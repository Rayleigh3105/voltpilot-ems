package agent

// Eine Anlage nur aus Erzeugern und Zählern - der Live-Fall Schramm „Zuhause“ (07.11.2026):
// drei KACO Powador TL3 über „Geräte suchen“ als „Weiterer Erzeuger“ übernommen, kein
// Wechselrichter, keine Anlagensteuerung. Die Box las alle drei frisch und stand trotzdem
// auf „keine_messwerte“: kein Standort-Sample, keine Telemetrie je Komponente, im Portal
// „Wartet auf die ersten Daten“ und im Cockpit kein Energiefluss.

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

const (
	schrammNetz  = "09a832cc-eb8d-4e9e-b132-247cb045f428"
	schrammHaus  = "b8a283f9-1195-4c0c-9dda-f8bbf1b55a33"
	schrammKaco1 = "2126f452-ac6e-4ec3-8446-a52fbeb8834e"
	schrammKaco2 = "33d64aa8-7e1d-484f-92bc-b0cce2cb97d3"
	schrammKaco3 = "ecc6ad92-0373-47a4-8cc2-20781426e2eb"
)

// kacoDriver ist der Treiber, wie die Cloud ihn für einen übernommenen Powador TL3 pusht
// (entities.json von edge-tgjn9gd, 07.11.2026 08:16:52Z) - ohne Rolle: die folgt aus dem Typ.
func kacoDriver(model, ip string, kwp int) string {
	return fmt.Sprintf(`{"communication":"sunspec_tcp","brand":"kaco","model":%q,
	  "family":"sunspec_live","capacity_kwp":%d,
	  "connection":{"ip":%q,"port":502,"unit_id":1,"model_type":"auto","curtail_write_fc":0}}`,
		model, kwp, ip)
}

// kacoProducer ist eine Erzeuger-Komponente mit ihrem Messkanal (wie im Push).
func kacoProducer(id, model, ip string, kwp int) entities.Entity {
	e := applyEntity(id, entities.TypeProducer, kacoDriver(model, ip, kwp))
	e.Capabilities.Measure = []entities.MeasureCap{{Channel: "pv_power_kw", Unit: "kW"}}
	return e
}

const shellyNetzDriver = `{"communication":"shelly_em_http","brand":"shelly","model":"shelly-pro-3em",
  "family":"shelly_em_triphase","connection":{"ip":"192.168.1.146","port":80}}`

// schrammPush ist der Push nach dem dritten Speichern: Netz und Haus zusammengesetzt, die
// drei KACO mit Treiber; mit netzZaehler zusätzlich der Shelly Pro 3EM-400 am Netzanschluss.
func schrammPush(rev string, netzZaehler bool) entities.Registry {
	netz := applyEntity(schrammNetz, entities.TypeGridMeter, "")
	if netzZaehler {
		netz = applyEntity(schrammNetz, entities.TypeGridMeter, shellyNetzDriver)
	}
	return portalPush(rev,
		netz,
		applyEntity(schrammHaus, entities.TypeHouseLoad, ""),
		kacoProducer(schrammKaco3, "powador-14.0-tl3", "192.168.1.156", 14),
		kacoProducer(schrammKaco2, "powador-20.0-tl3", "192.168.1.113", 18),
		kacoProducer(schrammKaco1, "powador-20.0-tl3", "192.168.1.147", 18))
}

func schrammBox(t *testing.T, netzZaehler bool) *Agent {
	t.Helper()
	a := newGateTestAgent(t)
	a.applyEntityRegistry(schrammPush("2026-11-07T08:16:52Z", netzZaehler))
	if rec := a.componentRecord(); rec.Held != "" || rec.Refused != "" {
		t.Fatalf("Schramm-Push nicht angewandt: %+v", rec)
	}
	if _, ok := a.GetInverter(); ok {
		t.Fatal("die Anlage hat keinen Wechselrichter")
	}
	return a
}

// quelleAn ist die Kennung der Quelle, die die Box für das Gerät an dieser Adresse fährt.
func quelleAn(t *testing.T, a *Agent, ip string) string {
	t.Helper()
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	for _, s := range a.srcs {
		if s.Connection.IP == ip {
			return s.ID
		}
	}
	t.Fatalf("keine Quelle an %s", ip)
	return ""
}

func lies(a *Agent, sourceID, werte string, ts time.Time) {
	a.onSourceTelemetry(sources.TopicPrefix+sourceID+"/telemetry",
		[]byte(fmt.Sprintf(`{%s, "ts": %q}`, werte, ts.Format(time.RFC3339))))
}

// entnimm liest das älteste Standort-Sample und quittiert es (naechstesSample liest nur).
func entnimm(t *testing.T, a *Agent) map[string]float64 {
	t.Helper()
	e, ok := a.buf.Next()
	if !ok {
		t.Fatal("kein Sample im Puffer")
	}
	m := naechstesSample(t, a)
	if err := a.buf.Ack(e.Seq); err != nil {
		t.Fatal(err)
	}
	return m
}

// naechsterTakt lässt die Taktsperre des Quellen-Samples verstreichen.
func naechsterTakt(a *Agent) {
	a.srcMu.Lock()
	a.lastSourcesSample = time.Time{}
	a.srcMu.Unlock()
}

func TestAnInverterlessPlantFoldsItsSiteSampleFromTheSources(t *testing.T) {
	a := schrammBox(t, false)
	k1, k2, k3 := quelleAn(t, a, "192.168.1.147"), quelleAn(t, a, "192.168.1.113"),
		quelleAn(t, a, "192.168.1.156")
	jetzt := ebenGelesen()

	// Die Werte der Box um 08:33Z: 0,52 / 0,52 / 0,35 kW.
	lies(a, k1, `"pv_power_kw": 0.52`, jetzt)
	if p := capturePaths(a); p.pending != 1 || p.ringLen != 1 {
		t.Fatalf("eine frische Erzeuger-Lesung ist ein Standort-Sample: %+v", p)
	}
	lies(a, k2, `"pv_power_kw": 0.52`, jetzt)
	lies(a, k3, `"pv_power_kw": 0.35`, jetzt)
	if p := capturePaths(a); p.pending != 1 {
		t.Fatalf("drei Quellen verdreifachen den Takt nicht (ein Sample je %v): %+v",
			sourcesSampleEvery, p)
	}
	entnimm(t, a)

	naechsterTakt(a)
	lies(a, k1, `"pv_power_kw": 0.53`, jetzt.Add(5*time.Second))
	m := entnimm(t, a)
	if !nahe(m["pv_power_kw"], 0.53+0.52+0.35) {
		t.Fatalf("PV = Summe der frischen Erzeuger: %v", m)
	}
	if _, ok := m["power_kw"]; ok {
		t.Fatalf("ohne Netz-Zähler kein Netzwert: %v", m)
	}
	if _, ok := m["load_kw"]; ok {
		t.Fatalf("ohne Netzwert ist das Haus nicht messbar - keine Schätzung: %v", m)
	}
	if snap := a.State.Get(); !nahe(snap.PvKw, 1.4) {
		t.Fatalf("die Kacheln der Box zeigen die PV-Summe: %v", snap.PvKw)
	}
}

func TestADuskReadingOfZeroIsAMeasuredZero(t *testing.T) {
	a := schrammBox(t, false)
	lies(a, quelleAn(t, a, "192.168.1.147"), `"pv_power_kw": 0`, ebenGelesen())
	m := entnimm(t, a)
	if v, ok := m["pv_power_kw"]; !ok || v != 0 {
		t.Fatalf("eine frische Lesung 0,0 kW ist gemessen, nicht fehlend: %v", m)
	}
}

func TestTheGridMeterClosesTheHouseBalanceOfAnInverterlessPlant(t *testing.T) {
	a := schrammBox(t, true)
	jetzt := ebenGelesen()
	netz := quelleAn(t, a, "192.168.1.146")
	lies(a, quelleAn(t, a, "192.168.1.147"), `"pv_power_kw": 8.0`, jetzt)
	entnimm(t, a)
	naechsterTakt(a)
	// Bezug 1,5 kW am Netzanschluss: Haus = 8,0 + 1,5 - 0 (TL3: keine Batterie, kein Speicher).
	lies(a, netz, `"power_kw": 1.5`, jetzt)
	m := entnimm(t, a)
	if !nahe(m["pv_power_kw"], 8.0) || !nahe(m["power_kw"], 1.5) || !nahe(m["load_kw"], 9.5) {
		t.Fatalf("PV, Netz und Haus aus der Standardbilanz: %v", m)
	}
}

func TestAStorageInTheRegistryLeavesTheHouseUnmeasured(t *testing.T) {
	a := newGateTestAgent(t)
	reg := schrammPush("r-speicher", true)
	reg.Entities = append(reg.Entities, applyEntity("6a1e3d0f-0000-0000-0000-00000000aaaa",
		entities.TypeBatteryHybrid, ""))
	a.applyEntityRegistry(reg)
	jetzt := ebenGelesen()
	lies(a, quelleAn(t, a, "192.168.1.147"), `"pv_power_kw": 8.0`, jetzt)
	entnimm(t, a)
	naechsterTakt(a)
	lies(a, quelleAn(t, a, "192.168.1.146"), `"power_kw": 1.5`, jetzt)
	m := entnimm(t, a)
	if _, ok := m["load_kw"]; ok {
		t.Fatalf("ein Speicher ohne gemessene Leistung macht das Haus unbekannt, nie Batterie 0: %v", m)
	}
}

func TestAnErzeugerReadingIsTheTelemetryOfItsComponent(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	// a.Stop (t.Cleanup of newGateTestAgent) closes the bus it was handed.
	telems, sub := busObserver(t, addr, "kaco1-tel", entities.TelemetryTopic(schrammKaco1))
	defer sub.Disconnect(0)
	andere, sub2 := busObserver(t, addr, "kaco2-tel", entities.TelemetryTopic(schrammKaco2))
	defer sub2.Disconnect(0)

	a := schrammBox(t, false)
	a.Bus = bus
	lies(a, quelleAn(t, a, "192.168.1.147"), `"pv_power_kw": 0.52`, ebenGelesen())

	waitFor(t, 3*time.Second, "Telemetrie der Komponente Kaco 1", func() bool { return len(telems()) > 0 })
	tel := telems()[0]
	ch, _ := tel["channels"].(map[string]any)
	if tel["entity_id"] != schrammKaco1 || tel["schema_version"] != entities.SchemaVersion ||
		ch == nil || ch["pv_power_kw"] != 0.52 {
		t.Fatalf("die Lesung von 192.168.1.147 ist die Telemetrie von Kaco 1: %v", tel)
	}
	if _, err := entities.ParseTelemetry(schrammKaco1, mustJSON(t, tel)); err != nil {
		t.Fatalf("die Box liest ihre eigene Meldung wie jede andere: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(andere()); n != 0 {
		t.Fatalf("eine Lesung gehört genau einer Komponente, Kaco 2 bekam %d", n)
	}
}

func TestWithAnInverterTheErzeugerStaysOutOfTheEntityTelemetry(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	// a.Stop (t.Cleanup of newGateTestAgent) closes the bus it was handed.
	telems, sub := busObserver(t, addr, "kaco1-tel-wr", entities.TelemetryTopic(schrammKaco1))
	defer sub.Disconnect(0)

	a := newGateTestAgent(t)
	reg := schrammPush("r-wr", false)
	reg.Entities = append(reg.Entities, applyEntity("6a1e3d0f-0000-0000-0000-00000000bbbb",
		entities.TypeBatteryHybrid, applyDeyeDriver))
	a.applyEntityRegistry(reg)
	if _, ok := a.GetInverter(); !ok {
		t.Fatal("der Push nennt einen Wechselrichter")
	}
	a.Bus = bus
	lies(a, quelleAn(t, a, "192.168.1.147"), `"pv_power_kw": 0.52`, ebenGelesen())
	time.Sleep(300 * time.Millisecond)
	if n := len(telems()); n != 0 {
		t.Fatalf("mit Wechselrichter trägt die Summe der battery-hybrid - keine Erzeuger-Telemetrie daneben (%d)", n)
	}
	if p := capturePaths(a); p.pending != 0 {
		t.Fatalf("mit Wechselrichter ist SEIN Sample das Standort-Sample, nicht die Quelle: %+v", p)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAPrimarySampleSilencesTheSourcesFold(t *testing.T) {
	a := schrammBox(t, false)
	// Ein Sample auf edge/telemetry, auch ohne gespeicherte Auswahl: SEIN Sample ist das
	// Standort-Sample, die Quellen falten kein zweites daneben.
	a.onLocalTelemetry(localbus.TopicTelemetry, []byte(`{"pv_power_kw": 3.0, "power_kw": 0.5}`))
	vorher := capturePaths(a).pending
	lies(a, quelleAn(t, a, "192.168.1.147"), `"pv_power_kw": 0.52`, ebenGelesen())
	if p := capturePaths(a); p.pending != vorher {
		t.Fatalf("neben einem Wechselrichter-Sample kein Quellen-Sample: %d -> %d", vorher, p.pending)
	}
}
