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
}

func (s benchScenario) seconds() int {
	n := 0
	for _, seg := range s.segments {
		n += seg.seconds
	}
	return n
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
			}},
		}
		a.mu.Unlock()
	}

	writes := []benchWrite{{0, 0}}
	batt := 0.0
	load0, _ := sc.load(0)
	regGrid, regBatt, regPv := load0-sc.pvKw, 0.0, sc.pvKw
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
		load, consumer := sc.load(tNow)
		if consumer && !consumerOn {
			res.consumers++
		}
		consumerOn = consumer
		grid := load + batt - sc.pvKw // + import / - export
		charge, discharge := math.Max(batt, 0), math.Max(-batt, 0)
		imp, exp := math.Max(grid, 0), math.Max(-grid, 0)
		fromStorage := math.Min(discharge, exp)
		res.storageExportedKwh += fromStorage * dt / 3600
		res.surplusLostKwh += (exp - fromStorage) * dt / 3600
		res.surplusKwh += math.Max(sc.pvKw-load, 0) * dt / 3600
		res.deficitKwh += math.Max(load-sc.pvKw, 0) * dt / 3600
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
			regGrid, regPv = grid, sc.pvKw
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

// WHAT THE HOLD DOES NOT REACH - measured, not judged (the open point of the
// decision of 2026-10-13, see the package's PR): a short consumer ON TOP of a
// deficit that already stands. The clock judges whether the house is short at
// all; at night it has been for hours, so the cover follows every step at once
// and a consumer of 10-15 s is still answered by a discharge that arrives after
// it. The run reports what that costs on each device, so the figure is on the
// table when the level-hold ("auch ein ANSTIEG wartet 60 s") is decided.
func TestShortConsumersOnTopOfAStandingDeficitAreStillFollowed(t *testing.T) {
	gaps := []float64{60, 90, 120, 75, 105}
	const baseKw = 1.5
	sc := benchScenario{
		start:  time.Date(2026, 10, 13, 21, 0, 0, 0, time.UTC),
		pvKw:   0,
		planKw: -1.6, cover: true,
		socPct: 60,
		segments: []benchSegment{
			// Night: the house draws 1,5 kW throughout; on top the 2,62 kW consumer.
			{seconds: 1500, surplusKw: -baseKw, pulseKw: 2.62, pulseS: []float64{15, 10, 12}, gapS: gaps},
		},
	}
	for _, dev := range benchDevices(t) {
		t.Run(dev.name, func(t *testing.T) {
			res := runBench(t, dev, sc)
			t.Logf("Deck-Viertelstunde bei Nacht, %s: %s", dev.name, res)
			if res.consumers < 15 {
				t.Fatalf("only %d consumers", res.consumers)
			}
			// The standing deficit itself is covered - that part must not regress:
			// after the first hold the storage delivers the base load less the
			// follower's reserve, give or take the retreats behind each consumer.
			standing := (baseKw - dev.damp.ReserveKw) * (res.seconds - 180) / 3600
			if res.dischargedKwh < 0.7*standing {
				t.Errorf("discharged %.3f kWh, want about the %.3f kWh the standing deficit asks for", res.dischargedKwh, standing)
			}
		})
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
