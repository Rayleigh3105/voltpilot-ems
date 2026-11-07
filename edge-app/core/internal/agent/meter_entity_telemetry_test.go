package agent

// Unterverteilungen (Konzept vp-unterzaehler-anzeige, B1): Schramm „Zuhause“ hat am
// Netzanschluss einen Shelly Pro 3EM-400 und in zwei Unterverteilungen je einen Pro 3EM
// („UV Halle“ 192.168.1.111, „UV Keller“ 192.168.1.121). Bis hierher kam von den
// Unterzählern nur der letzte kW-Wert im Herzschlag an - keine Reihe, keine Zählerstände,
// keine Phasen.

import (
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

const (
	schrammHalle  = "5d1c0a3e-7a51-4c55-9a0e-3f2f6a1c1111"
	schrammKeller = "5d1c0a3e-7a51-4c55-9a0e-3f2f6a1c2222"
)

func shellyDriver(ip string) string {
	return fmt.Sprintf(`{"communication":"shelly_em_http","brand":"shelly","model":"shelly-pro-3em",
	  "family":"shelly_em_triphase","connection":{"ip":%q,"port":80}}`, ip)
}

// zaehlerKanaele sind die Kanäle des Typkatalogs `sub-meter` (services/api
// entitytypes/catalog.json) - wie die Cloud sie pusht.
func zaehlerKanaele(mitLeistung bool) []entities.MeasureCap {
	var out []entities.MeasureCap
	if mitLeistung {
		out = append(out, entities.MeasureCap{Channel: "power_kw", Unit: "kW"})
	}
	return append(out,
		entities.MeasureCap{Channel: "energy_kwh", Unit: "kWh"},
		entities.MeasureCap{Channel: "energy_export_kwh", Unit: "kWh"},
		entities.MeasureCap{Channel: "power_l1_kw", Unit: "kW"},
		entities.MeasureCap{Channel: "power_l2_kw", Unit: "kW"},
		entities.MeasureCap{Channel: "power_l3_kw", Unit: "kW"})
}

func unterzaehler(id, typ, ip string, caps []entities.MeasureCap) entities.Entity {
	e := applyEntity(id, typ, shellyDriver(ip))
	e.Capabilities.Measure = caps
	e.Guards.Failsafe.Behavior = "measure-only"
	return e
}

// schrammMitZaehlern ist Schramms Push mit Netz-Zähler und beiden Unterzählern. Ein
// Unterzähler aus einer älteren Cloud ist ein `generic-load` mit nur `power_kw`.
func schrammMitZaehlern(t *testing.T, alteCloud bool) *Agent {
	t.Helper()
	reg := schrammPush("2026-11-07T12:00:00Z", true)
	netz := reg.Find(schrammNetz)
	netz.Capabilities.Measure = zaehlerKanaele(true)
	typ, caps := entities.TypeSubMeter, zaehlerKanaele(true)
	if alteCloud {
		typ, caps = entities.TypeGenericLoad, []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}}
	}
	reg.Entities = append(reg.Entities,
		unterzaehler(schrammHalle, typ, "192.168.1.111", caps),
		unterzaehler(schrammKeller, typ, "192.168.1.121", caps))
	a := newGateTestAgent(t)
	a.applyEntityRegistry(reg)
	if rec := a.componentRecord(); rec.Held != "" || rec.Refused != "" || len(rec.Rejected) != 0 {
		t.Fatalf("Push mit Zählern nicht angewandt: %+v", rec)
	}
	return a
}

// Schramms echte Zählerwerte vom 06.11.2026 (shellyem/testdata, Fall 1 und 0).
const (
	halleLesung = `"load_kw": 12.024, "energy_kwh": 70802.308, "energy_export_kwh": 1.069,
	  "power_l1_kw": 4.021, "power_l2_kw": 4.407, "power_l3_kw": 3.596`
	netzLesung = `"power_kw": 6.994, "energy_kwh": 42654.393, "energy_export_kwh": 80964.02,
	  "power_l1_kw": 2.918, "power_l2_kw": 2.237, "power_l3_kw": 1.839`
)

func zaehlerBus(t *testing.T) (string, *localbus.Bus) {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	return addr, bus
}

func TestASubMeterReadingIsTheTelemetryOfItsComponent(t *testing.T) {
	addr, bus := zaehlerBus(t)
	halle, sub := busObserver(t, addr, "halle-tel", entities.TelemetryTopic(schrammHalle))
	defer sub.Disconnect(0)
	keller, sub2 := busObserver(t, addr, "keller-tel", entities.TelemetryTopic(schrammKeller))
	defer sub2.Disconnect(0)

	a := schrammMitZaehlern(t, false)
	a.Bus = bus
	lies(a, quelleAn(t, a, "192.168.1.111"), halleLesung, ebenGelesen())

	waitFor(t, 3*time.Second, "Telemetrie der Komponente UV Halle", func() bool { return len(halle()) > 0 })
	tel := halle()[0]
	ch, _ := tel["channels"].(map[string]any)
	want := map[string]float64{"power_kw": 12.024, "energy_kwh": 70802.308, "energy_export_kwh": 1.069,
		"power_l1_kw": 4.021, "power_l2_kw": 4.407, "power_l3_kw": 3.596}
	if tel["entity_id"] != schrammHalle || len(ch) != len(want) {
		t.Fatalf("die Lesung von 192.168.1.111 ist die Telemetrie von UV Halle: %v", tel)
	}
	for k, v := range want {
		if ch[k] != v {
			t.Fatalf("UV Halle %s = %v, erwartet %v (%v)", k, ch[k], v, tel)
		}
	}
	if _, err := entities.ParseTelemetry(schrammHalle, mustJSON(t, tel)); err != nil {
		t.Fatalf("die Box liest ihre eigene Meldung wie jede andere: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(keller()); n != 0 {
		t.Fatalf("eine Lesung gehört genau einer Komponente, UV Keller bekam %d", n)
	}
	// Ein Unterzähler steht IN der Hauslast: er ist nie ein Standort-Sample.
	if p := capturePaths(a); p.pending != 0 {
		t.Fatalf("ein Unterzähler allein bildet kein Standort-Sample: %+v", p)
	}
}

func TestTheGridMeterReportsCountersAndPhasesButNotItsPower(t *testing.T) {
	addr, bus := zaehlerBus(t)
	netz, sub := busObserver(t, addr, "netz-tel", entities.TelemetryTopic(schrammNetz))
	defer sub.Disconnect(0)

	a := schrammMitZaehlern(t, false)
	a.Bus = bus
	lies(a, quelleAn(t, a, "192.168.1.146"), netzLesung, ebenGelesen())

	waitFor(t, 3*time.Second, "Telemetrie des Netz-Zählers", func() bool { return len(netz()) > 0 })
	ch, _ := netz()[0]["channels"].(map[string]any)
	if _, ok := ch["power_kw"]; ok {
		t.Fatalf("die Netz-Leistung trägt das Standort-Sample (Brücke der Cloud), kein zweiter Schreiber: %v", ch)
	}
	if ch["energy_kwh"] != 42654.393 || ch["energy_export_kwh"] != 80964.02 || ch["power_l1_kw"] != 2.918 || len(ch) != 5 {
		t.Fatalf("Netz-Zähler: Zählerstände und Phasen, sonst nichts: %v", ch)
	}
}

func TestAnOlderCloudsSubMeterReportsOnlyWhatItDeclares(t *testing.T) {
	addr, bus := zaehlerBus(t)
	halle, sub := busObserver(t, addr, "halle-tel-alt", entities.TelemetryTopic(schrammHalle))
	defer sub.Disconnect(0)

	a := schrammMitZaehlern(t, true)
	a.Bus = bus
	lies(a, quelleAn(t, a, "192.168.1.111"), halleLesung, ebenGelesen())

	waitFor(t, 3*time.Second, "Telemetrie von UV Halle", func() bool { return len(halle()) > 0 })
	ch, _ := halle()[0]["channels"].(map[string]any)
	if ch["power_kw"] != 12.024 || len(ch) != 1 {
		t.Fatalf("ein generic-load mit nur power_kw meldet nur seine Leistung: %v", ch)
	}
}

func TestMeterTelemetryIsThrottledToTheSourceCadence(t *testing.T) {
	addr, bus := zaehlerBus(t)
	halle, sub := busObserver(t, addr, "halle-tel-takt", entities.TelemetryTopic(schrammHalle))
	defer sub.Disconnect(0)

	a := schrammMitZaehlern(t, false)
	a.Bus = bus
	id := quelleAn(t, a, "192.168.1.111")
	lies(a, id, halleLesung, ebenGelesen())
	lies(a, id, halleLesung, ebenGelesen())
	waitFor(t, 3*time.Second, "erste Meldung", func() bool { return len(halle()) > 0 })
	time.Sleep(300 * time.Millisecond)
	if n := len(halle()); n != 1 {
		t.Fatalf("zwei Lesungen binnen 5 s sind eine Meldung, nicht %d", n)
	}
	a.srcMu.Lock()
	a.lastMeterTelemetry[schrammHalle] = time.Now().Add(-meterTelemetryEvery)
	a.srcMu.Unlock()
	lies(a, id, halleLesung, ebenGelesen())
	waitFor(t, 3*time.Second, "zweite Meldung nach dem Takt", func() bool { return len(halle()) == 2 })
}
