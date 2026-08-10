package shelly

// The per-device identity store: a Shelly's generation dialect + metering
// capability is detected ONCE and persisted (data_dir/shelly-devices.json,
// atomic tmp+rename like inverter.json/sources.json), so a reboot never
// re-probes a known device and the dialect decision is stable. A cached
// identity is DROPPED on a dialect-level invalid_response (firmware swap /
// device replaced behind the same IP) so the next pass re-detects exactly
// once - self-healing, never a re-detect loop.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const storeFile = "shelly-devices.json"

// storeSchemaVersion guards the on-disk shape (the calibration-certified.json
// discipline): a file from a FUTURE schema is ignored wholesale (re-detect,
// never mis-read).
const storeSchemaVersion = 1

type storeDoc struct {
	SchemaVersion int                 `json:"schema_version"`
	Devices       map[string]Identity `json:"devices"`
}

// Store persists detected identities keyed by Config.Key() (ip:port/channel).
type Store struct {
	mu   sync.Mutex
	path string
	byID map[string]Identity
}

// NewStore loads (or initializes) the store under dir.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, storeFile), byID: map[string]Identity{}}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	var doc storeDoc
	if json.Unmarshal(raw, &doc) != nil || doc.SchemaVersion != storeSchemaVersion {
		// Unreadable / foreign schema: start empty (a re-detect is cheap and
		// honest; guessing from a mis-read file is not).
		return s, nil
	}
	if doc.Devices != nil {
		s.byID = doc.Devices
	}
	return s, nil
}

// Get returns the persisted identity for one device key.
func (s *Store) Get(key string) (Identity, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, ok := s.byID[key]
	return id, ok
}

// Put persists one detected identity.
func (s *Store) Put(key string, id Identity) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byID[key] = id
	return s.persistLocked()
}

// Drop forgets one device (the next pass re-detects once).
func (s *Store) Drop(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.byID[key]; !ok {
		return nil
	}
	delete(s.byID, key)
	return s.persistLocked()
}

func (s *Store) persistLocked() error {
	raw, err := json.MarshalIndent(storeDoc{SchemaVersion: storeSchemaVersion, Devices: s.byID}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
