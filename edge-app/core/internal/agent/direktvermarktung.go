package agent

// Direktvermarktung wiring (Stage 2, vp-direktvermarktung-konzept d2 §5.4
// bis §5.6): the agent's only duties here are feeding the partner's Modbus
// interface from the SAME gated composite the dashboard and cloud see (never
// a device read), composing the partner's fresh set-point into the guard
// chain as a MANDATORY limit, and exposing the §5.4 status. Everything
// partner-shaped - tunnel, firewall, interface lifecycle, events - lives in
// internal/vermarktertunnel.

import (
	"context"
	"math"
	"path/filepath"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/vermarktertunnel"
)

// vermarkterDienst is what the agent needs from the tunnel manager
// (internal/vermarktertunnel.Manager implements it; the tests use a fake).
type vermarkterDienst interface {
	Run(ctx context.Context)
	Anschluss() (vermarktertunnel.Anschluss, bool)
	SetValues(at time.Time, values map[string]float64)
	Grenze() (kw float64, wirktAuf string, aktiv bool)
	Status() vermarktertunnel.Status
}

// netzbetreiberOhneSignalPct is what the input register
// netzbetreiber_vorgabe_pct shows while the site has no registered feed-in
// limit: 100 (= no curtailment by the grid operator). PROVISIONAL - F7 of
// the concept asks luox whether a fixed 70 % belongs there instead; this one
// constant is the only place that answer lands.
const netzbetreiberOhneSignalPct = 100.0

type vermarkterState struct {
	mu sync.Mutex
	// the registered feed-in limit of the last applySetpoint tick, for the
	// input register netzbetreiber_vorgabe_pct (nil = none configured)
	netzgrenzeKw *float64
}

// initVermarkter builds the tunnel manager (from New). On a box without a
// delivered anschluss.json it idles in "ohne_profil" and starts nothing.
func (a *Agent) initVermarkter() {
	dir := a.Cfg.VermarkterDir
	if dir == "" {
		dir = filepath.Join(a.Cfg.DataDir, "vermarkter")
	}
	a.vermarkter = vermarktertunnel.New(vermarktertunnel.Options{
		Dir:                     dir,
		RAM:                     a.Cfg.VermarkterRAMDir,
		OpenVPNBin:              a.Cfg.VermarkterOpenVPN,
		LebenszeichenHoechstens: time.Duration(a.Cfg.VermarkterLebenszeichenS) * time.Second,
		// OnEreignis stays empty for now: the manager writes the flash list
		// and logs each event itself; Stage 3 hooks the heartbeat in here.
	})
}

// startVermarkter runs the manager's convergence loop (from Start).
func (a *Agent) startVermarkter(ctx context.Context) {
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		a.vermarkter.Run(ctx)
	}()
}

// feedVermarkter serves the partner's input registers from the gated
// composite site sample (called at the foldSiteSample choke point, right
// beside the Modbus mirror's feed): the grid value with its sign FLIPPED
// (grid is +import/-export, the register counts feed-in positive), the PV
// sum, the delivered reference power, and the grid operator's percentage
// from the registered feed-in limit. Absent channels are absent - the
// interface answers 0x0B for them, never a fabricated 0 (§5.1).
func (a *Agent) feedVermarkter(ts time.Time, werte map[string]float64) {
	if a.vermarkter == nil {
		return
	}
	anschluss, ok := a.vermarkter.Anschluss()
	if !ok {
		return
	}
	out := map[string]float64{
		"referenz_w":                anschluss.ReferenzWp,
		"netzbetreiber_vorgabe_pct": a.netzbetreiberPct(anschluss.ReferenzWp),
	}
	if grid, ok := werte["power_kw"]; ok {
		out["nvp_einspeisung_w"] = -grid * 1000
	}
	if pv, ok := werte["pv_power_kw"]; ok {
		out["erzeugung_w"] = math.Max(pv, 0) * 1000
	}
	a.vermarkter.SetValues(ts, out)
}

// netzbetreiberPct derives the input register netzbetreiber_vorgabe_pct from
// the registered feed-in limit the last tick carried, relative to the
// delivered reference power (F7: without a signal, 100).
func (a *Agent) netzbetreiberPct(referenzWp float64) float64 {
	a.vermarkterSt.mu.Lock()
	grenze := a.vermarkterSt.netzgrenzeKw
	a.vermarkterSt.mu.Unlock()
	if grenze == nil || referenzWp <= 0 {
		return netzbetreiberOhneSignalPct
	}
	pct := math.Round(*grenze * 1000 * 100 / referenzWp)
	return math.Max(0, math.Min(100, pct))
}

// merkeNetzgrenze keeps the plan's registered feed-in limit for the feed
// above (called every applySetpoint tick, where the plan is read anyway).
func (a *Agent) merkeNetzgrenze(exportLimit *float64) {
	a.vermarkterSt.mu.Lock()
	defer a.vermarkterSt.mu.Unlock()
	if exportLimit == nil {
		a.vermarkterSt.netzgrenzeKw = nil
		return
	}
	v := *exportLimit
	a.vermarkterSt.netzgrenzeKw = &v
}

// vermarkterGrenzen composes the partner's limit into the guard chain
// (decision E2 = A, concept §5.6): while the watchdog is fresh and the
// set-point is below the rest value,
//
//   - acting on the FEED-IN (the provisional reading of F5): the returned
//     exportLimit is min(registered limit, partner limit) - the export
//     watchdog then holds it as a COMPLIANCE limit, so the battery cascade
//     charges first and only the rest is curtailed;
//   - acting on the GENERATION (profile value vorgabe_wirkt_auf, should
//     luox answer F5 that way): the same limit returns as a PV cap instead,
//     composed min with the plant cap after the watchdog.
//
// An expired watchdog or a missing connection returns the inputs untouched:
// no partner limit is ever invented (§5.1 "ohne Lebenszeichen gilt keine
// Vorgabe").
func (a *Agent) vermarkterGrenzen(exportLimit *float64) (eff *float64, pvCap *float64) {
	if a.vermarkter == nil {
		return exportLimit, nil
	}
	kw, wirktAuf, aktiv := a.vermarkter.Grenze()
	if !aktiv {
		return exportLimit, nil
	}
	if wirktAuf == direktvermarkter.WirktAufErzeugung {
		v := kw
		return exportLimit, &v
	}
	if exportLimit == nil || kw < *exportLimit {
		v := kw
		return &v, nil
	}
	return exportLimit, nil
}

// Direktvermarktung is the §5.4 status for the local web app (web.Handler
// picks it up as the optional DirektvermarktungController).
func (a *Agent) Direktvermarktung() vermarktertunnel.Status {
	if a.vermarkter == nil {
		return vermarktertunnel.Status{Lage: vermarktertunnel.LageOhneProfil}
	}
	return a.vermarkter.Status()
}
