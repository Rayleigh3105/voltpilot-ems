package agent

// The edge-local deadline fallback (Verbrauchssteuerung Inkrement 6,
// docs/verbrauchssteuerung.md §13.5/§19, contract D-20): a required_by_deadline
// flexible task must not miss its deadline in a cloud outage - the device
// starts it ITSELF, at the latest at "deadline minus remaining need minus one
// slot of margin", through the NORMAL desired -> arbitration -> guard chain.
//
// The rules (the pure half lives in internal/flexfallback):
//   - Gated on VP_CONSUMER_CONTROL_ENABLED (default OFF): with the flag off
//     nothing here runs, publishes or writes - byte-identical behavior.
//   - Only without a fresh v2 plan; a returning fresh plan preempts the
//     fallback holder by RANK (market 60 > deadline-fallback 50) - seamless,
//     no failsafe blip - and the fallback then withdraws its stored desire.
//   - The wish is class deadline-fallback, NEVER override: every guard
//     (consumer clamp, cycle guard, §14a/grid/contract) binds unchanged, and
//     a reactive Pflichtregel (flow override, rank 70) outranks it.
//   - Progress is CONFIRMED evidence only (the entity's own measured
//     power_kw), persisted across reboots (flexfallback.json); unknown
//     progress starts nothing and names the reason.

import (
	"encoding/json"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flexfallback"
)

// flexFallbackTTL is the fallback desire's TTL; it is renewed every
// arbitration tick (1 s) while the decision stays active, so withdrawal is
// the ABSENCE of renewal at worst - the reactive-rule discipline.
const flexFallbackTTL = 60 * time.Second

// flexSaveInterval throttles progress persistence (the file is a reboot
// bridge, not a journal).
const flexSaveInterval = 30 * time.Second

const flexStateFile = "flexfallback.json"

// rebuildFlexRequirements re-derives the validated per-entity deadline duties
// from the applied registry. Invalid entries are logged and SKIPPED (rule 5:
// missing data = no self-start, never a guessed one). Caller must NOT hold
// entMu.
func (a *Agent) rebuildFlexRequirements(reg entities.Registry) {
	if !a.Cfg.ConsumerControlEnabled {
		return
	}
	reqs := map[string][]flexfallback.Requirement{}
	for _, e := range reg.Entities {
		if len(e.FlexRequirements) == 0 || e.Category() != "consumer" ||
			len(e.Capabilities.Actuate) == 0 {
			continue
		}
		for _, fr := range e.FlexRequirements {
			r, err := flexfallback.ParseRequirement(fr)
			if err != nil {
				slog.Warn("flex requirement skipped (deadline fallback stays off for it)",
					"entity", e.ID, "err", err)
				continue
			}
			reqs[e.ID] = append(reqs[e.ID], r)
		}
	}
	a.flexMu.Lock()
	a.flexReqs = reqs
	// Entities/requirements that left the registry take their trackers along.
	for id, byReq := range a.flexTrack {
		rs, ok := reqs[id]
		if !ok {
			delete(a.flexTrack, id)
			a.flexDirty = true
			continue
		}
		for reqID := range byReq {
			found := false
			for _, r := range rs {
				if r.ID == reqID {
					found = true
					break
				}
			}
			if !found {
				delete(byReq, reqID)
				a.flexDirty = true
			}
		}
	}
	a.flexMu.Unlock()
}

// observeFlexProgress feeds one accepted per-entity telemetry sample into the
// confirmed-progress trackers. Called from onEntityTelemetry; a no-op unless
// the entity carries deadline duties and the sample measures power_kw.
func (a *Agent) observeFlexProgress(entityID string, channels map[string]float64, now time.Time) {
	if !a.Cfg.ConsumerControlEnabled {
		return
	}
	kw, ok := channels["power_kw"]
	if !ok || math.IsNaN(kw) || math.IsInf(kw, 0) {
		return
	}
	a.flexMu.Lock()
	defer a.flexMu.Unlock()
	reqs := a.flexReqs[entityID]
	if len(reqs) == 0 {
		return
	}
	for _, r := range reqs {
		inst, inWindow := r.CurrentInstance(now)
		if !inWindow {
			continue
		}
		if a.flexTrack == nil {
			a.flexTrack = map[string]map[string]*flexfallback.Tracker{}
		}
		byReq := a.flexTrack[entityID]
		if byReq == nil {
			byReq = map[string]*flexfallback.Tracker{}
			a.flexTrack[entityID] = byReq
		}
		t := byReq[r.ID]
		if t == nil {
			t = &flexfallback.Tracker{}
			byReq[r.ID] = t
		}
		t.Roll(inst.Key)
		t.Observe(now, kw, flexfallback.RunThresholdKw(r.PowerKw))
		a.flexDirty = true
	}
}

// flexEvidenceFresh reports whether the entity's OWN telemetry currently
// evidences its progress: fresh within the health window AND measuring
// power_kw. Takes entMu only (lock order: never nested inside flexMu).
func (a *Agent) flexEvidenceFresh(entityID string, now time.Time) bool {
	a.entMu.Lock()
	er, has := a.entReadings[entityID]
	a.entMu.Unlock()
	if !has || now.Sub(er.recv) > entityHealthWindow {
		return false
	}
	_, measured := er.channels["power_kw"]
	return measured
}

// flexProgressFor returns the tracked confirmed progress of one requirement
// instance (zero when the tracker belongs to another instance). Takes flexMu.
func (a *Agent) flexProgressFor(entityID, reqID, instanceKey string) flexfallback.Progress {
	a.flexMu.Lock()
	defer a.flexMu.Unlock()
	if byReq := a.flexTrack[entityID]; byReq != nil {
		if t := byReq[reqID]; t != nil && t.InstanceKey == instanceKey {
			return t.Progress
		}
	}
	return flexfallback.Progress{}
}

// runFlexFallback is the per-tick decision pass (called from the arbitration
// loop, after the plan executors so a fresh plan's desire is already in
// place). It emits/renews at most ONE fallback desire per consumer entity -
// the requirement whose deadline is nearest - and withdraws when the decision
// flips inactive. Reason transitions are logged once, never per tick.
func (a *Agent) runFlexFallback(now time.Time) {
	if !a.Cfg.ConsumerControlEnabled || a.arb == nil {
		return
	}
	a.flexMu.Lock()
	reqsByEntity := a.flexReqs
	a.flexMu.Unlock()
	if len(reqsByEntity) == 0 {
		return
	}

	a.arbMu.Lock()
	v2 := a.curPlan2
	a.arbMu.Unlock()
	planFresh := v2.Fresh(now)

	for entityID, reqs := range reqsByEntity {
		var active *flexfallback.Requirement
		var activeVerdict flexfallback.Verdict
		reason := flexfallback.ReasonOutsideWindow
		for i := range reqs {
			r := reqs[i]
			inst, inWindow := r.CurrentInstance(now)
			in := flexfallback.Input{Now: now, PlanFresh: planFresh}
			if inWindow {
				in.Progress = a.flexProgressFor(entityID, r.ID, inst.Key)
				in.ProgressKnown = a.flexEvidenceFresh(entityID, now)
			}
			v := flexfallback.Decide(r, in)
			if v.Active && (active == nil ||
				v.Instance.Deadline.Before(activeVerdict.Instance.Deadline)) {
				rc := r
				active, activeVerdict = &rc, v
			}
			if !v.Active && reason == flexfallback.ReasonOutsideWindow {
				reason = v.Reason
			}
		}

		if active != nil {
			a.logFlexTransition(entityID, flexfallback.ReasonRun, active.ID, activeVerdict)
			a.arb.SubmitInternal(&desired.Desired{
				EntityID:  entityID,
				RequestID: "flex-fallback:" + activeVerdict.Instance.Key,
				Source:    desired.Source{Kind: desired.SourceDeadlineFallback},
				Priority:  desired.ClassDeadlineFallback,
				TTL:       flexFallbackTTL,
				IssuedAt:  now,
				Commands:  active.Commands(),
			})
			a.flexMu.Lock()
			if a.flexHeld == nil {
				a.flexHeld = map[string]bool{}
			}
			a.flexHeld[entityID] = true
			a.flexMu.Unlock()
			continue
		}

		a.logFlexTransition(entityID, reason, "", flexfallback.Verdict{})
		a.flexMu.Lock()
		held := a.flexHeld[entityID]
		delete(a.flexHeld, entityID)
		a.flexMu.Unlock()
		if held {
			// Withdraw instead of letting the TTL run out: a fulfilled duty (or
			// a returning plan) ends the fallback NOW. The cycle guard still
			// governs the resulting transition (min-on holds are its call).
			a.arb.Withdraw(entityID, desired.Source{Kind: desired.SourceDeadlineFallback}.Key(), false)
			a.pokeArbitration()
		}
	}

	a.saveFlexStateThrottled(now)
}

// logFlexTransition logs a decision-reason CHANGE per entity - once, never
// per tick (a refusal must be visible, the OTA blocker lesson; steady state
// stays silent).
func (a *Agent) logFlexTransition(entityID, reason, reqID string, v flexfallback.Verdict) {
	a.flexMu.Lock()
	prev := a.flexLast[entityID]
	if prev == reason {
		a.flexMu.Unlock()
		return
	}
	if a.flexLast == nil {
		a.flexLast = map[string]string{}
	}
	a.flexLast[entityID] = reason
	a.flexMu.Unlock()
	if reason == flexfallback.ReasonRun {
		slog.Info("deadline fallback starts the flexible task itself",
			"entity", entityID, "requirement", reqID,
			"deadline", v.Instance.Deadline.UTC().Format(time.RFC3339),
			"latest_start", v.LatestStart.UTC().Format(time.RFC3339))
		return
	}
	slog.Info("deadline fallback inactive", "entity", entityID, "reason", reason)
}

// --- persistence (reboot bridge for the confirmed progress) -----------------

type flexPersist struct {
	Trackers map[string]map[string]*flexfallback.Tracker `json:"trackers"`
}

func (a *Agent) flexStatePath() string {
	return filepath.Join(a.Cfg.DataDir, flexStateFile)
}

// loadFlexState restores the confirmed-progress trackers (called from New,
// flag-gated: with the consumer switch off the file is not even read).
func (a *Agent) loadFlexState() {
	if !a.Cfg.ConsumerControlEnabled {
		return
	}
	raw, err := os.ReadFile(a.flexStatePath())
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("stored flex-fallback progress unreadable; starting without", "err", err)
		}
		return
	}
	var st flexPersist
	if err := json.Unmarshal(raw, &st); err != nil {
		slog.Warn("stored flex-fallback progress corrupt; starting without", "err", err)
		return
	}
	a.flexMu.Lock()
	a.flexTrack = st.Trackers
	if a.flexTrack == nil {
		a.flexTrack = map[string]map[string]*flexfallback.Tracker{}
	}
	a.flexMu.Unlock()
}

// saveFlexStateThrottled persists dirty progress at most every
// flexSaveInterval (atomic tmp+rename, the store discipline).
func (a *Agent) saveFlexStateThrottled(now time.Time) {
	a.flexMu.Lock()
	if !a.flexDirty || now.Sub(a.flexSavedAt) < flexSaveInterval {
		a.flexMu.Unlock()
		return
	}
	st := flexPersist{Trackers: map[string]map[string]*flexfallback.Tracker{}}
	for id, byReq := range a.flexTrack {
		cp := map[string]*flexfallback.Tracker{}
		for reqID, t := range byReq {
			tc := *t
			cp[reqID] = &tc
		}
		st.Trackers[id] = cp
	}
	a.flexDirty = false
	a.flexSavedAt = now
	a.flexMu.Unlock()

	raw, err := json.Marshal(st)
	if err != nil {
		slog.Error("flex-fallback progress marshal failed", "err", err)
		return
	}
	tmp := a.flexStatePath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		slog.Warn("flex-fallback progress not persisted", "err", err)
		return
	}
	if err := os.Rename(tmp, a.flexStatePath()); err != nil {
		slog.Warn("flex-fallback progress not persisted", "err", err)
	}
}
