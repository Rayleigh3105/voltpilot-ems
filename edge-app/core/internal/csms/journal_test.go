package csms

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	j.RecordWire("station_to_csms", "CP-1", []byte(`[4,"missing","NotSupported","nope",{"idTag":"another-clear-tag"}]`))

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

	all, err := os.ReadFile(filepath.Join(dir, journalKeyFile))
	if err != nil || len(all) != 32 {
		t.Fatalf("privacy key: bytes=%d err=%v", len(all), err)
	}
	encoded, _ := json.Marshal(events)
	got := string(encoded)
	for _, secret := range []string{"clear-rfid", "clear-parent", "another-clear-tag", "super-secret"} {
		if strings.Contains(got, secret) {
			t.Fatalf("secret %q reached journal: %s", secret, got)
		}
	}
	if !strings.Contains(got, "tagref_") || !strings.Contains(got, `"redacted":true`) ||
		!strings.Contains(got, "RigVendor.Mode") {
		t.Fatalf("masked refs/redaction/vendor key missing: %s", got)
	}
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
