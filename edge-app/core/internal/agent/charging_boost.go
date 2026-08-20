package agent

import (
	"log/slog"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/chargingboost"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
)

// onChargingBoost applies ONE non-retained „Jetzt voll laden" from the portal
// (contract docs/contracts/mqtt-charging-boost.schema.json, OCPP-Lastmanagement
// Stufe 4). It is pure wiring: the form lives in internal/chargingboost, what
// the override MAY do lives in internal/lastmgmt, and it ends in the very same
// `OcppBoost` the `:8484` button calls — there is no second way to override.
//
// ⚠ REFUSALS ARE STUMM TOWARD THE BROKER AND LOUD IN THE LOG. This path has no
// answer channel of its own, and a device that replied to a wrongly addressed
// sender would confirm its own existence.
func (a *Agent) onChargingBoost(payload []byte) {
	req, err := chargingboost.Parse(payload)
	if err != nil {
		slog.Warn("charging boost rejected", "err", err)
		return
	}
	// Topic == Payload: the rule of every downlink here.
	a.entMu.Lock()
	id := a.entIdentity
	a.entMu.Unlock()
	if id.DeviceID == "" {
		slog.Warn("charging boost before a known cloud identity - ignored")
		return
	}
	if !req.MatchesIdentity(id.TenantID, id.SiteID, id.DeviceID) {
		slog.Warn("charging boost for a foreign identity ignored",
			"tenant", req.TenantID, "site", req.SiteID, "device", req.DeviceID)
		return
	}
	now := time.Now().UTC()
	if req.Expired(now) {
		// ⚠ The second half of the replay defence (the first is NON-retained):
		// the broker may redeliver a QoS1 message to a box that was away, and a
		// consent from three hours ago is not a consent for now. It is
		// DISCARDED, never applied - and the log names BOTH clocks, because two
		// clocks that drifted apart is the one cause the cloud cannot see.
		slog.Warn("charging boost ignored: " + req.ExpiredMessage(now))
		return
	}
	if a.ocpp == nil {
		slog.Info("charging boost received but OCPP is off on this box - nothing applied")
		return
	}
	res, err := a.OcppBoost(lastmgmt.BoostRequest{
		ChargePointID: req.ChargePointID, Connector: req.Connector,
		Minutes: req.Minutes, Cancel: req.Cancel,
	})
	if err != nil {
		slog.Warn("charging boost not applied", "charge_point", req.ChargePointID,
			"connector", req.Connector, "err", err)
		return
	}
	slog.Info("charging boost applied", "charge_point", req.ChargePointID,
		"connector", req.Connector, "active", res.Active, "actor", req.Actor)
}
