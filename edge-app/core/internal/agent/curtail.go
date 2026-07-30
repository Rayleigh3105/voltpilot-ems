package agent

// This file wires PV-curtailment control of the fronius_sunspec Erzeuger
// SOURCES (Fronius Increment 3/3 - the Fahrplan's "Abregeln" phase executed
// for real) into the running agent:
//
//   - the additive `curtail` block on edge/setpoint (curtailSetpointExtras):
//     the GLOBAL kill-switch, the measured PV share the curtailment path
//     cannot control (the primary Deye hybrid + non-Fronius sources), and per
//     source the persisted First-Light grant + an armed bounded test. The
//     Node-RED executor (build-flows.js "PV-Abregelung") splits the plan's
//     plant-level pv_limit_kw across the units and writes Model 123
//     WMaxLimPct at DISCOVERED addresses - see edge-app/nodered/sunspec/
//     curtail.js for the split + gating truth this block feeds;
//   - the curtailment readback ingestion (onCurtailReadback, routed off
//     edge/control/readback by the curtail:true discriminator) into per-unit
//     Snapshot state for the :8484 card + the cloud heartbeat;
//   - the per-UNIT First-Light certification (internal/curtailcal): the
//     bounded, auto-reverting 80 %-of-current-output test whose evidence
//     (register readback confirmed AND measured power dropped to the cap)
//     gates the operator's "Freigeben". The grant is keyed on the PHYSICAL
//     unit (ip:port#unit_id, curtailUnitKey - byte-identical to the JS
//     unitKey) and persisted in data-dir/curtail-certified.json, so a
//     deleted + re-added source entry keeps its proof and a new inverter
//     never inherits one;
//   - the heartbeat's `curtailment` capability block (curtailmentSummary):
//     the cloud can distinguish "geplant und ausgeführt" from "geplant,
//     Anlage kann es (noch) nicht" - a plan step that cannot execute must
//     never look executed.
//
// SAFETY: the kill-switch (VP_CONTROL_ENABLED) is the outer AND on every
// branch; the bounded test is the ONE certification bypass (mirrors the
// battery First-Light); nothing here touches the battery control path, the
// Deye adapters, guards.Clamp or any existing gate - curtailment only ever
// REDUCES PV feed-in on explicitly released units.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/curtailcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// curtailUnitKey is the PHYSICAL identity of one SunSpec unit behind a
// (possibly shared) gateway. MUST stay byte-identical to
// edge-app/nodered/sunspec/curtail.js unitKey() - the flow keys its
// discovery cache and readbacks on the same string.
func curtailUnitKey(c inverter.Connection) string {
	port := c.Port
	if port <= 0 {
		port = 502
	}
	unit := c.UnitID
	if unit <= 0 {
		unit = 1
	}
	return strings.TrimSpace(c.IP) + ":" + strconv.Itoa(port) + "#" + strconv.Itoa(unit)
}

// curtailSources returns the curtailment-capable sources: fronius_sunspec
// Erzeuger (PV) measurement points. Order = the configured list order.
func (a *Agent) curtailSources() []sources.Source {
	a.srcMu.Lock()
	defer a.srcMu.Unlock()
	var out []sources.Source
	for _, s := range a.srcs {
		if s.Role == sources.RoleErzeuger && s.Communication == inverter.CommFroniusSunSpec {
			out = append(out, s)
		}
	}
	return out
}

// curtailCertified reports the persisted per-unit First-Light grant.
func (a *Agent) curtailCertified(unitKey string) bool {
	a.curtailMu.Lock()
	defer a.curtailMu.Unlock()
	return a.curtailCert[unitKey]
}

// curtailSetpointExtras builds the additive `curtail` block for edge/setpoint,
// or nil when the site has no curtailment-capable source (the setpoint is then
// byte-identical to before this feature).
//
// pv_uncontrolled_kw = the gated composite site PV minus the fresh measured PV
// of every fronius_sunspec Erzeuger source: exactly the share the curtailment
// executor can never command (the primary hybrid + other source types). The
// flow's split additionally subtracts non-writable Fronius units' measured
// output itself (it knows which units it will actually write this tick).
// Omitted while the composite PV is unknown - the split then says so honestly
// instead of assuming 0.
func (a *Agent) curtailSetpointExtras(now time.Time) map[string]any {
	list := a.curtailSources()
	if len(list) == 0 {
		return nil
	}

	entries := make([]map[string]any, 0, len(list))
	a.curtailMu.Lock()
	for _, s := range list {
		key := curtailUnitKey(s.Connection)
		e := map[string]any{
			"id":        s.ID,
			"certified": a.curtailCert[key],
			"label":     s.Label,
		}
		if s.CapacityKwp > 0 {
			e["capacity_kwp"] = s.CapacityKwp
		}
		if t := a.curtailCal.ActiveTestFor(s.ID, now); t != nil {
			e["test"] = map[string]any{"cap_kw": t.CapKw}
		}
		entries = append(entries, e)
	}
	a.curtailMu.Unlock()

	out := map[string]any{
		// The RAW kill-switch - deliberately NOT the top-level control_enabled,
		// which is ANDed with the PRIMARY inverter's certification and must
		// never gate a different physical device.
		"control_enabled": a.Cfg.ControlEnabled,
		"sources":         entries,
	}

	a.mu.Lock()
	sitePv := a.lastReading.PvKw
	a.mu.Unlock()
	if !math.IsNaN(sitePv) {
		var froniusPv float64
		a.srcMu.Lock()
		for _, s := range list {
			if r, ok := a.sourceFresh(s, now); ok && r.pv != nil {
				froniusPv += math.Max(0, *r.pv)
			}
		}
		a.srcMu.Unlock()
		out["pv_uncontrolled_kw"] = math.Round(math.Max(0, sitePv-froniusPv)*1000) / 1000
	}
	return out
}

// curtailReadbackMsg is the per-unit curtailment readback the flow publishes on
// edge/control/readback with the curtail:true discriminator.
type curtailReadbackMsg struct {
	Ts             string   `json:"ts"`
	Curtail        bool     `json:"curtail"`
	SourceID       string   `json:"source_id"`
	UnitKey        string   `json:"unit_key"`
	Label          string   `json:"label"`
	Target         string   `json:"target"`
	ControlEnabled bool     `json:"control_enabled"`
	Certified      bool     `json:"certified"`
	Calibration    bool     `json:"calibration"`
	Mode           string   `json:"mode"`
	Applied        bool     `json:"applied"`
	CapKw          *float64 `json:"cap_kw"`
	RatedKw        *float64 `json:"rated_kw"`
	AllMatch       *bool    `json:"all_match"`
	MismatchRoles  []string `json:"mismatch_roles"`
	Blocked        bool     `json:"blocked"`
	Reason         string   `json:"reason"`
	Enforcement    *struct {
		Status           string   `json:"status"`
		PossibleOverride bool     `json:"possible_override"`
		Reason           string   `json:"reason"`
		MeasuredKw       *float64 `json:"measured_kw"`
	} `json:"enforcement"`
	Registers []struct {
		Role         string   `json:"role"`
		Fc           int      `json:"fc"`
		Addr         int      `json:"addr"`
		CommandedRaw int      `json:"commanded_raw"`
		CommandedKw  *float64 `json:"commanded_kw"`
		// Nullable like the control readback's (state.ControlRegister.ActualRaw):
		// a register without an answer must not report a fabricated 0. The Fronius
		// curtailment executor always sends a value today, so this is shape-only.
		ActualRaw *int     `json:"actual_raw"`
		ActualKw  *float64 `json:"actual_kw"`
		Match     bool     `json:"match"`
	} `json:"registers"`
}

// onCurtailReadback ingests one unit's curtailment readback: per-unit Snapshot
// state (the :8484 evidence table + the heartbeat) and, during an armed test,
// the register half of the First-Light evidence. Read-only - it never
// influences execution.
func (a *Agent) onCurtailReadback(payload []byte) {
	var m curtailReadbackMsg
	if err := json.Unmarshal(payload, &m); err != nil {
		slog.Warn("curtail readback malformed; skipped")
		return
	}
	if m.SourceID == "" || m.UnitKey == "" {
		slog.Warn("curtail readback without identity; skipped")
		return
	}
	now := time.Now().UTC()
	checkedAt := now
	if m.Ts != "" {
		if t, err := time.Parse(time.RFC3339, m.Ts); err == nil {
			checkedAt = t.UTC()
		}
	}

	unit := state.CurtailUnit{
		SourceID:       m.SourceID,
		UnitKey:        m.UnitKey,
		Label:          m.Label,
		Target:         m.Target,
		CheckedAt:      checkedAt,
		ControlEnabled: m.ControlEnabled,
		Certified:      m.Certified,
		Calibration:    m.Calibration,
		Mode:           m.Mode,
		Applied:        m.Applied,
		CapKw:          m.CapKw,
		RatedKw:        m.RatedKw,
		AllMatch:       m.AllMatch,
		MismatchRoles:  m.MismatchRoles,
		Blocked:        m.Blocked,
		Reason:         m.Reason,
	}
	for _, r := range m.Registers {
		unit.Registers = append(unit.Registers, state.ControlRegister{
			Role: r.Role, Fc: r.Fc, Addr: r.Addr,
			CommandedRaw: r.CommandedRaw, CommandedKw: r.CommandedKw,
			ActualRaw: r.ActualRaw, ActualKw: r.ActualKw, Match: r.Match,
		})
	}
	if m.Enforcement != nil {
		unit.EnforcementStatus = m.Enforcement.Status
		unit.PossibleOverride = m.Enforcement.PossibleOverride
		unit.OverrideReason = m.Enforcement.Reason
		unit.MeasuredKw = m.Enforcement.MeasuredKw
		if m.Enforcement.PossibleOverride {
			slog.Warn("curtailment possibly OVERRIDDEN by a foreign controller",
				"unit", m.UnitKey, "reason", m.Enforcement.Reason)
		}
	}

	a.curtailMu.Lock()
	if a.curtailUnits == nil {
		a.curtailUnits = map[string]state.CurtailUnit{}
	}
	a.curtailUnits[m.UnitKey] = unit
	// The register half of the First-Light evidence: an APPLIED, fully
	// confirmed write during THIS unit's armed test.
	if m.Calibration && m.Applied && m.AllMatch != nil {
		a.curtailCal.NoteRegisterMatch(m.SourceID, *m.AllMatch, now)
	}
	units := a.renderCurtailUnitsLocked()
	a.curtailMu.Unlock()

	a.State.Update(func(s *state.Snapshot) { s.CurtailUnits = units })
}

// renderCurtailUnitsLocked builds the sorted per-unit slice for the Snapshot.
// Caller holds curtailMu.
func (a *Agent) renderCurtailUnitsLocked() []state.CurtailUnit {
	units := make([]state.CurtailUnit, 0, len(a.curtailUnits))
	for _, u := range a.curtailUnits {
		units = append(units, u)
	}
	sort.Slice(units, func(i, j int) bool { return units[i].UnitKey < units[j].UnitKey })
	return units
}

// curtailObserve feeds a source's measured PV into a running curtailment test
// (the enforcement half of the evidence). Called from onSourceTelemetry.
func (a *Agent) curtailObserve(sourceID string, pvKw float64, now time.Time) {
	a.curtailMu.Lock()
	a.curtailCal.Observe(sourceID, pvKw, now)
	a.curtailMu.Unlock()
}

// --- the web surface (web.CurtailController) ---------------------------------

// CurtailSnapshot implements GET /api/curtail.
func (a *Agent) CurtailSnapshot() curtailcal.View {
	return a.curtailView(time.Now().UTC())
}

func (a *Agent) curtailView(now time.Time) curtailcal.View {
	list := a.curtailSources()
	v := curtailcal.View{
		ControlEnabled: a.Cfg.ControlEnabled,
		AdminGate:      a.Cfg.CalibrationAdminSecret != "",
		MinPvKw:        curtailcal.MinPvKw,
	}
	if len(list) == 0 {
		v.Reason = "Keine Fronius-SunSpec-Erzeuger als Energiequelle eingerichtet."
		return v
	}
	v.Available = a.Cfg.ControlEnabled
	if !a.Cfg.ControlEnabled {
		v.Reason = "Die Wechselrichter-Steuerung ist als Sicherheitsvorgabe deaktiviert (Not-Aus)."
	}

	// Live per-source readings (freshness-gated) outside curtailMu.
	type live struct{ pv *float64 }
	lives := map[string]live{}
	a.srcMu.Lock()
	for _, s := range list {
		if r, ok := a.sourceFresh(s, now); ok && r.pv != nil {
			pv := *r.pv
			lives[s.ID] = live{pv: &pv}
		}
	}
	a.srcMu.Unlock()

	a.curtailMu.Lock()
	defer a.curtailMu.Unlock()
	v.TestTTLSeconds = int(a.curtailCal.TTL() / time.Second)
	for _, s := range list {
		key := curtailUnitKey(s.Connection)
		port := s.Connection.Port
		if port <= 0 {
			port = 502
		}
		unitID := s.Connection.UnitID
		if unitID <= 0 {
			unitID = 1
		}
		u := curtailcal.UnitView{
			SourceID:  s.ID,
			UnitKey:   key,
			Label:     s.Label,
			Target:    fmt.Sprintf("%s:%d (Unit %d)", s.Connection.IP, port, unitID),
			Certified: a.curtailCert[key],
		}
		if l, ok := lives[s.ID]; ok && l.pv != nil {
			u.LivePvKw = l.pv
			if *l.pv >= curtailcal.MinPvKw {
				cap := math.Round(*l.pv*curtailcal.TestFraction*10) / 10
				u.TestCapKw = &cap
			}
		}
		if t := a.curtailCal.ActiveTestFor(s.ID, now); t != nil {
			u.Test = &curtailcal.TestView{
				CapKw:            t.CapKw,
				BeforeKw:         t.BeforeKw,
				SecondsRemaining: int(t.Deadline.Sub(now) / time.Second),
				RegisterOk:       t.RegisterConfirmed,
				MinObservedKw:    t.MinObservedKw,
			}
		}
		u.Evidence = a.curtailCal.EvidenceFor(s.ID, now)
		u.CanCertify = a.curtailCal.CanCertify(s.ID, now)
		// The card must name the CAUSE of a failed/hanging execution: surface
		// the latest BLOCKED readback reason for this unit (kept while it is
		// the newest word from the executor and recent enough to matter).
		if ru, ok := a.curtailUnits[key]; ok && ru.Blocked && ru.Reason != "" && now.Sub(ru.CheckedAt) < 15*time.Minute {
			u.LastError = ru.Reason
			if age := now.Sub(ru.CheckedAt); age > 0 {
				u.LastErrorAgeSeconds = int(age / time.Second)
			}
		}
		v.Units = append(v.Units, u)
	}
	return v
}

// curtailSourceByID resolves one curtailment-capable source.
func (a *Agent) curtailSourceByID(sourceID string) (sources.Source, bool) {
	for _, s := range a.curtailSources() {
		if s.ID == sourceID {
			return s, true
		}
	}
	return sources.Source{}, false
}

func curtailErr(format string, args ...any) error {
	return &curtailcal.ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// CurtailStartTest arms the bounded curtailment test for one unit: cap = 80 %
// of the unit's CURRENT measured output, TTL-limited, auto-reverting (the
// core watchdog nudges the setpoint at the deadline; the inverter's native
// WMaxLimPct_RvrtTms is the on-device backstop). The test is the ONE
// certification bypass; the global kill-switch still wins.
func (a *Agent) CurtailStartTest(sourceID string) (curtailcal.View, error) {
	now := time.Now().UTC()
	if !a.Cfg.ControlEnabled {
		return a.curtailView(now), curtailErr("Die Wechselrichter-Steuerung ist deaktiviert (Not-Aus). Test nicht möglich.")
	}
	src, ok := a.curtailSourceByID(sourceID)
	if !ok {
		return a.curtailView(now), curtailErr("Diese Energiequelle ist nicht als Fronius-SunSpec-Erzeuger eingerichtet.")
	}
	var pv *float64
	a.srcMu.Lock()
	if r, fresh := a.sourceFresh(src, now); fresh && r.pv != nil {
		v := *r.pv
		pv = &v
	}
	a.srcMu.Unlock()
	if pv == nil {
		return a.curtailView(now), curtailErr("Für diesen Wechselrichter liegt kein aktueller Messwert vor - bitte warten, bis er Daten liefert.")
	}

	a.curtailMu.Lock()
	capKw, err := a.curtailCal.Start(sourceID, curtailUnitKey(src.Connection), *pv, now)
	if err == nil {
		if a.curtailWatchdog != nil {
			a.curtailWatchdog.Stop()
		}
		// Nudge shortly AFTER the deadline so the next setpoint publish carries
		// no test anymore -> the flow writes the release; the native RvrtTms
		// covers the crashed-core case.
		a.curtailWatchdog = time.AfterFunc(a.curtailCal.TTL()+2*time.Second, a.nudgeSetpoint)
	}
	a.curtailMu.Unlock()
	if err != nil {
		return a.curtailView(now), err
	}
	slog.Warn("curtailment First-Light test armed", "source", sourceID, "cap_kw", capKw)
	a.nudgeSetpoint() // publish the test on the setpoint immediately
	return a.curtailView(now), nil
}

// CurtailAbort ends a running test immediately (the release is written on the
// next setpoint tick; the native revert timer is the backstop).
func (a *Agent) CurtailAbort() curtailcal.View {
	now := time.Now().UTC()
	a.curtailMu.Lock()
	a.curtailCal.Abort(now)
	if a.curtailWatchdog != nil {
		a.curtailWatchdog.Stop()
	}
	a.curtailMu.Unlock()
	a.nudgeSetpoint()
	return a.curtailView(now)
}

// CurtailCertify is the deliberate per-unit hand-off: evidence-gated (register
// readback confirmed AND the measured output dropped to the cap, still within
// the grace window), persisted, rolled back if persisting fails. Mirrors
// CalibrationCertify - certification NEVER happens automatically.
func (a *Agent) CurtailCertify(sourceID string) (curtailcal.View, error) {
	now := time.Now().UTC()
	src, ok := a.curtailSourceByID(sourceID)
	if !ok {
		return a.curtailView(now), curtailErr("Diese Energiequelle ist nicht als Fronius-SunSpec-Erzeuger eingerichtet.")
	}
	key := curtailUnitKey(src.Connection)
	a.curtailMu.Lock()
	can := a.curtailCal.CanCertify(sourceID, now)
	if can {
		a.curtailCert[key] = true
	}
	a.curtailMu.Unlock()
	if !can {
		return a.curtailView(now), curtailErr("Für die Freigabe fehlt der Nachweis: ein Testlauf, dessen Register bestätigt wurden UND dessen gemessene Leistung auf die Begrenzung gefallen ist. Bitte den Test (erneut) ausführen.")
	}
	if err := a.persistCurtailCert(); err != nil {
		a.curtailMu.Lock()
		delete(a.curtailCert, key)
		a.curtailMu.Unlock()
		return a.curtailView(now), curtailErr("Die Freigabe konnte nicht gespeichert werden.")
	}
	slog.Warn("First-Light: PV curtailment CERTIFIED for this unit", "unit", key, "source", sourceID)
	a.nudgeSetpoint() // the next setpoint carries certified:true for this unit
	return a.curtailView(now), nil
}

// CurtailDecertify revokes one unit's grant ("Freigabe zurücknehmen").
func (a *Agent) CurtailDecertify(sourceID string) (curtailcal.View, error) {
	now := time.Now().UTC()
	src, ok := a.curtailSourceByID(sourceID)
	if !ok {
		return a.curtailView(now), curtailErr("Diese Energiequelle ist nicht als Fronius-SunSpec-Erzeuger eingerichtet.")
	}
	key := curtailUnitKey(src.Connection)
	a.curtailMu.Lock()
	was := a.curtailCert[key]
	delete(a.curtailCert, key)
	a.curtailMu.Unlock()
	if was {
		if err := a.persistCurtailCert(); err != nil {
			a.curtailMu.Lock()
			a.curtailCert[key] = true
			a.curtailMu.Unlock()
			return a.curtailView(now), curtailErr("Die Freigabe konnte nicht zurückgenommen werden.")
		}
		slog.Warn("First-Light: PV curtailment DECERTIFIED for this unit", "unit", key)
	}
	a.nudgeSetpoint()
	return a.curtailView(now), nil
}

// --- persisted per-unit certification (data-dir/curtail-certified.json) ------

// curtailCertVersion versions the grant file exactly like the battery
// calibration's calibrationCertVersion: a file below the current version was
// written before the current evidence gate existed and is invalidated on load.
const curtailCertVersion = 1

type curtailCertFile struct {
	Version int      `json:"version"`
	Units   []string `json:"units"`
}

func (a *Agent) curtailCertPath() string {
	return filepath.Join(a.Cfg.DataDir, "curtail-certified.json")
}

// loadCurtailCert restores the persisted per-unit grants at boot. Missing file
// = normal; corrupt/outdated = none applied (fail-safe read-only).
func (a *Agent) loadCurtailCert() {
	raw, err := os.ReadFile(a.curtailCertPath())
	if err != nil {
		if !os.IsNotExist(err) {
			slog.Warn("curtailment certification unreadable; none applied", "err", err)
		}
		return
	}
	var f curtailCertFile
	if err := json.Unmarshal(raw, &f); err != nil {
		slog.Warn("curtailment certification corrupt; none applied", "err", err)
		return
	}
	if f.Version < curtailCertVersion {
		if len(f.Units) > 0 {
			slog.Warn("First-Light: invalidating a pre-evidence-gate curtailment certification; units are read-only until re-certified",
				"units", f.Units, "was_version", f.Version, "gate_version", curtailCertVersion)
		}
		if err := a.persistCurtailCert(); err != nil {
			slog.Warn("could not persist the curtailment-certification invalidation; will retry on next boot", "err", err)
		}
		return
	}
	a.curtailMu.Lock()
	for _, u := range f.Units {
		if u = strings.TrimSpace(u); u != "" {
			a.curtailCert[u] = true
		}
	}
	a.curtailMu.Unlock()
	if len(f.Units) > 0 {
		slog.Info("First-Light: restored per-unit curtailment certification", "units", f.Units)
	}
}

// persistCurtailCert writes the grant set atomically (tmp + rename, 0600).
func (a *Agent) persistCurtailCert() error {
	a.curtailMu.Lock()
	units := make([]string, 0, len(a.curtailCert))
	for u, ok := range a.curtailCert {
		if ok {
			units = append(units, u)
		}
	}
	a.curtailMu.Unlock()
	sort.Strings(units)
	raw, err := json.MarshalIndent(curtailCertFile{Version: curtailCertVersion, Units: units}, "", "  ")
	if err != nil {
		return err
	}
	tmp := a.curtailCertPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.curtailCertPath())
}

// --- the heartbeat capability block ------------------------------------------

// curtailmentSummary builds the additive `curtailment` heartbeat block, nil
// when the site has no curtailment-capable source. Gate flags (units,
// certified counts, the kill-switch) come from the CORE (the house rule:
// observations belong to the readback, gates to the core); the execution
// observations (active/all_match/override) come from the latest per-unit
// readbacks in the Snapshot.
func (a *Agent) curtailmentSummary() *cloud.CurtailmentSummary {
	list := a.curtailSources()
	if len(list) == 0 {
		return nil
	}
	sum := &cloud.CurtailmentSummary{
		Units:          len(list),
		ControlEnabled: a.Cfg.ControlEnabled,
	}
	a.curtailMu.Lock()
	for _, s := range list {
		if a.curtailCert[curtailUnitKey(s.Connection)] {
			sum.CertifiedUnits++
		}
	}
	units := a.renderCurtailUnitsLocked()
	a.curtailMu.Unlock()

	var appliedCap float64
	var haveCap bool
	allMatch := true
	var haveApplied bool
	var latest time.Time
	for _, u := range units {
		if u.CheckedAt.After(latest) {
			latest = u.CheckedAt
		}
		if u.PossibleOverride {
			sum.PossibleOverride = true
		}
		if u.Applied && u.Mode == "apply" {
			sum.Active = true
			haveApplied = true
			if u.AllMatch != nil && !*u.AllMatch {
				allMatch = false
			}
			if u.CapKw != nil {
				appliedCap += *u.CapKw
				haveCap = true
			}
		}
	}
	if haveApplied {
		v := allMatch
		sum.AllMatch = &v
	}
	if haveCap {
		v := math.Round(appliedCap*1000) / 1000
		sum.AppliedCapKw = &v
	}
	if !latest.IsZero() {
		sum.CheckedAt = latest.Format(time.RFC3339Nano)
	}
	return sum
}
