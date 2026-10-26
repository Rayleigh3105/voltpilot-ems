package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// W-10 (Audit vp-ocpp-haushalt-audit): „Schnell bis zum Abstecken" und
// „Pausieren bis Abstecken" endeten nach 4 Stunden, und eine Pause ging bei
// einem Neustart der Box verloren.

func unplugPayload(action string, at time.Time) string {
	return `{"schema_version":"1.0","tenant_id":"t","site_id":"s","device_id":"d",
	  "charge_point_id":"SAEULE-1","connector_id":1,"action":"` + action + `","until_unplug":true,
	  "requested_at":"` + at.UTC().Format(time.RFC3339) + `"}`
}

func TestBisAbsteckenOutlastsTheFourHourCap(t *testing.T) {
	a, st := boostAgent(t)
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())

	for _, action := range []string{"voll", "pause"} {
		now := time.Now().UTC()
		a.onChargingBoost([]byte(unplugPayload(action, now)))
		a.ocpp.boosts.mu.Lock()
		it := a.ocpp.boosts.items["SAEULE-1#1"]
		a.ocpp.boosts.mu.Unlock()
		if !it.untilUnplug || it.pause != (action == "pause") {
			t.Fatalf("%s bis Abstecken: %+v", action, it)
		}
		if d := it.until.Sub(now); d < lastmgmt.BoostUntilUnplugMaxDuration-time.Minute {
			t.Fatalf("%s bis Abstecken endet nach %v - erwartet bis zum Abstecken, Deckel %v",
				action, d, lastmgmt.BoostUntilUnplugMaxDuration)
		}
		// Nach 5 Stunden läuft sie noch - vorher war nach 240 Minuten Schluss.
		if until, pause := a.ocpp.boosts.until("SAEULE-1#1", it.txID, now.Add(5*time.Hour)); until.IsZero() ||
			pause != (action == "pause") {
			t.Fatalf("%s bis Abstecken nach 5 h: until=%v pause=%v", action, until, pause)
		}
	}

	// Ohne das Feld bleibt der alte Deckel von 4 Stunden.
	now := time.Now().UTC()
	a.onChargingBoost([]byte(pausePayload(now)))
	a.ocpp.boosts.mu.Lock()
	it := a.ocpp.boosts.items["SAEULE-1#1"]
	a.ocpp.boosts.mu.Unlock()
	if it.untilUnplug || it.until.Sub(now) > lastmgmt.BoostMaxDuration+time.Minute {
		t.Fatalf("ohne until_unplug gilt der 4-Stunden-Deckel: %+v", it)
	}
}

// Die Pause überlebt den Neustart, an ihre Transaktion gebunden; „Jetzt voll
// laden" bleibt flüchtig, und ein neues Fahrzeug erbt nichts.
func TestAPauseSurvivesARestartBoundToItsTransaction(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	b := loadBoostStore(dir, now)
	b.grant("SAEULE-1#1", 7, now, 0, true, true)
	b.grant("SAEULE-2#1", 8, now, 0, false, true)

	r := loadBoostStore(dir, now.Add(time.Minute)) // der Neustart
	until, pause := r.until("SAEULE-1#1", 7, now.Add(6*time.Hour))
	if until.IsZero() || !pause {
		t.Fatalf("die Pause bis Abstecken muss den Neustart überleben: until=%v pause=%v", until, pause)
	}
	if until, _ := r.until("SAEULE-2#1", 8, now.Add(time.Minute)); !until.IsZero() {
		t.Fatal("„Jetzt voll laden“ darf nach einem Neustart nicht still weiter Netzstrom kaufen")
	}

	// Ein neues Fahrzeug (andere Transaktion) erbt sie nicht - und die Datei
	// vergisst sie mit.
	if until, _ := r.until("SAEULE-1#1", 9, now.Add(time.Hour)); !until.IsZero() {
		t.Fatal("ein neues Fahrzeug erbt die Pause")
	}
	if again := loadBoostStore(dir, now.Add(time.Hour)); len(again.items) != 0 {
		t.Fatalf("die Datei hält eine beendete Pause fest: %+v", again.items)
	}
}

// startOcpp liest die gespeicherten Pausen - der Weg, den ein Neustart der Box
// tatsächlich nimmt.
func TestStartOcppRestoresThePauses(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC()
	loadBoostStore(dir, now).grant("SAEULE-1#1", 7, now, 0, true, true)
	a := ocppAgent(t, func(c *config.Config) { c.DataDir = dir })
	if until, pause := a.ocpp.boosts.until("SAEULE-1#1", 7, now.Add(time.Hour)); until.IsZero() || !pause {
		t.Fatalf("der Neustart hat die Pause verloren: until=%v pause=%v", until, pause)
	}
	if _, paused := a.ocpp.boostKeys(now); len(paused) != 1 {
		t.Fatalf("die Fläche sieht die Pause nicht: %v", paused)
	}
}

// Eine Pause bis Abstecken endet mit IHRER Sitzung - auch auf der Fläche und
// in der Datei, obwohl der pausierte Stecker gar nicht mehr lädt.
func TestAPauseBisAbsteckenEndsWithTheSession(t *testing.T) {
	a, st := boostAgent(t)
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	a.onChargingBoost([]byte(unplugPayload("pause", time.Now())))
	measureSurplus(t, a, 20, 260, 0, st)
	a.ocppStep(context.Background())
	nearKwSoon(t, "paused", drawOf(st, 1), 0)
	raw, _ := os.ReadFile(filepath.Join(a.Cfg.DataDir, pauseFile))
	if !strings.Contains(string(raw), `"SAEULE-1#1"`) {
		t.Fatalf("die Pause steht nicht in der Datei: %s", raw)
	}

	if err := st.Unplug(1); err != nil {
		t.Fatalf("unplug: %v", err)
	}
	waitUntil(t, "the session ended", func() bool {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("SAEULE-1")
		for _, con := range c.Connectors {
			if con.Session != nil {
				return false
			}
		}
		return true
	})
	a.ocppStep(context.Background())
	if _, paused := a.ocpp.boostKeys(time.Now().UTC()); len(paused) != 0 {
		t.Fatalf("nach dem Abstecken zeigt die Fläche noch eine Pause: %v", paused)
	}
	raw, _ = os.ReadFile(filepath.Join(a.Cfg.DataDir, pauseFile))
	if strings.Contains(string(raw), "SAEULE-1") {
		t.Fatalf("die Datei hält die beendete Pause fest: %s", raw)
	}
}

// Der Herzschlag meldet die Pause ausdrücklich (additiv, `hand_paused`).
func TestTheHeartbeatCarriesTheHandPause(t *testing.T) {
	e := chargerEntry(state.OcppCharger{ID: "SAEULE-1", Connectors: []state.OcppConnector{
		{ID: 1, HandPaused: true}, {ID: 2},
	}})
	raw, _ := json.Marshal(e)
	if !e.Connectors[0].HandPaused || !strings.Contains(string(raw), `"hand_paused":true`) {
		t.Fatalf("hand_paused fehlt: %s", raw)
	}
	if e.Connectors[1].HandPaused || strings.Count(string(raw), "hand_paused") != 1 {
		t.Fatalf("ein Stecker ohne Pause trägt kein Feld: %s", raw)
	}
}
