// Package direktvermarkter is the box's view of the direct-marketer catalog
// (Direktvermarkter, catalog/direktvermarkter - concept
// vp-direktvermarktung-konzept d2 §5.3, Stage 1 "Vertrag und Schnittstelle").
//
// The profiles are DATA, authored under catalog/direktvermarkter/profiles and
// packaged into profiles.json by catalog/direktvermarkter/tools/
// package_edge_runtime.py (the Docker build context of this module is
// edge-app/core, so the derivative is generated and checked in; CI fails on a
// stale copy).
//
// Unlike catalog/control-profiles, this derivative carries the FULL register
// map and Modbus access settings, because the data-mirror server this
// package's twin feeds (Stage 1 item 2) needs them to run; it still carries
// only what Stage 1 reads - OpenVPN, the contract link and the setup steps
// stay the portal's and Stage 2's job, and 'vorgabe_wirkt_auf'/'referenz'
// stay out because nothing wires the partner limit into composeCurtailment
// yet.
//
// Two fields the authored catalog can still mark "offen (Fxx)" (word order
// F3, stale-value behaviour F8) always arrive here RESOLVED to a provisional
// default - the box cannot run on an open question. See the catalog README
// for how that default is chosen and how to flip it once the partner answers.
package direktvermarkter

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/modbusprofil"
)

//go:embed profiles.json
var embedded []byte

// Register is one entry of a partner's register map.
type Register struct {
	Table   string  `json:"tabelle"` // "input" (FC 4, read-only) or "holding" (FC 3/6/16)
	Address uint16  `json:"adresse"`
	Type    string  `json:"typ"` // "u16", "s16", "u32" or "s32"
	Meaning string  `json:"bedeutung"`
	Band    *[2]int `json:"band,omitempty"` // present only on a writable register with a bound
}

// Words is how many 16-bit registers this entry occupies (1 or 2).
func (r Register) Words() int { return modbusprofil.RegisterCount(r.Type) }

// End is the address one past this entry's last occupied register.
func (r Register) End() int { return int(r.Address) + r.Words() }

// Modbus is the partner's Modbus access settings.
type Modbus struct {
	Unit        int    `json:"unit"`
	WordOrder   string `json:"wortfolge"` // resolved: "little" or "big", never "offen (Fxx)"
	Functions   []int  `json:"funktionen"`
	Connections int    `json:"verbindungen"`
}

// Rules is the partner's operating rules the box reads today.
type Rules struct {
	WatchdogDeadlineS int    `json:"lebenszeichen_frist_s"`
	RestPct           int    `json:"ruhewert_pct"`
	OnStale           string `json:"bei_veraltet"` // resolved, e.g. "ausnahme_0x0b"
}

// Profile is one packaged partner profile.
type Profile struct {
	ID       string     `json:"id"`
	Modbus   Modbus     `json:"modbus"`
	Register []Register `json:"register"`
	Rules    Rules      `json:"regeln"`
}

// RegisterAt returns the register entry occupying addr in table ("input" or
// "holding"); ok=false for an address the profile does not define.
func (p Profile) RegisterAt(table string, addr uint16) (Register, bool) {
	for _, r := range p.Register {
		if r.Table == table && int(addr) >= int(r.Address) && int(addr) < r.End() {
			return r, true
		}
	}
	return Register{}, false
}

// ByMeaning returns the register entry with the given bedeutung; ok=false if
// the profile does not carry it.
func (p Profile) ByMeaning(meaning string) (Register, bool) {
	for _, r := range p.Register {
		if r.Meaning == meaning {
			return r, true
		}
	}
	return Register{}, false
}

type document struct {
	SchemaVersion string    `json:"schema_version"`
	Partner       []Profile `json:"partner"`
}

var (
	profiles []Profile
	loadErr  error
)

func init() {
	profiles, loadErr = parse(embedded)
}

// parse is fail-safe by construction: on a broken derivative the box runs
// with NO partner profiles, which means the interface in internal/mirror and
// composeCurtailment never see a partner limit - exactly the state a missing
// catalog should produce. Err() reports it; the tests keep it nil.
func parse(raw []byte) ([]Profile, error) {
	var doc document
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("direktvermarkter: %w", err)
	}
	if doc.SchemaVersion != "1.0" {
		return nil, fmt.Errorf("direktvermarkter: schema_version %q", doc.SchemaVersion)
	}
	return doc.Partner, nil
}

// Err is the load error of the embedded profiles (nil when they loaded).
func Err() error { return loadErr }

// All returns a copy of the packaged profiles.
func All() []Profile { return slices.Clone(profiles) }

// For returns the packaged profile for a partner id.
func For(id string) (Profile, bool) {
	for _, p := range profiles {
		if p.ID == id {
			return p, true
		}
	}
	return Profile{}, false
}
