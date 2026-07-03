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
	if sel.Connection.PowerScale != 1 {
		t.Errorf("default power scale: %v", sel.Connection.PowerScale)
	}
	if !sel.UpdatedAt.Equal(now) {
		t.Errorf("updated_at not stamped: %v", sel.UpdatedAt)
	}
	// modbus-only fields must not leak into a solarman selection.
	if sel.Connection.UnitID != 0 || sel.Connection.Profile != "" {
		t.Errorf("modbus fields leaked: %+v", sel.Connection)
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
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := cat.Normalize(c.req, now); err == nil {
				t.Fatalf("expected rejection")
			}
		})
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
