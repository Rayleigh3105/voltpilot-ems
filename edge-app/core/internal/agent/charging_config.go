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
	known := map[string]string{}
	for _, c := range a.OcppChargers() {
		known[c.ID] = c.ConnectionOrHaus()
	}
	for _, cp := range wanted {
		if prev, ok := known[cp.ID]; ok {
			// Das Portal äußert sich nicht ("") ⇒ nichts tun; sagt es dasselbe
			// wie bisher ⇒ ebenfalls nichts (kein Schreibvorgang, kein Log je
			// Zustellung des retained Dokuments).
			if cp.Connection == "" || cp.Connection == prev {
				continue
			}
			conn := cp.Connection
			if _, err := a.OcppUpdateCharger(cp.ID, csms.UpdateRequest{
				Connection: &conn,
			}); err != nil {
				slog.Warn("charging config: charge point connection not applied",
					"charge_point", cp.ID, "connection", conn, "err", err)
				continue
			}
			slog.Info("charging config: charge point connection applied",
				"charge_point", cp.ID, "connection", conn, "was", prev)
			continue
		}
		if _, err := a.OcppAddCharger(csms.AddRequest{
			ID:         cp.ID,
			Label:      cp.Label,
			Priority:   cp.Priority,
			RatedKw:    cp.RatedKw,
			Connectors: cp.Connectors,
			Connection: cp.Connection,
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
