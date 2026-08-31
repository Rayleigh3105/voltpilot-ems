package componentapply

import (
	"encoding/json"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// selfBuilt builds a descriptor in the shape the cloud really pushes for a
// self-built device: communication modbus_baukasten and the WHOLE stored
// definition as driver.connection (SelfBuildComponentService.definitionJsonRaw
// - a nested transport plus the channel list), never a flat address block.
func selfBuilt(id, label string, caps entities.Capabilities, connection string) entities.Entity {
	return entities.Entity{
		ID:           id,
		Type:         "modbus-generic",
		Label:        label,
		Capabilities: caps,
		Driver: json.RawMessage(`{"communication":"` + CommunicationSelfBuild +
			`","connection":` + connection + `}`),
	}
}

const zisterneDefinition = `{"schema_version":"1.0",` +
	`"transport":{"host":"192.168.210.77","port":502,"unit_id":3},` +
	`"channels":[{"slug":"fuellstand_pct","label":"Füllstand Zisterne","unit":"%",` +
	`"register":{"kind":"holding","address":40,"data_type":"u16","word_order":"big"},` +
	`"scale":0.1,"offset":0,"min_read_interval_s":30}]}`

func measure(chans ...[2]string) entities.Capabilities {
	c := entities.Capabilities{}
	for _, ch := range chans {
		c.Measure = append(c.Measure, entities.MeasureCap{Channel: ch[0], Unit: ch[1]})
	}
	return c
}

func TestCustomDevicesListsWhatTheApplierDeliberatelySkips(t *testing.T) {
	reg := entities.Registry{Entities: []entities.Entity{
		{ID: "inv", Type: entities.TypeBatteryHybrid, Label: "Wechselrichter",
			Driver: json.RawMessage(`{"brand":"deye","communication":"solarman_v5","connection":{"ip":"192.168.0.5"}}`)},
		selfBuilt("zisterne", "Zisterne", measure([2]string{"fuellstand_pct", "%"}), zisterneDefinition),
	}}

	got := CustomDevices(reg, map[string]string{"zisterne": "ok"})
	if len(got) != 1 {
		t.Fatalf("want exactly the self-built device, got %d: %+v", len(got), got)
	}
	d := got[0]
	if d.ID != "zisterne" || d.Label != "Zisterne" {
		t.Errorf("identity/label wrong: %+v", d)
	}
	if d.Communication != CommunicationSelfBuild {
		t.Errorf("communication = %q", d.Communication)
	}
	if d.Host != "192.168.210.77" || d.Port != 502 || d.UnitID != 3 {
		t.Errorf("transport read from the NESTED definition failed: %+v", d)
	}
	if d.Health != "ok" {
		t.Errorf("health = %q", d.Health)
	}
	if d.Switchable {
		t.Error("a measure-only device is not switchable")
	}
	if len(d.Channels) != 1 || d.Channels[0].Channel != "fuellstand_pct" ||
		d.Channels[0].Label != "Füllstand Zisterne" || d.Channels[0].Unit != "%" {
		t.Errorf("channel enrichment from the definition failed: %+v", d.Channels)
	}

	// The very same entity is the one Derive skips - "skipped by the applier"
	// and "listed as a self-built device" must be provably the SAME set.
	if _, ok, err := ParseDriver(reg.Entities[1]); err != nil || ok {
		t.Fatalf("ParseDriver must skip a self-built device: ok=%v err=%v", ok, err)
	}
	if _, ok, _ := ParseDriver(reg.Entities[0]); !ok {
		t.Fatal("the inverter must still be part of the read path")
	}
	if IsSelfBuilt(reg.Entities[0]) {
		t.Error("a catalog device is not self-built")
	}
}

func TestCustomDevicesNeverInventsAnAddressOrAStatus(t *testing.T) {
	// A push whose definition carries no transport at all (an older cloud, a
	// definition we cannot read): the device is still LISTED - it exists and the
	// customer must see it - but nothing about its address is claimed.
	reg := entities.Registry{Entities: []entities.Entity{
		selfBuilt("ohne", "Ohne Adresse", measure([2]string{"temp_c", "°C"}), `{"channels":[]}`),
		selfBuilt("kaputt", "Unlesbar", entities.Capabilities{}, `"nicht mal ein objekt"`),
	}}
	got := CustomDevices(reg, nil)
	if len(got) != 2 {
		t.Fatalf("both devices must be listed, got %d", len(got))
	}
	for _, d := range got {
		if d.Host != "" || d.Port != 0 || d.UnitID != 0 {
			t.Errorf("%s: an unreadable definition must claim NO address: %+v", d.ID, d)
		}
		if d.Health != "" {
			t.Errorf("%s: an entity the health map does not carry claims nothing: %q", d.ID, d.Health)
		}
	}
	// The channel list follows the CAPABILITIES, not the definition.
	if len(got[1].Channels) != 0 {
		t.Errorf("no declared capability, no channel: %+v", got[1].Channels)
	}
	if len(got[0].Channels) != 1 || got[0].Channels[0].Label != "" ||
		got[0].Channels[0].Unit != "°C" {
		t.Errorf("a channel without a definition label keeps its raw name + declared unit: %+v", got[0].Channels)
	}
}

func TestCustomDevicesReadsAFlatTransportToo(t *testing.T) {
	// The hand-written push shape (scout evidence lab-push-portal.json) puts the
	// address flat next to the channels. Reading both shapes is what keeps "the
	// address is silently missing" from being a whole bug class.
	reg := entities.Registry{Entities: []entities.Entity{
		selfBuilt("flach", "Flach", measure([2]string{"power_kw", "kW"}),
			`{"host":"192.168.210.77","port":"1502","unit_id":1}`),
	}}
	got := CustomDevices(reg, nil)
	if len(got) != 1 || got[0].Host != "192.168.210.77" || got[0].Port != 1502 || got[0].UnitID != 1 {
		t.Fatalf("flat transport (incl. a quoted port) not read: %+v", got)
	}
}

func TestCustomDevicesReportsAReleasedSwitchAndSortsStably(t *testing.T) {
	sw := selfBuilt("b", "Wärmepumpe", measure([2]string{"power_kw", "kW"}), zisterneDefinition)
	sw.Capabilities.Actuate = []entities.ActuateCap{{Command: "on_off"}}
	sw.Type = "modbus-load"
	reg := entities.Registry{Entities: []entities.Entity{
		sw,
		selfBuilt("a", "Zisterne", measure([2]string{"fuellstand_pct", "%"}), zisterneDefinition),
	}}
	got := CustomDevices(reg, map[string]string{"b": "stale"})
	if len(got) != 2 {
		t.Fatalf("want 2, got %d", len(got))
	}
	if got[0].Label != "Wärmepumpe" || got[1].Label != "Zisterne" {
		t.Errorf("stable label order expected, got %q, %q", got[0].Label, got[1].Label)
	}
	if !got[0].Switchable {
		t.Error("a released self-built device declares actuate and must say so")
	}
	if got[0].Health != "stale" || got[1].Health != "" {
		t.Errorf("health per entity wrong: %q / %q", got[0].Health, got[1].Health)
	}
	if got[1].Switchable {
		t.Error("a measure-only device is never switchable")
	}
}

func TestCustomDevicesIsNilWithoutASelfBuiltDevice(t *testing.T) {
	reg := entities.Registry{Entities: []entities.Entity{
		{ID: "grid", Type: entities.TypeGridMeter, Label: "Netz"},
		{ID: "inv", Type: entities.TypeBatteryHybrid, Label: "WR",
			Driver: json.RawMessage(`{"brand":"deye","communication":"solarman_v5"}`)},
	}}
	if got := CustomDevices(reg, map[string]string{"grid": "ok"}); got != nil {
		t.Fatalf("a plant without a self-built device must render byte-for-byte as before, got %+v", got)
	}
}
