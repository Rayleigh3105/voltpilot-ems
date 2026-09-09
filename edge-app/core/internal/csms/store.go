package csms

import (
	"encoding/json"
	"errors"
	"fmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
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
	SchemaVersion     string                    `json:"schema_version"`
	Chargers          []Charger                 `json:"chargers"`
	NextTransactionID int                       `json:"next_transaction_id"`
	StartWatermarks   map[string]startWatermark `json:"start_watermarks,omitempty"`
	Sessions          []storedSession           `json:"sessions,omitempty"`
	Control           *ocppcontrol.Policy       `json:"ocpp_control,omitempty"`
	ControlTest       *ControlTest              `json:"ocpp_control_test,omitempty"`
}

// The last accepted start per connector prevents closed Start replays without
// retaining a card history. Same-second starts with different evidence remain distinct.
type startWatermark struct {
	At           time.Time `json:"at"`
	MeterStartWh int       `json:"meter_start_wh"`
	TagRef       string    `json:"tag_ref,omitempty"`
}

// Separate wire type deliberately excludes the live plaintext IDTag.
type storedSession struct {
	ChargePointID string    `json:"charge_point_id"`
	ConnectorID   int       `json:"connector_id"`
	TransactionID int       `json:"transaction_id"`
	StartedAt     time.Time `json:"started_at"`
	MeterStartWh  int       `json:"meter_start_wh"`
	TagRef        string    `json:"tag_ref,omitempty"`
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
	p, ok, err := s.loadState()
	return p.Chargers, p.NextTransactionID, ok, err
}

func (s *Store) loadState() (persisted, bool, error) {
	p := persisted{NextTransactionID: 1}
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return p, false, nil
	}
	if err != nil {
		return p, false, err
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, false, fmt.Errorf("gespeicherte Ladepunkte beschädigt: %w", err)
	}
	if p.NextTransactionID < 1 {
		p.NextTransactionID = 1
	}
	return p, true, nil
}

// Save writes the list atomically (tmp+rename, the house discipline: a reboot
// in the middle of a write must leave a readable file).
func (s *Store) Save(list []Charger, nextTransactionID int, sessions ...[]storedSession) error {
	var tx []storedSession
	if len(sessions) > 0 {
		tx = sessions[0]
	}
	return s.save(list, nextTransactionID, tx, nil, nil, nil)
}

func (s *Store) save(list []Charger, nextTransactionID int, sessions []storedSession, control *ocppcontrol.Policy, test *ControlTest, starts map[string]startWatermark) error {
	if list == nil {
		list = []Charger{}
	}
	if nextTransactionID < 1 {
		nextTransactionID = 1
	}
	p := persisted{
		SchemaVersion:     SchemaVersion,
		Chargers:          list,
		NextTransactionID: nextTransactionID,
	}
	p.Sessions, p.Control = sessions, control
	p.ControlTest, p.StartWatermarks = test, starts
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".chargers-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(f.Name(), s.path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(s.path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

// AddRequest is what the setup surface posts to register a charge point BEFORE
// the station ever dials in (the mockups' "Säule anbinden": the box shows the
// endpoint + the Kennung, the operator configures it on the station, the
// station then announces itself).
type AddRequest struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Priority   bool    `json:"priority"`
	RatedKw    float64 `json:"rated_kw,omitempty"`
	MinKw      float64 `json:"min_kw,omitempty"`
	Connectors int     `json:"connectors,omitempty"`
	// Connection: "haus" (default) or "eigen" - see Charger.Connection.
	Connection string `json:"connection,omitempty"`
	// Source: this station's own source lane - see Charger.Source. "" = the
	// site-wide policy applies.
	Source string `json:"source,omitempty"`
	// Rank: this station's Rangliste position - see Charger.Rank. 0 = unranked.
	Rank int `json:"rank,omitempty"`
}

// maxRatedKw bounds an operator-declared station rating. 1000 kW per connector
// is well beyond any charge point that exists; the bound only catches a typo.
const maxRatedKw = 1000

// maxConnectors bounds the declared plug count of ONE station.
const maxConnectors = 32

// maxRank mirrors the charging-config contract's ceiling on a Rangliste
// position. Generous: a park with more than a few hundred claimants does not
// exist, and a bound that refuses a real site is worse than none.
const maxRank = 4096

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
	if req.RatedKw < 0 || req.RatedKw > maxRatedKw || req.RatedKw != req.RatedKw {
		return Charger{}, invalid("Die Nennleistung je Stecker muss zwischen 0 und %d kW liegen.", maxRatedKw)
	}
	if req.MinKw < 0 || req.MinKw > maxRatedKw || req.MinKw != req.MinKw {
		return Charger{}, invalid("Die Mindestleistung muss zwischen 0 und %d kW liegen.", maxRatedKw)
	}
	if req.RatedKw > 0 && req.MinKw > req.RatedKw {
		return Charger{}, invalid("Die Mindestleistung (%g kW) ist größer als die Nennleistung je Stecker (%g kW).", req.MinKw, req.RatedKw)
	}
	if req.Connectors < 0 || req.Connectors > maxConnectors {
		return Charger{}, invalid("Die Zahl der Stecker muss zwischen 0 und %d liegen (0 = von der Ladesäule übernehmen).", maxConnectors)
	}
	// ⚠ A word we do not understand must not become a stored state (the house
	// rule). Empty is legitimate and means "behind the house"; anything else is
	// refused rather than silently resolved - reading an unknown word as
	// "eigen" would take a real charging load out of the box's own balance.
	conn := strings.TrimSpace(req.Connection)
	if conn != "" && !KnownConnection(conn) {
		return Charger{}, invalid("Unbekannter Anschluss %q - erlaubt sind %q (hinter dem Hausanschluss) und %q (eigener Netzanschluss).", conn, ConnectionHaus, ConnectionEigen)
	}
	// ⚠ Dieselbe Regel für die Quellen-Bahn (P5): ein Wort, das wir nicht
	// verstehen, wird ABGELEHNT statt still auf eine Vorgabe gedreht - ein als
	// „schnell" gelesenes Unbekanntes machte aus einem „Nur Sonnenstrom" eine
	// Freigabe für Netzstrom, die der Kunde nie erteilt hat. Leer ist
	// legitim und heisst „für diese Säule gilt die Wahl der Anlage".
	src := strings.TrimSpace(req.Source)
	if src != "" && !KnownSource(src) {
		return Charger{}, invalid("Unbekannte Quelle %q - erlaubt sind \"nur_sonne\", \"sonne_zuerst\" und \"schnell\".", src)
	}
	// ⚠ Ein unplausibler RANG wird ABGELEHNT, nicht geklemmt (P6): er ordnet,
	// wer bei knapper Leistung zuerst lädt, und ein geratener Wert setzte eine
	// Säule still vor eine andere. 0 ist legitim und heisst „nicht eingeordnet".
	if req.Rank < 0 || req.Rank > maxRank {
		return Charger{}, invalid("Die Position in der Rangliste muss zwischen 0 und %d liegen (0 = nicht eingeordnet).", maxRank)
	}
	return Charger{
		ID: id, Label: label, Priority: req.Priority,
		RatedKw: req.RatedKw, MinKw: req.MinKw, Connectors: req.Connectors,
		Connection: conn,
		Source:     src,
		Rank:       req.Rank,
		AddedAt:    now.UTC(),
	}, nil
}

// SortChargers orders an allowlist deterministically by id.
func SortChargers(list []Charger) {
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
}
