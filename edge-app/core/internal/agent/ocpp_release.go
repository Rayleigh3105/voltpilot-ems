package agent

import (
	"log/slog"
	"math"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// This file wires „SONNE + SPEICHER" (2026-10-06) into the two executors it
// touches. Like ocpp_surplus.go it holds no rule of its own - the decision
// lives in internal/lastmgmt/release.go:
//
//   - the CHARGE-POINT executor (ocppStep) asks the release gate for a verdict
//     and hands the allocator one more reading of the source lane;
//   - the BATTERY executor (applySetpoint) reports, every tick, whether its
//     path can cover a vehicle right now (releaseReadiness), and while cars
//     draw released power it lowers a planned CHARGE in a slot the plan
//     authorized toward the measured self-consumption value (release cover).
//
// ⚠ NO NEW WRITE PATH. The battery receives the same kind of setpoint through
// the same certified, guarded path it always does (Clamp, SoC floor, BMS,
// §14a, export watchdog, peak guard); the only new value is "less charge /
// more discharge toward grid = 0", bounded by the cloud's floor. A battery
// the box may not command (uncertified family, kill switch, no held
// readback) is NOT ready - and then nothing is released at all.

// releaseReadyWindow is how long the battery executor's readiness report is
// believed. Twice its own measurement window: one missed tick is jitter, two
// are a path that stopped answering.
const releaseReadyMin = 30 * time.Second

// releaseInUseWindow bounds how old the charge-point decision may be for the
// battery executor to keep covering it.
const releaseInUseWindow = time.Minute

// releaseReadiness is the battery executor's last word on whether it covers a
// vehicle's draw.
type releaseReadiness struct {
	mu   sync.Mutex
	at   time.Time
	ok   bool
	note string
}

func (r *releaseReadiness) set(now time.Time, ok bool, note string) {
	r.mu.Lock()
	r.at, r.ok, r.note = now, ok, note
	r.mu.Unlock()
}

func (r *releaseReadiness) get(now time.Time, window time.Duration) (bool, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.at.IsZero() || now.Before(r.at) || now.Sub(r.at) > window {
		return false, "Der Speicherpfad meldet sich gerade nicht"
	}
	return r.ok, r.note
}

// releaseReadyWindow is the freshness of a readiness report.
func (a *Agent) releaseReadyWindow() time.Duration {
	w := 2 * a.Cfg.SetpointInterval
	if w < releaseReadyMin {
		w = releaseReadyMin
	}
	return w
}

// noteReleaseReadiness is called by applySetpoint once its gates are known.
func (a *Agent) noteReleaseReadiness(now time.Time, ok bool, note string) {
	a.releaseReady.set(now, ok, note)
}

// anyStorageRelease reports whether some registered station runs the source.
func anyStorageRelease(snap csms.Snapshot) bool {
	for _, c := range snap.Chargers {
		if c.StorageRelease {
			return true
		}
	}
	return false
}

// ocppReleaseInput gathers the facts of one release decision.
func (a *Agent) ocppReleaseInput(now time.Time) lastmgmt.ReleaseInput {
	a.mu.Lock()
	p := a.currentPlan
	r := a.lastReading
	readingAt := a.lastReadingAt
	a.mu.Unlock()

	in := lastmgmt.ReleaseInput{Now: now, PlanFresh: p.Fresh(now), BmsDischargeKw: math.NaN()}
	in.MaxDischargeKw, in.CloudReason = p.ReleaseFacts(now)
	if f, ok := p.ActiveReleaseFloor(now); ok {
		in.FloorPct = &f
	}
	window := a.releaseReadyWindow()
	if !math.IsNaN(r.SocPct) && !readingAt.IsZero() && !now.Before(readingAt) &&
		now.Sub(readingAt) <= window {
		soc := r.SocPct
		in.SocPct = &soc
	}
	in.DeficitKw, _, in.Measured = a.ocpp.budget.ReleaseFacts(now)
	in.BatteryReady, in.BatteryNote = a.releaseReady.get(now, window)
	in.RatedDischargeKw = a.Cfg.MaxDischargeKw
	if env := a.bmsEnvelope(a.batteryEntityID()); env != nil {
		in.BmsDischargeKw, in.BmsBlocked = env.DischargeKw, env.DischargeBlocked
	}
	return in
}

// ocppDecideRelease forms this pass's verdict and turns it into allocator
// input. A site without a release station gets an empty verdict and the input
// stays byte-for-byte what it was.
func (a *Agent) ocppDecideRelease(now time.Time, snap csms.Snapshot, surplus lastmgmt.SurplusVerdict,
	allocKw float64, input *lastmgmt.Input) lastmgmt.ReleaseVerdict {
	rt := a.ocpp
	if !anyStorageRelease(snap) {
		return rt.release.Off(now)
	}
	v := rt.release.Decide(a.ocppReleaseInput(now))
	if v.Active {
		kw := v.Kw
		input.StorageReleaseKw = &kw
	}
	if v.StorageFirst && surplus.BelowStorageKw != nil {
		below := math.Min(*surplus.BelowStorageKw, allocKw)
		input.StorageFirst = true
		input.SourceBudgetBelowStorageKw = &below
	}
	return v
}

// ocppObserveReleaseEffect is the effect check after a decision.
func (a *Agent) ocppObserveReleaseEffect(now time.Time, plan lastmgmt.Plan) {
	rt := a.ocpp
	_, grid, measured := rt.budget.ReleaseFacts(now)
	if rt.release.ObserveEffect(now, plan.StorageReleaseUsedKw, grid, measured) {
		slog.Warn("Sonne + Speicher: Freigabe zurückgenommen - Netzbezug während der Freigabe",
			"grid_kw", grid, "release_used_kw", plan.StorageReleaseUsedKw,
			"latch", lastmgmt.ReleaseLatch)
		rt.nudge()
	}
}

// ocppReleaseInUse tells the battery executor whether cars are drawing
// released battery power right now, and down to which floor.
func (a *Agent) ocppReleaseInUse(now time.Time) (float64, bool) {
	rt := a.ocpp
	if rt == nil {
		return 0, false
	}
	v, at := rt.release.Last()
	if !v.Active || v.FloorPct == nil || at.IsZero() || now.Before(at) || now.Sub(at) > releaseInUseWindow {
		return 0, false
	}
	p := rt.previousPlan()
	if p == nil || p.StorageReleaseUsedKw < lastmgmt.ReleaseMinKw {
		return 0, false
	}
	return *v.FloorPct, true
}

// releaseStorageFirst reports whether release stations are currently served
// AFTER the battery (their floor is reached) - they then do not count as cars
// before the storage for the battery's charge cap.
func (a *Agent) releaseStorageFirst() bool {
	if a.ocpp == nil {
		return false
	}
	v, _ := a.ocpp.release.Last()
	return v.StorageFirst
}
