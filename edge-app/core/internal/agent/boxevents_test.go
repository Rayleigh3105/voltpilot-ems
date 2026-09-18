package agent

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/boxevents"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

const (
	beTenant = "00000000-0000-4000-8000-000000000001"
	beSite   = "00000000-0000-4000-8000-000000000002"
	beBox    = "00000000-0000-4000-8000-000000000003"
)

func umschlaege(t *testing.T, a *Agent) []map[string]any {
	t.Helper()
	var alle []map[string]any
	for {
		e, ok := a.boxEventOutbox.Next()
		if !ok {
			return alle
		}
		var wire map[string]any
		if err := json.Unmarshal(e.Raw, &wire); err != nil {
			t.Fatal(err)
		}
		alle = append(alle, wire)
		if err := a.boxEventOutbox.Ack(e.Sequence); err != nil {
			t.Fatal(err)
		}
	}
}

// Der Weg von IP-19: Treiber -> lokaler Bus -> Kern -> Outbox -> .../v2/events.
func TestGeraeteEreignisseKommenUeberDenLokalenBusInDieOutbox(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	a.setMeasurementIdentity(beTenant, beSite, beBox)
	// Der Start der Box meldet sich selbst, sobald es eine Kennung gibt.
	erste := umschlaege(t, a)
	if len(erste) != 1 || erste[0]["events"].([]any)[0].(map[string]any)["art"] != "box_restart" {
		t.Fatalf("kein box_restart nach der Anmeldung: %v", erste)
	}
	if erste[0]["schema_version"] != "2.1" || erste[0]["device_id"] != beBox {
		t.Fatalf("Umschlag: %v", erste[0])
	}
	// Eine zweite Anmeldung derselben Box meldet KEINEN zweiten Neustart.
	a.setMeasurementIdentity(beTenant, beSite, beBox)
	if rest := umschlaege(t, a); len(rest) != 0 {
		t.Fatalf("zweiter Neustart gemeldet: %v", rest)
	}

	for _, roh := range []string{
		`{"art":"device_restart","zeitpunkt":"2027-02-01T10:00:00Z","datenquelle":"DQ-4","herzschlag_vorher":6104,"herzschlag_nachher":3}`,
		`{"art":"frozen_source","zeitpunkt":"2027-02-01T10:01:00Z","datenquelle":"DQ-4","lesungen":3}`,
		`{"art":"range_limit","zeitpunkt":"2027-02-01T10:02:00Z","datenquelle":"EK-3","statuswort":4096}`,
		`{"art":"layout_changed","zeitpunkt":"2027-03-01T08:00:00Z","datenquelle":"EK-7","karten_erwartet":4,"karten_gelesen":5}`,
	} {
		a.onBoxEvent(boxevents.Topic, []byte(roh))
	}
	// Was ein Treiber NICHT melden darf, erreicht die Outbox nie.
	for _, roh := range []string{
		`{"art":"box_restart","zeitpunkt":"2027-02-01T10:00:00Z"}`,
		`{"art":"clock_jump","zeitpunkt":"2027-02-01T10:00:00Z","sprung_s":600}`,
		`{"art":"data_gap","von":"2027-02-01T10:00:00Z","bis":"2027-02-01T11:00:00Z","erkannt_aus":"verdraengung"}`,
		`{"art":"range_limit","zeitpunkt":"2027-02-01T10:02:00Z","datenquelle":"EK-3","messstelle":"MS-10"}`,
		`nicht einmal json`,
	} {
		a.onBoxEvent(boxevents.Topic, []byte(roh))
	}
	gesendet := umschlaege(t, a)
	if len(gesendet) != 4 {
		t.Fatalf("Umschläge: %d", len(gesendet))
	}
	var arten []string
	for i, wire := range gesendet {
		if wire["sequence"].(float64) != float64(i+1) {
			t.Fatalf("Sequenz zählt nicht fortlaufend: %v", wire["sequence"])
		}
		ereignisse := wire["events"].([]any)
		if len(ereignisse) != 1 {
			t.Fatalf("ein Umschlag je Ereignis: %v", ereignisse)
		}
		e := ereignisse[0].(map[string]any)
		arten = append(arten, e["art"].(string))
		if _, err := boxevents.Pruefe(e); err != nil {
			t.Fatalf("Ereignis verletzt den Vertrag: %v", err)
		}
		if id, ok := e["ereignis_id"].(string); !ok || len(id) != 36 {
			t.Fatalf("keine Ereignis-Kennung: %v", e)
		}
	}
	if fmt.Sprint(arten) != "[device_restart frozen_source range_limit layout_changed]" {
		t.Fatalf("Arten: %v", arten)
	}
}

// Ohne Kennung gibt es kein Topic - und deshalb auch keinen Umschlag.
func TestOhneBoxKennungWirdNichtsAbgelegt(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	a.onBoxEvent(boxevents.Topic,
		[]byte(`{"art":"range_limit","zeitpunkt":"2027-02-01T10:02:00Z","datenquelle":"EK-3"}`))
	if a.boxEventOutbox.Pending() != 0 {
		t.Fatal("ein Ereignis ohne Kennung wurde abgelegt")
	}
}

// Die Puffer-Verdrängung der Mess-Outbox wird zum data_gap der Box, mit von/bis.
func TestVerdraengungDerMessOutboxWirdZumDataGap(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	a.setMeasurementIdentity(beTenant, beSite, beBox)
	_ = umschlaege(t, a) // den box_restart abräumen

	// Eine kleine Outbox, damit die Verdrängung im Test wirklich eintritt.
	klein, err := measurements.OpenOutbox(t.TempDir(), 2)
	if err != nil {
		t.Fatal(err)
	}
	a.measurementOutbox = klein
	start := time.Date(2026, 11, 3, 9, 40, 0, 0, time.UTC)
	for i := 0; i < 4; i++ {
		a.onMeasurementSamples(measurements.LocalSamplesTopic, []byte(fmt.Sprintf(
			`{"catalog_version":"2026.08.25.1","observed_at":"%s","samples":[`+
				`{"point_key":"sunspec.model_103.w","raw":"1","decoded":1,"quality":"good"}]}`,
			start.Add(time.Duration(i)*time.Minute).Format(time.RFC3339))))
	}
	// Solange die Verdrängung ANHÄLT, wird noch nichts gemeldet: sonst entstünde
	// je verworfenem Umschlag eine eigene Lücke.
	if zuFrueh := umschlaege(t, a); len(zuFrueh) != 0 {
		t.Fatalf("Lücke waehrend des laufenden Ausfalls gemeldet: %v", zuFrueh)
	}
	// Die Rückkehr: die Mess-Outbox läuft leer, der nächste Takt verdrängt nichts
	// mehr - jetzt steht das Fenster fest.
	for {
		e, ok := klein.Next()
		if !ok {
			break
		}
		if err := klein.Ack(e.Sequence); err != nil {
			t.Fatal(err)
		}
	}
	a.onMeasurementSamples(measurements.LocalSamplesTopic, []byte(fmt.Sprintf(
		`{"catalog_version":"2026.08.25.1","observed_at":"%s","samples":[`+
			`{"point_key":"sunspec.model_103.w","raw":"1","decoded":1,"quality":"good"}]}`,
		start.Add(9*time.Minute).Format(time.RFC3339))))
	gemeldet := umschlaege(t, a)
	if len(gemeldet) != 1 {
		t.Fatalf("Verdrängungs-Umschläge: %d (%v)", len(gemeldet), gemeldet)
	}
	e := gemeldet[0]["events"].([]any)[0].(map[string]any)
	if e["art"] != "data_gap" || e["erkannt_aus"] != "verdraengung" {
		t.Fatalf("Ereignis: %v", e)
	}
	// [von, bis): von ist der älteste verworfene Umschlag, bis der älteste
	// überlebende - genau das Fenster, das nie ankam.
	if e["von"] != "2026-11-03T09:40:00Z" || e["bis"] != "2026-11-03T09:42:00Z" {
		t.Fatalf("Fenster: von %v bis %v", e["von"], e["bis"])
	}
	if e["erwartet_fehlend"].(float64) != 2 {
		t.Fatalf("erwartet_fehlend: %v", e["erwartet_fehlend"])
	}
	// Dieselbe Episode wird nur EINMAL gemeldet.
	a.meldeVerdraengung()
	if rest := umschlaege(t, a); len(rest) != 0 {
		t.Fatalf("Verdrängung doppelt gemeldet: %v", rest)
	}
}

// Die injizierte Uhr: eine Box ohne Echtzeituhr startet 1970 und bekommt erst
// nach der Anmeldung NTP. Der gemeldete Neustart trägt die KORRIGIERTE Zeit.
func TestNeustartTraegtDieKorrigierteZeitNachEinemUhrsprung(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	wand := time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)
	var laufzeit time.Duration
	a.uhr = func() (time.Time, time.Duration) { return wand, laufzeit }
	a.zeitWache = boxevents.NeueZeitWache(a.boxClock)

	laufzeit = 180 * time.Second
	wand = time.Date(2027, 2, 1, 10, 3, 0, 0, time.UTC)
	a.setMeasurementIdentity(beTenant, beSite, beBox)

	gemeldet := umschlaege(t, a)
	if len(gemeldet) != 1 {
		t.Fatalf("Umschläge: %v", gemeldet)
	}
	if gemeldet[0]["observed_at"] != "2027-02-01T10:03:00Z" {
		t.Fatalf("observed_at: %v", gemeldet[0]["observed_at"])
	}
	e := gemeldet[0]["events"].([]any)[0].(map[string]any)
	if e["art"] != "box_restart" || e["zeitpunkt"] != "2027-02-01T10:00:00Z" {
		t.Fatalf("box_restart: %v", e)
	}
	if a.zeitWache.Spruenge() != 1 {
		t.Fatalf("Uhrsprung nicht gezählt: %d", a.zeitWache.Spruenge())
	}
}
