package agent

// PRÜFLAUF „ÜBERSCHUSS MIT KURZEN VERBRAUCHERN" (Captain decision E7 A,
// 2026-10-10, report vp-wr-ueberschuss-entladung-k3 §4/§5 UE-4): the release
// condition for every inverter the box regulates itself.
//
// The case it replays is Herzogau 2026-10-10 17:04: a slot that charges the PV
// surplus, a consumer of ~1 kW that runs for 5-20 s every one to two minutes,
// and a device that follows a write only after its own follow time and reports
// its measurements only every Messtakt. Each single rule of the box was right
// there and the storage still fed the grid twelve times in 79 minutes - a
// fault of the interplay, which only a closed loop with dead time shows.
//
// The run drives the REAL telemetry and setpoint paths (onLocalTelemetry,
// applySetpoint) against a simulated device whose follow time and Messtakt
// come from its CONTROL PROFILE (catalog/control-profiles, the timing the
// damped follower uses) - one run per packaged profile the box regulates, plus
// the Vorgabe for a device without a profile and a fast and a sluggish device
// that bracket them. Its result are the two day figures of E5:
//
//   - "aus dem Speicher eingespeist": energy that left the storage through the
//     grid connection point (the smaller of discharge and export, second by
//     second; the run plans no sale);
//   - "Überschuss nicht aufgenommen": the remaining export while the storage
//     had room in a slot that charges.
//
// Passing means the first figure is ZERO and the setpoint never went below
// zero. The second figure is reported and bounded by what the fixed reserve of
// the damped follower explains; it becomes "nahe null" with the gliding
// reserve (E3, package UE-7), which this run then tightens.
//
// Since the Captain decision A of 2026-10-13 the same condition holds in every
// kind of quarter hour, not only in the one that charges: the run below
// (TestShortConsumersInEverySlotKind) repeats it for a slot that rests, a slot
// the cloud marked for covering the house and a slot with the unplanned-load
// duty - the kinds in which, up to edge-2026.10.1, the first measured deficit
// was covered at once and the storage fed the grid behind every short consumer.
//
// Run it alone (the bench checklist in edge-app/nodered/CONTROL-BENCH.md):
//
//	go test ./internal/agent -run 'TestSurplusWithShortConsumers|TestShortConsumersInEverySlotKind' -v

import (
	"encoding/json"
	"fmt"
	"math"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlprofile"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// benchDevice is the simulated inverter: how its battery follows a write and
// how its measurement registers refresh.
type benchDevice struct {
	name string
	// damp is what the BOX knows about the device (its control profile's
	// Einschwingzeit and Messtakt, or the Vorgabe).
	damp guards.DampProfile
	// The battery follows the write in force deadS ago with a first-order lag
	// of tauS. For the Deye (15 s Einschwingzeit) that is the model of
	// follow_damper_test.go: 5 s + 6 s, i.e. 63 % after 11 s, 95 % after 23 s.
	deadS, tauS float64
	// gapsS is the cycle of gaps between two refreshes of the measurement
	// registers; on every other refresh the battery half arrives battLagS
	// after the grid half (the half pairs recorded at Herzogau).
	gapsS    []float64
	battLagS float64
}

// benchDeviceFor derives the simulated device from the damping profile the box
// uses for it: follow time from the Einschwingzeit, refreshes between a fifth
// of the Messtakt and the full Messtakt (Deye: 5-25 s, 15 s on average - as
// measured).
func benchDeviceFor(name string, damp guards.DampProfile) benchDevice {
	settle, cadence := damp.Settle.Seconds(), damp.MaxCadence.Seconds()
	d := benchDevice{name: name, damp: damp, deadS: settle / 3, tauS: settle * 0.4,
		battLagS: math.Min(5, cadence/5)}
	for _, f := range []float64{0.2, 0.6, 1.0, 0.4, 0.8} {
		d.gapsS = append(d.gapsS, math.Max(1, math.Round(f*cadence)))
	}
	return d
}

// benchDevices lists every device the run covers: one per packaged control
// profile that lets the box regulate, the Vorgabe, and two synthetic devices
// that bracket them.
func benchDevices(t *testing.T) []benchDevice {
	t.Helper()
	if err := controlprofile.Err(); err != nil {
		t.Fatalf("control profiles: %v", err)
	}
	var devices []benchDevice
	for _, prof := range controlprofile.All() {
		if prof.Damping.BoxRegulates == nil || !*prof.Damping.BoxRegulates || len(prof.Bindings) == 0 {
			continue // PV-only or a persistent lever: no box regulation to prove
		}
		b := prof.Bindings[0]
		dev := controlprofile.Device{Brand: b.Brand, Family: b.Family}
		if len(b.Models) > 0 {
			dev.Model = b.Models[0]
		}
		if b.ControlPath != nil {
			dev.ControlPath = *b.ControlPath
		}
		damp := guards.DampProfileFor(dev)
		if damp.Off {
			t.Fatalf("profile %s says the box regulates, but its damper is off", prof.ID)
		}
		devices = append(devices, benchDeviceFor("Profil "+prof.ID, damp))
	}
	if len(devices) == 0 {
		t.Fatal("no packaged control profile lets the box regulate - the run would prove nothing")
	}
	devices = append(devices, benchDeviceFor("Vorgabe (Gerät ohne Profil)", guards.DefaultDampProfile()))
	fast, slow := guards.DefaultDampProfile(), guards.DefaultDampProfile()
	fast.Settle, fast.MaxCadence = 3*time.Second, 5*time.Second
	slow.Settle, slow.MaxCadence = 30*time.Second, 40*time.Second
	devices = append(devices,
		benchDeviceFor("schnelles Gerät (3 s / 5 s)", fast),
		benchDeviceFor("träges Gerät (30 s / 40 s)", slow))
	return devices
}

// benchSegment is one stretch of the disturbance: a steady PV surplus and a
// consumer of pulseKw that runs for the cycled durations at the cycled gaps.
type benchSegment struct {
	seconds   int
	surplusKw float64
	pulseKw   float64
	pulseS    []float64 // durations, cycled
	gapS      []float64 // gaps from one consumer start to the next, cycled
}

type benchScenario struct {
	start   time.Time
	pvKw    float64
	planKw  float64
	surplus bool // the slot carries charge_from_surplus_only + charge_surplus_to_battery
	// cover / unplanned: the slot carries the cloud duty cover_load_from_battery
	// (a "Deck-Viertelstunde") / unplanned_load_discharge. Without any flag and
	// with planKw 0 the slot rests ("Ruhe-Viertelstunde").
	cover     bool
	unplanned bool
	socPct    float64
	segments  []benchSegment
	traceName string
	// NS-3 B (Nulleinspeise-Verbraucher): with zeroExport set the house is
	// baseKw plus that consumer, which regulates the connection point to zero
	// export by itself (benchZeroExport), plus fixedKw of a load that never
	// yields; the segments are not used. pvAt, when set, replaces the constant
	// pvKw. holdBaseKw is the slot's charge_hold_base_load_kw (nil = absent,
	// the box of before).
	zeroExport *benchZeroExport
	baseKw     float64
	fixedKw    float64
	pvAt       func(t float64) float64
	holdBaseKw *float64
	durationS  int // the run's length when there are no segments
}

// pv returns the PV production at t seconds.
func (s benchScenario) pv(t float64) float64 {
	if s.pvAt != nil {
		return s.pvAt(t)
	}
	return s.pvKw
}

func (s benchScenario) seconds() int {
	if s.durationS > 0 {
		return s.durationS
	}
	n := 0
	for _, seg := range s.segments {
		n += seg.seconds
	}
	return n
}

// benchZeroExport is the surplus consumer of Herzogau (NS-3 B, report
// vp-herzogau-minus-erloes-k4 §5, vp-herzogau-nie-schlechter-k5 §3): a
// controller that regulates the connection point to zero export by itself, in
// stages of stageKw (measured ~15/25/37 kW over a base of 3-5 kW). The TOP stage
// modulates continuously toward grid 0 with the lag tauS - the scout of 10.10.
// saw the grid held at ±0,01 kW for 70 s ("Heizstab-Regler"), and the
// 14.10. ring 13-30 kW of load at -0,4 to +0,6 kW of grid. A further stage
// switches on only after onDelayS (Einschaltverzug) with the top stage full and
// export left - the first one only once the export reaches onFirstKw - and the
// top stage switches off after offDelayS (Ausschaltverzug) with nothing left
// to modulate down and import at the meter. From offS on (0 = never) it is
// switched off. Its meter is the connection point, read every second.
type benchZeroExport struct {
	stageKw, tauS, onDelayS, offDelayS, onFirstKw float64
	stages                                        int
	startKw                                       float64 // power at t=0
	offS                                          float64

	n                 int
	mod               float64
	onSince, offSince float64
}

func (c *benchZeroExport) reset() {
	c.n, c.mod, c.onSince, c.offSince = 0, 0, -1, -1
	if c.startKw > 0 {
		p := math.Min(c.startKw, float64(c.stages)*c.stageKw)
		c.n = int(math.Ceil(p / c.stageKw))
		c.mod = p - float64(c.n-1)*c.stageKw
	}
}

func (c *benchZeroExport) power() float64 {
	if c.n == 0 {
		return 0
	}
	return float64(c.n-1)*c.stageKw + c.mod
}

// step advances the controller by dt seconds on the grid it measured (+ import
// / - export, the consumer included).
func (c *benchZeroExport) step(t, dt, gridKw float64) {
	if c.offS > 0 && t >= c.offS {
		c.n, c.mod = 0, 0
		return
	}
	const margin = 0.1
	if c.n > 0 {
		// integral action on the meter: import lowers, export raises the top stage
		c.mod -= gridKw * (1 - math.Exp(-dt/c.tauS))
		c.mod = math.Max(0, math.Min(c.stageKw, c.mod))
	}
	export := -gridKw
	wantsOn := (c.n == 0 && export >= c.onFirstKw) ||
		(c.n > 0 && c.n < c.stages && c.mod >= c.stageKw-1e-6 && export > margin)
	if wantsOn {
		if c.onSince < 0 {
			c.onSince = t
		}
		if t-c.onSince >= c.onDelayS {
			c.n, c.mod, c.onSince = c.n+1, 0, -1
		}
	} else {
		c.onSince = -1
	}
	if c.n > 0 && c.mod <= 1e-6 && gridKw > margin {
		if c.offSince < 0 {
			c.offSince = t
		}
		if t-c.offSince >= c.offDelayS {
			c.n, c.mod, c.offSince = c.n-1, c.stageKw, -1
			if c.n == 0 {
				c.mod = 0
			}
		}
	} else {
		c.offSince = -1
	}
}

// herzogauConsumer is the consumer of the two scenarios: three stages of
// 12,5 kW (up to 37,5 kW), 4 s of modulation lag, 30 s Einschaltverzug, 10 s
// Ausschaltverzug, the first stage at 12 kW of export.
func herzogauConsumer(startKw, offS float64) *benchZeroExport {
	return &benchZeroExport{stageKw: 12.5, stages: 3, tauS: 4, onDelayS: 30, offDelayS: 10,
		onFirstKw: 12, startKw: startKw, offS: offS}
}

// load returns the house load at t seconds and whether a consumer runs.
func (s benchScenario) load(t float64) (kw float64, consumer bool) {
	offset := 0.0
	for _, seg := range s.segments {
		if t < offset+float64(seg.seconds) {
			base := s.pvKw - seg.surplusKw
			if seg.pulseKw == 0 || len(seg.pulseS) == 0 {
				return base, false
			}
			// The first consumer starts 43 s into the segment - not on a poll or
			// tick boundary - and the cycle keeps shifting the phase.
			at, i := offset+43, 0
			for at < offset+float64(seg.seconds) {
				dur := seg.pulseS[i%len(seg.pulseS)]
				if t >= at && t < at+dur {
					return base + seg.pulseKw, true
				}
				at += seg.gapS[i%len(seg.gapS)]
				i++
			}
			return base, false
		}
		offset += float64(seg.seconds)
	}
	last := s.segments[len(s.segments)-1]
	return s.pvKw - last.surplusKw, false
}

// benchResult is what the grid connection point saw, plus what the box wrote.
type benchResult struct {
	seconds float64
	// The two day figures of E5.
	storageExportedKwh float64 // "aus dem Speicher eingespeist"
	surplusLostKwh     float64 // "Überschuss nicht aufgenommen"
	// What explains them.
	surplusKwh      float64 // PV surplus on offer (pv - load, where positive)
	chargedKwh      float64
	dischargedKwh   float64
	importKwh       float64
	boughtToBattKwh float64 // "Laden bei Bezug": the smaller of charge and import
	deficitKwh      float64 // house deficit (load - pv, where positive)
	consumers       int
	writes          int
	dischargeWrites int
	minSetpointKw   float64
	// storageExportS is how long the storage fed the grid (> 0.1 kW each).
	storageExportS float64
	// chargeAtImportMaxS is the longest unbroken stretch of charging while
	// importing (> 0.1 kW each) - "Laden bei Bezug", the EEG-sensitive side.
	chargeAtImportMaxS float64
	setpoints          []benchWrite
	// gridRefreshes are the instants the device refreshed its grid register.
	gridRefreshes []float64
	// NS-3 B: what the zero-export consumer took, and the run second by second.
	consumerKwh float64
	trace       []benchSecond
}

// benchSecond is one second of a run with the zero-export consumer.
type benchSecond struct{ batt, grid, consumer, pv float64 }

// meanCharge is the mean battery charge (kW) over [fromS, toS).
func (r benchResult) meanCharge(fromS, toS int) float64 {
	sum, n := 0.0, 0
	for i := fromS; i < toS && i < len(r.trace); i++ {
		sum += math.Max(r.trace[i].batt, 0)
		n++
	}
	if n == 0 {
		return math.NaN()
	}
	return sum / float64(n)
}

type benchWrite struct{ at, kw float64 }

func (r benchResult) String() string {
	return fmt.Sprintf("aus dem Speicher eingespeist %.4f kWh (%.0f s) | Überschuss nicht aufgenommen %.3f von %.3f kWh | "+
		"geladen %.3f kWh, entladen %.3f kWh, Bezug %.3f kWh (davon in den Speicher %.3f, längstens %.0f s am Stück) | "+
		"%d Verbraucher, %d Sollwert-Wechsel, davon %d Entlade-Befehle, tiefster Sollwert %+.2f kW",
		r.storageExportedKwh, r.storageExportS, r.surplusLostKwh, r.surplusKwh,
		r.chargedKwh, r.dischargedKwh, r.importKwh, r.boughtToBattKwh, r.chargeAtImportMaxS,
		r.consumers, r.writes, r.dischargeWrites, r.minSetpointKw)
}

const (
	benchPollEvery  = 5  // s, Node-RED read cadence
	benchTickEvery  = 10 // s, config SetpointIntervalSeconds
	benchTickOffset = 2  // s, the tick is not phase-locked to the poll
)

// runBench runs the closed loop second by second: plant, device registers,
// Node-RED poll, Layer-1 readback and the box tick.
func runBench(t *testing.T, dev benchDevice, sc benchScenario) benchResult {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.MaxChargeKw, cfg.MaxDischargeKw = 30, 30
	a, _ := startBusOnlyAgent(t, cfg)
	a.dampProfileFor = func(controlprofile.Device) guards.DampProfile { return dev.damp }

	setPlan := func(now time.Time) {
		slot := now.Truncate(15 * time.Minute)
		floor := 5.0
		a.mu.Lock()
		// No grid_charge_allowed: an EEG site, the charge never exceeds the PV.
		a.currentPlan = &plan.Plan{
			SlotMinutes: 15, ReceivedAt: now, GeneratedAt: now,
			EffectiveFloorSocPct: &floor,
			Slots: []plan.Slot{{
				Start: slot, BatterySetpointKw: sc.planKw,
				ChargeFromSurplusOnly: sc.surplus, ChargeSurplusToBattery: sc.surplus,
				CoverLoadFromBattery: sc.cover, UnplannedLoadDischarge: sc.unplanned,
				ChargeHoldBaseLoadKw: sc.holdBaseKw,
			}},
		}
		a.mu.Unlock()
	}

	writes := []benchWrite{{0, 0}}
	batt := 0.0
	houseAt := func(t float64) (float64, bool) {
		if sc.zeroExport != nil {
			return sc.baseKw + sc.fixedKw + sc.zeroExport.power(), false
		}
		return sc.load(t)
	}
	if sc.zeroExport != nil {
		sc.zeroExport.reset()
	}
	load0, _ := houseAt(0)
	regGrid, regBatt, regPv := load0-sc.pv(0), 0.0, sc.pv(0)
	nextGrid, nextBatt, refreshes := 0.0, math.Inf(1), 0
	lastSetpoint := 0.0
	res := benchResult{seconds: float64(sc.seconds())}
	lastSlot := time.Time{}
	consumerOn := false
	chargeAtImportS := 0.0
	const dt = 1.0
	for step := 0; step <= sc.seconds(); step++ {
		tNow := float64(step)
		now := sc.start.Add(time.Duration(step) * time.Second)
		if slot := now.Truncate(15 * time.Minute); !slot.Equal(lastSlot) {
			lastSlot = slot
			setPlan(now) // the cloud's plan for the new quarter hour
		}
		// Plant: the battery follows the write in force deadS ago.
		cmd := writes[0].kw
		for _, w := range writes {
			if w.at <= tNow-dev.deadS {
				cmd = w.kw
			}
		}
		batt += (cmd - batt) * (1 - math.Exp(-dt/dev.tauS))
		pv := sc.pv(tNow)
		load, consumer := houseAt(tNow)
		if consumer && !consumerOn {
			res.consumers++
		}
		consumerOn = consumer
		grid := load + batt - pv // + import / - export
		if sc.zeroExport != nil {
			// the consumer answers its own meter, for the next second
			sc.zeroExport.step(tNow, dt, grid)
			res.consumerKwh += sc.zeroExport.power() * dt / 3600
			res.trace = append(res.trace, benchSecond{batt: batt, grid: grid, consumer: sc.zeroExport.power(), pv: pv})
		}
		charge, discharge := math.Max(batt, 0), math.Max(-batt, 0)
		imp, exp := math.Max(grid, 0), math.Max(-grid, 0)
		fromStorage := math.Min(discharge, exp)
		res.storageExportedKwh += fromStorage * dt / 3600
		res.surplusLostKwh += (exp - fromStorage) * dt / 3600
		res.surplusKwh += math.Max(pv-load, 0) * dt / 3600
		res.deficitKwh += math.Max(load-pv, 0) * dt / 3600
		res.chargedKwh += charge * dt / 3600
		res.dischargedKwh += discharge * dt / 3600
		res.importKwh += imp * dt / 3600
		res.boughtToBattKwh += math.Min(charge, imp) * dt / 3600
		if discharge > 0.1 && exp > 0.1 {
			res.storageExportS += dt
		}
		if charge > 0.1 && imp > 0.1 {
			chargeAtImportS += dt
			res.chargeAtImportMaxS = math.Max(res.chargeAtImportMaxS, chargeAtImportS)
		} else {
			chargeAtImportS = 0
		}
		// Device registers: the grid half (with the PV) and, sometimes later, the
		// battery half.
		if tNow >= nextGrid {
			regGrid, regPv = grid, pv
			res.gridRefreshes = append(res.gridRefreshes, tNow)
			if refreshes%2 == 1 {
				nextBatt = tNow + dev.battLagS
			} else {
				regBatt = batt
			}
			nextGrid = tNow + dev.gapsS[refreshes%len(dev.gapsS)]
			refreshes++
		}
		if tNow >= nextBatt {
			regBatt, nextBatt = batt, math.Inf(1)
		}
		// Node-RED poll: publishes the register snapshot as it stands.
		if step%benchPollEvery == 0 {
			payload, _ := json.Marshal(map[string]any{
				"ts":               now.Format(time.RFC3339Nano),
				"power_kw":         round3(regGrid),
				"battery_power_kw": round3(regBatt),
				"pv_power_kw":      round3(regPv),
				"soc_pct":          sc.socPct,
			})
			a.onLocalTelemetry("", payload)
		}
		// Box tick, with the Layer-1 readback held.
		if step%benchTickEvery == benchTickOffset {
			a.State.Update(func(s *state.Snapshot) {
				s.Control = &state.ControlInfo{AllMatch: true, Confirm: "held", CheckedAt: now, ControlPath: "remote"}
			})
			a.applySetpoint(now)
			sp := a.State.Get().SetpointKw
			if math.Abs(sp-lastSetpoint) > 0.005 { // register resolution: 10 W
				res.writes++
				if sp < -0.005 && sp < lastSetpoint {
					res.dischargeWrites++
				}
				writes = append(writes, benchWrite{tNow, sp})
				res.setpoints = append(res.setpoints, benchWrite{tNow, sp})
				lastSetpoint = sp
			}
			res.minSetpointKw = math.Min(res.minSetpointKw, sp)
			if sc.traceName != "" && sc.traceName == dev.name {
				t.Logf("t=%4.0f load=%5.2f batt=%6.2f grid=%6.2f reg(g=%6.2f b=%6.2f) sp=%6.2f",
					tNow, load, batt, grid, regGrid, regBatt, sp)
			}
		}
	}
	return res
}

// herzogauBenchScenario is the run itself: 65 minutes in slots that charge the
// surplus (+1,303 kW planned, both surplus flags - the slot 17:00 of
// 2026-10-10), a PV surplus between 0,5 and 5 kW, a consumer of 1 kW for
// 5-20 s every one to two minutes, and one stretch with the consumer measured
// at 17:03:15 (2,6 kW for 15 s on a 0,76 kW surplus).
func herzogauBenchScenario() benchScenario {
	pulses := []float64{5, 10, 15, 20, 12, 8}
	gaps := []float64{60, 90, 120, 75, 105}
	sc := benchScenario{
		start:  time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC),
		pvKw:   5.0,
		planKw: 1.303, surplus: true,
		socPct: 37,
	}
	for _, surplus := range []float64{0.5, 0.8, 1.5, 3, 5} {
		sc.segments = append(sc.segments, benchSegment{
			seconds: 660, surplusKw: surplus, pulseKw: 1, pulseS: pulses, gapS: gaps,
		})
	}
	sc.segments = append(sc.segments, benchSegment{
		seconds: 600, surplusKw: 0.76, pulseKw: 2.62, pulseS: []float64{15, 10, 12}, gapS: gaps,
	})
	return sc
}

// THE RUN. One line per device with the two day figures; a device passes when
// its storage never fed the grid and its setpoint never went below zero.
func TestSurplusWithShortConsumers(t *testing.T) {
	sc := herzogauBenchScenario()
	for _, dev := range benchDevices(t) {
		t.Run(dev.name, func(t *testing.T) {
			res := runBench(t, dev, sc)
			t.Logf("%s (folgt nach %.0f s + %.0f s, Messtakt %.0f-%.0f s): %s", dev.name,
				dev.deadS, dev.tauS, dev.gapsS[0], dev.damp.MaxCadence.Seconds(), res)
			if res.consumers < 30 {
				t.Fatalf("the run carried only %d consumers - it would prove nothing", res.consumers)
			}
			// Figure 1 - "aus dem Speicher eingespeist": zero, and no discharge was
			// ever commanded on a consumer that runs 5-20 s.
			if res.storageExportedKwh > 1e-6 || res.storageExportS > 0 {
				t.Errorf("aus dem Speicher eingespeist: %.4f kWh in %.0f s - a short consumer in a charging slot must never discharge the storage into the grid",
					res.storageExportedKwh, res.storageExportS)
			}
			if res.dischargeWrites > 0 || res.minSetpointKw < 0 {
				t.Errorf("%d discharge commands, lowest setpoint %.3f kW - want none: no consumer here outlasts the hold",
					res.dischargeWrites, res.minSetpointKw)
			}
			// Figure 2 - "Überschuss nicht aufgenommen": reported, and bounded by
			// what the damped follower's fixed reserve and its retreat on every
			// consumer explain (mean export no higher than the reserve plus one
			// deadband). The gliding reserve (E3, UE-7) tightens this to "nahe
			// null"; here it only may not grow unnoticed.
			if mean := res.surplusLostKwh * 3600 / res.seconds; mean > dev.damp.ReserveKw+dev.damp.DeadbandKw {
				t.Errorf("Überschuss nicht aufgenommen: %.3f kWh = %.2f kW on average, above the reserve %.1f kW plus deadband",
					res.surplusLostKwh, mean, dev.damp.ReserveKw)
			}
			// The EEG side must not pay for it: a consumer that switches on meets
			// a charge that is taken back at once - "Laden bei Bezug" never stands
			// longer than one reaction of this device (its Messtakt until the
			// consumer shows, a poll, a tick, and its own follow time).
			reaction := dev.damp.MaxCadence.Seconds() + benchPollEvery + benchTickEvery + dev.deadS + 3*dev.tauS
			if res.chargeAtImportMaxS > reaction {
				t.Errorf("Laden bei Bezug for %.0f s in one stretch, want one reaction (<= %.0f s)", res.chargeAtImportMaxS, reaction)
			}
		})
	}
}

// benchSlotKind is one kind of quarter hour the run covers besides the one that
// charges: what the plan says, and what the scenario gets from it.
type benchSlotKind struct {
	name      string
	planKw    float64
	cover     bool
	unplanned bool
}

// benchSlotKinds are the three kinds in which a measured deficit becomes a
// discharge WITHOUT a planned charge in front of it. The covering slot carries
// the plan's own forecast discharge (-1 kW), as the cloud emits it.
func benchSlotKinds() []benchSlotKind {
	return []benchSlotKind{
		{name: "Ruhe-Viertelstunde"},
		{name: "Deck-Viertelstunde", planKw: -1.0, cover: true},
		{name: "ungeplante Lastdeckung", unplanned: true},
	}
}

func (k benchSlotKind) apply(sc benchScenario) benchScenario {
	sc.planKw, sc.surplus, sc.cover, sc.unplanned = k.planKw, false, k.cover, k.unplanned
	return sc
}

// shortConsumerScenario is the day of the Zusatzlauf of edge-2026.10.1 for a
// slot without a planned charge: 33 minutes on a small PV surplus, the consumer
// of Herzogau 17:03:15 (2,62 kW for 10-15 s) and a 1 kW consumer for 5-20 s,
// every one to two minutes. Every consumer here turns the house balance into a
// deficit - and none of them lasts as long as the hold.
func shortConsumerScenario() benchScenario {
	gaps := []float64{60, 90, 120, 75, 105}
	return benchScenario{
		start:  time.Date(2026, 10, 13, 15, 0, 0, 0, time.UTC),
		pvKw:   5.0,
		socPct: 37,
		segments: []benchSegment{
			{seconds: 660, surplusKw: 0.76, pulseKw: 2.62, pulseS: []float64{15, 10, 12}, gapS: gaps},
			{seconds: 660, surplusKw: 0.5, pulseKw: 1, pulseS: []float64{5, 10, 15, 20, 12, 8}, gapS: gaps},
			{seconds: 660, surplusKw: 0.2, pulseKw: 2.62, pulseS: []float64{12, 15, 10}, gapS: gaps},
		},
	}
}

// THE RUN FOR EVERY OTHER KIND OF SLOT (Captain decision A, 2026-10-13). One
// line per slot kind and device; a device passes when its storage never fed the
// grid and no discharge was ever commanded for a consumer of 5-20 s.
func TestShortConsumersInEverySlotKind(t *testing.T) {
	for _, kind := range benchSlotKinds() {
		sc := kind.apply(shortConsumerScenario())
		for _, dev := range benchDevices(t) {
			t.Run(kind.name+"/"+dev.name, func(t *testing.T) {
				res := runBench(t, dev, sc)
				t.Logf("%s, %s (folgt nach %.0f s + %.0f s, Messtakt %.0f-%.0f s): %s", kind.name, dev.name,
					dev.deadS, dev.tauS, dev.gapsS[0], dev.damp.MaxCadence.Seconds(), res)
				if res.consumers < 20 {
					t.Fatalf("the run carried only %d consumers - it would prove nothing", res.consumers)
				}
				if res.storageExportedKwh > 1e-6 || res.storageExportS > 0 {
					t.Errorf("aus dem Speicher eingespeist: %.4f kWh in %.0f s - a short consumer must never discharge the storage into the grid, whatever the slot plans",
						res.storageExportedKwh, res.storageExportS)
				}
				if res.dischargeWrites > 0 || res.minSetpointKw < 0 {
					t.Errorf("%d discharge commands, lowest setpoint %.3f kW - want none: no consumer here outlasts the hold",
						res.dischargeWrites, res.minSetpointKw)
				}
			})
		}
	}
}

// THE NIGHT (Stufen-Haltezeit, Captain decision A, 2026-10-19): the house has
// been short for hours, 1,5 kW of base load. Before the decision the clock
// judged only WHETHER the house was short, so the cover followed every step at
// once, and a consumer of 10-15 s on top was answered by a discharge that
// arrived after it (PR 1502: 0,13 kWh into the grid in 25 minutes on the Deye
// profile). The covering slot carries the forecast of that run, -1,6 kW - just
// above the base load and inside the follower's engage margin, so it runs as
// planned once the base load is covered.
const nightBaseKw = 1.5

func nightSlotKinds() []benchSlotKind {
	return []benchSlotKind{
		{name: "Ruhe-Viertelstunde"},
		{name: "Deck-Viertelstunde", planKw: -1.6, cover: true},
		{name: "ungeplante Lastdeckung", unplanned: true},
	}
}

func nightScenario(segments ...benchSegment) benchScenario {
	return benchScenario{
		start:    time.Date(2026, 10, 13, 21, 0, 0, 0, time.UTC),
		pvKw:     0,
		socPct:   60,
		segments: segments,
	}
}

// standingDeficitNight is the run of PR 1502: 25 minutes of base load, and on
// top the 2,62 kW consumer of Herzogau for 10-15 s every one to two minutes -
// or, without consumers, the same night as the yardstick of what the PLAN
// itself feeds into the grid.
func standingDeficitNight(consumers bool) benchScenario {
	seg := benchSegment{seconds: 1500, surplusKw: -nightBaseKw}
	if consumers {
		seg.pulseKw, seg.pulseS, seg.gapS = 2.62, []float64{15, 10, 12}, []float64{60, 90, 120, 75, 105}
	}
	return nightScenario(seg)
}

// A rise waits like a deficit out of rest: no consumer here raises the
// discharge on any device in any kind of slot, the storage feeds the grid no
// more than on the same night without consumers, and the base load stays
// covered.
func TestShortConsumersOnTopOfAStandingDeficitWait(t *testing.T) {
	for _, kind := range nightSlotKinds() {
		quietSc, sc := kind.apply(standingDeficitNight(false)), kind.apply(standingDeficitNight(true))
		for _, dev := range benchDevices(t) {
			t.Run(kind.name+"/"+dev.name, func(t *testing.T) {
				quiet, res := runBench(t, dev, quietSc), runBench(t, dev, sc)
				t.Logf("%s bei Nacht, %s: %s || ohne Verbraucher: aus dem Speicher eingespeist %.4f kWh (%.0f s), Bezug %.3f kWh, "+
					"%d Entlade-Befehle, tiefster Sollwert %+.2f kW",
					kind.name, dev.name, res, quiet.storageExportedKwh, quiet.storageExportS, quiet.importKwh,
					quiet.dischargeWrites, quiet.minSetpointKw)
				if res.consumers < 15 {
					t.Fatalf("only %d consumers", res.consumers)
				}
				if res.dischargeWrites > quiet.dischargeWrites || res.minSetpointKw < quiet.minSetpointKw-0.005 {
					t.Errorf("%d discharge commands (without consumers %d), lowest setpoint %.3f kW (without consumers %.3f kW) - "+
						"a consumer of 10-15 s must not raise the discharge", res.dischargeWrites, quiet.dischargeWrites,
						res.minSetpointKw, quiet.minSetpointKw)
				}
				if extra := res.storageExportedKwh - quiet.storageExportedKwh; extra > 1e-4 {
					t.Errorf("the consumers sent %.4f kWh of stored energy into the grid - a rise must wait like a deficit out of rest", extra)
				}
				// The standing deficit itself is covered - that part must not regress:
				// after the first hold the storage delivers the base load less the
				// follower's reserve.
				standing := (nightBaseKw - dev.damp.ReserveKw) * (res.seconds - 180) / 3600
				if res.dischargedKwh < 0.7*standing {
					t.Errorf("discharged %.3f kWh, want about the %.3f kWh the standing deficit asks for", res.dischargedKwh, standing)
				}
			})
		}
	}
}

// THE PRICE, chosen with the decision: a real load step at night - 2 kW on top
// of the base load for five minutes (an oven, a heat pump) - is covered one
// hold later, like a deficit out of rest, counted on measurements (no earlier
// than the hold, no later than the hold plus two Messtakte). Its end is
// followed at once.
func TestALoadStepAtNightIsCoveredOneHoldLater(t *testing.T) {
	const stepAt, stepS, stepKw = 600.0, 300.0, 2.0
	hold := guards.DeficitCoverHold.Seconds()
	for _, kind := range nightSlotKinds() {
		sc := kind.apply(nightScenario(
			benchSegment{seconds: int(stepAt), surplusKw: -nightBaseKw},
			benchSegment{seconds: int(stepS), surplusKw: -nightBaseKw - stepKw},
			benchSegment{seconds: 300, surplusKw: -nightBaseKw},
		))
		for _, dev := range benchDevices(t) {
			t.Run(kind.name+"/"+dev.name, func(t *testing.T) {
				res := runBench(t, dev, sc)
				before := 0.0
				for _, w := range res.setpoints {
					if w.at < stepAt {
						before = w.kw
					}
				}
				coverAt, backAt := -1.0, -1.0
				for _, w := range res.setpoints {
					if coverAt < 0 && w.at > stepAt && w.kw <= before-stepKw/2 {
						coverAt = w.at
					}
					if coverAt >= 0 && backAt < 0 && w.at > stepAt+stepS && w.kw >= before-0.05 {
						backAt = w.at
					}
				}
				cadence := dev.damp.MaxCadence.Seconds()
				t.Logf("%s, %s: Lastsprung %.0f kW auf %.1f kW Grundlast ab t=%.0f s für %.0f s (Sollwert davor %+.2f kW) - "+
					"gedeckt ab t=%.0f s (%.0f s nach Beginn), zurückgenommen %.0f s nach dem Ende; %s",
					kind.name, dev.name, stepKw, nightBaseKw, stepAt, stepS, before, coverAt, coverAt-stepAt,
					backAt-(stepAt+stepS), res)
				if before > -(nightBaseKw-dev.damp.ReserveKw)+0.05 {
					t.Fatalf("the base load was not covered before the step: setpoint %.3f kW", before)
				}
				if coverAt < 0 {
					t.Fatalf("a five-minute step was never covered: %s", res)
				}
				if coverAt-stepAt < hold {
					t.Errorf("step covered %.0f s after it began - before the hold of %.0f s", coverAt-stepAt, hold)
				}
				if latest := hold + 2*(cadence+benchPollEvery+benchTickEvery); coverAt-stepAt > latest {
					t.Errorf("step covered %.0f s after it began, want <= %.0f s (hold + two Messtakte)", coverAt-stepAt, latest)
				}
				if backAt < 0 {
					t.Fatalf("the step's cover was never taken back: %s", res)
				}
				if reaction := cadence + benchPollEvery + benchTickEvery; backAt-(stepAt+stepS) > reaction {
					t.Errorf("step's cover taken back %.0f s after its end, want one reaction (<= %.0f s)", backAt-(stepAt+stepS), reaction)
				}
			})
		}
	}
}

// ... and a load that swings faster than the hold - a hob in its cycle, 2 kW
// for 30 s and off for 30 s, ten minutes long - is covered up to its lower
// edge: the discharge stays at the base load, the swing is bought from the
// grid, and none of it is fed back.
func TestASwingingLoadAtNightIsCoveredUpToItsLowerEdge(t *testing.T) {
	const swingAt, swingS = 600.0, 600.0
	for _, kind := range nightSlotKinds() {
		night := func(swingKw float64) benchScenario {
			return kind.apply(nightScenario(
				benchSegment{seconds: int(swingAt), surplusKw: -nightBaseKw},
				benchSegment{seconds: int(swingS), surplusKw: -nightBaseKw, pulseKw: swingKw,
					pulseS: []float64{30}, gapS: []float64{60}},
				benchSegment{seconds: 300, surplusKw: -nightBaseKw},
			))
		}
		quietSc, sc := night(0), night(2)
		for _, dev := range benchDevices(t) {
			t.Run(kind.name+"/"+dev.name, func(t *testing.T) {
				quiet, res := runBench(t, dev, quietSc), runBench(t, dev, sc)
				before, lowest := 0.0, math.Inf(1)
				for _, w := range res.setpoints {
					if w.at < swingAt {
						before = w.kw
					} else if w.at < swingAt+swingS {
						lowest = math.Min(lowest, w.kw)
					}
				}
				lowest = math.Min(lowest, before)
				t.Logf("%s, %s: Kochfeld 2 kW im Takt 30 s an / 30 s aus auf %.1f kW Grundlast, %.0f s lang - "+
					"Sollwert davor %+.2f kW, tiefster im Takten %+.2f kW, Bezug %.3f kWh (ohne Kochfeld %.3f kWh), "+
					"aus dem Speicher eingespeist %.4f kWh (ohne Kochfeld %.4f kWh); %s",
					kind.name, dev.name, nightBaseKw, swingS, before, lowest, res.importKwh, quiet.importKwh,
					res.storageExportedKwh, quiet.storageExportedKwh, res)
				if res.consumers < 9 {
					t.Fatalf("only %d hob cycles", res.consumers)
				}
				if lowest < quiet.minSetpointKw-0.005 {
					t.Errorf("lowest setpoint while the hob swings %.3f kW, below the base load's %.3f kW - "+
						"a swing faster than the hold is covered up to its lower edge", lowest, quiet.minSetpointKw)
				}
				if extra := res.storageExportedKwh - quiet.storageExportedKwh; extra > 1e-4 {
					t.Errorf("the swing sent %.4f kWh of stored energy into the grid", extra)
				}
			})
		}
	}
}

// EXPORT BEATS THE SETTLE TIME (UE-2): "the consumer ends 5 s after the
// discharge command". The hold keeps every consumer shorter than itself away
// from the storage - but a consumer that outlasts it is covered, in a slot that
// rests as in a slot the cloud marked for covering, and it may end right after
// the box deepened the discharge for it. The discharge then has to be taken
// back by the FIRST tick that can know: the one after the device's next grid
// value, not the one after the settle time plus the next complete pair. That
// take-back needs no clock - lowering is immediate.
//
// In a covering slot "taken back" has two steps, and the first is the one this
// rule owns: the grid value alone takes the command back to what the PLAN
// itself commands (-1 kW here - the damper never undercuts a command a raising
// correction raises), and the next pair lets the follower limit that forecast
// value to the house, i.e. to zero. The second step is the ordinary retreat on
// a pair and is bounded by one settle time plus one Messtakt.
//
// The consumer starts at twelve different phases against the device's
// refreshes, the poll and the tick - the instant the box can know differs with
// each, and every one of them must be met exactly.
func TestDischargeIsTakenBackWithTheNextGridValueWhenTheConsumerEnds(t *testing.T) {
	kinds := benchSlotKinds()[:2] // the slot that rests and the covering slot
	for _, kind := range kinds {
		for _, dev := range benchDevices(t) {
			t.Run(kind.name+"/"+dev.name, func(t *testing.T) {
				settle, cadence := dev.damp.Settle.Seconds(), dev.damp.MaxCadence.Seconds()
				var sumDelay, maxDelay, sumExportS, maxExportWh, sumWait, maxRest float64
				phases := 0
				for lead := 30; lead < 150; lead += 10 {
					// 0,8 kW PV surplus. lead seconds of quiet, then a 2,8 kW
					// consumer: first found with a long one, then cut 5 s after the
					// box's discharge command.
					scenario := func(consumerS float64) benchScenario {
						return kind.apply(benchScenario{
							start: time.Date(2026, 10, 10, 15, 0, 0, 0, time.UTC),
							pvKw:  5.0, socPct: 37,
							segments: []benchSegment{
								{seconds: lead - 43, surplusKw: 0.8},
								{seconds: 400, surplusKw: 0.8, pulseKw: 2.8,
									pulseS: []float64{consumerS}, gapS: []float64{1000}},
							},
						})
					}
					firstDischarge := func(r benchResult) float64 {
						for _, w := range r.setpoints {
							if w.kw < -0.005 {
								return w.at
							}
						}
						return -1
					}
					cmdAt := firstDischarge(runBench(t, dev, scenario(300)))
					if cmdAt < 0 {
						t.Fatalf("lead %d s: a standing 2 kW deficit must be covered", lead)
					}
					// Never before the deficit stood for the hold.
					if wait := cmdAt - float64(lead); wait < guards.DeficitCoverHold.Seconds() {
						t.Fatalf("lead %d s: discharge %.0f s after the consumer started - before the hold", lead, wait)
					}
					sumWait += cmdAt - float64(lead)
					offAt := cmdAt + 5
					res := runBench(t, dev, scenario(offAt-float64(lead)))
					if got := firstDischarge(res); got != cmdAt {
						t.Fatalf("lead %d s: the discharge command moved from %.0f to %.0f s", lead, cmdAt, got)
					}
					// Taken back: to the plan's own value (0 in a slot that rests) ...
					backAt, restAt := -1.0, -1.0
					for _, w := range res.setpoints {
						if w.at > cmdAt && backAt < 0 && w.kw >= kind.planKw-0.005 {
							backAt = w.at
						}
						// ... and then to rest.
						if w.at > cmdAt && w.kw >= -0.005 {
							restAt = w.at
							break
						}
					}
					// The first tick that can know: the device's next grid refresh
					// after the consumer ended, the poll that reads it, the tick after.
					refreshAt := -1.0
					for _, at := range res.gridRefreshes {
						if at >= offAt {
							refreshAt = at
							break
						}
					}
					pollAt := math.Ceil(refreshAt/benchPollEvery) * benchPollEvery
					tickAt := math.Ceil((pollAt-benchTickOffset)/benchTickEvery)*benchTickEvery + benchTickOffset
					if backAt != tickAt {
						t.Errorf("lead %d s: command at %.0f s, consumer off at %.0f s, next grid value at %.0f s - "+
							"taken back at %.0f s, want the first tick after it (%.0f s)",
							lead, cmdAt, offAt, refreshAt, backAt, tickAt)
					}
					// The covering slot's second step: the forecast value itself is
					// limited to the house with the next pair.
					if restAt < 0 || restAt-offAt > settle+cadence+benchPollEvery+benchTickEvery {
						t.Errorf("lead %d s: consumer off at %.0f s, discharge fully gone at %.0f s - "+
							"want within a settle time plus a Messtakt, a poll and a tick", lead, offAt, restAt)
					}
					maxRest = math.Max(maxRest, restAt-offAt)
					delay := backAt - cmdAt
					sumDelay += delay
					maxDelay = math.Max(maxDelay, delay)
					sumExportS += res.storageExportS
					maxExportWh = math.Max(maxExportWh, res.storageExportedKwh*1000)
					phases++
				}
				t.Logf("%s, %s: Entladung im Mittel %.0f s nach Beginn des Verbrauchers; Verbraucher endet 5 s nach dem Entlade-Befehl, "+
					"%d Phasenlagen - Rücknahme auf den Planwert im Mittel nach %.0f s, höchstens %.0f s (Einschwingzeit + Messtakt: %.0f s), "+
					"Entladung ganz weg spätestens %.0f s nach dem Ende des Verbrauchers; "+
					"Speicher speist im Mittel %.0f s ein, höchstens %.1f Wh je Fall",
					kind.name, dev.name, sumWait/float64(phases), phases, sumDelay/float64(phases), maxDelay,
					settle+cadence, maxRest, sumExportS/float64(phases), maxExportWh)
			})
		}
	}
}

// ---- NS-3 B: der Speicher hat Vorrang vor dem Überschuss-Verbraucher --------
//
// Captain decision 2026-10-15 (report vp-herzogau-nie-schlechter-k5 §3, §7.2
// candidate g, Bauplan NS-P3b): the two days on which the planned charge
// collapsed against the consumer, replayed against the zero-export consumer
// model (benchZeroExport). Without the cloud's charge_hold_base_load_kw the box
// behaves as up to edge-2026.10.x - the charge collapses, which these runs
// keep as the regression guard of today's behavior; with it the charge holds
// and the consumer gets what remains. A third run is the safety half: a load
// above the base that does NOT yield must not be charged against for longer
// than the hold's import guard allows.
//
//	go test ./internal/agent -run 'TestSurplusConsumer' -v

// herzogau1210Scenario: 12.10. 14-15 Uhr. The plan charges 25 kW with both
// surplus flags, the consumer runs on its first stage (~6 kW) and the sun
// falls from 44 to 34 kW with a five-minute wiggle and one cloud of 8 kW.
// Measured: the charge broke down from ~25 to ~1 kW while the consumer went to
// 30-34 kW.
func herzogau1210Scenario(hold bool) benchScenario {
	sc := benchScenario{
		start:  time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC),
		planKw: 25, surplus: true, socPct: 70,
		baseKw: 5, zeroExport: herzogauConsumer(6, 0), durationS: 3600,
		pvAt: func(t float64) float64 {
			pv := 44 - 10*t/3600 + 2*math.Sin(2*math.Pi*t/300)
			if t >= 1500 && t < 1650 {
				pv -= 8
			}
			return pv
		},
	}
	if hold {
		base := 5.25 // the plan's load: 5 kW base plus its 5 % reserve
		sc.holdBaseKw = &base
	}
	return sc
}

// herzogau1410Scenario: 14.10. 15:00-16:40. The consumer already takes the
// whole surplus (the battery charges ~1 kW), the sun falls from 42 to 20 kW,
// the plan charges 20 kW, and at 16:30 the consumer switches off. Measured:
// ~1 kW of charge until 16:30, then 22 kW within two minutes.
func herzogau1410Scenario(hold bool) benchScenario {
	pvAt := func(t float64) float64 { return 42 - 22*t/6000 + 3*math.Sin(2*math.Pi*t/300) }
	sc := benchScenario{
		start:  time.Date(2026, 10, 14, 13, 0, 0, 0, time.UTC),
		planKw: 20, surplus: true, socPct: 25,
		baseKw: 4.5, zeroExport: herzogauConsumer(pvAt(0)-4.5-1, 5400), durationS: 6000,
		pvAt: pvAt,
	}
	if hold {
		base := 4.725
		sc.holdBaseKw = &base
	}
	return sc
}

// holdTarget is the charge the hold can deliver at second t: the plan's value,
// bounded by the sun above the base load.
func holdTarget(sc benchScenario, t int) float64 {
	return math.Max(0, math.Min(sc.planKw, sc.pv(float64(t))-sc.baseKw))
}

func meanHoldTarget(sc benchScenario, fromS, toS int) float64 {
	sum := 0.0
	for t := fromS; t < toS; t++ {
		sum += holdTarget(sc, t)
	}
	return sum / float64(toS-fromS)
}

// chargeAtImportS counts the seconds of "Laden bei Bezug" (charge > 0,1 kW,
// import > minImportKw) in [fromS, toS) and returns the total and the longest
// unbroken stretch.
func chargeAtImportS(r benchResult, fromS, toS int, minImportKw float64) (total, longest float64) {
	run := 0.0
	for i := fromS; i < toS && i < len(r.trace); i++ {
		if r.trace[i].batt > 0.1 && r.trace[i].grid > minImportKw {
			total++
			run++
			longest = math.Max(longest, run)
		} else {
			run = 0
		}
	}
	return total, longest
}

func TestSurplusConsumerWithoutHoldTheChargeCollapses(t *testing.T) {
	for _, dev := range benchDevices(t) {
		t.Run(dev.name, func(t *testing.T) {
			sc := herzogau1210Scenario(false)
			res := runBench(t, dev, sc)
			late := res.meanCharge(2400, 3600)
			t.Logf("12.10. 14-15 Uhr ohne Halten, %s: Laden %.1f kW in der ersten, %.1f kW in der letzten Viertelstunde, "+
				"Verbraucher %.1f kWh | %s", dev.name, res.meanCharge(60, 900), res.meanCharge(2700, 3600), res.consumerKwh, res)
			if late > 0.4*meanHoldTarget(sc, 2400, 3600) {
				t.Errorf("12.10. ohne Halten: %.1f kW in den letzten 20 min - the regression guard expects today's collapse "+
					"(the consumer takes the charge); if this changed, the hold may have leaked into the default path", late)
			}

			sc = herzogau1410Scenario(false)
			res = runBench(t, dev, sc)
			during, after := res.meanCharge(120, 5400), res.meanCharge(5520, 6000)
			t.Logf("14.10. 15:00-16:40 ohne Halten, %s: Laden %.1f kW solange der Verbraucher läuft, %.1f kW ab 2 min nach dem Abschalten | %s",
				dev.name, during, after, res)
			if during > 3 {
				t.Errorf("14.10. ohne Halten: %.1f kW while the consumer runs, want today's ~1 kW", during)
			}
			if want := 0.8 * meanHoldTarget(sc, 5520, 6000); after < want {
				t.Errorf("14.10. ohne Halten: %.1f kW after the consumer is off, want >= %.1f (22 kW within 2 min measured)", after, want)
			}
		})
	}
}

func TestSurplusConsumerWithHoldTheChargeStands(t *testing.T) {
	for _, dev := range benchDevices(t) {
		t.Run(dev.name, func(t *testing.T) {
			reaction := dev.damp.MaxCadence.Seconds() + benchPollEvery + benchTickEvery + dev.deadS + 3*dev.tauS
			for _, c := range []struct {
				name     string
				sc       benchScenario
				from, to int
			}{
				{"12.10. 14-15 Uhr", herzogau1210Scenario(true), 300, 3600},
				{"14.10. 15:00-16:30", herzogau1410Scenario(true), 300, 5400},
			} {
				res := runBench(t, dev, c.sc)
				got, want := res.meanCharge(c.from, c.to), meanHoldTarget(c.sc, c.from, c.to)
				// The consumer regulates the meter to zero itself, so a few hundred
				// watts either side are its own control error; what counts is an
				// import the hold stands against.
				total, longest := chargeAtImportS(res, 0, c.sc.seconds(), 2*guards.HoldImportMarginKw)
				t.Logf("%s mit Halten, %s: Laden %.1f kW (erreichbar %.1f), Verbraucher %.1f kWh, "+
					"Laden bei mehr als %.1f kW Bezug %.0f s, längstens %.0f s | %s",
					c.name, dev.name, got, want, res.consumerKwh, 2*guards.HoldImportMarginKw, total, longest, res)
				if got < 0.85*want {
					t.Errorf("%s: the held charge averages %.1f kW, want >= 85 %% of the %.1f kW the sun above the base allows", c.name, got, want)
				}
				if res.storageExportedKwh > 1e-6 || res.minSetpointKw < 0 {
					t.Errorf("%s: storage fed the grid (%.4f kWh) or a discharge was commanded (%.2f kW)", c.name, res.storageExportedKwh, res.minSetpointKw)
				}
				// The consumer yields within its own switching steps; the box never
				// charges at a real import longer than the guard's dwell plus one
				// reaction, and what went into the battery from the grid stays a
				// rounding share of the charge.
				if limit := guards.HoldYieldDwell.Seconds() + reaction; longest > limit {
					t.Errorf("%s: Laden bei Bezug for %.0f s in one stretch, want <= %.0f s (dwell + reaction)", c.name, longest, limit)
				}
				if res.boughtToBattKwh > 0.02*res.chargedKwh {
					t.Errorf("%s: %.3f kWh of the %.3f kWh charged came from the grid, want <= 2 %%", c.name, res.boughtToBattKwh, res.chargedKwh)
				}
				// The consumer gets what remains - it must still have run.
				if res.consumerKwh <= 0 {
					t.Errorf("%s: the consumer got nothing - the hold must only take the planned charge", c.name)
				}
			}
			// After the consumer is off on 14.10. the hold is the plain trim.
			sc := herzogau1410Scenario(true)
			res := runBench(t, dev, sc)
			if got, want := res.meanCharge(5520, 6000), 0.8*meanHoldTarget(sc, 5520, 6000); got < want {
				t.Errorf("14.10. after the consumer is off: %.1f kW, want >= %.1f", got, want)
			}
		})
	}
}

// THE SAFETY HALF: a load above the base that does NOT yield (a machine of
// 20 kW on 40 kW of sun) - the hold would buy the charge from the grid. The
// import guard gives it HoldYieldDwell, then the trim bounds the charge by the
// measured surplus again, for the rest of the slot.
func TestSurplusConsumerHoldNeverChargesFromTheGridForLong(t *testing.T) {
	for _, dev := range benchDevices(t) {
		t.Run(dev.name, func(t *testing.T) {
			base := 5.25
			sc := benchScenario{
				start:  time.Date(2026, 10, 13, 10, 0, 0, 0, time.UTC),
				planKw: 25, surplus: true, socPct: 50,
				baseKw: 5, fixedKw: 20, durationS: 899, holdBaseKw: &base,
				// a consumer that never switches on: only the fixed load is there
				zeroExport: &benchZeroExport{stageKw: 12.5, stages: 3, tauS: 4, onDelayS: 30, offDelayS: 10, onFirstKw: 1e9},
				pvAt:       func(float64) float64 { return 40 },
			}
			res := runBench(t, dev, sc)
			reaction := dev.damp.MaxCadence.Seconds() + benchPollEvery + benchTickEvery + dev.deadS + 3*dev.tauS
			total, longest := chargeAtImportS(res, 0, sc.seconds(), 0.1)
			late := res.meanCharge(300, 899)
			t.Logf("Last, die nicht ausweicht, %s: Laden bei Bezug %.0f s (längstens %.0f s), davon in den Speicher %.3f kWh, Laden danach %.1f kW | %s",
				dev.name, total, longest, res.boughtToBattKwh, late, res)
			if limit := guards.HoldYieldDwell.Seconds() + reaction; total > limit+benchTickEvery {
				t.Errorf("Laden bei Bezug %.0f s in the slot, want at most one dwell plus one reaction (%.0f s)", total, limit)
			}
			// 10 kW of import for at most the dwell plus a reaction.
			if limit := 10 * (guards.HoldYieldDwell.Seconds() + reaction) / 3600; res.boughtToBattKwh > limit {
				t.Errorf("bought into the battery %.3f kWh, want <= %.3f", res.boughtToBattKwh, limit)
			}
			// Afterwards the trim of before: the charge on the measured surplus of 15 kW.
			if late > 15.2 || late < 12 {
				t.Errorf("after the guard: %.1f kW of charge, want the measured surplus (15 kW less the reserve)", late)
			}
		})
	}
}
