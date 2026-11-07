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

func pikoDriver(ip string) string {
	return `{"brand":"kostal","model":"piko-20","family":"kostal_piko","communication":"kostal_dxs",
  "connection":{"ip":"` + ip + `","port":80}}`
}

// The KOSTAL PIKO 20 Schramm added on 07.11.2026 as a further Erzeuger, next to
// a device whose transport the box's source reader does NOT wire (Fronius over
// its Solar API on Edge Light). With the reader's answer (Options.SourceReads)
// the box applies everything it reads and reports the other device by id with
// the reader's reason - the portal shows that instead of "wartet auf die ersten
// Daten". Without it (the Docker box: the flow reads the sources) nothing
// changes: both are applied.
func TestASourceTheReaderDoesNotWireIsReportedNotApplied(t *testing.T) {
	const piko, fronius = "a0000000-0000-0000-0000-000000000007", "a0000000-0000-0000-0000-000000000008"
	reg := portal(
		ent("a0000000-0000-0000-0000-000000000002", entities.TypeProducer, kacoDriver("powador-20.0-tl3", "192.168.1.113")),
		ent("a0000000-0000-0000-0000-000000000004", entities.TypeGridMeter, shellyMeterDriver("192.168.1.146", "")),
		ent(piko, entities.TypeProducer, pikoDriver("192.168.1.122")),
		ent(fronius, entities.TypeProducer, `{"brand":"fronius","model":"fronius_solar_api","family":"fronius_solar_api",
  "communication":"fronius_solar_api","connection":{"ip":"192.168.1.130","port":80}}`),
	)
	var asked []string
	reads := func(comm, role string) string {
		asked = append(asked, comm+"/"+role)
		if comm == inverter.CommFroniusSolarAPI {
			return `Edge Light liest die Anbindung "fronius_solar_api" als Energiequelle noch nicht`
		}
		return ""
	}
	plan, err := DeriveWith(reg, cat(), nil, now, Options{SourceReads: reads})
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if len(plan.Rejected) != 1 || plan.Rejected[0].EntityID != fronius ||
		!strings.Contains(plan.Rejected[0].Reason, "fronius_solar_api") {
		t.Fatalf("genau der Fronius wird gemeldet: %+v", plan.Rejected)
	}
	if len(plan.Sources) != 3 {
		t.Fatalf("KACO, Netz-Zaehler und PIKO laufen: %+v", plan.Sources)
	}
	var pikoSrc *sources.Source
	for i, s := range plan.Sources {
		if s.Communication == inverter.CommKostalDxs {
			pikoSrc = &plan.Sources[i]
		}
	}
	if pikoSrc == nil || pikoSrc.Role != sources.RoleErzeuger || pikoSrc.Connection.IP != "192.168.1.122" ||
		plan.SourceEntities[pikoSrc.ID] != piko {
		t.Fatalf("PIKO als Erzeuger: %+v", pikoSrc)
	}
	if len(asked) != 4 {
		t.Fatalf("jede Quelle wird gefragt, der Wechselrichter nie: %v", asked)
	}

	plain, err := Derive(reg, cat(), nil, now)
	if err != nil || len(plain.Rejected) != 0 || len(plain.Sources) != 4 {
		t.Fatalf("ohne Leser-Antwort (Docker-Box) unveraendert: %+v %v", plain, err)
	}
}

// Every source the reader refuses: nothing applicable is left, and the plan
// still names the rejections, so the box can say WHY.
func TestOnlyUnreadSourcesLeaveNoConfigurationButTheirReasons(t *testing.T) {
	reg := portal(ent("a0000000-0000-0000-0000-000000000007", entities.TypeProducer, pikoDriver("192.168.1.122")))
	plan, err := DeriveWith(reg, cat(), nil, now, Options{SourceReads: func(string, string) string { return "nein" }})
	if err != ErrNoConfiguration || len(plan.Rejected) != 1 || plan.Rejected[0].Reason != "nein" {
		t.Fatalf("%+v %v", plan, err)
	}
}
