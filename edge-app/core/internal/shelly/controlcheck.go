package shelly

// The D11 SELF-SERVICE control check ("Verbindung testen"): identify the
// device (generation + metering capability - the wizard's honest "was das
// Gerät kann"), read the relay state, and prove the WRITE path ONLY when that
// is guaranteed non-disruptive: a value-identical `off` write while the relay
// is already OFF (the goe amp-re-write discipline). While the relay is ON the
// switch test is SKIPPED with an honest note - a running heat cycle is never
// interrupted, not even by a value-identical write (the task's conservative
// rule: a buggy firmware could toggle).
//
// Like the goe check it runs ONLY on an explicit operator request and is
// deliberately independent of the control flags: the wizard proves the write
// path BEFORE an operator arms them. A plain test (no control_test) never
// writes.

import "context"

// ControlCheckOutcome is the wizard-facing verdict.
type ControlCheckOutcome struct {
	// OK: the off-write went out, was accepted and the readback echoed it.
	OK bool `json:"ok"`
	// Skipped: the relay was ON, so the write test was deliberately not run
	// (an honest state, NOT a failure - ErrorCode stays empty).
	Skipped bool   `json:"skipped,omitempty"`
	Key     string `json:"key,omitempty"`
	Value   int    `json:"value,omitempty"`
	// ErrorCode classifies a failure (the testconn vocabulary); Message is
	// the honest German sentence for the wizard.
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
	// The detected capability facts (the D3 consequence the wizard names).
	Gen      int    `json:"gen,omitempty"`
	Model    string `json:"model,omitempty"`
	Metering *bool  `json:"metering,omitempty"`
}

// ControlCheck runs the non-disruptive check against the UNSAVED connection
// form (a fresh Detect - the wizard tests before anything is persisted).
func ControlCheck(ctx context.Context, doer Doer, cfg Config) ControlCheckOutcome {
	ident, err := Detect(ctx, doer, cfg)
	if err != nil {
		de, _ := err.(*DriverError)
		out := ControlCheckOutcome{ErrorCode: ErrInvalidResponse, Message: "Das Shelly-Gerät hat nicht geantwortet."}
		if de != nil {
			out.ErrorCode, out.Message = de.Code, de.Message
		}
		return out
	}
	metering := ident.HasMetering
	out := ControlCheckOutcome{Gen: ident.Gen, Model: ident.Model, Metering: &metering}

	st, de := ReadState(ctx, doer, cfg, ident)
	if de != nil {
		out.ErrorCode, out.Message = de.Code, de.Message
		return out
	}
	if st.On == nil {
		out.ErrorCode = ErrInvalidResponse
		out.Message = "Der Schaltzustand war nicht lesbar."
		return out
	}
	if *st.On {
		// Running: read-only, honestly named - never interrupt a heat cycle.
		out.Skipped = true
		out.Message = "Das Relais ist gerade eingeschaltet - der Schalttest wurde übersprungen, " +
			"um den laufenden Betrieb nicht zu unterbrechen. Gerät erkannt: " + ident.Label() + "."
		return out
	}

	// Relay OFF: the value-identical write (off while off) proves /relay/
	// bzw. Switch.Set is reachable, accepted and echoed - exactly what the
	// executor will rely on - without energizing anything.
	out.Key, out.Value = relayKey(ident), 0
	if de := SetRelay(ctx, doer, cfg, ident, false); de != nil {
		out.ErrorCode = de.Code
		out.Message = "Der Schalttest hat das Gerät nicht erreicht: " + de.Message
		return out
	}
	after, de := ReadState(ctx, doer, cfg, ident)
	if de != nil {
		out.ErrorCode = de.Code
		out.Message = "Die Rücklesung nach dem Schalttest ist fehlgeschlagen."
		return out
	}
	if after.On == nil || *after.On {
		out.ErrorCode = ErrInvalidResponse
		out.Message = "Das Gerät hat den geschriebenen Schaltzustand nicht zurückgemeldet."
		return out
	}
	out.OK = true
	out.Message = "Schalt-Schreibtest bestätigt: Relais-Befehl geschrieben und zurückgelesen " +
		"(das Relais blieb aus). Gerät erkannt: " + ident.Label() + "."
	return out
}
