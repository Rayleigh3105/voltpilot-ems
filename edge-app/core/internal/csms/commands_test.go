package csms

import (
	"encoding/json"
	"io"
	"log/slog"
	"testing"

	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
)

func TestCommandRequestCoversCompleteOcpp16Surface(t *testing.T) {
	actions := []string{"RemoteStartTransaction", "RemoteStopTransaction", "UnlockConnector", "SoftReset",
		"HardReset", "ChangeAvailability", "TriggerMessage", "GetConfiguration", "ChangeConfiguration",
		"ClearCache", "GetDiagnostics", "UpdateFirmware", "ReserveNow", "CancelReservation",
		"GetLocalListVersion", "SendLocalList", "SetChargingProfile", "ClearChargingProfile",
		"GetCompositeSchedule", "DataTransfer"}
	for _, action := range actions {
		req, wire, err := commandRequest(action, json.RawMessage(`{}`))
		if err != nil || req == nil {
			t.Fatalf("%s: req=%v wire=%q err=%v", action, req, wire, err)
		}
		if reset, ok := req.(*core.ResetRequest); ok {
			want := core.ResetTypeSoft
			if action == "HardReset" {
				want = core.ResetTypeHard
			}
			if reset.Type != want {
				t.Fatalf("%s default reset type = %q, want %q", action, reset.Type, want)
			}
		}
	}
	if _, wire, _ := commandRequest("SoftReset", nil); wire != "Reset" {
		t.Fatal("soft reset must use OCPP Reset")
	}
	if _, wire, _ := commandRequest("HardReset", nil); wire != "Reset" {
		t.Fatal("hard reset must use OCPP Reset")
	}
}

func TestJournalCarriesExternalCorrelationAcrossWireID(t *testing.T) {
	j, err := newJournal(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	j.BindOutgoing("cp-1", "RemoteStartTransaction", "ocpp-action-1")
	j.RecordWire("csms_to_station", "cp-1", []byte(`[2,"wire-1","RemoteStartTransaction",{"idTag":"secret"}]`))
	j.RecordWire("station_to_csms", "cp-1", []byte(`[3,"wire-1",{"status":"Accepted"}]`))
	first, token, ok := j.Next()
	if !ok {
		t.Fatal("missing call")
	}
	if err := j.Ack(token); err != nil {
		t.Fatal(err)
	}
	second, token, ok := j.Next()
	if !ok {
		t.Fatal("missing result")
	}
	if err := j.Ack(token); err != nil {
		t.Fatal(err)
	}
	var call, result ProtocolEvent
	if err := json.Unmarshal(first, &call); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second, &result); err != nil {
		t.Fatal(err)
	}
	if call.CorrelationID != "ocpp-action-1" || result.CorrelationID != "ocpp-action-1" {
		t.Fatalf("correlation lost: %#v %#v", call, result)
	}
	if result.Action != "RemoteStartTransaction" {
		t.Fatalf("wrong action %q", result.Action)
	}
}
