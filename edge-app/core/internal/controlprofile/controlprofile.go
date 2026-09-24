// Package controlprofile is the box's view of the control profiles
// (Steuerprofile, catalog/control-profiles - concept
// vp-wechselrichter-eigenregelung-k1 §4 "Profil statt Sonderfall", K7).
//
// The profiles are DATA, authored under catalog/control-profiles/profiles and
// packaged into profiles.json by catalog/control-profiles/tools/
// package_edge_runtime.py (the Docker build context of this module is
// edge-app/core, so the derivative is generated and checked in; CI fails on a
// stale copy, TestEmbeddedMatchesTheCatalog here fails without Python).
//
// ⚠ A PROFILE NEVER RELEASES ANYTHING. The derivative carries only what the box
// reads today - which profile belongs to the selected device, the damping
// timing of the follower (guards.DampProfileFor) and the day budget of a
// persistent lever (guards.NativeMode). No lever, no write sequence, no
// capability word: whether a device may regulate itself is decided per model +
// firmware + bench record by the certificate in Layer 1
// (CERTIFIED_NATIVE_CAPABILITIES, certificateMatchesPlan), exactly as before.
// Write sequences stay code in the adapters; the profile describes them and
// edge-app/nodered/control-profiles.test.js holds the two together.
package controlprofile

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
)

//go:embed profiles.json
var embedded []byte

// Binding says which selected device a profile belongs to: the catalog brand,
// register-map family and (optionally) model ids of internal/inverter, and
// (optionally) the control path Layer 1 reports (state.ControlPath: "remote",
// "tou" on a Deye). nil Models / ControlPath = any.
type Binding struct {
	Brand       string   `json:"marke"`
	Family      string   `json:"registerfamilie"`
	Models      []string `json:"modelle"`
	ControlPath *string  `json:"steuerpfad"`
}

// Damping is the follower timing the profile states (concept §6.5). nil =
// the profile makes no statement; the box keeps its Vorgabe.
type Damping struct {
	// BoxRegulates false = the box never regulates this device by measurement
	// (a persistent lever: every correction would be an EEPROM write).
	BoxRegulates *bool `json:"box_regelt"`
	// SettleS is the Einschwingzeit, CadenceS the Messtakt, both in seconds.
	SettleS  *float64 `json:"einschwingzeit_s"`
	CadenceS *float64 `json:"messtakt_s"`
}

// WriteBudget bounds the hand-overs of a lever that writes persistent memory
// (concept §6.6, F12). nil = no statement.
type WriteBudget struct {
	PersistentPerDay *int `json:"dauerspeicher_je_tag"`
}

// Profile is one packaged control profile.
type Profile struct {
	ID          string      `json:"id"`
	Bindings    []Binding   `json:"bindung"`
	Damping     Damping     `json:"daempfung"`
	WriteBudget WriteBudget `json:"schreibbudget"`
}

// Device is what the box knows about the selected inverter.
type Device struct {
	Brand, Model, Family, ControlPath string
}

type document struct {
	SchemaVersion string    `json:"schema_version"`
	Profiles      []Profile `json:"profile"`
}

var (
	profiles []Profile
	loadErr  error
)

func init() {
	profiles, loadErr = parse(embedded)
}

// parse is fail-safe by construction: on a broken derivative the box runs with
// NO profiles, which is exactly the Vorgabe every consumer already has for an
// unknown device. Err() reports it; the tests keep it nil.
func parse(raw []byte) ([]Profile, error) {
	var doc document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("controlprofile: %w", err)
	}
	if doc.SchemaVersion != "1.0" {
		return nil, fmt.Errorf("controlprofile: schema_version %q", doc.SchemaVersion)
	}
	return doc.Profiles, nil
}

// Err is the load error of the embedded profiles (nil when they loaded).
func Err() error { return loadErr }

// All returns a copy of the packaged profiles.
func All() []Profile { return slices.Clone(profiles) }

func (b Binding) matches(d Device) bool {
	if b.Brand != d.Brand || b.Family != d.Family {
		return false
	}
	if b.Models != nil && !slices.Contains(b.Models, d.Model) {
		return false
	}
	return b.ControlPath == nil || *b.ControlPath == d.ControlPath
}

// For returns the profile bound to the device. The catalog validator proves no
// two bindings overlap, so the first match is the only one.
func For(d Device) (Profile, bool) {
	for _, p := range profiles {
		for _, b := range p.Bindings {
			if b.matches(d) {
				return p, true
			}
		}
	}
	return Profile{}, false
}

// PersistentWritesPerDay is the day budget the device's profile states for a
// persistent lever; ok = false without a profile or without a statement.
func PersistentWritesPerDay(d Device) (int, bool) {
	p, ok := For(d)
	if !ok || p.WriteBudget.PersistentPerDay == nil {
		return 0, false
	}
	return *p.WriteBudget.PersistentPerDay, true
}
