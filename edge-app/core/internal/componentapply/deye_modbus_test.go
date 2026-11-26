package componentapply

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// A Deye created from its Modbus TCP template (the stick's Modbus TCP, field
// 25.11.2026): the cloud names the way only in the driver's communication -
// the box takes it as the chosen way instead of the model's Solarman default.
// The Solarman driver stays what it was.
func TestDeyeUeberModbusTCPAusDemPush(t *testing.T) {
	const drv = `{"brand":"deye","model":"sun-10k-sg04lp3","family":"hybrid_3p","communication":"deye_modbus_tcp",
		"connection":{"ip":"192.168.178.62","port":502,"unit_id":1}}`
	plan, err := Derive(portal(ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, drv)), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	inv := plan.Inverter
	if inv == nil || inv.Communication != inverter.CommDeyeModbusTCP || inv.Connection.Port != 502 ||
		inv.Connection.UnitID != 1 || inv.Connection.Serial != "" {
		t.Fatalf("Wechselrichter: %+v", inv)
	}
	plan, err = Derive(portal(ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver)), cat(), nil, now)
	if err != nil || plan.Inverter == nil || plan.Inverter.Communication != inverter.CommSolarmanV5 {
		t.Fatalf("Solarman: %+v, %v", plan.Inverter, err)
	}
}
