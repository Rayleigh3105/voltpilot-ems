package agent

// Der gefuehrte Neutral-Zeit-Test (docs/ota-autonomie.md §3): die Kalibrierung
// der Inverter-Neutral-Zeit T am GERAET statt am Pruefstand.
//
// Bisher war T nur mit einem physisch gezogenen Kabel zu belegen
// (VP_OTA_NEUTRAL_VERIFIED). Dieser Weg macht T zu einer MESSBAREN
// Eigenschaft, die die Box mit ihrem eigenen Lesepfad selbst ermittelt: ein
// kleiner, klar von neutral abweichender Sollwert wird geschrieben und
// bestaetigt (Register-Rueckmeldung), danach hoert die Box bewusst auf, ihn
// aufzufrischen, und beobachtet ueber den GEWOEHNLICHEN Telemetrie-Lesepfad -
// der unveraendert weiterlaeuft -, wie lange der Wechselrichter ihn haelt,
// bis er von selbst neutral wird. Das volle Verfahren + die Sicherheits-
// Argumentation stehen in internal/neutralcal (rein, ohne I/O).
//
// Diese Datei verdrahtet den Wechselrichter-Wert (`neutralTestOverride`, auf
// edge/setpoint - oder eben NICHTS, siehe unten), die Beobachtung aus der
// normalen Telemetrie (`neutralObserve`, aufgerufen aus onLocalTelemetry) und
// die Register-Bestaetigung aus dem Steuer-Readback (onControlReadback in
// agent.go). Die Freigabe folgt EXAKT demselben Muster wie First-Light
// Kalibrierung + PV-Abregelung:
//
//   - derselbe globale Not-Aus (VP_CONTROL_ENABLED) gilt unveraendert;
//   - der Testwert laeuft durch DIESELBE guards.Clamp-Kette wie jeder andere
//     Sollwert - nie um sie herum;
//   - eine harte Obergrenze (neutralcal.DefaultTTL) plus eine engere Grenze
//     fuer die Schreibphase (neutralcal.DepartureTimeout) begrenzen die
//     Messdauer, und ein `time.AfterFunc`-Wachhund (unabhaengig vom Takt der
//     Oberflaeche) nimmt die Steuerung spaetestens dann wieder auf;
//   - jederzeit per Knopf abbrechbar (NeutralAbort), und ein Abbruch
//     entwertet den Nachweis sofort;
//   - ein Sicherheitsnetz bricht den Test proaktiv ab, sobald etwas ANDERES
//     die Anlage braucht: eine laufende Kalibrierung, oder eine EILIGE OTA-
//     Aktualisierung, die die Anlage neutral parken moechte (die
//     otaNeutralOverride-Bitte darf nie fuer die Dauer eines Neutral-Zeit-
//     Tests verhungern);
//   - der Test AENDERT NIE eine Guard-Grenze und weitet NIE eine Befugnis -
//     ein bestandener Test traegt ausschliesslich eine gemessene
//     Sekundenzahl in die geraete-lokale Beleg-Datei ein
//     (otaapply.SaveNeutralRecord), die otaapply.NeutralTable.ForWithMeasured
//     GLEICHWERTIG zu VP_OTA_NEUTRAL_VERIFIED heranzieht - mit Vorrang fuer
//     die Umgebungsvariable.

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/neutralcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// neutralErr builds a user-facing (German) neutralcal.ValidationError the web
// layer maps to HTTP 400 (mirrors calErr/curtailErr).
func neutralErr(format string, args ...any) error {
	return &neutralcal.ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// neutralPreflight is the shared guard for starting a test: the global
// kill-switch must be on and a battery-controllable inverter must be
// selected - the SAME preflight calibration uses, since the test writes
// through the same bounded-write mechanism.
func (a *Agent) neutralPreflight() error {
	if !a.Cfg.ControlEnabled {
		return neutralErr("Die Wechselrichter-Steuerung ist deaktiviert (Not-Aus). Neutral-Zeit-Test nicht möglich.")
	}
	sel, ok := a.GetInverter()
	if !ok {
		return neutralErr("Bitte wählen Sie zuerst Ihren Wechselrichter aus.")
	}
	if !calibrationControllable(sel) {
		return neutralErr("Für diesen Wechselrichter ist kein Neutral-Zeit-Test verfügbar.")
	}
	a.calMu.Lock()
	engaged := a.cal.Engaged(time.Now().UTC())
	a.calMu.Unlock()
	if engaged {
		return neutralErr("Es läuft gerade eine Kalibrierung - bitte zuerst beenden.")
	}
	return nil
}

// NeutralSnapshot implements web.CalibrationController (GET /api/neutral).
func (a *Agent) NeutralSnapshot() neutralcal.View {
	return a.neutralView(time.Now().UTC())
}

// NeutralStartTest implements web.CalibrationController's neutral-time entry
// point (folded into the SAME calGuard-protected surface).
func (a *Agent) NeutralStartTest() (neutralcal.View, error) {
	now := time.Now().UTC()
	if err := a.neutralPreflight(); err != nil {
		return a.neutralView(now), err
	}
	family := a.currentFamily()
	a.neutralMu.Lock()
	testKw, err := a.neutralCal.Start(family, now)
	if err == nil {
		if a.neutralWatchdog != nil {
			a.neutralWatchdog.Stop()
		}
		// Belt-and-suspenders: independent of the setpoint tick cadence, this
		// resumes normal control shortly after the hard TTL - the same
		// pattern as calibration's/curtailment's own watchdog.
		a.neutralWatchdog = time.AfterFunc(a.neutralCal.TTL()+2*time.Second, a.nudgeSetpoint)
	}
	a.neutralMu.Unlock()
	if err != nil {
		return a.neutralView(now), err
	}
	slog.Warn("Neutral-Zeit-Test gestartet", "family", family, "test_kw", testKw)
	a.nudgeSetpoint() // publish the tiny departure immediately
	return a.neutralView(now), nil
}

// NeutralAbort ends the running test immediately - control resumes on the
// very next setpoint tick, and the evidence is invalidated (an aborted run
// proves nothing).
func (a *Agent) NeutralAbort() neutralcal.View {
	now := time.Now().UTC()
	a.neutralMu.Lock()
	a.neutralCal.Abort(now)
	if a.neutralWatchdog != nil {
		a.neutralWatchdog.Stop()
	}
	a.neutralMu.Unlock()
	a.nudgeSetpoint()
	return a.neutralView(now)
}

// NeutralRecord is "Als Nachweis übernehmen": persists the current, valid,
// PASSED evidence into ota/neutral-verified.json for this family. Refused
// (400) unless the evidence is a genuine, still-valid pass with a measured
// duration - a "nicht beweisbar"/"kein_nachweis" run can NEVER be recorded,
// by construction (CanRecord mirrors that gate).
func (a *Agent) NeutralRecord() (neutralcal.View, error) {
	now := time.Now().UTC()
	family := a.currentFamily()
	if family == "" {
		return a.neutralView(now), neutralErr("Kein Wechselrichter ausgewählt.")
	}
	a.neutralMu.Lock()
	canRecord := a.neutralCal.CanRecord(family, now)
	var ev *neutralcal.Evidence
	if canRecord {
		ev = a.neutralCal.EvidenceFor(family, now)
	}
	a.neutralMu.Unlock()
	if !canRecord || ev == nil || ev.MeasuredSeconds == nil {
		return a.neutralView(now), neutralErr("Es liegt kein bestandener, noch gültiger Nachweis vor - bitte zuerst einen Test durchführen.")
	}
	rec := otaapply.NeutralRecord{
		Family:        family,
		Seconds:       *ev.MeasuredSeconds,
		MeasuredAt:    now.Format(otaapply.TimeFormat),
		TestKw:        ev.TestKw,
		SettleSamples: ev.SettleSamples,
	}
	if err := otaapply.SaveNeutralRecord(a.Cfg.DataDir, rec); err != nil {
		return a.neutralView(now), neutralErr("Der Nachweis konnte nicht gespeichert werden: %s", err.Error())
	}
	slog.Warn("Neutral-Zeit-Test: belegtes T eingetragen", "family", family, "seconds", rec.Seconds)
	return a.neutralView(now), nil
}

// neutralObserve feeds a fresh measured battery-power reading into a
// running test - called from onLocalTelemetry with EVERY sample, exactly the
// "normal read path keeps running unchanged" the mechanism relies on.
func (a *Agent) neutralObserve(batteryKw float64, now time.Time) {
	family := a.currentFamily()
	if family == "" {
		return
	}
	a.neutralMu.Lock()
	a.neutralCal.Observe(family, batteryKw, now)
	a.neutralMu.Unlock()
}

// neutralTestOverride handles the ENTIRE setpoint tick while a Neutral-Zeit-
// Test is running: either publishing the tiny bounded departure (still
// guard-clamped, still gated by the global kill-switch) or, once the
// departure is confirmed, publishing NOTHING AT ALL - the whole mechanism.
// Returns true when it handled the tick (applySetpoint must return early).
func (a *Agent) neutralTestOverride(now time.Time, r guards.Reading, limits guards.Limits) bool {
	family := a.currentFamily()

	a.neutralMu.Lock()
	if !a.neutralCal.Active(now) {
		a.neutralMu.Unlock()
		return false
	}
	// Sicherheitsnetz "Interlock": eine EILIGE OTA-Aktualisierung darf fuer
	// die Dauer eines Neutral-Zeit-Tests (bis zu neutralcal.DefaultTTL) nicht
	// verhungern - otaNeutralOverride sitzt in der Kette NACH diesem
	// Aufrufer und kaeme sonst nie zum Zug. Der Test bricht dann ab; er hat
	// ohnehin nichts mehr zu beweisen, sobald etwas anderes die Anlage
	// braucht.
	if a.otaNeutralRequestPending(now) || family == "" || family != a.neutralCal.ActiveFamily(now) {
		a.neutralCal.Abort(now)
		a.neutralMu.Unlock()
		if a.neutralWatchdog != nil {
			a.neutralWatchdog.Stop()
		}
		slog.Warn("Neutral-Zeit-Test abgebrochen (Interlock): die Anlage wird anderweitig gebraucht")
		return false
	}
	kw, publish := a.neutralCal.Command(family, now)
	a.neutralMu.Unlock()

	if !publish {
		// SILENT phase (or the test just concluded): publish NOTHING - going
		// completely silent on edge/setpoint is the entire measurement
		// mechanism (see internal/neutralcal's package doc). The mode is
		// still reported honestly so the card/heartbeat never look like a
		// stuck setpoint.
		a.State.Update(func(s *state.Snapshot) { s.Mode = state.ModeNeutralTest })
		return true
	}

	kwClamped := guards.Clamp(kw, limits, r)
	certified := a.controlCertified(family)
	msg := map[string]any{
		"battery_setpoint_kw": kwClamped,
		"source":              "neutral_test",
		"ts":                  now.Format(time.RFC3339Nano),
		"control_enabled":     a.Cfg.ControlEnabled,
		"device_certified":    certified,
		// The executor's certification bypass marker - the SAME one
		// calibration uses, so an as-yet-uncertified family can still prove
		// its neutral-time here (measuring T is a prerequisite for autonomous
		// OTA, not a consequence of it).
		"calibration":         true,
		"grid_charge_allowed": false,
		"soc_min_pct":         a.Cfg.SocMinPct,
		"soc_max_pct":         a.Cfg.SocMaxPct,
	}
	if certified {
		if p := a.certifiedControlPath(family); p != "" {
			msg["device_certified_path"] = p
		}
	}
	if cur := a.curtailSetpointExtras(now); cur != nil {
		msg["curtail"] = cur
	}
	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("neutral-time test setpoint publish failed", "err", err)
	}
	a.neutralMu.Lock()
	a.neutralCal.NoteWrite(family, now)
	a.neutralMu.Unlock()
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = state.ModeNeutralTest
		s.SetpointKw = kwClamped
		s.SlotStart = time.Time{}
		s.ControlEnabled = a.Cfg.ControlEnabled
		s.ControlCertified = certified
		s.PeakGuardActive = false
		s.PeakQuarterMeanKw = nil
		s.Trim = nil
		s.Follow = nil
	})
	a.trim.Release()
	a.follow.Release()
	return true
}

// neutralView builds GET /api/neutral: session state + a persisted-record
// echo for the currently selected family.
func (a *Agent) neutralView(now time.Time) neutralcal.View {
	family := a.currentFamily()
	v := neutralcal.View{
		ControlEnabled:          a.Cfg.ControlEnabled,
		AdminGate:               a.Cfg.CalibrationAdminSecret != "",
		Family:                  family,
		TestKw:                  neutralcal.TestKw,
		TestTTLSeconds:          int(a.neutralTTL() / time.Second),
		DepartureTimeoutSeconds: int(neutralcal.DepartureTimeout / time.Second),
	}
	if b := a.liveBattKw(); b != nil {
		v.LiveBatteryKw = b
	}
	if family == "" {
		v.Reason = "Bitte wählen Sie zuerst Ihren Wechselrichter aus."
		return v
	}
	sel, ok := a.GetInverter()
	if !ok || !calibrationControllable(sel) {
		v.Reason = "Für diesen Wechselrichter ist kein Neutral-Zeit-Test verfügbar."
		return v
	}
	v.Available = true

	a.neutralMu.Lock()
	phase := a.neutralCal.Phase(family, now)
	active := phase == neutralcal.PhaseActive || phase == neutralcal.PhaseSilent
	var (
		testKw float64
		pub    bool
	)
	if active {
		testKw, pub = a.neutralCal.Command(family, now)
	}
	ev := a.neutralCal.EvidenceFor(family, now)
	canRecord := a.neutralCal.CanRecord(family, now)
	a.neutralMu.Unlock()

	if active {
		tv := &neutralcal.TestView{
			Family: family,
			TestKw: neutralcal.TestKw,
			Phase:  phase,
		}
		if pub {
			tv.TestKw = testKw
		}
		if ev != nil {
			tv.RegisterConfirmed = ev.RegisterConfirmed
			tv.DepartureConfirmed = ev.DepartureConfirmed
			tv.SettleSamples = ev.SettleSamples
			tv.SettleRequired = ev.SettleRequired
		}
		a.neutralMu.Lock()
		tv.SecondsRemaining = a.neutralCal.RemainingSeconds(family, now)
		a.neutralMu.Unlock()
		if b := a.liveBattKw(); b != nil {
			tv.LiveBatteryKw = b
		}
		v.Test = tv
	}
	v.Evidence = ev
	v.CanRecord = canRecord

	if recs := otaapply.LoadNeutralEvidence(a.Cfg.DataDir); recs != nil {
		if rec, ok := recs[strings.ToLower(strings.TrimSpace(family))]; ok {
			v.Recorded = &neutralcal.RecordedView{Seconds: rec.Seconds, MeasuredAt: rec.MeasuredAt}
		}
	}
	return v
}

func (a *Agent) neutralTTL() time.Duration {
	if a.neutralCal == nil {
		return neutralcal.DefaultTTL
	}
	return a.neutralCal.TTL()
}

// liveBattKw reads the latest measured battery power (nil = none yet).
func (a *Agent) liveBattKw() *float64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.lastBattKw == nil {
		return nil
	}
	v := *a.lastBattKw
	return &v
}

// neutralVerifiedSummary is the additive heartbeat fact: the device-measured
// Neutral-Zeit T for the CURRENTLY selected family, if this device ever
// recorded one. It is a FACT, never an authorization - whether it actually
// opens the autonomous-apply gate is decided entirely on-device by
// otaapply.NeutralTable.ForWithMeasured (VP_OTA_NEUTRAL_VERIFIED still wins).
// nil = never measured here (or no inverter selected) - an older backend
// simply ignores the field.
func (a *Agent) neutralVerifiedSummary() *cloud.NeutralVerifiedSummary {
	family := strings.ToLower(strings.TrimSpace(a.currentFamily()))
	if family == "" {
		return nil
	}
	recs := otaapply.LoadNeutralEvidence(a.Cfg.DataDir)
	rec, ok := recs[family]
	if !ok {
		return nil
	}
	return &cloud.NeutralVerifiedSummary{
		Family: rec.Family, Seconds: rec.Seconds, MeasuredAt: rec.MeasuredAt,
	}
}
