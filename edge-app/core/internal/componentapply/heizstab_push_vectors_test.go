package componentapply

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The cloud's descriptor of a heating rod over a Shelly output set, as the API
// composes it (docs/contracts/v2/heizstab-push-vectors.json - the same file
// services/api HeizstabPushApiTest proves the cloud against). Live case
// "Zuhause" (02.11.2026): the descriptor carried no actuate capability, the box
// read it as "measure-only", found no plant role for it and refused the WHOLE
// push - the inverter and every source of the plant with it.
const heizstabPushVectorsPath = "../../../../docs/contracts/v2/heizstab-push-vectors.json"

type heizstabPushVectors struct {
	Descriptor       json.RawMessage `json:"descriptor"`
	DescriptorVorFix json.RawMessage `json:"descriptor_vor_fix"`
	Box              struct {
		Role     string `json:"role"`
		Channels []int  `json:"channels"`
	} `json:"box"`
}

func loadHeizstabPushVectors(t *testing.T) heizstabPushVectors {
	t.Helper()
	raw, err := os.ReadFile(heizstabPushVectorsPath)
	if err != nil {
		t.Fatalf("Vektoren lesen: %v", err)
	}
	var v heizstabPushVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren unlesbar: %v", err)
	}
	return v
}

func entityFromDescriptor(t *testing.T, raw json.RawMessage) entities.Entity {
	t.Helper()
	var e entities.Entity
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("Beschreibung unlesbar: %v", err)
	}
	return e
}

func channelsCSV(chs []int) string {
	parts := make([]string, 0, len(chs))
	for _, c := range chs {
		parts = append(parts, strconv.Itoa(c))
	}
	return strings.Join(parts, ",")
}

// A heating rod is a CONSUMER by its pinned type - with or without a write
// capability. The descriptor the cloud sends today (actuate on_off/setpoint_kw/
// limit_kw) and the one it sent until 02.11.2026 (measure channels only) must
// BOTH derive one consumer-side Shelly source that keeps the output set: the
// write capability decides what the box may SWITCH (the guard chain), never
// on which side of the energy balance the device sits.
func TestAHeatingRodDescriptorDerivesAConsumerSourceWithAndWithoutActuate(t *testing.T) {
	v := loadHeizstabPushVectors(t)
	for name, raw := range map[string]json.RawMessage{
		"descriptor":         v.Descriptor,
		"descriptor_vor_fix": v.DescriptorVorFix,
	} {
		t.Run(name, func(t *testing.T) {
			rod := entityFromDescriptor(t, raw)
			plan, err := Derive(portal(rod), cat(), nil, now)
			if err != nil {
				t.Fatalf("Derive: %v", err)
			}
			if plan.Inverter != nil || len(plan.Sources) != 1 {
				t.Fatalf("erwartet genau eine Quelle, bekam %+v", plan)
			}
			s := plan.Sources[0]
			if s.Role != v.Box.Role || s.Role != sources.RoleConsumer {
				t.Fatalf("Rolle = %q, will %q", s.Role, v.Box.Role)
			}
			if string(s.Connection.Channels) != channelsCSV(v.Box.Channels) {
				t.Fatalf("Ausgangsmenge = %q, will %q", s.Connection.Channels, channelsCSV(v.Box.Channels))
			}
			if s.Communication != "shelly_http" || s.Connection.IP != "192.168.178.43" {
				t.Fatalf("Quelle %+v", s)
			}
		})
	}
}

// The plant around the rod survives the rod: the captain's push carried the
// Deye inverter next to the heating rod, and the refusal took the inverter
// down with it ("es läuft weiter der vorherige Stand"). With the rod derived,
// the inverter selection comes through.
func TestTheInverterNextToAMeasureOnlyHeatingRodIsDerivedToo(t *testing.T) {
	v := loadHeizstabPushVectors(t)
	rod := entityFromDescriptor(t, v.DescriptorVorFix)
	inv := ent("5f0d2c9e-0000-0000-0000-000000000001", entities.TypeBatteryHybrid, deyeDriver)
	plan, err := Derive(portal(inv, rod), cat(), nil, now)
	if err != nil {
		t.Fatalf("Derive: %v", err)
	}
	if plan.Inverter == nil || plan.Inverter.Brand != "deye" || len(plan.Sources) != 1 {
		t.Fatalf("plan = %+v", plan)
	}
}
