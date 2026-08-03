package agent

// OTA Stufe 3 „Autonom" - die KERN-Haelfte.
//
// Der Kern tauscht nichts. Er tut genau vier Dinge, und jedes davon ist etwas,
// das der Sidecar strukturell NICHT tun kann:
//
//  1. **Er sagt, wie es der Anlage geht** (`core-signal.json`): steuert sie
//     gerade, welche Wechselrichter-Familie, wird gerade ein von neutral
//     abweichender Sollwert ausgefuehrt. Ohne das wuerde der Sidecar im
//     Blindflug tauschen.
//  2. **Er meldet `applying` DURABEL** (QoS1, mit Ack) als letzte Handlung,
//     bevor irgendetwas gestoppt wird. Nur dadurch ist „im Update verstummt"
//     ein eigener Zustand statt ununterscheidbar von „die Box ist weg". Der
//     15-s-Herzschlag kann das nicht tragen: der Prozess verschwindet gerade.
//  3. **Er stellt die Anlage auf Bitte bewusst neutral** (der Eil-Pfad). Der
//     Sidecar hat keinen Zugriff auf den Steuerpfad - und soll ihn nicht haben.
//  4. **Er bezeugt, was laeuft** (der Selbsttest + `current.json`). Der Sidecar
//     hat Container getauscht; ob danach der richtige Stand LAEUFT und ob der
//     Steuerpfad des NEUEN Standes noch funktioniert, kann nur der Kern sagen.
//
// Vorgabe ist AUS: ohne Sidecar und ohne Schalter passiert hier nichts ausser
// dem Schreiben einer kleinen Zustandsdatei.

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const (
	// otaSignalInterval ist der Takt, in dem der Kern seinen Zustand
	// hinterlegt. Er ist deutlich kuerzer als der Herzschlag: der Sidecar
	// wartet darauf, und eine Sekunde zu lange gewartet ist eine Sekunde
	// laenger im Zustand „gerade wird getauscht".
	otaSignalInterval = 2 * time.Second
	// otaNeutralSettle ist die Zeit, die die Anlage nachweislich neutral
	// gestanden haben muss, bevor der Eil-Pfad weitergeht.
	otaNeutralSettle = 20 * time.Second
	// otaNeutralRequestTTL ist die Zeit, nach der eine unbeantwortete Bitte um
	// Neutralstellung verfaellt. Ein verschwundener Sidecar darf die Anlage
	// nicht dauerhaft parken.
	otaNeutralRequestTTL = 60 * time.Second
	// otaNeutralMaxHold deckelt die Neutralstellung hart. Auch ein Sidecar,
	// der alle zwei Sekunden weiter bittet, bekommt sie nicht laenger.
	otaNeutralMaxHold = 10 * time.Minute
	// otaSelfTestSettle ist die Zeit, die dem NEUEN Stand gegeben wird, bevor
	// er ueber sich urteilt (MQTT-Verbindung, erste Messwerte).
	otaSelfTestSettle = 25 * time.Second
	// otaSetpointDeadbandKw ist die Grenze, ab der ein Sollwert als „von
	// neutral abweichend" gilt (dieselbe Groessenordnung wie ueberall sonst).
	otaSetpointDeadbandKw = 0.05
)

// otaSignalLoop schreibt den Zustand des Kerns und beantwortet die Bitten des
// Sidecars.
func (a *Agent) otaSignalLoop(ctx context.Context) {
	defer a.done.Done()
	t := time.NewTicker(otaSignalInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			a.otaSignalOnce()
		}
	}
}

func (a *Agent) otaSignalOnce() {
	now := time.Now()
	snap := a.State.Get()
	up, _ := otaapply.ReadJSON[otaapply.UpdaterState](a.Cfg.DataDir, otaapply.FileUpdaterState)

	sig := otaapply.CoreSignal{
		UpdatedAt:      now.UTC().Format(otaapply.TimeFormat),
		Version:        Version,
		Healthy:        true,
		CloudConnected: snap.CloudConnected,
		ControlActive:  a.otaControlActive(snap),
		InverterFamily: a.currentFamily(),
		Dispatching:    a.otaDispatching(snap),
		SetpointKw:     snap.SetpointKw,
	}

	// --- Der durable `applying`-Bericht. ---------------------------------
	if up != nil && up.NeedApplyingAck && up.AckToken != "" {
		sig.AckToken = up.AckToken
		a.otaMu.Lock()
		already := a.otaAckedToken == up.AckToken
		failed := a.otaAckFailedToken == up.AckToken
		a.otaMu.Unlock()
		switch {
		case already:
			sig.ApplyingAckedAt = a.otaAckedAt
		case failed:
			sig.AckFailed = true
		default:
			if err := a.otaPublishApplying(up); err != nil {
				// EHRLICH statt hoffnungsvoll: der Sidecar soll nicht auf einen
				// Bericht warten, der nicht kommen kann. Er wartet dann noch
				// seine Frist und tauscht danach - eine Box ohne Broker muss
				// aktualisierbar bleiben.
				slog.Warn("OTA: durabler applying-Bericht fehlgeschlagen", "err", err)
				a.otaMu.Lock()
				a.otaAckFailedToken = up.AckToken
				a.otaMu.Unlock()
				sig.AckFailed = true
			} else {
				a.otaMu.Lock()
				a.otaAckedToken = up.AckToken
				a.otaAckedAt = now.UTC().Format(otaapply.TimeFormat)
				a.otaMu.Unlock()
				sig.ApplyingAckedAt = a.otaAckedAt
			}
		}
	}

	// --- Die Bitte um Neutralstellung (Eil-Pfad). -------------------------
	a.otaMu.Lock()
	if up != nil && up.NeedNeutral {
		if a.otaNeutralReq.IsZero() {
			slog.Warn("OTA: Eil-Aktualisierung - die Anlage wird bewusst neutral gestellt")
		}
		a.otaNeutralReq = now
	}
	held := a.otaNeutralSince
	a.otaMu.Unlock()
	if !held.IsZero() && now.Sub(held) >= otaNeutralSettle {
		sig.NeutralHeldSince = held.UTC().Format(otaapply.TimeFormat)
	}

	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileCoreSignal, sig); err != nil {
		slog.Debug("OTA: Zustand konnte nicht hinterlegt werden", "err", err)
	}
}

// otaPublishApplying setzt den durablen Bericht ab.
func (a *Agent) otaPublishApplying(up *otaapply.UpdaterState) error {
	a.mu.Lock()
	link := a.link
	a.mu.Unlock()
	if link == nil || !link.Connected() {
		return fmt.Errorf("keine Cloud-Verbindung")
	}
	sum := cloud.UpdateSummary{
		Backend: cloud.UpdateBackendCompose,
		Current: Version,
		State:   cloud.UpdateStateApplying,
		Reason: "Die Aktualisierung wird jetzt angewandt - das Geraet stoppt gleich " +
			"seine Dienste.",
		Target: up.Release,
	}
	if up.ReleaseSeq > 0 {
		seq := up.ReleaseSeq
		sum.TargetSeq = &seq
	}
	if up.LastKnownGood != "" {
		sum.LastKnownGood = up.LastKnownGood
	}
	return link.PublishUpdateState(sum)
}

// otaControlActive sagt, ob dieses Geraet gerade wirklich STEUERT.
//
// Das ist die Bedingung, unter der die Inverter-Neutral-Zeit T ueberhaupt
// tragend ist: eine Anlage ohne Steuerpfad haelt kein Kommando, das T
// ueberleben koennte. Beide Haelften der Freigabe muessen zutreffen - der
// globale Not-Aus UND die Freigabe fuer dieses Modell.
func (a *Agent) otaControlActive(snap state.Snapshot) bool {
	return snap.ControlEnabled && snap.ControlCertified && a.currentFamily() != ""
}

// otaDispatching sagt, ob GERADE ein von neutral abweichender Sollwert
// ausgefuehrt wird - der „nicht mitten im Schreiben"-Interlock.
func (a *Agent) otaDispatching(snap state.Snapshot) bool {
	if !a.otaControlActive(snap) {
		return false
	}
	switch snap.Mode {
	case state.ModeSchedule, state.ModeSelfConsume, state.ModeDesired, state.ModeCalibration:
		return math.Abs(snap.SetpointKw) > otaSetpointDeadbandKw
	default:
		return false
	}
}

// otaNeutralOverride publiziert die Neutralstellung des Eil-Pfades statt des
// Plan-/Arbiter-Wertes und meldet true, wenn er den Takt uebernommen hat.
//
// Er sitzt in `applySetpoint` NACH der Kalibrierung: ein laufender
// First-Light-Test gewinnt (und macht das Geraet ohnehin „dispatching", also
// verschiebt der gewoehnliche Interlock den Tausch dann von selbst).
func (a *Agent) otaNeutralOverride(now time.Time) bool {
	a.otaMu.Lock()
	req := a.otaNeutralReq
	since := a.otaNeutralSince
	switch {
	case req.IsZero() || now.Sub(req) > otaNeutralRequestTTL:
		// Keine (frische) Bitte: Neutralstellung beenden.
		if !since.IsZero() {
			slog.Info("OTA: Neutralstellung beendet")
		}
		a.otaNeutralReq, a.otaNeutralSince = time.Time{}, time.Time{}
		a.otaMu.Unlock()
		return false
	case !since.IsZero() && now.Sub(since) > otaNeutralMaxHold:
		// Harter Deckel: ein haengender Sidecar parkt die Anlage nicht ewig.
		slog.Error("OTA: Neutralstellung nach " + otaNeutralMaxHold.String() +
			" hart beendet - der Updater hat nicht weitergemacht")
		a.otaNeutralReq, a.otaNeutralSince = time.Time{}, time.Time{}
		a.otaMu.Unlock()
		return false
	case since.IsZero():
		a.otaNeutralSince = now
	}
	a.otaMu.Unlock()

	// Dieselbe Form wie das Rueckgabe-Fenster der Kalibrierung: neutral UND
	// control_enabled=false, damit der Executor die Steuerung wirklich
	// zurueckgibt statt eine 0 zu schreiben.
	msg := map[string]any{
		"battery_setpoint_kw": 0.0,
		"source":              "ota_neutral",
		"ts":                  now.Format(time.RFC3339Nano),
		"control_enabled":     false,
		"device_certified":    a.controlCertified(a.currentFamily()),
		"grid_charge_allowed": false,
		"soc_min_pct":         a.Cfg.SocMinPct,
		"soc_max_pct":         a.Cfg.SocMaxPct,
	}
	raw, _ := json.Marshal(msg)
	if err := a.Bus.Publish(localbus.TopicSetpoint, raw, true); err != nil {
		slog.Error("OTA: Neutralstellung konnte nicht veroeffentlicht werden", "err", err)
	}
	a.State.Update(func(s *state.Snapshot) {
		s.Mode = state.ModeOtaNeutral
		s.SetpointKw = 0
	})
	return true
}

// ---------------------------------------------------------------------------
// Der Selbsttest des NEUEN Standes
// ---------------------------------------------------------------------------

// otaSelfTestOnBoot laeuft EINMAL beim Start, wenn eine Brotkrume vorliegt.
//
// **Das ist die Selbst-Sperre des Kerns** (Vorentwurf §3, Befund B5): auch
// wenn der Docker-Daemon den Container aus eigener Kraft neu startet, landet
// der Kern hier und nicht in einem stillschweigend gesegneten Zustand. Wer
// eine Brotkrume vorfindet, hat sich zu beweisen.
func (a *Agent) otaSelfTestOnBoot(ctx context.Context) {
	defer a.done.Done()
	p, err := otaapply.ReadJSON[otaapply.PendingConfirm](a.Cfg.DataDir, otaapply.FilePendingConfirm)
	if err != nil || p == nil {
		return
	}
	if p.Phase != otaapply.PhaseSelfTest {
		// Der Tausch laeuft noch (der Sidecar ist an der Reihe). Der Selbsttest
		// gehoert an das ENDE - vorher wuerde er ueber einen halb getauschten
		// Stand urteilen.
		return
	}
	slog.Info("OTA: neuer Stand gefunden - Selbsttest laeuft", "release", p.Release)
	select {
	case <-ctx.Done():
		return
	case <-time.After(otaSelfTestSettle):
	}
	res := a.otaRunSelfTest(p, time.Now())
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileSelfTest, res); err != nil {
		slog.Error("OTA: Selbsttest-Urteil konnte nicht abgelegt werden", "err", err)
		return
	}
	if !res.Passed {
		slog.Error("OTA: Selbsttest NICHT bestanden - der Stand wird zurueckgenommen",
			"grund", res.Reason)
		return
	}
	// Der Boden wird NUR hier angehoben, und nur gegen die eigene
	// Build-Stempelung: aufgezeichnet wird ausschliesslich, was nachweislich
	// laeuft.
	if _, err := a.OtaRecordApplied(p.Release, p.ReleaseSeq); err != nil {
		slog.Warn("OTA: der angewandte Stand konnte nicht aufgezeichnet werden", "err", err)
	} else if p.StateSchema > 0 {
		a.otaRecordStateSchema(p.StateSchema)
	}
	slog.Info("OTA: Selbsttest bestanden", "release", p.Release)
}

// otaRunSelfTest ist die eigentliche Pruefung - „nie vakuum" (Befund B2).
//
// Der entscheidende Teil ist der SYNTHETISCHE Steuer-Trockenlauf: er laeuft
// IMMER, auch nachts und im Leerlauf, und er prueft genau das, was ein reiner
// „/health antwortet"-Test nicht prueft - dass die Guard-Kette dieses NEUEN
// Binaers noch dieselben Entscheidungen trifft. Ein Stand, der steuerungs-
// kaputt, aber im Leerlauf gesund ist, kann sich damit nicht selbst segnen.
func (a *Agent) otaRunSelfTest(p *otaapply.PendingConfirm, now time.Time) otaapply.SelfTest {
	res := otaapply.SelfTest{
		Token:     p.Token,
		Release:   p.Release,
		StartedAt: now.UTC().Format(otaapply.TimeFormat),
	}
	add := func(name string, ok bool, detail string) {
		res.Checks = append(res.Checks, otaapply.SelfTestCheck{Name: name, OK: ok, Detail: detail})
	}

	// 1. Laeuft wirklich das Release, das getauscht werden sollte? DIE Frage.
	running := otaverify.ReleaseIsRunning(p.Release, Version)
	add("version", running, "gestempelt: "+Version)

	// 2. Antwortet die lokale Weboberflaeche? (Der Endpunkt, den auch ein
	//    beaufsichtigter Test und der Installer abfragen.)
	webOK, webDetail := a.otaProbeHealth()
	add("web", webOK, webDetail)

	// 3. Cloud-Verbindung. Sie ist ein BEFUND, aber kein Ausschluss: eine Box
	//    hinter einer gerade gestoerten Leitung ist nicht kaputt, und sie
	//    wegen des Netzes zurueckzurollen waere ein Rueckschritt ohne Ursache.
	a.mu.Lock()
	link := a.link
	a.mu.Unlock()
	cloudOK := link != nil && link.Connected()
	add("cloud", cloudOK, "informativ - eine gestoerte Leitung nimmt keinen Stand zurueck")

	// 4. Der synthetische Steuer-Trockenlauf.
	ctrlOK, ctrlDetail := a.otaSyntheticControlDryRun()
	add("steuerpfad", ctrlOK, ctrlDetail)

	// 5. War vor dem Tausch gesteuert worden, muss der Steuerpfad auch DANACH
	//    noch stehen - Freigabe und Geraetewahl duerfen ein Update nicht
	//    ueberleben, indem sie verschwinden.
	if p.ControlActiveBefore {
		fam := a.currentFamily()
		stillCertified := fam != "" && a.controlCertified(fam)
		add("freigabe", stillCertified, "Familie: "+orNone(fam))
		if !stillCertified {
			res.Reason = "Die Steuerungs-Freigabe bzw. die Geraetewahl ist nach dem Tausch " +
				"nicht mehr vorhanden."
		}
	}

	res.Passed = running && webOK && ctrlOK
	if p.ControlActiveBefore && res.Reason != "" {
		res.Passed = false
	}
	if !res.Passed && res.Reason == "" {
		switch {
		case !running:
			res.Reason = "Es laeuft nicht das Release, das angewandt werden sollte (gestempelt: " +
				Version + ")."
		case !webOK:
			res.Reason = "Die lokale Weboberflaeche antwortet nicht: " + webDetail
		default:
			res.Reason = "Der Steuerpfad hat den Trockenlauf nicht bestanden: " + ctrlDetail
		}
	}
	res.FinishedAt = time.Now().UTC().Format(otaapply.TimeFormat)
	return res
}

// otaSyntheticControlDryRun rechnet einen Sollwert durch die ECHTE Guard-Kette
// und prueft ihre tragenden Zusagen - OHNE irgendetwas zu schreiben.
//
// Er benutzt eine synthetische Messung, wenn gerade keine echte vorliegt: der
// Sinn dieses Tests ist, dass er um drei Uhr nachts bei stillstehender Anlage
// genauso aussagekraeftig ist wie mittags.
func (a *Agent) otaSyntheticControlDryRun() (bool, string) {
	limits := guards.Limits{
		MaxChargeKw:    a.Cfg.MaxChargeKw,
		MaxDischargeKw: a.Cfg.MaxDischargeKw,
		SocMinPct:      a.Cfg.SocMinPct,
		SocMaxPct:      a.Cfg.SocMaxPct,
	}
	if limits.MaxChargeKw <= 0 || limits.MaxDischargeKw <= 0 ||
		limits.SocMinPct >= limits.SocMaxPct {
		return false, fmt.Sprintf("die Guard-Grenzen sind unsinnig (laden %.1f, entladen %.1f, "+
			"SoC %.0f..%.0f)", limits.MaxChargeKw, limits.MaxDischargeKw,
			limits.SocMinPct, limits.SocMaxPct)
	}

	// FOOTGUN, hier absichtlich benannt: das Nullwert-Feld `GridLimitKw` heisst
	// „§14a-Grenze 0 kW", NICHT „unbekannt" - eine mit `{}` gebaute Messung
	// laesst den Envelope-Guard gegen eine Null-Grenze rechnen. Unbekannt ist
	// ausschliesslich guards.Unknown() (NaN).
	reading := func(pv, load, soc, gridLimit float64) guards.Reading {
		return guards.Reading{PvKw: pv, LoadKw: load, SocPct: soc, GridLimitKw: gridLimit}
	}
	unknown := guards.Unknown()
	mid := reading(3, 2, (limits.SocMinPct+limits.SocMaxPct)/2, unknown)

	// a) Ein Ladewunsch weit ueber der Nennleistung wird auf das Band gekappt.
	charge := guards.Clamp(limits.MaxChargeKw*10, limits, mid)
	if charge > limits.MaxChargeKw+1e-6 || charge < 0 {
		return false, fmt.Sprintf("ein Ladewunsch wurde nicht auf das Nennband gekappt (%.3f kW)", charge)
	}
	// b) Ein Entladewunsch ebenso.
	discharge := guards.Clamp(-limits.MaxDischargeKw*10, limits, mid)
	if discharge < -limits.MaxDischargeKw-1e-6 || discharge > 0 {
		return false, fmt.Sprintf("ein Entladewunsch wurde nicht auf das Nennband gekappt (%.3f kW)", discharge)
	}
	// c) An der SoC-Decke darf nicht geladen werden.
	full := reading(3, 2, limits.SocMaxPct, unknown)
	if v := guards.Clamp(limits.MaxChargeKw, limits, full); v > 1e-9 {
		return false, fmt.Sprintf("an der SoC-Decke wurde noch geladen (%.3f kW)", v)
	}
	// d) Am SoC-Boden darf nicht entladen werden.
	empty := reading(0, 2, limits.SocMinPct, unknown)
	if v := guards.Clamp(-limits.MaxDischargeKw, limits, empty); v < -1e-9 {
		return false, fmt.Sprintf("am SoC-Boden wurde noch entladen (%.3f kW)", v)
	}
	// e) Die EEG-Solar-Klemme: ohne bekannte PV darf gar nicht geladen werden.
	eeg := guards.Limits{MaxChargeKw: limits.MaxChargeKw, MaxDischargeKw: limits.MaxDischargeKw,
		SocMinPct: limits.SocMinPct, SocMaxPct: limits.SocMaxPct, SolarOnlyCharge: true}
	blind := reading(unknown, 2, mid.SocPct, unknown)
	if v := guards.Clamp(limits.MaxChargeKw, eeg, blind); v > 1e-9 {
		return false, fmt.Sprintf("die Solar-Klemme hat bei unbekannter PV noch geladen (%.3f kW)", v)
	}
	// f) Die beobachtete §14a-Huelle deckelt den vorhergesagten Netzbezug.
	//    Bei Last 2 kW, PV 0 kW und einer 3-kW-Grenze darf eine 30-kW-Ladung
	//    hoechstens auf 1 kW Netzbezug hinauslaufen, also auf 1 kW Ladung.
	envelope := reading(0, 2, mid.SocPct, 3)
	if v := guards.Clamp(limits.MaxChargeKw, limits, envelope); v > 1.0+1e-6 {
		return false, fmt.Sprintf("die §14a-Huelle wurde ueberschritten (%.3f kW statt hoechstens 1 kW)", v)
	}

	return true, "Nennband, SoC-Band, Solar-Klemme und §14a-Huelle greifen wie erwartet"
}

// otaProbeHealth fragt die lokale Weboberflaeche ueber die Schleife ab.
func (a *Agent) otaProbeHealth() (bool, string) {
	addr := a.Cfg.HTTPAddr
	if addr == "" {
		return false, "kein HTTP-Adressbereich konfiguriert"
	}
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		port = "8484"
	}
	c := &http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		return false, err.Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, "HTTP " + resp.Status
	}
	return true, "HTTP 200"
}

// otaRecordStateSchema haelt die /data-Zustandsversion des angewandten
// Releases fest - der Eingang des state_schema-Gates beim NAECHSTEN Update.
func (a *Agent) otaRecordStateSchema(schema int) {
	cur := otaapply.ReadCurrent(a.Cfg.DataDir)
	if cur == nil {
		return
	}
	cur.StateSchema = schema
	if err := otaapply.WriteJSON(a.Cfg.DataDir, otaapply.FileCurrent, cur); err != nil {
		slog.Warn("OTA: state_schema konnte nicht aufgezeichnet werden", "err", err)
	}
}

// otaUpdaterOverlay faltet den Zustand des Sidecars in den Herzschlag.
//
// **Byte-gleich ohne Sidecar:** liegt keine Zustandsdatei vor oder meldet sie
// `idle`, bleibt der Block genau der der Stufe 2. Der Sidecar gewinnt nur
// dort, wo er wirklich etwas tut - dann ist SEIN Zustand die Wahrheit ueber
// die Anwendung, waehrend das Urteil des Kerns die Wahrheit ueber die PRUEFUNG
// bleibt (target_verdict).
func (a *Agent) otaUpdaterOverlay(sum *cloud.UpdateSummary) {
	up, err := otaapply.ReadJSON[otaapply.UpdaterState](a.Cfg.DataDir, otaapply.FileUpdaterState)
	if err != nil || up == nil {
		return
	}
	if up.LastKnownGood != "" {
		sum.LastKnownGood = up.LastKnownGood
	}
	if up.State == "" || up.State == otaapply.StateIdle {
		return
	}
	// Ein Zustand, der aelter ist als ein paar Takte, beschreibt nichts
	// Laufendes mehr - ein gestoppter Sidecar darf den Herzschlag nicht auf
	// „wendet an" einfrieren.
	if t, perr := time.Parse(otaapply.TimeFormat, up.UpdatedAt); perr != nil ||
		time.Since(t) > 2*time.Minute {
		return
	}
	sum.State = up.State
	if up.Reason != "" {
		sum.Reason = up.Reason
	}
	if up.Release != "" {
		sum.Target = up.Release
	}
	if up.ReleaseSeq > 0 {
		seq := up.ReleaseSeq
		sum.TargetSeq = &seq
	}
}

func orNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "keine"
	}
	return s
}
