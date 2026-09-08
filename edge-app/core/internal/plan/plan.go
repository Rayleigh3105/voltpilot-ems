// Package plan caches the cloud battery-dispatch schedule and selects the
// setpoint for "now".
//
// Contract: docs/contracts/mqtt-schedule.schema.json (FROZEN). The plan is
// received retained on ems/{t}/{s}/{d}/schedule, persisted to disk (so a
// reboot without network still has it) and considered STALE when no fresh
// schedule has been received for 20 minutes - the contract's x-failsafe
// Default-Watchdog window. Stale/missing plan, or "now" outside every slot,
// hands control to the self-consumption fallback (guards.SelfConsumption).
package plan

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"
)

// StaleAfter is the contract's Default-Watchdog window: a schedule not
// refreshed within this window no longer drives the battery.
const StaleAfter = 20 * time.Minute

// redeliverySlack bounds how far behind generated_at a NEWLY received plan may
// lag before it is treated as a broker redelivery of an old retained payload
// rather than a fresh publish. The optimizer republishes every 15 min, well
// inside StaleAfter; the extra slack absorbs publish latency and modest clock
// skew between optimizer and edge.
const redeliverySlack = 5 * time.Minute

// Slot is one dispatch slot. Positive setpoint = charge, negative = discharge.
type Slot struct {
	Start             time.Time `json:"start"`
	BatterySetpointKw float64   `json:"battery_setpoint_kw"`
	// PvLimitKw is the OPTIONAL planned PV feed-in cap (curtailment) for the
	// slot, kW, >= 0. nil = no limit (the contract's default). The edge does not
	// EXECUTE this field (see docs/contracts/mqtt-schedule.schema.json), but it is
	// retained so the local Fahrplan view can show the planned curtailment.
	PvLimitKw *float64 `json:"pv_limit_kw,omitempty"`
	// ChargeFromSurplusOnly is the OPTIONAL price-aware trim duty of the slot
	// (2026-07-30): true = the cloud determined that topping this slot's charge
	// up from the GRID costs more than the extra stored kWh earns over the rest
	// of the horizon, so the executor must clamp commanded CHARGE to the MEASURED
	// surplus max(pv - load, 0). The edge never evaluates a price - the whole
	// price decision is the cloud's (guards.PriceTrimmer only enforces).
	//
	// FAIL-OPEN, deliberately the OPPOSITE of GridChargeAllowed: absent/false =
	// no restriction, i.e. byte-for-byte pre-feature behavior. GridChargeAllowed
	// is REGULATORY (EEG) and therefore fails safe; this one is ECONOMIC, and an
	// unpriced restriction inferred from a missing field would destroy real
	// arbitrage on a merchant site. Both compose most-restrictive-wins.
	ChargeFromSurplusOnly bool `json:"charge_from_surplus_only,omitempty"`
	// CoverLoadFromBattery is the OPTIONAL in-slot LOAD-FOLLOWING duty of the
	// slot (2026-07-30, the discharge-side mirror of ChargeFromSurplusOnly):
	// true = the cloud determined that covering the house from the battery is
	// economic here (its import price exceeds lambda/eta + wear), so the
	// executor may RAISE the commanded discharge to the MEASURED deficit
	// max(load - pv, 0) instead of running this slot's forecast-derived watt
	// value rigidly and letting the difference be bought from the grid. The edge
	// never evaluates a price - guards.LoadFollower only enforces.
	//
	// FAIL-OPEN exactly like ChargeFromSurplusOnly: absent/false = no load
	// following = byte-for-byte pre-feature behavior. An inferred duty would be
	// the price-blind self-consumption logic, which is precisely what the
	// price-aware plan replaced.
	CoverLoadFromBattery bool `json:"cover_load_from_battery,omitempty"`
	// UnplannedLoadDischarge is a DISTINCT authorization for a planned idle
	// slot. It may start discharge from 0 kW, so execution additionally
	// requires a fresh full measurement set and EffectiveFloorSocPct.
	UnplannedLoadDischarge bool `json:"unplanned_load_discharge,omitempty"`
	// LimitDischargeToLoad is the OPTIONAL REDUCE-ONLY right of the slot
	// (2026-09-08, Netz-null-Reduzieren): true = the cloud plans a real
	// DISCHARGE here AND a grid exchange of ~ 0, so the executor may LIMIT the
	// commanded discharge down to the MEASURED deficit max(load - pv, 0) - never
	// RAISE it, hard floor at zero discharge, never a charge.
	//
	// It is the half of CoverLoadFromBattery that needs NO price: limiting only
	// ever keeps energy the plan itself values above the export in this slot.
	// The cloud's economic verdict flips to false exactly when the battery gets
	// scarce on a fixed-tariff site, and the box then fell back to deepen-only
	// while the running slot's setpoint (carrying the nowcast reserve) exported
	// 0,1-1,8 kW - 3,8 kWh per night at Pilsting/Herzogau (report
	// vp-nachtreserve-konzept-k2 P1). DEEPENING stays bound to
	// CoverLoadFromBattery / the local deficit-cover rule; this flag widens
	// nothing but the REDUCE half.
	//
	// FAIL-OPEN exactly like its siblings: absent/false = no right to limit =
	// byte-for-byte pre-feature behavior.
	LimitDischargeToLoad bool `json:"limit_discharge_to_load,omitempty"`
	// ChargeSurplusToBattery is the OPTIONAL in-slot SURPLUS-ABSORPTION duty of
	// the slot (2026-08-02, the charge-side counterpart that RAISES): true = the
	// cloud determined that STORING one more kWh beats SELLING it here
	// (eta*lambda - wear above the slot's export value), so the executor may
	// RAISE the commanded CHARGE to the MEASURED surplus max(pv - load, 0)
	// instead of leaving a surplus the 15-min PV forecast never saw to be
	// exported - at a negative price, paid away. The edge never evaluates a
	// price - guards.SurplusCharger only enforces.
	//
	// FAIL-OPEN exactly like its two siblings: absent/false = no absorption =
	// byte-for-byte pre-feature behavior. Inferring the duty would be the
	// price-blind "just charge the surplus" logic the price-aware plan replaced.
	ChargeSurplusToBattery bool `json:"charge_surplus_to_battery,omitempty"`
}

// Plan is the parsed, validated schedule payload.
type Plan struct {
	PlanID      string    `json:"plan_id"`
	GeneratedAt time.Time `json:"generated_at"`
	SlotMinutes int       `json:"slot_minutes"`
	Slots       []Slot    `json:"slots"`
	// ReceivedAt anchors the staleness window; persisted with the plan.
	ReceivedAt time.Time `json:"received_at"`
	// GridChargeAllowed is the OPTIONAL contract field mirroring the site's
	// netzladen_erlaubt (P5). false = the setpoint executor must clamp charge
	// to the MEASURED PV production (guards.Limits.SolarOnlyCharge; PV-bus
	// semantics since FK3, captain decision 2026-07-16). nil = field
	// absent (a pre-P5 cloud / hand-crafted payload): the edge treats that as
	// MOST RESTRICTIVE and clamps too - a fail-SAFE deviation from the
	// contract's absent=allowed reading, chosen deliberately: the updated
	// optimizer always publishes the field (a merchant site's plan carries
	// true and is unaffected), so only legacy/hand-crafted payloads change
	// behavior, and an EEG site behind such a payload must never grid-charge.
	GridChargeAllowed *bool `json:"grid_charge_allowed,omitempty"`
	// GridImportLimitKw is the OPTIONAL run-level billing-period peak target
	// (PS-1/PS-3, kW >= 0): the highest 15-min mean grid IMPORT the optimizer
	// planned for. nil = the site's peak-shaving module is off - byte-for-byte
	// pre-PS behavior. The edge peak guard (guards.PeakTracker/PeakShave)
	// defends this target against a forming quarter-hour import peak; it is
	// restrict-only (raise discharge / lower charge) and import-side only.
	GridImportLimitKw *float64 `json:"grid_import_limit_kw,omitempty"`
	// PeakReserveSocPct is the OPTIONAL peak-shaving SoC reserve (PS-2, percent
	// 0..100), only ever present alongside GridImportLimitKw. In the stale-plan
	// self-consumption fallback, ordinary discharge stops at this floor so the
	// reserve survives for peak defense (which alone may go below it, down to
	// the technical SoC floor). nil = no reserve - fallback behaves as before.
	PeakReserveSocPct *float64 `json:"peak_reserve_soc_pct,omitempty"`
	// EffectiveFloorSocPct is max(technical, backup, peak reserve), computed by
	// the optimizer. It is mandatory for starting unforeseen-load discharge;
	// absent/invalid means that additive duty is disabled (old-cloud safe).
	EffectiveFloorSocPct *float64 `json:"effective_floor_soc_pct,omitempty"`
	// GridExportLimitKw is the OPTIONAL site feed-in limit at the grid
	// connection point (kW >= 0), mirroring site.max_feed_in_kw (FK1). It is the
	// EXPORT-side twin of GridImportLimitKw: the cloud plans against it as a hard
	// export cap, and the edge REGULATES it in real time against the MEASURED
	// connection point (guards.ExportLimiter), because the 15-min plan cannot see
	// a wallbox being unplugged. nil = no limit configured - byte-for-byte
	// pre-feature behavior; a limit is NEVER invented.
	GridExportLimitKw *float64 `json:"grid_export_limit_kw,omitempty"`
}

// SolarOnlyCharge reports whether the plan demands the EEG solar-only-charge
// clamp. Fail-safe: only an EXPLICIT grid_charge_allowed=true releases the
// clamp; an absent field - or no plan at all - keeps the most restrictive
// posture (see GridChargeAllowed). The clamp composes into the
// self-consumption fallback as a no-op (pv - load never exceeds pv for a
// non-negative load), so a nil/legacy plan on a merchant site costs nothing
// on the fallback path.
func (p *Plan) SolarOnlyCharge() bool {
	return p == nil || p.GridChargeAllowed == nil || !*p.GridChargeAllowed
}

// PeakImportLimit returns the plan-carried billing-period peak target (kW), or
// nil when the peak-shaving module is off (field absent / no plan). It is
// DELIBERATELY independent of Fresh(): the billing peak is a 15-min MEAN the
// cloud MPC can only plan, never catch - the edge guard is the closed loop, and
// on a dead cloud link it keeps defending the LAST KNOWN target (PS-3 fallback
// composition; restrict-only, so a stale target can never widen anything). A
// NEW plan without the field clears it, per the contract's x-failsafe.
func (p *Plan) PeakImportLimit() *float64 {
	if p == nil || p.GridImportLimitKw == nil {
		return nil
	}
	v := *p.GridImportLimitKw
	return &v
}

// ExportLimit returns the plan-carried site feed-in limit at the grid
// connection point (kW), or nil when none is configured.
//
// Like PeakImportLimit it is DELIBERATELY independent of Fresh(), and here the
// reason is stronger: this is a COMPLIANCE limit. A dead optimizer must never
// hand the plant back its unlimited feed-in - the live watchdog keeps regulating
// against the last known limit (restrict-only, so a stale limit can never widen
// anything, only cost a little yield). A NEW plan without the field clears it,
// per the contract's clear-on-absent rule.
func (p *Plan) ExportLimit() *float64 {
	if p == nil || p.GridExportLimitKw == nil {
		return nil
	}
	v := *p.GridExportLimitKw
	return &v
}

// PeakReserveSoc returns the plan-carried peak-shaving SoC reserve (percent),
// or nil when none is configured. Like PeakImportLimit it survives staleness:
// the reserve exists precisely FOR the offline fallback.
func (p *Plan) PeakReserveSoc() *float64 {
	if p == nil || p.PeakReserveSocPct == nil {
		return nil
	}
	v := *p.PeakReserveSocPct
	return &v
}

// EffectiveFloorSoc returns the full cloud-computed corrective-discharge
// floor. It does not survive absence (nil is the fail-closed signal for the
// additive idle duty); plan staleness is checked by the duty itself.
func (p *Plan) EffectiveFloorSoc() *float64 {
	if p == nil || p.EffectiveFloorSocPct == nil {
		return nil
	}
	v := *p.EffectiveFloorSocPct
	return &v
}

// wire mirrors the contract JSON (RFC 3339 strings).
type wire struct {
	SchemaVersion        string   `json:"schema_version"`
	PlanID               string   `json:"plan_id"`
	GeneratedAt          string   `json:"generated_at"`
	SlotMinutes          int      `json:"slot_minutes"`
	GridChargeAllowed    *bool    `json:"grid_charge_allowed"`
	GridImportLimitKw    *float64 `json:"grid_import_limit_kw"`
	PeakReserveSocPct    *float64 `json:"peak_reserve_soc_pct"`
	EffectiveFloorSocPct *float64 `json:"effective_floor_soc_pct"`
	GridExportLimitKw    *float64 `json:"grid_export_limit_kw"`
	Slots                []struct {
		Start                  string   `json:"start"`
		BatterySetpointKw      float64  `json:"battery_setpoint_kw"`
		PvLimitKw              *float64 `json:"pv_limit_kw"`
		ChargeFromSurplusOnly  *bool    `json:"charge_from_surplus_only"`
		CoverLoadFromBattery   *bool    `json:"cover_load_from_battery"`
		UnplannedLoadDischarge *bool    `json:"unplanned_load_discharge"`
		LimitDischargeToLoad   *bool    `json:"limit_discharge_to_load"`
		ChargeSurplusToBattery *bool    `json:"charge_surplus_to_battery"`
	} `json:"slots"`
}

// Parse validates a schedule payload against the frozen contract shape and
// stamps receivedAt. Unknown fields (plan metadata) are ignored, as the
// contract allows the edge to.
func Parse(payload []byte, receivedAt time.Time) (*Plan, error) {
	var w wire
	if err := json.Unmarshal(payload, &w); err != nil {
		return nil, fmt.Errorf("schedule payload: %w", err)
	}
	if w.SchemaVersion != "1.0" {
		return nil, fmt.Errorf("schedule schema_version %q not supported", w.SchemaVersion)
	}
	if w.SlotMinutes < 1 {
		return nil, errors.New("schedule slot_minutes missing")
	}
	if len(w.Slots) == 0 {
		return nil, errors.New("schedule has no slots")
	}
	p := &Plan{
		PlanID:      w.PlanID,
		SlotMinutes: w.SlotMinutes,
		ReceivedAt:  receivedAt,
	}
	if w.GridChargeAllowed != nil {
		v := *w.GridChargeAllowed
		p.GridChargeAllowed = &v
	}
	// Peak-shaving fields (PS-3): keep only a valid, finite, non-negative
	// target; the reserve is accepted only ALONGSIDE a valid target (the
	// contract publishes it that way, and a reserve without a peak module must
	// never restrict the fallback) and only within 0..100.
	if w.GridImportLimitKw != nil && !math.IsNaN(*w.GridImportLimitKw) &&
		!math.IsInf(*w.GridImportLimitKw, 0) && *w.GridImportLimitKw >= 0 {
		v := *w.GridImportLimitKw
		p.GridImportLimitKw = &v
		if w.PeakReserveSocPct != nil && !math.IsNaN(*w.PeakReserveSocPct) &&
			!math.IsInf(*w.PeakReserveSocPct, 0) &&
			*w.PeakReserveSocPct >= 0 && *w.PeakReserveSocPct <= 100 {
			r := *w.PeakReserveSocPct
			p.PeakReserveSocPct = &r
		}
	}
	// Feed-in limit (the dynamic Einspeisebegrenzung's target): keep only a
	// valid, finite, non-negative limit. A garbage value must never become a
	// compliance target - and, unlike the peak fields, a missing one must never
	// be replaced by a guess: absent = no limit at all.
	if w.GridExportLimitKw != nil && !math.IsNaN(*w.GridExportLimitKw) &&
		!math.IsInf(*w.GridExportLimitKw, 0) && *w.GridExportLimitKw >= 0 {
		v := *w.GridExportLimitKw
		p.GridExportLimitKw = &v
	}
	if w.EffectiveFloorSocPct != nil && !math.IsNaN(*w.EffectiveFloorSocPct) &&
		!math.IsInf(*w.EffectiveFloorSocPct, 0) && *w.EffectiveFloorSocPct >= 0 &&
		*w.EffectiveFloorSocPct <= 100 {
		v := *w.EffectiveFloorSocPct
		p.EffectiveFloorSocPct = &v
	}
	if t, err := time.Parse(time.RFC3339, w.GeneratedAt); err == nil {
		p.GeneratedAt = t
	}
	// Freshness is bounded by PLAN AGE, not just receipt time: the broker
	// redelivers the retained schedule on every reconnect, and stamping such a
	// redelivery ReceivedAt=now would make an hours-old plan from a dead
	// optimizer look "fresh" for another StaleAfter window (on a flapping link
	// indefinitely). A payload whose generated_at already lies beyond
	// StaleAfter+redeliverySlack in the past is therefore anchored to its
	// generation time, so Fresh() rejects it immediately and the
	// self-consumption fallback engages - matching the disk-cache path, which
	// preserves the ORIGINAL ReceivedAt across restarts. Plans without a
	// parseable generated_at keep the receipt-time anchor (nothing to bound by).
	if !p.GeneratedAt.IsZero() && receivedAt.Sub(p.GeneratedAt) > StaleAfter+redeliverySlack {
		p.ReceivedAt = p.GeneratedAt.Add(redeliverySlack)
	}
	for _, s := range w.Slots {
		start, err := time.Parse(time.RFC3339, s.Start)
		if err != nil {
			return nil, fmt.Errorf("slot start %q: %w", s.Start, err)
		}
		slot := Slot{Start: start, BatterySetpointKw: s.BatterySetpointKw}
		// Only an EXPLICIT true carries the price-aware trim duty; absent/false
		// is "no restriction" (the field is fail-open by contract).
		if s.ChargeFromSurplusOnly != nil && *s.ChargeFromSurplusOnly {
			slot.ChargeFromSurplusOnly = true
		}
		// Same rule for the discharge-side mirror: only an EXPLICIT true carries
		// the load-following duty.
		if s.CoverLoadFromBattery != nil && *s.CoverLoadFromBattery {
			slot.CoverLoadFromBattery = true
		}
		if s.UnplannedLoadDischarge != nil && *s.UnplannedLoadDischarge {
			slot.UnplannedLoadDischarge = true
		}
		// ...and for the REDUCE-only right: only an EXPLICIT true carries it.
		if s.LimitDischargeToLoad != nil && *s.LimitDischargeToLoad {
			slot.LimitDischargeToLoad = true
		}
		// ...and for the charge-side counterpart that RAISES: only an EXPLICIT
		// true carries the surplus-absorption duty.
		if s.ChargeSurplusToBattery != nil && *s.ChargeSurplusToBattery {
			slot.ChargeSurplusToBattery = true
		}
		// Keep a valid, non-negative feed-in cap only; the contract guarantees
		// >= 0, and a bad value must never be shown as a real curtailment.
		if s.PvLimitKw != nil && !math.IsNaN(*s.PvLimitKw) && !math.IsInf(*s.PvLimitKw, 0) && *s.PvLimitKw >= 0 {
			v := *s.PvLimitKw
			slot.PvLimitKw = &v
		}
		p.Slots = append(p.Slots, slot)
	}
	return p, nil
}

// Fresh reports whether the plan may still drive the battery at "now".
func (p *Plan) Fresh(now time.Time) bool {
	return p != nil && now.Sub(p.ReceivedAt) <= StaleAfter
}

// ActiveSetpoint returns the setpoint of the slot whose
// [start, start+slot_minutes) contains now. ok=false when the plan is nil,
// stale, or now falls outside every slot - the caller then uses the
// self-consumption fallback.
func (p *Plan) ActiveSetpoint(now time.Time) (kw float64, slotStart time.Time, ok bool) {
	if !p.Fresh(now) {
		return 0, time.Time{}, false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.BatterySetpointKw, s.Start, true
		}
	}
	return 0, time.Time{}, false
}

// ActivePvLimit returns the OPTIONAL PV feed-in cap (kW, >= 0) of the slot active
// at now, so the core can forward it to Layer 1 for curtailment execution. nil
// when the plan is stale, no slot is active, or the active slot has no cap - the
// caller then clears any latched limit (report §4.5). Mirrors ActiveSetpoint's
// freshness/window semantics exactly.
func (p *Plan) ActivePvLimit(now time.Time) *float64 {
	if !p.Fresh(now) {
		return nil
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			if s.PvLimitKw != nil {
				v := *s.PvLimitKw
				return &v
			}
			return nil
		}
	}
	return nil
}

// ActiveChargeFromSurplusOnly reports whether the slot active at now carries the
// price-aware trim duty (see Slot.ChargeFromSurplusOnly). It mirrors
// ActiveSetpoint/ActivePvLimit exactly: false when the plan is nil, STALE, or no
// slot is active.
//
// Deliberately NOT a staleness survivor like PeakImportLimit: the duty is a
// per-slot price fact that cannot be extrapolated, and the stale-plan fallback
// (guards.SelfConsumption = pv - load) never grid-charges anyway, so there is
// nothing left to protect there.
func (p *Plan) ActiveChargeFromSurplusOnly(now time.Time) bool {
	if !p.Fresh(now) {
		return false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.ChargeFromSurplusOnly
		}
	}
	return false
}

// ActiveCoverLoadFromBattery reports whether the slot active at now carries the
// in-slot load-following duty (see Slot.CoverLoadFromBattery). It mirrors
// ActiveChargeFromSurplusOnly exactly: false when the plan is nil, STALE, or no
// slot is active.
//
// Like the trim duty it is DELIBERATELY not a staleness survivor (unlike
// PeakImportLimit): it is a per-slot price fact that cannot be extrapolated, and
// the stale-plan fallback (guards.SelfConsumption = pv - load) already follows
// the measured load by construction, so there is nothing left to protect there.
func (p *Plan) ActiveCoverLoadFromBattery(now time.Time) bool {
	if !p.Fresh(now) {
		return false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.CoverLoadFromBattery
		}
	}
	return false
}

// ActiveLimitDischargeToLoad reports whether the slot active at now carries the
// REDUCE-only right (see Slot.LimitDischargeToLoad). It mirrors
// ActiveCoverLoadFromBattery exactly - false when the plan is nil, STALE, or no
// slot is active - and for the same reason: it is a per-slot fact about the
// PLAN's own shape that cannot be extrapolated, and the stale-plan fallback
// (guards.SelfConsumption = pv - load) already follows the measured load by
// construction, so there is nothing left to protect there.
func (p *Plan) ActiveLimitDischargeToLoad(now time.Time) bool {
	if !p.Fresh(now) {
		return false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.LimitDischargeToLoad
		}
	}
	return false
}

// ActiveUnplannedLoadDischarge reports the additive idle-slot authorization.
// It never survives staleness and is false unless the same plan also carries a
// valid full reserve floor. That fail-closed coupling makes an old cloud safe.
func (p *Plan) ActiveUnplannedLoadDischarge(now time.Time) bool {
	if !p.Fresh(now) || p.EffectiveFloorSocPct == nil {
		return false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.UnplannedLoadDischarge && math.Abs(s.BatterySetpointKw) <= 0.05
		}
	}
	return false
}

// ActiveChargeSurplusToBattery reports whether the slot active at now carries
// the in-slot surplus-absorption duty (see Slot.ChargeSurplusToBattery). It
// mirrors its two siblings exactly: false when the plan is nil, STALE, or no
// slot is active.
//
// Like them it is DELIBERATELY not a staleness survivor (unlike
// PeakImportLimit): it is a per-slot price fact that cannot be extrapolated, and
// the stale-plan fallback (guards.SelfConsumption = pv - load) already charges
// the measured surplus by construction, so there is nothing left to protect
// there.
func (p *Plan) ActiveChargeSurplusToBattery(now time.Time) bool {
	if !p.Fresh(now) {
		return false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	for _, s := range p.Slots {
		if !now.Before(s.Start) && now.Before(s.Start.Add(width)) {
			return s.ChargeSurplusToBattery
		}
	}
	return false
}

// SlotView is one plan slot as the local Fahrplan view renders it.
type SlotView struct {
	Start             time.Time `json:"start"`
	BatterySetpointKw float64   `json:"battery_setpoint_kw"`
	// PvLimitKw echoes the slot's planned feed-in cap (nil = no limit).
	PvLimitKw *float64 `json:"pv_limit_kw,omitempty"`
	// Curtailed is true when the slot carries a PV feed-in cap (planned
	// curtailment) - the view draws a distinct marker for it.
	Curtailed bool `json:"curtailed"`
	// Active is true for the slot whose [start, start+slot_minutes) contains
	// "now", and only while the plan is fresh (matches ActiveSetpoint).
	Active bool `json:"active"`
}

// View is the cached plan projected for the local Fahrplan view at "now": the
// slots plus the derived freshness and which slot is executing. Read-only; it
// never influences execution.
type View struct {
	PlanID            string     `json:"plan_id"`
	GeneratedAt       time.Time  `json:"generated_at,omitzero"`
	ReceivedAt        time.Time  `json:"received_at"`
	SlotMinutes       int        `json:"slot_minutes"`
	StaleAfterSeconds int        `json:"stale_after_seconds"`
	Fresh             bool       `json:"fresh"`
	ActiveIndex       int        `json:"active_index"` // -1 when no slot is active
	Slots             []SlotView `json:"slots"`
}

// BuildView projects the plan for the local web app at "now": it marks the
// active slot (only when the plan is fresh, mirroring ActiveSetpoint), flags
// curtailed slots, and reports freshness against the contract's staleness
// window. Callers must not call it on a nil plan.
func (p *Plan) BuildView(now time.Time) View {
	fresh := p.Fresh(now)
	v := View{
		PlanID:            p.PlanID,
		GeneratedAt:       p.GeneratedAt,
		ReceivedAt:        p.ReceivedAt,
		SlotMinutes:       p.SlotMinutes,
		StaleAfterSeconds: int(StaleAfter / time.Second),
		Fresh:             fresh,
		ActiveIndex:       -1,
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	v.Slots = make([]SlotView, 0, len(p.Slots))
	for i, s := range p.Slots {
		active := fresh && !now.Before(s.Start) && now.Before(s.Start.Add(width))
		if active {
			v.ActiveIndex = i
		}
		v.Slots = append(v.Slots, SlotView{
			Start:             s.Start,
			BatterySetpointKw: s.BatterySetpointKw,
			PvLimitKw:         s.PvLimitKw,
			Curtailed:         s.PvLimitKw != nil,
			Active:            active,
		})
	}
	return v
}

// Store persists the last received plan across restarts.
type Store struct{ path string }

// NewStore stores the plan under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "plan.json")}, nil
}

// Save writes the plan atomically.
func (s *Store) Save(p *Plan) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted plan, or nil if none exists.
func (s *Store) Load() (*Plan, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p Plan
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("cached plan corrupt: %w", err)
	}
	return &p, nil
}
