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
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
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
	return a.curtailSourcesLocked()
}

// curtailSourcesLocked is curtailSources for a caller already holding srcMu.
func (a *Agent) curtailSourcesLocked() []sources.Source {
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

// --- the feed-in watchdog's REACH (dynamische Einspeisebegrenzung) ------------

// curtailReach reports how far the curtailment path can actually reach:
// curtailment-capable units configured and how many carry a per-unit First-Light
// release. It is the gate half of the feed-in watchdog's honesty statement (the
// house rule: gates come from the CORE, observations from the readback).
func (a *Agent) curtailReach() (units, certified int) {
	list := a.curtailSources()
	a.curtailMu.Lock()
	defer a.curtailMu.Unlock()
	for _, s := range list {
		if a.curtailCert[curtailUnitKey(s.Connection)] {
			certified++
		}
	}
	return len(list), certified
}

// exportGuardInfo enriches one watchdog verdict with the question the verdict
// itself cannot answer: can this cap reach a device at all?
//
// THIS IS SAFETY-CRITICAL COPY, not decoration. The operator is preparing to
// disconnect the customer-owned controller that holds the feed-in limit today,
// so a watchdog that computes a perfect cap and writes it NOWHERE must say so
// loudly rather than let anyone rely on a protection that does not exist.
// Nothing here influences execution - the two gates (kill-switch, per-unit
// release) are enforced where they always were, in the curtailment executor.
func (a *Agent) exportGuardInfo(c guards.ExportCap) *state.ExportGuardInfo {
	if !c.Active {
		return nil
	}
	units, certified := a.curtailReach()
	capKw := c.CapKw
	info := &state.ExportGuardInfo{
		LimitKw:        c.LimitKw,
		State:          string(c.State),
		Reason:         c.Reason,
		CapKw:          &capKw,
		Limiting:       c.Limiting,
		Blind:          c.Blind,
		ExportKw:       c.ExportKw,
		PvKw:           c.PvKw,
		Units:          units,
		CertifiedUnits: certified,
	}
	if c.MeasurementAge > 0 || !c.Blind {
		secs := int(c.MeasurementAge / time.Second)
		info.MeasurementAgeSeconds = &secs
	}
	switch {
	case units == 0:
		info.Reach = "Für diese Anlage ist kein abregelbarer Wechselrichter eingerichtet - " +
			"die Einspeisegrenze wird berechnet, aber an KEIN Gerät geschrieben. " +
			"Sie ist damit nicht wirksam."
	case !a.Cfg.ControlEnabled:
		info.Reach = "Die Wechselrichter-Steuerung ist ausgeschaltet (Not-Aus) - " +
			"die Einspeisegrenze wird berechnet, aber an KEIN Gerät geschrieben. " +
			"Sie ist damit nicht wirksam."
	case certified == 0:
		info.Reach = fmt.Sprintf(
			"Kein Wechselrichter ist für die Abregelung freigegeben (0 von %d) - "+
				"die Einspeisegrenze wird berechnet, aber an KEIN Gerät geschrieben. "+
				"Sie ist damit nicht wirksam.", units)
	case certified < units:
		info.Effective = true
		info.Reach = fmt.Sprintf(
			"%d von %d Wechselrichtern sind für die Abregelung freigegeben - die übrigen "+
				"können nicht zurückgeregelt werden und zählen nur als nicht regelbare Erzeugung.",
			certified, units)
	default:
		info.Effective = true
	}
	return info
}

// curtailTrackInfo turns one tracker verdict into the UI/heartbeat block.
// Absent (nil) whenever the plan does not curtail the active slot - the block
// must never claim a live correction where there is nothing to correct.
func (a *Agent) curtailTrackInfo(c guards.CurtailCap) *state.CurtailTrackInfo {
	if !c.Active {
		return nil
	}
	info := &state.CurtailTrackInfo{
		State:     string(c.State),
		Reason:    c.Reason,
		CapKw:     c.CapKw,
		PlanCapKw: c.PlanCapKw,
		LoadKw:    c.LoadKw,
		ChargeKw:  c.ChargeKw,
		Blind:     c.Blind,
	}
	if c.MeasurementAge > 0 || !c.Blind {
		secs := int(c.MeasurementAge / time.Second)
		info.MeasurementAgeSeconds = &secs
	}
	return info
}

// logExportGuard names the watchdog's state on CHANGE, never per tick (the
// OTA-blocker lesson: a refusal nobody logs is a riddle, a refusal logged every
// tick is noise the real hint drowns in). An ineffective watchdog is a WARNING -
// it is the state in which a plant believes it is protected and is not.
func (a *Agent) logExportGuard(info *state.ExportGuardInfo) {
	key := ""
	if info != nil {
		key = info.State + "|" + strconv.FormatBool(info.Effective) + "|" + info.Reach
	}
	a.curtailMu.Lock()
	changed := a.exportLogKey != key
	a.exportLogKey = key
	a.curtailMu.Unlock()
	if !changed || info == nil {
		return
	}
	if !info.Effective {
		slog.Warn("feed-in watchdog is NOT effective", "state", info.State,
			"limit_kw", info.LimitKw, "reach", info.Reach)
		return
	}
	if info.Blind {
		slog.Warn("feed-in watchdog running blind", "state", info.State, "reason", info.Reason)
		return
	}
	capKw := math.NaN()
	if info.CapKw != nil {
		capKw = *info.CapKw
	}
	slog.Info("feed-in watchdog", "state", info.State, "limit_kw", info.LimitKw,
		"cap_kw", capKw, "reach", info.Reach)
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
	// QuirkRoles/QuirkNote: register deviations the executor recognised as a
	// KNOWN, harmless firmware behaviour (today: WMaxLim_Ena answering 1 to a
	// commanded 0). They are deliberately NOT mismatches - see
	// sunspec/curtail.js evaluateReadback for the one-sided tolerance rule.
	QuirkRoles  []string `json:"quirk_roles"`
	QuirkNote   string   `json:"quirk_note"`
	Blocked     bool     `json:"blocked"`
	Reason      string   `json:"reason"`
	Enforcement *struct {
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
		QuirkRoles:     m.QuirkRoles,
		QuirkNote:      m.QuirkNote,
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
	// The register half of the First-Light evidence during THIS unit's armed
	// test. Deliberately NOT gated on m.Applied any more: since the executor
	// refreshes an active cap and VERIFIES it every cycle, a verify-only
	// readback carries a real verdict too - and that verdict is what gates the
	// clamp plateau ("the register demonstrably HOLDS the commanded value").
	// A blocked publish carries no verdict (AllMatch nil) and is skipped.
	if m.Calibration && m.AllMatch != nil {
		a.curtailCal.NoteRegister(m.SourceID, *m.AllMatch, now)
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
		u.Evidence = a.curtailCal.EvidenceFor(s.ID, now)
		if t := a.curtailCal.ActiveTestFor(s.ID, now); t != nil {
			tv := &curtailcal.TestView{
				CapKw:            t.CapKw,
				BeforeKw:         t.BeforeKw,
				SecondsRemaining: int(t.Deadline.Sub(now) / time.Second),
				RegisterOk:       t.RegisterConfirmed,
				MinObservedKw:    t.MinObservedKw,
				PlateauRequired:  curtailcal.PlateauSamples,
			}
			// The live clamp-proof progress rides the evidence (the ONE place
			// that renders the plateau), so the card never re-derives it.
			if u.Evidence != nil {
				tv.PlateauSamples = u.Evidence.PlateauSamples
				tv.AmbientKw = u.Evidence.AmbientKw
				tv.AmbientSource = u.Evidence.AmbientSource
			}
			u.Test = tv
		}
		u.CanCertify = a.curtailCal.CanCertify(s.ID, now)
		// The card must name the CAUSE of a failed/hanging execution: surface
		// the latest BLOCKED readback reason for this unit (kept while it is
		// the newest word from the executor and recent enough to matter). A
		// recognised firmware QUIRK is deliberately not one of those - it is
		// reported separately so it never reads as a fault.
		if ru, ok := a.curtailUnits[key]; ok && now.Sub(ru.CheckedAt) < 15*time.Minute {
			if ru.Blocked && ru.Reason != "" {
				u.LastError = ru.Reason
				if age := now.Sub(ru.CheckedAt); age > 0 {
					u.LastErrorAgeSeconds = int(age / time.Second)
				}
			}
			u.QuirkNote = ru.QuirkNote
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
	// The tested unit's live output PLUS the site's other curtailment units as
	// the AMBIENT REFERENCE: a sibling on the same roof is what tells a cap
	// apart from a cloud (two live false positives at Pilsting - see
	// internal/curtailcal). Without a sibling the session falls back to this
	// unit's own pre-test value, conservatively.
	var pv *float64
	refs := map[string]float64{}
	a.srcMu.Lock()
	if r, fresh := a.sourceFresh(src, now); fresh && r.pv != nil {
		v := *r.pv
		pv = &v
	}
	for _, s := range a.curtailSourcesLocked() {
		if s.ID == sourceID {
			continue
		}
		if r, fresh := a.sourceFresh(s, now); fresh && r.pv != nil {
			refs[s.ID] = *r.pv
		}
	}
	a.srcMu.Unlock()
	if pv == nil {
		return a.curtailView(now), curtailErr("Für diesen Wechselrichter liegt kein aktueller Messwert vor - bitte warten, bis er Daten liefert.")
	}

	a.curtailMu.Lock()
	capKw, err := a.curtailCal.Start(sourceID, curtailUnitKey(src.Connection), *pv, refs, now)
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
		// Name the CONCRETE gap when the finished test already has a verdict
		// ("nicht beweisbar" is a different instruction than "keine Wirkung").
		a.curtailMu.Lock()
		ev := a.curtailCal.EvidenceFor(sourceID, now)
		a.curtailMu.Unlock()
		if ev != nil && ev.Reason != "" {
			return a.curtailView(now), curtailErr("Für die Freigabe fehlt der Nachweis. %s", ev.Reason)
		}
		return a.curtailView(now), curtailErr("Für die Freigabe fehlt der Nachweis: ein Testlauf, dessen Register bestätigt wurden UND dessen gemessene Leistung nachweislich AM Limit geklemmt hat (mehrere Messwerte hintereinander), während der Wechselrichter unbegrenzt deutlich mehr liefern würde. Bitte den Test (erneut) ausführen.")
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
	// ⚠ The First-Light release is a CORE fact, never the readback's own
	// `certified` stamp (the split this block learned the hard way: a readback
	// stamp is a Layer-1 observation, never a gate authority). The per-unit
	// list below therefore reads the SAME map the count comes from - otherwise
	// the list could claim a release while the count beside it says 0.
	granted := make(map[string]bool, len(list))
	a.curtailMu.Lock()
	for _, s := range list {
		key := curtailUnitKey(s.Connection)
		if a.curtailCert[key] {
			sum.CertifiedUnits++
			granted[key] = true
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
		applying := u.Applied && u.Mode == "apply"
		if applying {
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
		// The ADDITIVE per-unit breakdown (R4a / Captain-Entscheid E2), built
		// from the SAME slice the aggregates above fold - so "2 von 2
		// freigegeben" and the list beneath it can never disagree.
		//
		// A unit without a source_id is SKIPPED: that id is the cloud's only
		// join key to the reported sources, and an entry it cannot attribute
		// would be noise at best and a wrong name at worst. The list is then
		// shorter than Units - which is why Units stays the count.
		if u.SourceID == "" {
			continue
		}
		entry := cloud.CurtailmentUnit{SourceID: u.SourceID, Certified: granted[u.UnitKey]}
		if applying && u.CapKw != nil {
			v := *u.CapKw
			entry.AppliedCapKw = &v
		}
		if u.AllMatch != nil {
			v := *u.AllMatch
			entry.Match = &v
		}
		sum.PerUnit = append(sum.PerUnit, entry)
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
	// The live feed-in watchdog rides along ADDITIVELY, straight from the
	// Snapshot the setpoint path wrote - never re-derived here, so the device
	// page and the cloud can never state two different verdicts. Absent when the
	// site has no feed-in limit configured.
	//
	// Known boundary: the block as a whole is only emitted when the plant HAS a
	// curtailment-capable unit (a heartbeat with units=0 is dropped cloud-side
	// on purpose, so "0 von 0 freigegeben" can never be fabricated). A site with
	// a feed-in limit but no curtailable inverter therefore states that case
	// locally - on :8484 and in the log - where the commissioning operator is
	// standing, and not in the fleet view.
	snap := a.State.Get()
	// The DEVICE'S OWN feed-in limit („Grenzen & Wächter" Stufe 0) rides along
	// the same way: straight from the Snapshot the raw-register path wrote, with
	// its OWN read timestamp. Absent = not read (older poll, a family whose
	// register map has no trustworthy cap, or simply not read yet) - never a
	// fabricated 0 and never "the device has no limit".
	if d := snap.DeviceExportLimit; d != nil {
		kw := d.LimitKw
		sum.DeviceExportLimitKw = &kw
		sum.DeviceExportLimitRegister = d.Register
		sum.DeviceExportLimitReadAt = d.ReadAt.Format(time.RFC3339Nano)
	}
	if g := snap.ExportGuard; g != nil {
		sum.ExportGuard = &cloud.ExportGuardSummary{
			LimitKw:   g.LimitKw,
			State:     g.State,
			Reason:    g.Reason,
			CapKw:     g.CapKw,
			Limiting:  g.Limiting,
			Blind:     g.Blind,
			Effective: g.Effective,
			Reach:     g.Reach,
		}
	}
	if c := snap.CurtailTrack; c != nil {
		sum.CurtailTrack = &cloud.CurtailTrackSummary{
			State:     c.State,
			Reason:    c.Reason,
			CapKw:     c.CapKw,
			PlanCapKw: c.PlanCapKw,
			LoadKw:    c.LoadKw,
			ChargeKw:  c.ChargeKw,
			Blind:     c.Blind,
		}
	}
	return sum
}
