package agent

import (
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// AP-15 IP-18: the feed-in watchdog regulates against the share of a held
// share document (guards/exportanteil.go). Without a document every function
// here answers "none" and the watchdog is byte for byte today's.

// exportAnteil is the own feed-in share the watchdog holds; nil without a
// share document. The role decides the loop: only fuehrt regulates the whole
// limit at the connection point - steuert_mit AND a document without a role
// (the field is optional) hold the share at the box's own point, always.
// A document WITHOUT a feed-in side (the plant has explicitly no feed-in
// limit, AP-15 Folge) holds no feed-in share either: nil, the feed-in side
// runs exactly as without a document - only the import share binds.
func (a *Agent) exportAnteil() *guards.ExportAnteil {
	h := a.heldAnteile()
	if h == nil || h.EinspeisungUnbegrenzt {
		return nil
	}
	an := &guards.ExportAnteil{Fuehrt: h.Rolle == "fuehrt"}
	// An accepted document names this box in both directions with a valid
	// number (anteile.DokumentPruefen); should the text still not read, the
	// share is 0 - a held document never falls back to "no share".
	if v, err := h.AnteilKw["einspeisung"].Float64(); err == nil {
		an.AnteilKw = v
	}
	return an
}

// observeExportAnteil feeds the watchdog of a box holding a share: its own
// measuring point (the gated composite power_kw: the connection point at the
// leading box, the feeder meter at a co-controlling one) plus PV and the
// measured battery (V6). A co-controlling box WITHOUT any meter of its own
// measures the sum of its devices (B3). Never a value of another box (G1).
func (a *Agent) observeExportAnteil(ts time.Time, measurements map[string]float64, battKw *float64, fuehrt bool) (urgent bool) {
	pv, okPv := measurements["pv_power_kw"]
	if !okPv {
		return false
	}
	if g, ok := measurements["power_kw"]; ok {
		return a.export.ObserveMitSpeicher(ts, g, pv, battKw)
	}
	// A box WITH a meter whose value is missing is blind - the device sum
	// would not see the uncontrolled generation behind its feeder.
	if fuehrt || a.ownGridPointConfigured() {
		return false
	}
	if g, ok := guards.GeraeteSummeNetz(pv, battKw); ok {
		return a.export.ObserveMitSpeicher(ts, g, pv, battKw)
	}
	return false
}

// ownGridPointConfigured: the box has a meter of its own for its grid point -
// a Netz source, or the primary inverter's own grid reading (the default,
// withdrawn only by the expert opt-out PrimaryGridNotSiteTotal).
func (a *Agent) ownGridPointConfigured() bool {
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	if !a.bal.PrimaryGridNotSiteTotal {
		return true
	}
	for _, s := range a.srcs {
		if s.Role == sources.RoleNetz {
			return true
		}
	}
	return false
}

// lowerDischarge applies the watchdog's discharge ceiling (V6) to the final
// battery setpoint (+ charge / - discharge): it only ever LOWERS a discharge -
// a charge, an idle battery and a discharge below the ceiling pass unchanged,
// so the watchdog never charges and never raises anything.
func lowerDischarge(kw float64, ceilingKw *float64) float64 {
	if ceilingKw == nil || !(kw < 0) || -kw <= *ceilingKw {
		return kw
	}
	return 0 - *ceilingKw
}
