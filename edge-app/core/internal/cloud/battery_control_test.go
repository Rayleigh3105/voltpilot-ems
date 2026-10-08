package cloud

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

// The `battery_control` block on the wire (contract
// docs/contracts/speicher-steuerstand.md): it rides EVERY heartbeat, also
// without a `control` block - that is the point, because the `control` block
// only exists with a readback and Edge Light never reads back.

func connectedLinkWithBatteryControl(
	t *testing.T, s *statusSink, fn func() *BatteryControlSummary,
) *Link {
	t.Helper()
	l, err := New(Options{
		Identity: enroll.Identity{
			TenantID: testTenant, SiteID: testSite, DeviceID: testDevice,
		},
		DevURL:           "tcp://" + s.addr,
		DevClientID:      "vp-status-test-battery-control",
		BatteryControlFn: fn,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	l.Connect()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if l.Connected() {
			return l
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("link did not connect to the in-process broker")
	return nil
}

func TestHeartbeatCarriesTheBatteryControlBlockWithoutAnyReadback(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLinkWithBatteryControl(t, sink, func() *BatteryControlSummary {
		return &BatteryControlSummary{State: "beobachtet", ControlEnabled: false, Certified: false}
	})
	// No `control` block: the box has no readback (Edge Light).
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil,
		nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	hb := sink.last(t)
	if _, ok := hb["control"]; ok {
		t.Fatal("precondition: no control block without a readback")
	}
	b, ok := hb["battery_control"].(map[string]any)
	if !ok {
		t.Fatalf("battery_control block missing: %v", hb["battery_control"])
	}
	// The flags travel as booleans, even when false - a reader must never
	// have to guess what an absent flag meant.
	if b["state"] != "beobachtet" || b["control_enabled"] != false || b["certified"] != false {
		t.Fatalf("battery_control = %v", b)
	}
	if len(b) != 3 {
		t.Fatalf("battery_control carries exactly the contract fields, got %v", b)
	}
}

func TestHeartbeatOmitsTheBatteryControlBlockWhenTheBoxKnowsNothing(t *testing.T) {
	sink := startStatusSink(t)
	for _, fn := range []func() *BatteryControlSummary{nil, func() *BatteryControlSummary { return nil }} {
		link := connectedLinkWithBatteryControl(t, sink, fn)
		if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil,
			nil, nil, nil, nil); err != nil {
			t.Fatal(err)
		}
		if _, ok := sink.last(t)["battery_control"]; ok {
			t.Fatal("no inverter selected must send NO battery_control block")
		}
	}
}
