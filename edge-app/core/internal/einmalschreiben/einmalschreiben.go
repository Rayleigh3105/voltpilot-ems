// Package einmalschreiben is the Go twin of the one-shot write of the plain
// Modbus TCP lane of the register write channel (edge-app/nodered/vp-palette/
// lib/register-write.js plan/runOnce and switch-write.js classify, the source
// of truth): read the register, optionally compare expected_before, write
// EXACTLY ONCE, let the device settle, read it back.
//
// It decides no policy. Which register, which value, which lane and whether a
// write is allowed at all were settled in the core (internal/registerwrite,
// internal/installerwrite.AdmitExpert) before the order reached the local bus
// (edge/register-write/request). What it re-checks is what it must to open a
// socket at all - the shape of the order and the PRIVATE target - because
// whoever opens a connection checks its target themselves.
//
// Pure: the device access is injected (Geraet), the lane is the caller's
// (internal/layer1). Both sides are held to edge-app/nodered/
// register-write-vectors.json, which register-write-vectors.gen.js produces
// from the JS modules.
package einmalschreiben

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// Object kinds and modes of the local-bus order.
const (
	KindHolding = "holding"
	KindCoil    = "coil"
	ModeApply   = "apply"
)

// Write function codes.
const (
	FcWriteCoil     = 5
	FcWriteSingle   = 6
	FcWriteMultiple = 16
)

// Settle is the pause between the write and the read-back: an EEPROM register
// needs a moment to adopt a value, and reading too early would report the old
// word as "nicht übernommen" - a lie about a write that landed.
const Settle = 2000 * time.Millisecond

// Error codes of the result.
const (
	ErrInvalidRequest   = "invalid_request"
	ErrPrecondition     = "precondition"
	ErrWriteUnconfirmed = "write_unconfirmed"
)

// Plan is what one order asks the device, every bound re-checked.
type Plan struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	UnitID         int    `json:"unitId"`
	Kind           string `json:"kind"`
	Addr           int    `json:"addr"`
	Apply          bool   `json:"apply"`
	Value          *int   `json:"value"`
	FC             int    `json:"fc"`
	ExpectedBefore *int   `json:"expectedBefore"`
}

// PlanAus is plan(): the order as the device sees it, ok=false when it is
// unusable (no or no PRIVATE host, an address outside 0..65535, an apply
// without a register word, a coil value other than 0/1, a foreign write FC, an
// expected_before that is no register word). The order is the decoded JSON
// object of edge/register-write/request.
func PlanAus(req map[string]any) (Plan, bool) {
	if req == nil {
		return Plan{}, false
	}
	host, _ := req["host"].(string)
	host = strings.TrimSpace(host)
	if host == "" || !probe.IsPrivateHost(host) {
		return Plan{}, false
	}
	kind := KindHolding
	if req["kind"] == KindCoil {
		kind = KindCoil
	}
	addr, ok := ganzzahl(req["addr"])
	if !ok || addr < 0 || addr > 65535 {
		return Plan{}, false
	}
	apply := req["mode"] == ModeApply
	p := Plan{Host: host, Port: begrenzt(req["port"], 1, 65535, 502), UnitID: begrenzt(req["unit_id"], 0, 255, 1),
		Kind: kind, Addr: addr, Apply: apply}
	if apply {
		v, ok := ganzzahl(req["value"])
		if !ok || v < 0 || v > 65535 || (kind == KindCoil && v != 0 && v != 1) {
			return Plan{}, false
		}
		p.Value = &v
	}
	fc, ok := schreibFC(kind, req["write_fc"])
	if !ok {
		return Plan{}, false
	}
	p.FC = fc
	if e, da := req["expected_before"]; da && e != nil {
		v, ok := ganzzahl(e)
		if !ok || v < 0 || v > 65535 {
			return Plan{}, false
		}
		p.ExpectedBefore = &v
	}
	return p, true
}

// schreibFC resolves the write function code. Absent = the DEFAULT of the
// object class: FC5 for a coil (there is no other), FC16 for a holding
// register - never FC6 by default, because many firmwares ACCEPT an FC6 frame
// and never apply it.
func schreibFC(kind string, raw any) (int, bool) {
	if kind == KindCoil {
		if raw == nil {
			return FcWriteCoil, true
		}
		if f, ok := raw.(float64); ok && f == FcWriteCoil {
			return FcWriteCoil, true
		}
		return 0, false
	}
	if raw == nil {
		return FcWriteMultiple, true
	}
	fc, ok := ganzzahl(raw)
	if ok && (fc == FcWriteSingle || fc == FcWriteMultiple) {
		return fc, true
	}
	return 0, false
}

// ganzzahl is JavaScript's Math.floor(Number(v)) for the shapes JSON carries:
// a number or a numeric string; absent, null and "" are no number.
func ganzzahl(v any) (int, bool) {
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case json.Number:
		var err error
		if f, err = x.Float64(); err != nil {
			return 0, false
		}
	case string:
		s := strings.TrimSpace(x)
		if x == "" {
			return 0, false
		}
		if s == "" {
			return 0, true // Number("  ") is 0
		}
		var err error
		if f, err = strconv.ParseFloat(s, 64); err != nil {
			return 0, false
		}
	case bool:
		if x {
			return 1, true
		}
		return 0, true
	default:
		return 0, false
	}
	f = math.Floor(f)
	if math.IsNaN(f) || math.IsInf(f, 0) || f > math.MaxInt32 || f < math.MinInt32 {
		return 0, false
	}
	return int(f), true
}

func begrenzt(v any, lo, hi, fallback int) int {
	n, ok := ganzzahl(v)
	if !ok || n < lo || n > hi {
		return fallback
	}
	return n
}

// Ergebnis is the answer on edge/register-write/result (without request_id).
// Before/After are nil when the register could not be read - "not read" and
// "read as 0" are different facts.
type Ergebnis struct {
	OK        bool   `json:"ok"`
	Wrote     bool   `json:"wrote"`
	Before    *int   `json:"before,omitempty"`
	After     *int   `json:"after,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Ungueltig is the answer to an order PlanAus refuses.
func Ungueltig() Ergebnis {
	return Ergebnis{ErrorCode: ErrInvalidRequest, Message: "Der Schreibauftrag ist unvollständig oder unzulässig."}
}

// Geraet is the device access of one order. Every failure is a message in the
// words of the palette's connection manager (modbusprofil.Meldung*), so
// Klassifiziere finds the same class on both box types.
type Geraet interface {
	LiesRegister(ctx context.Context, p Plan) ([]uint16, string)
	LiesSpulen(ctx context.Context, p Plan) ([]bool, string)
	Schreibe(ctx context.Context, p Plan) string
	Warte(ctx context.Context, d time.Duration)
}

// Ausfuehren is runOnce() for an admitted plan, under the caller's lane. The
// order is the honesty:
//  1. READ - it IS the preview, and on a real write the "before".
//  2. COMPARE - expected_before is judged here, inside the one claim on the
//     device, so no other writer can slip in between.
//  3. WRITE - EXACTLY ONCE; `wrote` is set before the frame goes out, because
//     from then on the write may have landed even if the answer is lost.
//  4. READ BACK - a failed read-back never turns a landed write into a
//     failure: the value is honestly absent.
func Ausfuehren(ctx context.Context, p Plan, g Geraet) Ergebnis {
	before, meldung := liesEins(ctx, p, g)
	if meldung != "" {
		code, satz := Klassifiziere(meldung)
		return Ergebnis{ErrorCode: code, Message: satz}
	}
	if !p.Apply {
		return Ergebnis{OK: true, Before: before}
	}
	if p.ExpectedBefore != nil && (before == nil || *before != *p.ExpectedBefore) {
		ist := "einem nicht lesbaren Wert"
		if before != nil {
			ist = strconv.Itoa(*before)
		}
		return Ergebnis{Before: before, ErrorCode: ErrPrecondition,
			Message: "Das Register steht inzwischen auf " + ist + ", erwartet wurde " +
				strconv.Itoa(*p.ExpectedBefore) + ". Es wurde NICHTS geschrieben."}
	}
	if meldung := g.Schreibe(ctx, p); meldung != "" {
		code, satz := Klassifiziere(meldung)
		if code == modbusprofil.ErrNoAnswer {
			code = ErrWriteUnconfirmed
		}
		return Ergebnis{Wrote: true, Before: before, ErrorCode: code,
			Message: "Der Schreibbefehl ging hinaus, das Ergebnis ist aber unbestätigt: " + satz}
	}
	g.Warte(ctx, Settle)
	after, _ := liesEins(ctx, p, g)
	return Ergebnis{OK: true, Wrote: true, Before: before, After: after}
}

// liesEins reads the addressed object: nil without a usable word, the failure
// message when the read itself failed.
func liesEins(ctx context.Context, p Plan, g Geraet) (*int, string) {
	if p.Kind == KindCoil {
		bits, meldung := g.LiesSpulen(ctx, p)
		if meldung != "" || len(bits) == 0 {
			return nil, meldung
		}
		v := 0
		if bits[0] {
			v = 1
		}
		return &v, ""
	}
	w, meldung := g.LiesRegister(ctx, p)
	if meldung != "" || len(w) == 0 {
		return nil, meldung
	}
	v := int(w[0])
	return &v, ""
}

// klassen is switch-write.js classify()'s table: the prefixes of the probe
// channel with the sentences of a write ("Schaltbefehl").
var klassen = []struct{ anfang, code, satz string }{
	{modbusprofil.MeldungAufbauTimeout, modbusprofil.ErrUnreachable, "Das Gerät ist unter dieser Adresse nicht erreichbar."},
	{"Verbindung fehlgeschlagen", modbusprofil.ErrUnreachable, "Das Gerät ist unter dieser Adresse nicht erreichbar."},
	{modbusprofil.MeldungAntwortZeit, modbusprofil.ErrNoAnswer, "Das Gerät antwortet nicht auf den Schaltbefehl (Unit-ID und Register prüfen)."},
	{modbusprofil.MeldungGesamtZeit, modbusprofil.ErrNoAnswer, "Das Gerät antwortet nicht auf den Schaltbefehl (Unit-ID und Register prüfen)."},
	{modbusprofil.MeldungGeschlossen, modbusprofil.ErrNoAnswer, "Das Gerät hat die Verbindung ohne Antwort beendet."},
	{modbusprofil.MeldungAusnahme, modbusprofil.ErrNoAnswer, "Das Gerät weist den Schaltbefehl ab - dieses Register lässt sich dort vermutlich nicht beschreiben."},
	{modbusprofil.MeldungWarteschlange, modbusprofil.ErrTimeout, "Das Gerät wird gerade von einer anderen Abfrage belegt. Bitte erneut versuchen."},
}

// Klassifiziere maps a failure message onto its class and sentence; the
// original text always travels along, anything unplaceable is
// invalid_response.
func Klassifiziere(meldung string) (code, satz string) {
	for _, k := range klassen {
		if strings.HasPrefix(meldung, k.anfang) {
			return k.code, k.satz + " (" + meldung + ")"
		}
	}
	return modbusprofil.ErrInvalidResponse, "Die Antwort des Geräts war nicht lesbar (" + meldung + ")."
}
