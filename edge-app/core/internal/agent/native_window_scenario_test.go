package agent

// K4b proof (concept vp-wechselrichter-eigenregelung-k1 §8): the prüffälle F1-F6,
// F10 and F12, each run TWICE through the REAL telemetry + setpoint path of the
// agent - once on the way "Gerät regelt" (Layer 1 reports and proves a certified
// lever, the device regulates inside the window) and once on the fallback
// "Box gedämpft" (Layer 1 reports no lever for the intent, the box's in-slot
// rules plus guards.FollowDamper carry the slot, E2 A).
//
// The closed loop, per simulated second:
//   - the DEVICE: in EMS mode it follows a written setpoint like the measured
//     Deye (5 s dead time + first-order lag tau = 6 s, i.e. 15-20 s to settle,
//     K1's model); in its OWN mode it regulates its own meter to grid 0 inside
//     the window with 0.5 s dead time + tau = 0.3 s - the assumption "well
//     under a second" of the native mode, which the pilot has to measure (E7).
//     Its registers refresh every measPeriod seconds (Deye: 5-25 s).
//   - LAYER 1 (emulated, the edge-app/nodered contract): Node-RED reads every 5 s,
//     the core ticks every 10 s. After a tick, a native intent for which the
//     device has a lever is handed over ONCE (mode switch + window); anything
//     else writes the published setpoint. Its readback for the next tick carries
//     mode/native.intent/native_capabilities exactly as the flows do.
//
// ⚠ Simulator and model evidence is not a hardware bench (CLAUDE.md). F7-F9 and
// F11 need the real device and stay open for K5/K6.

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const (
	nwRatedKw     = 30.0 // Herzogau: SUN-30K
	nwSelfDead    = 0.5  // s, the device's own loop: "well under a second"
	nwSelfTau     = 0.3  // s   (native mode doc; to be measured at the pilot, F1/F2)
	nwFloorPct    = 20.0
	nwTickSeconds = 10
)

var nwStart = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

// Levers of the two paths.
var (
	nwDeviceLevers = &state.NativeCapabilities{Intents: []string{
		guards.NativeIntentCoverLoad, guards.NativeIntentSurplusCharge, guards.NativeIntentSelfConsumption,
	}, Window: true}
	nwNoLevers = &state.NativeCapabilities{Intents: []string{}}
)

type nwSlot struct {
	planned float64
	flags   guards.IntentFlags
}

type nwScenario struct {
	seconds           int
	slots             []nwSlot // consecutive 15-min slots from nwStart
	pv, load          func(t float64) float64
	socPct, capKwh    float64
	eeg               bool
	levers            *state.NativeCapabilities
	gridChargeBlocked *bool
	measPeriod        float64
	// neverConfirm emulates a Layer 1 that predates K4b: it treats
	// "native_window" as the ordinary setpoint path and never confirms it.
	neverConfirm bool
}

type nwSample struct {
	t, grid, batt, soc, sp float64
	native, proven         bool
	reason, intent         string
}

type nwResult struct {
	samples []nwSample
	writes  int // device writes: setpoints + mode/window changes
	reasons map[string]bool
}

func nwFlagsSlot(start time.Time, s nwSlot) plan.Slot {
	return plan.Slot{
		Start: start, BatterySetpointKw: s.planned,
		ChargeFromSurplusOnly:  s.flags.ChargeFromSurplusOnly,
		ChargeSurplusToBattery: s.flags.ChargeSurplusToBattery,
		CoverLoadFromBattery:   s.flags.CoverLoadFromBattery,
		LimitDischargeToLoad:   s.flags.LimitDischargeToLoad,
		UnplannedLoadDischarge: s.flags.UnplannedLoadDischarge,
	}
}

func runNativeWindow(t *testing.T, s nwScenario) nwResult {
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
	allowed, floor := !s.eeg, nwFloorPct
	p := &plan.Plan{SlotMinutes: 15, ReceivedAt: nwStart, GeneratedAt: nwStart,
		GridChargeAllowed: &allowed, EffectiveFloorSocPct: &floor}
	for i, sl := range s.slots {
		p.Slots = append(p.Slots, nwFlagsSlot(nwStart.Add(time.Duration(i)*15*time.Minute), sl))
	}
	a.mu.Lock()
	a.currentPlan = p
	a.mu.Unlock()

	if s.measPeriod <= 0 {
		s.measPeriod = 10
	}
	if s.capKwh <= 0 {
		s.capKwh = 100
	}
	type write struct{ at, kw float64 }
	emsWrites := []write{{-1000, 0}}
	selfMode := false
	var selfIntent string
	var win guards.Window
	batt, soc := 0.0, s.socPct
	regGrid, regBatt, regPv, regSoc := 0.0, 0.0, s.pv(0), soc
	lastSp := 0.0
	nextRefresh := 0.0
	res := nwResult{reasons: map[string]bool{}}
	readback := func(now time.Time) {
		mode := "normal"
		intent := ""
		if selfMode {
			mode, intent = batteryModeNative, selfIntent
		}
		gcb := s.gridChargeBlocked
		a.State.Update(func(st *state.Snapshot) {
			st.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now,
				Mode: mode, NativeIntent: intent, NativeCapabilities: s.levers,
				NativeGridChargeBlocked: gcb, NativePreconditionGridChargeBlocked: gcb}
		})
	}
	var lastNative *state.NativeInfo
	var lastWithheld *state.NativeWithheldInfo
	for step := 0; step <= s.seconds; step++ {
		tNow := float64(step)
		now := nwStart.Add(time.Duration(step) * time.Second)
		pv, load := s.pv(tNow), s.load(tNow)
		// --- device physics, in 0.1-s sub-steps ---
		for sub := 1; sub <= 10; sub++ {
			ts := tNow - 1 + float64(sub)/10
			var target, tau float64
			if selfMode {
				// its own loop acts on its own meter, nwSelfDead late
				d := math.Max(ts-nwSelfDead, 0)
				target = math.Max(win.MinKw, math.Min(win.MaxKw, s.pv(d)-s.load(d)))
				tau = nwSelfTau
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
			if soc <= 0 && target < 0 {
				target = 0
			}
			batt += (target - batt) * (1 - math.Exp(-0.1/tau))
			soc += batt * 0.1 / 3600 / s.capKwh * 100
		}
		grid := load + batt - pv
		// --- device registers (one consistent block) ---
		if tNow >= nextRefresh {
			regGrid, regBatt, regPv, regSoc = grid, batt, pv, soc
			nextRefresh = tNow + s.measPeriod
		}
		// --- Layer 1 read -> core telemetry ---
		if step%pollEvery == 0 {
			payload, _ := json.Marshal(map[string]any{
				"ts": now.Format(time.RFC3339Nano), "power_kw": round3(regGrid),
				"battery_power_kw": round3(regBatt), "pv_power_kw": round3(regPv),
				"soc_pct": math.Round(regSoc*10) / 10,
			})
			a.onLocalTelemetry("", payload)
		}
		// --- core tick, then Layer 1 executes it ---
		if step%nwTickSeconds == tickOffset {
			readback(now.Add(-time.Second))
			a.mu.Lock()
			a.currentPlan.ReceivedAt = now // the cloud republishes; a stale plan is its own test
			a.mu.Unlock()
			a.applySetpoint(now)
			snap := a.State.Get()
			n := snap.Native
			lastNative = n
			lastWithheld = snap.NativeWithheld
			res.reasons[reasonOf(n)] = true
			if w := snap.NativeWithheld; w != nil {
				res.reasons[w.Reason] = true
			}
			wantSelf := n != nil && n.Active && nwHasLever(s.levers, n.Intent) &&
				!(s.neverConfirm && n.Mode != batteryModeNative)
			if wantSelf {
				w := guards.Window{MinKw: n.WindowMinKw, MaxKw: n.WindowMaxKw}
				if n.Mode == batteryModeNative { // E↓ primitive: the sim's full self-consumption
					w = guards.Window{MinKw: -nwRatedKw, MaxKw: nwRatedKw}
				}
				if !selfMode || w != win || n.Intent != selfIntent {
					res.writes++
				}
				selfMode, win, selfIntent = true, w, n.Intent
			} else {
				if selfMode {
					res.writes++ // hand back: EMS control asserted again
					selfMode = false
				}
				if math.Abs(snap.SetpointKw-lastSp) > 0.005 {
					emsWrites = append(emsWrites, write{tNow, snap.SetpointKw})
					lastSp = snap.SetpointKw
					res.writes++
				}
			}
		}
		smp := nwSample{t: tNow, grid: grid, batt: batt, soc: soc, sp: lastSp}
		if lastNative != nil {
			smp.native, smp.proven, smp.intent = lastNative.Active, lastNative.Proven, lastNative.Intent
			smp.reason = lastNative.Reason
		} else if lastWithheld != nil {
			smp.reason = lastWithheld.Reason
		}
		res.samples = append(res.samples, smp)
	}
	return res
}

func reasonOf(n *state.NativeInfo) string {
	if n == nil {
		return ""
	}
	return n.Reason
}

func nwHasLever(c *state.NativeCapabilities, intent string) bool {
	if c == nil {
		return false
	}
	for _, v := range c.Intents {
		if v == intent {
			return true
		}
	}
	return false
}

// longestRun is the longest continuous stretch (s) in [from, to) where cond holds.
func (r nwResult) longestRun(from, to float64, cond func(nwSample) bool) float64 {
	best, cur := 0.0, 0.0
	for _, s := range r.samples {
		if s.t < from || s.t >= to {
			continue
		}
		if cond(s) {
			cur++
			best = math.Max(best, cur)
		} else {
			cur = 0
		}
	}
	return best
}

// episodes counts separate stretches where cond holds.
func (r nwResult) episodes(from, to float64, cond func(nwSample) bool) int {
	n, in := 0, false
	for _, s := range r.samples {
		if s.t < from || s.t >= to {
			continue
		}
		if cond(s) && !in {
			n++
		}
		in = cond(s)
	}
	return n
}

func (r nwResult) at(t float64) nwSample { return r.samples[int(t)] }

var (
	nwEUp   = guards.IntentFlags{ChargeFromSurplusOnly: true, ChargeSurplusToBattery: true}
	nwE     = guards.IntentFlags{ChargeFromSurplusOnly: true, ChargeSurplusToBattery: true, CoverLoadFromBattery: true}
	nwEDown = guards.IntentFlags{CoverLoadFromBattery: true}
)

func step(t0, before, after float64) func(float64) float64 {
	return func(t float64) float64 {
		if t < t0 {
			return before
		}
		return after
	}
}

// ramp moves from `before` to `after` linearly over [t0, t0+dur].
func ramp(t0, dur, before, after float64) func(float64) float64 {
	return func(t float64) float64 {
		switch {
		case t <= t0:
			return before
		case t >= t0+dur:
			return after
		default:
			return before + (after-before)*(t-t0)/dur
		}
	}
}

type nwPath struct {
	name   string
	levers *state.NativeCapabilities
}

var nwPaths = []nwPath{{"geraet", nwDeviceLevers}, {"gedaempft", nwNoLevers}}

// F1 Wolkenkante: PV falls 16 kW within 20 s in E↑. The import that matters is
// the battery charging from the grid while it has not yet come down.
func TestNativeWindowF1CloudEdge(t *testing.T) {
	for _, path := range nwPaths {
		for _, meas := range []float64{5, 25} {
			t.Run(fmt.Sprintf("%s/messtakt-%.0fs", path.name, meas), func(t *testing.T) {
				r := runNativeWindow(t, nwScenario{
					seconds: 600, slots: []nwSlot{{planned: 20, flags: nwEUp}},
					pv: ramp(300, 20, 26, 10), load: step(0, 4, 4), socPct: 50,
					levers: path.levers, measPeriod: meas,
				})
				imp := func(s nwSample) bool { return s.grid > 1 }
				secs := r.longestRun(300, 600, imp)
				eps := r.episodes(300, 600, imp)
				t.Logf("F1 %s messtakt %.0f s: Bezug > 1 kW %0.f s am Stück, %d Episoden, Schreibvorgänge %d",
					path.name, meas, secs, eps, r.writes)
				// The fallback cannot reach the §8 limit of 20 s at Deye timing: the
				// edge has to be MEASURED (register cadence 5-25 s), read (5 s),
				// ticked (10 s), and the written value takes the device 15-20 s -
				// the physics K1 documented ("erzwungenes Nachlaufen") and the reason
				// the device path exists. Pinned as a regression bound, reported in
				// the PR as a gap of the fallback, not hidden.
				limit := 60.0
				if path.name == "geraet" {
					limit = 5
					if !r.at(290).proven || r.at(290).intent != guards.NativeIntentSurplusCharge {
						t.Fatalf("the device must regulate E↑ before the edge: %+v", r.at(290))
					}
				} else if r.at(290).native {
					t.Fatalf("without a lever the box keeps the slot: %+v", r.at(290))
				}
				if secs > limit || eps > 2 {
					t.Fatalf("F1: import > 1 kW for %.0f s (limit %.0f s), %d episodes (<= 1 overshoot)", secs, limit, eps)
				}
			})
		}
	}
}

// F2 Wolkenlücke: PV rises 16 kW within 20 s in E↑, SoC far below 95 %.
func TestNativeWindowF2CloudGap(t *testing.T) {
	for _, path := range nwPaths {
		t.Run(path.name, func(t *testing.T) {
			r := runNativeWindow(t, nwScenario{
				seconds: 600, slots: []nwSlot{{planned: 6, flags: nwEUp}},
				pv: ramp(300, 20, 10, 26), load: step(0, 4, 4), socPct: 50,
				levers: path.levers, measPeriod: 10,
			})
			secs := r.longestRun(300, 600, func(s nwSample) bool { return s.grid < -1 })
			t.Logf("F2 %s: Einspeisung > 1 kW %.0f s am Stück, Schreibvorgänge %d", path.name, secs, r.writes)
			if path.name == "geraet" && secs > 5 {
				t.Fatalf("F2: export > 1 kW for %.0f s (limit 5 s)", secs)
			}
			// The damped box raises a charge in steps of <= 3 kW per settled pair
			// on purpose (E2 A: export is the cheap side) - the §8 limit of 5 s is
			// not reachable on the fallback, which is exactly why the device path
			// exists. Pinned so a regression towards the old limit cycle shows.
			if path.name == "gedaempft" && (secs <= 5 || secs > 240) {
				t.Fatalf("F2 fallback: export > 1 kW for %.0f s - expected the documented ramp (5 s < x <= 240 s)", secs)
			}
		})
	}
}

// F3 Lastsprung: +10 kW house in E.
func TestNativeWindowF3LoadStep(t *testing.T) {
	for _, path := range nwPaths {
		t.Run(path.name, func(t *testing.T) {
			r := runNativeWindow(t, nwScenario{
				seconds: 600, slots: []nwSlot{{planned: -2, flags: nwE}},
				pv: step(0, 1, 1), load: step(300, 3, 13), socPct: 60,
				levers: path.levers, measPeriod: 10,
			})
			covered := r.longestRun(300, 600, func(s nwSample) bool { return s.grid > 0.5 })
			peak := r.longestRun(300, 600, func(s nwSample) bool { return s.grid > 3 })
			t.Logf("F3 %s: Bezug > 0,5 kW %.0f s, Netzspitze > 3 kW %.0f s", path.name, covered, peak)
			if path.name == "geraet" && covered > 2 {
				t.Fatalf("F3: not covered within 2 s (%.0f s)", covered)
			}
			// §8 wants <= 10 s for the box; with a 15-20 s follow time of the
			// device alone that is physically out of reach (see F1) - regression
			// bound, reported as a gap of the fallback.
			if path.name == "gedaempft" && peak > 60 {
				t.Fatalf("F3 fallback: grid peak > 3 kW for %.0f s", peak)
			}
		})
	}
}

// F4 Lastabwurf: -10 kW house in E↓ - the battery may not feed the grid.
func TestNativeWindowF4LoadDrop(t *testing.T) {
	for _, path := range nwPaths {
		t.Run(path.name, func(t *testing.T) {
			r := runNativeWindow(t, nwScenario{
				seconds: 600, slots: []nwSlot{{planned: -10, flags: nwEDown}},
				pv: step(0, 0, 0), load: step(300, 12, 2), socPct: 60,
				levers: path.levers, measPeriod: 10,
			})
			secs := r.longestRun(300, 600, func(s nwSample) bool { return s.batt < -0.2 && s.grid < -0.2 })
			t.Logf("F4 %s: Speicher-Einspeisung > 0,2 kW %.0f s", path.name, secs)
			if path.name == "geraet" && secs > 5 {
				t.Fatalf("F4: battery export for %.0f s (limit 5 s)", secs)
			}
			if path.name == "gedaempft" && secs > 40 {
				t.Fatalf("F4 fallback: battery export for %.0f s", secs)
			}
		})
	}
}

// F5 Verkauf nach Eigenverbrauch: slot change E -> A (-30 kW).
func TestNativeWindowF5SellAfterSelfConsumption(t *testing.T) {
	for _, path := range nwPaths {
		t.Run(path.name, func(t *testing.T) {
			r := runNativeWindow(t, nwScenario{
				seconds: 900 + 120, slots: []nwSlot{{planned: 2, flags: nwE}, {planned: -30}},
				pv: step(0, 6, 6), load: step(0, 3, 3), socPct: 80,
				levers: path.levers, measPeriod: 10,
			})
			first := 900 + tickOffset
			if sp := r.at(float64(first)).sp; math.Abs(sp+30) > 0.01 {
				t.Fatalf("F5: the first tick of the sell slot must command -30 kW, got %.3f", sp)
			}
			if r.at(float64(first)).native {
				t.Fatal("F5: a point window is a setpoint - the device must be taken back at the boundary")
			}
			after := r.at(float64(first) + 30)
			over := 0.0
			for _, s := range r.samples[900:] {
				over = math.Max(over, -30-s.batt)
			}
			t.Logf("F5 %s: Batterie 30 s nach dem ersten Takt %.2f kW, Überschwingen %.2f kW", path.name, after.batt, over)
			if math.Abs(after.batt+30) > 0.5 || over > 3 {
				t.Fatalf("F5: %.2f kW after 30 s (want -30 +- 0,5), overshoot %.2f", after.batt, over)
			}
		})
	}
}

// F6 Netzladen: a point N at a non-EEG site is a setpoint; at an EEG site the
// box never charges from the grid - on the setpoint path through the EEG clamp,
// on the device path only with the device's own grid-charge block PROVEN.
func TestNativeWindowF6GridCharge(t *testing.T) {
	r := runNativeWindow(t, nwScenario{
		seconds: 300, slots: []nwSlot{{planned: 10}}, pv: step(0, 0, 0), load: step(0, 2, 2),
		socPct: 30, levers: nwDeviceLevers, measPeriod: 10,
	})
	if b := r.at(200).batt; math.Abs(b-10) > 0.5 || r.at(200).native {
		t.Fatalf("F6 N at a non-EEG site: %.2f kW, native=%v", b, r.at(200).native)
	}
	eeg := runNativeWindow(t, nwScenario{
		seconds: 300, slots: []nwSlot{{planned: 10}}, pv: step(0, 1.5, 1.5), load: step(0, 2, 2),
		socPct: 30, eeg: true, levers: nwDeviceLevers, measPeriod: 10,
	})
	// EEG = never charge beyond the MEASURED PV (the house may import in
	// parallel - FK3 PV-bus semantics, guards.Clamp stage 4).
	for _, s := range eeg.samples[60:] {
		if s.batt > 1.5+0.05 {
			t.Fatalf("F6 EEG: charged beyond the PV at t=%.0f: batt %.2f", s.t, s.batt)
		}
	}
	for _, blocked := range []*bool{boolPtr(true), boolPtr(false)} {
		dev := runNativeWindow(t, nwScenario{
			seconds: 300, slots: []nwSlot{{planned: 5, flags: nwEUp}}, pv: step(0, 1.5, 1.5), load: step(0, 3, 3),
			socPct: 30, eeg: true, levers: nwDeviceLevers, gridChargeBlocked: blocked, measPeriod: 10,
		})
		for _, s := range dev.samples[30:] {
			if s.batt > 1.5+0.05 {
				t.Fatalf("F6 EEG device path: charged beyond the PV at t=%.0f: %.2f", s.t, s.batt)
			}
		}
		if *blocked && !dev.at(250).proven {
			t.Fatalf("F6: a device that PROVES its grid-charge block may regulate: %+v", dev.at(250))
		}
		if !*blocked && (dev.at(250).native || !dev.reasons[guards.NativeGridChargeUnproven]) {
			t.Fatalf("F6: a device that may grid-charge is taken back (netzladen_am_geraet): %+v %v", dev.at(250), dev.reasons)
		}
	}
	t.Logf("F6: N-Punkt 10 kW gehalten, EEG-Punkt auf PV gekappt, Geräteweg nur mit Beleg")
}

// F10 Reserve: in E the SoC reaches the floor; the take-back names its cause,
// the discharge ends, and the take-back holds until the slot ends.
func TestNativeWindowF10Reserve(t *testing.T) {
	for _, path := range nwPaths {
		t.Run(path.name, func(t *testing.T) {
			r := runNativeWindow(t, nwScenario{
				seconds: 1200, slots: []nwSlot{{planned: 0, flags: nwE}, {planned: 0, flags: nwE}},
				pv: step(0, 0, 0), load: step(0, 10, 10), socPct: nwFloorPct + 6, capKwh: 10,
				levers: path.levers, measPeriod: 10,
			})
			if path.name == "geraet" {
				if !r.reasons[guards.NativeFloorReached] {
					t.Fatalf("F10: the take-back must name reserve_boden: %v", r.reasons)
				}
				if s := r.at(890); s.native || s.reason != guards.NativeFloorReached {
					t.Fatalf("F10: latched until slot end: %+v", s)
				}
			}
			end := r.at(880)
			t.Logf("F10 %s: SoC am Slotende %.1f %%, Batterie %.2f kW", path.name, end.soc, end.batt)
			// 1 %-point of the 10-kWh test battery is 36 s at 10 kW: the fallback's
			// tick + 15-20 s follow time may overrun the floor by less than that.
			if end.soc < nwFloorPct-1 || end.batt < -0.2 {
				t.Fatalf("F10: the discharge must end at the floor: soc %.1f batt %.2f", end.soc, end.batt)
			}
		})
	}
}

// F12 Schreibbudget: a day of changing intents (here two hours: E↑, sell, E↑,
// E, hold ...) - the device path writes once per intent change, the box path
// writes whenever its value moves. Counted, reported per hour.
func TestNativeWindowF12WriteBudget(t *testing.T) {
	slots := []nwSlot{{planned: 8, flags: nwEUp}, {planned: 8, flags: nwEUp}, {planned: -20},
		{planned: 5, flags: nwEUp}, {planned: 0, flags: nwE}, {planned: 0, flags: nwE}, {planned: 0}, {planned: 6, flags: nwEUp}}
	pv := func(t float64) float64 { return 12 + 6*math.Sin(t/47) + 4*math.Sin(t/13) }
	load := func(t float64) float64 { return 4 + 2*math.Sin(t/29) }
	perHour := map[string]float64{}
	for _, path := range nwPaths {
		r := runNativeWindow(t, nwScenario{seconds: 8*900 - 1, slots: slots, pv: pv, load: load,
			socPct: 40, levers: path.levers, measPeriod: 10})
		perHour[path.name] = float64(r.writes) / 2
		t.Logf("F12 %s: %d Schreibvorgänge in 2 h (%.1f je Stunde)", path.name, r.writes, perHour[path.name])
	}
	if perHour["geraet"] >= perHour["gedaempft"] {
		t.Fatalf("F12: the device path must write less than the box path: %v", perHour)
	}
	// The device path: one hand-over per intent change plus the setpoint writes
	// of the point slots (sell, hold) - never a stream.
	if perHour["geraet"] > 20 {
		t.Fatalf("F12: device path writes %.1f per hour", perHour["geraet"])
	}
}

// A Layer 1 that does not know "native_window" stays safe: it writes the
// published (damped) reference, never confirms, and the core withdraws the
// intent after its grace with the named cause - latched for the slot.
func TestNativeWindowALayer1WithoutTheNewModeStaysSafe(t *testing.T) {
	r := runNativeWindow(t, nwScenario{
		seconds: 300, slots: []nwSlot{{planned: 8, flags: nwEUp}},
		pv: step(0, 20, 20), load: step(0, 4, 4), socPct: 50,
		levers: nwDeviceLevers, neverConfirm: true, measPeriod: 10,
	})
	if s := r.at(40); !s.native || s.proven || s.reason != guards.NativePending {
		t.Fatalf("inside the grace the intent stands pending: %+v", s)
	}
	if s := r.at(250); s.native || s.reason != guards.NativeUnproven {
		t.Fatalf("after the grace it is withdrawn with nachweis_fehlt: %+v", s)
	}
	// Throughout, the box's (damped) setpoint carried the slot: the battery
	// charges the surplus, it never went unregulated.
	if b := r.at(250).batt; b < 10 {
		t.Fatalf("the damped setpoint must carry the slot: batt %.2f", b)
	}
}

// The heartbeat words (K4a contract) and the null command of every
// autonomous_* mode.
func TestAutonomousChargeWordsAndNullCommand(t *testing.T) {
	floor := 20.0
	zero := 0.0
	for _, c := range []struct{ intent, want string }{
		{guards.NativeIntentSurplusCharge, execModeAutonomousCharge},
		{guards.NativeIntentSelfConsumption, execModeAutonomousSelfConsumption},
		{guards.NativeIntentCoverLoad, execModeAutonomousDischarge},
	} {
		snap := state.Snapshot{
			EffectiveFloorSocPct: &floor,
			Native: &state.NativeInfo{Active: true, Proven: true, Intent: c.intent,
				ReferenceKw: 7.5, WindowMinKw: 0, WindowMaxKw: 12},
			Control: &state.ControlInfo{AllMatch: true, CheckedAt: nwStart, Registers: []state.ControlRegister{
				{Role: "battery_power", CommandedKw: &zero, ActualKw: &zero, Match: true}}},
		}
		sum := controlSummary(snap)
		if sum == nil || sum.Execution == nil || sum.Execution.Mode != c.want {
			t.Fatalf("%s: want %s, got %+v", c.intent, c.want, sum)
		}
		if sum.CommandedKw != nil || sum.ConfirmedKw != nil {
			t.Fatalf("%s: nothing is commanded in an autonomous mode - commanded/confirmed must be null", c.intent)
		}
		if *sum.Execution.PlannedKw != 7.5 {
			t.Fatalf("planned_kw is the reference: %+v", sum.Execution)
		}
		hasWindow := sum.Execution.WindowMaxKw != nil
		if hasWindow != (c.want != execModeAutonomousDischarge) {
			t.Fatalf("%s: the window rides only with the charge-side words: %+v", c.intent, sum.Execution)
		}
	}
	// A take-back drops the word in the same tick: no proven native block, no word.
	snap := state.Snapshot{Native: nil, NativeWithheld: &state.NativeWithheldInfo{Reason: guards.NativeChargeFromGrid}}
	if e := executionSummary(snap); e != nil && isAutonomousMode(e.Mode) {
		t.Fatalf("a take-back must drop the autonomous word: %+v", e)
	}
}
