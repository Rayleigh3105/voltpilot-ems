package agent

import (
	"math"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// K3 — DIE ARBITRIERUNGS-BRÜCKE: der Ladepunkt wird eine Komponente wie jede
// andere (Konzept `vp-verbrauchsmgmt-konzept-v1` §2.2 K3, Paket P5).
//
// Bis hierher entschied über einen Ladepunkt AUSSCHLIESSLICH `internal/lastmgmt`
// - `agent/ocpp.go` enthielt keinen einzigen `arb.DecisionFor`-Aufruf. Folge
// (Konzept S3): „Günstige Stunden" und „Bis Uhrzeit fertig" waren für eine
// OCPP-Säule strukturell unmöglich, für eine go-e-Wallbox aber möglich - EIN
// Kundenwort, zwei Maschinen, und die eine hatte keine Tür.
//
// Diese Datei ist die Tür, und sie ist bewusst SCHMAL: sie liest je Sitzung das
// Urteil des Arbiters und übersetzt es in genau ZWEI Dinge, die
// `lastmgmt.Session` seit P5 kennt.
//
//  1. **Deckel** (`CapKw`): der granted `limit_kw` des Halters deckelt die
//     Sitzung. 0 ⇒ sie pausiert, mit dem Grund `plan` bzw. `regel`.
//  2. **Befreiung** (`SourceExempt`): ein Halter ab Klasse `deadline-fallback`
//     (Frist 50, Plan 60, Regel/Handeingriff 70/75, Compliance 80+) nimmt die
//     Sitzung aus der QUELLEN-BAHN - genau der Mechanismus, den der Boost seit
//     Stufe 4 benutzt.
//
// ⚠ SIE IST RESTRICT-ONLY, UND DAS IST DIE GANZE SICHERHEITS-AUSSAGE. Der
// Deckel kann `MaxKw` nur SENKEN (`Session.capped`), und die Befreiung wirkt
// ausschliesslich gegen die ÖKONOMIE des Kunden, nie gegen die PHYSIK: Budget,
// Sicherheitsabstand, §14a-Hülle, Rotation, Vorrang, Mindestleistung und das
// Ausfall-Profil binden eine befreite Sitzung Zeichen für Zeichen wie jede
// andere. Der physische Verteiler bleibt der Verteiler.
//
// ⚠ OHNE BINDUNG PASSIERT NICHTS. Welche Entität eine Säule IST, sagt allein
// die Cloud (`charge_point_id` im Registry-Descriptor, der Zwilling von
// `edge_source_id` einen Transport weiter). Eine Box an einer älteren Cloud -
// oder eine Anlage ohne Ladepunkt-Komponente - hat kein einziges Paar, und dann
// ist jede Zeile hier ein No-op: das Verhalten ist byte-identisch zu vor P5.
//
// ⚠ EIN URTEIL OHNE `limit_kw` IST KEIN DECKEL. Die Fähigkeit eines
// `ev-charger` ist genau `limit_kw` (Katalog `entitytypes/catalog.json`), also
// verwirft die Fähigkeits-Prüfung des Arbiters ohnehin alles andere; ein Urteil
// ohne diese Zahl BEFREIT höchstens, es deckelt nie auf eine erfundene Grenze.

// ocppBridgeHolder ist das Urteil des Arbiters, übersetzt für EINE Säule.
type ocppBridgeHolder struct {
	// capKw ist der granted limit_kw des Halters; nil = der Halter nennt keine
	// Leistung (dann bleibt die Säule bei ihrem eigenen Deckel).
	capKw *float64
	// exempt = der Halter steht ab Klasse deadline-fallback und nimmt die
	// Sitzung damit aus der Quellen-Bahn.
	exempt bool
	// reason ist das Wort für eine Pause bei capKw == 0.
	reason string
}

// ocppBridgeExemptRank ist die Klassen-Schwelle der Befreiung: ab
// `deadline-fallback` (50) aufwärts. Ein PLAIN opportunistischer Flow-Wunsch
// (40) befreit ausdrücklich NICHT - eine Regel, die nur „gerne würde", hebt die
// Quellen-Wahl des Kunden nicht auf.
const ocppBridgeExemptRank = 50

// ocppBridgeDecision übersetzt EIN Arbiter-Urteil. Rein: keine Uhr, kein I/O,
// kein Zustand - das `otaapply`/`probe`-Muster des Hauses.
//
// ok=false = kein Halter (oder ein Halter ohne Aussage über diese Säule); dann
// gilt die Steuerart-Quelle der Säule unverändert.
func ocppBridgeDecision(dec desired.Decision, ok bool) (ocppBridgeHolder, bool) {
	if !ok {
		return ocppBridgeHolder{}, false
	}
	out := ocppBridgeHolder{
		exempt: dec.HolderRank >= ocppBridgeExemptRank,
		reason: ocppBridgeReason(dec),
	}
	if v := dec.Granted.LimitKw; v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= 0 {
		kw := *v
		out.capKw = &kw
	}
	// ⚠ Ein `on_off:false` ist ein DECKEL VON 0, nicht ein eigener Kanal: die
	// Säule kennt nur `limit_kw`, und „aus" heisst bei einem Ladepunkt genau
	// „lade nichts". Ohne diese Zeile könnte ein künftiger Typ, der beides
	// deklariert, ein ausdrückliches Aus still verlieren.
	if v := dec.Granted.OnOff; v != nil && !*v {
		zero := 0.0
		out.capKw = &zero
	}
	if out.capKw == nil && !out.exempt {
		// Weder Deckel noch Befreiung: der Halter sagt über diese Säule
		// nichts, was die Verteilung ändern könnte.
		return ocppBridgeHolder{}, false
	}
	return out, true
}

// ocppBridgeReason wählt das Wort einer erzwungenen Pause. Der PLAN und eine
// REGEL schicken den Kunden an zwei verschiedene Orte, also sind es zwei
// Wörter; alles ab `contract` aufwärts ist ebenfalls keine Regel des Kunden,
// wird aber als solche benannt, weil es dieselbe Handlung ist („etwas hält
// diese Säule, es ist kein Leistungsmangel").
func ocppBridgeReason(dec desired.Decision) string {
	if dec.HolderRank == 60 || dec.HolderRank == 50 {
		return lastmgmt.ReasonPlan
	}
	return lastmgmt.ReasonRule
}

// ocppApplyBridge stempelt die Urteile des Arbiters auf die Allokator-Eingabe.
// Die Zuordnung Säule → Entität ist die der Cloud; ohne sie ändert sich nichts.
func ocppApplyBridge(sessions []lastmgmt.Session, entityByChargePoint map[string]string,
	byKey map[string]ocppClaim, decide func(string) (desired.Decision, bool)) {
	if len(entityByChargePoint) == 0 || decide == nil {
		return
	}
	// Je Säule EINMAL gefragt, nicht je Stecker: das Urteil gilt der
	// Komponente, und zwei Stecker derselben Säule sind eine Komponente.
	cache := map[string]ocppBridgeHolder{}
	seen := map[string]bool{}
	for i := range sessions {
		claim, ok := byKey[sessions[i].Key]
		if !ok {
			continue
		}
		entityID := entityByChargePoint[claim.chargerID]
		if entityID == "" {
			continue
		}
		if !seen[entityID] {
			seen[entityID] = true
			if h, has := ocppBridgeDecision(decide(entityID)); has {
				cache[entityID] = h
			}
		}
		h, has := cache[entityID]
		if !has {
			continue
		}
		sessions[i].CapKw = h.capKw
		sessions[i].CapReason = h.reason
		sessions[i].SourceExempt = h.exempt
	}
}
