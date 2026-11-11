package inverter

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// Pins the gap found on 04.11.2026 (Scout vp-kundenanlage-drei-geraete): the
// Huawei brand sat in the catalog with templates and a Node-RED decoder, but
// Normalize had no case for huawei_modbus and answered every Huawei form with
// "Unbekannte Kommunikationsmethode." - the portal test failed in 0 ms and a
// saved component would have been refused by the box.
func TestNormalizeHuaweiModbus(t *testing.T) {
	cat := DefaultCatalog()
	now := time.Date(2026, 11, 4, 20, 0, 0, 0, time.UTC)
	sel, err := cat.Normalize(SelectionRequest{Brand: BrandHuawei, Model: "sun2000-m1",
		Connection: Connection{IP: "192.168.178.60", UnitID: 1, InvertGridSign: true}}, now)
	if err != nil {
		t.Fatalf("Huawei SUN2000-M1 must normalize: %v", err)
	}
	if sel.Communication != CommHuaweiModbus || sel.Family != FamHuaweiSun2000Luna {
		t.Fatalf("communication/family = %q/%q", sel.Communication, sel.Family)
	}
	if sel.Connection.Port != 502 || sel.Connection.UnitID != 1 || !sel.Connection.InvertGridSign {
		t.Fatalf("connection = %+v", sel.Connection)
	}
	var bus map[string]any
	if err := json.Unmarshal(sel.BusPayload(), &bus); err != nil {
		t.Fatalf("bus payload: %v", err)
	}
	conn, _ := bus["connection"].(map[string]any)
	if conn["unit_id"] != float64(1) || conn["invert_grid_sign"] != true || conn["invert_batt_sign"] != false {
		t.Fatalf("bus payload connection = %+v", conn)
	}
	// Unit-ID 0 is Huawei's factory value on a direct connection and stays 0.
	sel0, err := cat.Normalize(SelectionRequest{Brand: BrandHuawei, Model: "sun2000-m1",
		Connection: Connection{IP: "192.168.178.60"}}, now)
	if err != nil || sel0.Connection.UnitID != 0 {
		t.Fatalf("unit 0 must stay 0: %+v %v", sel0.Connection, err)
	}
	if _, err := cat.Normalize(SelectionRequest{Brand: BrandHuawei, Model: "sun2000-m1",
		Connection: Connection{IP: "192.168.178.60", UnitID: 300}}, now); err == nil || !strings.Contains(err.Error(), "Unit-ID") {
		t.Fatalf("unit 300 must be refused, got %v", err)
	}
}
