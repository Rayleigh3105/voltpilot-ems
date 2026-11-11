package shelly

// The I/O of the stage path (group.go): ONE read for every output, writes OFF
// before ON, the immediate OFF of an output that is on although it should be
// off (HZ-4 = B), and the "nach Stromausfall" setting (HZ-5 = A).
//
// One read for the whole set: Gen2 `Shelly.GetStatus` carries every
// `switch:N` object (each the very body Switch.GetStatus returns), Gen1
// `/status` carries `relays[]`. On the VoltPilotGATE's WLAN a Shelly needs
// 1.5-3.5 s per request (31.10.2026), so three single reads would eat the
// portal's wait for a connection test on their own.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"time"
)

// Initial-state words (the "nach Stromausfall" setting), in the Gen2
// vocabulary; Gen1 `default_state` is mapped onto it (last -> restore_last,
// switch -> match_input).
const (
	InitialOff         = "off"
	InitialOn          = "on"
	InitialRestoreLast = "restore_last"
	InitialMatchInput  = "match_input"
)

// DetectGroup probes the device of an output set once: the dialect, whether
// EVERY output measures, and the state of every output - from the same two
// requests a single output's DetectState needs.
func DetectGroup(ctx context.Context, doer Doer, cfg Config) (Identity, GroupState, error) {
	if cfg.IP == "" {
		return Identity{}, GroupState{}, &DriverError{Code: ErrInvalidRequest, Message: "keine IP-Adresse"}
	}
	if !cfg.IsGroup() {
		return Identity{}, GroupState{}, &DriverError{Code: ErrInvalidRequest, Message: "keine Ausgangsmenge"}
	}
	if msg := ChannelsError(cfg.Channels); msg != "" {
		return Identity{}, GroupState{}, &DriverError{Code: ErrInvalidRequest, Message: msg}
	}
	code, body, err := doer.Get(ctx, "http://"+cfg.HostPort()+"/shelly")
	if de := classify(code, err); de != nil {
		return Identity{}, GroupState{}, de
	}
	var probe struct {
		Gen    *int   `json:"gen"`
		Model  string `json:"model"`
		App    string `json:"app"`
		Type   string `json:"type"`
		AuthEn *bool  `json:"auth_en"`
		Auth   *bool  `json:"auth"`
	}
	if e := json.Unmarshal(body, &probe); e != nil {
		return Identity{}, GroupState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Antwort des Geräts war kein Shelly-Format."}
	}
	if (probe.AuthEn != nil && *probe.AuthEn) || (probe.Auth != nil && *probe.Auth) {
		return Identity{}, GroupState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Das Shelly-Gerät ist passwortgeschützt - der Passwortschutz wird nicht unterstützt (siehe SHELLY.md)."}
	}
	var ident Identity
	switch {
	case probe.Gen != nil && *probe.Gen >= 2:
		ident = Identity{Gen: Gen2, Model: probe.Model, App: probe.App, DetectedAt: time.Now().UTC()}
	case probe.Type != "":
		ident = Identity{Gen: Gen1, Model: probe.Type, DetectedAt: time.Now().UTC()}
	default:
		return Identity{}, GroupState{}, &DriverError{Code: ErrInvalidResponse,
			Message: "Die Antwort des Geräts war kein Shelly-Format."}
	}
	metering, st, de := readGroup(ctx, doer, cfg, ident, true)
	if de != nil {
		return Identity{}, GroupState{}, de
	}
	ident.HasMetering = metering
	if !metering {
		st.PowerKw = nil
	}
	return ident, st, nil
}

// ReadGroupState reads every output of the set (+ the summed power when every
// output measures) through the detected dialect, in one request.
func ReadGroupState(ctx context.Context, doer Doer, cfg Config, ident Identity) (GroupState, *DriverError) {
	_, st, de := readGroup(ctx, doer, cfg, ident, ident.HasMetering)
	return st, de
}

// readGroup reads the set; metering reports whether every output carried a
// power value (the detection verdict), the state's PowerKw is the sum only
// when wantPower and every output measured.
func readGroup(ctx context.Context, doer Doer, cfg Config, ident Identity, wantPower bool) (bool, GroupState, *DriverError) {
	n := len(cfg.Channels)
	st := GroupState{Outputs: make([]*bool, n)}
	powers := make([]*float64, n)
	switch ident.Gen {
	case Gen2:
		code, body, err := doer.Get(ctx, "http://"+cfg.HostPort()+"/rpc/Shelly.GetStatus")
		if de := classify(code, err); de != nil {
			return false, GroupState{}, de
		}
		var all map[string]json.RawMessage
		if e := json.Unmarshal(body, &all); e != nil {
			return false, GroupState{}, &DriverError{Code: ErrInvalidResponse,
				Message: "Die Statusantwort des Geräts war nicht lesbar."}
		}
		for i, ch := range cfg.Channels {
			raw, ok := all["switch:"+strconv.Itoa(ch)]
			if !ok {
				return false, GroupState{}, &DriverError{Code: ErrInvalidResponse,
					Message: fmt.Sprintf("Ausgang %d kennt das Gerät nicht (Ausgänge prüfen).", ch)}
			}
			var sw struct {
				Output *bool    `json:"output"`
				Apower *float64 `json:"apower"`
			}
			if e := json.Unmarshal(raw, &sw); e != nil || sw.Output == nil {
				return false, GroupState{}, &DriverError{Code: ErrInvalidResponse,
					Message: fmt.Sprintf("Ausgang %d hat nicht verständlich geantwortet.", ch)}
			}
			st.Outputs[i] = sw.Output
			powers[i] = sw.Apower
		}
	case Gen1:
		doc, de := gen1Status(ctx, doer, cfg)
		if de != nil {
			return false, GroupState{}, de
		}
		for i, ch := range cfg.Channels {
			if ch >= len(doc.Relays) || doc.Relays[ch].IsOn == nil {
				return false, GroupState{}, &DriverError{Code: ErrInvalidResponse,
					Message: fmt.Sprintf("Ausgang %d kennt das Gerät nicht (Ausgänge prüfen).", ch)}
			}
			st.Outputs[i] = doc.Relays[ch].IsOn
			if ch < len(doc.Meters) && doc.Meters[ch].IsValid {
				powers[i] = doc.Meters[ch].Power // nil = no value = not a measurement
			}
		}
	default:
		return false, GroupState{}, &DriverError{Code: ErrInvalidRequest, Message: "unbekannter Shelly-Dialekt"}
	}
	metering, sum := true, 0.0
	for _, p := range powers {
		if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) {
			metering = false
			break
		}
		sum += math.Max(0, *p)
	}
	if metering && wantPower {
		kw := math.Round(sum) / 1000
		st.PowerKw = &kw
	}
	return metering, st, nil
}

// writeGroup executes a plan's writes: every OFF first, then every ON (each ON
// with its own dead-man timer). An OFF that fails stops the ONs - an output
// that may still be on must never get company the command did not grant. A
// failing ON does not stop the next ones: fewer phases than commanded is
// allowed, more never.
func writeGroup(ctx context.Context, doer Doer, cfg Config, ident Identity, p GroupPlan) *DriverError {
	for i, ch := range cfg.Channels {
		if p.Targets[i] {
			continue
		}
		if de := SetRelay(ctx, doer, cfg.output(ch), ident, false); de != nil {
			return &DriverError{Code: de.Code, Message: fmt.Sprintf(
				"Ausgang %d ließ sich nicht ausschalten - es wurde nichts eingeschaltet: %s", ch, de.Message)}
		}
	}
	var first *DriverError
	for i, ch := range cfg.Channels {
		if !p.Targets[i] {
			continue
		}
		if de := SetRelay(ctx, doer, cfg.output(ch), ident, true); de != nil && first == nil {
			first = &DriverError{Code: de.Code, Message: fmt.Sprintf(
				"Ausgang %d ließ sich nicht einschalten: %s", ch, de.Message)}
		}
	}
	return first
}

// GroupResult is the outcome of ExecuteGroup.
type GroupResult struct {
	// OK: the readback came back (the verdict is real). A write that failed is
	// still named in ErrorCode/Message - the read state tells what it left.
	OK       bool
	Wrote    bool
	Plan     GroupPlan
	Identity Identity
	Verdict  GroupVerdict
	// Corrected: an output was on although commanded off, and the immediate
	// OFF round ran within this pass (HZ-4 = B).
	Corrected bool
	ErrorCode string
	Message   string
}

// ExecuteGroup runs the stage write (when the plan writes), ONE readback, and
// - when an output is on although it should be off - the immediate OFF round
// with the stage recounted, then a second readback. Kill-switch off -> the
// readback only.
func ExecuteGroup(ctx context.Context, doer Doer, cfg Config, ident Identity, cmd Command,
	prev GroupPrev, day int) GroupResult {
	plan := PlanGroupFor(cfg, cmd, prev, day)
	if plan.Mode == "idle" {
		return GroupResult{ErrorCode: ErrInvalidRequest, Message: plan.Reason, Plan: plan, Identity: ident}
	}
	var writeErr *DriverError
	if plan.Write {
		writeErr = writeGroup(ctx, doer, cfg, ident, plan)
	}
	st, de := ReadGroupState(ctx, doer, cfg, ident)
	if de != nil {
		res := GroupResult{Wrote: plan.Write, Plan: plan, Identity: ident, ErrorCode: de.Code, Message: de.Message}
		if writeErr != nil {
			res.ErrorCode, res.Message = writeErr.Code, writeErr.Message
		}
		return res
	}
	res := GroupResult{OK: true, Wrote: plan.Write, Plan: plan, Identity: ident,
		Verdict: plan.EvalGroupReadback(cfg, ident, st)}
	if plan.Write && writeErr == nil {
		next := GroupPrev{Commanded: plan.Targets, Read: st.Outputs}
		stuck := false
		for i := range cfg.Channels {
			stuck = stuck || next.disobeying(i)
		}
		if stuck && plan.Stage < len(cfg.Channels) {
			again := PlanGroupFor(cfg, cmd, next, day)
			writeErr = writeGroup(ctx, doer, cfg, ident, again)
			if st2, de2 := ReadGroupState(ctx, doer, cfg, ident); de2 == nil {
				res.Plan, res.Verdict, res.Corrected = again, again.EvalGroupReadback(cfg, ident, st2), true
			}
		}
	}
	if writeErr != nil {
		res.ErrorCode, res.Message = writeErr.Code, writeErr.Message
	}
	return res
}

// GroupControlCheck is the D11 switch test of an output set: identify, read
// every output, and - ONLY while every output is off - write OFF to each and
// read back (value-identical, nothing energizes). One output on = a heating
// run: skipped, honestly named, never interrupted.
func GroupControlCheck(ctx context.Context, doer Doer, cfg Config) ControlCheckOutcome {
	ident, st, err := DetectGroup(ctx, doer, cfg)
	if err != nil {
		out := ControlCheckOutcome{ErrorCode: ErrInvalidResponse, Message: "Das Shelly-Gerät hat nicht geantwortet."}
		if de, ok := err.(*DriverError); ok {
			out.ErrorCode, out.Message = de.Code, de.Message
		}
		return out
	}
	metering := ident.HasMetering
	out := ControlCheckOutcome{Gen: ident.Gen, Model: ident.Model, Metering: &metering}
	for i, on := range st.Outputs {
		if on != nil && *on {
			out.Skipped = true
			out.Message = fmt.Sprintf("Ausgang %d ist gerade eingeschaltet - der Schalttest wurde übersprungen, "+
				"um den laufenden Betrieb nicht zu unterbrechen. Gerät erkannt: %s.", cfg.Channels[i], ident.Label())
			return out
		}
	}
	out.Key, out.Value = relayKey(ident), 0
	for _, ch := range cfg.Channels {
		if de := SetRelay(ctx, doer, cfg.output(ch), ident, false); de != nil {
			out.ErrorCode = de.Code
			out.Message = fmt.Sprintf("Der Schalttest hat Ausgang %d nicht erreicht: %s", ch, de.Message)
			return out
		}
	}
	after, de := ReadGroupState(ctx, doer, cfg, ident)
	if de != nil {
		out.ErrorCode = de.Code
		out.Message = "Die Rücklesung nach dem Schalttest ist fehlgeschlagen."
		return out
	}
	for i, on := range after.Outputs {
		if on == nil || *on {
			out.ErrorCode = ErrInvalidResponse
			out.Message = fmt.Sprintf("Ausgang %d hat den geschriebenen Schaltzustand nicht zurückgemeldet.", cfg.Channels[i])
			return out
		}
	}
	out.OK = true
	out.Message = fmt.Sprintf("Schalt-Schreibtest bestätigt: alle %d Ausgänge geschrieben und zurückgelesen "+
		"(sie blieben aus). Gerät erkannt: %s.", len(cfg.Channels), ident.Label())
	return out
}

// ReadInitialStates reads the "nach Stromausfall" setting of every output (one
// request: Gen2 Shelly.GetConfig, Gen1 /settings). An output whose value is
// missing or foreign stays "" - unknown, never guessed.
func ReadInitialStates(ctx context.Context, doer Doer, cfg Config, ident Identity) ([]string, *DriverError) {
	chs := cfg.Channels
	if !cfg.IsGroup() {
		chs = []int{cfg.Channel}
	}
	out := make([]string, len(chs))
	switch ident.Gen {
	case Gen2:
		code, body, err := doer.Get(ctx, "http://"+cfg.HostPort()+"/rpc/Shelly.GetConfig")
		if de := classify(code, err); de != nil {
			return nil, de
		}
		var all map[string]json.RawMessage
		if e := json.Unmarshal(body, &all); e != nil {
			return nil, &DriverError{Code: ErrInvalidResponse, Message: "Die Einstellungen des Geräts waren nicht lesbar."}
		}
		for i, ch := range chs {
			var sw struct {
				InitialState string `json:"initial_state"`
			}
			if raw, ok := all["switch:"+strconv.Itoa(ch)]; ok && json.Unmarshal(raw, &sw) == nil {
				out[i] = gen2Initial(sw.InitialState)
			}
		}
	case Gen1:
		code, body, err := doer.Get(ctx, "http://"+cfg.HostPort()+"/settings")
		if de := classify(code, err); de != nil {
			return nil, de
		}
		var doc struct {
			Relays []struct {
				DefaultState string `json:"default_state"`
			} `json:"relays"`
		}
		if e := json.Unmarshal(body, &doc); e != nil {
			return nil, &DriverError{Code: ErrInvalidResponse, Message: "Die Einstellungen des Geräts waren nicht lesbar."}
		}
		for i, ch := range chs {
			if ch < len(doc.Relays) {
				out[i] = gen1Initial(doc.Relays[ch].DefaultState)
			}
		}
	default:
		return nil, &DriverError{Code: ErrInvalidRequest, Message: "unbekannter Shelly-Dialekt"}
	}
	return out, nil
}

func gen2Initial(s string) string {
	switch s {
	case InitialOff, InitialOn, InitialRestoreLast, InitialMatchInput:
		return s
	}
	return ""
}

func gen1Initial(s string) string {
	switch s {
	case "off":
		return InitialOff
	case "on":
		return InitialOn
	case "last":
		return InitialRestoreLast
	case "switch":
		return InitialMatchInput
	}
	return ""
}

// SetInitialOff writes "nach Stromausfall: aus" to every output of the config
// (HZ-5 = A: only on the operator's explicit consent, one write per output -
// Gen2 Switch.SetConfig, Gen1 /settings/relay/N). A relay setting, not a
// switching command: nothing turns on or off by it.
func SetInitialOff(ctx context.Context, doer Doer, cfg Config, ident Identity) *DriverError {
	chs := cfg.Channels
	if !cfg.IsGroup() {
		chs = []int{cfg.Channel}
	}
	for _, ch := range chs {
		var u string
		switch ident.Gen {
		case Gen2:
			q := url.Values{}
			q.Set("id", strconv.Itoa(ch))
			q.Set("config", `{"initial_state":"off"}`)
			u = "http://" + cfg.HostPort() + "/rpc/Switch.SetConfig?" + q.Encode()
		case Gen1:
			u = "http://" + cfg.HostPort() + "/settings/relay/" + strconv.Itoa(ch) + "?default_state=off"
		default:
			return &DriverError{Code: ErrInvalidRequest, Message: "unbekannter Shelly-Dialekt"}
		}
		code, body, err := doer.Get(ctx, u)
		if de := classify(code, err); de != nil {
			return &DriverError{Code: de.Code, Message: fmt.Sprintf("Ausgang %d: %s", ch, de.Message)}
		}
		var resp map[string]json.RawMessage
		if e := json.Unmarshal(body, &resp); e != nil {
			return &DriverError{Code: ErrInvalidResponse,
				Message: fmt.Sprintf("Ausgang %d hat die Einstellung nicht verständlich bestätigt.", ch)}
		}
		if ident.Gen == Gen2 {
			if _, isErr := resp["code"]; isErr {
				var msg string
				_ = json.Unmarshal(resp["message"], &msg)
				return &DriverError{Code: ErrInvalidResponse,
					Message: fmt.Sprintf("Ausgang %d hat die Einstellung abgelehnt: %s", ch, msg)}
			}
		} else {
			var ds string
			_ = json.Unmarshal(resp["default_state"], &ds)
			if ds != "off" {
				return &DriverError{Code: ErrInvalidResponse,
					Message: fmt.Sprintf("Ausgang %d hat die Einstellung nicht übernommen.", ch)}
			}
		}
	}
	return nil
}

// GroupReadbackPayload renders the readback of the stage path: the v1 shape
// (all_match + registers, one per output with its channel) plus the additive
// `stage` block - commanded and CONFIRMED stage with their kW, the evidence
// the ledger counts. since carries, per output, when it began to deviate (zero
// = matches); a deviation is named, never hidden.
func GroupReadbackPayload(entityID, ts string, res GroupResult, since []time.Time) []byte {
	type reg struct {
		Role          string `json:"role"`
		Key           string `json:"key"`
		Channel       *int   `json:"channel,omitempty"`
		Commanded     int    `json:"commanded"`
		Actual        *int   `json:"actual"`
		Match         bool   `json:"match"`
		MismatchSince string `json:"mismatch_since,omitempty"`
	}
	type stage struct {
		Commanded     int      `json:"commanded"`
		CommandedKw   float64  `json:"commanded_kw"`
		Confirmed     *int     `json:"confirmed"`
		ConfirmedKw   *float64 `json:"confirmed_kw"`
		OutputsOn     []int    `json:"outputs_on"`
		CountedOutput []int    `json:"counted,omitempty"`
	}
	regs := make([]reg, 0, len(res.Verdict.Registers))
	for i, r := range res.Verdict.Registers {
		g := reg{Role: r.Role, Key: r.Key, Channel: r.Channel, Commanded: r.Commanded, Actual: r.Actual, Match: r.Match}
		if !r.Match && i < len(since) && !since[i].IsZero() {
			g.MismatchSince = since[i].UTC().Format(time.RFC3339)
		}
		regs = append(regs, g)
	}
	var st *stage
	if res.Plan.Mode == "on" || res.Plan.Mode == "off" {
		st = &stage{Commanded: res.Plan.Stage, CommandedKw: res.Plan.StageKw,
			Confirmed: res.Verdict.ConfirmedStage, ConfirmedKw: res.Verdict.ConfirmedKw, OutputsOn: []int{}}
		chs := res.Plan.Channels
		for i, on := range res.Verdict.Outputs {
			if on != nil && *on && i < len(chs) {
				st.OutputsOn = append(st.OutputsOn, chs[i])
			}
		}
		for i, c := range res.Plan.Counted {
			if c && i < len(chs) {
				st.CountedOutput = append(st.CountedOutput, chs[i])
			}
		}
	}
	payload := struct {
		SchemaVersion string   `json:"schema_version"`
		EntityID      string   `json:"entity_id"`
		Ts            string   `json:"ts"`
		Adapter       string   `json:"adapter"`
		Gen           int      `json:"gen,omitempty"`
		Metering      bool     `json:"metering"`
		Mode          string   `json:"mode"`
		ControlEnab   bool     `json:"control_enabled"`
		Wrote         bool     `json:"wrote"`
		AllMatch      *bool    `json:"all_match"`
		Registers     []reg    `json:"registers"`
		On            *bool    `json:"on,omitempty"`
		PowerKw       *float64 `json:"power_kw,omitempty"`
		Stage         *stage   `json:"stage,omitempty"`
		TimerS        int      `json:"timer_s,omitempty"`
		Reason        string   `json:"reason,omitempty"`
		ErrorCode     string   `json:"error_code,omitempty"`
		Message       string   `json:"message,omitempty"`
	}{
		SchemaVersion: "1.0", EntityID: entityID, Ts: ts, Adapter: Communication,
		Gen: res.Identity.Gen, Metering: res.Identity.HasMetering,
		Mode: res.Plan.Mode, ControlEnab: res.Plan.ControlEnabled, Wrote: res.Wrote,
		AllMatch: res.Verdict.AllMatch, Registers: regs,
		On: res.Verdict.On(), PowerKw: res.Verdict.PowerKw, Stage: st, TimerS: res.Plan.TimerS,
		Reason: res.Plan.Reason, ErrorCode: res.ErrorCode, Message: res.Message,
	}
	b, _ := json.Marshal(payload)
	return b
}
