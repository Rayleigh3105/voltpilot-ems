package agent

// The damped follower (guards/followdamper.go), end to end through the real
// telemetry and setpoint paths against a model of the Deye as MEASURED at
// Herzogau on 2026-09-24 (scout report vp-herzogau-laden-bei-bezug-h4 §1.4):
//
//   - it follows a written setpoint after 15-20 s (modelled as 5 s dead time
//     plus a first-order lag of 6 s: 63 % after 11 s, 86 % after 17 s, 95 %
//     after 23 s);
//   - it refreshes its measurement registers only at the recorded instants
//     (every 5-25 s), sometimes the grid half ~5 s before the battery half;
//   - Node-RED polls it every 5 s and the box recomputes the setpoint every 10 s.
//
// The replay drives that model with the disturbance recorded 17:15:35-17:27:35
// (PV - house, testdata/herzogau-2026-09-24-deye.txt) once with the box as it
// ran that day and once with the damper, and requires the limit cycle to be
// gone. Two synthetic cases - a load step and a cloud edge - pin the two
// halves of the rule: the expensive direction at once, the cheap one damped.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/controlprofile"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
)

// deyeRefresh is one refresh of the device's measurement registers.
type deyeRefresh struct {
	at         float64 // s since the replay start
	grid, batt bool    // which half of the surplus pair it refreshed
}

// exoPoint is one support point of the disturbance: total PV and the surplus
// PV - house (the battery-independent quantity the corrections follow).
type exoPoint struct{ at, pvKw, surplusKw float64 }

type replayScenario struct {
	start    time.Time
	seconds  int
	refresh  []deyeRefresh
	exo      []exoPoint
	battKw   float64 // battery power at start, also the setpoint in force
	planKw   func(t float64) float64
	socPct   float64
	recorded []float64 // the live run's register values (reference only)
}

func (s replayScenario) disturbance(t float64) (pv, surplus float64) {
	e := s.exo
	if t <= e[0].at {
		return e[0].pvKw, e[0].surplusKw
	}
	for i := 1; i < len(e); i++ {
		if t <= e[i].at {
			f := (t - e[i-1].at) / (e[i].at - e[i-1].at)
			return e[i-1].pvKw + f*(e[i].pvKw-e[i-1].pvKw),
				e[i-1].surplusKw + f*(e[i].surplusKw-e[i-1].surplusKw)
		}
	}
	last := e[len(e)-1]
	return last.pvKw, last.surplusKw
}

// replayResult is what the grid connection point saw.
type replayResult struct {
	changes           int     // setpoint changes written to the device
	minKw, maxKw      float64 // span of the written charge command
	measurements      int     // device grid refreshes inside the window
	chargeAtImport    int     // ... of which showed charging > 0.5 kW while importing > 0.5 kW
	chargeAtExport    int     // ... of which showed charging > 0.5 kW while exporting > 0.5 kW
	boughtIntoBattKwh float64 // integral of min(charge, import)
	importKwh         float64
	exportKwh         float64
	setpoints         []float64
	chargeImportSecs  float64 // seconds with charge > 0.5 kW and import > 0.5 kW
}

func (r replayResult) String() string {
	return fmt.Sprintf("%d Ladebefehl-Wechsel (%.2f..%.2f kW), Laden bei Bezug in %d von %d Messungen, "+
		"Laden bei Einspeisung in %d, in den Speicher gekauft %.3f kWh, Bezug %.3f kWh, Einspeisung %.3f kWh",
		r.changes, r.minKw, r.maxKw, r.chargeAtImport, r.measurements, r.chargeAtExport,
		r.boughtIntoBattKwh, r.importKwh, r.exportKwh)
}

const (
	deyeDeadTime = 5.0 // s
	deyeTau      = 6.0 // s
	pollEvery    = 5   // s, Node-RED read cadence
	tickEvery    = 10  // s, config SetpointIntervalSeconds
	tickOffset   = 2   // s, the tick is not phase-locked to the poll
)

// runDeyeReplay runs the closed loop second by second. damped selects the
// Deye profile (as on the live box after this change) or none (as it ran).
func runDeyeReplay(t *testing.T, s replayScenario, damped bool) replayResult {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, _ := startBusOnlyAgent(t, cfg)
	if damped {
		a.dampProfileFor = func(controlprofile.Device) guards.DampProfile {
			return guards.DampProfileFor(controlprofile.Device{Brand: inverter.BrandDeye, Family: inverter.FamHybrid3p, ControlPath: "remote"})
		}
	}
	setPlan := func(kw float64) {
		no := false
		a.mu.Lock()
		a.currentPlan = &plan.Plan{
			SlotMinutes: 15, ReceivedAt: s.start, GeneratedAt: s.start,
			GridChargeAllowed: &no, // EEG site: charge only from the PV bus
			Slots: []plan.Slot{{
				Start:                 s.start.Truncate(15 * time.Minute),
				BatterySetpointKw:     kw,
				ChargeFromSurplusOnly: true,
			}},
		}
		a.mu.Unlock()
	}

	type write struct{ at, kw float64 }
	writes := []write{{0, s.battKw}}
	batt := s.battKw
	// The device already holds a snapshot when the replay starts.
	pv0, surplus0 := s.disturbance(0)
	regGrid, regBatt, regPv := s.battKw-surplus0, s.battKw, pv0
	nextRefresh := 0
	planKw := math.NaN()
	lastSetpoint := s.battKw
	res := replayResult{minKw: math.Inf(1), maxKw: math.Inf(-1)}
	const dt = 1.0
	for step := 0; step <= s.seconds; step++ {
		tNow := float64(step)
		now := s.start.Add(time.Duration(step) * time.Second)
		if kw := s.planKw(tNow); kw != planKw {
			planKw = kw
			setPlan(kw)
		}
		// Plant: the battery follows the write in force deyeDeadTime ago.
		cmd := writes[0].kw
		for _, w := range writes {
			if w.at <= tNow-deyeDeadTime {
				cmd = w.kw
			}
		}
		batt += (cmd - batt) * (1 - math.Exp(-dt/deyeTau))
		pv, surplus := s.disturbance(tNow)
		grid := batt - surplus // import > 0
		if batt > 0.5 && grid > 0.5 {
			res.chargeImportSecs += dt
		}
		res.boughtIntoBattKwh += math.Max(math.Min(batt, grid), 0) * dt / 3600
		res.importKwh += math.Max(grid, 0) * dt / 3600
		res.exportKwh += math.Max(-grid, 0) * dt / 3600
		// Device register refreshes up to now.
		for nextRefresh < len(s.refresh) && s.refresh[nextRefresh].at <= tNow {
			r := s.refresh[nextRefresh]
			if r.grid {
				regGrid, regPv = grid, pv
				res.measurements++
				if batt > 0.5 && grid > 0.5 {
					res.chargeAtImport++
				}
				if batt > 0.5 && grid < -0.5 {
					res.chargeAtExport++
				}
			}
			if r.batt {
				regBatt = batt
			}
			nextRefresh++
		}
		// Node-RED poll: publishes the register snapshot as it stands.
		if step%pollEvery == 0 && !math.IsNaN(regGrid) {
			payload, _ := json.Marshal(map[string]any{
				"ts":               now.Format(time.RFC3339Nano),
				"power_kw":         round3(regGrid),
				"battery_power_kw": round3(regBatt),
				"pv_power_kw":      round3(regPv),
				"soc_pct":          s.socPct,
			})
			a.onLocalTelemetry("", payload)
		}
		// Box tick.
		if step%tickEvery == tickOffset {
			a.applySetpoint(now)
			sp := a.State.Get().SetpointKw
			if math.Abs(sp-lastSetpoint) > 0.005 { // register 1109 resolution: 10 W
				res.changes++
				writes = append(writes, write{tNow, sp})
				lastSetpoint = sp
			}
			if os.Getenv("VP_REPLAY_TRACE") != "" && damped {
				t.Logf("t=%4.0f plan=%6.2f S=%6.2f batt=%6.2f grid=%6.2f reg(g=%6.2f b=%6.2f) sp=%6.2f engaged=%v",
					tNow, planKw, surplus, batt, grid, regGrid, regBatt, sp, a.damp.Engaged())
			}
			res.setpoints = append(res.setpoints, sp)
			res.minKw = math.Min(res.minKw, sp)
			res.maxKw = math.Max(res.maxKw, sp)
		}
	}
	return res
}

func loadHerzogauReplay(t *testing.T) replayScenario {
	t.Helper()
	f, err := os.Open("testdata/herzogau-2026-09-24-deye.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	s := replayScenario{
		start:   time.Date(2026, 9, 24, 15, 15, 35, 463_000_000, time.UTC),
		seconds: 720, // 17:15:35-17:27:35 local, the window of the diagnosis
		battKw:  24.39,
		socPct:  40,
		// The slot 17:15-17:30 planned 16,784 kW; the plan received ~17:19:40
		// raised it to 23,528 kW (EEG-clamped to the measured PV on the box).
		planKw: func(t float64) float64 {
			if t < 245 {
				return 16.784
			}
			return 23.528
		},
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 0 || strings.HasPrefix(fields[0], "#") {
			continue
		}
		num := func(i int) float64 {
			v, err := strconv.ParseFloat(fields[i], 64)
			if err != nil {
				t.Fatalf("testdata line %q: %v", sc.Text(), err)
			}
			return v
		}
		switch fields[0] {
		case "r":
			s.refresh = append(s.refresh, deyeRefresh{at: num(1),
				grid: strings.Contains(fields[2], "g"), batt: strings.Contains(fields[2], "b")})
		case "x":
			s.exo = append(s.exo, exoPoint{at: num(1), pvKw: num(2), surplusKw: num(3)})
		case "w":
			if num(1) <= float64(s.seconds) {
				s.recorded = append(s.recorded, num(2))
			}
		}
	}
	if len(s.refresh) == 0 || len(s.exo) == 0 {
		t.Fatal("testdata carried no replay")
	}
	return s
}

// reversals counts direction changes of the written setpoint (a limit cycle
// reverses on every half period; a converging follower almost never does).
func reversals(sp []float64) int {
	n, dir := 0, 0.0
	for i := 1; i < len(sp); i++ {
		d := sp[i] - sp[i-1]
		if math.Abs(d) <= 0.005 {
			continue
		}
		if dir != 0 && math.Signbit(d) != math.Signbit(dir) {
			n++
		}
		dir = d
	}
	return n
}

func TestFollowDamperHerzogauReplayEndsTheLimitCycle(t *testing.T) {
	s := loadHerzogauReplay(t)
	before := runDeyeReplay(t, s, false)
	after := runDeyeReplay(t, s, true)
	t.Logf("live run 17:15:35-17:27:35 (register 1109): %d changes", len(s.recorded)-1)
	t.Logf("replay, box as it ran: %s, %d reversals", before, reversals(before.setpoints))
	t.Logf("replay, damped:        %s, %d reversals", after, reversals(after.setpoints))

	// The model reproduces the live limit cycle: the undamped box rewrites the
	// command on most ticks and charges while importing on a large share of
	// the measurements.
	if before.changes < 40 || before.chargeAtImport*4 < before.measurements {
		t.Fatalf("replay does not reproduce the live limit cycle: %s", before)
	}
	// Under the recorded clouds the damped box still has to follow a surplus
	// that moves by 10 kW within 10 s - faster than this device can (a write
	// shows after 15-20 s) - so what remains is forced tracking, not a swing of
	// its own: half the writes, half the reversals, fewer measurements charging
	// while importing and less energy bought into the battery. The swing itself
	// is isolated in the load-step case below, where the surplus stays constant.
	if after.changes*10 > before.changes*6 {
		t.Errorf("damped: %d changes, undamped %d - the command still chases the measurement", after.changes, before.changes)
	}
	if reversals(after.setpoints)*2 > reversals(before.setpoints) {
		t.Errorf("damped: %d reversals vs %d - still oscillating", reversals(after.setpoints), reversals(before.setpoints))
	}
	if after.chargeAtImport >= before.chargeAtImport {
		t.Errorf("damped: charging while importing in %d of %d measurements (undamped %d)",
			after.chargeAtImport, after.measurements, before.chargeAtImport)
	}
	if after.boughtIntoBattKwh > before.boughtIntoBattKwh*0.85 {
		t.Errorf("damped: %.3f kWh bought into the battery, undamped %.3f", after.boughtIntoBattKwh, before.boughtIntoBattKwh)
	}
}

// syntheticScenario builds a regular Deye clock (a refresh every 15 s, the
// battery half 5 s behind the grid half on every other cycle - the pattern of
// the live recording) around a disturbance.
func syntheticScenario(seconds int, planKw, battKw float64, exo []exoPoint) replayScenario {
	s := replayScenario{
		start:   time.Date(2026, 9, 25, 10, 0, 3, 0, time.UTC),
		seconds: seconds,
		battKw:  battKw,
		socPct:  50,
		planKw:  func(float64) float64 { return planKw },
		exo:     exo,
	}
	for k := 0; k*15 <= seconds; k++ {
		at := float64(k*15) + 1.5
		if k%2 == 1 {
			s.refresh = append(s.refresh, deyeRefresh{at: at, grid: true}, deyeRefresh{at: at + 5, batt: true})
		} else {
			s.refresh = append(s.refresh, deyeRefresh{at: at, grid: true, batt: true})
		}
	}
	return s
}

// LOAD STEP: steady charging from a 25 kW surplus, then the house jumps by
// 8 kW and STAYS there. Buying for the battery is the expensive direction: the
// damped box must lower in ONE step on the first settled pair and then stop.
// Because the surplus is constant after the step, every later movement of the
// command is the loop's own - the undamped box keeps swinging on its echo in
// "battery - grid" (this clock carries a half pair every other refresh, so
// every ramp of the battery meets one): that is the limit cycle of Herzogau.
func TestFollowDamperLoadStepLowersAtOnce(t *testing.T) {
	const stepAt = 180.0
	exo := []exoPoint{{0, 30, 25}, {stepAt, 30, 25}, {stepAt + 1, 30, 17}, {600, 30, 17}}
	s := syntheticScenario(600, 30, 24.5, exo)
	before := runDeyeReplay(t, s, false)
	after := runDeyeReplay(t, s, true)
	t.Logf("load step, undamped: %s, %d reversals", before, reversals(before.setpoints))
	t.Logf("load step, damped:   %s, %d reversals", after, reversals(after.setpoints))

	if r := reversals(before.setpoints); r < 10 {
		t.Fatalf("the undamped loop should keep swinging after one step: %s, %d reversals", before, r)
	}
	if r := reversals(after.setpoints); r != 0 {
		t.Errorf("damped: %d reversals after one load step, want 0", r)
	}
	// Before the step the damped box settled on surplus - reserve.
	pre := after.setpoints[int(stepAt)/tickEvery-1]
	if math.Abs(pre-24.5) > 0.25 {
		t.Fatalf("before the step: %.3f kW, want ~24.5 (25 kW surplus - 0.5 kW reserve)", pre)
	}
	// After the step: one downward write to ~16.5, then quiet.
	var down []float64
	for i := int(stepAt) / tickEvery; i < len(after.setpoints); i++ {
		if math.Abs(after.setpoints[i]-after.setpoints[i-1]) > 0.005 {
			down = append(down, after.setpoints[i])
		}
	}
	if len(down) == 0 || math.Abs(down[0]-16.5) > 0.25 {
		t.Fatalf("after the load step the damped box wrote %v, want one step to ~16.5 kW", down)
	}
	if len(down) > 1 {
		t.Errorf("after the load step the damped box kept writing: %v", down)
	}
	// Buying for the battery lasts one reaction (refresh + tick + the device's
	// own follow time), not a swing.
	if after.chargeImportSecs > 45 {
		t.Errorf("damped: %.0f s charging while importing after the load step, want one reaction (<= 45 s)", after.chargeImportSecs)
	}
	if after.chargeImportSecs > before.chargeImportSecs+5 {
		t.Errorf("damped: %.0f s charging while importing, undamped %.0f s", after.chargeImportSecs, before.chargeImportSecs)
	}
}

// CLOUD EDGE: PV collapses by 20 kW for three minutes and comes back. The drop
// is followed at once; the recovery - the cheap direction, a little export - in
// ramps of at most 3 kW per settled pair, without overshooting into the import.
func TestFollowDamperCloudEdgeRampsBackWithoutOvershoot(t *testing.T) {
	exo := []exoPoint{
		{0, 36, 29}, {120, 36, 29}, {125, 16, 9}, {300, 16, 9}, {305, 36, 29}, {720, 36, 29},
	}
	s := syntheticScenario(720, 30, 28.5, exo)
	before := runDeyeReplay(t, s, false)
	after := runDeyeReplay(t, s, true)
	t.Logf("cloud edge, undamped: %s, %d reversals", before, reversals(before.setpoints))
	t.Logf("cloud edge, damped:   %s, %d reversals", after, reversals(after.setpoints))

	var ups []float64
	for i := 1; i < len(after.setpoints); i++ {
		d := after.setpoints[i] - after.setpoints[i-1]
		if d > 0.005 {
			ups = append(ups, d)
			if d > 3.0+1e-6 {
				t.Errorf("tick %d: raised by %.3f kW in one write, want <= 3 kW", i, d)
			}
		}
	}
	if len(ups) < 5 {
		t.Errorf("recovery 9 -> 29 kW took %d raising writes, want a ramp (>= 5)", len(ups))
	}
	// One fall, one climb: no oscillation around the edge.
	if r := reversals(after.setpoints); r > 2 {
		t.Errorf("damped: %d reversals around one cloud, want <= 2", r)
	}
	// It ends on surplus - reserve.
	if last := after.setpoints[len(after.setpoints)-1]; math.Abs(last-28.5) > 0.25 {
		t.Errorf("after the cloud: %.3f kW, want ~28.5", last)
	}
	// Buying for the battery only right at the falling edge (one reaction of a
	// device that shows a write after 15-20 s), and less of it than the box as
	// it ran, which chased its own echo on the way down.
	if after.chargeImportSecs > 60 {
		t.Errorf("damped: %.0f s charging while importing, want only the falling edge (<= 60 s)", after.chargeImportSecs)
	}
	if after.boughtIntoBattKwh >= before.boughtIntoBattKwh {
		t.Errorf("damped: %.3f kWh bought into the battery, undamped %.3f", after.boughtIntoBattKwh, before.boughtIntoBattKwh)
	}
}
