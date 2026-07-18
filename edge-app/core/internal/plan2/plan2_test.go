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
