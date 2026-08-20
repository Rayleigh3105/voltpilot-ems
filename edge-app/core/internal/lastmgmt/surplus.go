package lastmgmt

import (
	"math"
	"strings"
	"time"
)

// This file is STUFE 4 of the load-management concept
// (`vp-ocpp-lastmgmt-konzept-w4` §8 Stufe 4 / PR 13, Mockups
// `vp-ocpp-mockups-r5` §2a/§2b): the second EINGANG of the ONE distribution
// mechanism.
//
// The two named uses are not two mechanisms, they are two inputs of the same
// allocator (Mockups §2a, verbatim):
//
//	Ladepark-Lastmanagement  -> the OBERGRENZE   (physical: budget.go)
//	PV-Überschussladen       -> the QUELLEN-Politik (economic: this file)
//
// The lower of the two wins, and NEITHER of them can soften the connection
// limit or the failsafe. That sentence is the whole design; everything below
// is its arithmetic.
//
// ⚠ THE SURPLUS IS THE BUDGET TRACKER'S OWN `rest`, NOT A SECOND MEASUREMENT.
// budget.go already pairs the site's measured grid power with the measured
// charging power and keeps `rest = grid − charging` — the site's net position
// WITHOUT the charge points. If that is negative the site would export, and
// what it would export is precisely the surplus the cars may take:
//
//	Überschuss = max(0, −rest)
//
// PV, building load and the battery are netted in automatically because they
// are already inside that one measured number — the same advantage the dynamic
// budget has over planning, and the reason there is no second truth here to
// drift from the first. It also means the SAME trailing-maximum window serves
// both jobs: a maximum of `rest` is a MINIMUM of the surplus, so the smoothing
// is conservative in both directions with one mechanism (see budget.go).
//
// ⚠ THE STORAGE ARBITRATION IS A SPLIT OF ONE MEASURED QUANTITY, and it is
// symmetric by construction. Let `batt` be the power the battery is MEASURED
// taking. Then
//
//	S = max(0, batt − rest)        the WHOLE surplus, before anybody took it
//
// is independent of how it is currently split, because `rest` contains the
// battery's own draw. From there the customer's choice is one subtraction:
//
//	speicher_vor_auto : cars get  max(0, S − batt)   ( = max(0, −rest), the
//	                    measured status quo — the battery already took its
//	                    share and what is left is what the cars may have)
//	auto_vor_speicher : cars get  S, and the BATTERY is capped at
//	                    max(0, S − cars) (StorageChargeCap below)
//
// Without that cap the cars-first choice would be a wish rather than a rule:
// the battery would keep charging on its own plan while the cars claimed the
// same kilowatts, and the site would import the difference — which is exactly
// what "Nur Sonnenstrom" promises never happens. The cap is RESTRICT-ONLY (it
// can only ever lower a charge), so it can never violate a guard.
//
// ⚠ BLIND IS NOT "UNLIMITED SURPLUS", and the two policies fail in OPPOSITE
// directions — deliberately, because their promises are opposite:
//
//	nur_sonne     without a fresh measurement -> 0 kW (pause). We cannot PROVE
//	              a surplus, and charging anyway would buy grid power under a
//	              promise that says it never does.
//	sonne_zuerst  without a fresh measurement -> no source cap at all. Its
//	              promise is "the surplus is used FIRST", not "only"; leaving a
//	              customer's fleet standing because a meter hiccuped would be
//	              the wrong failure.
//
// Both say so in their own German sentence. Nothing here ever touches the
// physical budget: a blind SOURCE lane cannot widen the connection limit,
// because that limit lives in the other input.

// SurplusPolicy is the customer's SOURCE choice, plant-wide (Mockups §2b). The
// values are the machine words; the German sentences live in this file and
// nowhere else.
type SurplusPolicy string

const (
	// PolicySolarOnly — „Nur Sonnenstrom": geladen wird ausschließlich der
	// Überschuss. Zieht eine Wolke auf, pausiert das Laden.
	PolicySolarOnly SurplusPolicy = "nur_sonne"
	// PolicySolarFirst — „Sonne zuerst, Netz wenn günstig" (die Vorgabe): der
	// Überschuss wird immer zuerst genutzt; ein laufendes Fahrzeug behält
	// seine Mindestleistung, damit es planbar voll wird.
	PolicySolarFirst SurplusPolicy = "sonne_zuerst"
	// PolicyFast — „Schnell laden": volle verfügbare Leistung, Quelle egal.
	// Die Anschlussgrenze gilt natürlich weiter.
	PolicyFast SurplusPolicy = "schnell"
)

// StoragePriority is the customer's answer to "Auto oder Speicher zuerst?".
type StoragePriority string

const (
	// StorageBeforeCars is the DEFAULT and the measured status quo: the
	// battery follows its own plan and the cars take what is left.
	StorageBeforeCars StoragePriority = "speicher_vor_auto"
	// CarsBeforeStorage hands the surplus to the vehicles first and caps the
	// battery's charge at what remains (StorageChargeCap).
	CarsBeforeStorage StoragePriority = "auto_vor_speicher"
)

// SurplusMode is the machine-readable stage of the source lane; the German
// sentence travels next to it (the otaapply Blocker/reason pair).
type SurplusMode string

const (
	// SurplusOff: the customer chose „Schnell laden" — there is no source cap.
	SurplusOff SurplusMode = "aus"
	// SurplusMeasured: the cap comes out of a fresh measurement.
	SurplusMeasured SurplusMode = "gemessen"
	// SurplusUnprovable: no fresh measurement. What that MEANS depends on the
	// policy (see the file doc) — the verdict says which.
	SurplusUnprovable SurplusMode = "nicht_belegbar"
)

// NormalizePolicy resolves the stored word.
//
// ⚠ THE DEFAULT IS `PolicyFast`, AND THAT IS THE COMPATIBILITY PROMISE OF THE
// WHOLE STUFE: it is the NEUTRAL value — no source cap at all — so a site whose
// customer never opened the „PV-Überschussladen"-Karte allocates byte for byte
// as it did in Stufe 1-3. „Sonne zuerst" is the default INSIDE the card (what
// the surface preselects when the customer switches it on), never the default
// of a site that was never asked.
//
// An UNKNOWN word resolves the same way, deliberately: a choice we cannot read
// must never invent a RESTRICTION (which would strand a customer's fleet on a
// corrupt byte) and must never invent a PROMISE either — and „Schnell laden" is
// the one value that claims nothing about the source. The write path
// (Settings.Apply) REFUSES an unknown word by name, so this branch can only be
// reached by a hand-edited file, and every surface shows the EFFECTIVE policy.
func NormalizePolicy(p SurplusPolicy) SurplusPolicy {
	switch p {
	case PolicySolarOnly, PolicySolarFirst, PolicyFast:
		return p
	}
	return PolicyFast
}

// NormalizeStorage maps an unknown word onto the default (the measured status
// quo, which changes nothing).
func NormalizeStorage(s StoragePriority) StoragePriority {
	if s == CarsBeforeStorage {
		return CarsBeforeStorage
	}
	return StorageBeforeCars
}

// PolicyText is the customer's own wording of their choice — used where a
// sentence has to NAME the priority it is acting on („kein Überschuss (Ihre
// Priorität: Nur Sonnenstrom)").
func PolicyText(p SurplusPolicy) string {
	switch NormalizePolicy(p) {
	case PolicySolarOnly:
		return "Nur Sonnenstrom"
	case PolicyFast:
		return "Schnell laden"
	}
	return "Sonne zuerst, Netz wenn günstig"
}

// SurplusVerdict is one evaluation of the SOURCE lane, with the terms it came
// from so a surface can show the arithmetic instead of a bare number.
type SurplusVerdict struct {
	// Active is false when there is NO source cap at all — either because the
	// customer chose „Schnell laden", or because the lane cannot be proven and
	// the chosen policy fails open (see the file doc).
	Active bool `json:"active"`
	// Kw is the source cap. Only meaningful while Active.
	Kw float64 `json:"kw"`
	// AllowMinimum is the „Sonne zuerst" concession: a vehicle whose minimum
	// does not fit into the surplus still gets it — from the grid — so it is
	// never left standing. „Nur Sonnenstrom" never sets it.
	AllowMinimum bool `json:"allow_minimum,omitempty"`
	// Policy / Storage echo the choice the verdict was formed under.
	Policy  SurplusPolicy   `json:"policy"`
	Storage StoragePriority `json:"storage"`
	// Mode / Reason are the machine word and its German sentence.
	Mode   SurplusMode `json:"mode"`
	Reason string      `json:"reason,omitempty"`
	// TotalKw is S — the whole measured surplus before anybody took it. nil
	// without a fresh measurement (never a fabricated 0).
	TotalKw *float64 `json:"total_kw,omitempty"`
	// BatteryKw is the power the battery was MEASURED taking, when it was
	// reported. nil = the site has no battery measurement on this path.
	BatteryKw *float64 `json:"battery_kw,omitempty"`
	// Blind is true whenever the verdict was NOT formed from a fresh
	// measurement.
	Blind bool `json:"blind,omitempty"`
}

// Surplus evaluates the SOURCE lane for now.
//
// It is idempotent for a given moment, so a render evaluates exactly what the
// next executor pass would — the same discipline the budget verdict follows,
// and the reason the page can never show a number the stations were not given.
func (t *BudgetTracker) Surplus(now time.Time, policy SurplusPolicy, storage StoragePriority) SurplusVerdict {
	policy, storage = NormalizePolicy(policy), NormalizeStorage(storage)
	out := SurplusVerdict{Policy: policy, Storage: storage}

	if policy == PolicyFast {
		out.Mode = SurplusOff
		out.Reason = "Schnell laden: die Fahrzeuge nutzen die volle verfügbare Leistung, " +
			"Quelle egal. Die Anschlussgrenze gilt unverändert."
		return out
	}

	t.mu.Lock()
	seen, at := t.seen, t.at
	restHold, restNoBattHold := t.restHoldLocked(), t.restNoBattHoldLocked()
	batt, haveBatt := t.battKw, t.haveBatt
	t.mu.Unlock()

	fresh := seen && !at.IsZero() && now.Sub(at) <= BudgetFreshWindow && !now.Before(at)
	if !fresh {
		out.Mode, out.Blind = SurplusUnprovable, true
		if policy == PolicySolarOnly {
			out.Active, out.Kw = true, 0
			out.Reason = "Ohne Messung am Netzanschluss lässt sich kein Sonnenüberschuss belegen — " +
				"bei „Nur Sonnenstrom“ wird dann nicht geladen."
			return out
		}
		out.Reason = "Ohne Messung am Netzanschluss lässt sich der Sonnenanteil nicht belegen — " +
			"es gilt allein Ihre Anschlussgrenze."
		return out
	}

	// S — the whole surplus, before anybody took it. `restNoBatt` is the site's
	// net position without the charge points AND without the battery, so its
	// negative part is what PV offers beyond the building.
	total := round3(math.Max(0, -restNoBattHold))
	out.TotalKw = &total
	if haveBatt {
		b := round3(batt)
		out.BatteryKw = &b
	}

	out.Active, out.Mode = true, SurplusMeasured
	switch storage {
	case CarsBeforeStorage:
		out.Kw = total
	default:
		// The measured status quo: the battery already took its share and what
		// is left is `max(0, −rest)`.
		out.Kw = round3(math.Max(0, -restHold))
	}
	out.AllowMinimum = policy == PolicySolarFirst
	out.Reason = surplusReason(out)
	return out
}

// StorageChargeCap is the OTHER half of „Auto vor Speicher": how much the
// battery may still charge once the vehicles have taken their share.
//
// ⚠ It is RESTRICT-ONLY and it is the reason cars-first is a rule rather than
// a wish. carsKw is what the charge points are MEASURED drawing right now
// (never what they were allocated — an allocation a vehicle does not use must
// not be taken from the battery).
//
// ok=false means "do not touch the battery": the customer did not choose
// cars-first, no vehicle is drawing, or there is no fresh measurement to
// judge from. A blind cap would be a guess about a customer's storage.
func (t *BudgetTracker) StorageChargeCap(now time.Time, policy SurplusPolicy, storage StoragePriority, carsKw float64) (float64, bool) {
	if NormalizeStorage(storage) != CarsBeforeStorage {
		return 0, false
	}
	if NormalizePolicy(policy) == PolicyFast {
		// „Schnell laden" makes no statement about the SOURCE, so it makes no
		// statement about the battery either.
		return 0, false
	}
	if !budgetFinite(carsKw) || carsKw <= 1e-9 {
		return 0, false
	}
	v := t.Surplus(now, policy, storage)
	if !v.Active || v.Blind || v.TotalKw == nil {
		return 0, false
	}
	return round3(math.Max(0, *v.TotalKw-carsKw)), true
}

// surplusReason spells the lane out in one sentence the customer can check
// against their own meter.
func surplusReason(v SurplusVerdict) string {
	var b strings.Builder
	b.WriteString("Ihre Priorität: ")
	b.WriteString(PolicyText(v.Policy))
	b.WriteString(". ")
	if v.Kw <= 1e-9 {
		b.WriteString("Gerade steht kein Sonnenüberschuss zur Verfügung")
		if v.Storage == StorageBeforeCars && v.BatteryKw != nil && *v.BatteryKw > 0.05 {
			b.WriteString(" — der Speicher nimmt ihn zuerst (Ihre Wahl)")
		}
		b.WriteString(".")
	} else {
		b.WriteString("Für die Fahrzeuge stehen gerade ")
		b.WriteString(kwText(v.Kw))
		b.WriteString(" kW Sonnenüberschuss zur Verfügung")
		if v.Storage == CarsBeforeStorage {
			b.WriteString(" — die Fahrzeuge gehen vor dem Speicher (Ihre Wahl)")
		}
		b.WriteString(".")
	}
	if v.AllowMinimum {
		b.WriteString(" Reicht er für ein Fahrzeug nicht aus, hält VoltPilot dessen Mindestleistung " +
			"mit Netzstrom, damit es planbar voll wird.")
	}
	return b.String()
}

// --- „Jetzt voll laden" (Mockups §2b) -------------------------------------

// BoostMaxDuration is the cap of ONE override: „bis das Fahrzeug voll ist,
// längstens 4 Stunden". It is a promise, not a trap - a longer request is
// clamped, never refused.
const BoostMaxDuration = 4 * time.Hour

// BoostRequest is „Jetzt voll laden" for ONE charging session.
type BoostRequest struct {
	// ChargePointID + Connector name the session. Both are required: a boost
	// is per LADEVORGANG, never per station (Mockups §2b).
	ChargePointID string `json:"charge_point_id"`
	Connector     int    `json:"connector_id"`
	// Minutes is the requested duration; 0 = the 4-hour cap. Values above the
	// cap are clamped, never refused — the cap is a promise, not a trap.
	Minutes int `json:"minutes,omitempty"`
	// Cancel ends a running boost instead of starting one.
	Cancel bool `json:"cancel,omitempty"`
}

// BoostResult is what the surface renders back.
type BoostResult struct {
	Key      string `json:"key"`
	Active   bool   `json:"active"`
	UntilMs  int64  `json:"until_ms,omitempty"`
	Note     string `json:"note"`
	Duration int    `json:"minutes,omitempty"`
}
