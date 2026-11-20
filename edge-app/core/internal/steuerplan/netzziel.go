package steuerplan

import (
	"math"
	"strings"
)

// The grid-side throttling slot (netzseitiger Drossel-Slot): the Go twin of
// edge-app/nodered/deye-grid-target.js. The core decides WHETHER a slot runs
// grid-side and publishes the intent; this file holds what only Layer 1 can
// know - the register order and the release of the exact model.

// GridTargetMode is the word on edge/setpoint (battery_mode) and in
// native_capabilities.intents.
const GridTargetMode = "grid_target"

// GridTargetMaxKw: never a target above +50 W (+ = import).
const GridTargetMaxKw = 0.05

// GridTargetPvMaxPermille is written to 1115 in grid mode, never 1000 or more.
const GridTargetPvMaxPermille = 999

// GridTargetRelease is one model release of the lever.
type GridTargetRelease struct {
	Brand, Model, Layout, BenchRecord string
}

// GridTargetReleases are the released models (deye-grid-target.js
// GRID_TARGET_RELEASES).
var GridTargetReleases = []GridTargetRelease{{
	Brand: "deye", Model: "sun-30k-sg01hp3", Layout: "pr978",
	BenchRecord: "Netz-Sollwert-Test Herzogau 08.10.2026 11:00:35-11:02:36 (Box edge-2026.09.6, " +
		"SUN-30K-SG01HP3-EU): Umschalten bei laufender Fernsteuerung bestaetigt, Vorzeichen richtig " +
		"(kein Bezug waehrend des Laufs), Netzpunkt folgte dem 2-kW-Schritt (Ziel -28,0 kW, gemessen " +
		"28,4 kW binnen ~7 s, Plateau 3/3), Fronius unberuehrt, 1115 = 1000 zog die Deye-PV nicht auf 0, " +
		"Export nie ueber 33 kW, Ruecknahme nach 120 s. Grenze: \"Ziel 0\" stellt nur den eigenen Anteil " +
		"(eigene PV plus Speicherladung), nicht die Fronius-Einspeisung.",
}}

func normWord(v any) string { return strings.ToLower(trimmed(v)) }

// GridTargetReleaseFor is the release for exactly this selection and layout.
func GridTargetReleaseFor(sel Obj, layout any) *GridTargetRelease {
	if sel == nil {
		return nil
	}
	brand, model := normWord(get(sel, "brand")), normWord(get(sel, "model"))
	l, ok := layout.(string)
	if brand == "" || model == "" || !ok || l == "" {
		return nil
	}
	for i := range GridTargetReleases {
		e := &GridTargetReleases[i]
		if e.Brand == brand && e.Model == model && e.Layout == l {
			return e
		}
	}
	return nil
}

type gridTarget struct {
	targetKw   float64
	neutralize bool
}

// parseGridTarget reads the core's intent strictly; the target is clamped to
// +50 W, never dropped.
func parseGridTarget(sp Obj) *gridTarget {
	if sp == nil || get(sp, "battery_mode") != GridTargetMode {
		return nil
	}
	kw := get(sp, "grid_target_kw")
	if !isFiniteNum(kw) {
		return nil
	}
	return &gridTarget{targetKw: math.Min(num(kw), GridTargetMaxKw), neutralize: isTrue(get(sp, "grid_target_neutralize"))}
}

// gridTargetUnits is the target in 0.1 % of rated, NOT negated; the +50 W
// clamp holds after rounding too.
func gridTargetUnits(targetKw, ratedKw float64) (units, raw int, clamped bool) {
	r := round(float64(targetKw/ratedKw) * deyeRemoteUnitsPerRated)
	if r == 0 || math.IsNaN(r) {
		r = 0
	}
	units = int(r)
	maxUnits := int(math.Floor(float64(GridTargetMaxKw/ratedKw) * deyeRemoteUnitsPerRated))
	if units > maxUnits {
		units = maxUnits
	}
	clamped = units < -deyeRemoteSetpointLimit
	if clamped {
		units = -deyeRemoteSetpointLimit
	}
	return units, units & 0xffff, clamped
}

// deyeGridTargetPlan is the register order of one tick: watchdog, neutral
// step (while the hand-over is unproven), 1115, the side switch, the target,
// enable LAST.
func deyeGridTargetPlan(t *gridTarget, writeFc, watchdogS int, ratedKw float64) (planned []WriteOp, readbacks []ReadOp, units int, clamped bool) {
	ram := func(w WriteOp) WriteOp { w.Always, w.BenchPending = true, true; return w }
	ramCfg := func(w WriteOp) WriteOp { w.ReassertS, w.BenchPending = deyeRemoteCfgReassertS, true; return w }
	units, raw, clamped := gridTargetUnits(t.targetKw, ratedKw)
	planned = append(planned, ram(WriteOp{Role: "remote_watchdog", FC: writeFc, Addr: DeyeRegWatchdog, Value: watchdogS & 0xffff,
		Encode: map[string]any{"kind": "remote_watchdog_s", "seconds": float64(watchdogS)}}))
	if t.neutralize {
		planned = append(planned, ram(WriteOp{Role: "grid_neutral", FC: writeFc, Addr: DeyeRegConstantPower, Value: 0,
			Encode: map[string]any{"kind": "remote_neutral"}}))
	}
	planned = append(planned, ramCfg(WriteOp{Role: "pv_max_permille", FC: writeFc, Addr: DeyeRegPvMaxPower, Value: GridTargetPvMaxPermille,
		Encode: map[string]any{"kind": "pv_max_permille", "rated_kw": ratedKw, "permille": float64(GridTargetPvMaxPermille)}}))
	planned = append(planned, ramCfg(WriteOp{Role: "power_control_mode", FC: writeFc, Addr: DeyeRegPowerControlMode, Value: deyePowerControlGridSide,
		Encode: map[string]any{"kind": "remote_power_control_mode", "enum": "grid_side"}}))
	planned = append(planned, ram(WriteOp{Role: "grid_power", FC: writeFc, Addr: DeyeRegConstantPower, Value: raw,
		Encode: map[string]any{"kind": "grid_power_permille", "rated_kw": ratedKw, "kw": t.targetKw,
			"units": float64(units), "limit": float64(deyeRemoteSetpointLimit), "clamped": clamped}}))
	planned = append(planned, ram(WriteOp{Role: "remote_mode", FC: writeFc, Addr: DeyeRegRemoteMode, Value: deyeRemoteModeOn,
		Encode: map[string]any{"kind": "remote_mode", "enum": "on"}}))
	for _, w := range planned {
		if w.Role == "grid_neutral" {
			continue
		}
		tol := 0.0
		if w.Role == "grid_power" {
			tol = 1
		}
		rb := readback(w.Role, w.Addr, w.Value&0xffff, tol)
		if w.Role == "grid_power" {
			rb.Decode = map[string]any{"kind": "grid_power_permille", "rated_kw": ratedKw}
		}
		readbacks = append(readbacks, rb)
	}
	return planned, readbacks, units, clamped
}

// withGridTargetLever adds the lever to a capability report when the
// selection carries the release; nil stays nil.
func withGridTargetLever(r *NativeLevers, released bool) *NativeLevers {
	if r == nil || !released {
		return r
	}
	for _, i := range r.Intents {
		if i == GridTargetMode {
			return r
		}
	}
	intents := append(append([]string{}, r.Intents...), GridTargetMode)
	return &NativeLevers{Intents: intents, Window: r.Window, Persistent: r.Persistent}
}
