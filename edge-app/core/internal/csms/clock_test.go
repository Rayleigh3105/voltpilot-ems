package csms

import (
	"sync"
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
)

// clockRig is a CSMS with a box clock the test moves, driven through the real
// OCPP handlers (the mapping onto the box clock lives there).
type clockRig struct {
	mu  sync.Mutex
	now time.Time
	dir string
	s   *Server
	h   *coreHandler
}

func newClockRig(t *testing.T, now time.Time) *clockRig {
	t.Helper()
	r := &clockRig{now: now, dir: t.TempDir()}
	r.reopen(t)
	return r
}

func (r *clockRig) clock() time.Time { r.mu.Lock(); defer r.mu.Unlock(); return r.now }

func (r *clockRig) advance(d time.Duration) { r.mu.Lock(); r.now = r.now.Add(d); r.mu.Unlock() }

// reopen is a box restart on the same data directory.
func (r *clockRig) reopen(t *testing.T) {
	t.Helper()
	s, err := New(Options{Enabled: true, DataDir: r.dir, Now: r.clock})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.List()) == 0 {
		if _, err := s.Add(AddRequest{ID: "CP"}); err != nil {
			t.Fatal(err)
		}
	}
	r.s, r.h = s, &coreHandler{srv: s}
}

func (r *clockRig) start(t *testing.T, stationAt time.Time, meterStart int) int {
	t.Helper()
	conf, err := r.h.OnStartTransaction("CP", &core.StartTransactionRequest{
		ConnectorId: 1, IdTag: "card", MeterStart: meterStart, Timestamp: types.NewDateTime(stationAt)})
	if err != nil {
		return 0
	}
	return conf.TransactionId
}

func (r *clockRig) stop(t *testing.T, tx int, stationAt time.Time) {
	t.Helper()
	if _, err := r.h.OnStopTransaction("CP", &core.StopTransactionRequest{
		TransactionId: tx, MeterStop: 1, Timestamp: types.NewDateTime(stationAt)}); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func (r *clockRig) meter(tx int, watts string, stationAt ...time.Time) {
	values := make([]types.MeterValue, 0, len(stationAt))
	for _, at := range stationAt {
		values = append(values, types.MeterValue{Timestamp: types.NewDateTime(at), SampledValue: []types.SampledValue{
			{Value: watts, Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}}})
	}
	_, _ = r.h.OnMeterValues("CP", &core.MeterValuesRequest{ConnectorId: 1, TransactionId: &tx, MeterValue: values})
}

func (r *clockRig) charging(t *testing.T) (float64, bool) {
	t.Helper()
	return r.s.Snapshot().ChargingTotal(r.clock(), 30*time.Second)
}

// TestAStationClockAheadOrBehindStillMeters is W-09 (audit probe A1): two
// seconds ahead used to drop every meter value as "from the future", and a
// minute behind dropped them as too old. Within MaxStationClockSkew the
// message is moved onto the box clock instead; beyond it nothing is live.
func TestAStationClockAheadOrBehindStillMeters(t *testing.T) {
	now := time.Date(2026, 10, 26, 11, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		skew time.Duration
		live bool
	}{
		{"2 s ahead", 2 * time.Second, true},
		{"90 s behind", -90 * time.Second, true},
		{"115 s ahead", 115 * time.Second, true},
		{"10 min ahead", 10 * time.Minute, false},
		{"10 min behind", -10 * time.Minute, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newClockRig(t, now)
			tx := r.start(t, now.Add(tc.skew), 0)
			if tx == 0 {
				t.Fatal("start refused")
			}
			r.advance(10 * time.Second)
			r.meter(tx, "11000", r.clock().Add(tc.skew))
			kw, complete := r.charging(t)
			if tc.live && (kw != 11 || !complete) {
				t.Fatalf("station clock %v: charging %.1f kW complete=%v, want 11 kW measured", tc.skew, kw, complete)
			}
			if !tc.live && complete {
				t.Fatalf("station clock %v: a sample this far off became live", tc.skew)
			}
			c, _ := r.s.Snapshot().ChargerByID("CP")
			if con := c.ConnectorByID(1); tc.live && !con.MeteredAt.Equal(r.clock()) {
				t.Fatalf("sample time %v, want the box clock %v", con.MeteredAt, r.clock())
			}
		})
	}
}

// TestABatchKeepsItsOrderOnTheBoxClock: moving a message onto the box clock
// keeps the distance between its samples, so the newest one still wins and an
// older one in the same batch never overwrites it.
func TestABatchKeepsItsOrderOnTheBoxClock(t *testing.T) {
	now := time.Date(2026, 10, 26, 11, 0, 0, 0, time.UTC)
	r := newClockRig(t, now)
	tx := r.start(t, now.Add(2*time.Second), 0)
	r.advance(20 * time.Second)
	at := r.clock().Add(2 * time.Second)
	values := []types.MeterValue{
		{Timestamp: types.NewDateTime(at), SampledValue: []types.SampledValue{
			{Value: "7000", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}}},
		{Timestamp: types.NewDateTime(at.Add(-10 * time.Second)), SampledValue: []types.SampledValue{
			{Value: "3000", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}}},
	}
	_, _ = r.h.OnMeterValues("CP", &core.MeterValuesRequest{ConnectorId: 1, TransactionId: &tx, MeterValue: values})
	if kw, complete := r.charging(t); kw != 7 || !complete {
		t.Fatalf("charging %.1f kW complete=%v, want the newest 7 kW", kw, complete)
	}
}

// TestAStartFromTheFutureNoLongerLocksTheConnector is W-09 (audit probe A3):
// one start dated two hours ahead (a station without a clock after a power
// cut, local time without a zone) became the connector's watermark, and every
// later, correct start was refused - across box restarts. The watermark runs
// on the box clock now; the station time only identifies a replay.
func TestAStartFromTheFutureNoLongerLocksTheConnector(t *testing.T) {
	now := time.Date(2026, 10, 26, 11, 0, 0, 0, time.UTC)
	r := newClockRig(t, now)
	future := now.Add(2 * time.Hour)
	tx := r.start(t, future, 100)
	if tx == 0 {
		t.Fatal("the future-dated start itself was refused")
	}
	c, _ := r.s.Snapshot().ChargerByID("CP")
	if got := c.ConnectorByID(1).Session.StartedAt; !got.Equal(now) {
		t.Fatalf("session dated %v, want the box clock %v", got, now)
	}
	r.advance(time.Minute)
	r.stop(t, tx, future.Add(time.Minute))
	if again := r.start(t, future, 100); again != 0 {
		t.Fatal("a replay of the closed start resurrected the session")
	}

	r.advance(time.Minute)
	next := r.start(t, r.clock(), 200)
	if next == 0 {
		t.Fatal("a correct start after the future-dated one was refused")
	}
	r.advance(time.Minute)
	r.stop(t, next, r.clock())

	r.reopen(t)
	r.advance(time.Minute)
	if r.start(t, r.clock(), 300) == 0 {
		t.Fatal("after a box restart a correct start was refused")
	}
}

// TestAPoisonedWatermarkIsHealedOnLoad: a watermark persisted by a box before
// W-09 still holds the station's future time; loading it must not keep the
// connector locked.
func TestAPoisonedWatermarkIsHealedOnLoad(t *testing.T) {
	now := time.Date(2026, 10, 26, 11, 0, 0, 0, time.UTC)
	r := newClockRig(t, now)
	r.s.mu.Lock()
	r.s.startWatermarks["CP#1"] = startWatermark{At: now.Add(2 * time.Hour), MeterStartWh: 100, TagRef: r.s.tagRefOf("card")}
	if err := r.s.persistLocked(); err != nil {
		t.Fatal(err)
	}
	r.s.mu.Unlock()
	r.reopen(t)
	if r.start(t, now.Add(2*time.Hour), 100) != 0 {
		t.Fatal("the old start's replay was accepted after the healing")
	}
	if r.start(t, now, 200) == 0 {
		t.Fatal("a correct start after a poisoned watermark was refused")
	}
}

// TestAWrongStationClockIsAskedToBeSet: from five seconds of skew the box
// asks the station for a Heartbeat - its answer carries the box clock - at
// most once per clockResyncEvery (W-09).
func TestAWrongStationClockIsAskedToBeSet(t *testing.T) {
	now := time.Date(2026, 10, 26, 11, 0, 0, 0, time.UTC)
	r := newClockRig(t, now)
	asked := func() (time.Time, bool) {
		r.s.mu.Lock()
		defer r.s.mu.Unlock()
		at, ok := r.s.clockResyncAt["CP"]
		return at, ok
	}
	r.s.observeStationClock("CP", now.Add(2*time.Second), now)
	if _, ok := asked(); ok {
		t.Fatal("two seconds of skew are rounding, not a wrong clock")
	}
	r.s.observeStationClock("CP", now.Add(2*time.Hour), now)
	if at, ok := asked(); !ok || !at.Equal(now) {
		t.Fatal("a station two hours ahead was not asked to set its clock")
	}
	r.s.observeStationClock("CP", now.Add(2*time.Hour), now.Add(time.Minute))
	if at, _ := asked(); !at.Equal(now) {
		t.Fatal("the station was asked again within the pacing")
	}
	r.s.observeStationClock("CP", now.Add(-time.Minute), now.Add(clockResyncEvery))
	if at, _ := asked(); !at.Equal(now.Add(clockResyncEvery)) {
		t.Fatal("a still-wrong clock was not asked again after the pacing")
	}
}
