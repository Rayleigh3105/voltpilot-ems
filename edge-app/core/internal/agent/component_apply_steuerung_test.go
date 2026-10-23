package agent

// Die Anlagensteuerung am Applier (UEMS EZ-21): eine Anlage, deren einziges
// angebundenes Geraet eine Steuerung ist (Gore), laeuft nicht mehr in den Halt
// „kein verbundenes Geraet“. Die Quelle landet in sources.json und auf
// edge/sources/config - und nirgends sonst: sie ist keine PV-Quelle, also
// bleibt die physische Huelle, wie sie war.

import (
	"encoding/json"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// Der Treiber und der Pin aus docs/contracts/v2/anlagensteuerung-quelle-vectors.json (Fall gore_neue_halle).
const (
	goreSteuerungDriver = `{"communication":"modbus_tcp","interval_s":5,
	  "connection":{"ip":"192.168.4.165","port":503,"unit_id":1},"data_source_id":"DQ-1"}`
	goreSteuerungPin = "src-2hv35pcn"
)

func goreSteuerung() entities.Entity {
	e := applyEntity("00000000-0000-0000-0000-0000000e2001", entities.TypeAnlagensteuerung, goreSteuerungDriver)
	e.Label = "Anlagensteuerung"
	e.EdgeSourceID = goreSteuerungPin
	return e
}

func TestAPlantWhoseOnlyDeviceIsAControllerIsAppliedNotHeld(t *testing.T) {
	a := newGateTestAgent(t)
	// Netz und Haus ohne Anbindung stehen daneben, wie im Gore-Push (EZ-20).
	a.applyEntityRegistry(portalPush("r1",
		applyEntity("00000000-0000-0000-0000-0000000e2010", entities.TypeGridMeter, ""),
		applyEntity("00000000-0000-0000-0000-0000000e2011", entities.TypeHouseLoad, ""),
		goreSteuerung()))

	rec := a.componentRecord()
	if rec.Held != "" || rec.Refused != "" || rec.Revision != "r1" {
		t.Fatalf("angewandt, weder gehalten noch abgelehnt: %+v", rec)
	}
	if !a.PortalManagedComponents() {
		t.Fatal("ein angewandter Plan macht die Anlage portal-verwaltet")
	}
	if _, ok := a.GetInverter(); ok {
		t.Fatal("eine Steuerung ist kein Wechselrichter")
	}
	list, ok, err := a.srcStore.Load()
	if err != nil || !ok || len(list) != 1 || list[0].ID != goreSteuerungPin ||
		list[0].Role != sources.RolePlantController || list[0].Connection.Port != 503 {
		t.Fatalf("sources.json: %+v ok=%v err=%v", list, ok, err)
	}
	var bus struct {
		Sources []struct {
			ID           string `json:"id"`
			Role         string `json:"role"`
			DataSourceID string `json:"data_source_id"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(sources.BusConfig(a.ListSources()), &bus); err != nil || len(bus.Sources) != 1 ||
		bus.Sources[0].ID != goreSteuerungPin || bus.Sources[0].DataSourceID != "DQ-1" {
		t.Fatalf("edge/sources/config: %+v %v", bus, err)
	}

	// Der zweite, gleiche Push schreibt nichts.
	a.applyEntityRegistry(portalPush("r2",
		applyEntity("00000000-0000-0000-0000-0000000e2010", entities.TypeGridMeter, ""),
		applyEntity("00000000-0000-0000-0000-0000000e2011", entities.TypeHouseLoad, ""),
		goreSteuerung()))
	if rec := a.componentRecord(); rec.Revision != "r2" || rec.Refused != "" {
		t.Fatalf("zweiter Push: %+v", rec)
	}
	if got := a.ListSources(); len(got) != 1 || got[0].ID != goreSteuerungPin {
		t.Fatalf("Quellen nach dem zweiten Push: %+v", got)
	}
}

func TestAControllerSourceLeavesThePhysicalEnvelopeAlone(t *testing.T) {
	a := newGateTestAgent(t)
	if _, err := a.SetInverter(inverter.SelectionRequest{
		Brand: "deye", Model: "sun-30k-sg01hp3",
		Connection: inverter.Connection{IP: "10.0.0.5", Port: 8899, Serial: "111", MbSlaveID: 1},
	}); err != nil {
		t.Fatal(err)
	}
	pvBefore, battBefore := a.envelope.Bounds()
	if pvBefore <= 0 {
		t.Fatalf("Vorbedingung: der Wechselrichter setzt eine PV-Grenze (%v)", pvBefore)
	}
	a.applyEntityRegistry(portalPush("r1", goreSteuerung()))
	if rec := a.componentRecord(); rec.Revision != "r1" || rec.Authority != componentapply.AuthorityPortal {
		t.Fatalf("nicht angewandt: %+v", rec)
	}
	// Als Erzeuger ohne kWp haette sie die PV-Grenze aufgehoben (maxPv = 0).
	if pv, batt := a.envelope.Bounds(); pv != pvBefore || batt != battBefore {
		t.Fatalf("Huelle %v/%v -> %v/%v: die Steuerung ist keine PV-Quelle", pvBefore, battBefore, pv, batt)
	}
	if sum, mix := a.aggregateSourcePv(); sum != 0 || mix != "" {
		t.Fatalf("PV-Summe %v (%q): die Steuerung traegt nichts bei", sum, mix)
	}
}
