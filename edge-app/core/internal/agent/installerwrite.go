// The deliberately NARROW remote installer write: ONE Deye register, 0x00E7
// „Grid Max Export power" (internal/installerwrite carries the gates and the
// reasoning).
//
// ⚠ THIS FILE HOLDS TWO LAYERS, AND KEEPING THEM APART IS THE DESIGN:
//
//	MECHANISM  WriteOnce(Target, AdmittedWrite) - TRIGGER-AGNOSTIC. Read,
//	           optionally write ONCE, read back, report {before, after,
//	           adopted}. It knows no allowlist, no HTTP, no audit; it cannot be
//	           pointed at a register of the caller's choosing because an
//	           AdmittedWrite only comes out of installerwrite.Admit.
//	ADAPTER    InstallerWrite(Request, by) - the :8484 maintenance trigger:
//	           resolve the target, run POLICY (Admit), call the mechanism, then
//	           phrase, audit and refresh the reported limit.
//
// A later trigger (a portal downlink) is a SECOND ADAPTER over the same two
// layers - a new function next to InstallerWrite, not a refactoring of either.
//
// ⚠ THE CORE OPENS NO SOCKET, and that is the one-socket law, not a style
// choice. The Solarman/LSW3 logger accepts a single TCP client and that client
// belongs to the Node-RED tab that already polls the inverter and executes the
// control writes. The write therefore travels the local bus into THAT tab,
// where it shares the per-(host,port) flow-context lock with the poll and the
// control executor - the same reasoning that keeps the guided switch test out
// of the core (agent/switchtest.go) and the Modbus mirror out of the logger
// entirely (internal/mirror).
//
// ⚠ EXACTLY ONE ATTEMPT PER ADMITTED WRITE. There is no retry loop and no
// periodic re-assert: 0x00E7 lives in EEPROM and every write costs a write
// cycle. A lost answer is reported as „unbestätigt", never retried behind the
// operator's back - the trigger re-reads with a dry run and decides.
package agent

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// installerWriteTimeout bounds ONE local-bus round trip. Wider than the
// test-read exchange because the node may wait out an in-flight poll for the
// socket, then read, write, settle ~2 s and read again. A var so tests can
// shorten it.
var installerWriteTimeout = 30 * time.Second

// installerBusRequest is what reaches Node-RED. It carries the ALREADY ADMITTED
// single write - one address, one value, one stage - so the node has nothing
// left to decide (the switchBusOp discipline).
type installerBusRequest struct {
	RequestID string `json:"request_id"`
	Mode      string `json:"mode"`
	Register  string `json:"register"`
	Addr      int    `json:"addr"`
	Value     int    `json:"value"`
	// ExpectedBefore is compared ON THE DEVICE, inside the one socket session
	// that also reads and writes - so there is no read-then-write window
	// another writer could slip into.
	ExpectedBefore *int `json:"expected_before,omitempty"`
}

// installerBusResult is the node's answer. Before/After are POINTERS: „not
// read" and „read as 0" are different facts, and 0 is a legitimate value of
// this register.
type installerBusResult struct {
	RequestID string `json:"request_id"`
	OK        bool   `json:"ok"`
	Before    *int   `json:"before"`
	After     *int   `json:"after"`
	Wrote     bool   `json:"wrote"`
	ErrorCode string `json:"error_code"`
	Message   string `json:"message"`
}

// --- MECHANISM: trigger-agnostic, policy-free -------------------------------

// WriteOnce performs ONE admitted write against ONE target and reports what the
// device did. It is the piece every trigger shares.
//
// It refuses (ErrBusy) while another write is in flight - two overlapping
// writes to one EEPROM register is the single thing this path must never do,
// and that is a property of the DEVICE, not of the trigger, so the guard lives
// here rather than in an adapter.
//
// It never audits and never phrases an operator sentence: those belong to the
// trigger that knows who asked.
func (a *Agent) WriteOnce(target installerwrite.Target, w installerwrite.AdmittedWrite) (installerwrite.WriteOnceResult, error) {
	// The transport is part of the mechanism: this write rides the Deye
	// Solarman-V5 poll's socket, so a device read over another transport has no
	// path here at all.
	if target.Communication != inverter.CommSolarmanV5 {
		return installerwrite.WriteOnceResult{}, &installerwrite.ValidationError{
			Msg: "Dieser Wechselrichter wird nicht über den Solarman-Logger gelesen; der Fernschreibpfad steht nur dort zur Verfügung.",
		}
	}

	a.installerMu.Lock()
	if a.installerBusy {
		a.installerMu.Unlock()
		return installerwrite.WriteOnceResult{}, installerwrite.ErrBusy
	}
	a.installerBusy = true
	a.installerMu.Unlock()
	defer func() {
		a.installerMu.Lock()
		a.installerBusy = false
		a.installerMu.Unlock()
	}()

	res := a.installerExchange(w)
	if res == nil {
		return installerwrite.WriteOnceResult{
			ErrorCode: installerwrite.ErrCodeTimeout,
			Message:   "Der Wechselrichter hat nicht rechtzeitig geantwortet. Es ist nicht sicher, ob geschrieben wurde - bitte den Ist-Wert mit einem Probelauf erneut lesen.",
		}, nil
	}
	out := installerwrite.WriteOnceResult{Before: res.Before, After: res.After, Wrote: res.Wrote}
	if !res.OK {
		out.ErrorCode = strings.TrimSpace(res.ErrorCode)
		if out.ErrorCode == "" {
			out.ErrorCode = installerwrite.ErrCodeUnreachable
		}
		out.Message = strings.TrimSpace(res.Message)
		if out.Message == "" {
			out.Message = "Der Schreibvorgang ist fehlgeschlagen."
		}
		return out, nil
	}
	// ADOPTED is only ever claimed from a real read-back of the requested value.
	out.Adopted = w.Apply() && res.After != nil && *res.After == w.Value()
	return out, nil
}

// installerExchange publishes the ONE op and waits for its ONE answer. nil =
// nothing came back in time.
func (a *Agent) installerExchange(w installerwrite.AdmittedWrite) *installerBusResult {
	if a.Bus == nil {
		return nil
	}
	id := newTestReadID()
	ch := make(chan installerBusResult, 1)
	a.installerMu.Lock()
	if a.installerWaiters == nil {
		a.installerWaiters = map[string]chan installerBusResult{}
	}
	a.installerWaiters[id] = ch
	a.installerMu.Unlock()
	defer func() {
		a.installerMu.Lock()
		delete(a.installerWaiters, id)
		a.installerMu.Unlock()
	}()

	mode := installerwrite.ModeDry
	if w.Apply() {
		mode = installerwrite.ModeApply
	}
	raw, _ := json.Marshal(installerBusRequest{
		RequestID: id, Mode: mode,
		Register: w.Register(), Addr: w.Addr(), Value: w.Value(),
		ExpectedBefore: w.ExpectedBefore(),
	})
	// NON-retained: a write order that reappeared on the next reconnect would
	// not be a one-shot write.
	if err := a.Bus.Publish(localbus.TopicInstallerWriteRequest, raw, false); err != nil {
		slog.Warn("installer write could not be published", "err", err)
		return nil
	}
	select {
	case r := <-ch:
		return &r
	case <-time.After(installerWriteTimeout):
		return nil
	}
}

// onInstallerWriteResult routes one answer to its waiting call.
func (a *Agent) onInstallerWriteResult(_ string, payload []byte) {
	var m installerBusResult
	if err := json.Unmarshal(payload, &m); err != nil || m.RequestID == "" {
		slog.Warn("installer write result malformed; skipped")
		return
	}
	a.installerMu.Lock()
	ch := a.installerWaiters[m.RequestID]
	a.installerMu.Unlock()
	if ch == nil {
		return // unknown / already-timed-out request
	}
	select {
	case ch <- m:
	default:
	}
}

// --- ADAPTER: the :8484 maintenance trigger ---------------------------------

// InstallerWriteEnabled reports the feature flag. The HTTP surface answers 404
// when it is false, so the path does not exist from outside.
func (a *Agent) InstallerWriteEnabled() bool { return a.Cfg.InstallerWriteEnabled }

// InstallerWriteView is the GET payload: the switch, the ONE register this path
// may touch, whether THIS plant qualifies, and the persistent audit log.
func (a *Agent) InstallerWriteView() installerwrite.View {
	target := a.installerTarget()
	return installerwrite.View{
		Enabled:  a.Cfg.InstallerWriteEnabled,
		Register: installerwrite.RegisterLabel,
		MaxRaw:   installerwrite.MaxRaw,
		MaxKw:    installerwrite.MaxKw,
		ScaleW:   installerwrite.ScaleW,
		Family:   target.Family,
		Allowed:  installerwrite.AllowedFamily(target.Family),
		Entries:  a.installerLog.List(),
	}
}

// installerTarget is the PRIMARY inverter as a write target - an empty family
// when none is configured.
func (a *Agent) installerTarget() installerwrite.Target {
	a.invMu.Lock()
	defer a.invMu.Unlock()
	if a.inv == nil {
		return installerwrite.Target{}
	}
	return installerwrite.Target{Family: a.inv.Family, Communication: a.inv.Communication}
}

// InstallerWrite is the :8484 ADAPTER: policy, mechanism, then the trigger's own
// concerns (phrasing, audit, the refreshed reported limit).
//
// A dry run READS the register and reports what would be written; it changes
// nothing and is deliberately NOT audited (there is no „nachher" to record, and
// a log of reads would bury the writes it exists to preserve). A confirmed
// write is ALWAYS audited - success, mismatch and failure alike, because a
// write whose answer was lost is exactly the record a later investigation needs.
func (a *Agent) InstallerWrite(req installerwrite.Request, by string) (installerwrite.Outcome, error) {
	target := a.installerTarget()
	admitted, err := installerwrite.Admit(target.Family, req) // POLICY
	if err != nil {
		return installerwrite.Outcome{}, err
	}
	res, err := a.WriteOnce(target, admitted) // MECHANISM
	if err != nil {
		return installerwrite.Outcome{}, err
	}
	out := a.installerOutcome(admitted, res)
	if admitted.Apply() {
		a.recordInstallerWrite(admitted, out, by)
	}
	if out.Accepted && out.After != nil {
		// The register just told us its new value, so the surfaces stop showing
		// yesterday's read. This is the SAME field the daily poll fills
		// (agent/exportlimit.go) - one truth about the device's own limit,
		// refreshed by whoever read it last.
		a.noteInstallerExportLimit(*out.After)
	}
	return out, nil
}

// installerOutcome turns the mechanism's result into the operator-facing
// verdict.
//
// The four honest outcomes it must keep apart:
//   - a DRY RUN reports the current value and states what would be written;
//   - an APPLIED write is only claimed when the register READ BACK as the
//     requested value;
//   - a PRECONDITION refusal means the register no longer held what the caller
//     expected - nothing was written, and that is a success of the guard;
//   - anything else names its reason.
func (a *Agent) installerOutcome(w installerwrite.AdmittedWrite, res installerwrite.WriteOnceResult) installerwrite.Outcome {
	out := installerwrite.Outcome{Plan: w, Before: res.Before, After: res.After}
	if res.Before != nil {
		kw := installerwrite.KwFor(*res.Before)
		out.BeforeKw = &kw
	}
	if res.After != nil {
		kw := installerwrite.KwFor(*res.After)
		out.AfterKw = &kw
	}
	if !res.OK() {
		out.Result = installerwrite.ResultFailed
		if res.ErrorCode == installerwrite.ErrCodePrecondition {
			out.Result = installerwrite.ResultPrecondition
		}
		out.Message = res.Message
		return out
	}
	if !w.Apply() {
		out.Result = installerwrite.ResultDryRun
		out.Message = probeMessage(res.Before, w)
		return out
	}
	if res.Adopted {
		out.Result = installerwrite.ResultApplied
		out.Accepted = true
		out.Message = fmt.Sprintf("Der Wechselrichter hat %s kW übernommen (Register %s = %d).", kwString(w.Kw()), w.Register(), w.Value())
		return out
	}
	out.Result = installerwrite.ResultMismatch
	if res.After == nil {
		out.Message = "Der Schreibbefehl ging hinaus, das Register konnte danach aber nicht zurückgelesen werden - der Wert ist unbestätigt."
		return out
	}
	out.Message = fmt.Sprintf("Der Wechselrichter hat den Wert nicht übernommen: angefordert %d (%s kW), zurückgelesen %d.", w.Value(), kwString(w.Kw()), *res.After)
	return out
}

// probeMessage is the dry-run sentence: the current value, and what a confirmed
// call would write. It always ends with the exact confirm token, so the second
// curl is a copy-paste away.
func probeMessage(before *int, w installerwrite.AdmittedWrite) string {
	cur := "unbekannt (das Register konnte nicht gelesen werden)"
	if before != nil {
		cur = fmt.Sprintf("%d (%s kW)", *before, kwString(installerwrite.KwFor(*before)))
	}
	return fmt.Sprintf(
		"Probelauf - es wurde NICHTS geschrieben. Ist-Wert: %s. Geschrieben würde: %d (%s kW). "+
			"Zum wirklichen Schreiben die Anfrage mit \"mode\": \"apply\" und \"confirm\": \"%s\" wiederholen.",
		cur, w.Value(), kwString(w.Kw()), installerwrite.ConfirmToken(w.Value()))
}

// recordInstallerWrite appends the persistent audit entry. A failing log write
// must never fail the operation the entry describes - the write already
// happened - so it is logged loudly and swallowed.
func (a *Agent) recordInstallerWrite(w installerwrite.AdmittedWrite, out installerwrite.Outcome, by string) {
	// A LOCAL write has no cloud order, so it mints its own correlation id -
	// otherwise the heartbeat uplink (D6) could not report it, and the one
	// write nobody in the cloud can see would be the one made on site.
	a.recordInstallerWriteFrom(w, out, by, newRegisterWriteID())
}

// recordInstallerWriteFrom is the same audit entry with the PORTAL trigger's
// extra fact: the `request_id` of the order that caused it.
//
// ⚠ It is the CROSS KEY between the two books (concept §2.5 point 4): the box's
// own audit and the cloud journal (`register_write_event`) record the same
// operation under the same id, so a manipulated book contradicts the other. A
// LOCAL write has no cloud order and therefore no id - it gets one only when
// the Herzschlag-Uplink reports it (D6), where the box mints it itself.
func (a *Agent) recordInstallerWriteFrom(w installerwrite.AdmittedWrite,
	out installerwrite.Outcome, by, requestID string) {
	src := strings.TrimSpace(by)
	if src == "" {
		src = "wartungszugang"
	}
	e := installerwrite.Entry{
		At:        time.Now().UTC(),
		RequestID: strings.TrimSpace(requestID),
		Register:  w.Register(),
		Before:    out.Before,
		Requested: w.Value(),
		After:     out.After,
		Kw:        w.Kw(),
		Result:    out.Result,
		Message:   out.Message,
		Source:    src,
	}
	if err := a.installerLog.Append(e); err != nil {
		slog.Error("installer write audit entry could not be persisted",
			"register", w.Register(), "requested", w.Value(), "err", err)
	}
}

// noteInstallerExportLimit folds a CONFIRMED read-back into the snapshot field
// the daily poll otherwise fills, so every surface (the :8484 card, the cloud
// heartbeat, the portal) sees the new limit at once instead of tomorrow.
// Bounded by the same plausibility rule as the read path - a value beyond it is
// a decode defect, not a plant.
func (a *Agent) noteInstallerExportLimit(raw int) {
	reg, ok := inverter.ExportLimitRegisterFor(a.installerTarget().Family)
	if !ok {
		return
	}
	kw := reg.DecodeExportLimitKw(uint16(raw))
	if kw < 0 || kw > deviceExportLimitMaxKw {
		return
	}
	info := &state.DeviceExportLimitInfo{
		LimitKw:  math.Round(kw*1000) / 1000,
		Register: reg.Label,
		ReadAt:   time.Now().UTC(),
	}
	a.State.Update(func(s *state.Snapshot) { s.DeviceExportLimit = info })
}

// kwString renders kW the way the German copy expects (one decimal, comma).
func kwString(kw float64) string {
	return strings.Replace(strconv.FormatFloat(kw, 'f', 1, 64), ".", ",", 1)
}
