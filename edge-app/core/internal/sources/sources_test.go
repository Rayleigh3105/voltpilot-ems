package sources

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

func cat() inverter.Catalog { return inverter.DefaultCatalog() }

func erzeugerReq() Request {
	return Request{
		Role:        RoleErzeuger,
		Brand:       inverter.BrandGenericModbus,
		Model:       inverter.FamSunSpec,
		Connection:  inverter.Connection{IP: "192.168.0.50"},
		CapacityKwp: 70,
	}
}

func TestNormalizeValidErzeugerDefaultsAndDerivations(t *testing.T) {
	req := erzeugerReq()
	req.IntervalS = 0 // -> default
	req.Label = ""    // -> derived from catalog
	src, err := Normalize(cat(), req, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.Role != RoleErzeuger {
		t.Fatalf("role = %q", src.Role)
	}
	if src.Communication != inverter.CommModbusTCP {
		t.Fatalf("communication derived wrong: %q", src.Communication)
	}
	if src.Family != inverter.FamSunSpec {
		t.Fatalf("family = %q", src.Family)
	}
	if src.IntervalS != defaultIntervalS {
		t.Fatalf("interval default = %d", src.IntervalS)
	}
	if src.Label == "" {
		t.Fatalf("label should default from catalog")
	}
	if src.CapacityKwp != 70 {
		t.Fatalf("capacity = %v", src.CapacityKwp)
	}
	if src.Connection.Port != 502 {
		t.Fatalf("modbus default port not filled: %d", src.Connection.Port)
	}
}

func TestNormalizeAcceptsNetzMeterRoleWithoutCapacity(t *testing.T) {
	req := erzeugerReq()
	req.Role = RoleNetz // Increment 1: a grid meter at the PCC
	req.CapacityKwp = 0 // a meter has no nameplate
	req.Model = inverter.FamSunSpec
	src, err := Normalize(cat(), req, time.Now())
	if err != nil {
		t.Fatalf("unexpected error normalizing a Netz meter: %v", err)
	}
	if src.Role != RoleNetz {
		t.Fatalf("role = %q, want %q", src.Role, RoleNetz)
	}
	if src.CapacityKwp != 0 {
		t.Fatalf("a meter should carry no capacity, got %v", src.CapacityKwp)
	}
	// Transport validation is reused exactly like the Erzeuger path.
	if src.Communication != inverter.CommModbusTCP || src.Connection.Port != 502 {
		t.Fatalf("Netz transport not derived: comm=%q port=%d", src.Communication, src.Connection.Port)
	}
}

func TestNormalizeRejectsUnknownRole(t *testing.T) {
	req := erzeugerReq()
	req.Role = "wallbox" // reserved vocabulary, not yet configurable on the edge
	_, err := Normalize(cat(), req, time.Now())
	if err == nil {
		t.Fatal("expected a validation error for an unknown role")
	}
	var ve *ValidationError
	if !asValidation(err, &ve) {
		t.Fatalf("expected *ValidationError, got %T", err)
	}
}

func TestNormalizeSurfacesCatalogErrorsAsValidation(t *testing.T) {
	req := erzeugerReq()
	req.Connection.IP = "" // inverter catalog rejects a missing IP
	_, err := Normalize(cat(), req, time.Now())
	var ve *ValidationError
	if err == nil || !asValidation(err, &ve) {
		t.Fatalf("expected a *ValidationError from the catalog, got %v (%T)", err, err)
	}
}

func TestNormalizeRejectsAbsurdInterval(t *testing.T) {
	req := erzeugerReq()
	req.IntervalS = 99999
	if _, err := Normalize(cat(), req, time.Now()); err == nil {
		t.Fatal("expected an interval validation error")
	}
}

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Load(); err != nil || ok {
		t.Fatalf("empty store should report ok=false: ok=%v err=%v", ok, err)
	}
	src, _ := Normalize(cat(), erzeugerReq(), time.Now())
	src.ID = NewID()
	if err := s.Save([]Source{src}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Load()
	if err != nil || !ok || len(got) != 1 {
		t.Fatalf("round-trip failed: ok=%v err=%v len=%d", ok, err, len(got))
	}
	if got[0].ID != src.ID || got[0].CapacityKwp != 70 {
		t.Fatalf("round-trip mismatch: %+v", got[0])
	}
}

func TestBusConfigShape(t *testing.T) {
	src, _ := Normalize(cat(), erzeugerReq(), time.Now())
	src.ID = "src-abc"
	raw := BusConfig([]Source{src})
	var m struct {
		SchemaVersion string           `json:"schema_version"`
		Sources       []map[string]any `json:"sources"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m.SchemaVersion != SchemaVersion || len(m.Sources) != 1 {
		t.Fatalf("bus config shape wrong: %s", raw)
	}
	e := m.Sources[0]
	if e["id"] != "src-abc" || e["role"] != RoleErzeuger || e["communication"] != inverter.CommModbusTCP {
		t.Fatalf("bus entry wrong: %+v", e)
	}
	if _, ok := e["connection"]; !ok {
		t.Fatalf("bus entry missing connection: %+v", e)
	}
	// An empty list clears the retained config with an empty array.
	var empty struct {
		Sources []map[string]any `json:"sources"`
	}
	_ = json.Unmarshal(BusConfig(nil), &empty)
	if empty.Sources == nil || len(empty.Sources) != 0 {
		t.Fatalf("empty list should yield an empty (non-null) array")
	}
}

// A fronius_sunspec Erzeuger source (a Fronius read over SunSpec-live) must
// publish its full SunSpec connection in the retained bus entry - without
// unit_id/model_type/invert_grid_sign the Node-RED per-source reader can only
// fall back to defaults (the captain's real "Wartet auf erste Daten" bug had
// this as its Go-side half).
func TestBusConfigCarriesFroniusSunSpecConnection(t *testing.T) {
	req := Request{
		Role:        RoleErzeuger,
		Brand:       inverter.BrandFroniusSunSpec,
		Model:       "fronius-eco-27-3-s",
		Connection:  inverter.Connection{IP: "192.168.254.40", UnitID: 2, ModelType: "float", InvertGridSign: true},
		CapacityKwp: 70,
	}
	src, err := Normalize(cat(), req, time.Now())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if src.Communication != inverter.CommFroniusSunSpec {
		t.Fatalf("communication derived wrong: %q", src.Communication)
	}
	src.ID = "src-eco"
	var m struct {
		Sources []struct {
			Communication string         `json:"communication"`
			Connection    map[string]any `json:"connection"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(BusConfig([]Source{src}), &m); err != nil {
		t.Fatal(err)
	}
	conn := m.Sources[0].Connection
	if m.Sources[0].Communication != inverter.CommFroniusSunSpec {
		t.Fatalf("communication = %q", m.Sources[0].Communication)
	}
	if conn["unit_id"] != float64(2) {
		t.Fatalf("unit_id missing from the bus entry: %+v", conn)
	}
	if conn["model_type"] != "float" {
		t.Fatalf("model_type missing from the bus entry: %+v", conn)
	}
	if conn["invert_grid_sign"] != true {
		t.Fatalf("invert_grid_sign missing from the bus entry: %+v", conn)
	}
	if conn["ip"] != "192.168.254.40" || conn["port"] != float64(502) {
		t.Fatalf("ip/port wrong: %+v", conn)
	}
}

func TestIDFromTopic(t *testing.T) {
	cases := map[string]string{
		"edge/sources/src-abc/telemetry": "src-abc",
		"edge/sources/config":            "",
		"edge/sources//telemetry":        "",
		"edge/sources/a/b/telemetry":     "",
		"edge/telemetry":                 "",
	}
	for topic, want := range cases {
		if got := IDFromTopic(topic); got != want {
			t.Fatalf("IDFromTopic(%q) = %q, want %q", topic, got, want)
		}
	}
}

// asValidation is a tiny errors.As helper kept local to avoid importing errors
// in every case.
func asValidation(err error, target **ValidationError) bool {
	ve, ok := err.(*ValidationError)
	if ok {
		*target = ve
	}
	return ok
}

// --- BalanceStore: persistence + the 2026-07-17 legacy migration -------------

// The store persists the expert opt-out; a legacy (opt-in era) balance.json
// carrying only `primary_grid_is_site_total` migrates to opt-out=false
// (standard ON) REGARDLESS of the stored value: a legacy explicit ON stays on,
// and a legacy false was the old opt-in default, not a topology statement.
func TestBalanceStoreRoundTripAndLegacyMigration(t *testing.T) {
	dir := t.TempDir()
	bs, err := NewBalanceStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	// Fresh: no file yet.
	if _, ok, err := bs.Load(); err != nil || ok {
		t.Fatalf("fresh load = ok=%v err=%v, want absent", ok, err)
	}

	// Round trip of the new opt-out key.
	if err := bs.Save(BalanceSettings{PrimaryGridNotSiteTotal: true}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := bs.Load()
	if err != nil || !ok || !got.PrimaryGridNotSiteTotal {
		t.Fatalf("round trip = %+v ok=%v err=%v", got, ok, err)
	}

	// Legacy files: both values migrate to opt-out=false.
	for _, legacy := range []string{
		`{"primary_grid_is_site_total": true}`,
		`{"primary_grid_is_site_total": false}`,
	} {
		if err := os.WriteFile(filepath.Join(dir, "balance.json"), []byte(legacy), 0o644); err != nil {
			t.Fatal(err)
		}
		got, ok, err := bs.Load()
		if err != nil || !ok {
			t.Fatalf("legacy load (%s): ok=%v err=%v", legacy, ok, err)
		}
		if got.PrimaryGridNotSiteTotal {
			t.Fatalf("legacy %s must migrate to opt-out=false (standard ON)", legacy)
		}
	}

	// A file that carries the NEW key uses it verbatim, even next to a stale
	// legacy key.
	mixed := `{"primary_grid_is_site_total": false, "primary_grid_not_site_total": true}`
	if err := os.WriteFile(filepath.Join(dir, "balance.json"), []byte(mixed), 0o644); err != nil {
		t.Fatal(err)
	}
	got, ok, err = bs.Load()
	if err != nil || !ok || !got.PrimaryGridNotSiteTotal {
		t.Fatalf("mixed-key load = %+v ok=%v err=%v, want opt-out=true", got, ok, err)
	}

	// Corrupt file: loud error, never silent defaults pretending to be stored.
	if err := os.WriteFile(filepath.Join(dir, "balance.json"), []byte(`{nope`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := bs.Load(); err == nil {
		t.Fatal("corrupt balance.json must surface an error")
	}
}
