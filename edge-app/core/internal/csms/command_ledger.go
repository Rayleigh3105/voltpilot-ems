package csms

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const commandLedgerFile = "ocpp-command-ledger.json"
const commandLedgerLimit = 4096
const commandLedgerLateResponseRetention = 24 * time.Hour

var errCommandLedgerCapacity = errors.New("OCPP-Befehlsledger ist mit noch gültigen Einträgen ausgelastet")

// ErrCommandStorage marks a pre-station persistence failure. Callers must not
// turn it into a terminal business result or acknowledge the MQTT command: no
// durable at-most-once decision exists yet, so redelivery remains authoritative.
var ErrCommandStorage = errors.New("OCPP-Befehl konnte nicht dauerhaft entschieden werden")

type commandLedgerEntry struct {
	ActionID            string    `json:"action_id"`
	Fingerprint         string    `json:"fingerprint"`
	State               string    `json:"state"`
	DeadlineAt          time.Time `json:"deadline_at"`
	UpdatedAt           time.Time `json:"updated_at"`
	Action              string    `json:"action"`
	WireAction          string    `json:"wire_action,omitempty"`
	ChargePointID       string    `json:"charge_point_id"`
	CorrelationID       string    `json:"correlation_id"`
	ConnectorID         *int      `json:"connector_id,omitempty"`
	ConfigurationKey    string    `json:"configuration_key,omitempty"`
	ReadbackWireID      string    `json:"readback_wire_id,omitempty"`
	ReadbackAction      string    `json:"readback_action,omitempty"`
	ReadbackCorrelation string    `json:"readback_correlation,omitempty"`
}

type commandWireMapping struct {
	ChargePointID string
	WireID        string
	WireAction    string
	CorrelationID string
	CallSeen      bool
}

type commandLedgerDocument struct {
	SchemaVersion      string               `json:"schema_version"`
	Entries            []commandLedgerEntry `json:"entries"`
	CapacityBlockUntil *time.Time           `json:"capacity_block_until,omitempty"`
}

// commandLedger is the durable at-most-once boundary. Claim is fsynced via an
// atomic rename before the first station byte is written. A crash may lose a
// command, but can never replay a physical action after restart.
type commandLedger struct {
	mu                 sync.Mutex
	path               string
	entries            map[string]commandLedgerEntry
	capacityBlockUntil time.Time
	// Test-only failure injection at the persistence boundary.
	beforeSave func() error
}

func newCommandLedger(dataDir string) (*commandLedger, error) {
	path := filepath.Join(dataDir, commandLedgerFile)
	l := &commandLedger{path: path, entries: map[string]commandLedgerEntry{}}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return l, nil
	}
	if err != nil {
		return nil, err
	}
	var doc commandLedgerDocument
	if json.Unmarshal(raw, &doc) != nil || doc.SchemaVersion != "1.0" {
		return nil, errors.New("OCPP command ledger beschädigt")
	}
	for _, e := range doc.Entries {
		l.entries[e.ActionID] = e
	}
	if doc.CapacityBlockUntil != nil {
		l.capacityBlockUntil = doc.CapacityBlockUntil.UTC()
	}
	return l, nil
}

// claim returns duplicate=true only for a byte-identical replay. Reusing an
// action id for changed bytes is a fail-closed collision.
func (l *commandLedger) claim(cmd CloudCommand, fingerprint, wireAction string, deadline, now time.Time) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if old, ok := l.entries[cmd.ActionID]; ok {
		if old.Fingerprint != fingerprint {
			return false, errors.New("action_id wurde mit anderer Nutzlast wiederverwendet")
		}
		return true, nil
	}
	l.prune(now)
	if now.Before(l.capacityBlockUntil) {
		// A single watermark remembers an arbitrary number of capacity-rejected
		// envelopes with constant disk and memory use. Every such envelope has a
		// deadline at or before the maximum. Until then none may reach a station;
		// afterwards they are all expired at the immutable envelope boundary.
		if deadline.After(l.capacityBlockUntil) {
			previous := l.capacityBlockUntil
			l.capacityBlockUntil = deadline.UTC()
			if err := l.save(); err != nil {
				l.capacityBlockUntil = previous
				return false, fmt.Errorf("%w: %v", ErrCommandStorage, err)
			}
		}
		return false, errCommandLedgerCapacity
	}
	if len(l.entries) >= commandLedgerLimit {
		// Every remaining entry is protected: either its immutable command
		// deadline is still live or its exact mapping is inside the bounded late-
		// response window. Eviction could therefore repeat a physical station
		// action or make its late outcome anonymous. Apply backpressure instead.
		// A per-action rejection map would turn sustained distinct IDs into a
		// durable memory/disk DoS. The global watermark deliberately trades
		// availability for bounded at-most-once safety.
		l.capacityBlockUntil = deadline.UTC()
		if err := l.save(); err != nil {
			l.capacityBlockUntil = time.Time{}
			return false, fmt.Errorf("%w: %v", ErrCommandStorage, err)
		}
		return false, errCommandLedgerCapacity
	}
	entry := commandLedgerEntry{ActionID: cmd.ActionID, Fingerprint: fingerprint, Action: cmd.Action,
		WireAction: wireAction, ChargePointID: cmd.ChargePointID, CorrelationID: cmd.CorrelationID,
		State: "claimed", DeadlineAt: deadline.UTC(), UpdatedAt: now.UTC()}
	var request struct {
		ConnectorID *int   `json:"connectorId"`
		Key         string `json:"key"`
	}
	_ = json.Unmarshal(cmd.Request, &request)
	entry.ConnectorID, entry.ConfigurationKey = request.ConnectorID, request.Key
	l.entries[cmd.ActionID] = entry
	if err := l.save(); err != nil {
		delete(l.entries, cmd.ActionID)
		return false, fmt.Errorf("%w: %v", ErrCommandStorage, err)
	}
	return false, nil
}

// wireMappings returns the durable exact-wire bindings that still await a
// station response. Unlike the protocol spool, these survive the normal QoS1
// ACK which deletes an already-uploaded outbound CALL.
func (l *commandLedger) wireMappings() []commandWireMapping {
	l.mu.Lock()
	defer l.mu.Unlock()
	var mappings []commandWireMapping
	for _, e := range l.entries {
		if e.State == "claimed" || e.State == "sent" {
			wireAction := e.WireAction
			if wireAction == "" {
				wireAction = e.Action
				if e.Action == "SoftReset" || e.Action == "HardReset" {
					wireAction = "Reset"
				}
			}
			mappings = append(mappings, commandWireMapping{ChargePointID: e.ChargePointID,
				WireID: e.ActionID, WireAction: wireAction, CorrelationID: e.CorrelationID,
				CallSeen: e.State == "sent"})
		}
		if e.ReadbackWireID != "" && (e.State == "readback_bound" || e.State == "readback_sent") {
			mappings = append(mappings, commandWireMapping{ChargePointID: e.ChargePointID,
				WireID: e.ReadbackWireID, WireAction: e.ReadbackAction,
				CorrelationID: e.ReadbackCorrelation, CallSeen: e.State == "readback_sent"})
		}
	}
	return mappings
}

// bindReadback persists the follow-up mapping before any readback bytes are
// handed to the station. Repeated callbacks reuse one wire id and never create
// multiple concurrent readbacks for the same physical action.
func (l *commandLedger) bindReadback(actionID, wireID, action, correlation string, now time.Time) (commandLedgerEntry, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[actionID]
	if !ok {
		return commandLedgerEntry{}, false, errors.New("unbekannte action_id")
	}
	if e.ReadbackWireID != "" {
		return e, e.State == "readback_bound", nil
	}
	previousState := e.State
	e.ReadbackWireID, e.ReadbackAction, e.ReadbackCorrelation = wireID, action, correlation
	e.State, e.UpdatedAt = "readback_bound", now.UTC()
	l.entries[actionID] = e
	if err := l.save(); err != nil {
		e.ReadbackWireID, e.ReadbackAction, e.ReadbackCorrelation = "", "", ""
		e.State = previousState
		l.entries[actionID] = e
		return commandLedgerEntry{}, false, err
	}
	return e, true, nil
}

func (l *commandLedger) getByWire(wireID string) (commandLedgerEntry, bool, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, e := range l.entries {
		if e.ActionID == wireID {
			return e, false, true
		}
		if e.ReadbackWireID == wireID {
			return e, true, true
		}
	}
	return commandLedgerEntry{}, false, false
}

func (l *commandLedger) finishByWire(wireID, state string, now time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, e := range l.entries {
		if e.ActionID != wireID && e.ReadbackWireID != wireID {
			continue
		}
		e.State, e.UpdatedAt = state, now.UTC()
		l.entries[id] = e
		return l.save()
	}
	return errors.New("unbekannte wire_id")
}

func (l *commandLedger) get(actionID string) (commandLedgerEntry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[actionID]
	return e, ok
}

func (l *commandLedger) finish(actionID, state string, now time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	e, ok := l.entries[actionID]
	if !ok {
		return errors.New("unbekannte action_id")
	}
	e.State, e.UpdatedAt = state, now.UTC()
	l.entries[actionID] = e
	return l.save()
}

func (l *commandLedger) prune(now time.Time) {
	for id, e := range l.entries {
		if commandLedgerEntryPrunable(e, now) {
			delete(l.entries, id)
		}
	}
	if !l.capacityBlockUntil.IsZero() && !now.Before(l.capacityBlockUntil) {
		l.capacityBlockUntil = time.Time{}
	}
}

func commandLedgerEntryPrunable(e commandLedgerEntry, now time.Time) bool {
	// A missing deadline is unknown legacy/corrupt evidence and therefore
	// deliberately retained fail-closed.
	if e.DeadlineAt.IsZero() || now.Before(e.DeadlineAt) {
		return false
	}
	// ExecuteCloudCommand rejects an expired envelope before claim(), so a
	// terminal entry is safe to remove once its deadline has passed. Before
	// then it remains replay protection even though no response is outstanding.
	switch e.State {
	case "rejected", "responded", "readback_failed":
		return true
	}
	// Claimed/sent/readback states can still receive a late station response.
	// Keep their exact wire mapping for a bounded late-outcome window; only
	// after that window is both replay and response evidence safely obsolete.
	return !now.Before(e.DeadlineAt.Add(commandLedgerLateResponseRetention))
}

func (l *commandLedger) save() error {
	if l.beforeSave != nil {
		if err := l.beforeSave(); err != nil {
			return err
		}
	}
	doc := commandLedgerDocument{SchemaVersion: "1.0", Entries: make([]commandLedgerEntry, 0, len(l.entries))}
	for _, e := range l.entries {
		doc.Entries = append(doc.Entries, e)
	}
	if !l.capacityBlockUntil.IsZero() {
		blockUntil := l.capacityBlockUntil.UTC()
		doc.CapacityBlockUntil = &blockUntil
	}
	sort.Slice(doc.Entries, func(i, j int) bool { return doc.Entries[i].ActionID < doc.Entries[j].ActionID })
	raw, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	tmp := l.path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, l.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	// The file sync protects its bytes; syncing the directory protects the
	// rename itself across sudden power loss before any station byte is sent.
	dir, err := os.Open(filepath.Dir(l.path))
	if err != nil {
		return err
	}
	err = dir.Sync()
	if closeErr := dir.Close(); err == nil {
		err = closeErr
	}
	return err
}
