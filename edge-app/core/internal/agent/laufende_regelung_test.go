package agent

// UE-3 (scout report vp-wr-ueberschuss-entladung-k3 §1.7 N3/N5, Herzogau
// 2026-10-10): a regulation the box started itself and that is already
// running survives a single failed readback, and the setpoint path never
// executes a plan-executor command that was injected for another plan or slot
// than the one it reads on the same tick.
//
// The replays drive the real handlers - onControlReadback for the recorded
// Layer-1 cycles, onSchedule for the plan arrival, applySetpoint at the
// recorded recomputation instants - with the measurements of the capture
// (belege/mitschnitt-20261010-*, all times UTC; local time is +2 h).

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlprofile"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// The three Layer-1 cycle shapes of the capture.
const (
	ue3Held = "held"
	// ue3Fill is the answer that preceded each of the three dropouts: the
	// remote block came back as 65535. Layer 1 judges that "unread" on the
	// three mode registers and "dead-man switch OFF" - a mismatch - on 1101,
	// while the written setpoint register 1109 itself held.
	ue3Fill        = "fill"
	ue3Unconfirmed = "unconfirmed"
)

func ue3At(clock string) time.Time {
	t, err := time.Parse("2006-01-02T15:04:05.000Z", "2026-10-10T"+clock+"Z")
	if err != nil {
		panic(err)
	}
	return t
}

// ue3Readback feeds one Layer-1 cycle through the real ingest, shaped like the
// recorded Deye remote-block readback for the setpoint kw in force.
func ue3Readback(t *testing.T, a *Agent, at time.Time, kw float64, shape string) {
	t.Helper()
	raw := int(uint16(int16(math.Round(-kw / 0.03))))
	reg := func(role string, addr, commanded int, actual any, verdict, note string) map[string]any {
		return map[string]any{
			"role": role, "fc": 3, "addr": addr, "commanded_raw": commanded,
			"actual_raw": actual, "match": verdict == "held", "verdict": verdict, "note": note,
		}
	}
	const unread = "unplausibler Rueckgabewert 65535 - keine echte Antwort"
	msg := map[string]any{
		"ts": at.Format(time.RFC3339Nano), "family": "hybrid_3p", "source": "schedule",
		"control_enabled": true, "certified": true, "mode": "normal", "wrote": true,
		"control_path": "remote", "remote_status_raw": 0,
	}
	power := reg("battery_power", 1109, raw, raw, "held", "")
	switch shape {
	case ue3Held:
		msg["verify"], msg["all_match"] = "held", true
		msg["registers"] = []any{
			reg("remote_watchdog", 1101, 60, 60, "held", ""),
			reg("power_control_mode", 1104, 1, 1, "held", ""),
			reg("battery_strategy", 1105, 2, 2, "held", ""),
			power,
			reg("remote_mode", 1100, 1, 1, "held", ""),
		}
	case ue3Fill:
		msg["verify"], msg["all_match"] = "mismatch", false
		msg["unread_roles"] = []string{"power_control_mode", "battery_strategy", "remote_mode"}
		msg["registers"] = []any{
			reg("remote_watchdog", 1101, 60, 65535, "mismatch",
				"Totmannschalter steht auf AUS - die Scharfstellung wurde nicht uebernommen"),
			reg("power_control_mode", 1104, 1, nil, "unread", unread),
			reg("battery_strategy", 1105, 2, nil, "unread", unread),
			power,
			reg("remote_mode", 1100, 1, nil, "unread", unread),
		}
	case ue3Unconfirmed:
		msg["verify"], msg["all_match"] = "unconfirmed", nil
		msg["unread_roles"] = []string{"battery_strategy", "remote_mode"}
		msg["registers"] = []any{
			reg("remote_watchdog", 1101, 60, 60, "held", ""),
			reg("power_control_mode", 1104, 1, 1, "held", ""),
			reg("battery_strategy", 1105, 2, nil, "unread", unread),
			power,
			reg("remote_mode", 1100, 1, nil, "unread", unread),
		}
	default:
		t.Fatalf("unknown readback shape %q", shape)
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	a.onControlReadback("", payload)
}

func ue3Measure(a *Agent, at time.Time, pv, load float64) {
	a.mu.Lock()
	a.lastReading = guards.Reading{SocPct: 37, PvKw: pv, LoadKw: load, GridLimitKw: guards.Unknown()}
	a.lastReadingAt = at
	a.mu.Unlock()
}

// ue3RestPlan is a fresh Fahrplan slot commanding 0 kW, floor 5 %. On the day
// the slot 15:15Z planned a +0.766 kW charge that the price trim had cut to
// 0 kW (state: trim planned 0.766 / surplus 0); the gate under test sees that
// 0 kW either way. Commanding it directly keeps the replay independent of how
// a CHARGE slot may start a discharge - that rule is UE-1's, not this one's.
func ue3RestPlan(slot time.Time) *plan.Plan {
	floor := 5.0
	return &plan.Plan{
		SlotMinutes: 15, ReceivedAt: slot, GeneratedAt: slot,
		EffectiveFloorSocPct: &floor,
		Slots:                []plan.Slot{{Start: slot, BatterySetpointKw: 0}},
	}
}

// ue3Event is one recorded instant: a measurement refresh ('m'), a Layer-1
// readback cycle ('r') or a recomputation of the setpoint ('t' - the 10 s tick
// at :x8 or a nudge of the arbitration in between).
type ue3Event struct {
	at       string
	kind     byte
	pv, load float64
	shape    string
	// recordedKw is what the box published at this recomputation on the day;
	// dropout marks the recomputation that fell to 0 kW.
	recordedKw float64
	dropout    bool
}

// ue3Replay returns the setpoint of every recomputation and the index of the
// one that was the recorded dropout.
func ue3Replay(t *testing.T, a *Agent, events []ue3Event) ([]float64, int) {
	t.Helper()
	var out []float64
	dropout := -1
	for _, e := range events {
		at := ue3At(e.at)
		switch e.kind {
		case 'm':
			ue3Measure(a, at, e.pv, e.load)
		case 'r':
			ue3Readback(t, a, at, a.State.Get().SetpointKw, e.shape)
		case 't':
			a.applySetpoint(at)
			sp := a.State.Get().SetpointKw
			t.Logf("%s setpoint %+.3f kW (recorded %+.3f), readback %s", e.at, sp, e.recordedKw,
				a.State.Get().Control.Confirm)
			if e.dropout {
				dropout = len(out)
			}
			out = append(out, sp)
		}
	}
	return out, dropout
}

// The three dropouts of 2026-10-10 (17:23:18, 17:26:48, 17:29:30 local): a
// discharge the box had started itself to cover a measured deficit fell to
// 0 kW on the recomputation after ONE readback cycle that answered 65535, and
// took 8-22 s to return while the house bought 0.6-2.8 kW. Replayed, the
// setpoint stays on the discharge side through each of them.
func TestARunningDeficitCoverSurvivesTheRecordedReadbackDropouts(t *testing.T) {
	cases := []struct {
		name   string
		slot   string
		events []ue3Event
	}{
		{"17:23:18 - 22 s at 0 kW, import up to 1.27 kW", "15:15:00.000", []ue3Event{
			// The deficit had stood at 0.2-0.3 kW for 47 s, below the damped
			// follower's reserve: the box rested at 0 kW until the load step.
			{at: "15:22:18.845", kind: 'r', shape: ue3Held},
			{at: "15:22:25.400", kind: 'm', pv: 2.14, load: 2.35},
			{at: "15:22:28.300", kind: 't', recordedKw: 0},
			{at: "15:22:28.859", kind: 'r', shape: ue3Held},
			{at: "15:22:35.400", kind: 'm', pv: 2.09, load: 2.35},
			{at: "15:22:38.300", kind: 't', recordedKw: 0},
			{at: "15:22:38.821", kind: 'r', shape: ue3Unconfirmed},
			{at: "15:22:45.400", kind: 'm', pv: 2.03, load: 2.31},
			{at: "15:22:48.300", kind: 't', recordedKw: 0},
			{at: "15:22:48.825", kind: 'r', shape: ue3Held},
			{at: "15:22:55.400", kind: 'm', pv: 1.97, load: 2.26},
			{at: "15:22:58.300", kind: 't', recordedKw: 0},
			{at: "15:22:58.816", kind: 'r', shape: ue3Held},
			{at: "15:23:05.400", kind: 'm', pv: 1.96, load: 2.27},
			{at: "15:23:08.300", kind: 't', recordedKw: 0},
			{at: "15:23:08.834", kind: 'r', shape: ue3Held},
			{at: "15:23:10.400", kind: 'm', pv: 1.84, load: 3.11},
			{at: "15:23:15.300", kind: 't', recordedKw: -0.765},
			{at: "15:23:15.833", kind: 'r', shape: ue3Fill},
			{at: "15:23:18.300", kind: 't', recordedKw: 0, dropout: true},
			{at: "15:23:18.834", kind: 'r', shape: ue3Held},
			{at: "15:23:25.400", kind: 'm', pv: 1.73, load: 3.00},
			{at: "15:23:28.300", kind: 't', recordedKw: 0},
			{at: "15:23:28.830", kind: 'r', shape: ue3Held},
			{at: "15:23:35.400", kind: 'm', pv: 1.69, load: 2.99},
			{at: "15:23:38.300", kind: 't', recordedKw: 0},
			{at: "15:23:38.844", kind: 'r', shape: ue3Held},
			{at: "15:23:40.300", kind: 't', recordedKw: -0.71},
		}},
		{"17:26:48 - 20 s at 0 kW, import up to 2.83 kW", "15:15:00.000", []ue3Event{
			{at: "15:26:18.837", kind: 'r', shape: ue3Held},
			{at: "15:26:25.400", kind: 'm', pv: 0.80, load: 2.295},
			{at: "15:26:28.300", kind: 't', recordedKw: -0.982},
			{at: "15:26:28.840", kind: 'r', shape: ue3Held},
			{at: "15:26:35.400", kind: 'm', pv: 0.79, load: 3.21},
			{at: "15:26:38.300", kind: 't', recordedKw: -1.917},
			{at: "15:26:38.837", kind: 'r', shape: ue3Fill},
			{at: "15:26:45.400", kind: 'm', pv: 0.78, load: 3.68},
			{at: "15:26:48.300", kind: 't', recordedKw: 0, dropout: true},
			{at: "15:26:48.843", kind: 'r', shape: ue3Held},
			{at: "15:26:55.400", kind: 'm', pv: 0.77, load: 3.55},
			{at: "15:26:58.300", kind: 't', recordedKw: 0},
			{at: "15:26:58.845", kind: 'r', shape: ue3Held},
			{at: "15:27:05.400", kind: 'm', pv: 0.77, load: 3.60},
			{at: "15:27:08.300", kind: 't', recordedKw: -2.33},
			{at: "15:27:08.830", kind: 'r', shape: ue3Unconfirmed},
			{at: "15:27:18.300", kind: 't', recordedKw: -2.33},
		}},
		{"17:29:30 - 8 s at 0 kW, import 0.63 kW", "15:15:00.000", []ue3Event{
			{at: "15:29:08.830", kind: 'r', shape: ue3Held},
			{at: "15:29:15.400", kind: 'm', pv: 0.57, load: 2.73},
			{at: "15:29:18.300", kind: 't', recordedKw: -1.641},
			{at: "15:29:18.835", kind: 'r', shape: ue3Held},
			{at: "15:29:21.804", kind: 'r', shape: ue3Held},
			{at: "15:29:25.400", kind: 'm', pv: 0.55, load: 2.88},
			{at: "15:29:26.832", kind: 'r', shape: ue3Held},
			{at: "15:29:28.300", kind: 't', recordedKw: -1.641},
			{at: "15:29:28.831", kind: 'r', shape: ue3Fill},
			{at: "15:29:30.300", kind: 't', recordedKw: 0, dropout: true},
			{at: "15:29:30.816", kind: 'r', shape: ue3Held},
			{at: "15:29:35.400", kind: 'm', pv: 0.54, load: 2.88},
			{at: "15:29:38.300", kind: 't', recordedKw: -1.831},
			{at: "15:29:39.079", kind: 'r', shape: ue3Held},
		}},
	}
	for _, c := range cases {
		// Once with the plain follower and once behind the damped follower of
		// the pilot's Deye profile, which is what stretched the recorded
		// dropouts from one recomputation to 8-22 s.
		for _, damped := range []bool{false, true} {
			name := c.name
			if damped {
				name += ", damped"
			}
			t.Run(name, func(t *testing.T) {
				a := followAgent(t)
				if damped {
					a.dampProfileFor = func(controlprofile.Device) guards.DampProfile {
						return guards.DampProfileFor(controlprofile.Device{
							Brand: inverter.BrandDeye, Family: inverter.FamHybrid3p, ControlPath: "remote"})
					}
				}
				a.mu.Lock()
				a.currentPlan = ue3RestPlan(ue3At(c.slot))
				a.mu.Unlock()
				got, dropout := ue3Replay(t, a, c.events)
				began := -1
				for i, sp := range got {
					if sp < 0 && began < 0 {
						began = i
					}
					if began >= 0 && sp >= 0 {
						t.Fatalf("recomputation %d of %d published %+.3f kW: the running discharge must stay "+
							"on its side through one failed readback (all: %v)", i+1, len(got), sp, got)
					}
				}
				// The discharge must be running BEFORE the recorded dropout,
				// or the replay proves nothing.
				if began < 0 || began >= dropout {
					t.Fatalf("the discharge began at recomputation %d, the recorded dropout is number %d (all: %v)",
						began+1, dropout+1, got)
				}
				if f := a.State.Get().Follow; f == nil || f.Path != execModeDeficitCover {
					t.Fatalf("the correction must keep its name through the flicker: %+v", f)
				}
			})
		}
	}
}

// ue3Running brings the box into a self-started discharge on an idle slot:
// held readback, 1.2 kW measured deficit, one recomputation.
func ue3Running(t *testing.T) (*Agent, time.Time) {
	t.Helper()
	a := followAgent(t)
	t0 := ue3At("15:20:00.000")
	a.mu.Lock()
	a.currentPlan = ue3RestPlan(ue3At("15:15:00.000"))
	a.mu.Unlock()
	ue3Measure(a, t0, 1.0, 2.2)
	ue3Readback(t, a, t0, 0, ue3Held)
	a.applySetpoint(t0)
	if sp := a.State.Get().SetpointKw; math.Abs(sp+1.2) > 0.001 {
		t.Fatalf("setup: the deficit cover must run at -1.2 kW, got %+.3f", sp)
	}
	return a, t0
}

func ue3Tick(a *Agent, at time.Time) float64 {
	ue3Measure(a, at, 1.0, 2.2)
	a.applySetpoint(at)
	return a.State.Get().SetpointKw
}

// "Three failed readbacks": two in a row are a flicker the running discharge
// rides out, the third ends it - on the tick that also turns the card to
// "not held".
func TestARunningDeficitCoverEndsWithTheThirdFailedReadback(t *testing.T) {
	a, t0 := ue3Running(t)
	for i, wantRunning := range []bool{true, true, false} {
		at := t0.Add(time.Duration(i+1) * 5 * time.Second)
		ue3Readback(t, a, at.Add(-500*time.Millisecond), -1.2, ue3Fill)
		sp := ue3Tick(a, at)
		if running := sp < 0; running != wantRunning {
			t.Fatalf("after %d failed readbacks: setpoint %+.3f kW, running=%v, want %v",
				i+1, sp, running, wantRunning)
		}
	}
	if c := a.State.Get().Control; c.Confirm != "not_held" {
		t.Fatalf("three mismatching cycles must read not_held, got %q", c.Confirm)
	}
	// A cycle WITHOUT an answer counts like a mismatching one once a deviation
	// stands: mismatch, silence, silence is three failed readbacks as well.
	a, t0 = ue3Running(t)
	for i, shape := range []string{ue3Fill, ue3Unconfirmed, ue3Unconfirmed} {
		at := t0.Add(time.Duration(i+1) * 5 * time.Second)
		ue3Readback(t, a, at.Add(-500*time.Millisecond), -1.2, shape)
		sp := ue3Tick(a, at)
		if running, want := sp < 0, i < 2; running != want {
			t.Fatalf("mismatch+silence, cycle %d: setpoint %+.3f kW, running=%v, want %v", i+1, sp, running, want)
		}
	}
}

// "Or 30 s": one failed readback and then nothing more - the discharge ends
// 30 s after the last cycle that held, not when the next answer happens to
// arrive.
func TestARunningDeficitCoverEndsThirtySecondsAfterTheLastHeldReadback(t *testing.T) {
	a, t0 := ue3Running(t)
	ue3Readback(t, a, t0.Add(5*time.Second), -1.2, ue3Fill)
	for _, step := range []struct {
		after   time.Duration
		running bool
	}{{10 * time.Second, true}, {20 * time.Second, true}, {30 * time.Second, true}, {31 * time.Second, false}} {
		sp := ue3Tick(a, t0.Add(step.after))
		if running := sp < 0; running != step.running {
			t.Fatalf("%s after the last held readback: setpoint %+.3f kW, running=%v, want %v",
				step.after, sp, running, step.running)
		}
	}
}

// The START stays fail-closed: one failed readback and no discharge running
// means none begins, and once a discharge has ended only a held readback lets
// the next one start.
func TestAFailedReadbackStillRefusesToStartADischarge(t *testing.T) {
	a := followAgent(t)
	t0 := ue3At("15:20:00.000")
	a.mu.Lock()
	a.currentPlan = ue3RestPlan(ue3At("15:15:00.000"))
	a.mu.Unlock()
	ue3Readback(t, a, t0.Add(-5*time.Second), 0, ue3Held)
	ue3Readback(t, a, t0, 0, ue3Fill)
	if sp := ue3Tick(a, t0); sp != 0 {
		t.Fatalf("a discharge started on a failed readback: %+.3f kW", sp)
	}
	if f := a.State.Get().Follow; f != nil {
		t.Fatalf("no correction may claim the tick: %+v", f)
	}

	// Ended by the third failed readback, then still "checking" on a fresh
	// mismatch after one held cycle would be a new start - refused; the held
	// cycle itself starts it.
	a, t0 = ue3Running(t)
	for i := 1; i <= 3; i++ {
		ue3Readback(t, a, t0.Add(time.Duration(i)*5*time.Second), -1.2, ue3Fill)
	}
	if sp := ue3Tick(a, t0.Add(16*time.Second)); sp != 0 {
		t.Fatalf("the third failed readback must end the discharge, got %+.3f kW", sp)
	}
	ue3Readback(t, a, t0.Add(20*time.Second), 0, ue3Held)
	ue3Readback(t, a, t0.Add(22*time.Second), 0, ue3Fill)
	if sp := ue3Tick(a, t0.Add(23*time.Second)); sp != 0 {
		t.Fatalf("an ended discharge restarted on a failed readback: %+.3f kW", sp)
	}
	ue3Readback(t, a, t0.Add(25*time.Second), 0, ue3Held)
	if sp := ue3Tick(a, t0.Add(26*time.Second)); sp >= 0 {
		t.Fatalf("a held readback must let the cover start again, got %+.3f kW", sp)
	}
}

// The charge side of the same rule: on a "grid ~ 0" slot whose obsolete
// planned discharge was followed down to rest, the box STARTS storing a
// measured surplus on its own authority (surplus store, idle entry). That
// charge rides out one failed readback like the discharge does - and a
// running discharge is no licence to start it.
func TestARunningSurplusStoreChargeSurvivesOneFailedReadback(t *testing.T) {
	a := followAgent(t)
	slot := ue3At("15:30:00.000")
	floor := 5.0
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		SlotMinutes: 15, ReceivedAt: slot, GeneratedAt: slot,
		EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{{
			Start: slot, BatterySetpointKw: -2.301, CoverLoadFromBattery: true,
		}},
	}
	a.mu.Unlock()
	t0 := slot.Add(8 * time.Minute)
	ue3Measure(a, t0, 7.84, 2.84)
	ue3Readback(t, a, t0, 0, ue3Held)
	a.applySetpoint(t0)
	if sp := a.State.Get().SetpointKw; math.Abs(sp-5.0) > 0.001 {
		t.Fatalf("setup: the surplus store must charge the measured 5.0 kW, got %+.3f", sp)
	}
	t1 := t0.Add(10 * time.Second)
	ue3Readback(t, a, t1.Add(-time.Second), 5.0, ue3Fill)
	ue3Measure(a, t1, 7.84, 2.84)
	a.applySetpoint(t1)
	snap := a.State.Get()
	if snap.SetpointKw <= 0 || snap.Absorb == nil {
		t.Fatalf("the running charge fell to %+.3f kW on one failed readback (absorb %+v)",
			snap.SetpointKw, snap.Absorb)
	}

	// Sun gone, house in deficit: the follower discharges on the cloud's duty.
	// Then the sun returns while the readback flickers - storing the surplus
	// would be a START of the charge side, which stays strict.
	t2 := t1.Add(10 * time.Second)
	ue3Readback(t, a, t2.Add(-time.Second), 5.0, ue3Held)
	ue3Measure(a, t2, 1.0, 3.0)
	a.applySetpoint(t2)
	if sp := a.State.Get().SetpointKw; sp >= 0 {
		t.Fatalf("setup: the follower must cover the deficit, got %+.3f", sp)
	}
	t3 := t2.Add(10 * time.Second)
	ue3Readback(t, a, t3.Add(-time.Second), -2.0, ue3Fill)
	ue3Measure(a, t3, 7.84, 2.84)
	a.applySetpoint(t3)
	if sp := a.State.Get().SetpointKw; sp != 0 {
		t.Fatalf("a charge started on a failed readback: %+.3f kW", sp)
	}
}

func TestRunningReadbackHealthyIsTheStrictRulePlusABoundedGrace(t *testing.T) {
	now := ue3At("15:20:00.000")
	window := 30 * time.Second
	held := func(age time.Duration) *state.ControlInfo {
		at := now.Add(-age)
		return &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: at, HeldAt: at}
	}
	checking := func(heldAge time.Duration, failed int) *state.ControlInfo {
		return &state.ControlInfo{
			AllMatch: true, Confirm: "checking", MismatchCycles: 1,
			CheckedAt: now.Add(-time.Second), HeldAt: now.Add(-heldAge), FailedCycles: failed,
		}
	}
	for _, c := range []struct {
		name          string
		control       *state.ControlInfo
		start, run    bool
		controlMutate func(*state.ControlInfo)
	}{
		{name: "no readback at all"},
		{name: "held and fresh", control: held(5 * time.Second), start: true, run: true},
		{name: "held but silent for longer than the window", control: held(31 * time.Second)},
		{name: "one failed cycle", control: checking(8*time.Second, 1), run: true},
		{name: "two failed cycles", control: checking(18*time.Second, 2), run: true},
		{name: "three failed cycles", control: checking(18*time.Second, 3)},
		{name: "last held cycle exactly 30 s ago", control: checking(30*time.Second, 1), run: true},
		{name: "last held cycle older than 30 s", control: checking(30*time.Second+time.Millisecond, 1)},
		{name: "never held", control: checking(0, 1),
			controlMutate: func(c *state.ControlInfo) { c.HeldAt = time.Time{} }},
		{name: "held cycle from the future", control: checking(-time.Second, 1)},
		{name: "confirmed refusal", control: checking(8*time.Second, 2),
			controlMutate: func(c *state.ControlInfo) { c.AllMatch, c.Confirm = false, "not_held" }},
		{name: "silence named", control: checking(8*time.Second, 2),
			controlMutate: func(c *state.ControlInfo) { c.Confirm = "no_answer" }},
		{name: "blocked", control: checking(8*time.Second, 1),
			controlMutate: func(c *state.ControlInfo) { c.Blocked = true }},
	} {
		if c.controlMutate != nil {
			c.controlMutate(c.control)
		}
		if got := idleReadbackHealthy(c.control, now, window); got != c.start {
			t.Errorf("%s: start (idleReadbackHealthy) = %v, want %v", c.name, got, c.start)
		}
		if got := runningReadbackHealthy(c.control, now, window); got != c.run {
			t.Errorf("%s: run (runningReadbackHealthy) = %v, want %v", c.name, got, c.run)
		}
	}
}

// The run length behind the grace is carried by the same debounce that
// carries the card's state: a held cycle resets it, every other cycle counts,
// and a blocked readback (no cycle at all) forgets it.
func TestControlConfirmCarriesTheLastHeldCycleAndTheFailedRun(t *testing.T) {
	t0 := ue3At("15:20:00.000")
	var prev *state.ControlInfo
	step := func(after time.Duration, cycle string, blocked bool) *state.ControlInfo {
		info := &state.ControlInfo{CheckedAt: t0.Add(after), Blocked: blocked}
		applyControlConfirm(info, prev, cycle)
		prev = info
		return info
	}
	if c := step(0, controlCycleMismatch, false); !c.HeldAt.IsZero() || c.FailedCycles != 1 {
		t.Fatalf("a first cycle that deviates never held: %+v", c)
	}
	if c := step(1*time.Second, controlCycleHeld, false); !c.HeldAt.Equal(t0.Add(time.Second)) || c.FailedCycles != 0 {
		t.Fatalf("held cycle: %+v", c)
	}
	step(2*time.Second, controlCycleUnconfirmed, false)
	step(3*time.Second, controlCycleMismatch, false)
	if c := step(4*time.Second, controlCycleUnconfirmed, false); !c.HeldAt.Equal(t0.Add(time.Second)) || c.FailedCycles != 3 {
		t.Fatalf("silence, mismatch, silence are three failed cycles since the held one: %+v", c)
	}
	if c := step(5*time.Second, "", true); !c.HeldAt.IsZero() || c.FailedCycles != 0 {
		t.Fatalf("a blocked readback is no cycle and carries nothing: %+v", c)
	}
	if c := step(6*time.Second, controlCycleMismatch, false); !c.HeldAt.IsZero() || c.FailedCycles != 1 {
		t.Fatalf("after a blocked readback the run starts over, never held: %+v", c)
	}
}

// ue3Registry is the test registry with the battery band of the pilot's
// 30 kW hybrid, so the plan values of the capture pass the entity guards.
func ue3Registry(t *testing.T) entities.Registry {
	t.Helper()
	var push map[string]any
	if err := json.Unmarshal(registryPush("rev-ue3", true), &push); err != nil {
		t.Fatal(err)
	}
	for _, raw := range push["entities"].([]any) {
		e := raw.(map[string]any)
		if e["entity_id"] != entBattery {
			continue
		}
		e["capabilities"].(map[string]any)["actuate"] = []any{
			map[string]any{"command": "setpoint_kw", "min": -30.0, "max": 30.0},
			map[string]any{"command": "limit_kw"},
		}
		limits := e["guards"].(map[string]any)["limits"].(map[string]any)
		limits["max_charge_kw"], limits["max_discharge_kw"] = 30.0, 30.0
	}
	out, err := json.Marshal(push)
	if err != nil {
		t.Fatal(err)
	}
	reg, skipped, err := entities.ParseRegistryPush(out,
		entities.Identity{TenantID: tTenant, SiteID: tSite, DeviceID: tDevice})
	if err != nil || len(skipped) != 0 {
		t.Fatalf("registry parse: skipped=%v err=%v", skipped, err)
	}
	return reg
}

func ue3SchedulePayload(t *testing.T, planID string, slots ...plan.Slot) []byte {
	t.Helper()
	no := false
	wire := make([]map[string]any, 0, len(slots))
	for _, s := range slots {
		wire = append(wire, map[string]any{
			"start":                     s.Start.UTC().Format(time.RFC3339),
			"battery_setpoint_kw":       s.BatterySetpointKw,
			"limit_discharge_to_load":   s.LimitDischargeToLoad,
			"charge_surplus_to_battery": s.ChargeSurplusToBattery,
		})
	}
	out, err := json.Marshal(map[string]any{
		"schema_version": "1.0", "plan_id": planID,
		"generated_at": time.Now().UTC().Format(time.RFC3339), "slot_minutes": 15,
		"grid_charge_allowed": &no, "effective_floor_soc_pct": 5.0,
		"slots": wire,
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// The plan change of 2026-10-10 17:45:07 local. The plan in force commanded
// -1.866 kW for the slot 15:45Z with the reduce right and the surplus duty,
// which the box had turned into +4.50 kW of charging (PV 7.8 kW, house
// 2.8 kW). The new plan commanded +4.922 kW for the same slot. For one second
// the box published -1.866 kW: the setpoint path read the NEW plan's flags
// (which leave a discharge alone) but still executed the plan executor's
// command for the OLD plan - the executors re-inject on their own 1 s loop,
// and onSchedule recomputes at once. The battery swung from +5.4 to -0.35 kW.
//
// The slot 15:45Z is anchored at the wall clock here because the arbiter
// keeps real time; s stands for 15:45:00Z, the arrival for 15:45:07.658Z.
func TestANewScheduleNeverExecutesTheReplacedPlansSlotValue(t *testing.T) {
	a := followAgent(t)
	a.applyEntityRegistry(ue3Registry(t))
	arrival := time.Now().UTC().Truncate(time.Second)
	s := arrival.Add(-7 * time.Second)
	floor, no := 5.0, false
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		PlanID: "plan-15:30", SlotMinutes: 15,
		ReceivedAt: s.Add(-15*time.Minute + 7*time.Second), GeneratedAt: s.Add(-15 * time.Minute),
		GridChargeAllowed: &no, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{
			{Start: s.Add(-15 * time.Minute), BatterySetpointKw: -2.301,
				LimitDischargeToLoad: true, ChargeSurplusToBattery: true},
			{Start: s, BatterySetpointKw: -1.866,
				LimitDischargeToLoad: true, ChargeSurplusToBattery: true},
		},
	}
	a.mu.Unlock()
	ue3Measure(a, arrival.Add(-2*time.Second), 7.806, 2.766)
	ue3Readback(t, a, s.Add(-1129*time.Millisecond), 4.5, ue3Held)
	ue3Readback(t, a, s.Add(870*time.Millisecond), 4.5, ue3Fill) // recorded 15:45:00.87Z

	// The last second under the plan in force: executors, then the setpoint.
	before := arrival.Add(-time.Second)
	a.runPlanExecutors(before)
	a.arb.Tick()
	a.applySetpoint(before)
	snap := a.State.Get()
	if snap.SetpointKw <= 0 || snap.Follow == nil || snap.Follow.Path != execModeLimit ||
		snap.Absorb == nil || !snap.Absorb.Active {
		t.Fatalf("setup: the old plan's -1.866 kW must be limited and the surplus stored, "+
			"got %+.3f kW follow=%+v absorb=%+v", snap.SetpointKw, snap.Follow, snap.Absorb)
	}

	// The new plan arrives; onSchedule recomputes at once.
	a.onSchedule(ue3SchedulePayload(t, "plan-15:45",
		plan.Slot{Start: s, BatterySetpointKw: 4.922, ChargeSurplusToBattery: true}))
	if got := a.State.Get().SetpointKw; got < 0 {
		t.Fatalf("the plan change published %+.3f kW - a discharge against 5.0 kW of measured surplus", got)
	}
	if got := a.State.Get().SetpointKw; math.Abs(got-4.922) > 0.2 {
		t.Fatalf("the plan change must land on the new plan's charge, got %+.3f kW", got)
	}
	// ...and the arbitration's own next second changes nothing any more.
	a.runPlanExecutors(arrival.Add(time.Second))
	a.arb.Tick()
	a.applySetpoint(arrival.Add(time.Second))
	if got := a.State.Get().SetpointKw; got < 4.9 {
		t.Fatalf("one second later: %+.3f kW", got)
	}
}

// The same staleness without a plan change: across a slot boundary the plan
// executor's command is the OLD slot's until the arbitration loop's next
// second. A recomputation inside that second (the 10 s tick, or a nudge) must
// not put the old slot's raw value under the new slot's flags either.
func TestASlotBoundaryNeverExecutesThePreviousSlotsValue(t *testing.T) {
	a := followAgent(t)
	a.applyEntityRegistry(ue3Registry(t))
	now := time.Now().UTC().Truncate(time.Second)
	boundary := now.Add(-200 * time.Millisecond)
	floor, no := 5.0, false
	a.mu.Lock()
	a.currentPlan = &plan.Plan{
		PlanID: "plan", SlotMinutes: 15,
		ReceivedAt: boundary.Add(-10 * time.Minute), GeneratedAt: boundary.Add(-10 * time.Minute),
		GridChargeAllowed: &no, EffectiveFloorSocPct: &floor,
		Slots: []plan.Slot{
			{Start: boundary.Add(-15 * time.Minute), BatterySetpointKw: -1.866,
				LimitDischargeToLoad: true, ChargeSurplusToBattery: true},
			{Start: boundary, BatterySetpointKw: 4.922, ChargeSurplusToBattery: true},
		},
	}
	a.mu.Unlock()
	ue3Measure(a, now.Add(-2*time.Second), 7.806, 2.766)
	ue3Readback(t, a, now.Add(-3*time.Second), 4.5, ue3Held)

	last := boundary.Add(-800 * time.Millisecond) // the executors' last second in the old slot
	a.runPlanExecutors(last)
	a.arb.Tick()
	a.applySetpoint(last)
	if got := a.State.Get().SetpointKw; got <= 0 {
		t.Fatalf("setup: the old slot must store the surplus, got %+.3f kW", got)
	}
	// First recomputation in the new slot, BEFORE the executors' next second.
	a.applySetpoint(now)
	if got := a.State.Get().SetpointKw; got < 0 {
		t.Fatalf("the slot boundary published the previous slot's %+.3f kW", got)
	}
	if got := a.State.Get().SlotStart; !got.Equal(boundary) {
		t.Fatalf("slot_start = %s, want the new slot %s", got, boundary)
	}
}
