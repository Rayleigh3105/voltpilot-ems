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
	if cfg.GridLimitKw != nil || cfg.SurplusPolicy != nil || cfg.StoragePriority != nil {
		req := lastmgmt.SettingsRequest{
			GridLimitKw:     cfg.GridLimitKw,
			SurplusPolicy:   cfg.SurplusPolicy,
			StoragePriority: cfg.StoragePriority,
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
	if cfg.Priorities != nil {
		a.applyChargingPriorities(cfg.Priorities)
	}
}

// applyChargePoints ADMITS every station identifier the portal listed that this
// box does not know yet.
//
// ⚠ Es wird NIE einer entfernt und NIE einer überschrieben. Die Allowlist bleibt
// die Allowlist - eine unbekannte Kennung wird weiterhin abgewiesen und
// protokolliert, es entsteht kein Anlern-Fenster; es wandert nur ihr PFLEGE-Ort
// ins Portal. Ein Eintrag zu ENTFERNEN wirft eine Säule beim nächsten
// Verbindungsaufbau vom Broker - eine Entscheidung mit Folgen für eine laufende
// Anlage, und die bleibt bewusst eine ausdrückliche Handlung am Gerät. Ein
// BESTEHENDER Eintrag wird nicht angefasst, weil `label`/`priority` dort auf
// :8484 gepflegt sein können (dieselbe PATCH-Regel wie für jedes andere Feld).
func (a *Agent) applyChargePoints(wanted []chargingcfg.ChargePoint) {
	known := map[string]bool{}
	for _, c := range a.OcppChargers() {
		known[c.ID] = true
	}
	for _, cp := range wanted {
		if known[cp.ID] {
			continue
		}
		if _, err := a.OcppAddCharger(csms.AddRequest{
			ID:         cp.ID,
			Label:      cp.Label,
			Priority:   cp.Priority,
			RatedKw:    cp.RatedKw,
			Connectors: cp.Connectors,
		}); err != nil {
			slog.Warn("charging config: charge point not admitted",
				"charge_point", cp.ID, "err", err)
			continue
		}
		slog.Info("charging config: charge point admitted", "charge_point", cp.ID)
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
