package lastmgmt

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"
)

// This file is „SONNE + SPEICHER" (06.10.2026): the third reading of the ONE
// source lane. A charge point on that source (`charge_points[].storage_release`
// on top of the lane word `nur_sonne`) may take the PV surplus PLUS battery
// energy above a floor the cloud computed - the energy the house does not need
// until the next PV generation (services/optimization storage_release.py).
//
// The cloud PLANS the floor; the box decides whether to RELEASE, against
// measured values only, and every unknown fails CLOSED into „Nur Sonne":
//
//	no fresh plan / no floor in the running slot / unknown or stale SoC /
//	no battery measurement / battery path not ready / BMS blocks discharge
//	=> no release; the vehicle charges exactly like „Nur Sonne".
//
// ⚠ THE RELEASE IS A POWER, NOT AN ENERGY, AND IT IS SHARED ONCE. While the
// measured SoC is above the floor the cars on the source may draw
//
//	release = min(cloud max discharge, box rated discharge, BMS discharge)
//	          − the house deficit the battery already covers
//
// kilowatts BEYOND the whole surplus. The allocator (Decide) books it as one
// more reading of the same lane, decremented by every source-bound allocation,
// so all charge points together can never take it twice. The SoC check runs
// on every pass; at the floor the release stops at once.
//
// ⚠ AT OR BELOW THE FLOOR THE BATTERY COMES FIRST, even on an „Autos zuerst"
// site: the floor assumes the forecast surplus refills the battery for the
// night, so a car that took that surplus would empty the night the floor was
// computed for. In every OTHER fallback (no plan, no floor in this slot, SoC
// unknown) the station is plainly „Nur Sonne" with the site's own priority.
//
// ⚠ MEASURED EFFECT BEATS THE PROMISE. The battery covers the cars through its
// ordinary regulation (self-consumption, deficit cover, load following, and
// the release cover in agent.applySetpoint). If the site nevertheless keeps
// importing from the grid while cars draw released power, the release is
// withdrawn for ReleaseLatch - „Netzstrom fürs Auto gibt es in dieser Quelle
// nicht" is a promise about the meter, not about a register.

// ReleaseMode is the machine word of the release stage; the German sentence
// travels next to it (the surplus Mode/Reason pair).
type ReleaseMode string

const (
	// ReleaseOff: no station on this box runs „Sonne + Speicher".
	ReleaseOff ReleaseMode = "aus"
	// ReleaseActive: battery energy above the floor goes to the cars.
	ReleaseActive ReleaseMode = "frei"
	// ReleaseAtFloor: the floor is known and the battery is at or below it.
	ReleaseAtFloor ReleaseMode = "an_der_grenze"
	// ReleaseNoPlan: no fresh plan, or a plan that computed no floor.
	ReleaseNoPlan ReleaseMode = "kein_plan"
	// ReleasePlanTrades: the plan is fresh, but the running slot carries no
	// floor - the plan imports or sells in this slot and wins.
	ReleasePlanTrades ReleaseMode = "plan_handelt"
	// ReleaseSocUnknown: no fresh measured SoC.
	ReleaseSocUnknown ReleaseMode = "ladestand_unbekannt"
	// ReleaseNoMeasurement: no fresh site measurement with battery power.
	ReleaseNoMeasurement ReleaseMode = "keine_messung"
	// ReleaseBatteryPath: the battery path cannot cover the cars right now.
	ReleaseBatteryPath ReleaseMode = "speicherpfad"
	// ReleaseBmsBlocks: the battery's own protection forbids discharge.
	ReleaseBmsBlocks ReleaseMode = "bms_sperrt"
	// ReleaseNoPower: the battery already covers the house at full power.
	ReleaseNoPower ReleaseMode = "keine_leistung"
	// ReleaseEffectLatch: the site kept importing while releasing.
	ReleaseEffectLatch ReleaseMode = "wirkung"
)

// The cloud's reasons for a run without any floor (mqtt-schedule
// ev_release_reason) are forwarded as modes of their own.
const (
	ReleaseCloudNoSoc       ReleaseMode = "kein_ladestand"
	ReleaseCloudHeld        ReleaseMode = "speicher_gehalten"
	ReleaseCloudStale       ReleaseMode = "prognose_veraltet"
	ReleaseCloudNightTooBig ReleaseMode = "nachtbedarf_ueber_kapazitaet"
	ReleaseCloudReserveBig  ReleaseMode = "reserve_ueber_kapazitaet"
	ReleaseCloudTooShort    ReleaseMode = "prognose_zu_kurz"
)

const (
	// ReleaseOnMarginPct: the release starts once the SoC lies this many
	// points ABOVE the floor ...
	ReleaseOnMarginPct = 2.0
	// ReleaseOffMarginPct: ... and stops once it is down to this margin. The
	// band keeps a car from toggling on every SoC tick at the floor.
	ReleaseOffMarginPct = 0.5
	// ReleaseImportToleranceKw is the grid import the effect check tolerates
	// while cars draw released power (regulation noise, the damped follower's
	// ramp).
	ReleaseImportToleranceKw = 0.5
	// ReleaseEffectWindow is how long the import must persist ...
	ReleaseEffectWindow = 90 * time.Second
	// ReleaseLatch is how long a release that did not work stays withdrawn.
	ReleaseLatch = 15 * time.Minute
	// ReleaseMinKw: below this the release is no statement.
	ReleaseMinKw = 0.05
)

// ReleaseInput are the facts of one decision.
type ReleaseInput struct {
	Now time.Time
	// PlanFresh is plan.Fresh(now).
	PlanFresh bool
	// MaxDischargeKw is the plan's ev_release_max_discharge_kw: nil = the plan
	// computed no floor for this site at all.
	MaxDischargeKw *float64
	// CloudReason is the plan's ev_release_reason ("" = none).
	CloudReason string
	// FloorPct is the running slot's ev_release_floor_soc_pct (nil = none).
	FloorPct *float64
	// SocPct is the measured SoC; nil = unknown or stale.
	SocPct *float64
	// DeficitKw / Measured come from BudgetTracker.ReleaseFacts.
	DeficitKw float64
	Measured  bool
	// BatteryReady says the battery path covers a vehicle's draw right now
	// (agent.applySetpoint); BatteryNote is its German reason when not.
	BatteryReady bool
	BatteryNote  string
	// RatedDischargeKw is the box's own rated band (0 = no statement);
	// BmsDischargeKw the BMS envelope (NaN = no statement); BmsBlocked its
	// hard stop.
	RatedDischargeKw float64
	BmsDischargeKw   float64
	BmsBlocked       bool
}

// ReleaseVerdict is one decision.
type ReleaseVerdict struct {
	// Active: cars on the source may draw Kw of battery power beyond the sun.
	Active bool    `json:"active"`
	Kw     float64 `json:"kw,omitempty"`
	// StorageFirst: the floor is known and the battery is at or below it -
	// cars on the source are served AFTER the battery.
	StorageFirst bool        `json:"storage_first,omitempty"`
	FloorPct     *float64    `json:"floor_soc_pct,omitempty"`
	SocPct       *float64    `json:"soc_pct,omitempty"`
	Mode         ReleaseMode `json:"mode"`
	Reason       string      `json:"reason,omitempty"`
}

// ReleaseGate carries the hysteresis and the effect latch across passes. It
// is mutated ONLY by the executor (Decide + Observe); a surface reads the
// last verdict instead of evaluating again, so it can never show a release
// the stations were not given.
type ReleaseGate struct {
	mu           sync.Mutex
	active       bool
	importSince  time.Time
	latchedUntil time.Time
	last         ReleaseVerdict
	lastAt       time.Time
}

// Decide forms the verdict of this pass and remembers it.
func (g *ReleaseGate) Decide(in ReleaseInput) ReleaseVerdict {
	g.mu.Lock()
	defer g.mu.Unlock()
	v := g.decideLocked(in)
	g.active = v.Active
	g.last, g.lastAt = v, in.Now
	return v
}

// Off records that no station runs the source - the surface then says
// nothing about a release at all.
func (g *ReleaseGate) Off(now time.Time) ReleaseVerdict {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.active = false
	g.importSince = time.Time{}
	g.last, g.lastAt = ReleaseVerdict{Mode: ReleaseOff}, now
	return g.last
}

// Last returns the verdict of the newest pass and when it was formed.
func (g *ReleaseGate) Last() (ReleaseVerdict, time.Time) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.last, g.lastAt
}

func (g *ReleaseGate) decideLocked(in ReleaseInput) ReleaseVerdict {
	v := ReleaseVerdict{FloorPct: in.FloorPct, SocPct: in.SocPct}
	off := func(m ReleaseMode, reason string) ReleaseVerdict {
		v.Active, v.Kw, v.Mode, v.Reason = false, 0, m, reason
		return v
	}
	if !in.PlanFresh || in.MaxDischargeKw == nil {
		v.FloorPct = nil
		return off(ReleaseNoPlan, "Ohne aktuellen Fahrplan rechnet niemand die Untergrenze des Speichers – "+
			"es lädt nur mit Sonnenstrom, wie bei „Nur Sonne“.")
	}
	if in.CloudReason != "" && in.FloorPct == nil {
		return off(ReleaseMode(in.CloudReason), cloudReasonText(in.CloudReason))
	}
	if in.FloorPct == nil {
		return off(ReleasePlanTrades, "In dieser Viertelstunde nutzt der Fahrplan den Speicher selbst "+
			"(Netzbezug oder Verkauf) – der Fahrplan geht vor, es lädt nur mit Sonnenstrom.")
	}
	if in.SocPct == nil {
		v.SocPct = nil
		return off(ReleaseSocUnknown, "Der Ladestand des Speichers ist gerade nicht gemessen. Unbekannt ist "+
			"nicht leer und nicht voll – es wird nichts freigegeben, nur Sonnenstrom.")
	}
	floor, soc := *in.FloorPct, *in.SocPct
	// The floor is a FACT from here on: whatever else is missing, at or below
	// it the battery comes first (see the file doc).
	margin := ReleaseOnMarginPct
	if g.active {
		margin = ReleaseOffMarginPct
	}
	if soc <= floor+margin {
		v.StorageFirst = true
		return off(ReleaseAtFloor, fmt.Sprintf("Der Speicher steht bei %s %% und damit an seiner Untergrenze "+
			"von %s %% – er bleibt für die Nacht. Das Auto lädt nur mit Sonnenstrom, der Speicher wird zuerst "+
			"gefüllt.", pctText(soc), pctText(floor)))
	}
	if !in.Measured {
		return off(ReleaseNoMeasurement, "Ohne frische Messung am Netzanschluss und am Speicher lässt sich "+
			"nicht belegen, was der Speicher schon für das Haus liefert – nur Sonnenstrom.")
	}
	if !in.BatteryReady {
		note := strings.TrimSpace(in.BatteryNote)
		if note == "" {
			note = "Der Speicher kann die Ladung gerade nicht übernehmen"
		}
		return off(ReleaseBatteryPath, note+" – es lädt nur mit Sonnenstrom.")
	}
	if in.BmsBlocked {
		return off(ReleaseBmsBlocks, "Der Schutz des Speichers erlaubt gerade keine Entladung – nur Sonnenstrom.")
	}
	if in.Now.Before(g.latchedUntil) {
		mins := int(math.Ceil(g.latchedUntil.Sub(in.Now).Minutes()))
		return off(ReleaseEffectLatch, fmt.Sprintf("Während der Freigabe kam Strom aus dem Netz – der Speicher "+
			"hat die Ladung nicht übernommen. Noch %d Minuten lädt das Auto nur mit Sonnenstrom.", mins))
	}
	maxKw := *in.MaxDischargeKw
	if in.RatedDischargeKw > 0 && in.RatedDischargeKw < maxKw {
		maxKw = in.RatedDischargeKw
	}
	if !math.IsNaN(in.BmsDischargeKw) && in.BmsDischargeKw >= 0 && in.BmsDischargeKw < maxKw {
		maxKw = in.BmsDischargeKw
	}
	kw := round3(maxKw - math.Max(0, in.DeficitKw))
	if !budgetFinite(kw) || kw < ReleaseMinKw {
		return off(ReleaseNoPower, "Der Speicher deckt gerade schon das Haus mit seiner ganzen Leistung – "+
			"für das Auto bleibt nur Sonnenstrom.")
	}
	v.Active, v.Kw, v.Mode = true, kw, ReleaseActive
	v.Reason = fmt.Sprintf("Der Speicher gibt bis %s kW für das Auto frei und darf bis %s %% entladen – "+
		"darüber braucht das Haus laut Prognose bis zur nächsten Sonne nichts (jetzt %s %%).",
		kwText(kw), pctText(floor), pctText(soc))
	return v
}

// ObserveEffect is the effect check of one executor pass: usedKw is the
// battery power the allocation handed to cars beyond the sun
// (Plan.StorageReleaseUsedKw), gridKw the measured grid power (+ import),
// measured whether that reading is fresh. It returns true when it just
// latched the release off.
func (g *ReleaseGate) ObserveEffect(now time.Time, usedKw, gridKw float64, measured bool) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.active || usedKw < ReleaseMinKw || !measured || gridKw <= ReleaseImportToleranceKw {
		g.importSince = time.Time{}
		return false
	}
	if g.importSince.IsZero() {
		g.importSince = now
		return false
	}
	if now.Sub(g.importSince) < ReleaseEffectWindow {
		return false
	}
	g.latchedUntil = now.Add(ReleaseLatch)
	g.importSince = time.Time{}
	g.active = false
	return true
}

func cloudReasonText(reason string) string {
	switch ReleaseMode(reason) {
	case ReleaseCloudNoSoc:
		return "Der Fahrplan hat keinen gemessenen Ladestand des Speichers – ohne ihn keine Freigabe, " +
			"nur Sonnenstrom."
	case ReleaseCloudHeld:
		return "Eine Regel hält den Speicher – er wird nicht für das Auto freigegeben, nur Sonnenstrom."
	case ReleaseCloudStale:
		return "Die Prognose für Last oder Sonne ist veraltet oder fehlt – ohne sie keine Freigabe, " +
			"nur Sonnenstrom."
	case ReleaseCloudNightTooBig:
		return "Laut Prognose braucht das Haus bis zur nächsten Sonne mehr, als der Speicher fasst – " +
			"es wird nichts freigegeben, nur Sonnenstrom."
	case ReleaseCloudReserveBig:
		return "Die eingestellte Reserve lässt im Speicher keinen Platz für eine Freigabe – nur Sonnenstrom."
	case ReleaseCloudTooShort:
		return "Die Prognose reicht noch nicht bis zur nächsten Sonne, die das Haus wieder deckt – " +
			"ohne sie keine Freigabe, nur Sonnenstrom."
	}
	return "Der Fahrplan gibt den Speicher gerade nicht frei – nur Sonnenstrom."
}
