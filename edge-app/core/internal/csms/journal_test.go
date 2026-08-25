package csms

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp"
)

func TestProtocolJournalPairsEveryWireTypeAndRedactsBeforeDisk(t *testing.T) {
	dir := t.TempDir()
	j, err := newJournal(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	j.RecordWire("station_to_csms", "CP-1", []byte(`[2,"auth-1","Authorize",{"idTag":"clear-rfid"}]`))
	j.RecordWire("csms_to_station", "CP-1", []byte(`[3,"auth-1",{"idTagInfo":{"status":"Accepted","parentIdTag":"clear-parent"}}]`))
	j.RecordWire("csms_to_station", "CP-1", []byte(`[2,"cfg-1","GetConfiguration",{}]`))
	j.RecordWire("station_to_csms", "CP-1", []byte(`[3,"cfg-1",{"configurationKey":[{"key":"AuthorizationKey","readonly":false,"value":"super-secret"},{"key":"RigVendor.Mode","readonly":true,"value":"complete"}]}]`))
	j.RecordWire("station_to_csms", "CP-1", []byte(`[4,"missing","NotSupported","AuthorizationKey=desc-secret https://example.invalid/x?token=url-secret idTag=description-tag client_secret=generic-secret",{"idTag":"another-clear-tag"}]`))

	var events []ProtocolEvent
	for {
		raw, token, ok := j.Next()
		if !ok {
			break
		}
		var event ProtocolEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
		if err := j.Ack(token); err != nil {
			t.Fatal(err)
		}
	}
	if len(events) != 5 {
		t.Fatalf("got %d events, want 5", len(events))
	}
	if events[1].Action != "Authorize" || events[1].MessageType != "CallResult" {
		t.Fatalf("result was not paired: %+v", events[1])
	}
	if events[3].Action != "GetConfiguration" || events[3].MessageType != "CallResult" {
		t.Fatalf("configuration result was not paired: %+v", events[3])
	}
	if events[4].MessageType != "CallError" || events[4].ErrorCode != "NotSupported" {
		t.Fatalf("call error lost: %+v", events[4])
	}
	if events[4].ErrorDescription != redactedErrorDescription {
		t.Fatalf("call error description not conservatively redacted: %+v", events[4])
	}

	all, err := os.ReadFile(filepath.Join(dir, journalKeyFile))
	if err != nil || len(all) != 32 {
		t.Fatalf("privacy key: bytes=%d err=%v", len(all), err)
	}
	encoded, _ := json.Marshal(events)
	got := string(encoded)
	for _, secret := range []string{"clear-rfid", "clear-parent", "another-clear-tag", "super-secret",
		"desc-secret", "url-secret", "description-tag", "generic-secret"} {
		if strings.Contains(got, secret) {
			t.Fatalf("secret %q reached journal: %s", secret, got)
		}
	}
	if !strings.Contains(got, "tagref_") || !strings.Contains(got, `"redacted":true`) ||
		!strings.Contains(got, "RigVendor.Mode") {
		t.Fatalf("masked refs/redaction/vendor key missing: %s", got)
	}
}

func TestProtocolCallErrorCannotEscapeThroughFunctionalErrorOrLogs(t *testing.T) {
	for _, canary := range []string{
		"AuthorizationKey=edge-secret",
		"https://station.invalid/upload?token=url-secret",
		"idTag=clear-rfid",
		"client_secret=generic-secret",
	} {
		raw := ocpp.NewError("NotSupported", canary, "correlation-secret-safe")
		got := privacySafeProtocolError(raw)
		if !strings.Contains(got.Error(), "NotSupported") ||
			!strings.Contains(got.Error(), redactedErrorDescription) ||
			strings.Contains(got.Error(), canary) {
			t.Fatalf("CallError was not normalized: %q", got)
		}
	}
}

func TestJournalOverflowCreatesRestartSafeCloudGap(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	j, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC)
	for i := 0; i < journalMaxEvents+1; i++ {
		j.append(ProtocolEvent{SchemaVersion: "1.0",
			EventID:       fmt.Sprintf("00000000-0000-4000-8000-%012d", i),
			OccurredAt:    base.Add(time.Duration(i) * time.Second).Format(time.RFC3339Nano),
			ChargePointID: "CP-OVERFLOW", Direction: "station_to_csms",
			MessageType: "Call", CorrelationID: fmt.Sprint(i), Action: "Heartbeat",
			Payload: json.RawMessage(`{}`)})
	}
	raw1, token1, ok := j.Next()
	if !ok {
		t.Fatal("overflow produced no cloud-visible gap")
	}
	var gap ProtocolEvent
	if err := json.Unmarshal(raw1, &gap); err != nil {
		t.Fatal(err)
	}
	if gap.Action != "JournalGap" || gap.MessageType != "Event" {
		t.Fatalf("first upload is not a gap: %+v", gap)
	}
	var payload struct {
		Dropped uint64            `json:"dropped_count"`
		Total   uint64            `json:"total_dropped"`
		First   string            `json:"first_event_id"`
		Last    string            `json:"last_event_id"`
		Reasons map[string]uint64 `json:"reasons"`
	}
	if err := json.Unmarshal(gap.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Dropped != 1 || payload.Total != 1 || payload.First != "00000000-0000-4000-8000-000000000000" ||
		payload.Last != payload.First || payload.Reasons["capacity_overflow"] != 1 {
		t.Fatalf("wrong overflow range/count: %+v", payload)
	}

	// Restart before QoS1 ACK: same event id, timestamp, bytes and token are
	// uploaded again, so the cloud's idempotent key works.
	restarted, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	raw2, token2, ok := restarted.Next()
	if !ok || token1 != token2 || string(raw1) != string(raw2) {
		t.Fatalf("gap did not survive restart unchanged: %q/%q", token1, token2)
	}
	if err := restarted.Ack(token2); err != nil {
		t.Fatal(err)
	}
	regular, _, ok := restarted.Next()
	var retained ProtocolEvent
	if !ok || json.Unmarshal(regular, &retained) != nil ||
		retained.EventID != "00000000-0000-4000-8000-000000000001" {
		t.Fatalf("oldest dropped event survived or retained events disappeared: %+v", retained)
	}
}

func TestJournalWriteAndCommitFailuresBecomeDurableGaps(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	j, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	event := func(id string) ProtocolEvent {
		return ProtocolEvent{SchemaVersion: "1.0", EventID: id,
			OccurredAt: "2026-08-25T06:30:00Z", ChargePointID: "CP-FAIL",
			Direction: "internal", MessageType: "Event", Action: "Connected",
			Payload: json.RawMessage(`{}`)}
	}
	j.writeEventFile = func(string, []byte, os.FileMode) error { return errors.New("disk full") }
	j.append(event("10000000-0000-4000-8000-000000000001"))
	j.writeEventFile = os.WriteFile
	j.renameEventFile = func(string, string) error { return errors.New("commit failed") }
	j.append(event("10000000-0000-4000-8000-000000000002"))
	j.renameEventFile = os.Rename
	bad := event("10000000-0000-4000-8000-000000000003")
	bad.Payload = json.RawMessage(`{`)
	j.append(bad)

	restarted, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	raw, _, ok := restarted.Next()
	if !ok {
		t.Fatal("write failures left no durable gap")
	}
	var gap ProtocolEvent
	if err := json.Unmarshal(raw, &gap); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Dropped uint64            `json:"dropped_count"`
		Total   uint64            `json:"total_dropped"`
		Reasons map[string]uint64 `json:"reasons"`
	}
	if err := json.Unmarshal(gap.Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Dropped != 3 || payload.Total != 3 || payload.Reasons["write_failure"] != 1 ||
		payload.Reasons["commit_failure"] != 1 || payload.Reasons["encode_failure"] != 1 {
		t.Fatalf("failed writes not represented exactly: %+v", payload)
	}
}

func TestJournalPurgeRemovesOldEventsAndGapMetadataWithoutInventingADrop(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	j, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	watermark := time.Date(2026, 8, 25, 7, 0, 0, 0, time.UTC)
	event := func(id string, at time.Time) ProtocolEvent {
		return ProtocolEvent{SchemaVersion: "1.0", EventID: id,
			OccurredAt: at.Format(time.RFC3339Nano), ChargePointID: "CP-PURGE",
			Direction: "internal", MessageType: "Event", Action: "Connected",
			Payload: json.RawMessage(`{}`)}
	}

	// A pre-watermark write failure has durable gap metadata, just like a
	// successfully-spooled old event. Neither may be uploaded after erasure.
	j.writeEventFile = func(string, []byte, os.FileMode) error { return errors.New("old disk failure") }
	j.append(event("20000000-0000-4000-8000-000000000001", watermark.Add(-2*time.Minute)))
	j.writeEventFile = os.WriteFile
	j.append(event("20000000-0000-4000-8000-000000000002", watermark))
	j.append(event("20000000-0000-4000-8000-000000000003", watermark.Add(time.Second)))

	if err := j.PurgeThrough(watermark); err != nil {
		t.Fatal(err)
	}
	raw, token, ok := j.Next()
	if !ok {
		t.Fatal("post-watermark event was purged")
	}
	var kept ProtocolEvent
	if json.Unmarshal(raw, &kept) != nil || kept.EventID != "20000000-0000-4000-8000-000000000003" {
		t.Fatalf("old event/gap survived purge or new event disappeared: %+v token=%q", kept, token)
	}
	if strings.HasPrefix(token, journalGapTokenPrefix) {
		t.Fatalf("intentional purge invented a JournalGap: %q", token)
	}
}

func TestJournalPurgeConservativelyRemovesCorruptAndUnreadableBytes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		makeBroken func(*testing.T, *Journal, string)
	}{
		{name: "corrupt JSON", makeBroken: func(t *testing.T, _ *Journal, path string) {
			if err := os.WriteFile(path, []byte(`{"truncated":`), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "read error", makeBroken: func(t *testing.T, j *Journal, path string) {
			if err := os.WriteFile(path, []byte(`{"bytes":"must be erased"}`), 0o600); err != nil {
				t.Fatal(err)
			}
			j.readEventFile = func(got string) ([]byte, error) {
				if got == path {
					return nil, errors.New("injected read failure")
				}
				return os.ReadFile(got)
			}
		}},
		{name: "undecodable timestamp", makeBroken: func(t *testing.T, _ *Journal, path string) {
			if err := os.WriteFile(path, []byte(`{"occurred_at":"not-a-time"}`), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			j, err := newJournal(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(j.dir, "2026-08-25T06-00-00Z_30000000-0000-4000-8000-000000000001.json")
			tc.makeBroken(t, j, path)
			j.count++

			if err := j.PurgeThrough(time.Date(2026, 8, 25, 7, 0, 0, 0, time.UTC)); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("uninspectable journal bytes survived all-data purge: %v", err)
			}
		})
	}
}

func TestJournalPurgeRemovesCrashLeftTempAfterRestartWithoutTouchingForeignFiles(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	first, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	event := eventForPurge("60000000-0000-4000-8000-000000000001",
		time.Date(2026, 8, 25, 6, 0, 0, 123456789, time.UTC))
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	tempPath, finalPath := journalEventPaths(first.dir, event)
	// This is the exact append crash window: the privacy-safe bytes reached the
	// temp file, but the process died before rename could commit finalPath.
	if err := first.writeEventFile(tempPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	foreign := []string{
		filepath.Join(first.dir, ".operator-note.json.tmp"),
		filepath.Join(first.dir, ".2026-08-25T06-00-00Z_not-a-generated-event.json.tmp"),
		filepath.Join(first.dir, "2026-08-25T06-00-00Z_60000000-0000-4000-8000-000000000001.json.tmp"),
	}
	for _, path := range foreign {
		if err := os.WriteFile(path, []byte("must stay"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	matchingDirectory := filepath.Join(first.dir,
		".2026-08-25T06-00-00Z_60000000-0000-4000-8000-000000000002.json.tmp")
	if err := os.Mkdir(matchingDirectory, 0o700); err != nil {
		t.Fatal(err)
	}

	// Re-open the journal to model a full process restart. Purge must discover
	// temp bytes that were never part of the in-memory count or upload queue.
	restarted, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.PurgeThrough(time.Date(2026, 8, 25, 7, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tempPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("crash-left temp bytes survived restart purge: %v", err)
	}
	if _, err := os.Stat(finalPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uncommitted event unexpectedly produced a final file: %v", err)
	}
	for _, path := range append(foreign, matchingDirectory) {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("purge touched non-journal artifact %s: %v", filepath.Base(path), err)
		}
	}
	if key, err := os.ReadFile(filepath.Join(dir, journalKeyFile)); err != nil || len(key) != 32 {
		t.Fatalf("purge touched the journal privacy key: bytes=%d err=%v", len(key), err)
	}
}

func TestJournalCrashLeftTempRemoveFailureStaysRetryableAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	first, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	event := eventForPurge("70000000-0000-4000-8000-000000000001",
		time.Date(2026, 8, 25, 6, 0, 0, 0, time.UTC))
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	tempPath, _ := journalEventPaths(first.dir, event)
	if err := first.writeEventFile(tempPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	restarted, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	restarted.removeEventFile = func(path string) error {
		if path == tempPath {
			return errors.New("injected crash-temp remove failure")
		}
		return os.Remove(path)
	}
	watermark := time.Date(2026, 8, 25, 7, 0, 0, 0, time.UTC)
	if err := restarted.PurgeThrough(watermark); err == nil ||
		!strings.Contains(err.Error(), "crash-left OCPP journal temp artifact") {
		t.Fatalf("temp remove failure was not surfaced as retryable purge error: %v", err)
	}
	if _, err := os.Stat(tempPath); err != nil {
		t.Fatalf("failed temp removal did not remain retryable: %v", err)
	}

	// A second process with recovered storage sees the same artifact and erases
	// it under the still-pending all-data purge intent.
	retried, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	if err := retried.PurgeThrough(watermark); err != nil {
		t.Fatalf("restart retry after temp remove recovery: %v", err)
	}
	if _, err := os.Stat(tempPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("restart retry did not erase crash-left temp bytes: %v", err)
	}
}

func TestJournalPurgeRemoveAndGapStateFailuresStayRetryable(t *testing.T) {
	t.Run("remove failure", func(t *testing.T) {
		dir := t.TempDir()
		j, err := newJournal(dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		old := eventForPurge("40000000-0000-4000-8000-000000000001",
			time.Date(2026, 8, 25, 6, 0, 0, 0, time.UTC))
		j.append(old)
		files, _ := j.filesLocked()
		path := filepath.Join(j.dir, files[0])
		j.removeEventFile = func(got string) error {
			if got == path {
				return errors.New("injected remove failure")
			}
			return os.Remove(got)
		}
		watermark := time.Date(2026, 8, 25, 7, 0, 0, 0, time.UTC)
		if err := j.PurgeThrough(watermark); err == nil {
			t.Fatal("remove failure was reported as a successful purge")
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("failed removal must remain retryable: %v", err)
		}
		j.removeEventFile = os.Remove
		if err := j.PurgeThrough(watermark); err != nil {
			t.Fatalf("retry after remove recovery: %v", err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("retry did not erase old event: %v", err)
		}
	})

	t.Run("gap-state commit failure", func(t *testing.T) {
		dir := t.TempDir()
		log := slog.New(slog.NewTextHandler(io.Discard, nil))
		j, err := newJournal(dir, log)
		if err != nil {
			t.Fatal(err)
		}
		old := eventForPurge("50000000-0000-4000-8000-000000000001",
			time.Date(2026, 8, 25, 6, 0, 0, 0, time.UTC))
		j.writeEventFile = func(string, []byte, os.FileMode) error { return errors.New("drop") }
		j.append(old)
		j.writeEventFile = os.WriteFile
		j.renameGapFile = func(string, string) error { return errors.New("injected gap-state failure") }
		watermark := time.Date(2026, 8, 25, 7, 0, 0, 0, time.UTC)
		if err := j.PurgeThrough(watermark); err == nil {
			t.Fatal("gap-state failure was reported as a successful purge")
		}

		// The failed commit left the old durable ledger intact. A restart sees
		// it and can retry the same intentional erasure once storage recovers.
		restarted, err := newJournal(dir, log)
		if err != nil {
			t.Fatal(err)
		}
		if raw, _, ok := restarted.Next(); !ok || !strings.Contains(string(raw), `"action":"JournalGap"`) {
			t.Fatal("failed gap-state purge did not remain durable/retryable")
		}
		if err := restarted.PurgeThrough(watermark); err != nil {
			t.Fatalf("gap-state retry failed: %v", err)
		}
		if _, _, ok := restarted.Next(); ok {
			t.Fatal("old gap metadata survived successful retry")
		}
	})
}

func eventForPurge(id string, at time.Time) ProtocolEvent {
	return ProtocolEvent{SchemaVersion: "1.0", EventID: id,
		OccurredAt: at.Format(time.RFC3339Nano), ChargePointID: "CP-PURGE-FAILURE",
		Direction: "internal", MessageType: "Event", Action: "Connected",
		Payload: json.RawMessage(`{}`)}
}

func TestProtocolJournalSurvivesRestartUntilAcknowledged(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	first, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	first.RecordConnection("CP-1", "Connected", firstTime())
	raw1, token1, ok := first.Next()
	if !ok {
		t.Fatal("event was not queued")
	}

	second, err := newJournal(dir, log)
	if err != nil {
		t.Fatal(err)
	}
	raw2, token2, ok := second.Next()
	if !ok || token1 != token2 || string(raw1) != string(raw2) {
		t.Fatalf("restart changed durable event: %q/%q", token1, token2)
	}
	if err := second.Ack(token2); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := second.Next(); ok {
		t.Fatal("acknowledged event remained queued")
	}
}

func firstTime() time.Time { return time.Unix(1, 0).UTC() }
