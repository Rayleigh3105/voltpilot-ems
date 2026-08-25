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
	journalDirectory          = "ocpp-journal"
	journalKeyFile            = "ocpp-privacy.key"
	journalGapStateFile       = "ocpp-journal-gaps.json"
	journalFilenameTimeLayout = "2006-01-02T15-04-05.999999999Z"
	journalMaxEvents          = 10000
	journalMaxWire            = 1024 * 1024
	journalGapTokenPrefix     = "gap:"
	redactedErrorDescription  = "[redacted-call-error-description]"
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

// journalGapState is a second, tiny durable ledger beside the bounded event
// spool. A capacity eviction or failed event write must never disappear into a
// local log: the next cloud upload is a JournalGap event describing the exact
// affected event/time range and monotonically increasing total.
type journalGapState struct {
	SchemaVersion string       `json:"schema_version"`
	TotalDropped  uint64       `json:"total_dropped"`
	Pending       []journalGap `json:"pending,omitempty"`
}

type journalGap struct {
	EventID         string            `json:"event_id"`
	ReportedAt      string            `json:"reported_at"`
	DroppedCount    uint64            `json:"dropped_count"`
	TotalDropped    uint64            `json:"total_dropped"`
	FirstOccurredAt string            `json:"first_occurred_at"`
	LastOccurredAt  string            `json:"last_occurred_at"`
	FirstEventID    string            `json:"first_event_id"`
	LastEventID     string            `json:"last_event_id"`
	Reasons         map[string]uint64 `json:"reasons"`
	Sealed          bool              `json:"sealed"`
}

// Journal is a bounded, crash-safe spool: one atomically-renamed file per
// event. A QoS1 cloud ACK removes exactly that file. Rewriting one ever-growing
// JSON array for every 10-second MeterValues report would punish the edge disk;
// small immutable files keep append and ACK O(1).
type Journal struct {
	dir       string
	statePath string
	key       []byte
	log       *slog.Logger
	mu        sync.Mutex
	closed    bool
	count     int
	changed   chan struct{}
	// pending action maps make CALLRESULT/CALLERROR self-describing. OCPP gives
	// those messages only a unique id; the action belongs to the paired CALL.
	incoming         map[string]string
	outgoing         map[string]string
	externalOutgoing map[string][]string
	externalByWire   map[string]string
	gaps             journalGapState
	// Injectable only for deterministic failure-path tests. Gap-state writes
	// deliberately use the real filesystem, so an event-write failure can still
	// leave durable evidence.
	writeEventFile  func(string, []byte, os.FileMode) error
	renameEventFile func(string, string) error
	readEventFile   func(string) ([]byte, error)
	removeEventFile func(string) error
	writeGapFile    func(string, []byte, os.FileMode) error
	renameGapFile   func(string, string) error
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
	statePath := filepath.Join(dataDir, journalGapStateFile)
	gaps, err := loadJournalGapState(statePath)
	if err != nil {
		return nil, err
	}
	j := &Journal{dir: dir, statePath: statePath, key: key, log: log,
		changed: make(chan struct{}, 1), count: count,
		incoming: map[string]string{}, outgoing: map[string]string{}, gaps: gaps,
		externalOutgoing: map[string][]string{}, externalByWire: map[string]string{},
		writeEventFile: os.WriteFile, renameEventFile: os.Rename,
		readEventFile: os.ReadFile, removeEventFile: os.Remove,
		writeGapFile: os.WriteFile, renameGapFile: os.Rename}
	// Enforce the bound on restart too. A process may have died after the final
	// rename but before the preceding instance could evict.
	j.mu.Lock()
	j.enforceBoundLocked()
	j.mu.Unlock()
	return j, nil
}

func loadJournalGapState(path string) (journalGapState, error) {
	state := journalGapState{SchemaVersion: "1.0"}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, fmt.Errorf("OCPP journal gap state: %w", err)
	}
	if state.SchemaVersion != "1.0" {
		return state, fmt.Errorf("OCPP journal gap state schema %q, want 1.0", state.SchemaVersion)
	}
	for i := range state.Pending {
		if state.Pending[i].EventID == "" || state.Pending[i].DroppedCount == 0 {
			return state, errors.New("OCPP journal gap state contains an invalid pending gap")
		}
		if state.Pending[i].Reasons == nil {
			state.Pending[i].Reasons = map[string]uint64{"unknown": state.Pending[i].DroppedCount}
		}
	}
	return state, nil
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
			queueKey := chargePointID + "\x00" + e.Action
			if queued := j.externalOutgoing[queueKey]; len(queued) > 0 {
				e.CorrelationID = queued[0]
				j.externalOutgoing[queueKey] = queued[1:]
				j.externalByWire[key] = e.CorrelationID
			}
		}
		j.mu.Unlock()
	case 3: // CALLRESULT
		e.MessageType = "CallResult"
		e.Action = j.takeAction(direction, key)
		if direction == "station_to_csms" {
			e.CorrelationID = j.externalCorrelation(key)
		}
		if len(msg) >= 3 {
			e.Payload = j.redact(msg[2], e.Action)
		}
	case 4: // CALLERROR
		e.MessageType = "CallError"
		e.Action = j.takeAction(direction, key)
		if direction == "station_to_csms" {
			e.CorrelationID = j.externalCorrelation(key)
		}
		if len(msg) >= 3 {
			_ = json.Unmarshal(msg[2], &e.ErrorCode)
		}
		if len(msg) >= 4 {
			var description string
			if json.Unmarshal(msg[3], &description) == nil && strings.TrimSpace(description) != "" {
				// Free station/vendor prose has no parseable structure and may
				// contain AuthorizationKey, URL tokens, idTags or arbitrary
				// secret fields. Preserve presence only, before the first disk write.
				e.ErrorDescription = redactedErrorDescription
			}
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

// BindOutgoing associates the API's durable correlation with the next wire
// CALL of this action. The OCPP library owns the wire message id; keeping this
// tiny adapter here lets late CallResult/CallError evidence close the right
// cloud action without leaking an implementation id into the API contract.
func (j *Journal) BindOutgoing(chargePointID, action, correlation string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	key := chargePointID + "\x00" + action
	j.externalOutgoing[key] = append(j.externalOutgoing[key], correlation)
}

func (j *Journal) externalCorrelation(key string) string {
	j.mu.Lock()
	defer j.mu.Unlock()
	correlation := j.externalByWire[key]
	delete(j.externalByWire, key)
	return correlation
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
		j.recordDrop(e, "encode_failure")
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return
	}
	tmp, final := journalEventPaths(j.dir, e)
	if err := j.writeEventFile(tmp, raw, 0o600); err != nil {
		j.log.Error("OCPP journal event could not be persisted", "err", err)
		j.recordDropLocked(e, "write_failure")
		return
	}
	if err := j.renameEventFile(tmp, final); err != nil {
		_ = os.Remove(tmp)
		j.log.Error("OCPP journal event could not be committed", "err", err)
		j.recordDropLocked(e, "commit_failure")
		return
	}
	j.count++
	j.enforceBoundLocked()
	select {
	case j.changed <- struct{}{}:
	default:
	}
}

func journalEventPaths(dir string, event ProtocolEvent) (tmp, final string) {
	name := strings.ReplaceAll(event.OccurredAt, ":", "-") + "_" + event.EventID + ".json"
	return filepath.Join(dir, "."+name+".tmp"), filepath.Join(dir, name)
}

func (j *Journal) recordDrop(e ProtocolEvent, reason string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.closed {
		return
	}
	j.recordDropLocked(e, reason)
}

func (j *Journal) recordDropLocked(e ProtocolEvent, reason string) {
	j.gaps.TotalDropped++
	var gap *journalGap
	if n := len(j.gaps.Pending); n > 0 && !j.gaps.Pending[n-1].Sealed {
		gap = &j.gaps.Pending[n-1]
	} else {
		j.gaps.Pending = append(j.gaps.Pending, journalGap{
			EventID: newEventID(), ReportedAt: time.Now().UTC().Format(time.RFC3339Nano),
			FirstOccurredAt: e.OccurredAt,
			FirstEventID:    e.EventID, Reasons: map[string]uint64{},
		})
		gap = &j.gaps.Pending[len(j.gaps.Pending)-1]
	}
	gap.DroppedCount++
	gap.TotalDropped = j.gaps.TotalDropped
	if gap.FirstOccurredAt == "" {
		gap.FirstOccurredAt = e.OccurredAt
	}
	if gap.FirstEventID == "" {
		gap.FirstEventID = e.EventID
	}
	gap.LastOccurredAt = e.OccurredAt
	gap.LastEventID = e.EventID
	gap.Reasons[reason]++
	if err := j.persistGapStateLocked(); err != nil {
		// Memory retains the evidence and every later append/Next retries it.
		// A machine-wide disk failure cannot be made writable by application
		// code, but it is never misreported as success.
		j.log.Error("OCPP journal data-loss evidence could not be persisted", "err", err,
			"total_dropped", j.gaps.TotalDropped)
	}
	j.signalChangedLocked()
}

func (j *Journal) persistGapStateLocked() error {
	raw, err := json.Marshal(j.gaps)
	if err != nil {
		return err
	}
	tmp := j.statePath + ".tmp"
	if err := j.writeGapFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := j.renameGapFile(tmp, j.statePath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (j *Journal) signalChangedLocked() {
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
	dropped := 0
	for _, name := range files[:drop] {
		e := ProtocolEvent{SchemaVersion: "1.0", EventID: eventIDFromJournalName(name),
			OccurredAt: time.Now().UTC().Format(time.RFC3339Nano), Action: "Unknown",
			MessageType: "Event", Direction: "internal", Payload: json.RawMessage(`{}`)}
		if raw, readErr := j.readEventFile(filepath.Join(j.dir, name)); readErr == nil {
			_ = json.Unmarshal(raw, &e)
		}
		if j.removeEventFile(filepath.Join(j.dir, name)) == nil {
			j.count--
			dropped++
			j.recordDropLocked(e, "capacity_overflow")
		}
	}
	if dropped > 0 {
		j.log.Error("OCPP journal capacity exceeded; oldest events dropped",
			"dropped", dropped, "total_dropped", j.gaps.TotalDropped)
	}
}

func eventIDFromJournalName(name string) string {
	base := strings.TrimSuffix(name, ".json")
	if len(base) >= 36 {
		return base[len(base)-36:]
	}
	return "unknown"
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

// tempArtifactsLocked inventories only files append() itself can leave between
// the durable temp write and its atomic rename. The strict UTC timestamp + v4
// UUID shape prevents an all-data purge from treating unrelated dotfiles,
// privacy keys, directories or symlinks as journal data.
func (j *Journal) tempArtifactsLocked() ([]string, error) {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return nil, err
	}
	files := make([]string, 0)
	for _, entry := range entries {
		if entry.Type().IsRegular() && isJournalTempArtifact(entry.Name()) {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}

func isJournalTempArtifact(name string) bool {
	if !strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".json.tmp") {
		return false
	}
	finalName := strings.TrimSuffix(strings.TrimPrefix(name, "."), ".tmp")
	stem := strings.TrimSuffix(finalName, ".json")
	if len(stem) <= 37 || stem[len(stem)-37] != '_' {
		return false
	}
	timestamp, eventID := stem[:len(stem)-37], stem[len(stem)-36:]
	if _, err := time.Parse(journalFilenameTimeLayout, timestamp); err != nil {
		return false
	}
	return isGeneratedEventID(eventID)
}

func isGeneratedEventID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' ||
		id[14] != '4' || !strings.ContainsRune("89ab", rune(id[19])) {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", c) {
			return false
		}
	}
	return true
}

// Next returns the oldest durable event and an opaque ack token.
func (j *Journal) Next() ([]byte, string, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if len(j.gaps.Pending) > 0 {
		gap := &j.gaps.Pending[0]
		if !gap.Sealed {
			gap.Sealed = true
			if err := j.persistGapStateLocked(); err != nil {
				j.log.Error("OCPP journal gap seal could not be persisted", "err", err)
			}
		}
		payload := mustJSON(map[string]any{
			"dropped_count": gap.DroppedCount, "total_dropped": gap.TotalDropped,
			"first_occurred_at": gap.FirstOccurredAt, "last_occurred_at": gap.LastOccurredAt,
			"first_event_id": gap.FirstEventID, "last_event_id": gap.LastEventID,
			"reasons": gap.Reasons,
		})
		e := ProtocolEvent{SchemaVersion: "1.0", EventID: gap.EventID,
			OccurredAt: gap.ReportedAt, ChargePointID: "edge-journal",
			Direction: "internal", MessageType: "Event", Action: "JournalGap", Payload: payload}
		raw, err := json.Marshal(e)
		if err != nil {
			j.log.Error("OCPP journal gap could not be encoded", "err", err)
			return nil, "", false
		}
		return raw, journalGapTokenPrefix + gap.EventID, true
	}
	files, err := j.filesLocked()
	if err != nil || len(files) == 0 {
		return nil, "", false
	}
	raw, err := j.readEventFile(filepath.Join(j.dir, files[0]))
	if err != nil {
		j.log.Error("OCPP journal event could not be read", "err", err)
		return nil, "", false
	}
	var event ProtocolEvent
	if json.Unmarshal(raw, &event) != nil || event.EventID == "" {
		// A torn/corrupt file would otherwise block the oldest-first uploader
		// forever. Remove it only together with a durable gap proof.
		if j.removeEventFile(filepath.Join(j.dir, files[0])) == nil {
			if j.count > 0 {
				j.count--
			}
			j.recordDropLocked(ProtocolEvent{EventID: eventIDFromJournalName(files[0]),
				OccurredAt: time.Now().UTC().Format(time.RFC3339Nano)}, "corrupt_event")
		}
		return j.nextLockedAfterRepair()
	}
	return raw, files[0], true
}

func (j *Journal) nextLockedAfterRepair() ([]byte, string, bool) {
	if len(j.gaps.Pending) == 0 {
		return nil, "", false
	}
	gap := &j.gaps.Pending[0]
	gap.Sealed = true
	_ = j.persistGapStateLocked()
	e := ProtocolEvent{SchemaVersion: "1.0", EventID: gap.EventID,
		OccurredAt: gap.ReportedAt, ChargePointID: "edge-journal",
		Direction: "internal", MessageType: "Event", Action: "JournalGap",
		Payload: mustJSON(map[string]any{
			"dropped_count": gap.DroppedCount, "total_dropped": gap.TotalDropped,
			"first_occurred_at": gap.FirstOccurredAt, "last_occurred_at": gap.LastOccurredAt,
			"first_event_id": gap.FirstEventID, "last_event_id": gap.LastEventID,
			"reasons": gap.Reasons,
		})}
	raw, err := json.Marshal(e)
	return raw, journalGapTokenPrefix + gap.EventID, err == nil
}

func (j *Journal) Ack(token string) error {
	if strings.HasPrefix(token, journalGapTokenPrefix) {
		id := strings.TrimPrefix(token, journalGapTokenPrefix)
		if id == "" || strings.ContainsAny(id, `/\\`) {
			return errors.New("invalid OCPP journal gap ack token")
		}
		j.mu.Lock()
		defer j.mu.Unlock()
		if len(j.gaps.Pending) == 0 || j.gaps.Pending[0].EventID != id {
			return errors.New("unknown OCPP journal gap ack token")
		}
		acknowledged := j.gaps.Pending[0]
		j.gaps.Pending = append([]journalGap(nil), j.gaps.Pending[1:]...)
		if err := j.persistGapStateLocked(); err != nil {
			j.gaps.Pending = append([]journalGap{acknowledged}, j.gaps.Pending...)
			return err
		}
		return nil
	}
	if token == "" || filepath.Base(token) != token || !strings.HasSuffix(token, ".json") {
		return errors.New("invalid OCPP journal ack token")
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	err := j.removeEventFile(filepath.Join(j.dir, token))
	if err == nil && j.count > 0 {
		j.count--
	}
	return err
}

// PurgeThrough is the OCPP counterpart of telemetry/history PurgeThrough. It
// is invoked by both local and cloud purge flows before replay can run. This is
// intentional erasure, so it does not create a data-loss gap. The monotonic
// all-time counter remains; pending gap events wholly inside the erased range
// are removed so the purge cannot re-upload old OCPP metadata afterwards.
func (j *Journal) PurgeThrough(watermark time.Time) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	tempArtifacts, err := j.tempArtifactsLocked()
	if err != nil {
		return err
	}
	// A crash between append's temp write and rename leaves bytes without a
	// trustworthy committed timestamp. After restart they necessarily predate
	// this purge invocation, so erase every exact journal temp artifact. A
	// failed removal is returned before the durable purge intent can be cleared;
	// the same artifact remains present for the startup/reconnect retry.
	for _, name := range tempArtifacts {
		if removeErr := j.removeEventFile(filepath.Join(j.dir, name)); removeErr != nil {
			return fmt.Errorf("remove crash-left OCPP journal temp artifact %s: %w", name, removeErr)
		}
	}
	files, err := j.filesLocked()
	if err != nil {
		return err
	}
	for _, name := range files {
		path := filepath.Join(j.dir, name)
		raw, readErr := j.readEventFile(path)
		if readErr != nil {
			// This is an explicit all-recordings erasure. If bytes cannot be
			// inspected, retaining them would turn an I/O/permission fault into
			// a privacy bypass. Conservatively remove the whole immutable event;
			// only a failed remove remains a retryable purge error.
			if removeErr := j.removeEventFile(path); removeErr != nil {
				return fmt.Errorf("remove unreadable OCPP journal event %s: %w", name, removeErr)
			}
			if j.count > 0 {
				j.count--
			}
			continue
		}
		var event ProtocolEvent
		if json.Unmarshal(raw, &event) != nil {
			// Corrupt/undecodable bytes have no trustworthy timestamp. An
			// all-data purge must erase them, never report a successful skip.
			if removeErr := j.removeEventFile(path); removeErr != nil {
				return fmt.Errorf("remove corrupt OCPP journal event %s: %w", name, removeErr)
			}
			if j.count > 0 {
				j.count--
			}
			continue
		}
		at, parseErr := time.Parse(time.RFC3339Nano, event.OccurredAt)
		if parseErr != nil {
			// Syntactically valid JSON with no trustworthy time is still an
			// undecodable recording. It cannot safely be classified as newer.
			if removeErr := j.removeEventFile(path); removeErr != nil {
				return fmt.Errorf("remove timestamp-less OCPP journal event %s: %w", name, removeErr)
			}
			if j.count > 0 {
				j.count--
			}
			continue
		}
		if !at.After(watermark) {
			if removeErr := j.removeEventFile(path); removeErr != nil {
				return removeErr
			}
			if j.count > 0 {
				j.count--
			}
		}
	}
	kept := j.gaps.Pending[:0]
	for _, gap := range j.gaps.Pending {
		last, parseErr := time.Parse(time.RFC3339Nano, gap.LastOccurredAt)
		if parseErr != nil || last.After(watermark) {
			kept = append(kept, gap)
		}
	}
	j.gaps.Pending = kept
	return j.persistGapStateLocked()
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
