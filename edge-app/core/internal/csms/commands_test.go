package csms

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ws"
)

type writeCountingWsServer struct {
	ws.WsServer
	writes int
}

func (s *writeCountingWsServer) Write(_ string, _ []byte) error {
	s.writes++
	return nil
}

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

func TestCommandLedgerCapacityBackpressurePreservesOldestLiveReplayAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	clockNow := now
	oldestID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	oldestRaw := cloudCommand(now, func(c *CloudCommand) {
		c.ActionID = oldestID
		c.CorrelationID = "ocpp-" + oldestID
	})
	var oldest CloudCommand
	if err := json.Unmarshal(oldestRaw, &oldest); err != nil {
		t.Fatal(err)
	}
	oldestFingerprint := fmt.Sprintf("%x", sha256.Sum256(oldestRaw))

	ledger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Build one durable full-capacity image in a single fsync. The first entry
	// is the reviewer's oldest still-unexpired sent command; another is already
	// terminal but remains live dedup evidence until the immutable deadline.
	ledger.entries[oldestID] = commandLedgerEntry{ActionID: oldestID,
		Fingerprint: oldestFingerprint, State: "sent", DeadlineAt: now.Add(30 * time.Second),
		UpdatedAt: now.Add(-time.Hour), Action: oldest.Action, WireAction: oldest.Action,
		ChargePointID: oldest.ChargePointID, CorrelationID: oldest.CorrelationID}
	liveTerminalID := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	ledger.entries[liveTerminalID] = commandLedgerEntry{ActionID: liveTerminalID,
		Fingerprint: "terminal-fingerprint", State: "responded", DeadlineAt: now.Add(2 * time.Second),
		UpdatedAt: now.Add(-30 * time.Minute), Action: "ClearCache", WireAction: "ClearCache",
		ChargePointID: "cp-1", CorrelationID: "ocpp-" + liveTerminalID}
	for i := 0; len(ledger.entries) < commandLedgerLimit; i++ {
		id := fmt.Sprintf("%08x-0000-4000-8000-%012x", i+1, i+1)
		ledger.entries[id] = commandLedgerEntry{ActionID: id, Fingerprint: fmt.Sprintf("fingerprint-%d", i),
			State: "sent", DeadlineAt: now.Add(30 * time.Second), UpdatedAt: now.Add(time.Duration(i) * time.Nanosecond),
			Action: "ClearCache", WireAction: "ClearCache", ChargePointID: "cp-1", CorrelationID: "ocpp-" + id}
	}
	if err := ledger.save(); err != nil {
		t.Fatal(err)
	}

	identity := CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}
	s1, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return clockNow }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	firstSocket := &writeCountingWsServer{}
	s1.chargers["cp-1"] = &ChargerState{Charger: Charger{ID: "cp-1"}, Connected: true}
	s1.transport = &transport{srv: s1, wsrv: firstSocket}
	newRaw := cloudCommand(now, func(c *CloudCommand) {
		c.ActionID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
		c.CorrelationID = "ocpp-" + c.ActionID
	})
	if err := s1.ExecuteCloudCommand(context.Background(), newRaw, identity); err == nil ||
		!strings.Contains(err.Error(), "At-most-once-Ledger ist ausgelastet") {
		t.Fatalf("full live ledger must apply explicit backpressure, got %v", err)
	}
	if firstSocket.writes != 0 {
		t.Fatalf("capacity-rejected command wrote %d station frames", firstSocket.writes)
	}
	eventRaw, token, ok := s1.NextProtocolEvent()
	if !ok {
		t.Fatal("capacity rejection was not durably reported upstream")
	}
	var rejection ProtocolEvent
	if err := json.Unmarshal(eventRaw, &rejection); err != nil {
		t.Fatal(err)
	}
	if rejection.Action != "CommandRejected" || rejection.Payload == nil {
		t.Fatalf("capacity event = %#v", rejection)
	}
	var rejectionPayload map[string]any
	if err := json.Unmarshal(rejection.Payload, &rejectionPayload); err != nil || rejectionPayload["code"] != "ledger_capacity" {
		t.Fatalf("capacity payload = %#v err=%v", rejectionPayload, err)
	}
	// Deliberately do not ACK: this is the reviewer's lost-PUBACK window.
	_ = token
	s1.transport = nil
	s1.Stop()

	restarted, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(restarted.entries) != commandLedgerLimit {
		t.Fatalf("ledger size after rejected claim = %d, want %d", len(restarted.entries), commandLedgerLimit)
	}
	if _, ok := restarted.entries[oldestID]; !ok {
		t.Fatal("capacity evicted the oldest still-unexpired at-most-once proof")
	}
	if _, ok := restarted.entries[liveTerminalID]; !ok {
		t.Fatal("capacity evicted terminal evidence before its replay deadline")
	}
	if _, ok := restarted.entries["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]; ok {
		t.Fatal("backpressured command was persisted as accepted")
	}
	if want := now.Add(30 * time.Second); !restarted.capacityBlockUntil.Equal(want) {
		t.Fatalf("capacity block = %s, want %s", restarted.capacityBlockUntil, want)
	}

	// A terminal slot becomes safely prunable, but the rejected envelope is
	// still live. Persist that free slot exactly as in the reproduced failure.
	clockNow = now.Add(3 * time.Second)
	restarted.mu.Lock()
	restarted.prune(clockNow)
	if err := restarted.save(); err != nil {
		restarted.mu.Unlock()
		t.Fatal(err)
	}
	restarted.mu.Unlock()
	if len(restarted.entries) != commandLedgerLimit-1 {
		t.Fatalf("ledger size after terminal slot freed = %d, want %d", len(restarted.entries), commandLedgerLimit-1)
	}
	if !restarted.capacityBlockUntil.Equal(now.Add(30 * time.Second)) {
		t.Fatal("freeing a slot cleared the live capacity watermark")
	}

	// Exact QoS1 replay after restart must remain rejected before station write
	// even though capacity is now available.
	s2, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return clockNow }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		s2.transport = nil
		s2.Stop()
	}()
	secondSocket := &writeCountingWsServer{}
	s2.chargers["cp-1"] = &ChargerState{Charger: Charger{ID: "cp-1"}, Connected: true}
	s2.transport = &transport{srv: s2, wsrv: secondSocket}
	if err := s2.ExecuteCloudCommand(context.Background(), newRaw, identity); err == nil ||
		!strings.Contains(err.Error(), "At-most-once-Ledger ist ausgelastet") {
		t.Fatalf("capacity replay after free slot/restart = %v", err)
	}
	if secondSocket.writes != 0 {
		t.Fatalf("capacity replay wrote %d station frames", secondSocket.writes)
	}
	if _, ok := s2.commands.entries["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]; ok {
		t.Fatal("capacity replay claimed the newly free execution slot")
	}

	// The stable event identity makes the replay idempotent in the durable
	// journal: the original unacknowledged rejection is still the only event.
	eventRaw, replayToken, ok := s2.NextProtocolEvent()
	if !ok {
		t.Fatal("original capacity feedback was lost across restart")
	}
	var replayEvent ProtocolEvent
	if err := json.Unmarshal(eventRaw, &replayEvent); err != nil {
		t.Fatal(err)
	}
	if replayEvent.EventID != "cccccccc-cccc-4ccc-8ccc-cccccccccccc" {
		t.Fatalf("capacity event id = %q, want stable action id", replayEvent.EventID)
	}
	if err := s2.AckProtocolEvent(replayToken); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := s2.NextProtocolEvent(); ok {
		t.Fatal("capacity replay created duplicate durable feedback")
	}
	// If feedback was ACKed but the command PUBACK was lost, re-emit the same
	// cloud event identity. The API can deduplicate it without suppressing the
	// rejection outcome, while the station still remains untouched.
	if err := s2.ExecuteCloudCommand(context.Background(), newRaw, identity); err == nil ||
		!strings.Contains(err.Error(), "At-most-once-Ledger ist ausgelastet") {
		t.Fatalf("post-feedback-ACK command replay = %v", err)
	}
	reemittedRaw, reemittedToken, ok := s2.NextProtocolEvent()
	if !ok {
		t.Fatal("capacity feedback was not re-emitted after its ACK")
	}
	var reemitted ProtocolEvent
	if err := json.Unmarshal(reemittedRaw, &reemitted); err != nil {
		t.Fatal(err)
	}
	if reemitted.EventID != replayEvent.EventID {
		t.Fatalf("re-emitted capacity event id = %q, want %q", reemitted.EventID, replayEvent.EventID)
	}
	if err := s2.AckProtocolEvent(reemittedToken); err != nil {
		t.Fatal(err)
	}
	if secondSocket.writes != 0 {
		t.Fatalf("post-feedback-ACK replay wrote %d station frames", secondSocket.writes)
	}

	// Existing claimed fingerprints retain their stronger collision semantics.
	if err := s2.ExecuteCloudCommand(context.Background(), oldestRaw, identity); err != nil {
		t.Fatalf("oldest exact replay after capacity/restart must be a no-op: %v", err)
	}
	oldestChanged := cloudCommand(now, func(c *CloudCommand) {
		c.ActionID = oldestID
		c.CorrelationID = "ocpp-" + oldestID
		c.RequestHash = strings.Repeat("b", 64)
	})
	if err := s2.ExecuteCloudCommand(context.Background(), oldestChanged, identity); err == nil ||
		!strings.Contains(err.Error(), "dauerhaft vorgemerkt") {
		t.Fatalf("existing fingerprint collision did not fail closed: %v", err)
	}
}

func TestCommandLedgerCapacityWatermarkIsBoundedAcrossHighCardinalityRestartAndBoundary(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	ledger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	terminalID := "terminal-slot"
	ledger.entries[terminalID] = commandLedgerEntry{ActionID: terminalID, Fingerprint: "terminal",
		State: "responded", DeadlineAt: now.Add(time.Second), UpdatedAt: now}
	for i := 0; len(ledger.entries) < commandLedgerLimit; i++ {
		id := fmt.Sprintf("protected-%d", i)
		ledger.entries[id] = commandLedgerEntry{ActionID: id, Fingerprint: id, State: "sent",
			DeadlineAt: now.Add(time.Hour), UpdatedAt: now}
	}
	if err := ledger.save(); err != nil {
		t.Fatal(err)
	}
	maxDeadline := now.Add(10 * time.Minute)
	first := CloudCommand{ActionID: "rejected-0", Action: "ClearCache"}
	if duplicate, err := ledger.claim(first, "rejected-0", "ClearCache", maxDeadline, now); duplicate || !errors.Is(err, errCommandLedgerCapacity) {
		t.Fatalf("initial capacity claim: duplicate=%v err=%v", duplicate, err)
	}
	initialBytes, err := os.ReadFile(ledger.path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 10000; i++ {
		id := fmt.Sprintf("rejected-%d", i)
		cmd := CloudCommand{ActionID: id, Action: "ClearCache"}
		deadline := now.Add(time.Duration(i%600+1) * time.Second)
		if duplicate, err := ledger.claim(cmd, id, "ClearCache", deadline, now); duplicate || !errors.Is(err, errCommandLedgerCapacity) {
			t.Fatalf("high-cardinality claim %d: duplicate=%v err=%v", i, duplicate, err)
		}
	}
	afterBytes, err := os.ReadFile(ledger.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(afterBytes) != len(initialBytes) || !bytes.Equal(afterBytes, initialBytes) {
		t.Fatalf("10,000 rejected IDs grew durable state: before=%d after=%d", len(initialBytes), len(afterBytes))
	}
	if len(ledger.entries) != commandLedgerLimit || !ledger.capacityBlockUntil.Equal(maxDeadline) {
		t.Fatalf("bounded state changed: entries=%d block=%s", len(ledger.entries), ledger.capacityBlockUntil)
	}

	restarted, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate, err := restarted.claim(CloudCommand{ActionID: "restart-replay", Action: "ClearCache"},
		"restart-replay", "ClearCache", maxDeadline, maxDeadline.Add(-time.Nanosecond)); duplicate || !errors.Is(err, errCommandLedgerCapacity) {
		t.Fatalf("restart before boundary: duplicate=%v err=%v", duplicate, err)
	}
	boundaryCommand := CloudCommand{ActionID: "after-boundary", Action: "ClearCache"}
	if duplicate, err := restarted.claim(boundaryCommand, "after-boundary", "ClearCache",
		maxDeadline.Add(time.Minute), maxDeadline); err != nil || duplicate {
		t.Fatalf("claim at exact expired watermark boundary: duplicate=%v err=%v", duplicate, err)
	}
	if !restarted.capacityBlockUntil.IsZero() {
		t.Fatalf("expired capacity watermark survived boundary: %s", restarted.capacityBlockUntil)
	}
	if _, ok := restarted.entries[terminalID]; ok {
		t.Fatal("expired terminal slot was not safely pruned at boundary")
	}
}

func TestCommandLedgerWatermarkExtensionSaveFailureStaysRetryableAcrossRestartBoundary(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	clockNow := now
	d1 := now.Add(20 * time.Second)
	d2 := now.Add(50 * time.Second)
	ledger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	terminalID := "terminal-capacity-slot"
	ledger.entries[terminalID] = commandLedgerEntry{ActionID: terminalID, Fingerprint: "terminal",
		State: "responded", DeadlineAt: d1, UpdatedAt: now}
	for i := 0; len(ledger.entries) < commandLedgerLimit; i++ {
		id := fmt.Sprintf("save-fail-protected-%d", i)
		ledger.entries[id] = commandLedgerEntry{ActionID: id, Fingerprint: id, State: "sent",
			DeadlineAt: now.Add(time.Hour), UpdatedAt: now}
	}
	ledger.capacityBlockUntil = d1
	if err := ledger.save(); err != nil {
		t.Fatal(err)
	}

	identity := CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}
	raw := cloudCommand(now, func(c *CloudCommand) {
		c.ActionID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
		c.CorrelationID = "ocpp-" + c.ActionID
		c.DeadlineAt = d2.Format(time.RFC3339Nano)
	})
	s1, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return clockNow }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	firstSocket := &writeCountingWsServer{}
	s1.chargers["cp-1"] = &ChargerState{Charger: Charger{ID: "cp-1"}, Connected: true}
	s1.transport = &transport{srv: s1, wsrv: firstSocket}
	s1.commands.beforeSave = func() error { return errors.New("forced watermark fsync failure") }
	err = s1.ExecuteCloudCommand(context.Background(), raw, identity)
	if !errors.Is(err, ErrCommandStorage) {
		t.Fatalf("watermark extension save failure = %v, want retryable storage error", err)
	}
	if firstSocket.writes != 0 {
		t.Fatalf("failed watermark extension wrote %d station frames", firstSocket.writes)
	}
	if _, _, ok := s1.NextProtocolEvent(); ok {
		t.Fatal("failed watermark extension emitted terminal cloud evidence")
	}
	if !s1.commands.capacityBlockUntil.Equal(d1) {
		t.Fatalf("failed extension changed in-memory watermark to %s, want D1 %s", s1.commands.capacityBlockUntil, d1)
	}
	s1.transport = nil
	s1.Stop()

	onDisk, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !onDisk.capacityBlockUntil.Equal(d1) {
		t.Fatalf("failed extension changed durable watermark to %s, want D1 %s", onDisk.capacityBlockUntil, d1)
	}

	// At the exact D1 boundary the old global block and one terminal slot are
	// safely prunable. Because the failed attempt emitted no terminal outcome
	// and remained unacknowledged, its QoS1 replay may now be claimed and sent.
	clockNow = d1
	s2, err := New(Options{Enabled: false, DataDir: dir, Now: func() time.Time { return clockNow }, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		s2.transport = nil
		s2.Stop()
	}()
	secondSocket := &writeCountingWsServer{}
	s2.chargers["cp-1"] = &ChargerState{Charger: Charger{ID: "cp-1"}, Connected: true}
	s2.transport = &transport{srv: s2, wsrv: secondSocket}
	if err := s2.ExecuteCloudCommand(context.Background(), raw, identity); err != nil {
		t.Fatalf("retry after storage recovery at D1 = %v", err)
	}
	if secondSocket.writes != 1 {
		t.Fatalf("durably claimed replay wrote %d station frames, want 1", secondSocket.writes)
	}
	entry, ok := s2.commands.entries["dddddddd-dddd-4ddd-8ddd-dddddddddddd"]
	if !ok || entry.State != "sent" {
		t.Fatalf("replay was not durably sent after recovery: %#v found=%v", entry, ok)
	}
}

func TestCommandLedgerCapacityPrunesExpiredButRetainsUnexpiredTerminalEvidence(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	ledger, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	expiredID := "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	liveTerminalID := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	latePendingID := "abababab-abab-4aba-8aba-abababababab"
	ledger.entries[expiredID] = commandLedgerEntry{ActionID: expiredID, Fingerprint: "expired",
		State: "responded", DeadlineAt: now, UpdatedAt: now.Add(-time.Hour)}
	ledger.entries[liveTerminalID] = commandLedgerEntry{ActionID: liveTerminalID, Fingerprint: "live-terminal",
		State: "rejected", DeadlineAt: now.Add(time.Minute), UpdatedAt: now.Add(-time.Hour)}
	ledger.entries[latePendingID] = commandLedgerEntry{ActionID: latePendingID, Fingerprint: "late-pending",
		State: "sent", DeadlineAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Hour)}
	for i := 0; len(ledger.entries) < commandLedgerLimit; i++ {
		id := fmt.Sprintf("%08x-1000-4000-8000-%012x", i+1, i+1)
		ledger.entries[id] = commandLedgerEntry{ActionID: id, Fingerprint: fmt.Sprintf("live-%d", i),
			State: "sent", DeadlineAt: now.Add(time.Minute), UpdatedAt: now}
	}
	if err := ledger.save(); err != nil {
		t.Fatal(err)
	}
	cmd := CloudCommand{ActionID: "ffffffff-ffff-4fff-8fff-ffffffffffff", Action: "ClearCache",
		ChargePointID: "cp-1", CorrelationID: "ocpp-ffffffff-ffff-4fff-8fff-ffffffffffff"}
	duplicate, err := ledger.claim(cmd, "new-fingerprint", "ClearCache", now.Add(time.Minute), now)
	if err != nil || duplicate {
		t.Fatalf("claim after safe expired prune: duplicate=%v err=%v", duplicate, err)
	}
	if _, ok := ledger.entries[expiredID]; ok {
		t.Fatal("expired evidence should free capacity")
	}
	if _, ok := ledger.entries[liveTerminalID]; !ok {
		t.Fatal("unexpired terminal evidence is still replay protection")
	}
	if _, ok := ledger.entries[latePendingID]; !ok {
		t.Fatal("expired sent command lost its bounded late-response correlation")
	}
	if len(ledger.entries) != commandLedgerLimit {
		t.Fatalf("ledger size after prune+claim = %d, want %d", len(ledger.entries), commandLedgerLimit)
	}
	restarted, err := newCommandLedger(dir)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate, err := restarted.claim(cmd, "new-fingerprint", "ClearCache", now.Add(time.Minute), now); err != nil || !duplicate {
		t.Fatalf("new claim did not survive restart: duplicate=%v err=%v", duplicate, err)
	}
}

func TestCommandLedgerPruneClassificationKeepsEveryLiveAndLateResponseProof(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		state    string
		deadline time.Time
		want     bool
	}{
		{"unexpired sent", "sent", now.Add(time.Second), false},
		{"unexpired terminal", "responded", now.Add(time.Second), false},
		{"expired terminal", "responded", now.Add(-time.Second), true},
		{"recent late response", "sent", now.Add(-time.Hour), false},
		{"late response retention elapsed", "readback_sent", now.Add(-commandLedgerLateResponseRetention), true},
		{"missing deadline fails closed", "responded", time.Time{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := commandLedgerEntryPrunable(commandLedgerEntry{State: tt.state, DeadlineAt: tt.deadline}, now); got != tt.want {
				t.Fatalf("prunable=%v, want %v", got, tt.want)
			}
		})
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
