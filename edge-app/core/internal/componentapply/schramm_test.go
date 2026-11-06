package componentapply

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The plant of Werner Schramm (06.11.2026) as the portal pushes it after the
// device search: three KACO Powador TL3 over SunSpec (the first as the plant's
// inverter, the others as further Erzeuger), a Shelly Pro 3EM-400 at the grid
// connection point and two Shelly Pro 3EM in sub-distributions. The cloud
// creates a meter in the consumer role as a measure-only generic-load - the
// box must read it as a consumer source instead of rejecting it.
func kacoDriver(model, ip string) string {
	return `{"brand":"kaco","model":"` + model + `","family":"sunspec_live","communication":"sunspec_tcp",
  "connection":{"ip":"` + ip + `","port":502,"unit_id":1,"model_type":"auto"}}`
}

func shellyMeterDriver(ip string, extra string) string {
	return `{"brand":"shelly","model":"shelly-pro-3em","family":"shelly_em_triphase","communication":"shelly_em_http",
  "connection":{"ip":"` + ip + `","port":80` + extra + `}}`
}

func TestSchrammPlantDerivesInverterErzeugerGridMeterAndSubMeters(t *testing.T) {
	plan, err := Derive(portal(
		ent("a0000000-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, kacoDriver("powador-14.0-tl3", "192.168.1.156")),
		ent("a0000000-0000-0000-0000-000000000002", entities.TypeProducer, kacoDriver("powador-20.0-tl3", "192.168.1.113")),
		ent("a0000000-0000-0000-0000-000000000003", entities.TypeProducer, kacoDriver("powador-20.0-tl3", "192.168.1.147")),
		ent("a0000000-0000-0000-0000-000000000004", entities.TypeGridMeter, shellyMeterDriver("192.168.1.146", "")),
		ent("a0000000-0000-0000-0000-000000000005", entities.TypeGenericLoad, shellyMeterDriver("192.168.1.111", "")),
		ent("a0000000-0000-0000-0000-000000000006", entities.TypeGenericLoad, shellyMeterDriver("192.168.1.121", `,"invert_grid_sign":true`)),
	), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Rejected) != 0 {
		t.Fatalf("nichts darf abgelehnt werden: %+v", plan.Rejected)
	}
	inv := plan.Inverter
	if inv == nil || inv.Communication != inverter.CommSunSpecTCP || inv.Family != inverter.FamSunSpecLive ||
		inv.Connection.IP != "192.168.1.156" || inv.Connection.UnitID != 1 {
		t.Fatalf("Wechselrichter: %+v", inv)
	}
	byIP := map[string]sources.Source{}
	for _, s := range plan.Sources {
		byIP[s.Connection.IP] = s
	}
	want := map[string]struct{ role, comm string }{
		"192.168.1.113": {sources.RoleErzeuger, inverter.CommSunSpecTCP},
		"192.168.1.147": {sources.RoleErzeuger, inverter.CommSunSpecTCP},
		"192.168.1.146": {sources.RoleNetz, inverter.CommShellyEMHTTP},
		"192.168.1.111": {sources.RoleConsumer, inverter.CommShellyEMHTTP},
		"192.168.1.121": {sources.RoleConsumer, inverter.CommShellyEMHTTP},
	}
	if len(plan.Sources) != len(want) {
		t.Fatalf("Quellen: %d, erwartet %d", len(plan.Sources), len(want))
	}
	for ip, w := range want {
		s, ok := byIP[ip]
		if !ok || s.Role != w.role || s.Communication != w.comm {
			t.Fatalf("%s: %+v, erwartet %s/%s", ip, s, w.role, w.comm)
		}
	}
	m := byIP["192.168.1.146"]
	if m.Model != inverter.ModelShellyPro3EM || m.Family != inverter.FamShellyEMTriphase || m.Connection.Port != 80 ||
		m.Connection.InvertGridSign || m.Connection.Channel != 0 {
		t.Fatalf("Netz-Zaehler: %+v", m)
	}
	if !byIP["192.168.1.121"].Connection.InvertGridSign {
		t.Fatalf("die Vorzeichen-Klappe muss die Normalisierung ueberleben")
	}
}

// A switch-only field never sneaks onto a meter: the channel and an output set
// are not part of this way.
func TestAShellyMeterDropsTheSwitchFields(t *testing.T) {
	plan, err := Derive(portal(
		ent("a0000000-0000-0000-0000-000000000004", entities.TypeGridMeter,
			shellyMeterDriver("192.168.1.146", `,"channel":2,"unit_id":7`)),
	), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	s := plan.Sources[0]
	if s.Connection.Channel != 0 || s.Connection.UnitID != 0 {
		t.Fatalf("Schalt-/Modbus-Felder am Zaehler: %+v", s.Connection)
	}
}

// A relay Shelly that is pushed as a plain measure-only load is still NOT
// read as a consumer: the exception is the meter's alone.
func TestARelayShellyStaysUnassignableAsAMeasureOnlyLoad(t *testing.T) {
	relay := `{"brand":"shelly","model":"shelly_http","family":"shelly_http","communication":"shelly_http",
  "connection":{"ip":"192.168.1.60","port":80,"channel":0}}`
	plan, err := Derive(portal(
		ent("a0000000-0000-0000-0000-000000000007", entities.TypeGenericLoad, relay),
		ent("a0000000-0000-0000-0000-000000000004", entities.TypeGridMeter, shellyMeterDriver("192.168.1.146", "")),
	), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Rejected) != 1 || plan.Rejected[0].EntityID != "a0000000-0000-0000-0000-000000000007" ||
		!strings.Contains(plan.Rejected[0].Reason, "Rolle") {
		t.Fatalf("Ablehnung: %+v", plan.Rejected)
	}
}
