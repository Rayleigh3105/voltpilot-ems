// Package flexfallback is the PURE half of the edge-local deadline fallback
// (Verbrauchssteuerung Inkrement 6, docs/verbrauchssteuerung.md §13.5/§19 +
// contract decision D-20): a `required_by_deadline` flexible task must not
// miss its deadline just because the cloud is unreachable - the device starts
// it ITSELF, at the latest at "deadline minus remaining need minus one slot of
// margin", under ALL guards, and only from CONFIRMED own progress.
//
// The rules this package carries (every time-dependent function takes `now` -
// the otaapply/calibration discipline, no I/O, docker-free tests):
//
//   - ONLY deadline duties: the registry push carries exclusively
//     required_by_deadline requirements (cloud-composed); price-conditioned,
//     opportunistic and reactive rules never reach this package - a price rule
//     without a precomputed window is `unknown` and stays off (§13.5).
//   - ONLY without a fresh plan: while a fresh v2 plan lies, the cloud alone
//     plans (its dispatch already contains the flexible task); the verdict is
//     inactive with reason `plan_fresh`.
//   - NEVER before the latest start: the fallback is a Notnagel, not a second
//     optimizer. Latest start = deadline - remaining need - StartMargin.
//   - CONFIRMED progress only: remaining need derives from measured own
//     telemetry (power above RunThreshold accrues runtime + integrates
//     energy), never from sent setpoints. Unknown progress (no fresh own
//     telemetry) starts NOTHING and names the reason (§3.3: unknown is never
//     0) - a fabricated run is worse than a missed one.
//   - The deadline ends the instance: past it the duty is honestly missed
//     (the window closed); the fallback never runs outside the window.
package flexfallback

import (
	"fmt"
	"math"
	"strings"
	"time"
	// The core ships on a zoneinfo-less Alpine image; the recurrence windows
	// are wall-clock in the SITE timezone (E7, DST-correct), so the Go
	// embedded tzdata is load-bearing, not convenience.
	_ "time/tzdata"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// StartMargin is the documented safety margin before the arithmetic latest
// start: one 15-min plan slot. It absorbs command latency, the driver tick
// and small progress-measurement lag - and it is the ONLY earliness the
// fallback ever takes (no start before latestStart, D-20).
const StartMargin = 15 * time.Minute

// DefaultTimezone is the v1 site-time pinning (verbrauchssteuerung.md E7).
const DefaultTimezone = "Europe/Berlin"

// The machine-readable verdict reasons (diagnostic vocabulary for logs and
// tests; the HEARTBEAT reason of a RUNNING fallback is ReasonRun, which joins
// the §15 vocabulary cloud-side).
const (
	// ReasonRun is the §15 reason_code of an active fallback run.
	ReasonRun = "flex_deadline_fallback"

	ReasonPlanFresh       = "plan_fresh"
	ReasonOutsideWindow   = "outside_window"
	ReasonFulfilled       = "fulfilled"
	ReasonNotYetDue       = "not_yet_due"
	ReasonProgressUnknown = "progress_unknown"
)

// Requirement is the validated view of one registry flex_requirements entry.
type Requirement struct {
	ID   string
	Loc  *time.Location
	Days string // daily | weekdays | weekend
	// FromMin/ToMin are wall-clock minutes since local midnight. ToMin may be
	// 1440 (= 24:00, end of day); ToMin <= FromMin marks an overnight window
	// whose deadline lies on the day AFTER its anchor day.
	FromMin, ToMin int
	// RuntimeSeconds/EnergyKwh are the demand (0 = that axis absent; at least
	// one is present). PowerKw converts remaining energy into remaining time
	// and is the setpoint value of a setpoint_kw fallback wish.
	RuntimeSeconds float64
	EnergyKwh      float64
	Contiguous     bool
	PowerKw        float64
	Command        string // entities.CmdOnOff | entities.CmdSetpointKw
}

// ParseRequirement validates one contract flex_requirements entry. An invalid
// entry is an error - the caller logs and SKIPS it (rule 5: missing data means
// no self-start, never a guessed one).
func ParseRequirement(fr entities.FlexRequirement) (Requirement, error) {
	r := Requirement{ID: fr.ID, Days: fr.Days, Contiguous: fr.Contiguous != nil && *fr.Contiguous}
	if strings.TrimSpace(fr.ID) == "" {
		return r, fmt.Errorf("flex requirement without id")
	}
	switch fr.Days {
	case "daily", "weekdays", "weekend":
	default:
		return r, fmt.Errorf("flex requirement %s: unknown days %q", fr.ID, fr.Days)
	}
	var err error
	if r.FromMin, err = parseHHMM(fr.From, false); err != nil {
		return r, fmt.Errorf("flex requirement %s: %w", fr.ID, err)
	}
	if r.ToMin, err = parseHHMM(fr.To, true); err != nil {
		return r, fmt.Errorf("flex requirement %s: %w", fr.ID, err)
	}
	if fr.RuntimeMinutes != nil && isFinitePos(*fr.RuntimeMinutes) {
		r.RuntimeSeconds = *fr.RuntimeMinutes * 60
	}
	if fr.EnergyKwh != nil && isFinitePos(*fr.EnergyKwh) {
		r.EnergyKwh = *fr.EnergyKwh
	}
	if r.RuntimeSeconds == 0 && r.EnergyKwh == 0 {
		return r, fmt.Errorf("flex requirement %s: no usable demand", fr.ID)
	}
	if !isFinitePos(fr.PowerKw) {
		return r, fmt.Errorf("flex requirement %s: power_kw missing", fr.ID)
	}
	r.PowerKw = fr.PowerKw
	switch fr.Command {
	case entities.CmdOnOff, entities.CmdSetpointKw:
		r.Command = fr.Command
	default:
		return r, fmt.Errorf("flex requirement %s: unsupported command %q", fr.ID, fr.Command)
	}
	tz := fr.Timezone
	if tz == "" {
		tz = DefaultTimezone
	}
	if r.Loc, err = time.LoadLocation(tz); err != nil {
		return r, fmt.Errorf("flex requirement %s: timezone %q unknown", fr.ID, tz)
	}
	return r, nil
}

func isFinitePos(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 }

func parseHHMM(s string, allow2400 bool) (int, error) {
	if allow2400 && s == "24:00" {
		return 1440, nil
	}
	var hh, mm int
	if _, err := fmt.Sscanf(s, "%d:%d", &hh, &mm); err != nil ||
		hh < 0 || hh > 23 || mm < 0 || mm > 59 || len(s) != 5 || s[2] != ':' {
		return 0, fmt.Errorf("time %q not HH:MM", s)
	}
	return hh*60 + mm, nil
}

// Instance is one concrete occurrence of the recurring duty.
type Instance struct {
	// Key identifies the occurrence stably across restarts: the requirement id
	// plus the local date of its ANCHOR day (the day of `from` - an overnight
	// window belongs to the instance of the PREVIOUS day, consumer_inputs
	// discipline).
	Key      string
	Start    time.Time
	Deadline time.Time
}

// dayMatches applies the recurrence day filter to the anchor day.
func (r Requirement) dayMatches(anchor time.Time) bool {
	wd := anchor.Weekday()
	switch r.Days {
	case "weekdays":
		return wd >= time.Monday && wd <= time.Friday
	case "weekend":
		return wd == time.Saturday || wd == time.Sunday
	}
	return true
}

// instanceFor builds the occurrence anchored on the given local day.
// Wall-clock construction via time.Date in the site zone is DST-correct: a
// 60-minute duty stays 60 minutes of ELAPSED time (§5.2 - the demand is
// runtime/energy, not a wall-clock span), and a nonexistent local time on the
// spring-forward day normalizes forward per Go's time semantics.
func (r Requirement) instanceFor(anchor time.Time) Instance {
	y, m, d := anchor.Date()
	start := time.Date(y, m, d, r.FromMin/60, r.FromMin%60, 0, 0, r.Loc)
	deadlineDay := anchor
	toMin := r.ToMin
	if r.ToMin <= r.FromMin { // overnight (or 24:00 == from 00:00 handled below)
		deadlineDay = anchor.AddDate(0, 0, 1)
		toMin = r.ToMin
	}
	if r.ToMin == 1440 { // 24:00 = midnight of the following day
		deadlineDay = anchor.AddDate(0, 0, 1)
		toMin = 0
	}
	dy, dm, dd := deadlineDay.Date()
	deadline := time.Date(dy, dm, dd, toMin/60, toMin%60, 0, 0, r.Loc)
	return Instance{
		Key:      r.ID + "@" + start.Format("2006-01-02"),
		Start:    start,
		Deadline: deadline,
	}
}

// CurrentInstance returns the occurrence whose [start, deadline) window
// contains now, ok=false when now lies outside every window (between
// occurrences, or the anchor day fails the day filter).
func (r Requirement) CurrentInstance(now time.Time) (Instance, bool) {
	local := now.In(r.Loc)
	// An overnight window that started YESTERDAY may still cover now.
	for _, anchor := range []time.Time{local.AddDate(0, 0, -1), local} {
		if !r.dayMatches(anchor) {
			continue
		}
		inst := r.instanceFor(anchor)
		if !now.Before(inst.Start) && now.Before(inst.Deadline) {
			return inst, true
		}
	}
	return Instance{}, false
}

// Progress is the CONFIRMED evidence within one instance (a lower bound -
// accrued only from measured telemetry, never from sent setpoints).
type Progress struct {
	RuntimeSeconds float64 `json:"runtime_seconds"`
	EnergyKwh      float64 `json:"energy_kwh"`
}

// RemainingSeconds is the remaining need at the given confirmed progress:
// the unfinished runtime demand, and/or the unfinished energy demand
// converted through the run power - the LARGER of the two binds (a combined
// demand is only fulfilled when both are).
func (r Requirement) RemainingSeconds(p Progress) float64 {
	rem := 0.0
	if r.RuntimeSeconds > 0 {
		rem = math.Max(0, r.RuntimeSeconds-p.RuntimeSeconds)
	}
	if r.EnergyKwh > 0 && r.PowerKw > 0 {
		remE := math.Max(0, r.EnergyKwh-p.EnergyKwh) / r.PowerKw * 3600
		rem = math.Max(rem, remE)
	}
	return rem
}

// LatestStart is the last instant the remaining need still fits before the
// deadline, minus the safety margin. The fallback never starts BEFORE it.
func (r Requirement) LatestStart(inst Instance, p Progress) time.Time {
	need := time.Duration(r.RemainingSeconds(p) * float64(time.Second))
	return inst.Deadline.Add(-need).Add(-StartMargin)
}

// Input is one decision context.
type Input struct {
	Now time.Time
	// PlanFresh: a fresh v2 plan lies - the cloud alone plans (rule 2).
	PlanFresh bool
	// ProgressKnown: the entity's OWN telemetry is fresh at decision time, so
	// the confirmed-progress lower bound is currently evidenced. False =
	// unknown = no start (§3.3).
	ProgressKnown bool
	Progress      Progress
}

// Verdict is the fallback decision for one requirement.
type Verdict struct {
	// Active: emit/renew the fallback wish now.
	Active bool
	// Reason: why NOT active (one of the Reason* diagnostics), or ReasonRun
	// while active.
	Reason string
	// Instance/LatestStart are filled whenever now lies inside a window.
	Instance    Instance
	LatestStart time.Time
}

// Decide is the fallback rule. Order is load-bearing: the window bounds the
// duty, a fresh plan silences the fallback entirely, fulfilment ends it,
// unknown progress refuses BEFORE the trigger arithmetic (arithmetic on an
// unknown quantity would be a guess), and only then the latest-start gate.
func Decide(r Requirement, in Input) Verdict {
	inst, ok := r.CurrentInstance(in.Now)
	if !ok {
		return Verdict{Reason: ReasonOutsideWindow}
	}
	v := Verdict{Instance: inst}
	if in.PlanFresh {
		v.Reason = ReasonPlanFresh
		return v
	}
	if !in.ProgressKnown {
		v.Reason = ReasonProgressUnknown
		return v
	}
	if r.RemainingSeconds(in.Progress) <= 0 {
		v.Reason = ReasonFulfilled
		return v
	}
	v.LatestStart = r.LatestStart(inst, in.Progress)
	if in.Now.Before(v.LatestStart) {
		v.Reason = ReasonNotYetDue
		return v
	}
	v.Active = true
	v.Reason = ReasonRun
	return v
}

// Commands is the fallback wish in the D-14 vocabulary.
func (r Requirement) Commands() entities.Commands {
	if r.Command == entities.CmdOnOff {
		on := true
		return entities.Commands{OnOff: &on}
	}
	kw := r.PowerKw
	return entities.Commands{SetpointKw: &kw}
}

// --- Confirmed-progress tracker ---------------------------------------------

// RunThresholdKw is the measured power above which a consumer counts as
// RUNNING for progress accrual: 10 % of its run power, floored at 50 W (a
// standby draw never accrues a duty; the relative part scales with the
// device). Documented, deliberately simple - the cloud ledger stays the
// authoritative fulfilment proof (D3), this is the edge's own lower bound.
func RunThresholdKw(powerKw float64) float64 {
	return math.Max(0.05, 0.1*powerKw)
}

// MaxSampleGap bounds hold-last accrual between two telemetry samples: a gap
// beyond it accrues NOTHING (evidence, not extrapolation). Matches the
// per-entity telemetry liveness window of the heartbeat.
const MaxSampleGap = 5 * time.Minute

// Tracker accumulates the confirmed progress of ONE requirement instance from
// measured samples. Serializable (persisted across reboots by the agent).
type Tracker struct {
	InstanceKey string   `json:"instance_key"`
	Progress    Progress `json:"progress"`
	LastAt      time.Time `json:"last_at"`
	LastKw      float64   `json:"last_kw"`
	HasLast     bool      `json:"has_last"`
}

// Roll switches the tracker to a new instance, resetting the accrued progress
// (a new day is a new duty). A no-op for the same key.
func (t *Tracker) Roll(instanceKey string) {
	if t.InstanceKey == instanceKey {
		return
	}
	*t = Tracker{InstanceKey: instanceKey}
}

// Observe feeds one measured power sample (the entity's own power_kw).
// Accrual is hold-last on the PREVIOUS sample: the elapsed time since it
// counts as runtime (and integrates energy) exactly when the previous sample
// was at/above the run threshold and the gap is within MaxSampleGap.
func (t *Tracker) Observe(now time.Time, powerKw, thresholdKw float64) {
	if math.IsNaN(powerKw) || math.IsInf(powerKw, 0) {
		return
	}
	if t.HasLast {
		dt := now.Sub(t.LastAt)
		if dt > 0 && dt <= MaxSampleGap && t.LastKw >= thresholdKw {
			t.Progress.RuntimeSeconds += dt.Seconds()
			t.Progress.EnergyKwh += t.LastKw * dt.Hours()
		}
	}
	t.LastAt = now
	t.LastKw = powerKw
	t.HasLast = true
}
