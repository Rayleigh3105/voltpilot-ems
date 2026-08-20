package csms_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

// quiet keeps the library's and our own chatter out of the test output while
// still exercising the real logging path.
func quiet() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// startServer boots a real CSMS on a free port with the given ids allowed.
func startServer(t *testing.T, ids ...string) (*csms.Server, string) {
	t.Helper()
	s, err := csms.New(csms.Options{
		Enabled: true,
		DataDir: t.TempDir(),
		Log:     quiet(),
	})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	for _, id := range ids {
		if _, err := s.Add(csms.AddRequest{ID: id}); err != nil {
			t.Fatalf("add %s: %v", id, err)
		}
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(s.Stop)
	snap := s.Snapshot()
	if !snap.Listening {
		t.Fatalf("server not listening: %+v", snap)
	}
	return s, fmt.Sprintf("ws://127.0.0.1:%d%s", snap.Port, snap.URLPath)
}

// connectCP dials a real ocpp-go charge point at the endpoint.
//
// NOTE the ocpp-go CLIENT appends its own id to the base URL it is given
// (ocppj.Client.Start), so it is handed the BASE endpoint. A real station in
// the field is configured with the FULL url including its ChargePointId -
// which is exactly what Server.EndpointFor renders for the setup surface.
func connectCP(t *testing.T, endpoint, id string) (ocpp16.ChargePoint, func()) {
	t.Helper()
	cp := ocpp16.NewChargePoint(id, nil, nil)
	if err := cp.Start(endpoint); err != nil {
		t.Fatalf("charge point %s could not connect to %s: %v", id, endpoint+"/"+id, err)
	}
	// The library's Stop closes an unguarded channel, so a second call panics;
	// one guarded stop serves both the test body and the cleanup.
	stop := sync.OnceFunc(cp.Stop)
	t.Cleanup(stop)
	return cp, stop
}

// waitFor polls cond for up to a second; the CSMS state is updated by the
// library's reader goroutine, so a request's effect lands a moment after its
// confirmation.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// TestRegisteredChargePointCompletesAFullSession is the PR-1 headline: a real
// OCPP 1.6J station connects to the box, announces itself, opens a
// transaction, reports meter values and closes it again - and every step is
// visible in the plain-typed snapshot the rest of the product reads.
func TestRegisteredChargePointCompletesAFullSession(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	cp, _ := connectCP(t, endpoint, "SAEULE-1")

	boot, err := cp.BootNotification("DC-240", "AnyVendor", func(r *core.BootNotificationRequest) {
		r.FirmwareVersion = "1.2.3"
		r.ChargePointSerialNumber = "SN-0001"
	})
	if err != nil {
		t.Fatalf("boot: %v", err)
	}
	if boot.Status != core.RegistrationStatusAccepted {
		t.Fatalf("boot status = %v, want Accepted", boot.Status)
	}
	if boot.Interval != int(csms.DefaultHeartbeatInterval/time.Second) {
		t.Fatalf("heartbeat interval = %d, want %d", boot.Interval, int(csms.DefaultHeartbeatInterval/time.Second))
	}

	waitFor(t, "boot recorded", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		return c.Connected && c.Vendor == "AnyVendor" && c.Model == "DC-240" &&
			c.Firmware == "1.2.3" && c.Serial == "SN-0001"
	})

	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusPreparing); err != nil {
		t.Fatalf("status: %v", err)
	}
	waitFor(t, "connector status", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		con := c.ConnectorByID(1)
		return con != nil && con.Status == csms.StatusPreparing
	})

	auth, err := cp.Authorize("TAG-123")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if auth.IdTagInfo.Status != types.AuthorizationStatusAccepted {
		t.Fatalf("authorize = %v, want Accepted (scope fence E4: Lastmanagement pur)", auth.IdTagInfo.Status)
	}

	start, err := cp.StartTransaction(1, "TAG-123", 1000, types.NewDateTime(time.Now()))
	if err != nil {
		t.Fatalf("start transaction: %v", err)
	}
	if start.TransactionId <= 0 {
		t.Fatalf("transaction id = %d, want a positive id", start.TransactionId)
	}

	if _, err := cp.MeterValues(1, []types.MeterValue{{
		Timestamp: types.NewDateTime(time.Now()),
		SampledValue: []types.SampledValue{
			{Value: "41000", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW},
			{Value: "12500", Measurand: types.MeasurandEnergyActiveImportRegister, Unit: types.UnitOfMeasureWh},
			{Value: "64", Measurand: types.MeasurandSoC, Unit: types.UnitOfMeasurePercent},
		},
	}}); err != nil {
		t.Fatalf("meter values: %v", err)
	}
	waitFor(t, "meter values", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		con := c.ConnectorByID(1)
		return con != nil && con.PowerKw != nil && *con.PowerKw == 41 &&
			con.EnergyKwh != nil && *con.EnergyKwh == 12.5 &&
			con.SocPct != nil && *con.SocPct == 64 &&
			con.Session != nil && con.Session.TransactionID == start.TransactionId
	})

	if _, err := cp.StopTransaction(20000, types.NewDateTime(time.Now()), start.TransactionId); err != nil {
		t.Fatalf("stop transaction: %v", err)
	}
	waitFor(t, "session closed", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		con := c.ConnectorByID(1)
		// The session is gone AND the stale power reading with it - a
		// connector with no vehicle must not keep showing 41 kW.
		return con != nil && con.Session == nil && con.PowerKw == nil
	})
}

// TestAnUnregisteredChargePointIsRefused proves the pairing rule: the
// allowlist is the admission decision and it happens at the websocket upgrade,
// before any handler sees the station.
func TestAnUnregisteredChargePointIsRefused(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")

	cp := ocpp16.NewChargePoint("FREMDE-SAEULE", nil, nil)
	err := cp.Start(endpoint)
	if err == nil {
		cp.Stop()
		t.Fatal("an unregistered charge point was allowed to connect")
	}
	if len(s.Snapshot().Chargers) != 1 {
		t.Fatalf("the refused station must not appear in the snapshot: %+v", s.Snapshot().Chargers)
	}
}

// TestRemovingAChargePointRevokesIt: removal is a revocation, not a cosmetic
// list edit - the station is dropped and cannot come back.
func TestRemovingAChargePointRevokesIt(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	cp, _ := connectCP(t, endpoint, "SAEULE-1")
	if _, err := cp.BootNotification("m", "v"); err != nil {
		t.Fatalf("boot: %v", err)
	}
	waitFor(t, "connected", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		return c.Connected
	})

	if err := s.Remove("SAEULE-1"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if len(s.Snapshot().Chargers) != 0 {
		t.Fatal("removed charge point still listed")
	}
	waitFor(t, "socket dropped", func() bool { return !cp.IsConnected() })

	again := ocpp16.NewChargePoint("SAEULE-1", nil, nil)
	if err := again.Start(endpoint); err == nil {
		again.Stop()
		t.Fatal("a revoked charge point could reconnect")
	}
	if err := s.Remove("SAEULE-1"); err != csms.ErrNotFound {
		t.Fatalf("second remove = %v, want ErrNotFound", err)
	}
}

// TestVendorStringsNeverReachTheMechanism is the herstellerneutral guard
// (Konzept §0, VERBINDLICH). Two stations with wildly different self-reported
// vendor/model/firmware produce a BYTE-IDENTICAL mechanism state once their
// display-only identity fields are blanked: nothing in this package branches
// on who made the box.
func TestVendorStringsNeverReachTheMechanism(t *testing.T) {
	strip := func(c csms.ChargerState) csms.ChargerState {
		c.Vendor, c.Model, c.Firmware, c.Serial = "", "", "", ""
		c.ID, c.Label = "", ""
		c.ConnectedAt, c.LastSeen, c.BootedAt, c.AddedAt = time.Time{}, time.Time{}, time.Time{}, time.Time{}
		for i := range c.Connectors {
			c.Connectors[i].MeteredAt = time.Time{}
			if c.Connectors[i].Session != nil {
				c.Connectors[i].Session.StartedAt = time.Time{}
				// The transaction id is a monotonic counter, not a vendor fact.
				c.Connectors[i].Session.TransactionID = 0
			}
		}
		return c
	}

	s, endpoint := startServer(t, "A", "B")
	drive := func(id, vendor, model, fw string) {
		cp, _ := connectCP(t, endpoint, id)
		if _, err := cp.BootNotification(model, vendor, func(r *core.BootNotificationRequest) {
			r.FirmwareVersion = fw
		}); err != nil {
			t.Fatalf("boot %s: %v", id, err)
		}
		if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusCharging); err != nil {
			t.Fatalf("status %s: %v", id, err)
		}
		if _, err := cp.StartTransaction(1, "TAG", 0, types.NewDateTime(time.Now())); err != nil {
			t.Fatalf("start %s: %v", id, err)
		}
		if _, err := cp.MeterValues(1, []types.MeterValue{{
			Timestamp:    types.NewDateTime(time.Now()),
			SampledValue: []types.SampledValue{{Value: "7400", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}},
		}}); err != nil {
			t.Fatalf("meter %s: %v", id, err)
		}
	}
	drive("A", "Midapower", "OEM-240kW", "MP-4.1")
	drive("B", "AnderesWerk", "Wallbox-XYZ", "0.0.1-beta")

	waitFor(t, "both stations reported", func() bool {
		snap := s.Snapshot()
		if len(snap.Chargers) != 2 {
			return false
		}
		for _, c := range snap.Chargers {
			con := c.ConnectorByID(1)
			if con == nil || con.PowerKw == nil || con.Session == nil {
				return false
			}
		}
		return true
	})

	snap := s.Snapshot()
	// JSON, not %+v: the state carries pointers, whose ADDRESSES would differ
	// for reasons that have nothing to do with a vendor.
	enc := func(c csms.ChargerState) string {
		raw, err := json.Marshal(strip(c))
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		return string(raw)
	}
	a, b := enc(snap.Chargers[0]), enc(snap.Chargers[1])
	if a != b {
		t.Fatalf("the mechanism state differs between two vendors:\n A: %s\n B: %s", a, b)
	}
	// ... and the vendor facts ARE recorded, just never acted on.
	if snap.Chargers[0].Vendor == snap.Chargers[1].Vendor {
		t.Fatal("the two stations' vendor strings should have been recorded verbatim")
	}
}

// TestTransactionIdsSurviveARestart: OCPP wants transaction ids unique per
// central system. A box that forgot them across a reboot would re-issue an id
// a station still holds for a running session.
func TestTransactionIdsSurviveARestart(t *testing.T) {
	dir := t.TempDir()
	newServer := func() *csms.Server {
		s, err := csms.New(csms.Options{Enabled: true, DataDir: dir, Log: quiet()})
		if err != nil {
			t.Fatalf("new: %v", err)
		}
		return s
	}

	s1 := newServer()
	if _, err := s1.Add(csms.AddRequest{ID: "SAEULE-1", Label: "Hof Nord"}); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := s1.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	snap := s1.Snapshot()
	endpoint := fmt.Sprintf("ws://127.0.0.1:%d%s", snap.Port, snap.URLPath)
	cp, stopCP := connectCP(t, endpoint, "SAEULE-1")
	first, err := cp.StartTransaction(1, "TAG", 0, types.NewDateTime(time.Now()))
	if err != nil {
		t.Fatalf("start transaction: %v", err)
	}
	stopCP()
	s1.Stop()

	s2 := newServer()
	list := s2.List()
	if len(list) != 1 || list[0].ID != "SAEULE-1" || list[0].Label != "Hof Nord" {
		t.Fatalf("allowlist did not survive the restart: %+v", list)
	}
	if err := s2.Start(context.Background()); err != nil {
		t.Fatalf("restart: %v", err)
	}
	defer s2.Stop()
	snap2 := s2.Snapshot()
	cp2, _ := connectCP(t, fmt.Sprintf("ws://127.0.0.1:%d%s", snap2.Port, snap2.URLPath), "SAEULE-1")
	second, err := cp2.StartTransaction(1, "TAG", 0, types.NewDateTime(time.Now()))
	if err != nil {
		t.Fatalf("start transaction after restart: %v", err)
	}
	if second.TransactionId <= first.TransactionId {
		t.Fatalf("transaction id %d after restart is not beyond %d", second.TransactionId, first.TransactionId)
	}
}

// TestADisconnectKeepsTheRecordedSessionAndSaysWhy: a dropped socket says
// nothing about what the station is physically doing. The OCPP dead-man's
// switch is what makes that safe - inventing "everything stopped" here would
// be a claim nobody measured.
func TestADisconnectKeepsTheRecordedSessionAndSaysWhy(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	cp, stopCP := connectCP(t, endpoint, "SAEULE-1")
	if _, err := cp.StartTransaction(1, "TAG", 0, types.NewDateTime(time.Now())); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitFor(t, "session open", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		con := c.ConnectorByID(1)
		return con != nil && con.Session != nil
	})

	stopCP()
	waitFor(t, "disconnect recorded", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		return !c.Connected
	})
	c, _ := s.Snapshot().ChargerByID("SAEULE-1")
	if con := c.ConnectorByID(1); con == nil || con.Session == nil {
		t.Fatal("the recorded session must survive the socket loss")
	}
}

// TestDisabledServerIsInertAndHonest: with VP_OCPP_ENABLED off nothing binds a
// port, and the snapshot says so rather than looking like an empty plant.
func TestDisabledServerIsInertAndHonest(t *testing.T) {
	s, err := csms.New(csms.Options{Enabled: false, DataDir: t.TempDir(), Log: quiet()})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("start with the flag off must be a no-op: %v", err)
	}
	snap := s.Snapshot()
	if snap.Enabled || snap.Listening || snap.Port != 0 {
		t.Fatalf("disabled server is not inert: %+v", snap)
	}
	if snap.Chargers == nil {
		t.Fatal("the charger list must be an empty list, never null")
	}
	s.Stop() // must not panic
}

// TestChangedCoalescesABurst: the allocator wants ONE wake-up per burst, not a
// queue (the OTA-blocker lesson - a per-event signal is noise).
func TestChangedCoalescesABurst(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	// Drain the notification the Add produced.
	select {
	case <-s.Changed():
	default:
	}
	cp, _ := connectCP(t, endpoint, "SAEULE-1")
	for i := 0; i < 5; i++ {
		if _, err := cp.MeterValues(1, []types.MeterValue{{
			Timestamp:    types.NewDateTime(time.Now()),
			SampledValue: []types.SampledValue{{Value: fmt.Sprint(1000 * i), Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}},
		}}); err != nil {
			t.Fatalf("meter %d: %v", i, err)
		}
	}
	waitFor(t, "a wake-up", func() bool {
		select {
		case <-s.Changed():
			return true
		default:
			return false
		}
	})
	// After consuming one, at most one more may be pending; never five.
	select {
	case <-s.Changed():
	default:
	}
	select {
	case <-s.Changed():
		t.Fatal("the change channel queued more than one wake-up for a burst")
	case <-time.After(50 * time.Millisecond):
	}
}
