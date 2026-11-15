package agent

// Steuerarten und Heizstab-Regler als Logik des Kerns, auf der Box (Stufe 6, Zusammenführen,
// dritter Teil; Beleg des Fähigkeitsworts steuerlogik_steuerarten):
//   - der übersetzte Heizstab-Regler schaltet einen gestellten Shelly Pro 3 Sekunde für Sekunde
//     genau wie der Regler der Box an einer zweiten, gleichen Anlage mit denselben Messwerten;
//   - die Quelle site.surplus und das Signal <gerät>.power lesen, was die Verbraucherregel und der
//     Regler lesen;
//   - die Pflicht einer übersetzten Steuerart hebt den Wunsch über den Fahrplan (Rang 70).

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst"
)

func TestBeideBoxArtenMeldenSteuerarten(t *testing.T) {
	for _, art := range []string{geraetesuche.BoxArtEdgeLight, geraetesuche.BoxArtDocker} {
		if !slices.Contains(cloud.BuiltSupports(art), "steuerlogik_steuerarten") {
			t.Fatalf("%s meldet steuerlogik_steuerarten nicht", art)
		}
	}
}

// heizstabAnlage ist eine Anlage mit dem gestellten Pro 3; mitBlock lässt den Regler der Box führen.
func heizstabAnlage(t *testing.T, mitBlock bool) *scharfStand {
	return neuerScharfStand(t, func(ip string, port int) entities.Registry {
		reg := stageRodRegistry(tScharfRod, ip, port)
		if mitBlock {
			reg.Entities[0].Heizstab = json.RawMessage(`{"modus":"ueberschuss"}`)
		}
		return reg
	})
}

// tick ist eine Sekunde beider Wege mit denselben Messwerten der Anlage.
func (s *scharfStand) tickMit(netz, pv, last float64) {
	s.tickReihe(netz, pv, last, false)
}

// tickReihe ist eine Sekunde; reglerZuerst dreht die Reihenfolge der beiden Schleifen (auf der Box laufen sie
// unabhängig voneinander, jede kann zuerst kommen).
func (s *scharfStand) tickReihe(netz, pv, last float64, reglerZuerst bool) {
	s.now = s.now.Add(time.Second)
	batt := 0.0
	ms := map[string]float64{"power_kw": netz, "pv_power_kw": pv, "load_kw": last}
	s.a.heizstabObserve(s.now, ms, &batt)
	s.a.logikObserve(s.now, ms, &batt)
	if reglerZuerst {
		s.a.runHeizstab(s.now)
	}
	s.a.logik.Tick(s.now)
	s.a.runSteuerlogik(s.now)
	if !reglerZuerst {
		s.a.runHeizstab(s.now)
	}
	s.arb.Tick()
	s.a.runShellyControlPass(context.Background(), s.a.shellyDoer, s.fp, s.asrt, s.now)
}

// setzeBlock nimmt den Block des Heizstabs in den Registry-Push oder heraus, wie die Cloud beim Übernehmen
// und beim Zurück (EntityRegistryService).
func (s *scharfStand) setzeBlock(mit bool) {
	reg := s.reg
	reg.Entities = append([]entities.Entity(nil), s.reg.Entities...)
	reg.Entities[0].Heizstab = nil
	if mit {
		reg.Entities[0].Heizstab = json.RawMessage(`{"modus":"ueberschuss"}`)
	}
	s.a.entMu.Lock()
	s.a.entRegistry = reg
	s.a.entMu.Unlock()
	s.arb.SetEntities(reg)
}

func TestHeizstabAlsLogikSchaltetWieDerRegler(t *testing.T) {
	alt := heizstabAnlage(t, true)
	kern := heizstabAnlage(t, false)
	regRaw, _ := json.Marshal(kern.reg)
	e, err := logikdienst.AusHeizstab(logikdienst.HeizstabAuftrag{Entity: tScharfRod,
		Block: json.RawMessage(`{"modus":"ueberschuss"}`), Registry: regRaw})
	if err != nil || !e.Uebersetzt {
		t.Fatalf("Übersetzung: %v %+v", err, e)
	}
	art, bericht, err := logikdienst.Artefakt(logikdienst.Auftrag{Text: e.Text, FlowID: tLogikFlow, FlowVersion: 1,
		Registry: regRaw, Armed: true, CompiledAt: time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC),
		Site: &logikdienst.Ort{Timezone: "Europe/Berlin"}})
	if err != nil {
		t.Fatalf("Artefakt: %v %+v", err, bericht)
	}
	kern.liefere(art)
	if !alt.a.heizstabOwns(tScharfRod) || kern.a.heizstabOwns(tScharfRod) || !kern.a.steuerlogikOwns(tScharfRod) {
		t.Fatal("die eine Anlage führt der Regler, die andere die Logik")
	}

	// Ein Tag in Minuten: die Sonne steigt und fällt, Wolken ziehen durch, das Haus zieht mal mehr.
	wechsel, sekunden := 0, 0
	vorher := 0
	for m := 0; m < 6*60; m++ {
		sonne := math.Max(0, 9*math.Sin(math.Pi*float64(m)/360))
		if m%47 < 6 {
			sonne *= 0.3 // eine Wolke
		}
		last := 0.6 + 0.4*math.Sin(float64(m)/13)
		for i := 0; i < 60; i++ {
			// Jede Anlage misst ihren eigenen Stab am Netzpunkt mit.
			alt.tickMit(math.Round((last+2*float64(alt.phasen())-sonne)*1000)/1000, sonne, last)
			kern.tickMit(math.Round((last+2*float64(kern.phasen())-sonne)*1000)/1000, sonne, last)
			sekunden++
			if alt.phasen() != kern.phasen() {
				t.Fatalf("Minute %d, Sekunde %d: Regler %d Phasen, Logik %d", m, i, alt.phasen(), kern.phasen())
			}
			if alt.phasen() != vorher {
				wechsel++
				vorher = alt.phasen()
			}
		}
	}
	if wechsel < 12 {
		t.Fatalf("der Tag belegt zu wenig: %d Stufenwechsel in %d s", wechsel, sekunden)
	}
	dec, _ := kern.arb.DecisionFor(tScharfRod)
	if dec.HolderKind != string(desired.SourceSteuerlogik) || dec.HolderRank != 40 {
		t.Fatalf("die Logik hält den Stab in der Klasse der Regel: %+v", dec)
	}
}

func TestQuellenUeberschussUndLeistung(t *testing.T) {
	s := heizstabAnlage(t, false)
	now := s.now
	batt := 0.0
	s.a.logikObserve(now, map[string]float64{"pv_power_kw": 5, "load_kw": 1.2, "power_kw": -3.8}, &batt)
	if w := s.a.logikQuelle("site.surplus", now.Add(10*time.Second)); w.Zahl == nil || math.Abs(*w.Zahl-3.8) > 1e-9 || w.Alter != 10 {
		t.Fatalf("site.surplus = PV minus Hausverbrauch derselben Messung: %+v", w)
	}
	// battery.power bleibt der Speicher, kein Gerät „battery“ mit dem Signal power.
	if w := s.a.logikQuelle("battery.power", now); w.Zahl == nil || *w.Zahl != 0 {
		t.Fatalf("battery.power ist die gemessene Speicherleistung: %+v", w)
	}
	// Eine Messung ohne Hausverbrauch ändert den Überschuss nicht; er altert.
	s.a.logikObserve(now.Add(20*time.Second), map[string]float64{"pv_power_kw": 9}, &batt)
	if w := s.a.logikQuelle("site.surplus", now.Add(30*time.Second)); w.Zahl == nil || *w.Zahl != 3.8 || w.Alter != 30 {
		t.Fatalf("ohne Hausverbrauch bleibt der letzte Überschuss: %+v", w)
	}
	// <gerät>.power: ohne Rücklesung unbekannt, dann die bestätigte Stufe des Pro 3.
	if w := s.a.logikQuelle(tScharfRod+".power", s.now); w.Zahl != nil {
		t.Fatalf("ohne Rücklesung ist die Leistung unbekannt: %+v", w)
	}
	submitSetpointWish(s.arb, tScharfRod, 4, "zwei")
	s.a.runShellyControlPass(context.Background(), s.a.shellyDoer, s.fp, s.asrt, s.now)
	if w := s.a.logikQuelle(tScharfRod+".power", s.now); w.Zahl == nil || *w.Zahl != 4 {
		t.Fatalf("die bestätigte Stufe zieht 4 kW: %+v", w)
	}
}

// Eine Pflichtregel der Steuerart: ihr Wunsch steht über dem Fahrplan (70), wie der generierte Flow.
func TestPflichtEinerSteuerartHebtDenWunsch(t *testing.T) {
	s := heizstabAnlage(t, false)
	regRaw, _ := json.Marshal(s.reg)
	doc := json.RawMessage(`{"origin":{"kind":"consumer-policy"},"nodes":[{"id":"reaktiv","type":"vp.consumer.reactive",
	 "parameters":{"entity_id":"` + tScharfRod + `","command":"setpoint_kw","ttl_s":45,"renew_s":15,"off_delay_s":0,
	  "requirements":[{"id":"leer","must_run":true,"value":2,"condition":{"signal":"storage.soc_pct","source":"site",
	   "channel":"soc_pct","op":"lt","value":20,"reset_value":25,"max_age_s":60}}]}}]}`)
	e, err := logikdienst.AusSteuerart(logikdienst.SteuerartAuftrag{Dokument: doc, Name: "Pflicht", Registry: regRaw})
	if err != nil || !e.Uebersetzt || !e.Pflicht {
		t.Fatalf("Übersetzung: %v %+v", err, e)
	}
	art, bericht, err := logikdienst.Artefakt(logikdienst.Auftrag{Text: e.Text, FlowID: tLogikFlow, FlowVersion: 1,
		Registry: regRaw, Armed: true, Pflicht: true, CompiledAt: time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC),
		Site: &logikdienst.Ort{Timezone: "Europe/Berlin"}})
	if err != nil {
		t.Fatalf("Artefakt: %v %+v", err, bericht)
	}
	s.liefere(art)
	tick := func(soc float64) {
		s.now = s.now.Add(time.Second)
		batt := 0.0
		s.a.logikObserve(s.now, map[string]float64{"power_kw": 0, "soc_pct": soc}, &batt)
		s.a.logik.Tick(s.now)
		s.a.runSteuerlogik(s.now)
		s.arb.Tick()
	}
	tick(50)
	if _, ok := s.arb.DecisionFor(tScharfRod); ok {
		if dec, _ := s.arb.DecisionFor(tScharfRod); dec.HolderKind == string(desired.SourceSteuerlogik) {
			t.Fatalf("ohne Anforderung kein Wunsch: %+v", dec)
		}
	}
	tick(15)
	dec, _ := s.arb.DecisionFor(tScharfRod)
	if dec.HolderKind != string(desired.SourceSteuerlogik) || dec.HolderRank != 70 || !dec.HolderOverride {
		t.Fatalf("Pflicht: Rang 70 über dem Fahrplan erwartet, %+v", dec)
	}
}

// Übernehmen und Zurück am Stab: der Block geht und kommt, der Stab hat in jeder Sekunde einen Herrn und schaltet
// nicht - in beiden Reihenfolgen der zwei Schleifen.
func TestUebergabeAmHeizstabOhneLuecke(t *testing.T) {
	for _, reglerZuerst := range []bool{false, true} {
		s := heizstabAnlage(t, true)
		regRaw, _ := json.Marshal(s.reg)
		e, err := logikdienst.AusHeizstab(logikdienst.HeizstabAuftrag{Entity: tScharfRod,
			Block: json.RawMessage(`{"modus":"ueberschuss"}`), Registry: regRaw})
		if err != nil || !e.Uebersetzt {
			t.Fatalf("Übersetzung: %v %+v", err, e)
		}
		art, _, err := logikdienst.Artefakt(logikdienst.Auftrag{Text: e.Text, FlowID: tLogikFlow, FlowVersion: 1,
			Registry: regRaw, Armed: true, CompiledAt: time.Date(2026, 11, 14, 8, 0, 0, 0, time.UTC),
			Site: &logikdienst.Ort{Timezone: "Europe/Berlin"}})
		if err != nil {
			t.Fatal(err)
		}
		// Erst der Satz mit der scharfen Übersetzung (der Regler führt noch), dann geht der Block. Wie im Mitlauf
		// vor dem Übernehmen rechnet die Logik erst eine ruhige Stunde mit: eine neue Übersetzung zählt Haltezeit
		// und Mindestpause ab ihrem Start (der Regler hat ohne Vorgeschichte keine); danach gehen beide im Gleichschritt.
		s.liefere(art)
		for i := 0; i < 3700; i++ {
			s.tickReihe(0.5+2*float64(s.phasen()), 0, 0.5, reglerZuerst)
		}
		for i := 0; i < 400; i++ {
			s.tickReihe(math.Round((0.5+2*float64(s.phasen())-7)*1000)/1000, 7, 0.5, reglerZuerst)
		}
		if s.phasen() < 2 {
			t.Fatalf("der Regler hat bei 7 kW Sonne nur %d Phasen", s.phasen())
		}
		vorher := s.phasen()
		halter := func() string {
			dec, _ := s.arb.DecisionFor(tScharfRod)
			return dec.HolderKind
		}
		if halter() != string(desired.SourceHeizstab) {
			t.Fatalf("vor dem Übernehmen führt der Regler, nicht %q", halter())
		}
		s.setzeBlock(false)
		for i := 0; i < 20; i++ {
			s.tickReihe(math.Round((0.5+2*float64(s.phasen())-7)*1000)/1000, 7, 0.5, reglerZuerst)
			if h := halter(); h == "" {
				t.Fatalf("Regler zuerst %v, Sekunde %d nach dem Übernehmen: der Stab hat keinen Herrn", reglerZuerst, i)
			}
			if s.phasen() != vorher {
				t.Fatalf("Regler zuerst %v: die Übergabe hat geschaltet (%d -> %d Phasen)", reglerZuerst, vorher, s.phasen())
			}
		}
		if halter() != string(desired.SourceSteuerlogik) {
			t.Fatalf("nach dem Übernehmen führt die Logik, nicht %q", halter())
		}
		// Zurück: der Regler führt sofort wieder, ohne eine Sekunde ohne Herrn. Er beginnt dabei neu, wie bei jedem
		// Block, der kommt (seinen Zustand verwirft er, wenn der Block geht): erst aus, nach der Prüfminute wieder
		// Stufe für Stufe (steuerlogik.md, Zusammenführen, dritter Teil).
		s.setzeBlock(true)
		for i := 0; i < 20; i++ {
			s.tickReihe(math.Round((0.5+2*float64(s.phasen())-7)*1000)/1000, 7, 0.5, reglerZuerst)
			if h := halter(); h != string(desired.SourceHeizstab) {
				t.Fatalf("Regler zuerst %v, Sekunde %d nach dem Zurück: es führt %q, nicht der Regler", reglerZuerst, i, h)
			}
		}
		for i := 0; i < 400; i++ {
			s.tickReihe(math.Round((0.5+2*float64(s.phasen())-7)*1000)/1000, 7, 0.5, reglerZuerst)
		}
		if s.phasen() != vorher {
			t.Fatalf("Regler zuerst %v: nach dem Neubeginn führt der Regler wieder %d Phasen, nicht %d", reglerZuerst, s.phasen(), vorher)
		}
	}
}
