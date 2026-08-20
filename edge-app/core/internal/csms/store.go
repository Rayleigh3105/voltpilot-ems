package csms

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ErrNotFound is returned when a charge point id is not on the allowlist (the
// web layer maps it to HTTP 404).
var ErrNotFound = errors.New("Ladepunkt nicht gefunden")

// ValidationError carries a customer-facing German message; the web layer maps
// it to HTTP 400. Mirrors inverter/sources.ValidationError so every setup
// surface refuses the same way.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, a...)}
}

// chargePointIDRe bounds the OCPP ChargePointId. It travels as a URL PATH
// SEGMENT (ws://box:8887/ocpp/{id}), so it must be safe there without
// escaping, and it is the allowlist key, so it must be exact. The charset is
// the same conservative one the platform already uses for device references.
var chargePointIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidChargePointID reports whether id is an acceptable ChargePointId.
func ValidChargePointID(id string) bool { return chargePointIDRe.MatchString(id) }

// maxChargers bounds the allowlist. A site with more charge points than this
// is not a thing this MVP claims to serve, and an unbounded list on a box with
// a small disk is nobody's friend.
const maxChargers = 64

// persisted is the on-disk shape of chargers.json. It is an OBJECT rather than
// a bare array (unlike sources.json) because it carries a second fact: the
// next transaction id. OCPP wants transaction ids unique per central system,
// and a box that forgot them across a reboot would re-issue ids that a station
// still holds for a running session.
type persisted struct {
	SchemaVersion     string    `json:"schema_version"`
	Chargers          []Charger `json:"chargers"`
	NextTransactionID int       `json:"next_transaction_id"`
}

// Store persists the charge-point allowlist + the transaction-id counter.
type Store struct{ path string }

// NewStore stores the list under dir (created if needed).
func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &Store{path: filepath.Join(dir, "chargers.json")}, nil
}

// Path is the file the store writes (diagnostics).
func (s *Store) Path() string { return s.path }

// Load returns the persisted allowlist and the next transaction id. ok=false
// when nothing has been stored yet.
func (s *Store) Load() ([]Charger, int, bool, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, 1, false, nil
	}
	if err != nil {
		return nil, 1, false, err
	}
	var p persisted
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, 1, false, fmt.Errorf("gespeicherte Ladepunkte beschädigt: %w", err)
	}
	next := p.NextTransactionID
	if next < 1 {
		next = 1
	}
	return p.Chargers, next, true, nil
}

// Save writes the list atomically (tmp+rename, the house discipline: a reboot
// in the middle of a write must leave a readable file).
func (s *Store) Save(list []Charger, nextTransactionID int) error {
	if list == nil {
		list = []Charger{}
	}
	if nextTransactionID < 1 {
		nextTransactionID = 1
	}
	raw, err := json.Marshal(persisted{
		SchemaVersion:     SchemaVersion,
		Chargers:          list,
		NextTransactionID: nextTransactionID,
	})
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// AddRequest is what the setup surface posts to register a charge point BEFORE
// the station ever dials in (the mockups' "Säule anbinden": the box shows the
// endpoint + the Kennung, the operator configures it on the station, the
// station then announces itself).
type AddRequest struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Priority bool   `json:"priority"`
}

// NormalizeAdd validates + normalises an add request against the existing
// list. It never mutates; the caller stores the returned Charger.
func NormalizeAdd(req AddRequest, existing []Charger, now time.Time) (Charger, error) {
	id := strings.TrimSpace(req.ID)
	if id == "" {
		return Charger{}, invalid("Bitte die Kennung der Ladesäule angeben.")
	}
	if !ValidChargePointID(id) {
		return Charger{}, invalid("Die Kennung %q ist nicht zulässig: erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich (höchstens 64 Zeichen).", id)
	}
	for _, c := range existing {
		if c.ID == id {
			return Charger{}, invalid("Eine Ladesäule mit der Kennung %q ist bereits eingetragen.", id)
		}
	}
	if len(existing) >= maxChargers {
		return Charger{}, invalid("Es sind bereits %d Ladesäulen eingetragen — mehr unterstützt diese Box nicht.", maxChargers)
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		label = id
	}
	if len([]rune(label)) > 120 {
		return Charger{}, invalid("Der Name der Ladesäule ist zu lang (höchstens 120 Zeichen).")
	}
	return Charger{ID: id, Label: label, Priority: req.Priority, AddedAt: now.UTC()}, nil
}

// SortChargers orders an allowlist deterministically by id.
func SortChargers(list []Charger) {
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
}
