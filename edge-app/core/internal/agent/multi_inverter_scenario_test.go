package agent

// K6 proof (concept vp-wechselrichter-eigenregelung-k1 §6.2-§6.4, §8 F7, F8,
// F11): Herzogau's shape through the REAL telemetry + setpoint path of the agent
// - one Deye (the leader, 30 kW battery, its own PV) and 2 × Fronius Eco 27
// (pure PV, curtailable, never part of the storage intent).
//
// The closed loop, per simulated second (0.1-s sub-steps):
//   - the DEYE: in its own mode it regulates ITS meter to grid 0 inside the
//     window (the K4b model: 0.5 s dead time, tau 0.3 s); its meter sits at the
//     connection point (sees the Fronius) or on its own branch (does not). In EMS
//     mode it follows a written setpoint like the measured Deye (5 s + tau 6 s).
//   - the FRONIUS: the plant-level pv_limit_kw minus the Deye's own PV, split to
//     the units (sunspec/curtail.js), reached after 2 s with the WMaxLimPct ramp
//     (tau 2 s).
//   - LAYER 1 (emulated as in native_window_scenario_test.go): reads every 5 s,
//     the core ticks every 10 s; a native intent with a lever is handed over.
//   - optionally the box's own Netz meter at the connection point.
//
// ⚠ Simulator and model evidence is not a hardware bench (CLAUDE.md): the pilot
// tests of E7 measure the real devices.

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// declareMeterAtGridPoint states the Pflichtangabe of K6 for a test agent: the
// selection's meter sits at the connection point, so it may lead.
func declareMeterAtGridPoint(a *Agent) {
	a.srcMu.Lock()
	a.bal.PrimaryMeterLocation = guards.MeterAtGridPoint
	a.srcMu.Unlock()
}

const (
	k6FroniusDead = 2.0 // s until a new WMaxLimPct acts
	k6FroniusTau  = 2.0 // s, the WMaxLimPct_WinTms ramp
)

type k6Scenario struct {
	seconds          int
	flags            guards.IntentFlags
	exportLimitKw    *float64 // the site's registered feed-in limit
	planPvLimitKw    *float64 // the plan curtails the slot (negative price)
	deyePv, fronius  func(t float64) float64
	load             func(t float64) float64
	socPct           float64
	meterSeesFronius bool   // the Deye's meter sits at the connection point
	netzMeter        bool   // the box has its own Netz meter there
	meterLocation    string // declared ("" = not stated)
	furtherStorage   string
	// gridZero emulates K5's Deye candidate grid_zero (1104 = 2, grid target
	// 0): in its own mode it holds ITS meter at 0 with the battery AND, once
	// the battery cannot take more, by throttling its OWN PV; the readback says
	// so (native.curtails_own_pv, native.candidate).
	gridZero bool
}

type k6Sample struct {
	t, grid, batt, fronius, pvLimit, deyeOut float64
	native, proven                           bool
	reason                                   string
}

type k6Result struct {
	samples []k6Sample
	reasons map[string]bool
	last    state.Snapshot
	hints   map[string]bool
}

func (r k6Result) from(t0 float64) []k6Sample { return r.samples[int(t0):] }

func runK6(t *testing.T, s k6Scenario) k6Result {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = nwRatedKw, nwRatedKw
	cfg.ControlEnabled = true
	cfg.ControlCertifiedFamilies = []string{"sunspec"}
	a, _ := startBusOnlyAgent(t, cfg)
	a.invMu.Lock()
	a.inv = &inverter.Selection{Family: "sunspec"}
	a.invMu.Unlock()
	a.srcMu.Lock()
	a.bal.PrimaryMeterLocation = s.meterLocation
	a.bal.FurtherStorage = s.furtherStorage
	a.srcMu.Unlock()
	netzID := ""
	if s.netzMeter {
		netzID = addNetz(t, a).ID
	}
	allowed, floor := true, nwFloorPct
	p := &plan.Plan{SlotMinutes: 15, ReceivedAt: nwStart, GeneratedAt: nwStart,
		GridChargeAllowed: &allowed, EffectiveFloorSocPct: &floor, GridExportLimitKw: s.exportLimitKw}
	for i := 0; i*900 <= s.seconds; i++ {
		sl := nwFlagsSlot(nwStart.Add(time.Duration(i)*15*time.Minute), nwSlot{flags: s.flags})
		sl.PvLimitKw = s.planPvLimitKw
		p.Slots = append(p.Slots, sl)
	}
	a.mu.Lock()
	a.currentPlan = p
	a.mu.Unlock()

	type write struct{ at, kw float64 }
	emsWrites := []write{{-1000, 0}}
	type capAt struct{ at, kw float64 }
	froniusCaps := []capAt{{-1000, math.Inf(1)}}
	selfMode := false
	var selfIntent string
	var win guards.Window
	batt, soc, fr := 0.0, s.socPct, s.fronius(0)
	deyeOut := s.deyePv(0)
	var regDev, regBatt, regPv, regSoc, regTrue float64
	lastSp := 0.0
	res := k6Result{reasons: map[string]bool{}, hints: map[string]bool{}}
	readback := func(now time.Time) {
		mode, intent := "normal", ""
		if selfMode {
			mode, intent = batteryModeNative, selfIntent
		}
		a.State.Update(func(st *state.Snapshot) {
			st.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now,
				Mode: mode, NativeIntent: intent, NativeCapabilities: nwDeviceLevers}
			if selfMode && s.gridZero {
				st.Control.NativeCurtailsOwnPv, st.Control.NativeCandidate = true, "grid_zero"
			}
		})
	}
	var lastNative *state.NativeInfo
	var lastWithheld *state.NativeWithheldInfo
	pvLimit := math.Inf(1)
	for step := 0; step <= s.seconds; step++ {
		tNow := float64(step)
		now := nwStart.Add(time.Duration(step) * time.Second)
		for sub := 1; sub <= 10; sub++ {
			ts := tNow - 1 + float64(sub)/10
			ownTarget := s.deyePv(ts)
			// Fronius: the cap written ~k6FroniusDead ago, then the ramp.
			fcap := froniusCaps[0].kw
			for _, c := range froniusCaps {
				if c.at <= ts-k6FroniusDead {
					fcap = c.kw
				}
			}
			fr += (math.Min(s.fronius(ts), fcap) - fr) * (1 - math.Exp(-0.1/k6FroniusTau))
			var target, tau float64
			if selfMode {
				d := math.Max(ts-nwSelfDead, 0)
				seen := s.deyePv(d) - s.load(d)
				if s.meterSeesFronius {
					seen += fr
				}
				target = math.Max(win.MinKw, math.Min(win.MaxKw, seen))
				tau = nwSelfTau
				if s.gridZero && seen > win.MaxKw {
					// grid target 0: what the battery cannot take, its own PV gives up
					ownTarget = math.Max(0, s.deyePv(d)-(seen-win.MaxKw))
				}
			} else {
				target = emsWrites[0].kw
				for _, w := range emsWrites {
					if w.at <= ts-deyeDeadTime {
						target = w.kw
					}
				}
				tau = deyeTau
			}
			target = math.Max(-nwRatedKw, math.Min(nwRatedKw, target))
			if soc >= 100 && target > 0 {
				target = 0
			}
			batt += (target - batt) * (1 - math.Exp(-0.1/tau))
			deyeOut += (ownTarget - deyeOut) * (1 - math.Exp(-0.1/nwSelfTau))
			soc += batt * 0.1 / 3600 / 100 * 100
		}
		grid := s.load(tNow) + batt - deyeOut - fr
		dev := grid
		if !s.meterSeesFronius {
			dev = grid + fr
		}
		if step%5 == 0 { // the Deye's register block, one consistent refresh
			regDev, regBatt, regPv, regSoc, regTrue = dev, batt, deyeOut+fr, soc, grid
		}
		if step%pollEvery == 0 {
			if netzID != "" {
				feedNetz(a, netzID, round3(regTrue))
			}
			payload, _ := json.Marshal(map[string]any{
				"ts": now.Format(time.RFC3339Nano), "power_kw": round3(regDev),
				"battery_power_kw": round3(regBatt), "pv_power_kw": round3(regPv),
				"soc_pct": math.Round(regSoc*10) / 10,
			})
			a.onLocalTelemetry("", payload)
		}
		if step%nwTickSeconds == tickOffset {
			readback(now.Add(-time.Second))
			a.mu.Lock()
			a.currentPlan.ReceivedAt = now
			a.mu.Unlock()
			a.applySetpoint(now)
			snap := a.State.Get()
			res.last = snap
			lastNative, lastWithheld = snap.Native, snap.NativeWithheld
			res.reasons[reasonOf(lastNative)] = true
			if lastWithheld != nil {
				res.reasons[lastWithheld.Reason] = true
			}
			if snap.Leader != nil && snap.Leader.Hint != "" {
				res.hints[snap.Leader.Hint] = true
			}
			// The published plant cap: the composition of the two blocks the
			// snapshot carries (composeCurtailment, most restrictive wins).
			pvLimit = math.Inf(1)
			if c := snap.CurtailTrack; c != nil {
				pvLimit = c.CapKw
			}
			if g := snap.ExportGuard; g != nil && g.CapKw != nil && *g.CapKw < pvLimit {
				pvLimit = *g.CapKw
			}
			froniusCaps = append(froniusCaps, capAt{tNow, math.Max(0, pvLimit-deyeOut)})
			n := lastNative
			if n != nil && n.Active && nwHasLever(nwDeviceLevers, n.Intent) {
				w := guards.Window{MinKw: n.WindowMinKw, MaxKw: n.WindowMaxKw}
				if n.Mode == batteryModeNative {
					w = guards.Window{MinKw: -nwRatedKw, MaxKw: nwRatedKw}
				}
				selfMode, win, selfIntent = true, w, n.Intent
			} else {
				selfMode = false
				if math.Abs(snap.SetpointKw-lastSp) > 0.005 {
					emsWrites = append(emsWrites, write{tNow, snap.SetpointKw})
					lastSp = snap.SetpointKw
				}
			}
		}
		smp := k6Sample{t: tNow, grid: grid, batt: batt, fronius: fr, pvLimit: pvLimit, deyeOut: deyeOut}
		if lastNative != nil {
			smp.native, smp.proven, smp.reason = lastNative.Active, lastNative.Proven, lastNative.Reason
		} else if lastWithheld != nil {
			smp.reason = lastWithheld.Reason
		}
		res.samples = append(res.samples, smp)
	}
	return res
}

func kwp(v float64) *float64 { return &v }

// F7 Einspeisegrenze: 30 kW at the connection point, the storage is full. At
// t=240 s a wallbox is unplugged (-10 kW house): the export jumps, and the
// feed-in watchdog - the outer loop, since the storage takes nothing more -
// brings it back to <= 30,5 kW within 20 s. The Deye stays the leader.
func TestK6F7FeedInLimitWithAFullStorage(t *testing.T) {
	res := runK6(t, k6Scenario{
		seconds: 600, flags: nwE, exportLimitKw: kwp(30),
		deyePv: func(float64) float64 { return 20 }, fronius: func(float64) float64 { return 54 },
		load: step(240, 15, 5), socPct: 100, meterSeesFronius: true, meterLocation: guards.MeterAtGridPoint,
	})
	for _, smp := range res.samples {
		export := -smp.grid
		if (smp.t >= 20 && smp.t < 240) || smp.t >= 260 {
			if export > 30.5 {
				t.Fatalf("t=%v s: export %.2f kW above 30,5 kW (F7)", smp.t, export)
			}
		}
	}
	if g := res.last.ExportGuard; g == nil || g.Cascade != guards.CascadeOuter {
		t.Fatalf("a full storage leaves the watchdog in charge: %+v", res.last.ExportGuard)
	}
	if !res.samples[500].native {
		t.Fatalf("the Deye stays the leader in its own mode: %+v", res.samples[500])
	}
}

// F8 Negativpreis: the plan curtails the slot and the Deye stores the surplus
// itself (E↑). The slot becomes "Einspeisegrenze 0 kW" for the cascade: the
// battery charges at its ceiling first, then the Fronius are throttled to
// export 0 ± 0,5 kW - and the two loops do not swing against each other.
func TestK6F8NegativePriceChargesFullyAndThrottlesTheFronius(t *testing.T) {
	res := runK6(t, k6Scenario{
		seconds: 900, flags: nwEUp, planPvLimitKw: kwp(25), exportLimitKw: kwp(30),
		deyePv: func(float64) float64 { return 20 }, fronius: func(float64) float64 { return 54 },
		load: func(float64) float64 { return 5 }, socPct: 50, meterSeesFronius: true,
		meterLocation: guards.MeterAtGridPoint,
	})
	reversals, dir := 0, 0.0
	prev := math.NaN()
	for _, smp := range res.from(300) {
		if smp.grid > 0.5 || smp.grid < -0.5 {
			t.Fatalf("t=%v s: grid %.2f kW outside 0 ± 0,5 kW (F8)", smp.t, smp.grid)
		}
		if smp.batt < nwRatedKw-1 {
			t.Fatalf("t=%v s: the storage must charge at its ceiling, got %.2f kW", smp.t, smp.batt)
		}
		if smp.fronius > 54-10 {
			t.Fatalf("t=%v s: the Fronius must be throttled, got %.2f kW", smp.t, smp.fronius)
		}
		if !math.IsNaN(prev) && math.Abs(smp.pvLimit-prev) > 1e-9 {
			d := smp.pvLimit - prev
			if dir != 0 && math.Signbit(d) != math.Signbit(dir) {
				reversals++
			}
			dir = d
		}
		prev = smp.pvLimit
	}
	if reversals > 6 {
		t.Fatalf("inner and outer loop swing: %d cap reversals in 600 s", reversals)
	}
	if c := res.last.CurtailTrack; c == nil || !strings.Contains(c.Reason, "Negativer Preis") {
		t.Fatalf("the curtailment block must say what the slot does: %+v", c)
	}
	// The site's compliance watchdog keeps meaning the registered 30 kW.
	if g := res.last.ExportGuard; g == nil || g.LimitKw != 30 {
		t.Fatalf("the heartbeat's feed-in block keeps the registered limit: %+v", g)
	}
}

// K5's grid_zero as the inner loop, negative price: the Deye holds its meter
// at 0 with the battery and, once the battery is at its ceiling, with its own
// PV. The cascade knows it as the inner loop (proven E↑), the watchdog throttles
// the Fronius only for what the Deye cannot hold, and the two do not swing -
// no take-back either, because this slot asks for curtailment.
func TestK6GridZeroIsTheInnerLoopAtANegativePrice(t *testing.T) {
	res := runK6(t, k6Scenario{
		seconds: 900, flags: nwEUp, planPvLimitKw: kwp(25), exportLimitKw: kwp(30),
		deyePv: func(float64) float64 { return 20 }, fronius: func(float64) float64 { return 54 },
		load: func(float64) float64 { return 5 }, socPct: 50, meterSeesFronius: true,
		meterLocation: guards.MeterAtGridPoint, gridZero: true,
	})
	reversals, dir := 0, 0.0
	prev := math.NaN()
	for _, smp := range res.from(300) {
		if smp.grid > 0.5 || smp.grid < -0.5 {
			t.Fatalf("t=%v s: grid %.2f kW outside 0 ± 0,5 kW", smp.t, smp.grid)
		}
		if smp.batt < nwRatedKw-1 {
			t.Fatalf("t=%v s: the storage must charge at its ceiling, got %.2f kW", smp.t, smp.batt)
		}
		if !smp.proven {
			t.Fatalf("t=%v s: a curtailing slot keeps grid_zero (reason %q)", smp.t, smp.reason)
		}
		if !math.IsNaN(prev) && math.Abs(smp.pvLimit-prev) > 1e-9 {
			d := smp.pvLimit - prev
			if dir != 0 && math.Signbit(d) != math.Signbit(dir) {
				reversals++
			}
			dir = d
		}
		prev = smp.pvLimit
	}
	if reversals > 6 {
		t.Fatalf("grid_zero and the watchdog swing: %d cap reversals in 600 s", reversals)
	}
	if res.reasons[guards.NativeOwnPvCurtailed] {
		t.Fatalf("a slot that asks for curtailment must not take grid_zero back: %v", res.reasons)
	}
}

// K5's grid_zero at a POSITIVE price with the registered 30 kW limit: near
// the SoC ceiling it would throttle its own PV for nothing, so K5 takes it
// back (pv_abgeregelt) - and from then on the watchdog alone holds the limit.
func TestK6GridZeroAtAPositivePriceHandsTheLimitToTheWatchdog(t *testing.T) {
	res := runK6(t, k6Scenario{
		seconds: 600, flags: nwEUp, exportLimitKw: kwp(30),
		deyePv: func(float64) float64 { return 20 }, fronius: func(float64) float64 { return 54 },
		load: func(float64) float64 { return 5 }, socPct: 93, meterSeesFronius: true,
		meterLocation: guards.MeterAtGridPoint, gridZero: true,
	})
	if !res.reasons[guards.NativeOwnPvCurtailed] {
		t.Fatalf("near the ceiling at a positive price grid_zero must be taken back, reasons %v", res.reasons)
	}
	for _, smp := range res.from(60) {
		if -smp.grid > 30.5 {
			t.Fatalf("t=%v s: export %.2f kW above the registered 30 kW", smp.t, -smp.grid)
		}
	}
}

// F11 Fremd-PV, the meter at the connection point: the Deye sees the Fronius'
// feed-in and stores it - export <= 0,5 kW while it has room - and the box's own
// Netz meter confirms the location (passt).
func TestK6F11ForeignPvIsStoredWhenTheMeterSitsAtTheGridPoint(t *testing.T) {
	res := runK6(t, k6Scenario{
		seconds: 400, flags: nwEUp,
		deyePv: func(float64) float64 { return 2 }, fronius: func(float64) float64 { return 20 },
		load: func(float64) float64 { return 5 }, socPct: 50, meterSeesFronius: true, netzMeter: true,
		meterLocation: guards.MeterAtGridPoint,
	})
	for _, smp := range res.from(60) {
		if -smp.grid > 0.5 {
			t.Fatalf("t=%v s: export %.2f kW - the leader must store the Fronius surplus (F11)", smp.t, -smp.grid)
		}
	}
	l := res.last.Leader
	if l == nil || !l.Leads || l.Plausibility != guards.MeterPlausibilityOK {
		t.Fatalf("the Netz meter must confirm the leader's meter: %+v", l)
	}
}

// F11 Fremd-PV, the meter on the Deye's own branch although "am Netzpunkt" was
// declared: the Deye does not see the Fronius and stores nothing. The box's
// Netz meter disagrees persistently, the lever is taken back (zaehler_unplausibel)
// and the box regulates; the export-with-headroom symptom points at the meter.
func TestK6F11AMeterThatMissesTheForeignPvIsCaught(t *testing.T) {
	res := runK6(t, k6Scenario{
		seconds: 400, flags: nwEUp,
		deyePv: func(float64) float64 { return 2 }, fronius: func(float64) float64 { return 20 },
		load: func(float64) float64 { return 5 }, socPct: 50, meterSeesFronius: false, netzMeter: true,
		meterLocation: guards.MeterAtGridPoint,
	})
	if !res.reasons[guards.NativeMeterImplausible] {
		t.Fatalf("the meter comparison must veto the declaration, reasons %v", res.reasons)
	}
	if !res.hints[guards.LeaderHintCheckMeter] {
		t.Fatalf("the export-with-headroom symptom must point at the meter, hints %v", res.hints)
	}
	if res.samples[len(res.samples)-1].native {
		t.Fatalf("a leader whose meter misses the connection point must not keep regulating")
	}
	// Without a Netz meter the box's grid reading IS the device's meter: the
	// fault is invisible to the box (it sees the Deye's +3 kW, not the 15 kW
	// export), so no measured symptom can ever fire - which is exactly why the
	// leader block names the guided one-time test.
	blind := runK6(t, k6Scenario{
		seconds: 200, flags: nwEUp,
		deyePv: func(float64) float64 { return 2 }, fronius: func(float64) float64 { return 20 },
		load: func(float64) float64 { return 5 }, socPct: 50, meterSeesFronius: false,
		meterLocation: guards.MeterAtGridPoint,
	})
	if !blind.hints[guards.LeaderHintOneTimeTest] || blind.hints[guards.LeaderHintCheckMeter] {
		t.Fatalf("without a Netz meter the box can only name the one-time test: %v", blind.hints)
	}
}

// Two storages at one connection point: only one regulates itself. A second
// storage that runs its own self-consumption on the same meter keeps the
// leader on the box's setpoint path; a follower (master/slave) does not.
func TestK6TwoStoragesAtOneGridPointOnlyOneRegulatesItself(t *testing.T) {
	base := k6Scenario{
		seconds: 120, flags: nwEUp,
		deyePv: func(float64) float64 { return 10 }, fronius: func(float64) float64 { return 0 },
		load: func(float64) float64 { return 5 }, socPct: 50, meterSeesFronius: true,
		meterLocation: guards.MeterAtGridPoint,
	}
	second := base
	second.furtherStorage = guards.FurtherStorageSelfRegulating
	res := runK6(t, second)
	for _, smp := range res.samples {
		if smp.native {
			t.Fatalf("t=%v s: a second regulator at the grid point, yet the leader regulates itself", smp.t)
		}
	}
	if !res.reasons[guards.NativeSecondRegulator] {
		t.Fatalf("the refusal must name the second regulator, reasons %v", res.reasons)
	}
	follower := base
	follower.furtherStorage = guards.FurtherStorageFollower
	if res := runK6(t, follower); !res.samples[100].proven {
		t.Fatalf("a follower (master/slave) leaves the leader its own regulation: %+v", res.samples[100])
	}
	unstated := base
	unstated.meterLocation = ""
	res = runK6(t, unstated)
	if !res.reasons[guards.NativeMeterLocationMissing] || res.samples[100].native {
		t.Fatalf("without the Pflichtangabe the device does not regulate itself, reasons %v", res.reasons)
	}
}

// Reine PV-Wechselrichter gehören nicht zur Speicher-Absicht: the Fronius are
// read-only sources and curtailment actuators - the published setpoint carries
// the storage intent for the selection only, the Fronius get a plant cap.
func TestK6PurePvInvertersStayActuatorsOfTheCurtailment(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, addr := startBusOnlyAgent(t, cfg)
	sub := subscribeSetpoint(t, addr)
	fr := addFronius(t, a, 1, 27)
	a.curtailMu.Lock()
	a.curtailCert[curtailUnitKey(fr.Connection)] = true
	a.curtailMu.Unlock()
	now := time.Now().UTC()
	limit := 30.0
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, nil, &limit)
	a.mu.Unlock()
	observe(a, now, -45, 60)
	a.applySetpoint(now)
	waitFor(t, 5*time.Second, "setpoint with a plant cap", func() bool {
		m, ok := sub.latest()
		if !ok {
			return false
		}
		_, has := m["pv_limit_kw"]
		return has
	})
	m, _ := sub.latest()
	cur, ok := m["curtail"].(map[string]any)
	if !ok {
		t.Fatalf("the Fronius must stay curtailment actuators: %v", m)
	}
	for _, e := range cur["sources"].([]any) {
		entry := e.(map[string]any)
		for _, k := range []string{"battery_native_intent", "battery_window_min_kw", "battery_mode"} {
			if _, has := entry[k]; has {
				t.Fatalf("a pure PV inverter must never carry the storage intent: %v", entry)
			}
		}
	}
}

// F9 on the box side: Herzogau as configured today - a 30 kW limit, 54 kWp of
// Fronius, the Deye's own cap read at 33 kW, nothing declared. The feed-in block
// warns that the limit does not survive the box; a declared backstop clears it.
func TestK6F9TheBoxWarnsWhenTheLimitHasNoDeviceSideBackstop(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	a, _ := startBusOnlyAgent(t, cfg)
	addFronius(t, a, 1, 27)
	addFronius(t, a, 2, 27)
	declareMeterAtGridPoint(a)
	a.State.Update(func(s *state.Snapshot) {
		s.DeviceExportLimit = &state.DeviceExportLimitInfo{LimitKw: 33, Register: "0x00e7", ReadAt: time.Now()}
	})
	now := time.Now().UTC()
	limit := 30.0
	a.mu.Lock()
	a.currentPlan = exportPlan(now, 0, nil, &limit)
	a.mu.Unlock()
	observe(a, now, -20, 40)
	a.applySetpoint(now)
	g := a.State.Get().ExportGuard
	if g == nil || g.BackstopCovered || !strings.Contains(g.Backstop, "hält nur die Box") ||
		!strings.Contains(g.Backstop, "33,0 kW") {
		t.Fatalf("Herzogau today must be warned: %+v", g)
	}
	bal := a.GetBalance()
	bal.ExportBackstop = guards.ExportBackstopPresent
	if _, err := a.SetBalance(bal); err != nil {
		t.Fatal(err)
	}
	a.applySetpoint(now.Add(10 * time.Second))
	if g := a.State.Get().ExportGuard; g == nil || !g.BackstopCovered || g.BackstopSource != guards.BackstopDeclared {
		t.Fatalf("a declared backstop clears the warning: %+v", g)
	}
}
