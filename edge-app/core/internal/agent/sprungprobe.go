package agent

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sprungprobe"
)

// AP-15 IP-21, box half: the Sprungprobe of a Gemeinsame Steuerung
// (docs/contracts/v2/mqtt-sprungprobe.md §2/§3, Kasten E3 = A). An order on
// .../v2/sprungprobe (not retained) makes the box lower ONE of its set values -
// the plant's PV cap or the battery's charge - by a bounded amount for 60 s,
// twice, and report what it measured itself. The probe is a CEILING composed
// most-restrictive-wins into the final setpoint (sprungprobe.Kappe/Laden): no
// new write path, no new register release, no change to the arbitration.
// Every own watchdog stands above it - the feed-in and import watchdogs, the
// frozen-value probe and the battery's protection block: the moment one
// intervenes, the probe aborts and its ceiling is gone. It needs no share
// document (it runs in S1, before arming - §5.3). Without an order nothing
// here runs and the setpoint is byte for byte what it was.
//
// A taken order ends with exactly one report: a finished report waits until
// the link takes it, and the open order is on disk (sprungprobe-offen.json) -
// after a restart the box reports it aborted with "neustart" instead of
// letting it vanish (the probe itself lives only in memory: a restart never
// resumes a jump).

// onSprungprobe handles one order from the cloud link.
func (a *Agent) onSprungprobe(payload []byte) {
	a.nimmSprungprobe(payload, time.Now().UTC())
}

// nimmSprungprobe reads and starts an order; false = not taken (another
// box's, unreadable or out of bounds, or a probe already runs).
func (a *Agent) nimmSprungprobe(payload []byte, now time.Time) bool {
	snap := a.State.Get()
	own := sprungprobe.Identitaet{Mandant: snap.TenantID, Anlage: snap.SiteID, Box: snap.DeviceID}
	auftrag, err := sprungprobe.Lesen(own, payload)
	if errors.Is(err, sprungprobe.ErrNichtIhres) {
		slog.Warn("sprungprobe order for another device ignored")
		return false
	}
	if err != nil {
		slog.Warn("sprungprobe order not taken", "err", err)
		return false
	}
	a.sprungMu.Lock()
	defer a.sprungMu.Unlock()
	if a.sprung != nil || a.sprungBericht != nil {
		slog.Warn("sprungprobe order ignored: a probe is still running or unreported", "probe", auftrag.ProbeID)
		return false
	}
	if err := a.sprungOffenMerken(offenerAuftrag{ProbeID: auftrag.ProbeID, Art: auftrag.Art}); err != nil {
		// an order that would vanish on a restart is not taken
		slog.Error("sprungprobe order not persisted; not taken", "err", err, "probe", auftrag.ProbeID)
		return false
	}
	a.sprung = sprungprobe.Neu(auftrag, now)
	slog.Info("sprungprobe order taken", "probe", auftrag.ProbeID, "art", auftrag.Art, "sprung_kw", auftrag.SprungKw)
	a.sprungAbschliessen()
	return true
}

// sprungSchritt advances a running probe on this tick with the verdicts known
// BEFORE the feed-in watchdog: an import-side guard that lowered the battery
// setpoint on this tick, a frozen connection-point value, the battery's hard
// protection stop. The zero Wunsch (no probe) changes nothing.
func (a *Agent) sprungSchritt(now time.Time, r guards.Reading, battKw *float64, bezugGriffEin bool,
	bms *guards.BmsEnvelope) sprungprobe.Wunsch {
	a.sprungMu.Lock()
	defer a.sprungMu.Unlock()
	if a.sprung == nil {
		return sprungprobe.Wunsch{}
	}
	l := sprungprobe.Lage{IstKw: math.NaN(), RegelungAn: true}
	if a.sprung.Art() == sprungprobe.ErzeugungSenken {
		l.IstKw = r.PvKw
	} else if battKw != nil {
		l.IstKw = math.Max(*battKw, 0) // + = charge (edge-entity signs)
	}
	switch {
	case bezugGriffEin:
		l.Waechter = sprungprobe.Bezugswaechter
	case !a.eingefrorenSeit(now).IsZero():
		l.Waechter = sprungprobe.Eingefroren
	case bms != nil && (bms.ChargeBlocked || bms.DischargeBlocked):
		l.Waechter = sprungprobe.Geraeteschutz
	}
	w := a.sprung.Schritt(now, l)
	a.sprungAbschliessen()
	return w
}

// sprungNachher applies the verdicts formed AFTER sprungSchritt on the same
// tick - the feed-in watchdog holding the producers back or regulating blind,
// or lowering the discharge, and control off - and returns the ceiling that
// still holds: none once aborted.
func (a *Agent) sprungNachher(now time.Time, w sprungprobe.Wunsch, export guards.ExportCap,
	entladungGesenkt, controlEnabled bool) sprungprobe.Wunsch {
	a.sprungMu.Lock()
	defer a.sprungMu.Unlock()
	if a.sprung == nil && a.sprungBericht == nil {
		return w
	}
	if a.sprung != nil {
		grund := ""
		switch {
		case export.Active && (export.Limiting || export.Blind) || entladungGesenkt:
			grund = sprungprobe.Einspeisewaechter
		case !controlEnabled:
			grund = sprungprobe.RegelungAus
		}
		if grund != "" && a.sprung.Laeuft() {
			a.sprung.Abbrechen(now, grund)
			w = sprungprobe.Wunsch{Art: w.Art}
		}
		a.sprungAbschliessen()
	}
	a.sprungSenden()
	return w
}

// sprungAbschliessen moves a finished probe's report to the outbox. Caller
// holds sprungMu.
func (a *Agent) sprungAbschliessen() {
	if a.sprung == nil {
		return
	}
	if b, ok := a.sprung.Bericht(); ok {
		a.sprungBericht = &b
		a.sprung = nil
		slog.Info("sprungprobe finished", "probe", b.ProbeID, "abgebrochen", b.Abgebrochen, "grund", b.Grund,
			"spruenge", len(b.Spruenge))
	}
}

// sprungSenden hands a waiting report to the link; it stays waiting until the
// link takes it. Caller holds sprungMu.
func (a *Agent) sprungSenden() {
	if a.sprungBericht == nil || a.sprungSendetGerade {
		return
	}
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil {
		return
	}
	b := *a.sprungBericht
	a.sprungSendetGerade = true
	go func() {
		err := link.PublishSprungprobeResult(b)
		a.sprungMu.Lock()
		defer a.sprungMu.Unlock()
		a.sprungSendetGerade = false
		if err != nil {
			slog.Warn("sprungprobe report publish failed; retrying on the next tick", "err", err, "probe", b.ProbeID)
			return
		}
		if a.sprungBericht != nil && a.sprungBericht.ProbeID == b.ProbeID {
			a.sprungBericht = nil
			a.sprungOffenVergessen()
		}
	}()
}

// offenerAuftrag is what survives a restart: enough for the one report.
type offenerAuftrag struct {
	ProbeID string          `json:"probe_id"`
	Art     sprungprobe.Art `json:"art"`
}

func (a *Agent) sprungOffenPfad() string {
	if a.Cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(a.Cfg.DataDir, "sprungprobe-offen.json")
}

// sprungOffenMerken writes the open order atomically (temp, fsync, rename).
func (a *Agent) sprungOffenMerken(o offenerAuftrag) error {
	pfad := a.sprungOffenPfad()
	if pfad == "" {
		return nil
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return err
	}
	tmp := pfad + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, pfad)
}

func (a *Agent) sprungOffenVergessen() {
	if pfad := a.sprungOffenPfad(); pfad != "" {
		if err := os.Remove(pfad); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Warn("open sprungprobe order not removed", "err", err)
		}
	}
}

// restoreSprungprobe runs in New: an order that was open when the box stopped
// is reported once, aborted with "neustart" - never resumed.
func (a *Agent) restoreSprungprobe(now time.Time) {
	pfad := a.sprungOffenPfad()
	if pfad == "" {
		return
	}
	raw, err := os.ReadFile(pfad)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	var o offenerAuftrag
	if err == nil {
		err = json.Unmarshal(raw, &o)
	}
	if err != nil || o.ProbeID == "" || (o.Art != sprungprobe.ErzeugungSenken && o.Art != sprungprobe.VerbrauchSenken) {
		slog.Warn("open sprungprobe order unreadable; dropped", "err", err)
		a.sprungOffenVergessen()
		return
	}
	a.sprungMu.Lock()
	a.sprungBericht = &sprungprobe.Bericht{ProbeID: o.ProbeID, Art: o.Art, Stellgroesse: o.Art.Stellgroesse(),
		Abgebrochen: true, Grund: sprungprobe.Neustart, Ts: now.UTC()}
	a.sprungMu.Unlock()
	slog.Info("sprungprobe order was open at the restart; reporting it aborted", "probe", o.ProbeID)
}
