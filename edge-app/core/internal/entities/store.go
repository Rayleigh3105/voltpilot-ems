package entities

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Store persists the applied entity registry across restarts
// (data-dir/entities.json, the sources.Store atomic-write pattern) so the
// local retained configs can be re-published at boot - the in-process local
// bus loses retained state with the process - and the heartbeat can echo the
// applied revision before the cloud re-delivers the retained push.
type Store struct{ path string }

// NewStore stores the registry under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "entities.json")}, nil
}

// Save writes the registry atomically.
func (s *Store) Save(reg Registry) error {
	if reg.Entities == nil {
		reg.Entities = []Entity{}
	}
	raw, err := json.Marshal(reg)
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted registry, ok=false if none exists yet.
func (s *Store) Load() (Registry, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Registry{}, false, nil
	}
	if err != nil {
		return Registry{}, false, err
	}
	var reg Registry
	if err := json.Unmarshal(raw, &reg); err != nil {
		return Registry{}, false, fmt.Errorf("gespeicherte Entitäten beschädigt: %w", err)
	}
	return reg, true, nil
}
