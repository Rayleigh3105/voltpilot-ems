package componentapply

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// Pins the push half of the gap found on 04.11.2026 (Scout
// vp-kundenanlage-drei-geraete): the Huawei brand sat in the catalog but
// Catalog.Normalize had no case for huawei_modbus, so Derive refused every
// pushed Huawei and the box never read it.
const huaweiDriver = `{"role":"inverter","brand":"huawei","model":"sun2000-m1",
  "family":"huawei_sun2000_luna","communication":"huawei_modbus",
  "connection":{"ip":"192.168.178.60","port":502,"unit_id":1,"invert_grid_sign":true}}`

func TestAPushedHuaweiDerivesTheInverterWithItsConnection(t *testing.T) {
	plan, err := Derive(portal(
		ent("5f0d2c9e-0000-0000-0000-0000000000a1", entities.TypeBatteryHybrid, huaweiDriver),
	), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive must accept a Huawei SUN2000: %v", err)
	}
	inv := plan.Inverter
	if inv == nil || inv.Brand != "huawei" || inv.Communication != inverter.CommHuaweiModbus ||
		inv.Family != inverter.FamHuaweiSun2000Luna {
		t.Fatalf("Wechselrichter falsch abgeleitet: %+v", inv)
	}
	if inv.Connection.Port != 502 || inv.Connection.UnitID != 1 || !inv.Connection.InvertGridSign {
		t.Fatalf("Verbindung falsch: %+v", inv.Connection)
	}
}

// The portal once sent "unit_id": "01" (text). The box refuses the WHOLE push
// and names the field - the API now keeps such a value out, this is the
// last-line proof on the box side.
func TestAHuaweiUnitIdAsTextRefusesThePushAndNamesTheField(t *testing.T) {
	bad := strings.Replace(huaweiDriver, `"unit_id":1`, `"unit_id":"01"`, 1)
	_, err := Derive(portal(
		ent("5f0d2c9e-0000-0000-0000-0000000000a1", entities.TypeBatteryHybrid, bad),
	), cat(), nil, now)
	if err == nil || !strings.Contains(err.Error(), "unit_id") {
		t.Fatalf("want a refusal naming unit_id, got %v", err)
	}
}
