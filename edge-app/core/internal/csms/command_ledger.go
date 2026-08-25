package csms

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const commandLedgerFile = "ocpp-command-ledger.json"
const commandLedgerLimit = 4096

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
	SchemaVersion string               `json:"schema_version"`
	Entries       []commandLedgerEntry `json:"entries"`
}

// commandLedger is the durable at-most-once boundary. Claim is fsynced via an
// atomic rename before the first station byte is written. A crash may lose a
// command, but can never replay a physical action after restart.
type commandLedger struct {
	mu      sync.Mutex
	path    string
	entries map[string]commandLedgerEntry
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
		return false, err
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
		if e.DeadlineAt.Before(now.Add(-24 * time.Hour)) {
			delete(l.entries, id)
		}
	}
	if len(l.entries) < commandLedgerLimit {
		return
	}
	all := make([]commandLedgerEntry, 0, len(l.entries))
	for _, e := range l.entries {
		all = append(all, e)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].UpdatedAt.Before(all[j].UpdatedAt) })
	for i := 0; i <= len(all)-commandLedgerLimit; i++ {
		delete(l.entries, all[i].ActionID)
	}
}

func (l *commandLedger) save() error {
	doc := commandLedgerDocument{SchemaVersion: "1.0", Entries: make([]commandLedgerEntry, 0, len(l.entries))}
	for _, e := range l.entries {
		doc.Entries = append(doc.Entries, e)
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
