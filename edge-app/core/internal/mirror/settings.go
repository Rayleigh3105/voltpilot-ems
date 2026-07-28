// Package mirror is the "Modbus-Datenspiegel": a READ-ONLY Modbus-TCP slave
// on the customer LAN that serves the plant's register data FROM CACHES the
// edge's own poll fills - so a building automation (Loxone, KNX gateway,
// SCADA) reads through VoltPilot instead of fighting over the single-client
// Solarman logger socket.
//
// THE INVARIANT (design report data/vp-modbus-share-f5, §6): a consumer
// request NEVER touches the inverter/logger. Every answer comes from RAM;
// the request path has no channel to any upstream I/O. Consumer DEMAND may
// only steer what OUR OWN 5-s poll additionally fetches (auto-learn, below),
// hard-capped and always subordinate to the existing socket-lock discipline
// in which control writes win. The 60-s dead-man watchdog (Deye register
// 1101) is therefore structurally unaffected.
//
// Two register areas on one listener (container port 1502, host-mapped
// ${VP_MIRROR_PORT:-502}):
//
//   - unit ID = the device's mb_slave_id (default 1): the NATIVE register
//     pass-through. Serves the raw register blocks the Node-RED poll already
//     reads (published on edge/registers/raw) byte-faithfully, so a Loxone
//     keeps its whole sensor tree and changes exactly one property: the IP.
//     A request for an uncached-but-plausible range is RECORDED as a wanted
//     block (auto-learn) and answered with exception 0x0B until our own poll
//     delivered it - the consumer polls cyclically, so the first miss is
//     invisible in practice.
//   - unit ID 100: the brand-agnostic VoltPilot standard map (frozen, schema
//     v1) sourced from the gated composite channels every plant has. SunSpec
//     style not-implemented sentinels for absent channels - never a
//     fabricated 0.
//
// Read-only structurally: only FC3/FC4 are dispatched (same data); every
// other function code gets exception 0x01 ILLEGAL FUNCTION. No write path
// exists in this package.
package mirror

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Block is one register range [Start, Start+Count) in a learned-want list.
type Block struct {
	Start int `json:"start"`
	Count int `json:"count"`
}

// End returns the exclusive end register of the block.
func (b Block) End() int { return b.Start + b.Count }

// Settings is the persisted mirror configuration (data_dir/mirror.json).
// LearnedBlocks is the auto-learned want set, persisted so a core restart
// does not forget which registers the customer's building automation reads.
type Settings struct {
	Enabled bool `json:"enabled"`
	// Port is the CONTAINER listen port. The compose maps
	// "${VP_MIRROR_PORT:-502}:1502" onto it, so changing it here without
	// changing the compose mapping breaks reachability - it exists for tests
	// and host-network setups, not for the UI (the POST endpoint deliberately
	// does not accept it).
	Port          int     `json:"port"`
	StaleAfterS   int     `json:"stale_after_s"`
	LearnedBlocks []Block `json:"learned_blocks"`
}

// DefaultSettings returns the built-in configuration: mirror OFF (the
// listener must be inert until the operator enables it), container port 1502,
// 90-s staleness window (the dashboard's .stale convention).
func DefaultSettings() Settings {
	return Settings{Enabled: false, Port: 1502, StaleAfterS: 90}
}

// ValidationError carries a German, operator-facing validation message.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

// Normalize validates and fills defaults; a zero value field falls back to
// its default so a partial/older mirror.json still yields a complete config.
func (s Settings) Normalize() (Settings, error) {
	out := s
	if out.Port == 0 {
		out.Port = DefaultSettings().Port
	}
	if out.Port < 1 || out.Port > 65535 {
		return out, &ValidationError{Msg: "Der Port muss zwischen 1 und 65535 liegen."}
	}
	if out.StaleAfterS == 0 {
		out.StaleAfterS = DefaultSettings().StaleAfterS
	}
	if out.StaleAfterS < 5 || out.StaleAfterS > 3600 {
		return out, &ValidationError{Msg: "Die Frische-Schwelle (stale_after_s) muss zwischen 5 und 3600 Sekunden liegen."}
	}
	blocks := make([]Block, 0, len(out.LearnedBlocks))
	for _, b := range out.LearnedBlocks {
		if b.Start < 0 || b.Start > 0xFFFF || b.Count < 1 || b.End() > 0x10000 {
			continue // silently drop a garbage persisted block, never fail the boot
		}
		if overlapsControlWindow(b.Start, b.Count) {
			continue // the control window is never polled - see learner.go
		}
		if b.Count > MaxLearnedBlockSize {
			b.Count = MaxLearnedBlockSize
		}
		blocks = append(blocks, b)
		if len(blocks) >= MaxLearnedBlocks {
			break
		}
	}
	out.LearnedBlocks = blocks
	return out, nil
}

// Store persists the mirror configuration under data_dir/mirror.json,
// mirroring guards.SettingsStore's atomic write (despike.json pattern).
type Store struct{ path string }

// NewStore stores the configuration under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "mirror.json")}, nil
}

// Save writes the settings atomically.
func (s *Store) Save(cfg Settings) error {
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Load returns the persisted settings, ok=false if none exists yet. A stored
// file is re-normalized so an out-of-date/partial file still yields a
// complete, valid configuration.
func (s *Store) Load() (Settings, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{}, false, nil
	}
	if err != nil {
		return Settings{}, false, err
	}
	var cfg Settings
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Settings{}, false, fmt.Errorf("gespeicherte Spiegel-Einstellungen beschädigt: %w", err)
	}
	norm, err := cfg.Normalize()
	if err != nil {
		return Settings{}, false, err
	}
	return norm, true, nil
}
