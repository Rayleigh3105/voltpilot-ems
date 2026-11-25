package inverter

import (
	"encoding/json"
	"testing"
	"time"
)

// A Deye over the Modbus TCP of its logger stick (field 25.11.2026: newer
// sticks offer no Solarman V5): the second way of every Deye model, Solarman
// stays the default, no logger serial, port 502 and unit 1 by default, the
// unit mirrored into mb_slave_id for the Deye read and control paths.
func TestDeyeUeberModbusTCPDesDatenloggers(t *testing.T) {
	cat := DefaultCatalog()
	b, ok := cat.brand(BrandDeye)
	if !ok {
		t.Fatal("deye")
	}
	for _, m := range b.Models {
		wege := b.TransportsFor(m)
		if len(wege) != 2 || wege[0] != CommSolarmanV5 || wege[1] != CommDeyeModbusTCP {
			t.Fatalf("%s: ways %v", m.ID, wege)
		}
	}
	now := time.Date(2026, 11, 25, 18, 0, 0, 0, time.UTC)
	sel, err := cat.Normalize(SelectionRequest{Brand: BrandDeye, Model: "sun-10k-sg04lp3",
		Connection: Connection{IP: "192.168.178.62", Transport: CommDeyeModbusTCP, Serial: "2985159064",
			InvertBattSign: true, RemoteMode: "off"}}, now)
	if err != nil {
		t.Fatalf("Deye over Modbus TCP rejected: %v", err)
	}
	if sel.Communication != CommDeyeModbusTCP || sel.Family != FamHybrid3p || sel.Connection.Port != 502 ||
		sel.Connection.UnitID != 1 || sel.Connection.MbSlaveID != 1 || sel.Connection.Serial != "" {
		t.Fatalf("selection: %+v", sel)
	}
	var bus struct {
		Communication string         `json:"communication"`
		Connection    map[string]any `json:"connection"`
	}
	if err := json.Unmarshal(sel.BusPayload(), &bus); err != nil {
		t.Fatal(err)
	}
	c := bus.Connection
	if bus.Communication != CommDeyeModbusTCP || c["ip"] != "192.168.178.62" || c["port"] != 502.0 ||
		c["unit_id"] != 1.0 || c["mb_slave_id"] != 1.0 || c["invert_batt_sign"] != true || c["remote_mode"] != "off" {
		t.Fatalf("bus payload: %+v", bus)
	}
	if _, ok := c["serial"]; ok {
		t.Fatalf("a logger serial on the Modbus TCP way: %+v", c)
	}

	// Another unit is taken; a unit outside 1..247 is refused.
	sel, err = cat.Normalize(SelectionRequest{Brand: BrandDeye, Model: "sun-10k-sg04lp3",
		Connection: Connection{IP: "192.168.178.62", Port: 1502, UnitID: 3, Transport: CommDeyeModbusTCP}}, now)
	if err != nil || sel.Connection.Port != 1502 || sel.Connection.MbSlaveID != 3 {
		t.Fatalf("unit 3: %+v, %v", sel, err)
	}
	if _, err := cat.Normalize(SelectionRequest{Brand: BrandDeye, Model: "sun-10k-sg04lp3",
		Connection: Connection{IP: "192.168.178.62", UnitID: 248, Transport: CommDeyeModbusTCP}}, now); err == nil {
		t.Fatal("unit 248 accepted")
	}

	// Without a choice it stays Solarman V5, which needs the logger serial.
	if _, err := cat.Normalize(SelectionRequest{Brand: BrandDeye, Model: "sun-10k-sg04lp3",
		Connection: Connection{IP: "192.168.178.62"}}, now); err == nil {
		t.Fatal("the default way needs the logger serial")
	}
	sel, err = cat.Normalize(SelectionRequest{Brand: BrandDeye, Model: "sun-10k-sg04lp3",
		Connection: Connection{IP: "192.168.178.34", Serial: "2985159064", UnitID: 7}}, now)
	if err != nil || sel.Communication != CommSolarmanV5 || sel.Connection.Port != 8899 || sel.Connection.UnitID != 0 {
		t.Fatalf("solarman: %+v, %v", sel, err)
	}
}
