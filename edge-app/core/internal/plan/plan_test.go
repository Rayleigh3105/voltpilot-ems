package plan

import (
	"testing"
	"time"
)

// contractPayload is shaped exactly like the frozen
// docs/contracts/mqtt-schedule.schema.json example.
const contractPayload = `{
  "schema_version": "1.0",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "site_id": "00000000-0000-0000-0000-000000000002",
  "device_id": "00000000-0000-0000-0000-000000000003",
  "plan_id": "11111111-2222-3333-4444-555555555555",
  "generated_at": "2026-07-01T09:00:00Z",
  "horizon_slots": 2,
  "slot_minutes": 15,
  "slots": [
    { "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": -25.0 },
    { "start": "2026-07-01T09:15:00Z", "battery_setpoint_kw": 30.0 }
  ]
}`

func mustParse(t *testing.T, receivedAt time.Time) *Plan {
	t.Helper()
	p, err := Parse([]byte(contractPayload), receivedAt)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return p
}

func TestParseContractPayload(t *testing.T) {
	rx := time.Date(2026, 7, 1, 9, 1, 0, 0, time.UTC)
	p := mustParse(t, rx)
	if p.PlanID != "11111111-2222-3333-4444-555555555555" || p.SlotMinutes != 15 || len(p.Slots) != 2 {
		t.Fatalf("unexpected plan: %+v", p)
	}
	if !p.ReceivedAt.Equal(rx) {
		t.Errorf("receivedAt not stamped")
	}
}

func TestParseRejectsMalformed(t *testing.T) {
	cases := map[string]string{
		"bad json":       `{`,
		"wrong version":  `{"schema_version":"2.0","slot_minutes":15,"slots":[{"start":"2026-07-01T09:00:00Z","battery_setpoint_kw":1}]}`,
		"no slots":       `{"schema_version":"1.0","slot_minutes":15,"slots":[]}`,
		"no slot width":  `{"schema_version":"1.0","slots":[{"start":"2026-07-01T09:00:00Z","battery_setpoint_kw":1}]}`,
		"bad slot start": `{"schema_version":"1.0","slot_minutes":15,"slots":[{"start":"gestern","battery_setpoint_kw":1}]}`,
	}
	for name, payload := range cases {
		if _, err := Parse([]byte(payload), time.Now()); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestActiveSetpointSelectsCoveringSlot(t *testing.T) {
	rx := time.Date(2026, 7, 1, 9, 1, 0, 0, time.UTC)
	p := mustParse(t, rx)

	kw, start, ok := p.ActiveSetpoint(time.Date(2026, 7, 1, 9, 7, 0, 0, time.UTC))
	if !ok || kw != -25 || !start.Equal(time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("first slot: got %v %v %v", kw, start, ok)
	}
	// Slot boundary belongs to the NEXT slot ([start, start+width)).
	kw, _, ok = p.ActiveSetpoint(time.Date(2026, 7, 1, 9, 15, 0, 0, time.UTC))
	if !ok || kw != 30 {
		t.Errorf("boundary slot: got %v %v", kw, ok)
	}
	// After the horizon: no active slot.
	if _, _, ok := p.ActiveSetpoint(time.Date(2026, 7, 1, 9, 30, 0, 0, time.UTC)); ok {
		t.Errorf("past horizon must not select a slot")
	}
	// Before the first slot: no active slot.
	if _, _, ok := p.ActiveSetpoint(time.Date(2026, 7, 1, 8, 59, 0, 0, time.UTC)); ok {
		t.Errorf("before horizon must not select a slot")
	}
}

func TestStalenessWindowMirrorsContract(t *testing.T) {
	rx := time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)
	p := mustParse(t, rx)

	// 19 min after receipt: still fresh (now inside the second slot).
	if _, _, ok := p.ActiveSetpoint(rx.Add(19 * time.Minute)); !ok {
		t.Errorf("fresh plan must drive")
	}
	// 21 min after receipt: STALE even though a slot covers now -> fallback.
	if _, _, ok := p.ActiveSetpoint(rx.Add(21 * time.Minute)); ok {
		t.Errorf("stale plan (20-min window) must NOT drive")
	}
	if p.Fresh(rx.Add(21 * time.Minute)) {
		t.Errorf("Fresh must be false after 20 min")
	}
	var nilPlan *Plan
	if nilPlan.Fresh(rx) {
		t.Errorf("nil plan is never fresh")
	}
	if _, _, ok := nilPlan.ActiveSetpoint(rx); ok {
		t.Errorf("nil plan has no setpoint")
	}
}

func TestStoreRoundtrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Empty store: nil, no error.
	if p, err := s.Load(); err != nil || p != nil {
		t.Fatalf("empty load: %v %v", p, err)
	}
	rx := time.Date(2026, 7, 1, 9, 1, 0, 0, time.UTC)
	if err := s.Save(mustParse(t, rx)); err != nil {
		t.Fatal(err)
	}
	// Fresh store instance = restart: the plan survives with receivedAt.
	s2, _ := NewStore(dir)
	p, err := s2.Load()
	if err != nil || p == nil {
		t.Fatalf("load after restart: %v %v", p, err)
	}
	if !p.ReceivedAt.Equal(rx) || len(p.Slots) != 2 || p.Slots[0].BatterySetpointKw != -25 {
		t.Errorf("persisted plan differs: %+v", p)
	}
}
