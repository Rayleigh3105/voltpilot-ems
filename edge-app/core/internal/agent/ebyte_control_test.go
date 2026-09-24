package agent

// Integration tests for the Ebyte M31 I/O module against the in-process
// simulator (internal/ebyte/ebytesim): one device entity + channel-bound
// consumer entities -> arbitrated wish -> watchdog gate -> ONE relay write ->
// readback; stale = OFF; flags off = zero writes; a foreign device or a
// changed module layout is never switched; the source poll publishes the
// input/output states; the connection test pins the device.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ebyte"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ebyte/ebytesim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
)

const (
	ioModuleID = "io-m31"
	ioRodID    = "rod-on-do3"
	ioPumpID   = "pump-on-do4"
	ioIP       = "192.168.3.50"
)

func ioRegistry(mac string) entities.Registry {
	maxKw := 3.0
	dev := entities.Entity{ID: ioModuleID, Type: "io-module", Label: "I/O-Modul",
		Guards: entities.Guards{Failsafe: entities.Failsafe{Behavior: "measure-only"}},
		Driver: json.RawMessage(fmt.Sprintf(`{"brand":"ebyte","model":"m31_axax8080g_u","communication":"ebyte_modbus_tcp",
		  "connection":{"ip":%q,"port":502,"unit_id":1,"mac":%q}}`, ioIP, mac)),
		EdgeSourceID: "src-io"}
	consumer := func(id, typ string, ch int) entities.Entity {
		return entities.Entity{ID: id, Type: typ,
			Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{{Command: entities.CmdOnOff}}},
			Guards: entities.Guards{Limits: entities.GuardLimits{MaxConsumptionKw: &maxKw},
				Failsafe: entities.Failsafe{Behavior: "off"}},
			Driver: json.RawMessage(fmt.Sprintf(
				`{"communication":"ebyte_modbus_tcp","io_entity_id":%q,"channel":%d}`, ioModuleID, ch)),
		}
	}
	return entities.Registry{Revision: "rev-io", Entities: []entities.Entity{
		dev, consumer(ioRodID, entities.TypeHeatingRod, 3), consumer(ioPumpID, entities.TypeGenericLoad, 4)}}
}

// ioAgent wires a minimal agent whose ebyte dialer reaches the simulator.
func ioAgent(t *testing.T, sim *ebytesim.Sim, reg entities.Registry, arb *desired.Arbiter) *Agent {
	t.Helper()
	addr, err := sim.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sim.Close)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.ControlEnabled = true
	cfg.ConsumerControlEnabled = true
	return &Agent{Cfg: cfg, entRegistry: reg, arb: arb, invCat: inverter.DefaultCatalog(),
		ebyteDial: func(ctx context.Context, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", addr)
		}}
}

func armedSim() *ebytesim.Sim {
	sim := ebytesim.New([]string{ebytesim.HostSlot}, 8, 8)
	sim.SetHold(0x0C35, 600)
	sim.SetHold(0x0C36, 1)
	for i := 0; i < 8; i++ {
		sim.SetHold(uint16(0x1B58+i), 1)
	}
	return sim
}

func TestEbyteChannelConsumerSwitchesExactlyItsRelayWithReadback(t *testing.T) {
	sim := armedSim()
	reg := ioRegistry("00:54:2c:84:9b:90")
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, ioRodID, true, "r1")
	submitOnOffWish(arb, ioPumpID, false, "r2")

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	readbacks, sub := busObserver(t, addr, "io-rb", entities.ReadbackTopic(ioRodID))
	defer sub.Disconnect(0)

	a := ioAgent(t, sim, reg, arb)
	a.Bus = bus
	a.runEbyteControlPass(context.Background(), time.Now())

	out := sim.Outputs()
	for i, on := range out {
		if on != (i == 2) {
			t.Fatalf("only DO3 may be on, got %v", out)
		}
	}
	waitFor(t, 3*time.Second, "readback published", func() bool { return len(readbacks()) > 0 })
	rb := readbacks()[len(readbacks())-1]
	if rb["all_match"] != true || rb["adapter"] != "ebyte_modbus_tcp" || rb["channel"] != 3.0 || rb["on"] != true {
		t.Fatalf("unexpected readback: %v", rb)
	}

	// An unchanged plan inside the re-assert window writes nothing more.
	writes := sim.Writes
	a.runEbyteControlPass(context.Background(), time.Now())
	if sim.Writes != writes {
		t.Fatalf("an unchanged, in-sync channel must not be re-written (%d -> %d)", writes, sim.Writes)
	}
	// A relay switched off behind the executor's back is corrected at once.
	sim.SetOutput(2, false)
	a.runEbyteControlPass(context.Background(), time.Now())
	if !sim.Outputs()[2] {
		t.Fatal("a deviating relay must be driven back to its plan")
	}
}

func TestEbyteWithoutDeviceWatchdogArmsItFirstAndNeverSwitchesOnUnguarded(t *testing.T) {
	sim := ebytesim.New([]string{ebytesim.HostSlot}, 8, 8) // factory: watchdog off
	reg := ioRegistry("00:54:2c:84:9b:90")
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, ioRodID, true, "r1")
	a := ioAgent(t, sim, reg, arb)

	now := time.Now()
	a.runEbyteControlPass(context.Background(), now)
	if sim.Restarts != 1 || sim.Hold(0x0C36) != 1 || sim.Hold(0x0C35) != ebyte.DefaultOfflineTenths {
		t.Fatalf("the watchdog must be armed first: restarts=%d enable=%d", sim.Restarts, sim.Hold(0x0C36))
	}
	if sim.Outputs()[2] {
		t.Fatal("no ON in the pass that had to arm the watchdog")
	}
	a.runEbyteControlPass(context.Background(), now.Add(time.Second))
	if !sim.Outputs()[2] {
		t.Fatal("with the watchdog armed the ON must follow")
	}
}

func TestEbyteWatchdogIsNeverArmedWhileAnotherOutputRuns(t *testing.T) {
	sim := ebytesim.New([]string{ebytesim.HostSlot}, 8, 8)
	sim.SetOutput(6, true) // DO7 runs a load of another system
	reg := ioRegistry("00:54:2c:84:9b:90")
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, ioRodID, true, "r1")
	a := ioAgent(t, sim, reg, arb)
	a.runEbyteControlPass(context.Background(), time.Now())
	if sim.Restarts != 0 || !sim.Outputs()[6] || sim.Outputs()[2] {
		t.Fatalf("no restart while an output runs, no unguarded ON: restarts=%d outputs=%v", sim.Restarts, sim.Outputs())
	}
}

func TestEbyteStaleDecisionDrivesTheChannelOff(t *testing.T) {
	sim := armedSim()
	sim.SetOutput(2, true)
	reg := ioRegistry("00:54:2c:84:9b:90")
	a := ioAgent(t, sim, reg, minimalArbiter(reg)) // no wish at all
	a.runEbyteControlPass(context.Background(), time.Now())
	if sim.Outputs()[2] {
		t.Fatal("without a fresh decision the relay must be off")
	}
}

func TestEbyteFlagsOffMeansZeroModbus(t *testing.T) {
	sim := armedSim()
	reg := ioRegistry("00:54:2c:84:9b:90")
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, ioRodID, true, "r1")
	a := ioAgent(t, sim, reg, arb)
	a.Cfg.ConsumerControlEnabled = false
	a.runEbyteControlPass(context.Background(), time.Now())
	if sim.Writes != 0 || sim.Outputs()[2] {
		t.Fatal("consumer control off must not write")
	}
}

func TestEbyteForeignDeviceOrChangedLayoutIsNeverSwitched(t *testing.T) {
	sim := armedSim()
	reg := ioRegistry("00:54:2c:00:00:01") // the pinned MAC is another device
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, ioRodID, true, "r1")
	a := ioAgent(t, sim, reg, arb)
	a.runEbyteControlPass(context.Background(), time.Now())
	if sim.Writes != 0 {
		t.Fatal("a foreign device must never be switched")
	}

	// Box-side pin: first contact pins the layout, a renegotiated stack stops writes.
	reg2 := ioRegistry("")
	b := ioAgent(t, armedSim(), reg2, arb)
	b.ebyteDial = a.ebyteDial
	b.Cfg.DataDir = a.Cfg.DataDir
	b.runEbyteControlPass(context.Background(), time.Now())
	if !sim.Outputs()[2] {
		t.Fatal("first contact pins and switches")
	}
	sim.Slots = []string{ebytesim.HostSlot, "XXAX00A0-U"}
	sim.DO = append(sim.DO, make([]bool, 16)...)
	sim.SetOutput(2, false)
	writes := sim.Writes
	b.runEbyteControlPass(context.Background(), time.Now().Add(2*time.Minute))
	if sim.Writes != writes {
		t.Fatal("a changed module layout must stop every write until re-confirmed")
	}
	// The connection test is the operator's confirmation: it re-pins.
	res := b.ebyteTest(testconn.Request{Brand: "ebyte", Model: "m31_axax8080g_u",
		Connection: testconn.Connection{"ip": ioIP}})
	if !res.OK {
		t.Fatalf("test: %+v", res)
	}
	// The new module's outputs carry no fault state yet, so the device
	// watchdog no longer covers every relay: the executor re-arms it (restart,
	// all outputs off) and switches in the NEXT pass.
	b.runEbyteControlPass(context.Background(), time.Now().Add(10*time.Minute))
	if sim.Outputs()[2] || sim.Hold(0x1B58+23) != 1 {
		t.Fatalf("the watchdog must be re-armed over the new outputs first (DO3=%v)", sim.Outputs()[2])
	}
	b.runEbyteControlPass(context.Background(), time.Now().Add(11*time.Minute))
	if !sim.Outputs()[2] {
		t.Fatal("after the confirming test and the re-armed watchdog the channel is switched again")
	}
}

func TestEbyteSourcePollPublishesInputAndOutputStates(t *testing.T) {
	sim := armedSim()
	sim.SetInput(0, true)
	sim.SetOutput(7, true)
	reg := ioRegistry("00:54:2c:84:9b:90")
	a := ioAgent(t, sim, reg, minimalArbiter(reg))
	a.srcs = []sources.Source{{ID: "src-io", Role: sources.RoleConsumer, Brand: inverter.BrandEbyte,
		Communication: inverter.CommEbyteModbusTCP,
		Connection:    inverter.Connection{IP: ioIP, Port: 502, UnitID: 1}}}

	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	srcMsgs, sub1 := busObserver(t, addr, "io-src", sources.TopicPrefix+"src-io/telemetry")
	defer sub1.Disconnect(0)
	entMsgs, sub2 := busObserver(t, addr, "io-ent", entities.TelemetryTopic(ioModuleID))
	defer sub2.Disconnect(0)
	a.Bus = bus
	a.runEbyteSourcePass(context.Background(), time.Now())

	waitFor(t, 3*time.Second, "source + entity telemetry", func() bool {
		return len(srcMsgs()) > 0 && len(entMsgs()) > 0
	})
	src := srcMsgs()[0]
	in, _ := src["inputs"].([]any)
	out, _ := src["outputs"].([]any)
	if len(in) != 8 || in[0] != true || len(out) != 8 || out[7] != true {
		t.Fatalf("source telemetry %v", src)
	}
	ch, _ := entMsgs()[0]["channels"].(map[string]any)
	if ch["di_1"] != 1.0 || ch["di_2"] != 0.0 || ch["do_8"] != 1.0 || len(ch) != 16 {
		t.Fatalf("entity channels %v", ch)
	}
	if sim.Writes != 0 {
		t.Fatal("the read path never writes")
	}
}

func TestEbyteNotAusAndARemovedConsumerSwitchOffOnlyWhatTheExecutorSwitchedOn(t *testing.T) {
	sim := armedSim()
	sim.SetOutput(6, true) // DO7: switched by somebody else, never ours to release
	reg := ioRegistry("00:54:2c:84:9b:90")
	arb := minimalArbiter(reg)
	submitOnOffWish(arb, ioRodID, true, "r1")
	submitOnOffWish(arb, ioPumpID, true, "r2")
	a := ioAgent(t, sim, reg, arb)
	a.runEbyteControlPass(context.Background(), time.Now())
	if out := sim.Outputs(); !out[2] || !out[3] {
		t.Fatalf("both channels on first: %v", out)
	}

	// The pump consumer is deleted in the portal: its output goes off, the
	// rod keeps running.
	a.entMu.Lock()
	a.entRegistry.Entities = a.entRegistry.Entities[:2]
	a.entMu.Unlock()
	a.runEbyteControlPass(context.Background(), time.Now())
	if out := sim.Outputs(); !out[2] || out[3] {
		t.Fatalf("only the removed consumer's output goes off: %v", out)
	}

	// Not-Aus: control off releases the rod, never the foreign DO7, and then
	// the executor stays silent.
	a.Cfg.ConsumerControlEnabled = false
	a.runEbyteControlPass(context.Background(), time.Now())
	if out := sim.Outputs(); out[2] || !out[6] {
		t.Fatalf("Not-Aus releases only our outputs: %v", out)
	}
	writes := sim.Writes
	a.runEbyteControlPass(context.Background(), time.Now())
	if sim.Writes != writes {
		t.Fatal("after the release a disabled executor writes nothing")
	}
}

func TestEbyteDeviceTelemetryTravelsOnChangePlusHeartbeat(t *testing.T) {
	sim := armedSim()
	reg := ioRegistry("00:54:2c:84:9b:90")
	a := ioAgent(t, sim, reg, minimalArbiter(reg))
	a.srcs = []sources.Source{{ID: "src-io", Role: sources.RoleConsumer, Brand: inverter.BrandEbyte,
		Communication: inverter.CommEbyteModbusTCP,
		Connection:    inverter.Connection{IP: ioIP, Port: 502, UnitID: 1}}}
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := localbus.Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	msgs, sub := busObserver(t, addr, "io-hb", entities.TelemetryTopic(ioModuleID))
	defer sub.Disconnect(0)
	a.Bus = bus

	t0 := time.Now()
	a.runEbyteSourcePass(context.Background(), t0)
	a.runEbyteSourcePass(context.Background(), t0.Add(10*time.Second)) // unchanged: silent
	sim.SetInput(4, true)
	a.runEbyteSourcePass(context.Background(), t0.Add(20*time.Second)) // change: published
	a.runEbyteSourcePass(context.Background(), t0.Add(90*time.Second)) // heartbeat: published
	waitFor(t, 3*time.Second, "three publications", func() bool { return len(msgs()) >= 3 })
	time.Sleep(200 * time.Millisecond)
	if got := len(msgs()); got != 3 {
		t.Fatalf("expected first + change + heartbeat = 3 publications, got %d", got)
	}
	ch, _ := msgs()[1]["channels"].(map[string]any)
	if ch["di_5"] != 1.0 {
		t.Fatalf("the change must carry the new input state: %v", ch)
	}
}

func TestEbyteConnectionTestReportsItsChannelStatesAsContractSamples(t *testing.T) {
	sim := armedSim()
	sim.SetInput(1, true)
	reg := ioRegistry("")
	a := ioAgent(t, sim, reg, minimalArbiter(reg))
	conn := json.RawMessage(`{"ip":"192.168.3.50","port":502,"unit_id":1}`)
	res := a.runProbeTestConnection(probe.Op{ID: "verbindung", Op: probe.OpTestConnection,
		Brand: "ebyte", Model: "m31_axax8080g_u", Role: "consumer", Connection: conn})
	if !res.OK || len(res.Samples) != 16 {
		t.Fatalf("expected 16 samples, got %+v", res)
	}
	if res.Samples[0].Channel != "do_1" || res.Samples[8].Channel != "di_1" ||
		*res.Samples[9].Value != 1 || res.Samples[9].Count != 1 {
		t.Fatalf("samples %+v", res.Samples)
	}

	// A larger stack stays inside the contract's 16 rows and shows both kinds.
	big := ebyte.State{Inputs: make([]bool, 24), Outputs: make([]bool, 24)}
	states := ebyteTestStates(big)
	if len(states) != 16 || states[7].Channel != "do_8" || states[8].Channel != "di_1" {
		t.Fatalf("balanced states %+v", states)
	}
}

func ebyteSwitchOp(op string, channel int, on *int, ttl *int) probe.Op {
	addr, off, fc := channel-1, 0, probe.WriteFCCoil
	return probe.Op{Op: op, ID: "ausgang", Transport: probe.TransportEbyte, Host: ioIP,
		RegisterKind: probe.RegisterKindCoil, Address: &addr, WriteFC: &fc,
		OnValue: on, OffValue: &off, TTLSeconds: ttl}
}

func TestEbyteTestSwitchOfAFreeOutputSwitchesAndFallsBackByItself(t *testing.T) {
	sim := armedSim()
	reg := ioRegistry("00:54:2c:84:9b:90")
	a := ioAgent(t, sim, reg, minimalArbiter(reg))
	one, ttl := 1, 1
	op := ebyteSwitchOp(probe.OpSwitchTest, 5, &one, &ttl)
	if code, msg := probe.ValidateOps([]probe.Op{op})[0].Code, probe.ValidateOps([]probe.Op{op})[0].Message; code != "" {
		t.Fatalf("a valid output test must be admitted: %s %s", code, msg)
	}
	res := a.runSwitchOp(op)
	if !res.OK || res.Switched == nil || res.Switched.Readback == nil || *res.Switched.Readback != 1 {
		t.Fatalf("switch test: %+v", res)
	}
	if !sim.Outputs()[4] {
		t.Fatal("DO5 must be on during the test")
	}
	waitFor(t, 5*time.Second, "automatic off", func() bool { return !sim.Outputs()[4] })
}

func TestEbyteTestSwitchNeverTurnsOnAnOutputOwnedByAConsumer(t *testing.T) {
	sim := armedSim()
	reg := ioRegistry("00:54:2c:84:9b:90") // DO3 = heating rod, DO4 = pump
	a := ioAgent(t, sim, reg, minimalArbiter(reg))
	one, ttl := 1, 60
	res := a.runSwitchOp(ebyteSwitchOp(probe.OpSwitchTest, 3, &one, &ttl))
	if res.OK || sim.Outputs()[2] {
		t.Fatalf("a consumer's output must not be test-switched on: %+v", res)
	}
	sim.SetOutput(2, true)
	// Switching OFF stays possible - it is always the safe direction.
	if res := a.runSwitchOp(ebyteSwitchOp(probe.OpSwitchCancel, 3, nil, nil)); !res.OK || sim.Outputs()[2] {
		t.Fatalf("switching a bound output off must work: %+v", res)
	}
}

func TestEbyteTestSwitchAdmissionIsCoilOnly(t *testing.T) {
	one, ttl := 1, 60
	op := ebyteSwitchOp(probe.OpSwitchTest, 1, &one, &ttl)
	op.RegisterKind = probe.RegisterKindHolding
	if v := probe.ValidateOps([]probe.Op{op})[0]; v.OK() {
		t.Fatal("an I/O-module output is a coil only")
	}
}
