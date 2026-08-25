package csms

// The durable OCPP protocol journal. It sits BELOW the OCPP library at the
// websocket boundary, so it sees every CALL, CALLRESULT and CALLERROR in both
// directions — including malformed/unsupported requests the typed handlers
// never receive. The journal is visibility only: recording can never change a
// protocol answer and it exposes no station command method.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	journalDirectory = "ocpp-journal"
	journalKeyFile   = "ocpp-privacy.key"
	journalMaxEvents = 10000
	journalMaxWire   = 1024 * 1024
)

// ProtocolEvent is the privacy-safe envelope queued on disk. Tenant/site/
// device identity is added by the enrolled cloud link at publish time.
type ProtocolEvent struct {
	SchemaVersion    string          `json:"schema_version"`
	EventID          string          `json:"event_id"`
	OccurredAt       string          `json:"occurred_at"`
	ChargePointID    string          `json:"charge_point_id"`
	Direction        string          `json:"direction"`
	MessageType      string          `json:"message_type"`
	CorrelationID    string          `json:"correlation_id,omitempty"`
	Action           string          `json:"action"`
	ErrorCode        string          `json:"error_code,omitempty"`
	ErrorDescription string          `json:"error_description,omitempty"`
	ErrorDetails     json.RawMessage `json:"error_details,omitempty"`
	Payload          json.RawMessage `json:"payload"`
}

// Journal is a bounded, crash-safe spool: one atomically-renamed file per
// event. A QoS1 cloud ACK removes exactly that file. Rewriting one ever-growing
// JSON array for every 10-second MeterValues report would punish the edge disk;
// small immutable files keep append and ACK O(1).
type Journal struct {
	dir     string
	key     []byte
	log     *slog.Logger
	mu      sync.Mutex
	closed  bool
	count   int
	changed chan struct{}
	// pending action maps make CALLRESULT/CALLERROR self-describing. OCPP gives
	// those messages only a unique id; the action belongs to the paired CALL.
	incoming map[string]string
	outgoing map[string]string
}

func newJournal(dataDir string, log *slog.Logger) (*Journal, error) {
	dir := filepath.Join(dataDir, journalDirectory)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key, err := loadOrCreatePrivacyKey(filepath.Join(dataDir, journalKeyFile))
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			count++
		}
	}
	return &Journal{dir: dir, key: key, log: log, changed: make(chan struct{}, 1),
		count: count, incoming: map[string]string{}, outgoing: map[string]string{}}, nil
}

func loadOrCreatePrivacyKey(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil {
		if len(b) != 32 {
			return nil, fmt.Errorf("OCPP privacy key has %d bytes, want 32", len(b))
		}
		return b, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	b = make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return b, nil
}

// RecordWire parses the OCPP-J array only far enough to identify and redact
// it. Unknown valid payload fields are retained; we never re-interpret vendor
// text. Invalid bytes are represented as a bounded parse_error event, not
// copied into logs where credentials could escape.
func (j *Journal) RecordWire(direction, chargePointID string, raw []byte) {
	e := ProtocolEvent{SchemaVersion: "1.0", EventID: newEventID(),
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), ChargePointID: chargePointID,
		Direction: direction, Action: "Unknown", Payload: json.RawMessage(`{}`)}
	if len(raw) > journalMaxWire {
		e.MessageType = "Event"
		e.Action = "OversizeMessageRejected"
		e.Payload = mustJSON(map[string]any{"bytes": len(raw), "payload": "[redacted]"})
		j.append(e)
		return
	}
	var msg []json.RawMessage
	if err := json.Unmarshal(raw, &msg); err != nil || len(msg) < 2 {
		e.MessageType = "Event"
		e.Action = "MalformedMessage"
		e.Payload = mustJSON(map[string]any{"payload": "[redacted]"})
		j.append(e)
		return
	}
	var kind int
	_ = json.Unmarshal(msg[0], &kind)
	_ = json.Unmarshal(msg[1], &e.CorrelationID)
	key := chargePointID + "\x00" + e.CorrelationID

	switch kind {
	case 2: // CALL
		e.MessageType = "Call"
		if len(msg) >= 3 {
			_ = json.Unmarshal(msg[2], &e.Action)
		}
		if len(msg) >= 4 {
			e.Payload = j.redact(msg[3], e.Action)
		}
		j.mu.Lock()
		if direction == "station_to_csms" {
			j.incoming[key] = e.Action
		} else {
			j.outgoing[key] = e.Action
		}
		j.mu.Unlock()
	case 3: // CALLRESULT
		e.MessageType = "CallResult"
		e.Action = j.takeAction(direction, key)
		if len(msg) >= 3 {
			e.Payload = j.redact(msg[2], e.Action)
		}
	case 4: // CALLERROR
		e.MessageType = "CallError"
		e.Action = j.takeAction(direction, key)
		if len(msg) >= 3 {
			_ = json.Unmarshal(msg[2], &e.ErrorCode)
		}
		if len(msg) >= 4 {
			_ = json.Unmarshal(msg[3], &e.ErrorDescription)
		}
		if len(msg) >= 5 {
			e.ErrorDetails = j.redact(msg[4], e.Action)
		}
	default:
		e.MessageType = "Event"
		e.Action = "UnknownMessageType"
	}
	j.append(e)
}

func (j *Journal) takeAction(direction, key string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	m := j.outgoing
	if direction == "csms_to_station" {
		m = j.incoming
	}
	action := m[key]
	delete(m, key)
	if action == "" {
		return "Unknown"
	}
	return action
}

func (j *Journal) RecordConnection(chargePointID, action string, at time.Time) {
	j.append(ProtocolEvent{SchemaVersion: "1.0", EventID: newEventID(),
		OccurredAt: at.UTC().Format(time.RFC3339Nano), ChargePointID: chargePointID,
		Direction: "internal", MessageType: "Event", Action: action,
		Payload: json.RawMessage(`{}`)})
}

// redact applies the privacy boundary BEFORE bytes reach disk. idTags become a
// stable per-edge HMAC reference; URLs, AuthorizationKey and untyped vendor
// DataTransfer data never enter the journal in clear text.
func (j *Journal) redact(raw json.RawMessage, action string) json.RawMessage {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return json.RawMessage(`{"payload":"[redacted]"}`)
	}
	v = j.redactValue(v, "", action)
	return mustJSON(v)
}

func (j *Journal) redactValue(v any, field, action string) any {
	switch x := v.(type) {
	case map[string]any:
		configurationSecret := false
		if key, ok := x["key"].(string); ok {
			configurationSecret = secretConfigurationKey(key)
		}
		out := make(map[string]any, len(x)+1)
		for k, value := range x {
			lk := strings.ToLower(k)
			switch {
			case lk == "idtag" || lk == "parentidtag":
				if s, ok := value.(string); ok && s != "" {
					out[k] = j.tagRef(s)
				} else {
					out[k] = value
				}
			case secretField(lk) || (configurationSecret && lk == "value"):
				out[k] = nil
				out["redacted"] = true
			case (action == "GetDiagnostics" || action == "UpdateFirmware") && lk == "location":
				out[k] = redactURL(value)
			case action == "DataTransfer" && lk == "data":
				out[k] = "[redacted-untyped-vendor-data]"
			default:
				out[k] = j.redactValue(value, k, action)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i := range x {
			out[i] = j.redactValue(x[i], field, action)
		}
		return out
	default:
		return v
	}
}

func secretConfigurationKey(key string) bool {
	n := strings.NewReplacer("_", "", "-", "").Replace(strings.ToLower(key))
	return n == "authorizationkey" || strings.Contains(n, "password") ||
		strings.Contains(n, "passwd") || strings.Contains(n, "secret") ||
		strings.Contains(n, "accesstoken") || strings.Contains(n, "refreshtoken") ||
		strings.Contains(n, "credential") || strings.Contains(n, "privatekey") ||
		strings.Contains(n, "clientkey") || strings.Contains(n, "apikey")
}

func secretField(key string) bool { return secretConfigurationKey(key) }

func redactURL(v any) any {
	s, ok := v.(string)
	if !ok || s == "" {
		return v
	}
	u, err := url.Parse(s)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "[redacted-url]"
	}
	return u.Scheme + "://" + u.Host + "/[redacted]"
}

func (j *Journal) tagRef(value string) string {
	h := hmac.New(sha256.New, j.key)
	_, _ = h.Write([]byte(value))
	return "tagref_" + hex.EncodeToString(h.Sum(nil))[:24]
}

func (j *Journal) append(e ProtocolEvent) {
	raw, err := json.Marshal(e)
	if err != nil {
		j.log.Error("OCPP journal event could not be encoded", "err", err)
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return
	}
	name := strings.ReplaceAll(e.OccurredAt, ":", "-") + "_" + e.EventID + ".json"
	tmp := filepath.Join(j.dir, "."+name+".tmp")
	final := filepath.Join(j.dir, name)
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		j.log.Error("OCPP journal event could not be persisted", "err", err)
		return
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		j.log.Error("OCPP journal event could not be committed", "err", err)
		return
	}
	j.count++
	j.enforceBoundLocked()
	select {
	case j.changed <- struct{}{}:
	default:
	}
}

// Close forms the lifecycle barrier between the websocket goroutines and the
// data directory. ocpp-go may deliver a final disconnect callback while Stop
// is unwinding; after Close returns no callback can recreate a journal file.
func (j *Journal) Close() {
	j.mu.Lock()
	j.closed = true
	j.mu.Unlock()
}

func (j *Journal) enforceBoundLocked() {
	// Avoid an O(n) directory scan on every 10-second MeterValues event. The
	// count is established once at startup and maintained under the same lock.
	if j.count <= journalMaxEvents {
		return
	}
	files, err := j.filesLocked()
	if err != nil || len(files) <= journalMaxEvents {
		return
	}
	drop := len(files) - journalMaxEvents
	for _, name := range files[:drop] {
		if os.Remove(filepath.Join(j.dir, name)) == nil {
			j.count--
		}
	}
	j.log.Error("OCPP journal capacity exceeded; oldest events dropped", "dropped", drop)
}

func (j *Journal) filesLocked() ([]string, error) {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}

// Next returns the oldest durable event and an opaque ack token.
func (j *Journal) Next() ([]byte, string, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	files, err := j.filesLocked()
	if err != nil || len(files) == 0 {
		return nil, "", false
	}
	raw, err := os.ReadFile(filepath.Join(j.dir, files[0]))
	if err != nil {
		j.log.Error("OCPP journal event could not be read", "err", err)
		return nil, "", false
	}
	return raw, files[0], true
}

func (j *Journal) Ack(token string) error {
	if token == "" || filepath.Base(token) != token || !strings.HasSuffix(token, ".json") {
		return errors.New("invalid OCPP journal ack token")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	err := os.Remove(filepath.Join(j.dir, token))
	if err == nil && j.count > 0 {
		j.count--
	}
	return err
}

func (j *Journal) Changed() <-chan struct{} { return j.changed }

func newEventID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failure is already catastrophic for enrollment. Keep the
		// journal non-blocking but still syntactically valid and unique enough.
		n := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(n >> (i % 8 * 8))
		}
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
