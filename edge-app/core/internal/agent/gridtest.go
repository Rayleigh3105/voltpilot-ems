package agent

// Netz-Sollwert-Test - die KERN-Haelfte (Konzept `vp-deye-netzseitig-drossel-k2`,
// Paket P1). Die ganze Regel und das ganze Sicherheits-Argument liegen im reinen
// `internal/curtailcal` (gridtest.go); diese Datei sammelt nur die Tatsachen,
// traegt die Anweisung in den veroeffentlichten Sollwert und die Beobachtungen
// zurueck in den Zustandsautomaten.
//
// SIE IST DIE SCHWESTER von agent/calibration.go (dem Batterie-First-Light) und
// agent/curtail.go (dem Fronius-Abregeltest) - dieselbe Bauform:
//
//	armieren (Betreiber-Kennwort) -> gridTestOverride veroeffentlicht den
//	Sollwert statt des Plans -> Layer 1 schreibt -> Rueckmeldung + Messung
//	fuellen den Beweis -> TTL/Abbruch fahren die Rueckkehr -> fertig.
//
// ⚠ ES GIBT KEINEN AUTOMATISCHEN EINTRITT. Weder ein Fahrplan-Slot noch eine
// Wolken-Anweisung kann hier hineinfuehren; der einzige Weg ist
// POST /api/curtail/grid-test hinter demselben Betreiber-Kennwort wie jede
// andere physische Steuer-Mutation. Der Produktivpfad („netzseitiger
// Drossel-Slot") ist Paket 3 und wird erst nach dem Live-Test gebaut.
//
// ⚠ DIE FRONIUS-KAPPEN BLEIBEN, WIE SIE SIND (§3.1). Der Testsollwert traegt
// deshalb `pv_limit_kw` des LAUFENDEN Plans unveraendert weiter: ohne dieses
// Feld plant der Abregel-Executor eine FREIGABE (`sunspec/curtail.js`:
// `plantCap == null -> mode 'release'`), und damit haette der Test die halbe
// Anlage veraendert, die er als Referenz braucht.

import (
	"encoding/json"
	"log/slog"
	"math"
	"strconv"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/curtailcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// gridTestSource ist die Quelle, unter der der Testpfad seinen Sollwert
// veroeffentlicht. Layer 1 unterscheidet daran nichts (der `grid_test`-Block
// tut das), aber die Rueckmeldung traegt sie zurueck - und nur ein Zyklus
// DIESER Quelle darf den Beweis fuellen.
const gridTestSource = "grid-test"

// --- Voraussetzungen sammeln --------------------------------------------------

// gridPrimaryDeye meldet, ob der PRIMAERE Wechselrichter ein Deye auf dem
// Solarman-Pfad ist, und seine Nennleistung. Der netzseitige Modus lebt im
// Deye-Fernsteuerblock - jedes andere Geraet hat ihn schlicht nicht.
func (a *Agent) gridPrimaryDeye() (label, target string, ratedKw float64, ok bool) {
	a.invMu.Lock()
	sel := a.inv
	a.invMu.Unlock()
	if sel == nil || sel.Communication != inverter.CommSolarmanV5 {
		return "", "", 0, false
	}
	port := sel.Connection.Port
	if port <= 0 {
		port = 8899
	}
	label = sel.Label
	if label == "" {
		label = sel.Model
	}
	return label, sel.Connection.IP + ":" + strconv.Itoa(port), sel.RatedKw, true
}

// gridFroniusPv summiert die FRISCHE PV der Abregel-Einheiten - die
// Umgebungs-Referenz, die eine Drosselung von einer Wolke unterscheidet.
// nil, wenn keine einzige Einheit einen frischen Messwert liefert (Schweigen
// ist keine Referenz).
func (a *Agent) gridFroniusPv(now time.Time) *float64 {
	list := a.curtailSources()
	if len(list) == 0 {
		return nil
	}
	var sum float64
	var any bool
	a.srcMu.Lock()
	for _, s := range list {
		if r, ok := a.sourceFresh(s, now); ok && r.pv != nil {
			sum += math.Max(0, *r.pv)
			any = true
		}
	}
	a.srcMu.Unlock()
	if !any {
		return nil
	}
	return &sum
}

// gridFroniusHealthy beantwortet §3.1 „Fronius: beide freigegeben, all_match,
// kein possible_override". Es ist die Bedingung dafuer, dass die Fronius-Kappen
// waehrend des Tests nachweislich stehen bleiben.
func (a *Agent) gridFroniusHealthy(now time.Time) (bool, string) {
	list := a.curtailSources()
	if len(list) == 0 {
		// Ohne Fronius gibt es keine Umgebungs-Referenz und keinen zweiten
		// Regler - beides Voraussetzungen dieses Tests.
		return false, "Es ist kein Fronius-Wechselrichter als Energiequelle eingerichtet - ohne ihn fehlt die Vergleichsgröße für „war es die Drosselung oder die Wolke?“."
	}
	a.curtailMu.Lock()
	defer a.curtailMu.Unlock()
	for _, s := range list {
		key := curtailUnitKey(s.Connection)
		if !a.curtailCert[key] {
			return false, "Mindestens ein Fronius-Wechselrichter ist für die Abregelung noch nicht freigegeben."
		}
		u, ok := a.curtailUnits[key]
		if !ok || now.Sub(u.CheckedAt) > 5*time.Minute {
			return false, "Von mindestens einem Fronius-Wechselrichter liegt keine aktuelle Rückmeldung vor."
		}
		if u.PossibleOverride {
			return false, "Ein Fronius-Wechselrichter meldet einen möglichen Fremdregler - während des Tests müssen seine Kappen stehen."
		}
		if u.AllMatch != nil && !*u.AllMatch {
			return false, "Ein Fronius-Wechselrichter hält seine Begrenzung gerade nicht."
		}
	}
	return true, ""
}

// gridPlanBatteryOk: der Fahrplan will im laufenden UND im naechsten Slot laden
// oder ruhen (§3.1). Ein STALER oder fehlender Plan ist ausdruecklich NICHT ok -
// die Sicherung faehrt dann Eigenverbrauch und darf entladen.
func gridPlanBatteryOk(p *plan.Plan, now time.Time) bool {
	if p == nil || !p.Fresh(now) {
		return false
	}
	kw, _, ok := p.ActiveSetpoint(now)
	if !ok || kw < 0 {
		return false
	}
	width := time.Duration(p.SlotMinutes) * time.Minute
	if width <= 0 {
		return false
	}
	next, _, okNext := p.ActiveSetpoint(now.Add(width))
	// Kein Folge-Slot heisst: der Horizont endet hier. Dann ist die Bedingung
	// „auch im naechsten Slot" nicht belegbar - und was nicht belegbar ist,
	// wird nicht behauptet.
	return okNext && next >= 0
}

// gridConditions traegt alle Tatsachen aus §3.1 zusammen.
func (a *Agent) gridConditions(mode string, now time.Time) curtailcal.GridConditions {
	a.mu.Lock()
	p := a.currentPlan
	r := a.lastReading
	readingAt := a.lastReadingAt
	batt := a.lastBattKw
	grid := a.lastGridKw
	a.mu.Unlock()

	_, _, ratedKw, isDeye := a.gridPrimaryDeye()
	family := a.currentFamily()
	certified := a.controlCertified(family)

	snap := a.State.Get()
	remotePath := isDeye && snap.Control != nil && snap.Control.ControlPath == "remote"

	froniusPv := a.gridFroniusPv(now)
	froniusOk, froniusNote := a.gridFroniusHealthy(now)

	cond := curtailcal.GridConditions{
		Mode:           mode,
		ControlEnabled: a.Cfg.ControlEnabled,
		Certified:      certified,
		RemotePath:     remotePath,
		RatedKw:        ratedKw,
		PlanBatteryOk:  gridPlanBatteryOk(p, now),
		PlanNative:     snap.Native != nil && snap.Native.Active,
		FroniusHealthy: froniusOk,
		FroniusNote:    froniusNote,
		FroniusPvKw:    froniusPv,
		BatteryKw:      batt,
	}
	if !readingAt.IsZero() {
		cond.MeasurementAge = now.Sub(readingAt)
	} else {
		// Nie gemessen = unendlich alt. Eine 0 waere die gefaehrlichere Auskunft.
		cond.MeasurementAge = 24 * time.Hour
	}
	if !math.IsNaN(r.PvKw) {
		v := r.PvKw
		cond.SitePvKw = &v
		if froniusPv != nil {
			// Der Deye-Anteil ist die Anlagen-PV minus der frischen Fronius-PV -
			// dieselbe Rechnung, mit der der Sollwert `pv_uncontrolled_kw`
			// traegt (agent/curtail.go).
			d := math.Max(0, v-*froniusPv)
			cond.DeyePvKw = &d
		}
	}
	if !math.IsNaN(r.SocPct) {
		v := r.SocPct
		cond.SocPct = &v
	}
	if grid != nil {
		v := *grid
		cond.GridKw = &v
	}
	a.gridMu.Lock()
	cond.PvStableFor = a.gridPv.StableFor(now)
	a.gridMu.Unlock()
	return cond
}

// --- Beobachtung --------------------------------------------------------------

// gridObserve fuettert den PV-Stabilitaets-Beobachter (immer) und, waehrend ein
// Test laeuft, den Zustandsautomaten. Sie haengt am Telemetrie-Pfad, nicht am
// Sollwert-Takt: der Beweis braucht den ~5-10-s-Takt der Messung, nicht den
// ~10-s-Takt des Schreibens.
func (a *Agent) gridObserve(now time.Time, measurements map[string]float64, battKw *float64) {
	pv, hasPv := measurements["power_kw"]
	_ = pv
	sitePv, hasSitePv := measurements["pv_power_kw"]
	a.gridMu.Lock()
	if hasSitePv {
		a.gridPv.Observe(sitePv, now)
	}
	active := a.gridCal.Active(now)
	a.gridMu.Unlock()
	if !active {
		return
	}

	obs := curtailcal.GridObservation{BatteryKw: battKw}
	if g, ok := measurements["power_kw"]; ok {
		v := g
		obs.GridKw = &v
	}
	if hasSitePv {
		v := sitePv
		obs.SitePvKw = &v
	}
	if s, ok := measurements["soc_pct"]; ok {
		v := s
		obs.SocPct = &v
	}
	if f := a.gridFroniusPv(now); f != nil {
		obs.FroniusPvKw = f
		if obs.SitePvKw != nil {
			d := math.Max(0, *obs.SitePvKw-*f)
			obs.DeyePvKw = &d
		}
	}
	_ = hasPv

	a.gridMu.Lock()
	a.gridCal.Observe(obs, now)
	stillActive := a.gridCal.Active(now)
	a.gridMu.Unlock()
	// Ein Abbruch aus der Beobachtung heraus (Vorzeichen falsch, Huelle
	// verlassen, SoC am Rand) muss SOFORT die Rueckkehr veroeffentlichen -
	// nicht erst beim naechsten Sollwert-Takt.
	if active && !stillActive {
		a.nudgeSetpoint()
	}
}

// gridNoteReadback traegt das Urteil eines Rueckmelde-Zyklus in den
// Zustandsautomaten. Nur ein ENTSCHIEDENER Zyklus (held/mismatch) zaehlt - ein
// Zyklus ohne Antwort ist keine Aussage (die Regel des ganzen Hauses).
func (a *Agent) gridNoteReadback(held bool, now time.Time) {
	a.gridMu.Lock()
	before := a.gridCal.Active(now)
	a.gridCal.NoteRegister(held, now)
	after := a.gridCal.Active(now)
	a.gridMu.Unlock()
	if before && !after {
		a.nudgeSetpoint()
	}
}

// --- Der Sollwert-Ueberschreiber ----------------------------------------------

// gridTestOverride veroeffentlicht den Testsollwert STATT des Plan-/Arbiter-
// Wertes und meldet true, sodass applySetpoint frueh zurueckkehrt. Er ist
// wortgleich zur Bauform von calibrationOverride - mit EINEM Unterschied, und
// der ist eine Sicherheits-Aussage: die Kalibrierung umgeht die
// ZERTIFIZIERUNG (sie verdient sie ja erst), dieser Test umgeht GAR NICHTS.
// Er verlangt Not-Aus AN, Zertifikat vorhanden und Fernsteuerpfad - Start
// lehnt sonst ab -, und der veroeffentlichte `control_enabled` ist dieselbe
// Konjunktion wie im Normalbetrieb.
func (a *Agent) gridTestOverride(now time.Time, p *plan.Plan) bool {
	a.gridMu.Lock()
	cmd, engaged := a.gridCal.Publish(now)
	a.gridMu.Unlock()
	if !engaged {
		return false
	}

	family := a.currentFamily()
	certified := a.controlCertified(family)
	controlEnabled := a.Cfg.ControlEnabled && certified

	msg := map[string]any{
		// Netzseitig kommandieren wir KEINEN Batterie-Sollwert - der
		// Wechselrichter fuehrt die Batterie dann selbst. Die 0 ist deshalb
		// keine Fuellung, sondern die Aussage des Neutral-/Rueckkehr-Schrittes
		// und der Wert, den `controlRoute` als gueltigen Sollwert verlangt.
		"battery_setpoint_kw": 0.0,
		"source":              gridTestSource,
		"ts":                  now.Format(time.RFC3339Nano),
		"control_enabled":     controlEnabled,
		"device_certified":    certified,
		// Ein Netz-Sollwert-Test laedt nie aus dem Netz (EEG-sicher und fuer
		// den Nachweis unnoetig) - genau wie die Kalibrierung.
		"grid_charge_allowed": false,
		"soc_min_pct":         a.Cfg.SocMinPct,
		"soc_max_pct":         a.Cfg.SocMaxPct,
		"battery_mode":        batteryModeSetpoint,
		// DER Block: die ganze Anweisung an Layer 1.
		"grid_test": cmd,
	}
	if certified {
		if pth := a.certifiedControlPath(family); pth != "" {
			msg["device_certified_path"] = pth
		}
	}
	// Die Fronius-Kappen bleiben, wie sie sind: die Plankappe reist
	// UNVERAENDERT weiter (siehe der Dateikopf).
	if lim := p.ActivePvLimit(now); lim != nil && *lim >= 0 {
		msg["pv_limit_kw"] = math.Round(*lim*1000) / 1000
	}
	if cur := a.curtailSetpointExtras(now); cur != nil {
		msg["curtail"] = cur
	}

	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("grid-test setpoint publish failed", "err", err)
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = state.ModeCalibration
		s.SetpointKw = 0
		s.SlotStart = time.Time{}
		s.ControlEnabled = controlEnabled
		s.ControlCertified = certified
		s.PeakGuardActive = false
		s.PeakQuarterMeanKw = nil
		// Ein begrenzter Testschreibvorgang BESITZT den Wechselrichter fuer
		// seine TTL - keine oekonomische Ausfuehrungsart darf daneben einen
		// scharfen Zustand behaupten.
		s.Trim = nil
		s.Follow = nil
		s.Absorb = nil
		s.Native = nil
	})
	a.trim.Release()
	a.follow.Release()
	a.absorb.Release()
	a.native.Release()
	return true
}

// --- Die Web-Flaeche ----------------------------------------------------------

// GridTestSnapshot implementiert GET /api/curtail/grid-test.
func (a *Agent) GridTestSnapshot() curtailcal.GridView {
	return a.gridView(curtailcal.GridModeGrid, time.Now().UTC())
}

func (a *Agent) gridView(mode string, now time.Time) curtailcal.GridView {
	label, target, _, isDeye := a.gridPrimaryDeye()
	v := curtailcal.GridView{
		Supported:      isDeye,
		ControlEnabled: a.Cfg.ControlEnabled,
		AdminGate:      a.Cfg.CalibrationAdminSecret != "",
		TTLSeconds:     int(curtailcal.GridDefaultTTL / time.Second),
		AcTTLSeconds:   int(curtailcal.GridAcTTL / time.Second),
		Label:          label,
		Target:         target,
	}
	if !isDeye {
		v.Reason = "Der netzseitige Fernsteuermodus lebt im Deye-Registerblock 1100-1121. Dieser Anlage ist kein Deye als Wechselrichter zugeordnet."
		return v
	}
	cond := a.gridConditions(mode, now)
	v.Preconditions = curtailcal.GridPreconditions(cond)

	a.gridMu.Lock()
	v.Run = a.gridCal.RunView(now)
	v.Evidence = a.gridCal.Evidence(now)
	engaged := a.gridCal.Engaged(now)
	a.gridMu.Unlock()

	if engaged {
		v.Reason = "Es läuft gerade ein Netz-Sollwert-Test."
		return v
	}
	if missing := curtailcal.GridPreconditionsFailed(v.Preconditions); len(missing) > 0 {
		v.Reason = "Noch nicht möglich: " + joinGerman(missing) + "."
		return v
	}
	v.Available = true
	return v
}

// joinGerman haengt eine Liste zu einem lesbaren Satzteil zusammen.
func joinGerman(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	out := ""
	for i, s := range items {
		switch {
		case i == 0:
			out = s
		case i == len(items)-1:
			out += " und " + s
		default:
			out += ", " + s
		}
	}
	return out
}

// GridTestStart armiert einen Lauf. Er ist der EINZIGE Eintritt in den
// netzseitigen Modus, und er liegt hinter demselben Betreiber-Kennwort wie
// jede andere physische Steuer-Mutation (web.calGuard).
func (a *Agent) GridTestStart(mode string) (curtailcal.GridView, error) {
	now := time.Now().UTC()
	if mode == "" {
		mode = curtailcal.GridModeGrid
	}
	if _, _, _, isDeye := a.gridPrimaryDeye(); !isDeye {
		return a.gridView(mode, now), &curtailcal.ValidationError{
			Msg: "Der netzseitige Fernsteuermodus lebt im Deye-Registerblock 1100-1121. Dieser Anlage ist kein Deye als Wechselrichter zugeordnet.",
		}
	}
	cond := a.gridConditions(mode, now)

	a.gridMu.Lock()
	t, err := a.gridCal.Start(cond, now)
	if err == nil {
		if a.gridWatchdog != nil {
			a.gridWatchdog.Stop()
		}
		// Die Selbst-Ruecknahme, unabhaengig von der Aufmerksamkeit des
		// Bedieners: einmal auf die TTL (dort beginnt die Rueckkehr) und einmal
		// auf ihr Ende (dort endet der Ueberschreiber und der Plan uebernimmt).
		d := t.Deadline.Sub(now) + 2*time.Second
		a.gridWatchdog = time.AfterFunc(d, func() {
			a.nudgeSetpoint()
			a.gridMu.Lock()
			a.gridWatchdog = time.AfterFunc(curtailcal.GridReturnGrace+2*time.Second, a.nudgeSetpoint)
			a.gridMu.Unlock()
		})
	}
	a.gridMu.Unlock()
	if err != nil {
		return a.gridView(mode, now), err
	}
	slog.Warn("Netz-Sollwert-Test armiert (Deye netzseitig, begrenzt + selbst zuruecknehmend)",
		"mode", t.Mode, "ttl_s", int(t.Deadline.Sub(now)/time.Second),
		"base_grid_kw", t.BaseGridKw, "base_deye_pv_kw", t.BaseDeyePvKw, "base_soc_pct", t.BaseSocPct)
	a.nudgeSetpoint()
	return a.gridView(mode, now), nil
}

// GridTestAbort beendet den Lauf sofort. Der Ueberschreiber faehrt danach noch
// die Rueckkehr (1109 ← 0, dann 1104 ← 1) - abbrechen heisst zuruecknehmen.
func (a *Agent) GridTestAbort() curtailcal.GridView {
	now := time.Now().UTC()
	a.gridMu.Lock()
	a.gridCal.Abort("Vom Betreiber abgebrochen.", now)
	if a.gridWatchdog != nil {
		a.gridWatchdog.Stop()
	}
	a.gridWatchdog = time.AfterFunc(curtailcal.GridReturnGrace+2*time.Second, a.nudgeSetpoint)
	a.gridMu.Unlock()
	a.nudgeSetpoint()
	return a.gridView(curtailcal.GridModeGrid, now)
}
