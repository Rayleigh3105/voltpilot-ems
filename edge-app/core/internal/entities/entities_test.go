package entities

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
)

// The CONTRACT FIXTURES (docs/contracts/v2/examples) drive the happy paths -
// the runtime parser is the executable contract check (the E0 fixture
// discipline; the Java ingest validator does the same for mqtt-telemetry-2.0).
const fixtureDir = "../../../../docs/contracts/v2/examples"

var pushIdentity = Identity{
	TenantID: "00000000-0000-0000-0000-000000000001",
	SiteID:   "00000000-0000-0000-0000-000000000002",
	DeviceID: "00000000-0000-0000-0000-000000000003",
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatalf("contract fixture missing: %v", err)
	}
	return raw
}

func TestParseRegistryPushAcceptsTheContractFixture(t *testing.T) {
	reg, skipped, err := ParseRegistryPush(fixture(t, "edge-entity.valid.registry-push.json"), pushIdentity)
	if err != nil {
		t.Fatalf("fixture rejected: %v", err)
	}
	if len(skipped) != 0 {
		t.Fatalf("fixture entries skipped: %v", skipped)
	}
	if reg.Revision != "2026-07-18T11:00:00Z" {
		t.Fatalf("revision = %q", reg.Revision)
	}
	if len(reg.Entities) != 3 {
		t.Fatalf("want 3 entities, got %d", len(reg.Entities))
	}
	battery := reg.FirstOfType(TypeBatteryHybrid)
	if battery == nil || battery.ID != "5f0d2c9e-6b1a-4c3d-9e8f-0a1b2c3d4e5f" {
		t.Fatalf("battery entity missing/wrong: %+v", battery)
	}
	if battery.Guards.Failsafe.Behavior != "self-consumption" {
		t.Fatalf("battery failsafe = %q", battery.Guards.Failsafe.Behavior)
	}
	producer := reg.FirstOfType(TypeProducer)
	if producer == nil || producer.Guards.Limits.MaxGenerationKw == nil ||
		*producer.Guards.Limits.MaxGenerationKw != 27 {
		t.Fatalf("producer nameplate missing: %+v", producer)
	}
	if len(producer.Driver) == 0 {
		t.Fatalf("producer driver block not carried through")
	}
	meter := reg.FirstOfType(TypeGridMeter)
	if meter == nil || len(meter.Capabilities.Actuate) != 0 {
		t.Fatalf("grid meter must be measure-only: %+v", meter)
	}
}

func TestParseRegistryPushRejectsForeignIdentityAndWrongVersion(t *testing.T) {
	raw := fixture(t, "edge-entity.valid.registry-push.json")
	foreign := pushIdentity
	foreign.DeviceID = "99999999-9999-9999-9999-999999999999"
	if _, _, err := ParseRegistryPush(raw, foreign); err == nil {
		t.Fatal("foreign identity accepted")
	}
	bad := strings.Replace(string(raw), "\"schema_version\": \"1.0\"", "\"schema_version\": \"9.9\"", 1)
	if _, _, err := ParseRegistryPush([]byte(bad), pushIdentity); err == nil {
		t.Fatal("wrong schema_version accepted")
	}
}

func TestParseRegistryPushSkipsUnknownTypesNeverFatal(t *testing.T) {
	// The invalid CONFIG fixture's entity_type ("wallbox") inside a push: the
	// entry is skipped with a note, the rest of the set applies (the
	// schedule-2.0 unknown-entity rule; forward compatibility for E1b types).
	push := map[string]any{
		"schema_version": "1.0",
		"tenant_id":      pushIdentity.TenantID,
		"site_id":        pushIdentity.SiteID,
		"device_id":      pushIdentity.DeviceID,
		"revision":       "r1",
		"published_at":   "2026-07-18T11:00:00Z",
		"entities": []any{
			json.RawMessage(fixture(t, "edge-entity.invalid.unknown-entity-type.json")),
			map[string]any{
				"entity_id":    "7b2f4e10-8d3c-4e5f-b0a1-2c3d4e5f6071",
				"entity_type":  "grid-meter",
				"capabilities": map[string]any{"measure": []any{map[string]any{"channel": "power_kw"}}},
				"guards":       map[string]any{"failsafe": map[string]any{"behavior": "measure-only"}},
			},
		},
	}
	raw, _ := json.Marshal(push)
	reg, skipped, err := ParseRegistryPush(raw, pushIdentity)
	if err != nil {
		t.Fatalf("push rejected: %v", err)
	}
	if len(reg.Entities) != 1 || reg.Entities[0].Type != TypeGridMeter {
		t.Fatalf("want the grid meter only, got %+v", reg.Entities)
	}
	if len(skipped) != 1 || !strings.Contains(skipped[0], "wallbox") {
		t.Fatalf("want one wallbox skip note, got %v", skipped)
	}
}

func TestConfigPayloadMatchesTheContractConfigShape(t *testing.T) {
	reg, _, err := ParseRegistryPush(fixture(t, "edge-entity.valid.registry-push.json"), pushIdentity)
	if err != nil {
		t.Fatal(err)
	}
	battery := reg.FirstOfType(TypeBatteryHybrid)
	var cfg map[string]any
	if err := json.Unmarshal(battery.ConfigPayload(reg.Revision), &cfg); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"schema_version", "entity_id", "entity_type", "capabilities", "guards", "revision"} {
		if _, ok := cfg[key]; !ok {
			t.Fatalf("config payload missing %q: %v", key, cfg)
		}
	}
	if cfg["schema_version"] != "1.0" || cfg["entity_type"] != TypeBatteryHybrid {
		t.Fatalf("config payload wrong: %v", cfg)
	}
	// Round-trip: the config fixture (the same battery entity as a retained
	// config) parses back into an equal entity.
	var fromFixture struct {
		Entity
	}
	if err := json.Unmarshal(fixture(t, "edge-entity.valid.config-battery.json"), &fromFixture); err != nil {
		t.Fatal(err)
	}
	if fromFixture.ID != battery.ID || fromFixture.Type != battery.Type {
		t.Fatalf("config fixture and push fixture diverge: %+v vs %+v", fromFixture.Entity, *battery)
	}
}

func TestParseTelemetryAcceptsTheContractFixtureAndEnforcesIdentity(t *testing.T) {
	raw := fixture(t, "edge-entity.valid.telemetry-producer.json")
	tel, err := ParseTelemetry("6a1e3d0f-7c2b-4d4e-af90-1b2c3d4e5f60", raw)
	if err != nil {
		t.Fatalf("fixture rejected: %v", err)
	}
	if tel.Channels["pv_power_kw"] != 44.2 {
		t.Fatalf("channels = %v", tel.Channels)
	}
	if tel.Ts.IsZero() {
		t.Fatal("fixture ts not parsed")
	}
	if _, err := ParseTelemetry("someone-else", raw); err == nil {
		t.Fatal("identity mismatch accepted")
	}
	if _, err := ParseTelemetry("e1", []byte(`{"schema_version":"1.0","entity_id":"e1","channels":{}}`)); err == nil {
		t.Fatal("empty channels accepted")
	}
}

func batteryEntity(maxCharge, maxDischarge float64, gridAllowed *bool) Entity {
	return Entity{
		ID:   "batt",
		Type: TypeBatteryHybrid,
		Capabilities: Capabilities{Actuate: []ActuateCap{
			{Command: CmdSetpointKw}, {Command: CmdLimitKw},
		}},
		Guards: Guards{
			Limits: GuardLimits{
				MaxChargeKw:           &maxCharge,
				MaxDischargeKw:        &maxDischarge,
				ChargeFromGridAllowed: gridAllowed,
			},
			Failsafe: Failsafe{Behavior: "self-consumption"},
		},
	}
}

func TestClampCommandsBatteryUsesRegistryBandAndD8Posture(t *testing.T) {
	// D-8: charge_from_grid_allowed ABSENT = NOT allowed - charge is clamped
	// to measured PV; the registry band caps the magnitude.
	e := batteryEntity(10, 8, nil)
	r := guards.Reading{SocPct: 50, PvKw: 3, LoadKw: 1, GridLimitKw: guards.Unknown()}
	wish := 20.0
	granted := e.ClampCommands(Commands{SetpointKw: &wish}, r)
	if granted.SetpointKw == nil || *granted.SetpointKw != 3 {
		t.Fatalf("D-8 solar-only clamp: want 3 (measured pv), got %+v", granted.SetpointKw)
	}
	// Explicit true releases the clamp: only the rated band applies.
	allowed := true
	e2 := batteryEntity(10, 8, &allowed)
	granted = e2.ClampCommands(Commands{SetpointKw: &wish}, r)
	if granted.SetpointKw == nil || *granted.SetpointKw != 10 {
		t.Fatalf("band clamp: want 10, got %+v", granted.SetpointKw)
	}
	// Discharge is capped by the discharge bound, never by solar-only.
	discharge := -20.0
	granted = e.ClampCommands(Commands{SetpointKw: &discharge}, r)
	if granted.SetpointKw == nil || *granted.SetpointKw != -8 {
		t.Fatalf("discharge clamp: want -8, got %+v", granted.SetpointKw)
	}
}

func TestClampCommandsCapabilityGateAndTypes(t *testing.T) {
	// A command the registry never declared is dropped (the desired
	// contract's capability:unsupported_command) - here the battery declares
	// no limit_pct.
	e := batteryEntity(10, 8, nil)
	pct := 50.0
	if got := e.ClampCommands(Commands{LimitPct: &pct}, guards.Reading{
		SocPct: guards.Unknown(), PvKw: guards.Unknown(), LoadKw: guards.Unknown(),
		GridLimitKw: guards.Unknown()}); !got.Empty() {
		t.Fatalf("undeclared capability granted: %+v", got)
	}

	// Producer: never commanded to produce - setpoint dropped, limit_kw
	// nameplate-capped and floored at 0 (reduce-only).
	nameplate := 27.0
	producer := Entity{
		ID:   "pv",
		Type: TypeProducer,
		Capabilities: Capabilities{Actuate: []ActuateCap{
			{Command: CmdLimitKw}, {Command: CmdLimitPct},
		}},
		Guards: Guards{Limits: GuardLimits{MaxGenerationKw: &nameplate},
			Failsafe: Failsafe{Behavior: "release"}},
	}
	sp, over, neg := 5.0, 100.0, -3.0
	r := guards.Reading{SocPct: guards.Unknown(), PvKw: guards.Unknown(),
		LoadKw: guards.Unknown(), GridLimitKw: guards.Unknown()}
	granted := producer.ClampCommands(Commands{SetpointKw: &sp, LimitKw: &over}, r)
	if granted.SetpointKw != nil {
		t.Fatal("producer setpoint must be dropped")
	}
	if granted.LimitKw == nil || *granted.LimitKw != 27 {
		t.Fatalf("nameplate cap: want 27, got %+v", granted.LimitKw)
	}
	granted = producer.ClampCommands(Commands{LimitKw: &neg}, r)
	if granted.LimitKw == nil || *granted.LimitKw != 0 {
		t.Fatalf("negative limit must clamp to 0, got %+v", granted.LimitKw)
	}

	// Grid meter: measure-only - everything dropped.
	meter := Entity{ID: "m", Type: TypeGridMeter,
		Guards: Guards{Failsafe: Failsafe{Behavior: "measure-only"}}}
	if got := meter.ClampCommands(Commands{SetpointKw: &sp, LimitKw: &sp}, r); !got.Empty() {
		t.Fatalf("grid meter granted commands: %+v", got)
	}
}

func TestGuardChainLimitsDefaults(t *testing.T) {
	e := Entity{Type: TypeBatteryHybrid}
	l := e.GuardChainLimits()
	if !math.IsInf(l.MaxChargeKw, 1) || !math.IsInf(l.MaxDischargeKw, 1) {
		t.Fatalf("absent bounds must disable the band, got %+v", l)
	}
	if !l.SolarOnlyCharge {
		t.Fatal("D-8: absent charge_from_grid_allowed must clamp solar-only")
	}
}

func TestTopicsAndIDExtraction(t *testing.T) {
	if ConfigTopic("e1") != "edge/entities/e1/config" ||
		CommandTopic("e1") != "edge/entities/e1/command" ||
		TelemetryTopic("e1") != "edge/entities/e1/telemetry" {
		t.Fatal("topic shapes drifted")
	}
	if IDFromTopic("edge/entities/e1/telemetry", "telemetry") != "e1" {
		t.Fatal("id extraction broken")
	}
	if IDFromTopic("edge/entities/a/b/telemetry", "telemetry") != "" ||
		IDFromTopic("edge/sources/e1/telemetry", "telemetry") != "" {
		t.Fatal("foreign topic accepted")
	}
}

func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Load(); err != nil || ok {
		t.Fatalf("fresh store: ok=%v err=%v", ok, err)
	}
	reg, _, err := ParseRegistryPush(fixture(t, "edge-entity.valid.registry-push.json"), pushIdentity)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Save(reg); err != nil {
		t.Fatal(err)
	}
	loaded, ok, err := s.Load()
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if loaded.Revision != reg.Revision || len(loaded.Entities) != len(reg.Entities) {
		t.Fatalf("round trip lost data: %+v", loaded)
	}
	if loaded.FirstOfType(TypeProducer).Guards.Limits.MaxGenerationKw == nil {
		t.Fatal("round trip lost guard limits")
	}
}
