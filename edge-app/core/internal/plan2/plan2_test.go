package plan2

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fixtureDir = "../../../../docs/contracts/v2/examples"

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatalf("contract fixture unreadable: %v", err)
	}
	return raw
}

var recv = time.Date(2026, 7, 18, 10, 5, 0, 0, time.UTC)

func TestParseTwoEntitiesFixture(t *testing.T) {
	p, err := Parse(fixture(t, "mqtt-schedule-2.0.valid.two-entities.json"), recv)
	if err != nil {
		t.Fatal(err)
	}
	if p.SlotMinutes != 15 || len(p.Entities) != 2 {
		t.Fatalf("parsed plan wrong: %+v", p)
	}
	if p.GridImportLimitKw == nil || *p.GridImportLimitKw != 42.5 {
		t.Fatalf("site peak target wrong: %v", p.GridImportLimitKw)
	}
	batt := p.Entity("batt-main")
	if batt == nil || batt.ReserveSocPct == nil || *batt.ReserveSocPct != 25 {
		t.Fatalf("battery entity wrong: %+v", batt)
	}
	// D-8: the fixture does not carry charge_from_grid_allowed -> NOT allowed.
	if batt.ChargeFromGridAllowed {
		t.Fatal("absent charge_from_grid_allowed must read NOT allowed (D-8)")
	}

	// Active slot at 10:05 = the 10:00 slot.
	now := time.Date(2026, 7, 18, 10, 5, 0, 0, time.UTC)
	cmds, start, ok := p.ActiveCommands("batt-main", now)
	if !ok || cmds.SetpointKw == nil || *cmds.SetpointKw != 12.0 {
		t.Fatalf("active battery slot wrong: %+v ok=%v", cmds, ok)
	}
	if start != time.Date(2026, 7, 18, 10, 0, 0, 0, time.UTC) {
		t.Fatalf("slot start wrong: %v", start)
	}
	// The producer's 10:00 slot caps limit_kw 40; its 10:15 slot flips to pct.
	pvCmds, _, ok := p.ActiveCommands("pv-roof-east", now)
	if !ok || pvCmds.LimitKw == nil || *pvCmds.LimitKw != 40 {
		t.Fatalf("producer slot wrong: %+v", pvCmds)
	}
	later := time.Date(2026, 7, 18, 10, 20, 0, 0, time.UTC)
	pvCmds, _, ok = p.ActiveCommands("pv-roof-east", later)
	if !ok || pvCmds.LimitPct == nil || *pvCmds.LimitPct != 100 {
		t.Fatalf("second producer slot wrong: %+v", pvCmds)
	}
}

func TestParseConsumerDispatchFixture(t *testing.T) {
	// The Verbrauchssteuerung Inkrement-2 publisher shape, read BY PATH (the
	// examples discipline): three kind:"consumer" entities - setpoint_kw for a
	// continuous wallbox, on_off for the rod and the pump; a 0/false slot IS
	// the plan (an all-off raster stays a commanded state, unlike the
	// producer's release-by-omission semantics).
	// Received 14 min after generation: inside the redelivery slack, so the
	// freshness window still reaches past the fixture's 12:00 slot.
	crecv := time.Date(2026, 8, 10, 11, 44, 0, 0, time.UTC)
	p, err := Parse(fixture(t, "mqtt-schedule-2.0.valid.consumer-dispatch.json"), crecv)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Entities) != 3 {
		t.Fatalf("want 3 consumer entities, got %d", len(p.Entities))
	}
	for _, e := range p.Entities {
		if e.Kind != "consumer" {
			t.Fatalf("entity %s kind = %q", e.ID, e.Kind)
		}
		// D-8 reads identically for consumers: absent = NOT grid-released
		// (irrelevant to the consumer clamp, but the parse must not invent it).
		if e.ChargeFromGridAllowed {
			t.Fatalf("entity %s: absent charge_from_grid_allowed must read false", e.ID)
		}
	}

	// 11:44: the wallbox's 11:30 slot commands 3.0 kW.
	cmds, start, ok := p.ActiveCommands("wb-carport", crecv)
	if !ok || cmds.SetpointKw == nil || *cmds.SetpointKw != 3.0 {
		t.Fatalf("wallbox active slot wrong: %+v ok=%v", cmds, ok)
	}
	if start != time.Date(2026, 8, 10, 11, 30, 0, 0, time.UTC) {
		t.Fatalf("slot start wrong: %v", start)
	}
	// 12:01: the wallbox's 0.0 slot is STILL a command (off), never a release.
	late := time.Date(2026, 8, 10, 12, 1, 0, 0, time.UTC)
	cmds, _, ok = p.ActiveCommands("wb-carport", late)
	if !ok || cmds.SetpointKw == nil || *cmds.SetpointKw != 0 {
		t.Fatalf("wallbox off slot must stay a command: %+v ok=%v", cmds, ok)
	}
	// The rod's on_off raster: true at 11:44, false at 12:01.
	cmds, _, ok = p.ActiveCommands("rod-boiler", crecv)
	if !ok || cmds.OnOff == nil || !*cmds.OnOff {
		t.Fatalf("rod active slot wrong: %+v", cmds)
	}
	cmds, _, ok = p.ActiveCommands("rod-boiler", late)
	if !ok || cmds.OnOff == nil || *cmds.OnOff {
		t.Fatalf("rod off slot wrong: %+v", cmds)
	}
	// The pump has NO slot covering 11:44 (its Pflichtlauf starts 11:45): no
	// active command - the executor leaves it to its failsafe.
	if _, _, ok := p.ActiveCommands("pump-stall", crecv); ok {
		t.Fatal("pump must have no active slot before its window")
	}
	if cmds, _, ok := p.ActiveCommands("pump-stall", time.Date(2026, 8, 10, 11, 50, 0, 0, time.UTC)); !ok ||
		cmds.OnOff == nil || !*cmds.OnOff {
		t.Fatalf("pump window slot wrong: %+v ok=%v", cmds, ok)
	}

	// Plan staleness withdraws consumer desires like every other entity: past
	// the 20-min window ActiveCommands answers nothing.
	stale := crecv.Add(21 * time.Minute)
	if _, _, ok := p.ActiveCommands("rod-boiler", stale); ok {
		t.Fatal("a stale plan must not command a consumer")
	}
}

func TestParseMinimalFixtureAndV1KeyRejected(t *testing.T) {
	if _, err := Parse(fixture(t, "mqtt-schedule-2.0.valid.minimal-battery.json"), recv); err != nil {
		t.Fatalf("minimal fixture must parse: %v", err)
	}
	// The invalid fixture carries a v1 command key; strict command props make
	// the slot unusable -> no usable entity slots.
	if _, err := Parse(fixture(t, "mqtt-schedule-2.0.invalid.v1-command-key.json"), recv); err == nil {
		t.Fatal("v1-command-key fixture must be refused")
	}
}

func TestStalenessMirrorsV1Semantics(t *testing.T) {
	raw := fixture(t, "mqtt-schedule-2.0.valid.two-entities.json")
	p, err := Parse(raw, recv)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Fresh(recv.Add(19 * time.Minute)) {
		t.Fatal("plan must be fresh inside the 20-min window")
	}
	if p.Fresh(recv.Add(21 * time.Minute)) {
		t.Fatal("plan must be stale after 20 min")
	}
	if _, _, ok := p.ActiveCommands("batt-main", recv.Add(21*time.Minute)); ok {
		t.Fatal("a stale plan must drive nothing")
	}

	// Redelivery of an OLD retained payload (generated_at far in the past) is
	// anchored to generation time - it can never look fresh again.
	lateRecv := recv.Add(2 * time.Hour)
	p2, err := Parse(raw, lateRecv)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Fresh(lateRecv) {
		t.Fatal("an aged redelivered plan must be stale immediately")
	}
}

func TestUnknownAndDuplicateEntitiesAreSkippedNeverFatal(t *testing.T) {
	raw := strings.Replace(string(fixture(t, "mqtt-schedule-2.0.valid.two-entities.json")),
		`"entity_id": "pv-roof-east"`, `"entity_id": "batt-main"`, 1) // duplicate id
	p, err := Parse([]byte(raw), recv)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Entities) != 1 {
		t.Fatalf("duplicate entity must be skipped, got %d", len(p.Entities))
	}
}

func TestStoreRoundTripKeepsStalenessAnchor(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	raw := fixture(t, "mqtt-schedule-2.0.valid.two-entities.json")
	if err := s.Save(raw, recv); err != nil {
		t.Fatal(err)
	}
	p, err := s.Load()
	if err != nil || p == nil {
		t.Fatalf("load: %v %v", p, err)
	}
	if !p.ReceivedAt.Equal(recv) {
		t.Fatalf("receipt anchor lost: %v", p.ReceivedAt)
	}
	if err := s.Clear(); err != nil {
		t.Fatal(err)
	}
	if p, err := s.Load(); err != nil || p != nil {
		t.Fatalf("clear must remove the plan: %v %v", p, err)
	}
}

// AP-15 IP-15 (P2, W8): ein Lauf, je Box ein Dokument - beide mit derselben
// plan_id; lauf_nr und der Block gemeinsame_steuerung sind additiv und werden
// ueberlesen, das Dokument jeder Box ist ein gewoehnlicher Plan 2.0. Ein
// Dokument ohne Entitaet lehnt die Box ab - darum bekommt eine Box ohne
// Entitaet im Lauf keins.
func TestGemeinsameSteuerungJeBoxEinDokumentEinePlanID(t *testing.T) {
	fuehrt, err := Parse(fixture(t, "mqtt-schedule-2.0.valid.gemeinsame-steuerung-fuehrt.json"), recv)
	if err != nil {
		t.Fatal(err)
	}
	mit, err := Parse(fixture(t, "mqtt-schedule-2.0.valid.gemeinsame-steuerung-steuert-mit.json"), recv)
	if err != nil {
		t.Fatal(err)
	}
	if fuehrt.PlanID != mit.PlanID || fuehrt.DeviceID == mit.DeviceID {
		t.Fatalf("one run, two boxes expected: %q/%q %q/%q", fuehrt.PlanID, fuehrt.DeviceID, mit.PlanID, mit.DeviceID)
	}
	if fuehrt.GridImportLimitKw == nil || mit.GridImportLimitKw != nil {
		t.Fatalf("peak target only at the leading box: %v / %v", fuehrt.GridImportLimitKw, mit.GridImportLimitKw)
	}
	if mit.Entity("pv-00000000-0000-0000-0000-0000000000e4") == nil || len(mit.Entities) != 1 {
		t.Fatalf("co-steering box entities wrong: %+v", mit.Entities)
	}
	leer := strings.Replace(string(fixture(t, "mqtt-schedule-2.0.valid.gemeinsame-steuerung-steuert-mit.json")),
		`"entities": [`, `"entities": [], "x": [`, 1)
	if _, err := Parse([]byte(leer), recv); Grund(err) != GrundKeineEntitaeten {
		t.Fatalf("empty document must be rejected keine_entitaeten, got %v", err)
	}
}
