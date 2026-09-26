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
	// The CURTAILMENT write form must ride the SOURCE config: a Fronius is
	// curtailed as an Erzeuger source, so without this the per-connection
	// flip-back is unreachable from :8484 and the plan node silently keeps the
	// FC16 default. Absent = 0 = auto (-> FC16).
	if conn["curtail_write_fc"] != float64(0) {
		t.Fatalf("curtail_write_fc default missing from the bus entry: %+v", conn)
	}

	req.Connection.CurtailWriteFc = 6
	flipped, err := Normalize(cat(), req, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	flipped.ID = "src-eco"
	if err := json.Unmarshal(BusConfig([]Source{flipped}), &m); err != nil {
		t.Fatal(err)
	}
	if m.Sources[0].Connection["curtail_write_fc"] != float64(6) {
		t.Fatalf("the FC6 flip-back must reach Node-RED: %+v", m.Sources[0].Connection)
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

// A go-e wallbox is added as a CONSUMER source: the consumer role is accepted,
// the go-e HTTP transport is derived from the catalog, and the retained bus
// entry carries just its ip+port so Node-RED can self-wire the /api/status read.
func TestNormalizeAcceptsConsumerGoeSource(t *testing.T) {
	req := Request{
		Role:       RoleConsumer,
		Brand:      inverter.BrandGoe,
		Model:      inverter.FamGoeHTTP,
		Connection: inverter.Connection{IP: "192.168.1.42"},
	}
	src, err := Normalize(cat(), req, time.Now())
	if err != nil {
		t.Fatalf("consumer go-e source rejected: %v", err)
	}
	if src.Role != RoleConsumer {
		t.Fatalf("role = %q, want %q", src.Role, RoleConsumer)
	}
	if src.Communication != inverter.CommGoeHTTP || src.Family != inverter.FamGoeHTTP {
		t.Fatalf("go-e source transport wrong: %+v", src)
	}
	if src.Connection.Port != 80 {
		t.Fatalf("default go-e port = %d, want 80", src.Connection.Port)
	}

	src.ID = "src-goe"
	var m struct {
		Sources []map[string]any `json:"sources"`
	}
	if err := json.Unmarshal(BusConfig([]Source{src}), &m); err != nil {
		t.Fatal(err)
	}
	e := m.Sources[0]
	if e["role"] != RoleConsumer || e["communication"] != inverter.CommGoeHTTP {
		t.Fatalf("bus entry wrong: %+v", e)
	}
	conn, _ := e["connection"].(map[string]any)
	if conn == nil || conn["ip"] != "192.168.1.42" {
		t.Fatalf("bus entry connection wrong: %+v", e["connection"])
	}
}

// DeterministicID: the source id derives from the TRANSPORT IDENTITY, so
// delete + re-add of the same physical device converges on the SAME id and the
// portal's adoption pin survives (vp-vier-erzeuger-p9). Every identity part -
// role, transport, endpoint, per-transport discriminator - must change the id.
func TestDeterministicIDIsStablePerTransportIdentity(t *testing.T) {
	base := Source{
		Role:          RoleErzeuger,
		Communication: inverter.CommFroniusSunSpec,
		Connection:    inverter.Connection{IP: "192.168.210.40", Port: 502, UnitID: 1},
	}
	id := DeterministicID(base)
	if id != DeterministicID(base) {
		t.Fatalf("not deterministic: %q vs %q", id, DeterministicID(base))
	}
	if len(id) != len("src-")+8 || id[:4] != "src-" {
		t.Fatalf("id format wrong: %q", id)
	}
	for _, c := range id[4:] {
		if !containsRune(idAlphabet, c) {
			t.Fatalf("id %q uses a char outside the alphabet: %q", id, c)
		}
	}

	// Labels / intervals / kWp are NOT identity: same id.
	relabeled := base
	relabeled.Label = "Fronius Anlage WR2"
	relabeled.IntervalS = 30
	relabeled.CapacityKwp = 35
	if DeterministicID(relabeled) != id {
		t.Fatalf("label/master data must not change the id")
	}

	// Every identity part IS identity: different id.
	variations := []func(s *Source){
		func(s *Source) { s.Connection.UnitID = 2 },
		func(s *Source) { s.Connection.IP = "192.168.210.41" },
		func(s *Source) { s.Connection.Port = 1502 },
		func(s *Source) { s.Role = RoleNetz },
		func(s *Source) { s.Communication = inverter.CommModbusTCP },
	}
	seen := map[string]bool{id: true}
	for i, mutate := range variations {
		v := base
		mutate(&v)
		vid := DeterministicID(v)
		if seen[vid] {
			t.Fatalf("variation %d collides: %q", i, vid)
		}
		seen[vid] = true
	}

	// Solarman identity keys on the logger serial + slave id.
	sol := Source{Role: RoleErzeuger, Communication: inverter.CommSolarmanV5,
		Connection: inverter.Connection{IP: "192.168.254.210", Port: 8899,
			Serial: "2985159064", MbSlaveID: 1}}
	solOther := sol
	solOther.Connection.Serial = "2985159065"
	if DeterministicID(sol) == DeterministicID(solOther) {
		t.Fatalf("solarman serial must be part of the identity")
	}
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}

// A shelly consumer source is CORE-owned (single-writer: source poll, test and
// executor all live in internal/shelly), so the retained Node-RED config must
// never carry it - a forwarded entry would only produce the sources store's
// permanent NICHT-VERDRAHTET warning for a transport the flow has no reader
// for. Other sources in the same list are untouched.
func TestBusConfigExcludesCoreOwnedShellySources(t *testing.T) {
	shelly, err := Normalize(cat(), Request{
		Role:  RoleConsumer,
		Brand: inverter.BrandShelly, Model: inverter.FamShellyHTTP,
		Connection: inverter.Connection{IP: "192.168.0.60"},
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	shelly.ID = "src-shelly1"
	erz, _ := Normalize(cat(), erzeugerReq(), time.Now())
	erz.ID = "src-erz1"
	var m struct {
		Sources []map[string]any `json:"sources"`
	}
	if err := json.Unmarshal(BusConfig([]Source{shelly, erz}), &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Sources) != 1 || m.Sources[0]["id"] != "src-erz1" {
		t.Fatalf("shelly source must not reach Node-RED: %+v", m.Sources)
	}
}

// The Shelly switch channel is part of the transport identity (a 2PM is one
// box with two independent relays = two physical measurement points).
func TestDeterministicIDShellyChannelIsIdentity(t *testing.T) {
	base := Source{
		Role:          RoleConsumer,
		Communication: inverter.CommShellyHTTP,
		Connection:    inverter.Connection{IP: "192.168.0.60", Port: 80, Channel: 0},
	}
	other := base
	other.Connection.Channel = 1
	if DeterministicID(base) == DeterministicID(other) {
		t.Fatalf("channel must be identity: %q", DeterministicID(base))
	}
	if DeterministicID(base) != DeterministicID(base) {
		t.Fatalf("not deterministic")
	}
}

// K6: the leader statements round-trip, and a word this build does not know
// (a newer image wrote it, then a rollback) falls back to "not stated" - which
// refuses "Gerät regelt" - instead of becoming permission.
func TestBalanceLeaderStatementsPersistAndUnknownWordsFailClosed(t *testing.T) {
	dir := t.TempDir()
	bs, err := NewBalanceStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := BalanceSettings{PrimaryMeterLocation: "netzpunkt", FurtherStorage: "halten", ExportBackstop: "keiner"}
	if err := bs.Save(want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := bs.Load()
	if err != nil || !ok || got != want {
		t.Fatalf("round trip: %+v ok=%v err=%v", got, ok, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "balance.json"),
		[]byte(`{"primary_meter_location":"dach","further_storage":"halten"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, _, err = bs.Load()
	if err != nil || got.MeterLocation() != "unbekannt" || got.FurtherStorage != "" {
		t.Fatalf("an unknown word must fail closed: %+v err=%v", got, err)
	}
	if err := os.WriteFile(filepath.Join(dir, "balance.json"),
		[]byte(`{"primary_grid_not_site_total":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _, _ = bs.Load(); got.MeterLocation() != "woanders" {
		t.Fatalf("a legacy opt-out is the location \"woanders\": %+v", got)
	}
}
