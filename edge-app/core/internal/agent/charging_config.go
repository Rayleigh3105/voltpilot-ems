package agent

import (
	"errors"
	"log/slog"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/chargingcfg"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// onChargingConfig applies ONE retained load-management document from the
// portal (contract docs/contracts/mqtt-charging-config.schema.json,
// Lastmanagement Stufe 3). It is pure wiring: every rule lives in
// internal/chargingcfg (parse + plausibility) and internal/lastmgmt (what a
// setting MEANS), and nothing here decides anything about power.
//
// ⚠ It writes SETTINGS, never a limit. The allocation is computed on this box
// as it was before - the portal only maintains the two numbers the customer
// owns (their connection limit, and which stations get priority). The concept's
// E1 stands: the connection limit is a PHYSICAL limit, so its watchdog must not
// hang off the WAN.
//
// ⚠ PATCH semantics: an ABSENT field keeps what the box has. The safety margin,
// the minimum power and the highest known building load remain :8484 settings,
// and a document that silently reset them would be a data loss nobody asked for.
func (a *Agent) onChargingConfig(payload []byte) {
	cfg, err := chargingcfg.Parse(payload)
	if errors.Is(err, chargingcfg.ErrEmpty) {
		// Die Rücknahme: das Portal hat sein Dokument geleert (Unclaim). Die
		// zuletzt übernommenen Werte BLEIBEN stehen - sie zurückzusetzen wäre
		// eine Änderung an einer laufenden Anlage, die niemand angeordnet hat,
		// und die Box wüsste auch nicht, worauf. Von hier an gilt wieder
		// allein, was auf :8484 gepflegt wird.
		slog.Info("charging config withdrawn - the maintained values stay in force")
		return
	}
	if err != nil {
		slog.Warn("charging config rejected", "err", err)
		return
	}
	// Topic == Payload: die Regel jedes Downlinks hier. Ein fremd adressiertes
	// Dokument wird STUMM verworfen (eine Antwort bestätigte dem Absender die
	// Existenz dieses Geräts) - laut nur im Protokoll.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID == "" {
		// Vor der Beanspruchung gibt es keine Konfiguration, die uns meinen
		// könnte - das Dokument bleibt retained liegen.
		slog.Warn("charging config before a known cloud identity - ignored")
		return
	}
	if !cfg.MatchesIdentity(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("charging config for a foreign identity ignored",
			"tenant", cfg.TenantID, "site", cfg.SiteID, "device", cfg.DeviceID)
		return
	}
	if a.ocpp == nil {
		// Eine Box ohne OCPP-Flag hat kein Lastmanagement, das eine
		// Anschlussgrenze brauchen könnte. Das ist kein Fehler: das Dokument
		// bleibt retained liegen und wird angewandt, sobald der Server läuft.
		slog.Info("charging config received but OCPP is off on this box - nothing applied")
		return
	}
	// ⚠ ONE Apply for every field the document carries: Settings.Apply is
	// PATCH, so a second call would be pointless churn - and splitting them
	// could leave the box half-configured if one refused.
	// ⚠ Der RAHMEN (E10) reist im SELBEN Apply: `SettingsRequest` ist längst
	// PATCH, also fällt ein nicht genanntes Rahmen-Feld auf den Wert der Box
	// zurück, und die Plausibilitäts-Regeln bleiben die EINE Stelle
	// (Settings.Apply), die auch die :8484-Oberfläche fährt.
	frame := cfg.Frame
	if cfg.GridLimitKw != nil || cfg.SurplusPolicy != nil || cfg.StoragePriority != nil ||
		frame != nil {
		req := lastmgmt.SettingsRequest{
			GridLimitKw:     cfg.GridLimitKw,
			SurplusPolicy:   cfg.SurplusPolicy,
			StoragePriority: cfg.StoragePriority,
		}
		if frame != nil {
			req.HouseReserveKw = frame.HouseReserveKw
			req.MarginPct = frame.MarginPct
			req.MinPowerKw = frame.MinPowerKw
			req.RotationMinutes = frame.RotationMinutes
			req.MaxHouseLoadKw = frame.MaxHouseLoadKw
			req.StaticBudget = frame.StaticBudget
		}
		if _, err := a.OcppSaveSettings(req); err != nil {
			slog.Warn("charging config: settings not applied", "err", err)
		} else {
			slog.Info("charging config applied",
				"grid_limit_kw", cfg.GridLimitKw,
				"surplus_policy", cfg.SurplusPolicy,
				"storage_priority", cfg.StoragePriority)
		}
	}
	// ⚠ Die Allowlist ZUERST: eine gerade eingetragene Säule soll den Vorrang
	// desselben Dokuments schon abbekommen, sonst zöge er erst beim nächsten
	// Speichern.
	if len(cfg.ChargePoints) > 0 {
		a.applyChargePoints(cfg.ChargePoints)
	}
	// ⚠ Und die LÖSCHUNGEN danach: der Parser hält beide Listen schon
	// überschneidungsfrei, aber die Reihenfolge macht die Regel „die Löschung
	// gewinnt" auch dann wahr, wenn jemand später am Parser dreht.
	if len(cfg.RemovedChargePoints) > 0 {
		a.applyChargePointRemovals(cfg.RemovedChargePoints)
	}
	if cfg.Priorities != nil {
		a.applyChargingPriorities(cfg.Priorities)
	}
}

// applyChargePoints ADMITS every station identifier the portal listed that this
// box does not know yet.
//
// ⚠ DIESE Liste entfernt NIE einen und überschreibt NIE einen. Die Allowlist
// bleibt die Allowlist - eine unbekannte Kennung wird weiterhin abgewiesen und
// protokolliert, es entsteht kein Anlern-Fenster; es wandert nur ihr PFLEGE-Ort
// ins Portal. Eine Kennung zu ENTFERNEN ist eine eigene, AUSDRÜCKLICHE Aussage
// des Dokuments (`removed_charge_point_ids`, siehe applyChargePointRemovals) -
// sie hier hineinzulesen hieße, ein Weglassen als Löschung zu deuten. Ein
// BESTEHENDER Eintrag wird nicht angefasst, weil `label`/`priority` dort auf
// :8484 gepflegt sein können (dieselbe PATCH-Regel wie für jedes andere Feld).
//
// ⚠ GENAU EINE AUSNAHME: `connection` (Cockpit Phase 1 / C1). Der Grund der
// Nie-überschreiben-Regel ist, was ein Betreiber AN DER BOX gepflegt haben
// kann - und für den Anschluss gibt es dort gar keine Oberfläche, also nichts
// zu schützen. Behielte sie ihn ein, erreichte ein Kunde, der den Haken später
// setzt, die Box NIE, und ihr Budget-Gesetz rechnete für immer mit einer
// Ladeleistung, die auf einem anderen Zähler liegt.
func (a *Agent) applyChargePoints(wanted []chargingcfg.ChargePoint) {
	type stationState struct {
		connection string
		source     string
		minKw      float64
	}
	known := map[string]stationState{}
	for _, c := range a.OcppChargers() {
		known[c.ID] = stationState{c.ConnectionOrHaus(), c.Source, c.MinKw}
	}
	for _, cp := range wanted {
		if prev, ok := known[cp.ID]; ok {
			// Das Portal äußert sich nicht ("") ⇒ nichts tun; sagt es dasselbe
			// wie bisher ⇒ ebenfalls nichts (kein Schreibvorgang, kein Log je
			// Zustellung des retained Dokuments).
			var req csms.UpdateRequest
			touched := false
			if cp.Connection != "" && cp.Connection != prev.connection {
				conn := cp.Connection
				req.Connection = &conn
				touched = true
			}
			// ⚠ Die QUELLE folgt derselben Ausnahme wie der Anschluss (P5):
			// sie hat auf der Box keine Oberfläche, es gibt dort also nichts zu
			// schützen - und ein Kunde, der die Steuerart EINER Säule später
			// ändert, erreichte sie sonst nie. Die Mindestleistung gehört zu
			// derselben Wahl („Sonne zuerst … 4,2 kW halten") und reist mit ihr.
			if cp.Source != "" && cp.Source != prev.source {
				src := cp.Source
				req.Source = &src
				touched = true
			}
			if cp.MinKw > 0 && cp.MinKw != prev.minKw {
				min := cp.MinKw
				req.MinKw = &min
				touched = true
			}
			if !touched {
				continue
			}
			if _, err := a.OcppUpdateCharger(cp.ID, req); err != nil {
				slog.Warn("charging config: charge point not updated",
					"charge_point", cp.ID, "connection", cp.Connection,
					"source", cp.Source, "min_kw", cp.MinKw, "err", err)
				continue
			}
			slog.Info("charging config: charge point updated",
				"charge_point", cp.ID, "connection", cp.Connection,
				"source", cp.Source, "min_kw", cp.MinKw)
			continue
		}
		if _, err := a.OcppAddCharger(csms.AddRequest{
			ID:         cp.ID,
			Label:      cp.Label,
			Priority:   cp.Priority,
			RatedKw:    cp.RatedKw,
			MinKw:      cp.MinKw,
			Connectors: cp.Connectors,
			Connection: cp.Connection,
			Source:     cp.Source,
		}); err != nil {
			slog.Warn("charging config: charge point not admitted",
				"charge_point", cp.ID, "err", err)
			continue
		}
		slog.Info("charging config: charge point admitted",
			"charge_point", cp.ID, "connection", cp.Connection)
	}
}

// applyChargePointRemovals nimmt jede vom Portal genannte Kennung aus der
// Freigabeliste (Captain-Order 24.08.2026: „Ebenso will ich die möglichkeit
// haben eingebene kennungen zu löschen").
//
// ⚠ Die Folge am Gerät steht in csms.Remove: die Säule wird getrennt und ein
// Wiederverbinden abgewiesen. Ihr zuletzt hinterlegtes Sicherheitsprofil behält
// sie - es liegt IN der Säule -, ein laufender Ladevorgang endet dadurch also
// nicht, er fällt auf dieses Profil zurück. Genau so sagt es auch der
// :8484-Rückfrage-Dialog (VPOcpp.removalConsequences); zwei Formulierungen
// derselben Folge wären zwei Wahrheiten.
//
// ⚠ Eine Kennung, die diese Box nicht (mehr) kennt, ist ein GERÄUSCHLOSER
// No-op: die Grabstein-Liste reist in jedem folgenden Dokument mit, also ist
// „schon entfernt" der Normalfall und kein Fehler.
func (a *Agent) applyChargePointRemovals(ids []string) {
	known := map[string]bool{}
	for _, c := range a.OcppChargers() {
		known[c.ID] = true
	}
	for _, id := range ids {
		if !known[id] {
			continue
		}
		if err := a.OcppRemoveCharger(id); err != nil {
			slog.Warn("charging config: charge point not removed",
				"charge_point", id, "err", err)
			continue
		}
		slog.Info("charging config: charge point removed", "charge_point", id)
	}
}

// applyChargingPriorities makes the portal's priority choice the box's: every
// listed station gets Vorrang, every other REGISTERED one loses it.
//
// ⚠ The list is the WHOLE statement, so removing an id is as meaningful as
// adding one - a merge would make "no station has priority any more"
// unexpressible. An id the box does not know is IGNORED (the portal validates
// against what was reported; a station removed in between is not an error).
func (a *Agent) applyChargingPriorities(wanted []string) {
	want := map[string]bool{}
	for _, id := range wanted {
		want[id] = true
	}
	for _, c := range a.OcppChargers() {
		desired := want[c.ID]
		if c.Priority == desired {
			continue
		}
		p := desired
		if _, err := a.OcppUpdateCharger(c.ID, csms.UpdateRequest{Priority: &p}); err != nil {
			slog.Warn("charging config: priority not applied", "charge_point", c.ID, "err", err)
			continue
		}
		slog.Info("charging config: priority updated", "charge_point", c.ID, "priority", desired)
	}
}
