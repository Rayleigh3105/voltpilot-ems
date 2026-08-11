package componentapply

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Store persists the last apply outcome (<data_dir>/components-applied.json),
// atomically like inverter.Store / sources.Store.
//
// It is NOT a copy of the configuration - the configuration itself lives where
// it always lived (inverter.json + sources.json), which is precisely what keeps
// the local bus mechanics byte-identical. This file only records WHO owns the
// configuration and WHICH revision was last applied, so a rebooting box knows
// it is portal-managed before the first push of the new session arrives.
type Store struct{ path string }

// NewStore keeps the record under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "components-applied.json")}, nil
}

// Save writes the record atomically (tmp + rename), so a restart in the middle
// of a write finds either the old record or the new one, never half of one.
func (s *Store) Save(r Record) error {
	r.Version = StateVersion
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted record, ok=false when none exists yet.
//
// A record from a FUTURE schema version is ignored wholesale (ok=false) rather
// than half-read: the safe direction is "this box does not know that it is
// portal-managed", which leaves the local configuration alone until the next
// push says otherwise.
func (s *Store) Load() (Record, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Record{}, false, nil
	}
	if err != nil {
		return Record{}, false, err
	}
	var r Record
	if err := json.Unmarshal(raw, &r); err != nil {
		return Record{}, false, err
	}
	if r.Version != StateVersion {
		return Record{}, false, nil
	}
	return r, true, nil
}
