package csms_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

func TestStopDrainsActiveStationBeforeClosingTransportLifecycle(t *testing.T) {
	s, endpoint := lifecycleServer(t, nil, "SHUTDOWN-RACE")
	stopServer := sync.OnceFunc(s.Stop)
	t.Cleanup(stopServer)
	cp := ocpp16.NewChargePoint("SHUTDOWN-RACE", nil, nil)
	cpStop := sync.OnceFunc(cp.Stop)
	t.Cleanup(cpStop)
	if err := cp.Start(endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := cp.BootNotification("model", "vendor"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "active station", func() bool {
		station, ok := s.Snapshot().ChargerByID("SHUTDOWN-RACE")
		return ok && station.Connected
	})

	// Under -race this is the exact lifecycle boundary that used to let
	// ocpp-go's writePump read errC while WsServer.Stop closed and nilled it.
	stopServer()
	waitFor(t, "station disconnected by server stop", func() bool { return !cp.IsConnected() })
	if s.Snapshot().Listening {
		t.Fatal("server still reports listening after Stop")
	}
}

func TestOcppSampledValueKeepsWideWireDigitsBeforeMeasurementRuntime(t *testing.T) {
	received := make(chan []csms.SampledReading, 1)
	s, endpoint := lifecycleServer(t, func(samples []csms.SampledReading, _ time.Time) {
		received <- samples
	}, "WIDE-OCPP")
	t.Cleanup(s.Stop)
	cp := ocpp16.NewChargePoint("WIDE-OCPP", nil, nil)
	cpStop := sync.OnceFunc(cp.Stop)
	t.Cleanup(cpStop)
	if err := cp.Start(endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := cp.MeterValues(1, []types.MeterValue{{
		Timestamp: types.NewDateTime(time.Now()),
		SampledValue: []types.SampledValue{{
			Value: "9007199254740993", Measurand: types.MeasurandEnergyActiveImportRegister,
			Unit: types.UnitOfMeasureWh,
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	select {
	case samples := <-received:
		if len(samples) != 1 || samples[0].Value != "9007199254740993" {
			t.Fatalf("CSMS sampled-value boundary changed raw digits: %#v", samples)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for sampled value")
	}
}

func lifecycleServer(t *testing.T, onSamples func([]csms.SampledReading, time.Time), id string) (*csms.Server, string) {
	t.Helper()
	s, err := csms.New(csms.Options{
		Enabled: true, DataDir: t.TempDir(), Log: quiet(), OnSampledValues: onSamples,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Add(csms.AddRequest{ID: id}); err != nil {
		t.Fatal(err)
	}
	if err = s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	snapshot := s.Snapshot()
	return s, "ws://127.0.0.1:" + fmt.Sprint(snapshot.Port) + snapshot.URLPath
}
