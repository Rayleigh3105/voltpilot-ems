package ebyte

import (
	"context"
	"net"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ebyte/ebytesim"
)

// simClient starts a simulator and returns a client whose dialer reaches it
// while the Config keeps a real LAN address (the LAN rule stays exercised).
func simClient(t *testing.T, sim *ebytesim.Sim) (Client, Config) {
	t.Helper()
	addr, err := sim.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sim.Close)
	dial := func(ctx context.Context, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", addr)
	}
	return Client{Dial: dial}, Config{IP: "192.168.3.50"}
}

func hostOnly() *ebytesim.Sim { return ebytesim.New([]string{ebytesim.HostSlot}, 8, 8) }

func TestParseModuleDecodesTheDocumentedModelCodes(t *testing.T) {
	cases := []struct {
		model          string
		di, ai, do, ao int
		doKind, aiKind string
	}{
		{"M31-AXAX8080G-U", 8, 0, 8, 0, "relay", ""},
		{"GAXAX8080-U", 8, 0, 8, 0, "relay", ""}, // the slave-table spelling of the bench host
		{"M31-AFAX4440G-U", 4, 4, 4, 0, "relay", "current_differential"},
		{"M31-AXXXA000G-U", 16, 0, 0, 0, "", ""},
		{"M31-AXEX8080G-U", 8, 0, 8, 0, "transistor", ""},
		{"M31-XXAX00A0G-U", 0, 0, 16, 0, "relay", ""},
		{"M31-XXEX00A0G-U", 0, 0, 16, 0, "transistor", ""},
		{"M31-XAXX0A00G-U", 0, 16, 0, 0, "", "current_single"},
		{"M31-XDXX0600G-U", 0, 6, 0, 0, "", "pt100"},
		{"M31-XXXA0008G-U", 0, 0, 0, 8, "", ""},
	}
	for _, c := range cases {
		m, ok := ParseModule(c.model)
		if !ok {
			t.Fatalf("%s: not parsed", c.model)
		}
		if m.DI != c.di || m.AI != c.ai || m.DO != c.do || m.AO != c.ao || m.DOKind != c.doKind || m.AIKind != c.aiKind {
			t.Fatalf("%s: got %+v", c.model, m)
		}
	}
	for _, bad := range []string{"NONE", "", "M31-AXAX8G-U", "AXAX8000", "M31-AXAX0080G-U"} {
		if _, ok := ParseModule(bad); ok {
			t.Fatalf("%q must not parse", bad)
		}
	}
}

func TestIdentifyReadsTheBenchHostAndProvesItsChannelCount(t *testing.T) {
	cl, cfg := simClient(t, hostOnly())
	id, de := cl.Identify(context.Background(), cfg)
	if de != nil {
		t.Fatal(de)
	}
	if id.Model != "M31-AXAX8080G-U" || id.Firmware != "9232-0-13" || id.MAC != "00:54:2c:84:9b:90" {
		t.Fatalf("identity %+v", id)
	}
	if id.DI != 8 || id.DO != 8 || !id.Proven || len(id.Modules) != 1 {
		t.Fatalf("stack %+v", id)
	}
}

func TestExpansionModulesContinueTheAddressesInSlotOrder(t *testing.T) {
	sim := ebytesim.New([]string{ebytesim.HostSlot, "XXAX00A0-U", "AXXXA000-U", "XDXX0600-U"}, 8+16, 8+16)
	cl, cfg := simClient(t, sim)
	id, st, de := cl.Read(context.Background(), cfg)
	if de != nil {
		t.Fatal(de)
	}
	if id.DI != 24 || id.DO != 24 || !id.Proven || len(st.Inputs) != 24 || len(st.Outputs) != 24 {
		t.Fatalf("id %+v state %+v", id, st)
	}
	if len(id.Unsupported) != 1 || id.Unsupported[0] != "XDXX0600-U" {
		t.Fatalf("the PT100 module must be named as not read: %+v", id.Unsupported)
	}
	// DO17 is the first relay of the 16-DO module (coil 16).
	cfg.MAC = id.MAC
	if _, st, de = cl.SetOutput(context.Background(), cfg, 17, true); de != nil {
		t.Fatal(de)
	}
	if !sim.Outputs()[16] || !st.Outputs[16] {
		t.Fatal("DO17 must be coil 16")
	}
}

func TestAStackThatDoesNotMatchItsSlotTableIsNeverWritten(t *testing.T) {
	// The table claims a 16-DO module, but the device only answers 20 coils.
	sim := ebytesim.New([]string{ebytesim.HostSlot, "XXAX00A0-U"}, 8, 20)
	cl, cfg := simClient(t, sim)
	id, de := cl.Identify(context.Background(), cfg)
	if de != nil {
		t.Fatal(de)
	}
	if id.Proven {
		t.Fatal("a count that does not match the address boundary must not be proven")
	}
	if _, _, de = cl.Read(context.Background(), cfg); de == nil || de.Code != ErrChannelUnknown {
		t.Fatalf("an unproven stack must not be read: %v", de)
	}
	if _, _, de = cl.SetOutput(context.Background(), cfg, 1, true); de == nil || de.Code != ErrChannelUnknown {
		t.Fatalf("expected channel_unknown, got %v", de)
	}
	if sim.Writes != 0 {
		t.Fatal("nothing may be written to an unproven stack")
	}
}

func TestPendingNegotiationIsReportedAndNeverWritten(t *testing.T) {
	sim := hostOnly()
	sim.Pending = true
	cl, cfg := simClient(t, sim)
	if _, _, de := cl.Read(context.Background(), cfg); de == nil || de.Code != ErrNegotiationPending {
		t.Fatalf("expected negotiation_pending, got %v", de)
	}
	if _, _, de := cl.SetOutput(context.Background(), cfg, 1, true); de == nil || de.Code != ErrNegotiationPending {
		t.Fatalf("expected negotiation_pending, got %v", de)
	}
	if sim.Writes != 0 {
		t.Fatal("no write while negotiation is pending")
	}
}

func TestAForeignDeviceBehindThePinnedAddressIsNeverSwitched(t *testing.T) {
	sim := hostOnly()
	cl, cfg := simClient(t, sim)
	cfg.MAC = "00-54-2C-00-00-01"
	_, _, de := cl.SetOutput(context.Background(), cfg, 1, true)
	if de == nil || de.Code != ErrIdentityMismatch {
		t.Fatalf("expected identity_mismatch, got %v", de)
	}
	if sim.Writes != 0 {
		t.Fatal("no write to a foreign device")
	}
	if _, _, de = cl.Read(context.Background(), cfg); de == nil || de.Code != ErrIdentityMismatch {
		t.Fatalf("a foreign reading must not be attributed: %v", de)
	}
}

func TestSetOutputSwitchesExactlyOneRelayAndReadsBack(t *testing.T) {
	sim := hostOnly()
	cl, cfg := simClient(t, sim)
	cfg.MAC = "00:54:2C:84:9B:90"
	for ch := 1; ch <= 8; ch++ {
		_, st, de := cl.SetOutput(context.Background(), cfg, ch, true)
		if de != nil {
			t.Fatal(de)
		}
		for i, on := range st.Outputs {
			if on != (i == ch-1) {
				t.Fatalf("DO%d on: outputs %v", ch, st.Outputs)
			}
		}
		if _, _, de = cl.SetOutput(context.Background(), cfg, ch, false); de != nil {
			t.Fatal(de)
		}
	}
	for _, ch := range []int{0, 9, -1} {
		if _, _, de := cl.SetOutput(context.Background(), cfg, ch, true); de == nil || de.Code != ErrChannelUnknown {
			t.Fatalf("channel %d: expected channel_unknown, got %v", ch, de)
		}
	}
}

func TestPulseModeOutputsAreNotUsedAsConsumerSwitches(t *testing.T) {
	sim := hostOnly()
	sim.SetHold(0x32C8+2, 1) // DO3 in pulse mode
	cl, cfg := simClient(t, sim)
	if _, _, de := cl.SetOutput(context.Background(), cfg, 3, true); de == nil || de.Code != ErrInvalidRequest {
		t.Fatalf("expected refusal, got %v", de)
	}
	if sim.Writes != 0 {
		t.Fatal("no write in pulse mode")
	}
}

func TestArmWatchdogConfiguresEveryOutputAndRestartsOnlyWhileAllAreOff(t *testing.T) {
	sim := hostOnly()
	cl, cfg := simClient(t, sim)
	sim.SetOutput(4, true)
	if _, de := cl.ArmWatchdog(context.Background(), cfg, WatchdogSetup{}); de == nil {
		t.Fatal("a running output must block the restart")
	}
	if sim.Restarts != 0 || sim.Hold(0x0C36) != 0 {
		t.Fatal("nothing may be configured while an output is on")
	}
	sim.SetOutput(4, false)
	if _, de := cl.ArmWatchdog(context.Background(), cfg, WatchdogSetup{}); de != nil {
		t.Fatal(de)
	}
	if sim.Restarts != 1 || sim.Hold(0x0C35) != DefaultOfflineTenths || sim.Hold(0x0C36) != 1 {
		t.Fatalf("restarts %d offline %d enable %d", sim.Restarts, sim.Hold(0x0C35), sim.Hold(0x0C36))
	}
	_, st, de := cl.Read(context.Background(), cfg)
	if de != nil {
		t.Fatal(de)
	}
	if !st.Watchdog.Armed() {
		t.Fatalf("watchdog %+v", st.Watchdog)
	}
}

func TestAPublicAddressIsRefusedBeforeDialing(t *testing.T) {
	dialed := false
	cl := Client{Dial: func(context.Context, string) (net.Conn, error) { dialed = true; return nil, net.ErrClosed }}
	if _, de := cl.Identify(context.Background(), Config{IP: "8.8.8.8"}); de == nil || de.Code != ErrInvalidRequest {
		t.Fatalf("expected invalid_request, got %v", de)
	}
	if dialed {
		t.Fatal("a public address must never be dialed")
	}
}
