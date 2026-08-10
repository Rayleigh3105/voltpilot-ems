package goe

// The D11 SELF-SERVICE control check ("Verbindung testen" -> "Verbindung
// geprüft"): prove the go-e WRITE path + readback WITHOUT disturbing anything -
// read the charger's current requested current (amp), write EXACTLY that value
// back, and read it again. Writing the current value is a semantic no-op (a
// charging car keeps charging at the same current; an idle box stays idle), so
// the check never interrupts a charge - yet a successful round trip proves
// /api/set is reachable, accepted and echoed, which is precisely what the
// consumer executor will rely on. frc and psm are deliberately NEVER touched
// here (either could change real behavior).
//
// The check runs ONLY on an explicit operator request (the wizard's
// "Verbindung testen" with control_test set) - it is independent of the
// VP_CONTROL_ENABLED/VP_CONSUMER_CONTROL_ENABLED flags BY DESIGN: the D11
// wizard must be able to prove the write path BEFORE an operator arms the
// automatic control flags, and the write is value-identical by construction.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
)

// ControlCheckOutcome is the wizard-facing verdict of the write short-test.
type ControlCheckOutcome struct {
	// OK: the amp write went out, was accepted and the readback echoed it.
	OK bool `json:"ok"`
	// Key/Value name what was written ("amp" = the current value re-written).
	Key   string `json:"key,omitempty"`
	Value int    `json:"value,omitempty"`
	// ErrorCode classifies a failure (the testconn vocabulary); Message is the
	// honest German sentence for the wizard.
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
	// PhaseSwitchMode/PhasesInUse report the phase position the charger
	// announced during the check (absent when not reported) - the wizard's
	// hint whether D4 phase switching is observable on this device.
	PhaseSwitchMode *int `json:"phase_switch_mode,omitempty"`
	PhasesInUse     *int `json:"phases_in_use,omitempty"`
}

// ControlCheck runs the non-disruptive write short-test against the configured
// go-e charger.
func ControlCheck(ctx context.Context, doer Doer, cfg Config) ControlCheckOutcome {
	if cfg.IP == "" {
		return ControlCheckOutcome{ErrorCode: ErrInvalidRequest, Message: "keine IP-Adresse"}
	}
	host := cfg.IP
	if cfg.Port > 0 {
		host = fmt.Sprintf("%s:%d", cfg.IP, cfg.Port)
	}
	statusURL := "http://" + host + "/api/status?filter=" + readbackFilter

	readStatus := func() (status, string) {
		code, body, err := doer.Get(ctx, statusURL)
		if ec, bad := classify(code, err); bad {
			return status{}, ec
		}
		var st status
		if e := json.Unmarshal(body, &st); e != nil {
			return status{}, ErrInvalidResponse
		}
		return st, ""
	}

	before, ec := readStatus()
	if ec != "" {
		return ControlCheckOutcome{ErrorCode: ec, Message: "Die Wallbox hat nicht geantwortet."}
	}
	out := ControlCheckOutcome{PhaseSwitchMode: before.Psm, PhasesInUse: before.Pnp}
	if before.Amp == nil {
		// Nothing safe to re-write: honestly "not checkable", never a guessed
		// write (unknown is never invented into a value).
		out.ErrorCode = ErrInvalidResponse
		out.Message = "Der Schreibtest war nicht prüfbar (die Wallbox meldet keine Ampere-Vorgabe)."
		return out
	}
	val := *before.Amp
	out.Key, out.Value = "amp", val

	q := url.Values{}
	q.Set("amp", strconv.Itoa(val))
	code, body, err := doer.Get(ctx, "http://"+host+"/api/set?"+q.Encode())
	if ec, bad := classify(code, err); bad {
		out.ErrorCode = ec
		out.Message = "Der Schreibtest hat die Wallbox nicht erreicht."
		return out
	}
	var setResp map[string]json.RawMessage
	if e := json.Unmarshal(body, &setResp); e != nil {
		out.ErrorCode = ErrInvalidResponse
		out.Message = "Die Wallbox hat den Schreibtest nicht verständlich beantwortet."
		return out
	}
	if raw, okKey := setResp["amp"]; okKey {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			out.ErrorCode = ErrInvalidResponse
			out.Message = "Die Wallbox hat den Schreibtest abgelehnt: " + s
			return out
		}
	}

	after, ec := readStatus()
	if ec != "" {
		out.ErrorCode = ec
		out.Message = "Die Rücklesung nach dem Schreibtest ist fehlgeschlagen."
		return out
	}
	out.PhaseSwitchMode = after.Psm
	out.PhasesInUse = after.Pnp
	if after.Amp == nil || *after.Amp != val {
		out.ErrorCode = ErrInvalidResponse
		out.Message = "Die Wallbox hat den geschriebenen Wert nicht zurückgemeldet."
		return out
	}
	out.OK = true
	out.Message = "Steuer-Schreibtest bestätigt: Ampere-Vorgabe geschrieben und zurückgelesen."
	return out
}
