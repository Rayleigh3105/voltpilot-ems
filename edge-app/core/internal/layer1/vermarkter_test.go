package layer1_test

// The direct-marketer connection on Edge Industrie, end to end over the real
// local bus (vp-direktvermarktung-konzept d2 §5.4/§5.5, Stufe 4): the partner
// interface answers reads from the Erzeuger image, a partner write becomes a
// Koppelbild limit_w wish with reason "vertrag", the edge writes the MINIMUM
// of plan and partner and names the binding reason, and the watchdog lets the
// partner limit run out by itself.
//
// The tunnel itself (OpenVPN, the 502->1502 redirect on the tunnel interface
// only) is the root helper's job and proven by the container probe
// edge-industrie/test/vermarkter-probe.sh - here the tunnel address is a test
// hook (SetVermarkterForTest).

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/layer1"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbustcp"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// luoxVerbindung is the staged partner at the test's "tunnel address".
type luoxVerbindung struct {
	t *testing.T
	c *modbustcp.Client
	// lebenszeichen counts up; every Erneuern writes it to holding 3 (u32).
	lebenszeichen uint32
}

func verbindeLuox(t *testing.T, adresse string) *luoxVerbindung {
	t.Helper()
	c, err := modbustcp.Dial(context.Background(), nil, adresse, 1, 2*time.Second, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return &luoxVerbindung{t: t, c: c}
}

// Vorgabe writes the set-point percentage (holding 2) and a fresh watchdog.
func (l *luoxVerbindung) Vorgabe(pct uint16) {
	l.t.Helper()
	if err := l.c.WriteRegisters(2, []uint16{pct}); err != nil {
		l.t.Fatal(err)
	}
	l.Erneuern()
}

// Erneuern writes the next watchdog value (holding 3, u32 little word order).
func (l *luoxVerbindung) Erneuern() {
	l.t.Helper()
	l.lebenszeichen++
	w, _ := direktvermarkter.Encode(float64(l.lebenszeichen), "u32", "little")
	if err := l.c.WriteRegisters(3, w); err != nil {
		l.t.Fatal(err)
	}
}

func (l *luoxVerbindung) liesInput(addr, count uint16) []uint16 {
	l.t.Helper()
	w, err := l.c.ReadInput(addr, count)
	if err != nil {
		l.t.Fatal(err)
	}
	return w
}

func TestVermarkterBegrenztUeberDasKoppelbild(t *testing.T) {
	port := freePort(t)
	t.Cleanup(layer1.SetVermarkterForTest("127.0.0.1", port, 6*time.Second))
	pfad := t.TempDir()
	if err := os.WriteFile(filepath.Join(pfad, "partner"), []byte("luox\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	steuerung := starteKoppelSteuerung(t)
	a := startLightBox(t, layer1.Options{FirstPoll: time.Hour, Poll: time.Hour,
		SourcesFirstPoll: time.Hour, SourcesPoll: time.Hour, VermarkterPfad: pfad})
	bus, err := layer1.DialMQTT(a.Cfg.LocalMQTTAddr, "vermarkter-beobachter")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(bus.Close)
	publish := func(topic string, v any) {
		raw, _ := json.Marshal(v)
		if err := bus.Publish(topic, raw, true); err != nil {
			t.Fatal(err)
		}
	}
	// The same plant as the Koppelbild test: an Anlagensteuerung with
	// Stellplatz 1 released (limit_kw), serving the Gore Erzeuger image
	// (p_installiert_kw 265, p_nvp_w -1200 = 1200 W feed-in).
	publish("edge/entities/"+erzSteuerung+"/config", map[string]any{"entity_id": erzSteuerung,
		"entity_type": "anlagensteuerung", "edge_source_id": erzPin,
		"driver":       map[string]any{"communication": "modbus_tcp", "data_source_id": erzDatenquelle},
		"capabilities": map[string]any{"actuate": []any{map[string]any{"command": "limit_kw", "min": 0, "max": 265, "platz": 1}}}})
	publish(sources.TopicConfig, map[string]any{"schema_version": sources.SchemaVersion, "sources": []any{
		map[string]any{"id": erzPin, "role": sources.RolePlantController, "communication": "modbus_tcp",
			"family":     sources.FamilyErzeugerRegisterbild,
			"connection": map[string]any{"ip": "127.0.0.1", "port": steuerung.port, "unit_id": 1}}}})
	publish(measurements.LocalConfigTopic, map[string]any{"schema_version": "2.0", "revision": 4,
		"catalog_version": "2026.10.21.1",
		"selections":      []any{map[string]any{"point_key": "erzeuger.a.p_erzeugung_w", "cadence_s": 60, "entity_id": erzSteuerung}},
		"erzeuger_registerbilder": []any{map[string]any{"entity_id": erzSteuerung, "basisadresse": 0,
			"funktionscode": 4, "wortfolge": "big", "te_anzahl": 3, "anlagenart": "pv",
			"steuerung_kennung": koppelSteuerungID}}})

	// 1. The partner interface comes up at the "tunnel address" and answers
	// reads from the Erzeuger image - feed-in positive, reference power in W.
	waitFor(t, 20*time.Second, "erstes Telegramm", func() bool { return steuerung.letztes() != nil })
	adresse := fmt.Sprintf("127.0.0.1:%d", port)
	var luox *luoxVerbindung
	waitFor(t, 20*time.Second, "Partner-Schnittstelle lauscht", func() bool {
		c, err := modbustcp.Dial(context.Background(), nil, adresse, 1, time.Second, time.Second)
		if err != nil {
			return false
		}
		c.Close()
		return true
	})
	luox = verbindeLuox(t, adresse)
	waitFor(t, 20*time.Second, "Messwerte am Partner-Register", func() bool {
		w, err := luox.c.ReadInput(0, 2)
		if err != nil {
			return false
		}
		v, ok := direktvermarkter.Decode(w, "s32", "little")
		return ok && v == 1200
	})
	referenz := luox.liesInput(5, 2)
	if v, ok := direktvermarkter.Decode(referenz, "u32", "little"); !ok || v != 265000 {
		t.Fatalf("referenz_w %v (%v)", referenz, v)
	}

	// 2. luox limits to 30 %: the next telegram wishes min(nothing, 30 % von
	// 265 kW) = 79 500 W with reason vertrag (code 6) - on Stellplatz 1,
	// whose offer is the whole generation (the profile means the feed-in;
	// capping generation is the safe stand-in, never the other way round).
	// The telegram carries the 1.1 version word only while reason 6 rides.
	luox.Vorgabe(30)
	waitFor(t, 20*time.Second, "Wunsch 79 500 W mit Grund vertrag", func() bool {
		luox.Erneuern()
		w := steuerung.letztes()
		art, wert, grund := platz1(w)
		return art == 1 && wert == 79500 && grund == 6 && w[4] == 0x0101
	})

	// 3. The plan binds when it is lower: limit_kw 50 wins, reason markt,
	// version word back at 1.0.
	publish("edge/entities/"+erzSteuerung+"/command", map[string]any{"schema_version": "1.0", "entity_id": erzSteuerung,
		"control_enabled": true, "source": "plan-executor", "commands": map[string]any{"limit_kw": 50}})
	waitFor(t, 20*time.Second, "Fahrplan 50 kW bindet", func() bool {
		luox.Erneuern()
		w := steuerung.letztes()
		art, wert, grund := platz1(w)
		return art == 1 && wert == 50000 && grund == 1 && w[4] == 0x0100
	})

	// 4. The plan opens up to 159 kW: the partner binds again.
	publish("edge/entities/"+erzSteuerung+"/command", map[string]any{"schema_version": "1.0", "entity_id": erzSteuerung,
		"control_enabled": true, "source": "plan-executor", "commands": map[string]any{"limit_kw": 159}})
	waitFor(t, 20*time.Second, "Partner 79 500 W bindet wieder", func() bool {
		luox.Erneuern()
		w := steuerung.letztes()
		art, wert, grund := platz1(w)
		return art == 1 && wert == 79500 && grund == 6
	})

	// 5. The watchdog runs out (nobody renews it): the set-point register
	// falls back to the rest value and the plan's wish stands alone again.
	// No telegram ever carries a stale partner limit.
	waitFor(t, 30*time.Second, "Vorgabe abgelaufen, Fahrplan bindet", func() bool {
		w := steuerung.letztes()
		art, wert, grund := platz1(w)
		return art == 1 && wert == 159000 && grund == 1
	})
	halte, err := luox.c.ReadHolding(2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if halte[0] != 100 {
		t.Fatalf("Ruhewert %d statt 100", halte[0])
	}

	// 6. The partner file disappears (Widerruf): the interface closes.
	if err := os.Remove(filepath.Join(pfad, "partner")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 20*time.Second, "Schnittstelle geschlossen", func() bool {
		c, err := modbustcp.Dial(context.Background(), nil, adresse, 1, time.Second, time.Second)
		if err != nil {
			return true
		}
		c.Close()
		return false
	})
}
