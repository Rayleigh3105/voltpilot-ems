package agent

// Die Lesung einer Anlagensteuerung als Standort-Sample (UEMS EZ-17, Scheibe 1).
//
// Befund vom 27.10.2026 (Gore „Neue Halle“, WAGO PFC200, drei Growatt dahinter): das
// Cockpit zeigte die Jetzt-Werte aus dem Erzeuger-Bild, der Verlauf, „Heute · kWh“ und die
// Energiebilanz blieben leer. Ursache: die Box bildete ihr v1-Standort-Sample (die EINE
// Quelle von telemetry, telemetry_rollup_15m und Verlauf) nur aus einem Wechselrichter-
// Sample auf edge/telemetry plus den Rollen pv-generation/grid-meter; die Rolle
// plant-controller las kein Fold. Hier steht der Gegenbeweis als Regel: die Lesung der
// Steuerung auf edge/sources/<pin>/telemetry wird auf einer Box ohne Wechselrichter zum
// Standort-Sample - durch denselben Fold wie ein Wechselrichter-Sample (Puffer, Ring,
// Zustand) - und auf einer Box mit Wechselrichter bleibt alles, wie es war.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// goreBox ist die Box der Gore-Anlage: Netz und Haus zusammengesetzt, die Steuerung mit
// ihrem Pin - und KEIN Wechselrichter (der Push aus component_apply_steuerung_test.go).
func goreBox(t *testing.T) *Agent {
	t.Helper()
	a := newGateTestAgent(t)
	a.applyEntityRegistry(portalPush("r1",
		applyEntity("00000000-0000-0000-0000-0000000e2010", entities.TypeGridMeter, ""),
		applyEntity("00000000-0000-0000-0000-0000000e2011", entities.TypeHouseLoad, ""),
		goreSteuerung()))
	if rec := a.componentRecord(); rec.Held != "" || rec.Refused != "" {
		t.Fatalf("Gore-Push nicht angewandt: %+v", rec)
	}
	return a
}

// feedSteuerung ist die Lesung der Steuerung, wie die Palette sie veroeffentlicht
// (measurement-runtime.js erzeugerQuelle): kW, Vorzeichen des Bilds, eigene Zeit.
func feedSteuerung(a *Agent, payload string) {
	a.onSourceTelemetry(sources.TopicPrefix+goreSteuerungPin+"/telemetry", []byte(payload))
}

func naechstesSample(t *testing.T, a *Agent) map[string]float64 {
	t.Helper()
	e, ok := a.buf.Next()
	if !ok {
		t.Fatal("kein Sample im Puffer")
	}
	if e.EntityID != "" {
		t.Fatalf("ein v1-Standort-Sample, kein Entitaets-Sample: %+v", e)
	}
	return e.Measurements
}

func nahe(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

func TestControllerReadingBecomesTheSiteSampleOfAnInverterlessBox(t *testing.T) {
	a := goreBox(t)
	if vorher := capturePaths(a); vorher.pending != 0 || vorher.ringLen != 0 {
		t.Fatalf("vor der Lesung nichts im Puffer: %+v", vorher)
	}
	// Die Werte des Screenshots vom 27.10.2026, 16:59: 0,7 kW Erzeugung, 679,4 kW Bezug.
	feedSteuerung(a, `{"pv_power_kw": 0.7, "power_kw": 679.4, "ts": "2026-10-27T15:59:00Z"}`)

	nach := capturePaths(a)
	if nach.pending != 1 || nach.ringLen != 1 {
		t.Fatalf("die Lesung ist ein Standort-Sample (Puffer, Ring): %+v", nach)
	}
	if want := time.Date(2026, 10, 27, 15, 59, 0, 0, time.UTC); !nach.lastTel.Equal(want) {
		t.Fatalf("Sample traegt die Zeit der Lesung: %v", nach.lastTel)
	}
	m := naechstesSample(t, a)
	if !nahe(m["pv_power_kw"], 0.7) || !nahe(m["power_kw"], 679.4) {
		t.Fatalf("pv und Netz wie gelesen: %v", m)
	}
	// Verbrauch = Erzeugung + Netzpunkt, Batterie 0 als Tatsache des Erzeuger-Bilds (680,1 kW).
	if !nahe(m["load_kw"], 680.1) {
		t.Fatalf("Hauslast aus der Standardbilanz pv + grid: %v", m)
	}
	if _, ok := m["soc_pct"]; ok {
		t.Fatalf("kein SoC auf einer Erzeugeranlage: %v", m)
	}
	snap := a.State.Get()
	if !nahe(snap.PvKw, 0.7) || !nahe(snap.LoadKw, 680.1) {
		t.Fatalf("die Kacheln der Box zeigen die Lesung: pv=%v load=%v", snap.PvKw, snap.LoadKw)
	}
	if !nahe(snap.LastReading["power_kw"], 679.4) {
		t.Fatalf("„Zuletzt gelesen“ traegt die Steuerung: %v", snap.LastReading)
	}

	// Jede Lesung ist ein Sample - im Takt der Steuerung, wie ein Wechselrichter-Poll.
	feedSteuerung(a, `{"pv_power_kw": 0.3, "power_kw": 679.8, "ts": "2026-10-27T15:59:05Z"}`)
	if p := capturePaths(a); p.pending != 2 || p.ringLen != 2 {
		t.Fatalf("zweite Lesung, zweites Sample: %+v", p)
	}
}

func TestControllerReadingWithoutNetzpunktHasNoGridAndNoLoad(t *testing.T) {
	a := goreBox(t)
	// Buettner (EW-16 C): kein Netzpunkt - die Palette laesst power_kw weg. Nie 0.
	feedSteuerung(a, `{"pv_power_kw": 58.9, "ts": "2026-10-27T15:59:00Z"}`)
	if p := capturePaths(a); p.pending != 1 {
		t.Fatalf("auch ohne Netzpunkt ein Sample (Erzeugung): %+v", p)
	}
	m := naechstesSample(t, a)
	if !nahe(m["pv_power_kw"], 58.9) {
		t.Fatalf("Erzeugung wie gelesen: %v", m)
	}
	for _, k := range []string{"power_kw", "load_kw"} {
		if _, ok := m[k]; ok {
			t.Fatalf("%s ohne Netzpunkt unbekannt, nie 0: %v", k, m)
		}
	}
}

func TestControllerReadingWithGridOnlyHasNoLoad(t *testing.T) {
	a := goreBox(t)
	// Erzeugung nicht gueltig (a_gueltig Bit 3 = 0): Netzpunkt allein ergibt keine Hauslast.
	feedSteuerung(a, `{"power_kw": 12.5, "ts": "2026-10-27T15:59:00Z"}`)
	m := naechstesSample(t, a)
	if !nahe(m["power_kw"], 12.5) {
		t.Fatalf("Netzpunkt wie gelesen: %v", m)
	}
	if _, ok := m["load_kw"]; ok {
		t.Fatalf("ohne Erzeugung keine Hauslast: %v", m)
	}
}

func TestControllerReadingWithNothingUsableIsNoSample(t *testing.T) {
	a := goreBox(t)
	feedSteuerung(a, `{"ts": "2026-10-27T15:59:00Z"}`)
	feedSteuerung(a, `{"pv_power_kw": null, "power_kw": null}`)
	if p := capturePaths(a); p.pending != 0 || p.ringLen != 0 {
		t.Fatalf("eine Lesung ohne Wert ist kein Sample: %+v", p)
	}
}

func TestControllerReadingBesideAnInverterStaysOutOfTheBalance(t *testing.T) {
	// Der Wechselrichter VOR dem Portal-Push: eine portal-verwaltete Anlage nimmt keine
	// lokale Auswahl mehr an, ein Push ohne Wechselrichter laesst die vorhandene stehen.
	a := newGateTestAgent(t)
	selectPrimary(t, a, "deye", "sun-30k-sg01hp3")
	a.applyEntityRegistry(portalPush("r1",
		applyEntity("00000000-0000-0000-0000-0000000e2010", entities.TypeGridMeter, ""),
		applyEntity("00000000-0000-0000-0000-0000000e2011", entities.TypeHouseLoad, ""),
		goreSteuerung()))
	if _, ok := a.GetInverter(); !ok {
		t.Fatal("der Wechselrichter bleibt neben der Steuerung")
	}
	feedSteuerung(a, `{"pv_power_kw": 0.7, "power_kw": 679.4, "ts": "2026-10-27T15:59:00Z"}`)
	if p := capturePaths(a); p.pending != 0 || p.ringLen != 0 {
		t.Fatalf("mit Wechselrichter bleibt die Steuerung ausserhalb der Bilanz: %+v", p)
	}
	// Das Wechselrichter-Sample bleibt die Standortbilanz - unveraendert, ohne die Steuerung.
	feedPrimary(a, 5, 2, -3, 50)
	m := naechstesSample(t, a)
	if !nahe(m["pv_power_kw"], 5) || !nahe(m["power_kw"], -3) {
		t.Fatalf("Wechselrichter-Sample wie gelesen: %v", m)
	}
}

func TestAnOrdinaryErzeugerSourceReadingNeverSynthesizesASample(t *testing.T) {
	a := newGateTestAgent(t)
	src := addErzeuger(t, a, 10)
	feedSource(a, src.ID, 4.2)
	if p := capturePaths(a); p.pending != 0 || p.ringLen != 0 {
		t.Fatalf("eine PV-Quelle allein ist kein Standort-Sample (wie bisher): %+v", p)
	}
	netz := addNetz(t, a)
	feedNetz(a, netz.ID, 1.5)
	if p := capturePaths(a); p.pending != 0 {
		t.Fatalf("ein Netz-Zaehler allein ist kein Standort-Sample (wie bisher): %+v", p)
	}
}

func TestControllerReadingWithoutTsTakesTheBoxClock(t *testing.T) {
	a := goreBox(t)
	vor := time.Now().UTC().Add(-time.Second)
	feedSteuerung(a, fmt.Sprintf(`{"pv_power_kw": %v, "power_kw": %v}`, 1.0, 2.0))
	nach := time.Now().UTC().Add(time.Second)
	lt := a.State.Get().LastTelemetry
	if lt.Before(vor) || lt.After(nach) {
		t.Fatalf("ohne ts die Uhr der Box: %v", lt)
	}
}
