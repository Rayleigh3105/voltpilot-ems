package csms

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
)

func TestCommandRequestCoversCompleteOcpp16Surface(t *testing.T) {
	valid := map[string]string{
		"RemoteStartTransaction": `{"idTag":"tag"}`, "RemoteStopTransaction": `{"transactionId":1}`,
		"UnlockConnector": `{"connectorId":1}`, "SoftReset": `{}`, "HardReset": `{}`,
		"ChangeAvailability": `{"connectorId":0,"type":"Operative"}`,
		"TriggerMessage":     `{"requestedMessage":"Heartbeat"}`, "GetConfiguration": `{}`,
		"ChangeConfiguration": `{"key":"HeartbeatInterval","value":"300"}`, "ClearCache": `{}`,
		"GetDiagnostics":    `{"location":"https://example.invalid/upload"}`,
		"UpdateFirmware":    `{"location":"https://example.invalid/fw","retrieveDate":"2026-08-25T10:00:00Z"}`,
		"ReserveNow":        `{"connectorId":1,"expiryDate":"2026-08-25T10:00:00Z","idTag":"tag","reservationId":1}`,
		"CancelReservation": `{"reservationId":1}`, "GetLocalListVersion": `{}`,
		"SendLocalList":        `{"listVersion":1,"updateType":"Full"}`,
		"SetChargingProfile":   `{"connectorId":1,"csChargingProfiles":{"chargingProfileId":1,"stackLevel":0,"chargingProfilePurpose":"TxProfile","chargingProfileKind":"Absolute","chargingSchedule":{"chargingRateUnit":"W","chargingSchedulePeriod":[{"startPeriod":0,"limit":11000}]}}}`,
		"ClearChargingProfile": `{}`, "GetCompositeSchedule": `{"connectorId":1,"duration":300}`,
		"DataTransfer": `{"vendorId":"de.voltpilot","messageId":"HealthCheck","data":{"nonce":"x"}}`,
	}
	for action, payload := range valid {
		req, wire, err := commandRequest(action, json.RawMessage(payload))
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
	if _, _, err := commandRequest("RemoteStartTransaction", json.RawMessage(`{}`)); err == nil {
		t.Fatal("required OCPP fields must be validated before enqueue")
	}
	if _, wire, _ := commandRequest("SoftReset", nil); wire != "Reset" {
		t.Fatal("soft reset must use OCPP Reset")
	}
	if _, wire, _ := commandRequest("HardReset", nil); wire != "Reset" {
		t.Fatal("hard reset must use OCPP Reset")
	}
}

func cloudCommand(now time.Time, mutate func(*CloudCommand)) []byte {
	cmd := CloudCommand{SchemaVersion: "1.0", Type: "ocpp_command", TenantID: "tenant-a",
		SiteID: "site-a", DeviceID: "device-a", ChargePointID: "cp-1",
		ActionID: "11111111-1111-4111-8111-111111111111", CorrelationID: "ocpp-11111111-1111-4111-8111-111111111111",
		RequestedAt: now.Format(time.RFC3339Nano), DeadlineAt: now.Add(30 * time.Second).Format(time.RFC3339Nano),
		RequestHash: strings.Repeat("a", 64), Action: "RemoteStartTransaction", Request: json.RawMessage(`{"idTag":"tag"}`)}
	if mutate != nil {
		mutate(&cmd)
	}
	raw, _ := json.Marshal(cmd)
	return raw
}

func TestCommandReplayAndReconnectAreDurablyDeduplicated(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	identity := CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}
	s1, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return now }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	raw := cloudCommand(now, nil)
	if err := s1.ExecuteCloudCommand(context.Background(), raw, identity); err == nil || !strings.Contains(err.Error(), "nicht gefunden") {
		t.Fatalf("first offline/unknown execution = %v", err)
	}
	s1.Stop()
	// Restart is the reconnect/crash boundary: the broker may redeliver the
	// same QoS1 bytes, but the persistent claim wins before station lookup.
	s2, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return now.Add(time.Second) }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Stop()
	if err := s2.ExecuteCloudCommand(context.Background(), raw, identity); err != nil {
		t.Fatalf("duplicate should be an idempotent no-op: %v", err)
	}
	if changed := cloudCommand(now, func(c *CloudCommand) { c.Action = "HardReset"; c.Request = json.RawMessage(`{}`) }); s2.ExecuteCloudCommand(context.Background(), changed, identity) == nil {
		t.Fatal("same action_id with changed bytes must fail closed")
	}
}

func TestCommandCrashAfterDurableClaimNeverReplays(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	raw := cloudCommand(now, nil)
	s1, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return now }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	var cmd CloudCommand
	if err := json.Unmarshal(raw, &cmd); err != nil {
		t.Fatal(err)
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(raw))
	if duplicate, err := s1.commands.claim(cmd, fingerprint, cmd.Action, now.Add(30*time.Second), now); err != nil || duplicate {
		t.Fatalf("durable pre-send claim: duplicate=%v err=%v", duplicate, err)
	}
	// Simulate power loss in the exact claim -> station-write window: no
	// finish marker exists, but the fsynced claim must still be authoritative.
	s1.Stop()
	s2, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return now.Add(time.Second) }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Stop()
	identity := CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}
	if err := s2.ExecuteCloudCommand(context.Background(), raw, identity); err != nil {
		t.Fatalf("crash-window replay must be a no-op before station lookup: %v", err)
	}
}

func TestCommandDeadlineAndIdentityFailClosedBeforeExecution(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	s, err := New(Options{Enabled: false, DataDir: t.TempDir(), Now: func() time.Time { return now }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	identity := CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}
	expired := cloudCommand(now.Add(-time.Minute), func(c *CloudCommand) { c.DeadlineAt = now.Add(-time.Second).Format(time.RFC3339Nano) })
	if err := s.ExecuteCloudCommand(context.Background(), expired, identity); err == nil || !strings.Contains(err.Error(), "abgelaufen") {
		t.Fatalf("expired = %v", err)
	}
	tooLateForSafeWrite := cloudCommand(now.Add(-20*time.Second), func(c *CloudCommand) {
		c.DeadlineAt = now.Add(5 * time.Second).Format(time.RFC3339Nano)
	})
	if err := s.ExecuteCloudCommand(context.Background(), tooLateForSafeWrite, identity); err == nil || !strings.Contains(err.Error(), "Ausführungsfrist") {
		t.Fatalf("near-deadline = %v", err)
	}
	foreign := cloudCommand(now, func(c *CloudCommand) {
		c.ActionID = "22222222-2222-4222-8222-222222222222"
		c.CorrelationID = "ocpp-" + c.ActionID
		c.DeviceID = "device-b"
	})
	if err := s.ExecuteCloudCommand(context.Background(), foreign, identity); err == nil || !strings.Contains(err.Error(), "anderen Edge") {
		t.Fatalf("foreign = %v", err)
	}
	badCorrelation := cloudCommand(now, func(c *CloudCommand) { c.CorrelationID = "ocpp-wrong" })
	if err := s.ExecuteCloudCommand(context.Background(), badCorrelation, identity); err == nil || !strings.Contains(err.Error(), "unvollständig") {
		t.Fatalf("correlation mismatch = %v", err)
	}
}

func TestWireCorrelationSurvivesCrashAndConcurrentReverseResponses(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	j, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	j.BindWire("cp-1", "wire-a", "Reset", "operation-a")
	j.RecordWire("csms_to_station", "cp-1", []byte(`[2,"wire-a","Reset",{"type":"Soft"}]`))
	j.BindWire("cp-1", "wire-b", "Reset", "operation-b")
	j.RecordWire("csms_to_station", "cp-1", []byte(`[2,"wire-b","Reset",{"type":"Hard"}]`))
	j.Close()
	j2, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	defer j2.Close()
	j2.RecordWire("station_to_csms", "cp-1", []byte(`[3,"wire-b",{"status":"Accepted"}]`))
	j2.RecordWire("station_to_csms", "cp-1", []byte(`[3,"wire-a",{"status":"Accepted"}]`))
	want := map[string]string{"wire-a": "operation-a", "wire-b": "operation-b"}
	got := map[string]string{}
	for {
		raw, token, ok := j2.Next()
		if !ok {
			break
		}
		var e ProtocolEvent
		if json.Unmarshal(raw, &e) != nil {
			t.Fatal("bad event")
		}
		if e.MessageType == "CallResult" {
			got[e.WireID] = e.CorrelationID
		}
		if err := j2.Ack(token); err != nil {
			t.Fatal(err)
		}
	}
	if len(got) != 2 || got["wire-a"] != want["wire-a"] || got["wire-b"] != want["wire-b"] {
		t.Fatalf("correlation after crash/reverse responses = %#v", got)
	}
}

func TestWireCorrelationSurvivesRestartAfterOutboundCallUploadAck(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	ledger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	j, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	commands := []CloudCommand{
		{ActionID: "11111111-1111-4111-8111-111111111111", CorrelationID: "ocpp-11111111-1111-4111-8111-111111111111",
			Action: "SetChargingProfile", ChargePointID: "cp-1", Request: json.RawMessage(`{"connectorId":1}`)},
		{ActionID: "22222222-2222-4222-8222-222222222222", CorrelationID: "ocpp-22222222-2222-4222-8222-222222222222",
			Action: "SetChargingProfile", ChargePointID: "cp-1", Request: json.RawMessage(`{"connectorId":1}`)},
	}
	for i, cmd := range commands {
		if duplicate, err := ledger.claim(cmd, fmt.Sprintf("fingerprint-%d", i), cmd.Action,
			now.Add(time.Minute), now); err != nil || duplicate {
			t.Fatalf("claim %d: duplicate=%v err=%v", i, duplicate, err)
		}
		j.BindWire(cmd.ChargePointID, cmd.ActionID, cmd.Action, cmd.CorrelationID)
		j.RecordWire("csms_to_station", cmd.ChargePointID,
			[]byte(fmt.Sprintf(`[2,%q,%q,{"connectorId":1}]`, cmd.ActionID, cmd.Action)))
		if err := ledger.finish(cmd.ActionID, "sent", now); err != nil {
			t.Fatal(err)
		}
	}
	// Model the normal cloud uploader: both outbound CALL records have been
	// delivered with QoS1 and their immutable spool files are deleted.
	for range commands {
		raw, token, ok := j.Next()
		if !ok {
			t.Fatal("missing outbound CALL")
		}
		var event ProtocolEvent
		if err := json.Unmarshal(raw, &event); err != nil || event.MessageType != "Call" {
			t.Fatalf("outbound event = %#v err=%v", event, err)
		}
		if err := j.Ack(token); err != nil {
			t.Fatal(err)
		}
	}
	j.Close()

	restartedLedger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	restarted.RestoreCommandMappings(restartedLedger.wireMappings())
	callbacks := map[string]string{}
	restarted.onCommandResult = func(_, wireID, action string, _ json.RawMessage) {
		callbacks[wireID] = action
		_ = restartedLedger.finishByWire(wireID, "responded", now.Add(time.Second))
	}
	// Same-action results deliberately arrive in reverse order. Only the exact
	// wire UUID may decide their logical operation and targeted callback.
	for i := len(commands) - 1; i >= 0; i-- {
		cmd := commands[i]
		restarted.RecordWire("station_to_csms", cmd.ChargePointID,
			[]byte(fmt.Sprintf(`[3,%q,{"status":"Accepted"}]`, cmd.ActionID)))
	}
	correlations := map[string]string{}
	for {
		raw, token, ok := restarted.Next()
		if !ok {
			break
		}
		var event ProtocolEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		if event.MessageType == "CallResult" {
			correlations[event.WireID] = event.CorrelationID
			if event.Action != "SetChargingProfile" {
				t.Fatalf("wire %s action=%q", event.WireID, event.Action)
			}
		}
		if err := restarted.Ack(token); err != nil {
			t.Fatal(err)
		}
	}
	for _, cmd := range commands {
		if correlations[cmd.ActionID] != cmd.CorrelationID || callbacks[cmd.ActionID] != cmd.Action {
			t.Fatalf("wire %s correlation=%q callback=%q", cmd.ActionID,
				correlations[cmd.ActionID], callbacks[cmd.ActionID])
		}
	}

	// The same durability rule applies to the targeted readback CALL. Its ACK
	// must not make a later composite-schedule result anonymous after restart.
	readbackWire := "33333333-3333-4333-8333-333333333333"
	bound, shouldSend, err := restartedLedger.bindReadback(commands[0].ActionID, readbackWire,
		"GetCompositeSchedule", "readback-"+commands[0].CorrelationID, now.Add(2*time.Second))
	if err != nil || !shouldSend {
		t.Fatalf("bind readback: bound=%#v send=%v err=%v", bound, shouldSend, err)
	}
	restarted.BindWire("cp-1", readbackWire, bound.ReadbackAction, bound.ReadbackCorrelation)
	restarted.RecordWire("csms_to_station", "cp-1",
		[]byte(fmt.Sprintf(`[2,%q,"GetCompositeSchedule",{"connectorId":1,"duration":300}]`, readbackWire)))
	if err := restartedLedger.finish(commands[0].ActionID, "readback_sent", now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	raw, token, ok := restarted.Next()
	if !ok {
		t.Fatal("missing readback CALL")
	}
	var readbackCall ProtocolEvent
	if err := json.Unmarshal(raw, &readbackCall); err != nil || readbackCall.WireID != readbackWire {
		t.Fatalf("readback CALL=%#v err=%v", readbackCall, err)
	}
	if err := restarted.Ack(token); err != nil {
		t.Fatal(err)
	}
	restarted.Close()

	thirdLedger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	third, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	third.RestoreCommandMappings(thirdLedger.wireMappings())
	third.RecordWire("station_to_csms", "cp-1",
		[]byte(fmt.Sprintf(`[3,%q,{"status":"Accepted","connectorId":1}]`, readbackWire)))
	raw, _, ok = third.Next()
	if !ok {
		t.Fatal("missing readback result")
	}
	var readbackResult ProtocolEvent
	if err := json.Unmarshal(raw, &readbackResult); err != nil {
		t.Fatal(err)
	}
	if readbackResult.Action != "GetCompositeSchedule" ||
		readbackResult.CorrelationID != "readback-"+commands[0].CorrelationID {
		t.Fatalf("readback result lost exact mapping: %#v", readbackResult)
	}
}

func TestJournalCarriesExternalCorrelationAcrossWireID(t *testing.T) {
	j, err := newJournal(t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	j.BindWire("cp-1", "wire-1", "RemoteStartTransaction", "ocpp-action-1")
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
