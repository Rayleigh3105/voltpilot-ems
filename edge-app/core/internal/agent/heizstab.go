package agent

// The box side of the heating-rod controller (internal/heizstab; contract
// docs/contracts/v2/heizstab-regler.md). Every arbitration tick it reads the
// newest measurements (connection point, battery, the rod's own power), lets
// the controller decide the stage of every heating rod that carries a
// `heizstab` block and hands that stage to the arbiter as a RULE-class wish
// (rank 40). Everything above keeps its say: a manual "Jetzt heizen" (75), a
// fresh plan where no rule owns the rod, the guards, the cycle guard and
// "Automatik pausieren" (the arbiter suspends rule wishes).
//
// It runs here, in the Go core, because Edge Light has no Node-RED - the
// reactive rule flow would never run on the captain's box - and because it
// must go on without the cloud (HZ-7 = A): it reads only the registry the box
// keeps on disk and measurements from the house. Its memory (stage, last on
// and off, switches of the last hour) is kept on disk too, so a reboot never
// shortens a pause or a minimum run.
//
// Gated like the executors: no wish at all while VP_CONSUMER_CONTROL_ENABLED
// is off. The controller only drives a Shelly OUTPUT SET (the driver knows the
// stages and their kW); anything else is skipped and named in the log.

import (
	"encoding/json"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sort"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/heizstab"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
)

// heizstabTTL keeps a controller wish alive between ticks; a dead loop lets
// it expire into the fail-safe (off).
const heizstabTTL = 45 * time.Second

// heizstabRodMeasuredMaxAge bounds the rod's own MEASURED power (metering
// outputs); the confirmed stage may be older because the executor reads it
// at least once per re-assert.
const (
	heizstabRodMeasuredMaxAge = 30 * time.Second
	heizstabStageMaxAge       = 2*goeReassertInterval + 15*time.Second
)

const heizstabStateFile = "heizstab-state.json"

// heizstabRun is the agent-side memory of the controller.
type heizstabRun struct {
	loaded bool
	states map[string]*heizstab.State
	last   map[string]heizstab.Decision
	held   map[string]bool
	// warned is the last problem logged per rod (logged once, not per tick).
	warned map[string]string
	// observation of the house (from the telemetry choke point)
	gridKw *float64
	gridAt time.Time
	battKw *float64
	battAt time.Time
}

// heizstabObserve keeps the newest connection-point and battery readings - the
// SAME gated composite power_kw every guard on this box reads.
func (a *Agent) heizstabObserve(ts time.Time, measurements map[string]float64, battKw *float64) {
	a.heizMu.Lock()
	defer a.heizMu.Unlock()
	if g, ok := measurements["power_kw"]; ok && !math.IsNaN(g) && !math.IsInf(g, 0) {
		v := g
		a.heiz.gridKw, a.heiz.gridAt = &v, ts
	}
	if battKw != nil && !math.IsNaN(*battKw) && !math.IsInf(*battKw, 0) {
		v := *battKw
		a.heiz.battKw, a.heiz.battAt = &v, ts
	}
}

// heizstabRod is one rod the controller drives.
type heizstabRod struct {
	entity entities.Entity
	params heizstab.Params
	stages []heizstab.Stage
}

// heizstabRods lists the rods with an active block and a driver that knows its
// stages.
func heizstabRods(reg entities.Registry, problem func(id, msg string)) []heizstabRod {
	if problem == nil {
		problem = func(string, string) {}
	}
	var out []heizstabRod
	for _, e := range reg.Entities {
		if len(e.Heizstab) == 0 {
			continue
		}
		p, ok, err := heizstab.ParseParams(e.Heizstab)
		if err != nil {
			problem(e.ID, "Block abgelehnt: "+err.Error())
			continue
		}
		if !ok {
			continue
		}
		cfg, isShelly := shelly.ParseDriver(e.Driver)
		outs, kws := cfg.StageCeilings()
		if !isShelly || len(outs) == 0 {
			problem(e.ID, "kein Treiber mit Stufen - der Regler schaltet diesen Heizstab nicht")
			continue
		}
		rod := heizstabRod{entity: e, params: p}
		for i := range outs {
			rod.stages = append(rod.stages, heizstab.Stage{Outputs: outs[i], Kw: kws[i]})
		}
		out = append(out, rod)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].entity.ID < out[j].entity.ID })
	return out
}

// heizstabOwns reports whether the controller drives this entity right now -
// the plan executor then injects no market wish for it (a rule owns the rod,
// the Stufe-3 rule of owner_claimed, applied to the box's own rule).
func (a *Agent) heizstabOwns(entityID string) bool {
	if !a.Cfg.ConsumerControlEnabled {
		return false
	}
	a.entMu.Lock()
	e := a.entRegistry.Find(entityID)
	var one entities.Registry
	if e != nil {
		one.Entities = []entities.Entity{*e}
	}
	a.entMu.Unlock()
	return len(heizstabRods(one, nil)) == 1
}

// runHeizstab is one controller tick over every heating rod with a block.
func (a *Agent) runHeizstab(now time.Time) {
	if a.arb == nil {
		return
	}
	a.entMu.Lock()
	reg := a.entRegistry
	a.entMu.Unlock()
	problems := map[string]string{}
	rods := heizstabRods(reg, func(id, msg string) { problems[id] = msg })
	active := a.Cfg.ConsumerControlEnabled

	a.heizMu.Lock()
	if !a.heiz.loaded {
		a.loadHeizstabStateLocked()
	}
	for id, msg := range problems {
		if a.heiz.warned[id] != msg {
			slog.Warn("heizstab: "+msg, "entity", id)
		}
	}
	a.heiz.warned = problems
	grid, gridAt, batt, battAt := a.heiz.gridKw, a.heiz.gridAt, a.heiz.battKw, a.heiz.battAt
	a.heizMu.Unlock()

	seen := map[string]bool{}
	dirty := false
	for _, rod := range rods {
		id := rod.entity.ID
		seen[id] = true
		if !active {
			continue
		}
		rodKw := a.heizstabRodKw(id, now)
		a.heizMu.Lock()
		st := a.heiz.states[id]
		if st == nil {
			st = &heizstab.State{}
			a.heiz.states[id] = st
		}
		d := heizstab.Step(rod.params, rod.stages, st, heizstab.Inputs{Now: now,
			GridKw: grid, GridAt: gridAt, BatteryKw: batt, BatteryAt: battAt, RodKw: rodKw})
		prev, had := a.heiz.last[id]
		a.heiz.last[id] = d
		a.heiz.held[id] = true
		a.heizMu.Unlock()
		if d.Changed {
			dirty = true
			slog.Info("heizstab: Stufe", "entity", id, "stufe", d.Stage, "ausgaenge", d.Outputs,
				"kw", d.Kw, "code", d.Code, "grund", d.Reason)
		} else if !had || prev.Code != d.Code {
			slog.Debug("heizstab: Grund", "entity", id, "code", d.Code, "grund", d.Reason)
		}
		kw := d.Kw
		cmds := a.consumerCommands(rod.entity, entities.Commands{SetpointKw: &kw})
		a.arb.SubmitInternal(&desired.Desired{
			EntityID:      id,
			RequestID:     "heizstab:" + st.Since.UTC().Format(time.RFC3339) + ":" + d.Code,
			Source:        desired.Source{Kind: desired.SourceHeizstab},
			Priority:      desired.ClassFlow,
			TTL:           heizstabTTL,
			IssuedAt:      now,
			Commands:      cmds,
			RequestedType: entities.CmdSetpointKw,
		})
	}

	// Rods that lost their block (or control went off): release the wish now,
	// never let it linger until its TTL.
	a.heizMu.Lock()
	var release []string
	for id := range a.heiz.held {
		if !seen[id] || !active {
			release = append(release, id)
			delete(a.heiz.held, id)
			delete(a.heiz.last, id)
		}
	}
	for id := range a.heiz.states {
		if !seen[id] {
			delete(a.heiz.states, id)
			dirty = true
		}
	}
	a.heizMu.Unlock()
	for _, id := range release {
		a.arb.Withdraw(id, desired.Source{Kind: desired.SourceHeizstab}.Key(), false)
		a.pokeArbitration()
	}
	if dirty {
		a.saveHeizstabState()
	}
}

// heizstabRodKw is the rod's own draw now: MEASURED (a metering output set
// publishes power_kw), else the kW of its CONFIRMED stage (the executor's
// readback). nil = unknown - the controller then starts nothing.
func (a *Agent) heizstabRodKw(id string, now time.Time) *float64 {
	a.entMu.Lock()
	er, ok := a.entReadings[id]
	a.entMu.Unlock()
	if ok && now.Sub(er.recv) <= heizstabRodMeasuredMaxAge {
		if kw, has := er.channels["power_kw"]; has && !math.IsNaN(kw) && !math.IsInf(kw, 0) {
			v := kw
			return &v
		}
	}
	if st := a.shellyGroupStage(id); st != nil && st.ConfirmedKw != nil {
		if at, err := time.Parse(time.RFC3339, st.At); err == nil && now.Sub(at) <= heizstabStageMaxAge {
			v := *st.ConfirmedKw
			return &v
		}
	}
	return nil
}

// heizstabSummary is the controller's verdict for the heartbeat (nil = no
// controller for this entity).
func (a *Agent) heizstabSummary(id string) *cloud.ConsumerHeizstab {
	a.heizMu.Lock()
	defer a.heizMu.Unlock()
	d, ok := a.heiz.last[id]
	if !ok {
		return nil
	}
	out := &cloud.ConsumerHeizstab{Stufe: d.Stage, Ausgaenge: d.Outputs, Kw: d.Kw,
		Code: d.Code, Grund: d.Reason, VerfuegbarKw: d.AvailableKw}
	if !d.NextUpAt.IsZero() {
		out.HoeherAb = d.NextUpAt.UTC().Format(time.RFC3339)
	}
	if st := a.heiz.states[id]; st != nil && !st.Since.IsZero() {
		out.Seit = st.Since.UTC().Format(time.RFC3339)
	}
	return out
}

// --- the controller's memory on disk ---------------------------------------

type heizstabStateDoc struct {
	SchemaVersion int                        `json:"schema_version"`
	Rods          map[string]*heizstab.State `json:"heizstaebe"`
}

func (a *Agent) heizstabStatePath() string {
	return filepath.Join(a.Cfg.DataDir, heizstabStateFile)
}

// loadHeizstabStateLocked reads the memory once (heizMu held). A file from
// another schema is ignored wholesale - start clean rather than mis-read.
func (a *Agent) loadHeizstabStateLocked() {
	a.heiz.loaded = true
	a.heiz.states = map[string]*heizstab.State{}
	if a.heiz.last == nil {
		a.heiz.last = map[string]heizstab.Decision{}
	}
	if a.heiz.held == nil {
		a.heiz.held = map[string]bool{}
	}
	if a.Cfg.DataDir == "" {
		return
	}
	raw, err := os.ReadFile(a.heizstabStatePath())
	if err != nil {
		return
	}
	var doc heizstabStateDoc
	if json.Unmarshal(raw, &doc) != nil || doc.SchemaVersion != 1 {
		slog.Warn("heizstab: gespeicherter Zustand nicht lesbar - Neubeginn")
		return
	}
	for id, st := range doc.Rods {
		if st != nil {
			a.heiz.states[id] = st
		}
	}
}

// saveHeizstabState writes the memory atomically (tmp + rename).
func (a *Agent) saveHeizstabState() {
	if a.Cfg.DataDir == "" {
		return
	}
	a.heizMu.Lock()
	doc := heizstabStateDoc{SchemaVersion: 1, Rods: map[string]*heizstab.State{}}
	for id, st := range a.heiz.states {
		cp := *st
		cp.Switches = append([]time.Time(nil), st.Switches...)
		doc.Rods[id] = &cp
	}
	a.heizMu.Unlock()
	raw, _ := json.MarshalIndent(doc, "", "  ")
	tmp := a.heizstabStatePath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		slog.Warn("heizstab: Zustand nicht gespeichert", "err", err)
		return
	}
	if err := os.Rename(tmp, a.heizstabStatePath()); err != nil {
		slog.Warn("heizstab: Zustand nicht gespeichert", "err", err)
	}
}
