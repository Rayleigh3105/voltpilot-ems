package inverter

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

var now = time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)

func TestNormalizeDeyeSolarmanDefaultsAndDerivation(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand:  BrandDeye,
		Family: "hybrid_3p",
		Connection: Connection{
			IP:     "192.168.0.28",
			Serial: "2985159064",
			// port, mb_slave_id, power_scale omitted -> defaults
			// (power_scale 0 = auto-detect the LV/HV scale from register 0x0000)
		},
	}, now)
	if err != nil {
		t.Fatalf("valid deye selection rejected: %v", err)
	}
	if sel.Communication != CommSolarmanV5 {
		t.Errorf("communication derived from brand: got %q", sel.Communication)
	}
	if sel.Label != "Deye · Hybrid, 3-phasig" {
		t.Errorf("label: %q", sel.Label)
	}
	if sel.Connection.Port != defaultSolarmanPort {
		t.Errorf("default port: %d", sel.Connection.Port)
	}
	if sel.Connection.MbSlaveID != 1 {
		t.Errorf("default slave id: %d", sel.Connection.MbSlaveID)
	}
	if sel.Connection.PowerScale != 0 {
		t.Errorf("default power scale should be 0 (auto-detect): %v", sel.Connection.PowerScale)
	}
	if !sel.UpdatedAt.Equal(now) {
		t.Errorf("updated_at not stamped: %v", sel.UpdatedAt)
	}
	// modbus-only fields must not leak into a solarman selection.
	if sel.Connection.UnitID != 0 || sel.Connection.Profile != "" {
		t.Errorf("modbus fields leaked: %+v", sel.Connection)
	}
}

func TestNormalizePerModelSelection(t *testing.T) {
	cat := DefaultCatalog()
	// The captain's plant: a 12 kW LV hybrid, selected by its exact model.
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye,
		Model: "sun-12k-sg04lp3",
		Connection: Connection{
			IP:     "192.168.0.28",
			Serial: "2985159064",
		},
	}, now)
	if err != nil {
		t.Fatalf("valid per-model selection rejected: %v", err)
	}
	if sel.Model != "sun-12k-sg04lp3" {
		t.Errorf("model not carried: %q", sel.Model)
	}
	if sel.Family != FamHybrid3p {
		t.Errorf("12k LV must resolve to the hybrid_3p register map, got %q", sel.Family)
	}
	if sel.Label != "Deye · SUN-12K-SG04LP3-EU" {
		t.Errorf("label should name the concrete model: %q", sel.Label)
	}
}

func TestModelDeterminesRegisterMapNotPhaseGrouping(t *testing.T) {
	cat := DefaultCatalog()
	cases := map[string]string{
		"sun-12k-sg04lp3":  FamHybrid3p, // LV 3-phase hybrid (captain)
		"sun-50k-sg01hp3":  FamHybrid3p, // HV 3-phase hybrid (same high map)
		"sun-3.6k-sg03lp1": FamHybrid1p, // single-phase hybrid
		"sun-8k-g03":       FamString,   // string grid-tie
		"sun600g3":         FamMicro,    // micro
	}
	for model, wantFam := range cases {
		conn := Connection{IP: "1.2.3.4", Serial: "s"}
		sel, err := cat.Normalize(SelectionRequest{Brand: BrandDeye, Model: model, Connection: conn}, now)
		if err != nil {
			t.Fatalf("model %s rejected: %v", model, err)
		}
		if sel.Family != wantFam {
			t.Errorf("model %s -> family %q, want %q", model, sel.Family, wantFam)
		}
	}
}

// TestRatedKwAndBatteryLookup: every Deye model carries a positive nameplate
// rating (the physical-envelope guard depends on it), the generic SunSpec entry
// has none, and battery families are correctly classified.
func TestRatedKwAndBatteryLookup(t *testing.T) {
	cat := DefaultCatalog()
	for _, b := range cat.Brands {
		for _, m := range b.Models {
			rated, ok := cat.RatedKw(b.ID, m.ID)
			if b.ID == BrandDeye {
				if !ok || rated <= 0 {
					t.Errorf("Deye model %q must have a positive rating, got %v ok=%v", m.ID, rated, ok)
				}
			}
		}
	}
	// The captain's 12 kW hybrid is a battery family with rating 12.
	if rated, ok := cat.RatedKw(BrandDeye, "sun-12k-sg04lp3"); !ok || rated != 12 {
		t.Fatalf("SUN-12K-SG04LP3 rating = %v ok=%v, want 12", rated, ok)
	}
	if !FamilyHasBattery(FamHybrid3p) || !FamilyHasBattery(FamHybrid1p) {
		t.Fatal("hybrid families must be battery families")
	}
	if FamilyHasBattery(FamString) || FamilyHasBattery(FamMicro) || FamilyHasBattery(FamSunSpec) {
		t.Fatal("string/micro/sunspec families must not be battery families")
	}
	// Batteryless = PROVABLY no battery (grid-tie generation only) - the house
	// balance may count battery power as a physical 0 there. Deliberately NOT
	// the complement of FamilyHasBattery: generic Modbus / Fronius Solar API
	// MAY carry a battery, so a missing battery reading there is "unknown".
	if !FamilyBatteryless(FamString) || !FamilyBatteryless(FamMicro) || !FamilyBatteryless(FamSunSpecLive) {
		t.Fatal("string/micro/sunspec_live must be provably batteryless")
	}
	if FamilyBatteryless(FamHybrid3p) || FamilyBatteryless(FamHybrid1p) ||
		FamilyBatteryless(FamSunSpec) || FamilyBatteryless(FamFroniusSolarAPI) || FamilyBatteryless("") {
		t.Fatal("hybrids/generic/fronius/unknown must NOT count as batteryless")
	}
	// The generic SunSpec model has no rating -> envelope inactive.
	if _, ok := cat.RatedKw(BrandGenericModbus, FamSunSpec); ok {
		t.Fatal("generic SunSpec must have no known rating")
	}
	// An unknown brand/model yields no rating.
	if _, ok := cat.RatedKw("nope", "nope"); ok {
		t.Fatal("unknown brand/model must have no rating")
	}
}

func TestEveryModelResolvesToAKnownRegisterFamily(t *testing.T) {
	cat := DefaultCatalog()
	for _, b := range cat.Brands {
		if len(b.Models) == 0 {
			t.Errorf("brand %s exposes no selectable models", b.ID)
		}
		seen := map[string]bool{}
		for _, m := range b.Models {
			if m.ID == "" || m.Label == "" || m.Family == "" {
				t.Errorf("brand %s model %+v has an empty id/label/family", b.ID, m)
			}
			if seen[m.ID] {
				t.Errorf("brand %s has a duplicate model id %q", b.ID, m.ID)
			}
			seen[m.ID] = true
			if _, ok := b.family(m.Family); !ok {
				t.Errorf("brand %s model %q maps to unknown register family %q", b.ID, m.ID, m.Family)
			}
		}
	}
}

func TestNormalizeRejectsUnknownAndMissingModel(t *testing.T) {
	cat := DefaultCatalog()
	if _, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-999k-imaginary",
		Connection: Connection{IP: "1.2.3.4", Serial: "s"},
	}, now); err == nil {
		t.Fatal("unknown model must be rejected")
	}
	if _, err := cat.Normalize(SelectionRequest{
		Brand:      BrandDeye,
		Connection: Connection{IP: "1.2.3.4", Serial: "s"},
	}, now); err == nil {
		t.Fatal("a request with neither model nor family must be rejected")
	}
}

func TestBusPayloadCarriesModelAndFamily(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-12k-sg04lp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	// `model` is additive; `family` stays the Node-RED routing key (unchanged).
	if m["model"] != "sun-12k-sg04lp3" {
		t.Errorf("payload model: %v", m["model"])
	}
	if m["family"] != FamHybrid3p {
		t.Errorf("payload family (routing key) must stay the register map: %v", m["family"])
	}
	if m["schema_version"] != SchemaVersion {
		t.Errorf("schema version unchanged (additive change): %v", m["schema_version"])
	}
	// control_tier is additive: a Deye is Tier 3 (Time-of-Use). JSON numbers decode
	// as float64.
	if tier, _ := m["control_tier"].(float64); int(tier) != ControlTierToU {
		t.Errorf("payload control_tier: Deye must be Tier 3 (ToU), got %v", m["control_tier"])
	}
	if sel.ControlTier != ControlTierToU {
		t.Errorf("selection control_tier: %d", sel.ControlTier)
	}
}

// TestControlSignIsPreservedAndPublished proves the WRITE-path control sign the
// First-Light calibration step sets on the Deye connection survives Normalize and
// reaches the Node-RED control adapter via the retained edge/inverter/config.
func TestControlSignIsPreservedAndPublished(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-12k-sg04lp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064", InvertControlSign: true, PowerScale: 10},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !sel.Connection.InvertControlSign {
		t.Fatal("Normalize must preserve invert_control_sign on a solarman selection")
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	conn, _ := m["connection"].(map[string]any)
	if conn["invert_control_sign"] != true {
		t.Errorf("edge/inverter/config must carry invert_control_sign=true, got %v", conn["invert_control_sign"])
	}
	if conn["power_scale"].(float64) != 10 {
		t.Errorf("power_scale must be published for the control scale, got %v", conn["power_scale"])
	}

	// The read-only go-e transport must NOT carry a control sign (meaningless there).
	sel2, err := cat.Normalize(SelectionRequest{
		Brand: BrandGoe, Family: FamGoeHTTP,
		Connection: Connection{IP: "10.0.0.9", InvertControlSign: true},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if sel2.Connection.InvertControlSign {
		t.Error("a read-only go-e source must not keep a control sign")
	}
}

// TestReadBattSignIsPreservedAndPublished pins the READ-side battery-sign plumbing
// that closes the First-Light verdict hole: without invert_batt_sign reaching the
// SELF-WIRING path, a Deye whose raw battery register reports charge as negative
// (the captain's SUN-30K-SG01HP3-EU HV firmware) published an inverted
// battery_power_kw that the calibration verdict then trusted. The flag must survive
// Normalize on solarman and be published on edge/inverter/config so the Node-RED
// Deye reader (which already forwards conn.invert_batt_sign) can honor it. It is the
// read-side twin of invert_control_sign and must NOT leak onto other transports.
func TestReadBattSignIsPreservedAndPublished(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064", InvertBattSign: true},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !sel.Connection.InvertBattSign {
		t.Fatal("Normalize must preserve invert_batt_sign on a solarman selection")
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	conn, _ := m["connection"].(map[string]any)
	if conn["invert_batt_sign"] != true {
		t.Errorf("edge/inverter/config must carry invert_batt_sign=true so the self-wiring reader can honor it, got %v", conn["invert_batt_sign"])
	}

	// The read-side battery sign is meaningless on transports without a hybrid
	// battery register here (generic Modbus / Fronius / go-e) - it must be dropped.
	for _, tc := range []struct {
		name string
		req  SelectionRequest
	}{
		{"generic modbus", SelectionRequest{Brand: BrandGenericModbus, Family: FamSunSpec, Connection: Connection{IP: "10.0.0.9", InvertBattSign: true}}},
		{"fronius solar api", SelectionRequest{Brand: BrandFronius, Family: FamFroniusSolarAPI, Connection: Connection{IP: "10.0.0.9", InvertBattSign: true}}},
		{"go-e", SelectionRequest{Brand: BrandGoe, Family: FamGoeHTTP, Connection: Connection{IP: "10.0.0.9", InvertBattSign: true}}},
	} {
		s, err := cat.Normalize(tc.req, now)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if s.Connection.InvertBattSign {
			t.Errorf("%s: a transport without a hybrid battery register must not keep invert_batt_sign", tc.name)
		}
	}
}

// TestControlWriteFcIsPreservedAndPublished pins the control WRITE-function-code
// switch (the fix for the Deye that ignores an FC6 write): the field must survive
// Normalize on solarman, reach edge/inverter/config so the Node-RED control adapter
// can honor it, default to 0 (auto -> FC16 for Deye), validate to {0,6,16}, and NOT
// leak onto the other transports (Deye/Solarman only).
func TestControlWriteFcIsPreservedAndPublished(t *testing.T) {
	cat := DefaultCatalog()

	// default (absent) stays 0 = auto -> FC16 downstream.
	def, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064"},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if def.Connection.ControlWriteFc != 0 {
		t.Errorf("default control_write_fc should be 0 (auto -> FC16), got %v", def.Connection.ControlWriteFc)
	}

	// an explicit FC6 flip-back is preserved and published.
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064", ControlWriteFc: 6},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if sel.Connection.ControlWriteFc != 6 {
		t.Fatal("Normalize must preserve control_write_fc=6 on a solarman selection")
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	conn, _ := m["connection"].(map[string]any)
	if conn["control_write_fc"].(float64) != 6 {
		t.Errorf("edge/inverter/config must carry control_write_fc=6 so the adapter can flip back to FC6, got %v", conn["control_write_fc"])
	}

	// FC16 is accepted explicitly too; a garbage code is rejected.
	if _, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064", ControlWriteFc: 16},
	}, now); err != nil {
		t.Errorf("control_write_fc=16 must be accepted: %v", err)
	}
	if _, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.0.28", Serial: "2985159064", ControlWriteFc: 3},
	}, now); err == nil {
		t.Error("control_write_fc=3 (not 0/6/16) must be rejected")
	}

	// The control write-FC is meaningless on transports without the Deye control
	// path - it must be dropped, exactly like invert_batt_sign.
	for _, tc := range []struct {
		name string
		req  SelectionRequest
	}{
		{"generic modbus", SelectionRequest{Brand: BrandGenericModbus, Family: FamSunSpec, Connection: Connection{IP: "10.0.0.9", ControlWriteFc: 6}}},
		{"fronius solar api", SelectionRequest{Brand: BrandFronius, Family: FamFroniusSolarAPI, Connection: Connection{IP: "10.0.0.9", ControlWriteFc: 6}}},
		{"go-e", SelectionRequest{Brand: BrandGoe, Family: FamGoeHTTP, Connection: Connection{IP: "10.0.0.9", ControlWriteFc: 6}}},
	} {
		s, err := cat.Normalize(tc.req, now)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if s.Connection.ControlWriteFc != 0 {
			t.Errorf("%s: a transport without the Deye control path must not keep control_write_fc", tc.name)
		}
	}
}

// TestControlTierPerBrand pins the battery-control primitive each catalogued brand
// declares - the dispatch fact the Node-RED controlRoute keys on. Deye=ToU(3),
// generic SunSpec + both Fronius brands = SunSpec(1), the go-e wallbox = read-only
// (its control lives in the certified Go core executor, not controlRoute).
func TestControlTierPerBrand(t *testing.T) {
	cat := DefaultCatalog()
	want := map[string]int{
		BrandDeye:           ControlTierToU,
		BrandGenericModbus:  ControlTierSunSpec,
		BrandFronius:        ControlTierSunSpec,
		BrandFroniusSunSpec: ControlTierSunSpec,
		BrandGoe:            ControlTierReadOnly,
	}
	for _, b := range cat.Brands {
		w, ok := want[b.ID]
		if !ok {
			t.Fatalf("uncatalogued brand %q - add its control_tier expectation", b.ID)
		}
		if b.ControlTier != w {
			t.Errorf("brand %q control_tier = %d, want %d", b.ID, b.ControlTier, w)
		}
	}
}

func TestNormalizeSolarmanRequiresSerial(t *testing.T) {
	cat := DefaultCatalog()
	_, err := cat.Normalize(SelectionRequest{
		Brand:      BrandDeye,
		Family:     "hybrid_3p",
		Connection: Connection{IP: "192.168.0.28"},
	}, now)
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("missing serial must be a ValidationError, got %v", err)
	}
}

func TestNormalizeGenericModbus(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand:      BrandGenericModbus,
		Family:     "sunspec",
		Connection: Connection{IP: "192.168.0.50"},
	}, now)
	if err != nil {
		t.Fatalf("valid generic selection rejected: %v", err)
	}
	if sel.Communication != CommModbusTCP {
		t.Errorf("communication: %q", sel.Communication)
	}
	if sel.Connection.Port != defaultModbusPort {
		t.Errorf("default modbus port: %d", sel.Connection.Port)
	}
	if sel.Connection.UnitID != 1 {
		t.Errorf("default unit id: %d", sel.Connection.UnitID)
	}
	if sel.Connection.Profile != "sunspec" {
		t.Errorf("profile derived from family: %q", sel.Connection.Profile)
	}
	// solarman-only fields must not leak.
	if sel.Connection.Serial != "" || sel.Connection.PowerScale != 0 {
		t.Errorf("solarman fields leaked: %+v", sel.Connection)
	}
}

func TestNormalizeFronius(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand:      BrandFronius,
		Model:      FamFroniusSolarAPI,
		Connection: Connection{IP: "192.168.0.20"}, // port/insecure_tls omitted -> defaults
	}, now)
	if err != nil {
		t.Fatalf("valid fronius selection rejected: %v", err)
	}
	if sel.Communication != CommFroniusSolarAPI {
		t.Errorf("communication derived from brand: %q", sel.Communication)
	}
	if sel.Family != FamFroniusSolarAPI {
		t.Errorf("family: %q", sel.Family)
	}
	if sel.Connection.Port != defaultFroniusPort {
		t.Errorf("default fronius port: %d", sel.Connection.Port)
	}
	// no serial / unit id / power scale for the Solar API.
	if sel.Connection.Serial != "" || sel.Connection.MbSlaveID != 0 ||
		sel.Connection.UnitID != 0 || sel.Connection.Profile != "" || sel.Connection.PowerScale != 0 {
		t.Errorf("cross-transport fields leaked: %+v", sel.Connection)
	}

	// the escape hatches (insecure_tls + invert_grid_sign) are carried through.
	sel2, err := cat.Normalize(SelectionRequest{
		Brand: BrandFronius, Model: FamFroniusSolarAPI,
		Connection: Connection{IP: "10.0.0.7", Port: 443, InsecureTLS: true, InvertGridSign: true},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if !sel2.Connection.InsecureTLS || !sel2.Connection.InvertGridSign || sel2.Connection.Port != 443 {
		t.Errorf("fronius escape hatches not carried: %+v", sel2.Connection)
	}
}

func TestFroniusBrandInCatalog(t *testing.T) {
	cat := DefaultCatalog()
	b, ok := cat.brand(BrandFronius)
	if !ok {
		t.Fatal("Fronius brand missing from catalog")
	}
	if b.Communication != CommFroniusSolarAPI {
		t.Errorf("fronius communication: %q", b.Communication)
	}
	if len(b.Models) != 1 || b.Models[0].Family != FamFroniusSolarAPI {
		t.Errorf("fronius models: %+v", b.Models)
	}
	// froniusFields: host required, port default 80, insecure_tls checkbox, no serial/unit_id/auth.
	keys := map[string]Field{}
	for _, f := range b.Fields {
		keys[f.Key] = f
	}
	if f, ok := keys["ip"]; !ok || !f.Required {
		t.Errorf("fronius must require a host field")
	}
	if f, ok := keys["port"]; !ok || f.Default != defaultFroniusPort {
		t.Errorf("fronius port default: %+v", keys["port"])
	}
	if f, ok := keys["insecure_tls"]; !ok || f.Type != "checkbox" {
		t.Errorf("fronius insecure_tls checkbox: %+v", f)
	}
	for _, forbidden := range []string{"serial", "unit_id", "mb_slave_id", "password"} {
		if _, ok := keys[forbidden]; ok {
			t.Errorf("fronius must NOT expose %q (Solar API needs no such field)", forbidden)
		}
	}
}

func TestBusPayloadFroniusShape(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandFronius, Model: FamFroniusSolarAPI,
		Connection: Connection{IP: "192.168.0.20", InsecureTLS: true, InvertGridSign: true},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	if m["communication"] != CommFroniusSolarAPI || m["family"] != FamFroniusSolarAPI {
		t.Fatalf("fronius payload top-level: %v", m)
	}
	conn := m["connection"].(map[string]any)
	if conn["ip"] != "192.168.0.20" || conn["port"].(float64) != defaultFroniusPort ||
		conn["insecure_tls"] != true || conn["invert_grid_sign"] != true {
		t.Fatalf("fronius connection: %v", conn)
	}
	// cross-transport keys must be absent from a fronius payload.
	for _, forbidden := range []string{"serial", "mb_slave_id", "power_scale", "unit_id", "profile"} {
		if _, ok := conn[forbidden]; ok {
			t.Fatalf("%q must not appear in fronius payload: %v", forbidden, conn)
		}
	}
}

func TestNormalizeFroniusSunSpec(t *testing.T) {
	cat := DefaultCatalog()
	// The captain's Eco, selected by model, over SunSpec Modbus TCP.
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandFroniusSunSpec,
		Model: "fronius-eco-27-3-s",
		// port / unit_id / model_type omitted -> defaults (502 / 1 / auto)
		Connection: Connection{IP: "192.168.210.40"},
	}, now)
	if err != nil {
		t.Fatalf("valid fronius sunspec selection rejected: %v", err)
	}
	if sel.Communication != CommFroniusSunSpec {
		t.Errorf("communication derived from brand: %q", sel.Communication)
	}
	if sel.Family != FamSunSpecLive {
		t.Errorf("family must be the sunspec_live profile: %q", sel.Family)
	}
	if sel.Label != "Fronius (Modbus / SunSpec) · Fronius Eco 27.0-3-S" {
		t.Errorf("label should name the concrete model: %q", sel.Label)
	}
	if sel.Connection.Port != defaultFroniusSunSpecPort {
		t.Errorf("default port 502: %d", sel.Connection.Port)
	}
	if sel.Connection.UnitID != 1 {
		t.Errorf("default unit id 1: %d", sel.Connection.UnitID)
	}
	if sel.Connection.ModelType != "auto" {
		t.Errorf("default model_type auto: %q", sel.Connection.ModelType)
	}
	if sel.Connection.Profile != FamSunSpecLive {
		t.Errorf("profile derived from family: %q", sel.Connection.Profile)
	}
	// cross-transport fields must not leak.
	if sel.Connection.Serial != "" || sel.Connection.MbSlaveID != 0 ||
		sel.Connection.PowerScale != 0 || sel.Connection.InsecureTLS {
		t.Errorf("cross-transport fields leaked: %+v", sel.Connection)
	}

	// A configured unit id + explicit model_type + invert_grid_sign are carried.
	sel2, err := cat.Normalize(SelectionRequest{
		Brand: BrandFroniusSunSpec, Model: "fronius-eco-27-3-s",
		Connection: Connection{IP: "10.0.0.40", UnitID: 2, ModelType: "float", InvertGridSign: true},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if sel2.Connection.UnitID != 2 || sel2.Connection.ModelType != "float" || !sel2.Connection.InvertGridSign {
		t.Errorf("sunspec fields not carried: %+v", sel2.Connection)
	}

	// The Eco carries a 27 kW rating so the physical-envelope guard engages.
	if rated, ok := cat.RatedKw(BrandFroniusSunSpec, "fronius-eco-27-3-s"); !ok || rated != 27 {
		t.Fatalf("Eco 27.0-3-S rating = %v ok=%v, want 27", rated, ok)
	}
	// The generic SunSpec Fronius entry has no rating -> envelope inactive.
	if _, ok := cat.RatedKw(BrandFroniusSunSpec, FamSunSpecLive); ok {
		t.Fatal("generic Fronius SunSpec entry must have no known rating")
	}
	// A bad model_type is rejected.
	if _, err := cat.Normalize(SelectionRequest{
		Brand: BrandFroniusSunSpec, Model: "fronius-eco-27-3-s",
		Connection: Connection{IP: "10.0.0.40", ModelType: "nonsense"},
	}, now); err == nil {
		t.Fatal("bad model_type must be rejected")
	}
}

func TestBusPayloadFroniusSunSpecShape(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandFroniusSunSpec, Model: "fronius-eco-27-3-s",
		Connection: Connection{IP: "192.168.210.40", UnitID: 1, ModelType: "float", InvertGridSign: true},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	if m["communication"] != CommFroniusSunSpec || m["family"] != FamSunSpecLive {
		t.Fatalf("fronius sunspec payload top-level: %v", m)
	}
	conn := m["connection"].(map[string]any)
	if conn["unit_id"].(float64) != 1 || conn["profile"] != FamSunSpecLive ||
		conn["model_type"] != "float" || conn["invert_grid_sign"] != true {
		t.Fatalf("fronius sunspec connection: %v", conn)
	}
	// cross-transport keys must be absent.
	for _, forbidden := range []string{"serial", "mb_slave_id", "power_scale", "insecure_tls"} {
		if _, ok := conn[forbidden]; ok {
			t.Fatalf("%q must not appear in fronius sunspec payload: %v", forbidden, conn)
		}
	}
}

func TestNormalizeRejects(t *testing.T) {
	cat := DefaultCatalog()
	cases := []struct {
		name string
		req  SelectionRequest
	}{
		{"unknown brand", SelectionRequest{Brand: "nope", Family: "x", Connection: Connection{IP: "1.2.3.4"}}},
		{"unknown family", SelectionRequest{Brand: BrandDeye, Family: "nope", Connection: Connection{IP: "1.2.3.4", Serial: "s"}}},
		{"missing ip", SelectionRequest{Brand: BrandGenericModbus, Family: "sunspec"}},
		{"bad port", SelectionRequest{Brand: BrandGenericModbus, Family: "sunspec", Connection: Connection{IP: "1.2.3.4", Port: 70000}}},
		{"bad power scale", SelectionRequest{Brand: BrandDeye, Family: "hybrid_3p", Connection: Connection{IP: "1.2.3.4", Serial: "s", PowerScale: 3}}},
		{"bad slave id", SelectionRequest{Brand: BrandDeye, Family: "hybrid_3p", Connection: Connection{IP: "1.2.3.4", Serial: "s", MbSlaveID: 999}}},
		{"fronius missing host", SelectionRequest{Brand: BrandFronius, Model: FamFroniusSolarAPI}},
		{"fronius bad port", SelectionRequest{Brand: BrandFronius, Model: FamFroniusSolarAPI, Connection: Connection{IP: "1.2.3.4", Port: 70000}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := cat.Normalize(c.req, now); err == nil {
				t.Fatalf("expected rejection")
			}
		})
	}
}

func TestNormalizeAcceptsPowerScaleAutoAndOverrides(t *testing.T) {
	cat := DefaultCatalog()
	// 0 = auto-detect (default), 1 and 10 are explicit manual overrides.
	for _, ps := range []float64{0, 1, 10} {
		sel, err := cat.Normalize(SelectionRequest{
			Brand:  BrandDeye,
			Family: "hybrid_3p",
			Connection: Connection{
				IP: "192.168.0.28", Serial: "2985159064", PowerScale: ps,
			},
		}, now)
		if err != nil {
			t.Fatalf("power_scale %v rejected: %v", ps, err)
		}
		if sel.Connection.PowerScale != ps {
			t.Errorf("power_scale %v not preserved: got %v", ps, sel.Connection.PowerScale)
		}
	}
}

func TestBusPayloadSolarmanShape(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand:  BrandDeye,
		Family: "hybrid_3p",
		Connection: Connection{
			IP: "192.168.0.28", Serial: "2985159064", PowerScale: 10, InvertGridSign: true,
		},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	if m["schema_version"] != SchemaVersion || m["brand"] != BrandDeye ||
		m["communication"] != CommSolarmanV5 || m["family"] != "hybrid_3p" {
		t.Fatalf("payload top-level: %v", m)
	}
	conn := m["connection"].(map[string]any)
	if conn["serial"] != "2985159064" || conn["power_scale"].(float64) != 10 ||
		conn["invert_grid_sign"] != true || conn["mb_slave_id"].(float64) != 1 {
		t.Fatalf("solarman connection: %v", conn)
	}
	// modbus-only keys must be absent from a solarman payload.
	if _, ok := conn["unit_id"]; ok {
		t.Fatalf("unit_id must not appear in solarman payload: %v", conn)
	}
	if _, ok := conn["profile"]; ok {
		t.Fatalf("profile must not appear in solarman payload: %v", conn)
	}
}

func TestBusPayloadModbusShape(t *testing.T) {
	cat := DefaultCatalog()
	sel, _ := cat.Normalize(SelectionRequest{
		Brand: BrandGenericModbus, Family: "sunspec",
		Connection: Connection{IP: "192.168.0.50", UnitID: 3},
	}, now)
	var m map[string]any
	_ = json.Unmarshal(sel.BusPayload(), &m)
	conn := m["connection"].(map[string]any)
	if conn["unit_id"].(float64) != 3 || conn["profile"] != "sunspec" {
		t.Fatalf("modbus connection: %v", conn)
	}
	if _, ok := conn["serial"]; ok {
		t.Fatalf("serial must not appear in modbus payload: %v", conn)
	}
}

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.Load(); err != nil || ok {
		t.Fatalf("empty store: ok=%v err=%v", ok, err)
	}
	sel, _ := DefaultCatalog().Normalize(SelectionRequest{
		Brand: BrandDeye, Family: "hybrid_1p",
		Connection: Connection{IP: "10.0.0.5", Serial: "123"},
	}, now)
	if err := st.Save(sel); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.Load()
	if err != nil || !ok {
		t.Fatalf("load after save: ok=%v err=%v", ok, err)
	}
	if got.Brand != sel.Brand || got.Family != sel.Family ||
		got.Connection.Serial != "123" || got.Communication != CommSolarmanV5 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

// The go-e Charger (wallbox) is a read-only CONSUMER driver: it must appear in
// the catalog as its own brand with the goe_http_api communication, and Normalize
// must produce a clean http-only selection (no serial/unit-id/sign fields) that
// BusPayload publishes as just ip+port.
func TestGoeCharger_CatalogNormalizeAndBusPayload(t *testing.T) {
	cat := DefaultCatalog()

	var b Brand
	found := false
	for _, x := range cat.Brands {
		if x.ID == BrandGoe {
			b = x
			found = true
		}
	}
	if !found {
		t.Fatal("go-e brand missing from DefaultCatalog")
	}
	if b.Communication != CommGoeHTTP {
		t.Fatalf("go-e communication = %q, want %q", b.Communication, CommGoeHTTP)
	}
	if len(b.Models) != 1 || b.Models[0].Family != FamGoeHTTP {
		t.Fatalf("go-e models = %+v, want one generic goe_http_api model", b.Models)
	}
	if b.Models[0].RatedKw != 0 {
		t.Fatalf("go-e model must carry no RatedKw (envelope stays inactive), got %v", b.Models[0].RatedKw)
	}

	sel, err := cat.Normalize(SelectionRequest{
		Brand:      BrandGoe,
		Model:      FamGoeHTTP,
		Connection: Connection{IP: "192.168.1.42"},
	}, now)
	if err != nil {
		t.Fatalf("Normalize go-e: %v", err)
	}
	if sel.Communication != CommGoeHTTP || sel.Family != FamGoeHTTP {
		t.Fatalf("normalized go-e = %+v", sel)
	}
	if sel.Connection.Port != 80 {
		t.Fatalf("default go-e port = %d, want 80", sel.Connection.Port)
	}
	// http-only transport: no serial / unit id / sign / profile leak through.
	if sel.Connection.Serial != "" || sel.Connection.UnitID != 0 || sel.Connection.Profile != "" ||
		sel.Connection.InvertGridSign || sel.Connection.PowerScale != 0 {
		t.Fatalf("go-e selection carries foreign transport fields: %+v", sel.Connection)
	}

	var payload map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["communication"] != CommGoeHTTP {
		t.Fatalf("bus payload communication = %v", payload["communication"])
	}
	conn, _ := payload["connection"].(map[string]any)
	if conn == nil || conn["ip"] != "192.168.1.42" {
		t.Fatalf("bus payload connection = %+v", payload["connection"])
	}
	// go-e is a lean http transport: only ip+port in the published connection.
	if _, ok := conn["serial"]; ok {
		t.Fatalf("go-e bus connection must not carry serial: %+v", conn)
	}

	// go-e has no nameplate rating -> the physical-envelope guard stays inactive.
	if _, ok := cat.RatedKw(BrandGoe, FamGoeHTTP); ok {
		t.Fatal("go-e must have no RatedKw")
	}
}

// TestRemoteModeFieldsAndRatedKwArePublished pins the wiring the Deye REMOTE-MODE
// control path needs from the core (registers 1100-1121):
//   - rated_kw: the setpoint register 1109 is 0.1 % of RATED power, so without the
//     model nameplate the control adapter cannot compute a value and refuses. It
//     must come from the CATALOG, never a hardcoded number.
//   - remote_mode / remote_watchdog_s: the operator's force-ToU hatch and the
//     inverter's own dead-man's timeout, published so the SELF-WIRING path carries
//     them (the invert_batt_sign / control_write_fc precedent).
func TestRemoteModeFieldsAndRatedKwArePublished(t *testing.T) {
	cat := DefaultCatalog()

	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.254.210", Serial: "1127365518"},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if sel.RatedKw != 30 {
		t.Fatalf("rated_kw must come from the catalog model, got %v", sel.RatedKw)
	}
	if sel.Connection.RemoteMode != "auto" {
		t.Fatalf("remote mode defaults to auto-detect, got %q", sel.Connection.RemoteMode)
	}
	if sel.Connection.RemoteWatchdogS != 0 {
		t.Fatalf("watchdog defaults to 0 = the adapter's documented 60 s, got %v", sel.Connection.RemoteWatchdogS)
	}

	var m map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &m); err != nil {
		t.Fatal(err)
	}
	if got, _ := m["rated_kw"].(float64); got != 30 {
		t.Fatalf("rated_kw must be published on the retained selection, got %v", m["rated_kw"])
	}
	conn, _ := m["connection"].(map[string]any)
	if conn["remote_mode"] != "auto" {
		t.Fatalf("remote_mode must be published, got %v", conn["remote_mode"])
	}
	if _, ok := conn["remote_watchdog_s"]; !ok {
		t.Fatal("remote_watchdog_s must be published so the adapter can honour it")
	}

	// An operator override round-trips.
	tuned, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-12k-sg04lp3",
		Connection: Connection{IP: "10.0.0.9", Serial: "123", RemoteMode: "off", RemoteWatchdogS: 120},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if tuned.Connection.RemoteMode != "off" || tuned.Connection.RemoteWatchdogS != 120 {
		t.Fatalf("operator override lost: %+v", tuned.Connection)
	}
	if tuned.RatedKw != 12 {
		t.Fatalf("rated_kw follows the selected model, got %v", tuned.RatedKw)
	}

	// The watchdog can never be disabled or set outside the protocol's range from
	// config - the whole safety argument of the remote path is that it exists.
	for _, bad := range []int{5, 9, 18001, 0xffff} {
		if _, err := cat.Normalize(SelectionRequest{
			Brand: BrandDeye, Model: "sun-30k-sg01hp3",
			Connection: Connection{IP: "10.0.0.9", Serial: "123", RemoteWatchdogS: bad},
		}, now); err == nil {
			t.Fatalf("watchdog %d must be rejected", bad)
		}
	}
	if _, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "10.0.0.9", Serial: "123", RemoteMode: "nonsense"},
	}, now); err == nil {
		t.Fatal("an unknown remote_mode must be rejected")
	}

	// The fields belong to the Deye transport ONLY - another transport clears them
	// and publishes no rated_kw-derived remote config.
	other, err := cat.Normalize(SelectionRequest{
		Brand: BrandGenericModbus, Model: FamSunSpec,
		Connection: Connection{IP: "10.0.0.5", RemoteMode: "off", RemoteWatchdogS: 120},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	if other.Connection.RemoteMode != "" || other.Connection.RemoteWatchdogS != 0 {
		t.Fatalf("remote-mode fields must be cleared on a non-Deye transport: %+v", other.Connection)
	}
	var om map[string]any
	if err := json.Unmarshal(other.BusPayload(), &om); err != nil {
		t.Fatal(err)
	}
	oc, _ := om["connection"].(map[string]any)
	if _, ok := oc["remote_mode"]; ok {
		t.Fatal("remote_mode must not be published on a non-Deye transport")
	}

	// The Deye form offers both as catalog data, so no front-end change is needed.
	var brand Brand
	for _, b := range cat.Brands {
		if b.ID == BrandDeye {
			brand = b
		}
	}
	keys := map[string]bool{}
	for _, f := range brand.Fields {
		keys[f.Key] = true
	}
	for _, k := range []string{"remote_mode", "remote_watchdog_s"} {
		if !keys[k] {
			t.Fatalf("the Deye connection form must offer %q", k)
		}
	}
}
