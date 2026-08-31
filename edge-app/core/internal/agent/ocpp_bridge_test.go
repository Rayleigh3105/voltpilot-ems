package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// K3 — die Arbitrierungs-Brücke, gemessen AN DEN SÄULEN.
//
// Die drei Fälle des Auftrags, plus die Kompatibilitäts-Zusage: ohne Bindung
// ändert sich kein Byte.

// chargePointEntity baut eine Ladepunkt-Komponente mit der Bindung, die allein
// die Cloud kennt (`charge_point_id`) - der Zwilling von `edge_source_id`.
func chargePointEntity(entityID, chargePointID string, maxKw float64) entities.Registry {
	zero := 0.0
	return entities.Registry{
		Revision: "rev-cp",
		Entities: []entities.Entity{{
			ID: entityID, Type: "ev-charger", ChargePointID: chargePointID,
			Capabilities: entities.Capabilities{
				Measure: []entities.MeasureCap{{Channel: "power_kw", Unit: "kW"}},
				Actuate: []entities.ActuateCap{{Command: entities.CmdLimitKw, Min: &zero, Max: &maxKw}},
			},
			Guards: entities.Guards{
				Limits:   entities.GuardLimits{MaxConsumptionKw: &maxKw},
				Failsafe: entities.Failsafe{Behavior: "release"},
			},
		}},
	}
}

// bindStation hängt Registry + Arbiter an den OCPP-Rig-Agenten.
func bindStation(a *Agent, reg entities.Registry) *desired.Arbiter {
	arb := minimalArbiter(reg)
	a.entMu.Lock()
	a.entRegistry = reg
	a.entMu.Unlock()
	a.arb = arb
	return arb
}

// submitLimit stellt einen Wunsch der gegebenen Klasse auf die Säule.
func submitLimit(arb *desired.Arbiter, id string, class desired.Class, kw *float64, on *bool, req string) {
	d := &desired.Desired{
		EntityID: id, RequestID: req,
		Source:   desired.Source{Kind: desired.SourceFlow, FlowID: "f1", NodeID: "n1"},
		Priority: class,
		TTL:      time.Hour,
		IssuedAt: time.Now().UTC(),
	}
	if kw != nil {
		d.Commands.LimitKw = kw
		d.RequestedType = entities.CmdLimitKw
	}
	if on != nil {
		d.Commands.OnOff = on
		d.RequestedType = entities.CmdOnOff
	}
	arb.SubmitInternal(d)
	arb.Tick()
}

// -----------------------------------------------------------------------
// Die reine Übersetzung
// -----------------------------------------------------------------------

func TestTheBridgeTranslatesOnlyWhatAHolderReallySays(t *testing.T) {
	kw := 7.0
	off := false
	on := true

	// Kein Halter ⇒ die Quelle der Säule gilt unverändert.
	if _, ok := ocppBridgeDecision(desired.Decision{}, false); ok {
		t.Fatal("ohne Halter darf die Brücke nichts stempeln")
	}
	// Ein plain-flow-Halter OHNE Leistungsangabe sagt über die Verteilung
	// nichts: kein Deckel, keine Befreiung.
	if _, ok := ocppBridgeDecision(desired.Decision{HolderRank: 40}, true); ok {
		t.Fatal("ein Halter ohne Deckel und ohne Befreiung darf nichts ändern")
	}
	// Deckel.
	h, ok := ocppBridgeDecision(desired.Decision{
		HolderRank: 40, Granted: entities.Commands{LimitKw: &kw}}, true)
	if !ok || h.capKw == nil || *h.capKw != 7 {
		t.Fatalf("Deckel: %+v ok=%v", h, ok)
	}
	if h.exempt {
		t.Fatal("Rang 40 befreit ausdrücklich NICHT von der Quellen-Bahn")
	}
	// Ein ausdrückliches Aus ist ein Deckel von 0 - nicht ein eigener Kanal.
	h, _ = ocppBridgeDecision(desired.Decision{
		HolderRank: 70, Granted: entities.Commands{OnOff: &off}}, true)
	if h.capKw == nil || *h.capKw != 0 {
		t.Fatalf("on_off:false muss ein Deckel von 0 sein, got %+v", h.capKw)
	}
	if h.reason != lastmgmt.ReasonRule {
		t.Fatalf("Rang 70 ist eine Regel, got %q", h.reason)
	}
	// Ein on_off:true allein deckelt nichts.
	h, ok = ocppBridgeDecision(desired.Decision{
		HolderRank: 60, Granted: entities.Commands{OnOff: &on}}, true)
	if !ok || h.capKw != nil {
		t.Fatalf("on_off:true darf nicht deckeln, got %+v ok=%v", h.capKw, ok)
	}
	if !h.exempt || h.reason != lastmgmt.ReasonPlan {
		t.Fatalf("Rang 60 ist der Plan und befreit: %+v", h)
	}
	// Rang 50 (Frist) befreit ebenfalls und heisst „Plan".
	h, _ = ocppBridgeDecision(desired.Decision{HolderRank: 50, Granted: entities.Commands{OnOff: &on}}, true)
	if !h.exempt || h.reason != lastmgmt.ReasonPlan {
		t.Fatalf("Rang 50: %+v", h)
	}
}

// -----------------------------------------------------------------------
// An den Säulen
// -----------------------------------------------------------------------

// TestAHolderCapsTheStationAtTheChargePoint: „Halter deckelt".
func TestAHolderCapsTheStationAtTheChargePoint(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167) // 82,3 kW Budget - weit über dem Deckel
	st := ocppStation(t, a, "SAEULE-1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	waitUntil(t, "die Säule lädt ohne Halter voll", func() bool {
		return findProfileSoft(st, "TxProfile") >= 21_900
	})

	reg := chargePointEntity("ent-cp-1", "SAEULE-1", 22)
	arb := bindStation(a, reg)
	kw := 6.0
	submitLimit(arb, "ent-cp-1", desired.ClassFlow, &kw, nil, "req-cap")
	a.ocpp.nudge()

	waitUntil(t, "der Deckel des Halters erreicht die Säule", func() bool {
		w := findProfileSoft(st, "TxProfile")
		return w > 5_900 && w < 6_100
	})
	nearKw(t, "gedeckelte Säule", findProfile(t, st, "TxProfile")/1000, 6)
}

// TestAHolderOfZeroPausesTheStationWithItsOwnReason.
func TestAHolderOfZeroPausesTheStationWithItsOwnReason(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	st := ocppStation(t, a, "SAEULE-1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	// ⚠ NICHT-VAKUUM: erst muss sie nachweislich laden, sonst prüft das „< 1"
	// nur, dass noch gar kein Profil installiert wurde.
	waitUntil(t, "die Säule lädt ohne Halter", func() bool {
		return findProfileSoft(st, "TxProfile") > 1_000
	})

	reg := chargePointEntity("ent-cp-1", "SAEULE-1", 22)
	arb := bindStation(a, reg)
	zero := 0.0
	submitLimit(arb, "ent-cp-1", desired.ClassFlow, &zero, nil, "req-off")
	a.ocpp.nudge()

	waitUntil(t, "die Säule pausiert", func() bool {
		return findProfileSoft(st, "TxProfile") < 1
	})
	// Und die Fläche nennt den Grund, statt Leistungsmangel zu behaupten.
	waitUntil(t, "der Grund ist eine Regel, kein Budget", func() bool {
		for _, c := range a.ocppInfo().Chargers {
			for _, con := range c.Connectors {
				if con.Reason == lastmgmt.ReasonRule {
					return true
				}
			}
		}
		return false
	})
}

// TestAHolderExemptsTheStationFromTheSourceLane: „Halter befreit".
//
// Der Standort steht auf „Nur Sonnenstrom" OHNE Überschuss - jede Säule
// pausiert. Ein Plan-Halter (Rang 60) nimmt SEINE Säule aus dieser Bahn: sie
// lädt, die andere nicht. Die PHYSIK bleibt unberührt.
func TestAHolderExemptsTheStationFromTheSourceLane(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	a.ocpp.mu.Lock()
	set := a.ocpp.settings
	set.SurplusPolicy = lastmgmt.PolicySolarOnly
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()

	s1 := ocppStation(t, a, "SAEULE-1", 1, 22)
	s2 := ocppStation(t, a, "SAEULE-2", 1, 22)
	for _, st := range []*ocppsim.Station{s1, s2} {
		if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
			t.Fatalf("plug: %v", err)
		}
	}
	// Kein Überschuss: der Standort bezieht.
	measureSite(t, a, 40, s1, s2)
	waitUntil(t, "ohne Sonne pausieren beide", func() bool {
		return findProfileSoft(s1, "TxProfile") < 1 && findProfileSoft(s2, "TxProfile") < 1
	})

	reg := chargePointEntity("ent-cp-1", "SAEULE-1", 22)
	arb := bindStation(a, reg)
	full := 22.0
	submitLimit(arb, "ent-cp-1", desired.ClassMarket, &full, nil, "req-plan")
	measureSite(t, a, 40, s1, s2)

	waitUntil(t, "die befreite Säule lädt", func() bool {
		return findProfileSoft(s1, "TxProfile") > 1_000
	})
	if w := findProfileSoft(s2, "TxProfile"); w >= 1 {
		t.Fatalf("die ungebundene Säule darf NICHT mitbefreit werden: %.0f W", w)
	}
}

// TestWithoutABindingTheStationFollowsItsSourceByteForByte: „kein Halter =
// Quelle" UND die Kompatibilitäts-Zusage in einem.
func TestWithoutABindingTheStationFollowsItsSourceByteForByte(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	a.ocpp.mu.Lock()
	set := a.ocpp.settings
	set.SurplusPolicy = lastmgmt.PolicySolarOnly
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()
	st := ocppStation(t, a, "SAEULE-1", 1, 22)
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
		t.Fatalf("plug: %v", err)
	}
	measureSite(t, a, 40, st)
	waitUntil(t, "ohne Sonne pausiert sie", func() bool {
		return findProfileSoft(st, "TxProfile") < 1
	})

	// Ein Arbiter MIT Halter, aber OHNE Bindung (die Cloud hat nie eine
	// charge_point_id geschickt): die Brücke ist ein No-op.
	reg := chargePointEntity("ent-cp-1", "", 22)
	arb := bindStation(a, reg)
	full := 22.0
	submitLimit(arb, "ent-cp-1", desired.ClassMarket, &full, nil, "req-plan")
	measureSite(t, a, 40, st)

	time.Sleep(200 * time.Millisecond)
	if w := findProfileSoft(st, "TxProfile"); w >= 1 {
		t.Fatalf("ohne Bindung darf nichts befreit werden: %.0f W", w)
	}
}

// -----------------------------------------------------------------------
// Die QUELLE je Säule (P5, Steuerart je Ladepunkt)
// -----------------------------------------------------------------------

// setStationSource stempelt die Steuerart-Quelle EINER Säule, so wie das
// retained Konfigurations-Dokument es täte.
func setStationSource(t *testing.T, a *Agent, id, source string) {
	t.Helper()
	if _, err := a.ocpp.srv.Update(id, csms.UpdateRequest{Source: &source}); err != nil {
		t.Fatalf("update %s: %v", id, err)
	}
	a.ocpp.nudge()
}

// TestAStationsOwnSourceBindsOnlyItself: der Anlagen-Standard ist „schnell",
// EINE Säule steht auf „Nur Sonnenstrom" — ohne Überschuss pausiert genau sie,
// die andere lädt weiter.
func TestAStationsOwnSourceBindsOnlyItself(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167) // Anlagen-Standard bleibt „schnell"
	s1 := ocppStation(t, a, "SAEULE-SONNE", 1, 22)
	s2 := ocppStation(t, a, "SAEULE-SCHNELL", 1, 22)
	for _, st := range []*ocppsim.Station{s1, s2} {
		if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
			t.Fatalf("plug: %v", err)
		}
	}
	waitUntil(t, "beide laden zunächst", func() bool {
		return findProfileSoft(s1, "TxProfile") > 1_000 && findProfileSoft(s2, "TxProfile") > 1_000
	})

	setStationSource(t, a, "SAEULE-SONNE", string(lastmgmt.PolicySolarOnly))
	measureSite(t, a, 40, s1, s2) // Bezug, also kein Überschuss

	waitUntil(t, "die Sonnen-Säule pausiert", func() bool {
		return findProfileSoft(s1, "TxProfile") < 1
	})
	if w := findProfileSoft(s2, "TxProfile"); w <= 1_000 {
		t.Fatalf("die Säule mit eigener Quelle „schnell\" muss weiter laden: %.0f W", w)
	}
}

// TestAStationOnSchnellIsExemptFromTheSitesSolarLane: der Anlagen-Standard ist
// „Nur Sonnenstrom", EINE Säule steht ausdrücklich auf „schnell" — sie lädt,
// obwohl kein Überschuss da ist. Die PHYSIK bindet sie unverändert.
func TestAStationOnSchnellIsExemptFromTheSitesSolarLane(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 167)
	a.ocpp.mu.Lock()
	set := a.ocpp.settings
	set.SurplusPolicy = lastmgmt.PolicySolarOnly
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()

	s1 := ocppStation(t, a, "SAEULE-CHEF", 1, 22)
	s2 := ocppStation(t, a, "SAEULE-HOF", 1, 22)
	for _, st := range []*ocppsim.Station{s1, s2} {
		if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 22, MinKw: 5}); err != nil {
			t.Fatalf("plug: %v", err)
		}
	}
	measureSite(t, a, 40, s1, s2)
	waitUntil(t, "ohne Sonne pausieren beide", func() bool {
		return findProfileSoft(s1, "TxProfile") < 1 && findProfileSoft(s2, "TxProfile") < 1
	})

	setStationSource(t, a, "SAEULE-CHEF", string(lastmgmt.PolicyFast))
	measureSite(t, a, 40, s1, s2)

	waitUntil(t, "die Chef-Säule lädt", func() bool {
		return findProfileSoft(s1, "TxProfile") > 1_000
	})
	if w := findProfileSoft(s2, "TxProfile"); w >= 1 {
		t.Fatalf("die Säule ohne eigene Wahl folgt weiter dem Anlagen-Standard: %.0f W", w)
	}
}
