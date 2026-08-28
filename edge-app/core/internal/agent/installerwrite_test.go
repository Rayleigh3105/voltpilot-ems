package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"testing"
	"time"

	pahomqtt "github.com/eclipse/paho.mqtt.golang"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// The NARROW installer write (0x00E7). What is proven here is the WIRING and
// the one-shot discipline - the Modbus/V5 frame itself lives in the flow and is
// proven there against a real in-process Solarman logger.

type installerBox struct {
	a    *Agent
	addr string
}

// startInstallerBox is a box with a Deye hybrid_3p selected - the constellation
// the whole path exists for. There is NO arming step: the config is the plain
// default, so the path exists on every box (Captain-Korrektur 20.08.2026).
func startInstallerBox(t *testing.T) *installerBox {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a, addr := startBusOnlyAgent(t, cfg)
	if err := a.Bus.Subscribe(localbus.TopicInstallerWriteResult, 15, a.onInstallerWriteResult); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	// DASSELBE Handler-Paar fuer die schlichte Modbus-TCP-Lane (Stufe 2) - wie
	// in agent.go: eine Warteschlange, eine Ergebnis-Form, zwei Transporte.
	if err := a.Bus.Subscribe(localbus.TopicRegisterWriteResult, 15, a.onInstallerWriteResult); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: "deye", Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064", MbSlaveID: 1, PowerScale: 10},
	}); err != nil {
		t.Fatalf("select inverter: %v", err)
	}
	return &installerBox{a: a, addr: addr}
}

// installerStub plays the flow node: it records the ONE request it sees and
// answers with whatever the callback returns.
func installerStub(t *testing.T, busAddr string, seen chan<- installerBusRequest,
	answer func(req installerBusRequest) installerBusResult) {
	t.Helper()
	opts := pahomqtt.NewClientOptions().
		AddBroker("tcp://" + busAddr).
		SetClientID("test-installer-stub").
		SetConnectTimeout(5 * time.Second)
	client := pahomqtt.NewClient(opts)
	if tok := client.Connect(); !tok.WaitTimeout(10*time.Second) || tok.Error() != nil {
		t.Fatalf("stub connect: %v", tok.Error())
	}
	t.Cleanup(func() { client.Disconnect(100) })
	tok := client.Subscribe(localbus.TopicInstallerWriteRequest, 1,
		func(_ pahomqtt.Client, msg pahomqtt.Message) {
			var req installerBusRequest
			if json.Unmarshal(msg.Payload(), &req) != nil || req.RequestID == "" {
				return
			}
			if seen != nil {
				select {
				case seen <- req:
				default:
				}
			}
			if answer == nil {
				return
			}
			res := answer(req)
			res.RequestID = req.RequestID
			raw, _ := json.Marshal(res)
			client.Publish(localbus.TopicInstallerWriteResult, 1, false, raw)
		})
	if !tok.WaitTimeout(5*time.Second) || tok.Error() != nil {
		t.Fatalf("stub subscribe: %v", tok.Error())
	}
}

func regPtr(v int) *int { return &v }

// THE CASE: Herzogau holds 33,0 kW (raw 3300) and is raised to 70,0 kW.
// A dry run reads and writes NOTHING; the confirmed call writes exactly once and
// reports the read-back.
func TestTheDryRunReadsAndTheConfirmedCallWritesExactlyOnce(t *testing.T) {
	box := startInstallerBox(t)
	seen := make(chan installerBusRequest, 8)
	installerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		if req.Mode == installerwrite.ModeDry {
			return installerBusResult{OK: true, Before: regPtr(3300)}
		}
		return installerBusResult{OK: true, Before: regPtr(3300), After: regPtr(req.Value), Wrote: true}
	})

	// Stage 1 - the DEFAULT. Nothing is written, and the answer names the token.
	out, err := box.a.InstallerWrite(installerwrite.Request{Value: 7000}, "test")
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	req := <-seen
	if req.Mode != installerwrite.ModeDry || req.Addr != installerwrite.RegisterAddr || req.Value != 7000 {
		t.Fatalf("dry-run request: %#v", req)
	}
	if out.Result != installerwrite.ResultDryRun || out.Accepted {
		t.Fatalf("dry run must not claim an apply: %#v", out)
	}
	if out.Before == nil || *out.Before != 3300 {
		t.Fatalf("dry run must report the Ist-value: %#v", out.Before)
	}
	if !containsSub(out.Message, installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000)) {
		t.Fatalf("the dry run must print the confirm token, got %q", out.Message)
	}
	if n := len(box.a.installerLog.List()); n != 0 {
		t.Fatalf("a dry run must not be audited, got %d entries", n)
	}

	// Stage 2 - the confirmed write.
	out, err = box.a.InstallerWrite(installerwrite.Request{
		Register: "0x00E7", Value: 7000, Mode: installerwrite.ModeApply, Confirm: "0x00E7=7000",
	}, "wartungszugang")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	req = <-seen
	if req.Mode != installerwrite.ModeApply || req.Value != 7000 {
		t.Fatalf("apply request: %#v", req)
	}
	if !out.Accepted || out.Result != installerwrite.ResultApplied {
		t.Fatalf("read-back matched, so it must be applied: %#v", out)
	}
	if out.After == nil || *out.After != 7000 || out.AfterKw == nil || *out.AfterKw != 70 {
		t.Fatalf("after/kw: %#v %#v", out.After, out.AfterKw)
	}
	// EXACTLY ONE attempt per confirmed request - no retry, no refresh.
	select {
	case extra := <-seen:
		t.Fatalf("a second attempt was made: %#v", extra)
	case <-time.After(400 * time.Millisecond):
	}
	// The audit entry survives a restart.
	entries := box.a.installerLog.List()
	if len(entries) != 1 {
		t.Fatalf("want exactly one audit entry, got %d", len(entries))
	}
	e := entries[0]
	if e.Register != installerwrite.RegisterLabel || e.Requested != 7000 ||
		e.Before == nil || *e.Before != 3300 || e.After == nil || *e.After != 7000 ||
		e.Result != installerwrite.ResultApplied || e.Source != "wartungszugang" || e.At.IsZero() {
		t.Fatalf("audit entry: %#v", e)
	}
	reopened, err := installerwrite.NewLog(box.a.Cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.List(); len(got) != 1 || got[0].Requested != 7000 {
		t.Fatalf("the audit trail must survive a restart: %#v", got)
	}
	// The confirmed read-back also refreshes the device's own reported limit,
	// so no surface keeps showing yesterday's daily read.
	if lim := box.a.State.Get().DeviceExportLimit; lim == nil || lim.LimitKw != 70 {
		t.Fatalf("device export limit: %#v", lim)
	}
}

// A write the device did not adopt is a MISMATCH, and it is audited - the case
// an investigation needs most.
func TestANotAdoptedValueIsAMismatchAndIsAudited(t *testing.T) {
	box := startInstallerBox(t)
	installerStub(t, box.addr, nil, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: regPtr(3300), After: regPtr(3300), Wrote: true}
	})
	out, err := box.a.InstallerWrite(installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
	}, "test")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if out.Accepted || out.Result != installerwrite.ResultMismatch {
		t.Fatalf("an unchanged register must never read as applied: %#v", out)
	}
	if got := box.a.installerLog.List(); len(got) != 1 || got[0].Result != installerwrite.ResultMismatch {
		t.Fatalf("a mismatch must be audited: %#v", got)
	}
	// It must NOT overwrite the device's reported limit with the requested value.
	if lim := box.a.State.Get().DeviceExportLimit; lim != nil && lim.LimitKw == 70 {
		t.Fatalf("an unadopted write must never claim the new limit: %#v", lim)
	}
}

// Nothing came back: a READ can state that nothing was written, while an
// APPLY must keep the device state unknown. Only the latter is audited.
func TestASilentDeviceGetsModeSpecificHonestFailureAndOnlyWritesAreAudited(t *testing.T) {
	prev := installerWriteTimeout
	installerWriteTimeout = 300 * time.Millisecond
	t.Cleanup(func() { installerWriteTimeout = prev })

	box := startInstallerBox(t)
	installerStub(t, box.addr, nil, nil) // sees it, answers nothing
	read, err := box.a.InstallerWrite(installerwrite.Request{Value: 7000}, "test")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !containsSub(read.Message, "Es wurde nichts geschrieben") ||
		containsSub(read.Message, "nicht sicher") {
		t.Fatalf("a dry-run timeout must state that it wrote nothing: %#v", read)
	}
	if got := box.a.installerLog.List(); len(got) != 0 {
		t.Fatalf("a dry run must not be audited as a write: %#v", got)
	}

	out, err := box.a.InstallerWrite(installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
	}, "test")
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if out.Accepted || out.Result != installerwrite.ResultFailed {
		t.Fatalf("a silent device must fail honestly: %#v", out)
	}
	if !containsSub(out.Message, "nicht sicher") {
		t.Fatalf("an unanswered write must keep the state unknown: %#v", out)
	}
	if got := box.a.installerLog.List(); len(got) != 1 || got[0].Result != installerwrite.ResultFailed {
		t.Fatalf("a failed attempt must be audited: %#v", got)
	}
}

// The allowlist is enforced BEFORE anything reaches the bus: a family whose
// 0x00E7 is our own discharge lever never sees a request.
func TestARefusedFamilyNeverReachesTheBus(t *testing.T) {
	box := startInstallerBox(t)
	if _, err := box.a.SetInverter(inverter.SelectionRequest{
		Brand: "deye", Model: "sun-12k-sg04lp3", Family: "hybrid_3p",
		Connection: inverter.Connection{IP: "192.168.0.28", Serial: "2985159064", MbSlaveID: 1, PowerScale: 1},
	}); err != nil {
		t.Fatalf("select: %v", err)
	}
	// Force the refused family directly (the catalog has no 1p model with a serial-free form).
	box.a.invMu.Lock()
	box.a.inv.Family = "hybrid_1p"
	box.a.invMu.Unlock()

	seen := make(chan installerBusRequest, 4)
	installerStub(t, box.addr, seen, func(installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: regPtr(0)}
	})
	_, err := box.a.InstallerWrite(installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
	}, "test")
	var ve *installerwrite.ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("expected a refusal, got %v", err)
	}
	select {
	case req := <-seen:
		t.Fatalf("a refused family must never reach the device: %#v", req)
	case <-time.After(300 * time.Millisecond):
	}
	if n := len(box.a.installerLog.List()); n != 0 {
		t.Fatalf("a refusal is not a write and must not be audited, got %d", n)
	}
}

// The GET view names the one register and whether THIS plant qualifies - so an
// operator sees the refusal before typing a value. It carries NO switch state:
// there is nothing to arm (Captain-Korrektur 20.08.2026).
func TestTheViewReportsTheAllowlistAndNoSwitch(t *testing.T) {
	v := startInstallerBox(t).a.InstallerWriteView()
	if !v.Allowed || v.Family != "hybrid_3p" ||
		v.Register != installerwrite.RegisterLabel || v.MaxRaw != installerwrite.MaxRaw || v.ScaleW != installerwrite.ScaleW {
		t.Fatalf("view: %#v", v)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(`"enabled"`)) {
		t.Fatalf("the view must not carry a switch any more: %s", raw)
	}
}

// A second write while one is in flight is refused - two overlapping writes to
// one EEPROM register is the single thing this path must never do.
func TestASecondWriteWhileOneIsInFlightIsRefused(t *testing.T) {
	prev := installerWriteTimeout
	installerWriteTimeout = 900 * time.Millisecond
	t.Cleanup(func() { installerWriteTimeout = prev })

	box := startInstallerBox(t)
	installerStub(t, box.addr, nil, nil) // never answers, so the first call stays in flight

	started := make(chan struct{})
	done := make(chan struct{})
	go func() {
		close(started)
		_, _ = box.a.InstallerWrite(installerwrite.Request{
			Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
		}, "test")
		close(done)
	}()
	<-started
	time.Sleep(200 * time.Millisecond)
	_, err := box.a.InstallerWrite(installerwrite.Request{
		Value: 6000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 6000),
	}, "test")
	if !errors.Is(err, installerwrite.ErrBusy) {
		t.Fatalf("expected ErrBusy, got %v", err)
	}
	<-done
}

func containsSub(hay, needle string) bool {
	return len(needle) > 0 && len(hay) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(hay); i++ {
			if hay[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

// ⚠ THE LAYER SPLIT: the MECHANISM is trigger-agnostic. A second trigger (a
// portal downlink) calls WriteOnce directly - it gets the device facts and
// NOTHING of the :8484 adapter's concerns (no audit entry, no phrasing). This
// test is what makes „a later trigger is a second adapter, not a refactoring"
// checkable rather than asserted.
func TestWriteOnceIsTriggerAgnosticAndAuditsNothing(t *testing.T) {
	box := startInstallerBox(t)
	installerStub(t, box.addr, nil, func(req installerBusRequest) installerBusResult {
		return installerBusResult{OK: true, Before: regPtr(3300), After: regPtr(req.Value), Wrote: true}
	})
	admitted, err := installerwrite.Admit("hybrid_3p", installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := box.a.WriteOnce(installerwrite.Target{Family: "hybrid_3p", Communication: inverter.CommSolarmanV5}, admitted)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK() || !res.Wrote || !res.Adopted {
		t.Fatalf("mechanism result: %#v", res)
	}
	if res.Before == nil || *res.Before != 3300 || res.After == nil || *res.After != 7000 {
		t.Fatalf("before/after: %#v %#v", res.Before, res.After)
	}
	if res.Message != "" || res.ErrorCode != "" {
		t.Fatalf("a clean exchange carries no failure prose: %#v", res)
	}
	// The mechanism owns the DEVICE, not the paperwork.
	if n := len(box.a.installerLog.List()); n != 0 {
		t.Fatalf("WriteOnce must not audit - that is the trigger's job, got %d", n)
	}
	// The transport gate lives in the mechanism, so every trigger inherits it.
	if _, err := box.a.WriteOnce(installerwrite.Target{Family: "hybrid_3p", Communication: "modbus_tcp"}, admitted); err == nil {
		t.Fatal("a device on another transport has no path here")
	}
}

// The OPTIONAL precondition is compared ON THE DEVICE, inside the one socket
// session: a stale decision must not overwrite a newer value, and the refusal
// says what it found.
func TestAStalePreconditionRefusesWithoutWriting(t *testing.T) {
	box := startInstallerBox(t)
	seen := make(chan installerBusRequest, 4)
	installerStub(t, box.addr, seen, func(req installerBusRequest) installerBusResult {
		// The device moved on: it reads 5000, not the expected 3300.
		if req.ExpectedBefore != nil && *req.ExpectedBefore != 5000 {
			return installerBusResult{
				OK: false, Before: regPtr(5000), Wrote: false,
				ErrorCode: installerwrite.ErrCodePrecondition,
				Message:   "Das Register steht inzwischen auf 5000, erwartet wurde 3300. Es wurde NICHTS geschrieben.",
			}
		}
		return installerBusResult{OK: true, Before: regPtr(5000), After: regPtr(req.Value), Wrote: true}
	})
	stale := 3300
	out, err := box.a.InstallerWrite(installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
		ExpectedBefore: &stale,
	}, "test")
	if err != nil {
		t.Fatalf("a refused precondition is an OUTCOME, not an error: %v", err)
	}
	req := <-seen
	if req.ExpectedBefore == nil || *req.ExpectedBefore != 3300 {
		t.Fatalf("the expectation must travel to the device: %#v", req.ExpectedBefore)
	}
	if out.Accepted || out.Result != installerwrite.ResultPrecondition {
		t.Fatalf("outcome: %#v", out)
	}
	if out.Before == nil || *out.Before != 5000 {
		t.Fatalf("the refusal must report what it FOUND: %#v", out.Before)
	}
	// A guard that fired is still a write attempt worth recording.
	got := box.a.installerLog.List()
	if len(got) != 1 || got[0].Result != installerwrite.ResultPrecondition || got[0].After != nil {
		t.Fatalf("audit: %#v", got)
	}
	// The matching expectation goes through.
	fresh := 5000
	out, err = box.a.InstallerWrite(installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
		ExpectedBefore: &fresh,
	}, "test")
	if err != nil || !out.Accepted {
		t.Fatalf("a matching precondition must not block the write: %#v %v", out, err)
	}
}
