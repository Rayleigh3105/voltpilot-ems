package ebyte

// The per-address identity pin: the MAC and the module layout an I/O module
// showed on first contact (or at the last successful "Verbindung testen") are
// persisted in data_dir/ebyte-devices.json (atomic tmp+rename, the Shelly
// store discipline). Two changes must stop the executor, never be followed
// silently:
//
//   - another MAC behind the address: a DHCP lease moved, a device was
//     swapped - switching "DO3" there switches somebody else's load;
//   - another module layout: after adding/removing a module and negotiating,
//     the DO addresses are renumbered - "DO9" is now a different relay.
//
// Reads stay honest (the source poll reports what it reads), writes are
// refused until an operator confirms the new device with a connection test,
// which re-pins.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const storeFile = "ebyte-devices.json"

const storeSchemaVersion = 1

// Pin is the persisted identity of one module address.
type Pin struct {
	MAC    string `json:"mac"`
	Layout string `json:"layout"`
}

// LayoutOf renders the module layout signature ("0:GAXAX8080-U|1:XXAX00A0-U").
func LayoutOf(id Identity) string {
	parts := make([]string, 0, len(id.Modules))
	for _, m := range id.Modules {
		parts = append(parts, fmt.Sprintf("%d:%s", m.Slot, strings.ToUpper(m.Model)))
	}
	return strings.Join(parts, "|")
}

// PinOf is the pin an identity would leave.
func PinOf(id Identity) Pin { return Pin{MAC: id.MAC, Layout: LayoutOf(id)} }

// Key identifies one module address.
func (c Config) Key() string { return fmt.Sprintf("%s/%d", c.Address(), c.unit()) }

type storeDoc struct {
	SchemaVersion int            `json:"schema_version"`
	Devices       map[string]Pin `json:"devices"`
}

// Store persists pins keyed by Config.Key().
type Store struct {
	mu   sync.Mutex
	path string
	pins map[string]Pin
}

// NewStore loads (or initializes) the store under dir. A foreign or
// unreadable file starts empty: the next contact pins afresh.
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, storeFile), pins: map[string]Pin{}}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	var doc storeDoc
	if json.Unmarshal(raw, &doc) == nil && doc.SchemaVersion == storeSchemaVersion && doc.Devices != nil {
		s.pins = doc.Devices
	}
	return s, nil
}

func (s *Store) persistLocked() error {
	raw, err := json.MarshalIndent(storeDoc{SchemaVersion: storeSchemaVersion, Devices: s.pins}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// Get returns the pin of an address.
func (s *Store) Get(key string) (Pin, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pins[key]
	return p, ok
}

// Put (re-)pins an address.
func (s *Store) Put(key string, p Pin) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.pins[key]; ok && cur == p {
		return nil
	}
	s.pins[key] = p
	return s.persistLocked()
}

// Verify compares a read identity against the pin of its address. No pin yet:
// the identity is pinned now (first contact) and accepted. A changed MAC or
// layout yields the German refusal; the pin is NOT overwritten.
func (s *Store) Verify(cfg Config, id Identity) *DriverError {
	now := PinOf(id)
	pin, ok := s.Get(cfg.Key())
	if !ok {
		if err := s.Put(cfg.Key(), now); err != nil {
			return driverErr(ErrInvalidResponse, "Die Geräte-Identität konnte nicht gespeichert werden: "+err.Error())
		}
		return nil
	}
	if pin.MAC != now.MAC {
		return driverErr(ErrIdentityMismatch, fmt.Sprintf(
			"Unter %s antwortet ein anderes I/O-Modul (MAC %s statt %s). Es wird nichts geschaltet; nach einem Gerätetausch bitte „Verbindung testen“ ausführen.",
			cfg.IP, now.MAC, pin.MAC))
	}
	if pin.Layout != now.Layout {
		return driverErr(ErrIdentityMismatch,
			"Die Modul-Zusammenstellung des I/O-Moduls hat sich geändert; die Ausgänge können neu nummeriert sein. Es wird nichts geschaltet, bis die Zuordnung mit „Verbindung testen“ bestätigt ist.")
	}
	return nil
}
