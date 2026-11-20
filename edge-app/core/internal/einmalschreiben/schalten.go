package einmalschreiben

import (
	"context"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
)

// The guided switch test (vp-palette/lib/switch-write.js writePlan/runWrite):
// the core has already admitted the cloud's request (identity, expiry, private
// target, rate limit) and armed the auto-off watchdog; the executor performs
// exactly the ONE write it is handed, optionally reads back, and names every
// failure. It decides nothing.

// SchaltErgebnis is one result on edge/switch/result.
type SchaltErgebnis struct {
	ID        string `json:"id"`
	OK        bool   `json:"ok"`
	Readback  *int   `json:"readback,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// SchaltPlanAus is writePlan: a host, an address and a value in 0..65535, a
// write function code 5/6/16 (a coil only 0/1); port and unit fall back to
// 502/1 when out of range. A present JSON null is Number(null) = 0.
func SchaltPlanAus(op map[string]any) (Plan, bool) {
	if op == nil {
		return Plan{}, false
	}
	host, _ := op["host"].(string)
	host = strings.TrimSpace(host)
	if host == "" {
		return Plan{}, false
	}
	addr, ok := zahlFeld(op, "address")
	if !ok || addr < 0 || addr > 65535 {
		return Plan{}, false
	}
	value, ok := zahlFeld(op, "value")
	if !ok || value < 0 || value > 65535 {
		return Plan{}, false
	}
	fc, ok := zahlFeld(op, "fc")
	if !ok || (fc != FcWriteCoil && fc != FcWriteSingle && fc != FcWriteMultiple) {
		return Plan{}, false
	}
	if fc == FcWriteCoil && value != 0 && value != 1 {
		return Plan{}, false
	}
	kind := KindHolding
	if fc == FcWriteCoil {
		kind = KindCoil
	}
	return Plan{Host: host, Port: begrenztFeld(op, "port", 1, 65535, 502), UnitID: begrenztFeld(op, "unit_id", 0, 255, 1),
		Kind: kind, Addr: addr, Apply: true, Value: &value, FC: fc}, true
}

// Schalten is runWrite for one op, under the caller's lane: write, then - when
// the op names a readback address - read it back (a failed or empty readback
// is still a switched op: the write went through).
func Schalten(ctx context.Context, op map[string]any, g Geraet) SchaltErgebnis {
	id, _ := op["id"].(string)
	if id == "" {
		id = "schalten"
	}
	p, ok := SchaltPlanAus(op)
	if !ok {
		return SchaltErgebnis{ID: id, ErrorCode: modbusprofil.ErrInvalidRequest, Message: "Der Schaltbefehl ist unvollständig oder unzulässig."}
	}
	if meldung := g.Schreibe(ctx, p); meldung != "" {
		code, satz := Klassifiziere(meldung)
		return SchaltErgebnis{ID: id, ErrorCode: code, Message: satz}
	}
	if rb, da := op["readback_address"]; !da || rb == nil {
		return SchaltErgebnis{ID: id, OK: true}
	}
	rp := p
	rp.Addr = begrenztFeld(op, "readback_address", 0, 65535, p.Addr)
	var v *int
	if p.Kind == KindCoil {
		if bits, m := g.LiesSpulen(ctx, rp); m == "" && len(bits) > 0 {
			b := 0
			if bits[0] {
				b = 1
			}
			v = &b
		}
	} else if regs, m := g.LiesRegister(ctx, rp); m == "" && len(regs) > 0 {
		w := int(regs[0])
		v = &w
	}
	return SchaltErgebnis{ID: id, OK: true, Readback: v}
}

// zahlFeld is Math.floor(Number(op[key])): absent is no number, a present
// null is 0.
func zahlFeld(op map[string]any, key string) (int, bool) {
	v, da := op[key]
	if !da {
		return 0, false
	}
	if v == nil {
		return 0, true
	}
	return ganzzahl(v)
}

// begrenztFeld is boundedInt(op[key], lo, hi, fallback).
func begrenztFeld(op map[string]any, key string, lo, hi, fallback int) int {
	n, ok := zahlFeld(op, key)
	if !ok || n < lo || n > hi {
		return fallback
	}
	return n
}
