package agent

// The executor side of a Shelly OUTPUT SET: ONE heating-rod device over
// several outputs, switched in stages (internal/shelly group.go; contract
// docs/contracts/v2/heizstab-shelly.md). It runs inside the same control pass,
// behind the same two kill-switches, with the same 60-s re-assert that re-arms
// every output's own dead-man timer, as the single-output path - and adds:
//
//   - a memory per entity (what was commanded and read per output), because
//     the stage choice keeps outputs that are on and counts an output that is
//     on although it should be off (HZ-4 = B);
//   - since when an output deviates, published per register and in the
//     heartbeat, so a deviation that lasts is visible and nothing is hidden;
//   - the stage the heartbeat reports (commanded and CONFIRMED, with kW) -
//     what the ledger counts instead of "rated power x time";
//   - a refusal to drive any output two entities claim (a set over the
//     outputs of a per-output component): two writers on one relay would
//     undo each other, so neither writes and both say why.

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

// shellyGroupRun is the executor's memory of one output-set entity.
type shellyGroupRun struct {
	prev  shelly.GroupPrev
	since []time.Time // per output: when its deviation began (zero = as commanded)
	stage *cloud.ConsumerStage
}

// shellyDay is the stage-1 rotation day (UTC days since the epoch): the start
// output of a partial stage moves by one each day (HZ-3 = A).
func shellyDay(now time.Time) int { return int(now.UTC().Unix() / 86400) }

// shellyInitialReadBudget is the time a connection test must have left to also
// read the "nach Stromausfall" setting - one more request, 1.5-3.5 s on a weak
// WLAN. Without it the setting stays unread (never guessed) and the portal's
// wait is not put at risk.
const shellyInitialReadBudget = 4 * time.Second

// shellyOutputKey names one physical output for the double-writer check.
func shellyOutputKey(cfg shelly.Config, ch int) string {
	return cfg.HostPort() + "/" + strconv.Itoa(ch)
}

// shellyOutputsOf is every output a shelly entity drives.
func shellyOutputsOf(cfg shelly.Config) []int {
	if cfg.IsGroup() {
		return cfg.Channels
	}
	return []int{cfg.Channel}
}

// shellyDoubleClaims returns, per entity, the first output it shares with
// another entity - only where an output SET is involved (two single outputs on
// one channel are already refused when the registry is applied).
func shellyDoubleClaims(reg entities.Registry) map[string]int {
	type claim struct {
		id    string
		group bool
	}
	claims := map[string][]claim{}
	for _, e := range reg.Entities {
		cfg, ok := shelly.ParseDriver(e.Driver)
		if !ok {
			continue
		}
		for _, ch := range shellyOutputsOf(cfg) {
			k := shellyOutputKey(cfg, ch)
			claims[k] = append(claims[k], claim{id: e.ID, group: cfg.IsGroup()})
		}
	}
	out := map[string]int{}
	for k, cs := range claims {
		if len(cs) < 2 {
			continue
		}
		anyGroup := false
		for _, c := range cs {
			anyGroup = anyGroup || c.group
		}
		if !anyGroup {
			continue
		}
		ch, _ := strconv.Atoi(k[strings.LastIndex(k, "/")+1:])
		for _, c := range cs {
			if _, seen := out[c.id]; !seen {
				out[c.id] = ch
			}
		}
	}
	return out
}

// shellyDoubleClaimMessage is the honest refusal of a doubly claimed output.
func shellyDoubleClaimMessage(ch int) string {
	return "Ausgang " + strconv.Itoa(ch) + " gehört zu zwei Geräten - VoltPilot schaltet keines von beiden, " +
		"bis jeder Ausgang genau einem Gerät gehört."
}

// publishShellyDoubleClaim publishes the refusal as the entity's readback, so
// the surfaces see why nothing switches (no write, no read).
func (a *Agent) publishShellyDoubleClaim(e entities.Entity, cfg shelly.Config, ch int, now time.Time) {
	if a.Bus == nil {
		return
	}
	msg := shellyDoubleClaimMessage(ch)
	var payload []byte
	if cfg.IsGroup() {
		payload = shelly.GroupReadbackPayload(e.ID, now.UTC().Format(time.RFC3339), shelly.GroupResult{
			Plan:      shelly.GroupPlan{Adapter: shelly.Communication, Target: cfg.HostPort(), Mode: "idle"},
			ErrorCode: shelly.ErrInvalidRequest, Message: msg}, nil)
	} else {
		payload = shelly.ReadbackPayload(e.ID, now.UTC().Format(time.RFC3339), shelly.Result{
			Plan:      shelly.Plan{Adapter: shelly.Communication, Target: cfg.HostPort(), Mode: "idle"},
			ErrorCode: shelly.ErrInvalidRequest, Message: msg})
	}
	if err := a.Bus.Publish(entities.ReadbackTopic(e.ID), payload, false); err != nil {
		slog.Error("shelly readback publish failed", "entity", e.ID, "err", err)
	}
}

// shellyGroupPrev copies the entity's memory (empty for a new entity).
func (a *Agent) shellyGroupPrev(id string) shelly.GroupPrev {
	a.shellyGroupMu.Lock()
	defer a.shellyGroupMu.Unlock()
	run := a.shellyGroups[id]
	if run == nil {
		return shelly.GroupPrev{}
	}
	return shelly.GroupPrev{Commanded: append([]bool(nil), run.prev.Commanded...),
		Read: append([]*bool(nil), run.prev.Read...)}
}

// runShellyGroupEntity is one pass for an output-set entity (the group twin of
// the single-output body of runShellyControlPass).
func (a *Agent) runShellyGroupEntity(ctx context.Context, doer shelly.Doer, e entities.Entity,
	cfg shelly.Config, lastFP map[string]string, lastAssert map[string]time.Time, now time.Time) {
	cmd := a.shellyCommandFor(e.ID)
	prev := a.shellyGroupPrev(e.ID)
	day := shellyDay(now)
	fp := shellyGroupFingerprint(shelly.PlanGroupFor(cfg, cmd, prev, day))
	due := now.Sub(lastAssert[e.ID]) >= goeReassertInterval
	if fp == lastFP[e.ID] && !due {
		return
	}
	ident, err := a.shellyIdentity(ctx, doer, cfg)
	if err != nil {
		slog.Warn("shelly detect failed", "entity", e.ID, "target", cfg.HostPort(), "err", err)
		lastAssert[e.ID] = now
		return
	}
	res := shelly.ExecuteGroup(ctx, doer, cfg, ident, cmd, prev, day)
	if !res.OK || res.ErrorCode != "" {
		slog.Warn("shelly stage execute", "entity", e.ID, "ok", res.OK,
			"error_code", res.ErrorCode, "msg", res.Message)
		if res.ErrorCode == shelly.ErrInvalidResponse {
			a.shellyForgetIdentity(cfg)
		}
	}
	since := a.rememberShellyGroup(e.ID, cfg, res, now)
	if a.Bus != nil {
		payload := shelly.GroupReadbackPayload(e.ID, now.UTC().Format(time.RFC3339), res, since)
		if err := a.Bus.Publish(entities.ReadbackTopic(e.ID), payload, false); err != nil {
			slog.Error("shelly readback publish failed", "entity", e.ID, "err", err)
		}
		if res.OK && res.Verdict.PowerKw != nil {
			a.publishShellyEntityTelemetry(e.ID, shelly.Result{OK: true,
				Verdict: shelly.Verdict{PowerKw: res.Verdict.PowerKw}}, now)
		}
	}
	lastFP[e.ID] = shellyGroupFingerprint(res.Plan)
	lastAssert[e.ID] = now
}

// rememberShellyGroup folds one execute into the entity's memory and returns
// the per-output deviation starts for the readback.
func (a *Agent) rememberShellyGroup(id string, cfg shelly.Config, res shelly.GroupResult, now time.Time) []time.Time {
	a.shellyGroupMu.Lock()
	defer a.shellyGroupMu.Unlock()
	if a.shellyGroups == nil {
		a.shellyGroups = map[string]*shellyGroupRun{}
	}
	n := len(cfg.Channels)
	run := a.shellyGroups[id]
	if run == nil || len(run.since) != n {
		run = &shellyGroupRun{since: make([]time.Time, n)}
		a.shellyGroups[id] = run
	}
	if res.Plan.Mode == "idle" {
		run.prev, run.stage = shelly.GroupPrev{}, nil
		run.since = make([]time.Time, n)
		return run.since
	}
	if res.Wrote {
		run.prev.Commanded = append([]bool(nil), res.Plan.Targets...)
	}
	if res.OK {
		run.prev.Read = append([]*bool(nil), res.Verdict.Outputs...)
		for i := 0; i < n; i++ {
			mismatch := i < len(res.Verdict.Registers) && !res.Verdict.Registers[i].Match
			switch {
			case !mismatch:
				run.since[i] = time.Time{}
			case run.since[i].IsZero():
				run.since[i] = now
			}
		}
	} else {
		// The device fell silent: what it said before is no longer known.
		run.prev.Read = make([]*bool, n)
	}
	st := &cloud.ConsumerStage{Commanded: res.Plan.Stage, CommandedKw: res.Plan.StageKw,
		At: now.UTC().Format(time.RFC3339)}
	if res.OK {
		st.Confirmed, st.ConfirmedKw = res.Verdict.ConfirmedStage, res.Verdict.ConfirmedKw
		for i, on := range res.Verdict.Outputs {
			if on != nil && *on {
				st.OutputsOn = append(st.OutputsOn, cfg.Channels[i])
			}
		}
	}
	var oldest time.Time
	for _, t := range run.since {
		if !t.IsZero() && (oldest.IsZero() || t.Before(oldest)) {
			oldest = t
		}
	}
	if !oldest.IsZero() {
		st.MismatchSince = oldest.UTC().Format(time.RFC3339)
	}
	run.stage = st
	return append([]time.Time(nil), run.since...)
}

// shellyGroupStage is the stage the heartbeat reports for an entity (nil =
// not an output set, or nothing executed yet).
func (a *Agent) shellyGroupStage(id string) *cloud.ConsumerStage {
	a.shellyGroupMu.Lock()
	defer a.shellyGroupMu.Unlock()
	run := a.shellyGroups[id]
	if run == nil || run.stage == nil {
		return nil
	}
	cp := *run.stage
	cp.OutputsOn = append([]int(nil), run.stage.OutputsOn...)
	return &cp
}

// forgetShellyGroups drops the memory of entities that left the registry.
func (a *Agent) forgetShellyGroups(seen map[string]bool) {
	a.shellyGroupMu.Lock()
	defer a.shellyGroupMu.Unlock()
	for id := range a.shellyGroups {
		if !seen[id] {
			delete(a.shellyGroups, id)
		}
	}
}

// shellyGroupFingerprint identifies a stage plan's write intent.
func shellyGroupFingerprint(p shelly.GroupPlan) string {
	var b strings.Builder
	b.WriteString(p.Mode + "/" + strconv.Itoa(p.Stage) + "/" + strconv.Itoa(p.TimerS) + "/" +
		strconv.FormatBool(p.ControlEnabled) + "/")
	for _, t := range p.Targets {
		if t {
			b.WriteByte('1')
		} else {
			b.WriteByte('0')
		}
	}
	return b.String()
}

// shellyGroupSourceReading reads an output-set SOURCE: relay_on is the rod-level
// fact "heats" (any output on, only when every output was read), outputs the
// per-output states, load_kw the sum when every output measures.
func shellyGroupSourceReading(ctx context.Context, doer shelly.Doer, cfg shelly.Config,
	ident shelly.Identity) (map[string]any, *shelly.DriverError) {
	st, de := shelly.ReadGroupState(ctx, doer, cfg, ident)
	if de != nil {
		return nil, de
	}
	payload := map[string]any{}
	outs, all, heats := make([]bool, len(st.Outputs)), true, false
	for i, on := range st.Outputs {
		if on == nil {
			all = false
			continue
		}
		outs[i] = *on
		heats = heats || *on
	}
	if all {
		payload["relay_on"] = heats
		payload["outputs"] = outs
	}
	if st.PowerKw != nil {
		payload["load_kw"] = *st.PowerKw
	}
	return payload, nil
}

// shellyGroupTest is the connection test of an output set: identify, read every
// output from one status answer (two requests, like a single output), then -
// while the test's time allows - the "nach Stromausfall" setting of each
// output (HZ-5: shown and warned about, never changed here).
func (a *Agent) shellyGroupTest(req testconn.Request, cfg shelly.Config) testconn.Result {
	doer := a.shellyDoerRef()
	ctx, cancel := context.WithTimeout(context.Background(), testReadTimeout)
	defer cancel()
	ident, st, err := shelly.DetectGroup(ctx, doer, cfg)
	if err != nil {
		return shellyTestFailure(err)
	}
	res := testconn.Result{OK: true, Reading: &testconn.Reading{LoadKw: st.PowerKw}}
	outs := make([]testconn.OutputState, len(cfg.Channels))
	for i, ch := range cfg.Channels {
		outs[i] = testconn.OutputState{Channel: ch, On: st.Outputs[i]}
		if st.Outputs[i] != nil {
			res.States = append(res.States, testconn.ChannelState{
				Channel: shellyRelayChannel + "_" + strconv.Itoa(ch), Value: b01(*st.Outputs[i])})
		}
	}
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) > shellyInitialReadBudget {
		if initial, de := shelly.ReadInitialStates(ctx, doer, cfg, ident); de == nil {
			for i := range outs {
				outs[i].InitialState = initial[i]
			}
		} else {
			slog.Info("shelly: Einstellung nach Stromausfall nicht gelesen", "target", cfg.HostPort(), "err", de)
		}
	}
	res.Outputs = outs
	if req.ControlTest {
		out := shelly.GroupControlCheck(ctx, doer, cfg)
		res.ControlCheck = &testconn.ControlCheck{
			OK: out.OK, Skipped: out.Skipped, Key: out.Key, Value: out.Value,
			ErrorCode: out.ErrorCode, Message: out.Message,
			Gen: out.Gen, DeviceModel: out.Model, Metering: out.Metering,
		}
	}
	return res
}

// runShellyNachStromausfallAus answers the probe op of the same name: write
// "nach Stromausfall: aus" to every output of the connection, read the setting
// back and report it per output. Detected fresh, like a connection test (the
// form may not be saved yet).
func (a *Agent) runShellyNachStromausfallAus(op probe.Op) probe.OpResult {
	var cfg shelly.Config
	if err := json.Unmarshal(op.Connection, &cfg); err != nil || cfg.IP == "" {
		return probe.Failed(op.ID, probe.ErrInvalidRequest, "Die Verbindungsdaten sind nicht lesbar.")
	}
	if msg := shelly.ChannelsError(cfg.Channels); msg != "" || (!cfg.IsGroup() && (cfg.Channel < 0 || cfg.Channel > 3)) {
		if msg == "" {
			msg = "Der Schaltkanal muss zwischen 0 und 3 liegen."
		}
		return probe.Failed(op.ID, probe.ErrInvalidRequest, msg)
	}
	doer := a.shellyDoerRef()
	ctx, cancel := context.WithTimeout(context.Background(), testReadTimeout)
	defer cancel()
	var ident shelly.Identity
	var err error
	if cfg.IsGroup() {
		ident, _, err = shelly.DetectGroup(ctx, doer, cfg)
	} else {
		ident, err = shelly.Detect(ctx, doer, cfg)
	}
	if err != nil {
		f := shellyTestFailure(err)
		return probe.Failed(op.ID, f.ErrorCode, f.Message)
	}
	if de := shelly.SetInitialOff(ctx, doer, cfg, ident); de != nil {
		f := shellyTestFailure(de)
		return probe.Failed(op.ID, f.ErrorCode, f.Message)
	}
	slog.Info("shelly: nach Stromausfall auf aus gestellt", "target", cfg.HostPort(), "op", op.ID)
	chs := shellyOutputsOf(cfg)
	ausgaenge := make([]probe.Ausgang, len(chs))
	for i, ch := range chs {
		ausgaenge[i] = probe.Ausgang{Kanal: ch}
	}
	if initial, de := shelly.ReadInitialStates(ctx, doer, cfg, ident); de == nil {
		for i := range ausgaenge {
			ausgaenge[i].NachStromausfall = initial[i]
		}
	}
	return probe.OpResult{ID: op.ID, OK: true, Ausgaenge: ausgaenge}
}
