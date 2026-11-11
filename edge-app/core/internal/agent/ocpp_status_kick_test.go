package agent

import (
	"context"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
)

// heartbeatRecorder is the status heartbeat's publish side, recorded: when it
// went out and what the chargers block said at that moment.
type heartbeatRecorder struct {
	mu   sync.Mutex
	at   []time.Time
	sent []*cloud.ChargersSummary
	sum  func() *cloud.ChargersSummary
}

func (r *heartbeatRecorder) publish() bool {
	var s *cloud.ChargersSummary
	if r.sum != nil {
		s = r.sum()
	}
	r.mu.Lock()
	r.at = append(r.at, time.Now())
	r.sent = append(r.sent, s)
	r.mu.Unlock()
	return true
}

func (r *heartbeatRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.at)
}

func (r *heartbeatRecorder) times() []time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]time.Time(nil), r.at...)
}

func runHeartbeatLoop(t *testing.T, every, gap time.Duration, kick chan struct{}, r *heartbeatRecorder) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		statusHeartbeatLoop(ctx, every, gap, kick, r.publish)
	}()
	t.Cleanup(func() { cancel(); <-done })
}

func kickOnce(kick chan struct{}) {
	select {
	case kick <- struct{}{}:
	default:
	}
}

// An early heartbeat goes out at once, a second change inside the gap waits
// for the gap's end, and a burst of changes costs exactly one heartbeat.
func TestStatusHeartbeatComesEarlyButNeverCloserThanTheGap(t *testing.T) {
	const gap = 300 * time.Millisecond
	kick := make(chan struct{}, 1)
	r := &heartbeatRecorder{}
	runHeartbeatLoop(t, time.Hour, gap, kick, r)

	start := time.Now()
	kickOnce(kick)
	waitUntil(t, "the first early heartbeat", func() bool { return r.count() == 1 })
	if d := r.times()[0].Sub(start); d > 100*time.Millisecond {
		t.Fatalf("the first early heartbeat waited %v", d)
	}
	for i := 0; i < 20; i++ {
		kickOnce(kick)
		time.Sleep(5 * time.Millisecond)
	}
	waitUntil(t, "the collected heartbeat", func() bool { return r.count() == 2 })
	at := r.times()
	if d := at[1].Sub(at[0]); d < gap {
		t.Fatalf("two heartbeats %v apart, the gap is %v", d, gap)
	}
	time.Sleep(2 * gap)
	if n := r.count(); n != 2 {
		t.Fatalf("a burst of changes must cost one heartbeat, got %d", n)
	}
}

// Without a change the cadence is the only source of heartbeats.
func TestStatusHeartbeatWithoutAChangeKeepsTheCadence(t *testing.T) {
	kick := make(chan struct{}, 1)
	r := &heartbeatRecorder{}
	runHeartbeatLoop(t, 200*time.Millisecond, 50*time.Millisecond, kick, r)
	time.Sleep(700 * time.Millisecond)
	if n := r.count(); n < 2 || n > 4 {
		t.Fatalf("%d heartbeats in 700 ms at a 200 ms cadence", n)
	}
}

func powerKw(v float64) *float64 { return &v }

// The fingerprint is made of WORDS: a running charge whose value moves asks
// for nothing, while the first measurement, the start of the draw and a
// status change each do.
func TestOcppStatusFingerprintIgnoresMovingPowerValues(t *testing.T) {
	snap := func(status string, session bool, kw *float64) csms.Snapshot {
		con := csms.Connector{ID: 1, Status: status, PowerKw: kw}
		if session {
			con.Session = &csms.Session{TransactionID: 1}
		}
		c := csms.ChargerState{Charger: csms.Charger{ID: "S1"}, Connected: true, Connectors: []csms.Connector{con}}
		return csms.Snapshot{Chargers: []csms.ChargerState{c}}
	}
	base := ocppStatusFingerprint(snap("Charging", true, powerKw(7.1)))
	if got := ocppStatusFingerprint(snap("Charging", true, powerKw(7.4))); got != base {
		t.Fatal("a moving power value must not ask for a heartbeat")
	}
	for name, other := range map[string]csms.Snapshot{
		"status":            snap("SuspendedEVSE", true, powerKw(7.1)),
		"session":           snap("Charging", false, powerKw(7.1)),
		"first measurement": snap("Charging", true, nil),
		"draw stops":        snap("Charging", true, powerKw(0)),
	} {
		if ocppStatusFingerprint(other) == base {
			t.Fatalf("%s must ask for a heartbeat", name)
		}
	}
}

// The reproduction of "plugged in, charging with surplus, the portal shows it
// late": the real box, a station on a real websocket, and the status
// heartbeat at its production cadence. The block the cloud receives must say
// "Charging" with a power within statusKickMinGap of the station reporting
// it - not on the next 15-s tick.
func TestPluggingInReachesTheHeartbeatWithinSecondsNotOnTheNextTick(t *testing.T) {
	a := ocppAgent(t, nil)
	set := lastmgmt.Settings{GridLimitKw: 35, MarginPct: 10, MaxHouseLoadKw: 20}.WithDefaults()
	a.ocpp.mu.Lock()
	a.ocpp.settings = set
	a.ocpp.mu.Unlock()
	if err := a.ocpp.store.Save(set); err != nil {
		t.Fatal(err)
	}
	ocppPolicy(t, a, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	st := ocppStation(t, a, "SAEULE-HOF", 1, 11)
	// The site exports 8 kW while nothing charges (house 1 kW, PV 9 kW).
	observe := func() {
		batt := 0.0
		a.ocppObserve(time.Now().UTC(), map[string]float64{"power_kw": 1 + st.DrawKw(1) - 9}, &batt)
	}
	observe()

	r := &heartbeatRecorder{sum: a.chargersSummary}
	runHeartbeatLoop(t, statusHeartbeatEvery, statusKickMinGap, a.statusKick(), r)
	// The regular beat that happens to be running: the change must not wait
	// for the next one.
	time.Sleep(200 * time.Millisecond)

	plugged := time.Now()
	if err := st.Plug(1, ocppsim.Vehicle{DemandKw: 11, MinKw: 1.4}); err != nil {
		t.Fatal(err)
	}
	observe()
	minKwSoon(t, "the car draws the surplus", drawOf(st, 1), 1)
	if err := st.ReportStatus(1, core.ChargePointStatusCharging, ""); err != nil {
		t.Fatal(err)
	}
	if err := st.PublishMeterValues(); err != nil {
		t.Fatal(err)
	}
	metered := time.Now()

	deadline := metered.Add(statusKickMinGap + 2*time.Second)
	var shownAt time.Time
	for time.Now().Before(deadline) && shownAt.IsZero() {
		r.mu.Lock()
		for i, s := range r.sent {
			if s == nil || len(s.Chargers) != 1 || len(s.Chargers[0].Connectors) != 1 {
				continue
			}
			con := s.Chargers[0].Connectors[0]
			if con.Status == "Charging" && con.PowerKw != nil && *con.PowerKw > ocppDrawingKw {
				shownAt = r.at[i]
				break
			}
		}
		r.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	if shownAt.IsZero() {
		t.Fatalf("no heartbeat said \"Charging\" with a power within %v of the meter value (plugged %v ago)",
			statusKickMinGap+2*time.Second, time.Since(plugged))
	}
	if d := shownAt.Sub(metered); d >= statusHeartbeatEvery {
		t.Fatalf("the heartbeat waited for the tick: %v", d)
	}
	t.Logf("plugged -> heartbeat with Charging + power: %v (meter value -> heartbeat: %v)",
		shownAt.Sub(plugged), shownAt.Sub(metered))

	// A running charge whose value merely moves adds no heartbeat (first let
	// a heartbeat that is still being collected go out).
	time.Sleep(statusKickMinGap + 500*time.Millisecond)
	before := r.count()
	for i := 0; i < 3; i++ {
		if err := st.PublishMeterValues(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	time.Sleep(statusKickMinGap + 500*time.Millisecond)
	if n := r.count(); n != before {
		t.Fatalf("steady meter values sent %d extra heartbeats", n-before)
	}
}
