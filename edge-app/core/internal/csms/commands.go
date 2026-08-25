package csms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/lorenzodonini/ocpp-go/ocpp"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/firmware"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/localauth"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/remotetrigger"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/reservation"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/smartcharging"
)

// CloudCommand is the non-retained Cloud -> Edge OCPP contract. Request is
// typed by action at this boundary; it is never interpreted by the API as
// free-form vendor JSON except for schema-registered DataTransfer.
type CloudCommand struct {
	SchemaVersion string          `json:"schema_version"`
	Type          string          `json:"type"`
	TenantID      string          `json:"tenant_id"`
	SiteID        string          `json:"site_id"`
	DeviceID      string          `json:"device_id"`
	ChargePointID string          `json:"charge_point_id"`
	ActionID      string          `json:"action_id"`
	CorrelationID string          `json:"correlation_id"`
	Action        string          `json:"action"`
	Request       json.RawMessage `json:"request"`
}

func (s *Server) ExecuteCloudCommand(ctx context.Context, raw []byte) error {
	var cmd CloudCommand
	if err := json.Unmarshal(raw, &cmd); err != nil || cmd.Type != "ocpp_command" || cmd.SchemaVersion != "1.0" {
		return errors.New("ungültiger OCPP-Cloud-Befehl")
	}
	if cmd.ChargePointID == "" || cmd.Action == "" || cmd.CorrelationID == "" {
		return errors.New("unvollständiger OCPP-Cloud-Befehl")
	}
	s.mu.Lock()
	t := s.transport
	c, ok := s.chargers[cmd.ChargePointID]
	connected := ok && c.Connected
	s.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if !connected || t == nil {
		return errors.New("Ladesäule ist offline")
	}
	request, wireAction, err := commandRequest(cmd.Action, cmd.Request)
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	s.journal.BindOutgoing(cmd.ChargePointID, wireAction, cmd.CorrelationID)
	if err := t.cs.SendRequestAsync(cmd.ChargePointID, request, func(_ ocpp.Response, _ error) {}); err != nil {
		return fmt.Errorf("OCPP %s konnte nicht gesendet werden: %w", cmd.Action, err)
	}
	return nil
}

func commandRequest(action string, raw []byte) (ocpp.Request, string, error) {
	data := raw
	if len(data) == 0 {
		data = []byte(`{}`)
	}
	var req ocpp.Request
	wire := action
	switch action {
	case "RemoteStartTransaction":
		req = &core.RemoteStartTransactionRequest{}
	case "RemoteStopTransaction":
		req = &core.RemoteStopTransactionRequest{}
	case "UnlockConnector":
		req = &core.UnlockConnectorRequest{}
	case "SoftReset", "HardReset":
		req = &core.ResetRequest{}
		wire = "Reset"
	case "ChangeAvailability":
		req = &core.ChangeAvailabilityRequest{}
	case "TriggerMessage":
		req = &remotetrigger.TriggerMessageRequest{}
	case "GetConfiguration":
		req = &core.GetConfigurationRequest{}
	case "ChangeConfiguration":
		req = &core.ChangeConfigurationRequest{}
	case "ClearCache":
		req = &core.ClearCacheRequest{}
	case "GetDiagnostics":
		req = &firmware.GetDiagnosticsRequest{}
	case "UpdateFirmware":
		req = &firmware.UpdateFirmwareRequest{}
	case "ReserveNow":
		req = &reservation.ReserveNowRequest{}
	case "CancelReservation":
		req = &reservation.CancelReservationRequest{}
	case "GetLocalListVersion":
		req = &localauth.GetLocalListVersionRequest{}
	case "SendLocalList":
		req = &localauth.SendLocalListRequest{}
	case "SetChargingProfile":
		req = &smartcharging.SetChargingProfileRequest{}
	case "ClearChargingProfile":
		req = &smartcharging.ClearChargingProfileRequest{}
	case "GetCompositeSchedule":
		req = &smartcharging.GetCompositeScheduleRequest{}
	case "DataTransfer":
		req = &core.DataTransferRequest{}
	default:
		return nil, "", fmt.Errorf("OCPP-Aktion %q wird auf der Edge nicht unterstützt", action)
	}
	if err := json.Unmarshal(data, req); err != nil {
		return nil, "", fmt.Errorf("Payload für %s ist ungültig: %w", action, err)
	}
	if reset, ok := req.(*core.ResetRequest); ok && reset.Type == "" {
		if action == "HardReset" {
			reset.Type = core.ResetTypeHard
		} else {
			reset.Type = core.ResetTypeSoft
		}
	}
	return req, wire, nil
}
