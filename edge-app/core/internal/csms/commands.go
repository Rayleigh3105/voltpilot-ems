package csms

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/firmware"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/localauth"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/remotetrigger"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/reservation"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
)

type CommandIdentity struct{ TenantID, SiteID, DeviceID string }

// CloudCommand is the non-retained Cloud -> Edge OCPP contract. Request is
// typed by action at this boundary; it is never interpreted by the API as
// free-form vendor JSON except for schema-registered DataTransfer.
type CloudCommand struct {
	SchemaVersion        string          `json:"schema_version"`
	Type                 string          `json:"type"`
	TenantID             string          `json:"tenant_id"`
	SiteID               string          `json:"site_id"`
	DeviceID             string          `json:"device_id"`
	ChargePointID        string          `json:"charge_point_id"`
	ActionID             string          `json:"action_id"`
	CorrelationID        string          `json:"correlation_id"`
	RequestedAt          string          `json:"requested_at"`
	DeadlineAt           string          `json:"deadline_at"`
	RequestHash          string          `json:"request_hash"`
	DataTransferSchemaID string          `json:"data_transfer_schema_id,omitempty"`
	Action               string          `json:"action"`
	Request              json.RawMessage `json:"request"`
}

var commandUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

const (
	commandSocketWriteWait = 2 * time.Second
	commandWriteReserve    = 10 * time.Second
)

func (s *Server) ExecuteCloudCommand(ctx context.Context, raw []byte, identity CommandIdentity) error {
	var cmd CloudCommand
	if err := decodeStrict(raw, &cmd); err != nil || cmd.Type != "ocpp_command" || cmd.SchemaVersion != "1.0" {
		return errors.New("ungültiger OCPP-Cloud-Befehl")
	}
	reject := func(code, reason string) error {
		s.journal.RecordCommandEvent(cmd.ChargePointID, cmd.CorrelationID, "CommandRejected",
			cmd.ActionID, code, reason, s.opts.Now())
		return errors.New(reason)
	}
	requestBytes := bytes.TrimSpace(cmd.Request)
	if cmd.TenantID == "" || cmd.SiteID == "" || cmd.DeviceID == "" || cmd.ChargePointID == "" ||
		cmd.Action == "" || cmd.CorrelationID == "" || !commandUUID.MatchString(cmd.ActionID) ||
		cmd.CorrelationID != "ocpp-"+cmd.ActionID ||
		!regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(cmd.RequestHash) ||
		len(requestBytes) == 0 || requestBytes[0] != '{' {
		return reject("invalid_envelope", "unvollständiger OCPP-Cloud-Befehl")
	}
	if cmd.TenantID != identity.TenantID || cmd.SiteID != identity.SiteID || cmd.DeviceID != identity.DeviceID {
		return reject("identity_mismatch", "OCPP-Befehl gehört zu einer anderen Edge-Identität")
	}
	requested, err1 := time.Parse(time.RFC3339Nano, cmd.RequestedAt)
	deadline, err2 := time.Parse(time.RFC3339Nano, cmd.DeadlineAt)
	now := s.opts.Now()
	if err1 != nil || err2 != nil || deadline.Before(requested) || deadline.Sub(requested) > 10*time.Minute ||
		requested.After(now.Add(time.Minute)) {
		return reject("invalid_deadline", "OCPP-Befehl hat keine gültige Ausführungsfrist")
	}
	if !now.Before(deadline) {
		return reject("expired", "OCPP-Befehl ist bereits abgelaufen")
	}
	if !now.Add(commandWriteReserve).Before(deadline) {
		return reject("deadline_too_close", "OCPP-Ausführungsfrist reicht für ein sicheres Senden nicht mehr aus")
	}
	request, wireAction, err := commandRequest(cmd.Action, cmd.Request)
	if err != nil {
		return reject("invalid_payload", err.Error())
	}
	if cmd.Action == "DataTransfer" && cmd.DataTransferSchemaID != "voltpilot.health-check.v1" {
		return reject("unknown_schema", "DataTransfer-Schema ist auf dieser Edge nicht registriert")
	}
	if cmd.Action == "DataTransfer" {
		dt := request.(*core.DataTransferRequest)
		data, ok := dt.Data.(map[string]any)
		nonce, nonceOK := data["nonce"].(string)
		if dt.VendorId != "de.voltpilot" || dt.MessageId != "HealthCheck" || !ok || !nonceOK || nonce == "" || len(data) != 1 {
			return reject("schema_violation", "DataTransfer-Nutzlast verletzt das registrierte Vendor-Schema")
		}
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(raw))
	duplicate, err := s.commands.claim(cmd, fingerprint, wireAction, deadline, now)
	if err != nil {
		if errors.Is(err, errCommandLedgerCapacity) {
			return reject("ledger_capacity", "OCPP-Befehl kann nicht sicher angenommen werden: Das At-most-once-Ledger ist ausgelastet")
		}
		return reject("deduplication_failed", "OCPP-Befehl konnte nicht dauerhaft vorgemerkt werden")
	}
	if duplicate {
		s.journal.RecordCommandEvent(cmd.ChargePointID, cmd.CorrelationID, "CommandDuplicate",
			cmd.ActionID, "duplicate", "Bereits dauerhaft verarbeiteter OCPP-Befehl", now)
		return nil
	}
	s.mu.Lock()
	t := s.transport
	c, ok := s.chargers[cmd.ChargePointID]
	connected := ok && c.Connected
	s.mu.Unlock()
	if !ok {
		rejected := reject("unknown_station", ErrNotFound.Error())
		_ = s.commands.finish(cmd.ActionID, "rejected", now)
		return rejected
	}
	if !connected || t == nil {
		rejected := reject("station_offline", "Ladesäule ist offline")
		_ = s.commands.finish(cmd.ActionID, "rejected", now)
		return rejected
	}
	select {
	case <-ctx.Done():
		rejected := reject("cancelled_before_send", "OCPP-Befehl wurde vor dem Senden beendet")
		_ = s.commands.finish(cmd.ActionID, "rejected", now)
		return rejected
	default:
	}
	// Re-check the immutable deadline at the bounded websocket handoff. The
	// gateway bypasses ocpp-go's async action queue; the reserve covers the
	// serialized one-slot handoff plus the configured socket write timeout.
	if !s.opts.Now().Add(commandWriteReserve).Before(deadline) {
		rejected := reject("deadline_too_close", "OCPP-Ausführungsfrist reicht für ein sicheres Senden nicht mehr aus")
		_ = s.commands.finish(cmd.ActionID, "rejected", s.opts.Now())
		return rejected
	}
	if err := t.sendCloudCommand(cmd.ChargePointID, request, wireAction, cmd.ActionID, cmd.CorrelationID); err != nil {
		rejected := reject("send_failed", fmt.Sprintf("OCPP %s konnte nicht gesendet werden", cmd.Action))
		_ = s.commands.finish(cmd.ActionID, "rejected", s.opts.Now())
		return rejected
	}
	if err := s.commands.finish(cmd.ActionID, "sent", s.opts.Now()); err != nil {
		// The durable claim already exists, so even this post-send disk failure
		// cannot cause a replay. Surface it instead of pretending all is well.
		return reject("ledger_finish_failed", "OCPP-Befehl wurde gesendet, Abschluss des Edge-Ledgers ist fehlgeschlagen")
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
	if err := decodeStrict(data, req); err != nil {
		return nil, "", fmt.Errorf("Payload für %s ist ungültig: %w", action, err)
	}
	if reset, ok := req.(*core.ResetRequest); ok && reset.Type == "" {
		if action == "HardReset" {
			reset.Type = core.ResetTypeHard
		} else {
			reset.Type = core.ResetTypeSoft
		}
	}
	if err := types.Validate.Struct(req); err != nil {
		return nil, "", fmt.Errorf("Payload für %s verletzt das OCPP-Schema: %w", action, err)
	}
	return req, wire, nil
}

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("mehrere JSON-Werte")
		}
		return err
	}
	return nil
}

func (t *transport) sendCloudCommand(chargePointID string, request any,
	wireAction, wireID, correlation string) error {
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}
	frame, err := json.Marshal([]any{2, wireID, wireAction, json.RawMessage(payload)})
	if err != nil {
		return err
	}
	t.srv.journal.BindWire(chargePointID, wireID, wireAction, correlation)
	if err := t.wsrv.Write(chargePointID, frame); err != nil {
		t.srv.journal.UnbindWire(chargePointID, wireID)
		return err
	}
	return nil
}

// commandReadback turns a positive configuration/profile mutation response
// into the explicit follow-up required by the product choreography. The
// minimal readback metadata survives a restart in the command ledger and does
// not contain idTags, values, URLs, tokens, or vendor data.
func (s *Server) commandReadback(chargePointID, wireID, action string, payload json.RawMessage) {
	entry, ok := s.commands.get(wireID)
	if !ok || entry.ChargePointID != chargePointID || entry.Action != action {
		_ = s.commands.finishByWire(wireID, "responded", s.opts.Now())
		return
	}
	var response struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(payload, &response)
	if response.Status != "" && response.Status != "Accepted" && response.Status != "RebootRequired" {
		_ = s.commands.finish(wireID, "responded", s.opts.Now())
		return
	}
	var followAction string
	var followPayload []byte
	switch action {
	case "ChangeConfiguration":
		if entry.ConfigurationKey == "" {
			_ = s.commands.finish(wireID, "responded", s.opts.Now())
			return
		}
		followAction = "GetConfiguration"
		followPayload, _ = json.Marshal(map[string]any{"key": []string{entry.ConfigurationKey}})
	case "SendLocalList":
		followAction, followPayload = "GetLocalListVersion", []byte(`{}`)
	case "SetChargingProfile", "ClearChargingProfile":
		connector := 0
		if entry.ConnectorID != nil {
			connector = *entry.ConnectorID
		}
		followAction = "GetCompositeSchedule"
		followPayload, _ = json.Marshal(map[string]any{"connectorId": connector, "duration": 300})
	default:
		_ = s.commands.finish(wireID, "responded", s.opts.Now())
		return
	}
	request, followWire, err := commandRequest(followAction, followPayload)
	if err != nil {
		s.journal.RecordCommandEvent(chargePointID, entry.CorrelationID, "CommandRejected", wireID,
			"readback_failed", "OCPP-Readback konnte nicht vorbereitet werden", s.opts.Now())
		_ = s.commands.finish(wireID, "readback_failed", s.opts.Now())
		return
	}
	s.mu.Lock()
	t := s.transport
	charger := s.chargers[chargePointID]
	connected := charger != nil && charger.Connected
	s.mu.Unlock()
	if t == nil || !connected {
		s.journal.RecordCommandEvent(chargePointID, entry.CorrelationID, "CommandRejected", wireID,
			"readback_failed", "OCPP-Readback konnte wegen Verbindungsabbruch nicht gesendet werden", s.opts.Now())
		_ = s.commands.finish(wireID, "readback_failed", s.opts.Now())
		return
	}
	// OCPP-J uniqueId is capped at 36 characters by several 1.6 stacks. The
	// action UUID is already 36 characters, so suffixing it makes a standards-
	// compliant station silently discard the readback CALL.
	readbackCorrelation := "readback-" + entry.CorrelationID
	bound, shouldSend, err := s.commands.bindReadback(wireID, newEventID(), followWire,
		readbackCorrelation, s.opts.Now())
	if err != nil {
		s.journal.RecordCommandEvent(chargePointID, entry.CorrelationID, "CommandRejected", wireID,
			"readback_failed", "OCPP-Readback konnte nicht dauerhaft korreliert werden", s.opts.Now())
		return
	}
	if !shouldSend {
		return
	}
	if err := t.sendCloudCommand(chargePointID, request, followWire, bound.ReadbackWireID, bound.ReadbackCorrelation); err != nil {
		s.journal.RecordCommandEvent(chargePointID, entry.CorrelationID, "CommandRejected", wireID,
			"readback_failed", "OCPP-Readback konnte nicht gesendet werden", s.opts.Now())
		_ = s.commands.finish(wireID, "readback_failed", s.opts.Now())
		return
	}
	_ = s.commands.finish(wireID, "readback_sent", s.opts.Now())
}
