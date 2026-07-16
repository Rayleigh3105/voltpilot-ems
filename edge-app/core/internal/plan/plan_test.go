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

// The optional pv_limit_kw (Phase-3 curtailment) is parsed and retained per
// slot; absent stays nil, and a bad/negative value is dropped (never shown as a
// real curtailment). The edge does not execute the field - only displays it.
func TestParseKeepsPvLimitCurtailment(t *testing.T) {
	payload := `{
	  "schema_version": "1.0", "slot_minutes": 15,
	  "slots": [
	    { "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": 5.0, "pv_limit_kw": 3.5 },
	    { "start": "2026-07-01T09:15:00Z", "battery_setpoint_kw": -2.0 },
	    { "start": "2026-07-01T09:30:00Z", "battery_setpoint_kw": 1.0, "pv_limit_kw": -1.0 }
	  ]
	}`
	p, err := Parse([]byte(payload), time.Now())
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if p.Slots[0].PvLimitKw == nil || *p.Slots[0].PvLimitKw != 3.5 {
		t.Errorf("slot 0 pv_limit not kept: %+v", p.Slots[0].PvLimitKw)
	}
	if p.Slots[1].PvLimitKw != nil {
		t.Errorf("absent pv_limit must stay nil: %+v", p.Slots[1].PvLimitKw)
	}
	if p.Slots[2].PvLimitKw != nil {
		t.Errorf("negative pv_limit must be dropped: %+v", p.Slots[2].PvLimitKw)
	}
}

// The optional grid_charge_allowed (P5 EEG execution gap) is parsed, drives
// SolarOnlyCharge, and survives the disk round-trip. FAIL-SAFE: only an
// explicit true releases the clamp; an ABSENT field (legacy/hand-crafted
// payload) and a nil plan demand the most restrictive posture.
func TestParseGridChargeAllowed(t *testing.T) {
	slot := `{ "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": 5.0 }`

	eeg, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,"grid_charge_allowed":false,"slots":[`+slot+`]}`), time.Now())
	if err != nil {
		t.Fatalf("Parse eeg: %v", err)
	}
	if eeg.GridChargeAllowed == nil || *eeg.GridChargeAllowed || !eeg.SolarOnlyCharge() {
		t.Errorf("grid_charge_allowed=false must demand the solar-only clamp: %+v", eeg.GridChargeAllowed)
	}

	merchant, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,"grid_charge_allowed":true,"slots":[`+slot+`]}`), time.Now())
	if err != nil {
		t.Fatalf("Parse merchant: %v", err)
	}
	if merchant.GridChargeAllowed == nil || !*merchant.GridChargeAllowed || merchant.SolarOnlyCharge() {
		t.Errorf("grid_charge_allowed=true must not clamp: %+v", merchant.GridChargeAllowed)
	}

	legacy := mustParse(t, time.Now()) // contractPayload carries no field
	if legacy.GridChargeAllowed != nil {
		t.Errorf("absent field must stay nil: %+v", legacy.GridChargeAllowed)
	}
	if !legacy.SolarOnlyCharge() {
		t.Error("absent field must demand the clamp (fail-safe, most restrictive)")
	}

	var nilPlan *Plan
	if !nilPlan.SolarOnlyCharge() {
		t.Error("nil plan must demand the clamp (fail-safe)")
	}

	// Disk round-trip keeps the posture (reboot-without-network case).
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.Save(eeg); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !loaded.SolarOnlyCharge() {
		t.Errorf("persisted plan lost grid_charge_allowed=false: %+v", loaded.GridChargeAllowed)
	}
}

// The optional PS-1/PS-2 peak fields (grid_import_limit_kw +
// peak_reserve_soc_pct) are parsed, validated, exposed independent of
// freshness (the PS-3 guard defends the LAST KNOWN target on a dead cloud
// link) and survive the disk round-trip; absent fields = nil = module off.
func TestParsePeakShavingFields(t *testing.T) {
	slot := `{ "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": 5.0 }`

	peak, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,
		"grid_import_limit_kw":62.5,"peak_reserve_soc_pct":25,"slots":[`+slot+`]}`), time.Now())
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if lim := peak.PeakImportLimit(); lim == nil || *lim != 62.5 {
		t.Errorf("peak target not kept: %v", lim)
	}
	if res := peak.PeakReserveSoc(); res == nil || *res != 25 {
		t.Errorf("peak reserve not kept: %v", res)
	}

	// Absent fields = module off (byte-for-byte pre-PS behavior).
	legacy := mustParse(t, time.Now())
	if legacy.PeakImportLimit() != nil || legacy.PeakReserveSoc() != nil {
		t.Errorf("absent fields must stay nil: %+v %+v", legacy.GridImportLimitKw, legacy.PeakReserveSocPct)
	}
	var nilPlan *Plan
	if nilPlan.PeakImportLimit() != nil || nilPlan.PeakReserveSoc() != nil {
		t.Error("nil plan must expose no peak fields")
	}

	// Invalid values are dropped, never latched: a negative target, and a
	// reserve without a (valid) target or outside 0..100.
	bad, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,
		"grid_import_limit_kw":-3,"peak_reserve_soc_pct":25,"slots":[`+slot+`]}`), time.Now())
	if err != nil {
		t.Fatalf("Parse bad: %v", err)
	}
	if bad.PeakImportLimit() != nil {
		t.Errorf("negative target must be dropped: %v", bad.GridImportLimitKw)
	}
	if bad.PeakReserveSoc() != nil {
		t.Errorf("reserve without a valid target must be dropped: %v", bad.PeakReserveSocPct)
	}
	badRes, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,
		"grid_import_limit_kw":60,"peak_reserve_soc_pct":140,"slots":[`+slot+`]}`), time.Now())
	if err != nil {
		t.Fatalf("Parse badRes: %v", err)
	}
	if badRes.PeakImportLimit() == nil || badRes.PeakReserveSoc() != nil {
		t.Errorf("out-of-range reserve must be dropped, target kept: %v %v",
			badRes.GridImportLimitKw, badRes.PeakReserveSocPct)
	}

	// The accessors deliberately ignore staleness: a stale plan still answers.
	peak.ReceivedAt = time.Now().Add(-2 * time.Hour)
	if !peak.Fresh(time.Now()) && peak.PeakImportLimit() == nil {
		t.Error("stale plan must still expose the last known target (PS-3 fallback)")
	}

	// Disk round-trip keeps the module state (reboot-without-network case).
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if err := store.Save(peak); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if lim := loaded.PeakImportLimit(); lim == nil || *lim != 62.5 {
		t.Errorf("persisted plan lost the peak target: %v", loaded.GridImportLimitKw)
	}
	if res := loaded.PeakReserveSoc(); res == nil || *res != 25 {
		t.Errorf("persisted plan lost the peak reserve: %v", loaded.PeakReserveSocPct)
	}
}

// BuildView marks the executing slot (only while fresh) and flags curtailed
// slots, so the local Fahrplan view can render freshness + the active bar.
func TestBuildViewMarksActiveAndCurtailed(t *testing.T) {
	payload := `{
	  "schema_version": "1.0", "slot_minutes": 15,
	  "slots": [
	    { "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": -25.0 },
	    { "start": "2026-07-01T09:15:00Z", "battery_setpoint_kw": 30.0, "pv_limit_kw": 4.0 }
	  ]
	}`
	rx := time.Date(2026, 7, 1, 9, 1, 0, 0, time.UTC)
	p, err := Parse([]byte(payload), rx)
	if err != nil {
		t.Fatal(err)
	}

	// Fresh plan, "now" inside the first slot.
	v := p.BuildView(time.Date(2026, 7, 1, 9, 7, 0, 0, time.UTC))
	if !v.Fresh || v.ActiveIndex != 0 {
		t.Fatalf("expected fresh plan, active slot 0: %+v", v)
	}
	if len(v.Slots) != 2 || !v.Slots[0].Active || v.Slots[1].Active {
		t.Errorf("active flag wrong: %+v", v.Slots)
	}
	if v.Slots[0].Curtailed || !v.Slots[1].Curtailed {
		t.Errorf("curtailed flag wrong: %+v", v.Slots)
	}
	if v.StaleAfterSeconds != int(StaleAfter/time.Second) {
		t.Errorf("stale window not exposed: %d", v.StaleAfterSeconds)
	}

	// Stale plan (>20 min after receipt): no active slot even though one covers now.
	vs := p.BuildView(rx.Add(21 * time.Minute))
	if vs.Fresh || vs.ActiveIndex != -1 {
		t.Errorf("stale plan must have no active slot: %+v", vs)
	}
	for _, s := range vs.Slots {
		if s.Active {
			t.Errorf("no slot may be active in a stale plan: %+v", s)
		}
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

// A retained-schedule REDELIVERY (broker replays the retained plan on every
// reconnect) must not reset the staleness clock: a plan whose generated_at is
// already far in the past is anchored to its generation time, so a dead
// optimizer's hours-old plan never drives the battery for another 20 min after
// each reconnect - the self-consumption fallback engages immediately. Matches
// the disk-cache path, which preserves the original ReceivedAt.
func TestRedeliveredOldPlanIsStaleImmediately(t *testing.T) {
	now := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	slots := `[{ "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": 5.0 },
	           { "start": "2026-07-01T12:00:00Z", "battery_setpoint_kw": 5.0 }]`

	// Generated 3h ago, redelivered now: stale at once, even though a slot
	// covers now (the 24h horizon outlives the optimizer by design).
	old, err := Parse([]byte(`{"schema_version":"1.0","generated_at":"2026-07-01T09:00:00Z","slot_minutes":15,"slots":`+slots+`}`), now)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if old.Fresh(now) {
		t.Error("redelivered 3h-old plan must be stale immediately")
	}
	if _, _, ok := old.ActiveSetpoint(now); ok {
		t.Error("redelivered 3h-old plan must not drive the battery")
	}

	// Generated within StaleAfter+slack: a genuine fresh publish (or a
	// redelivery of a still-current plan) keeps today's behavior byte-for-byte.
	recent, err := Parse([]byte(`{"schema_version":"1.0","generated_at":"2026-07-01T11:50:00Z","slot_minutes":15,"slots":`+slots+`}`), now)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !recent.ReceivedAt.Equal(now) || !recent.Fresh(now) {
		t.Errorf("10-min-old plan must stay fresh with receivedAt=now: %+v", recent.ReceivedAt)
	}

	// No parseable generated_at: nothing to bound by - receipt-time anchor as
	// before (legacy payloads keep working).
	unbounded, err := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,"slots":`+slots+`}`), now)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !unbounded.ReceivedAt.Equal(now) || !unbounded.Fresh(now) {
		t.Errorf("plan without generated_at keeps the receipt anchor: %+v", unbounded.ReceivedAt)
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

func TestActivePvLimitForwardsAndClears(t *testing.T) {
	now := time.Date(2026, 7, 8, 12, 0, 0, 0, time.UTC)
	cap := 3.0
	p := &Plan{
		SlotMinutes: 15,
		ReceivedAt:  now,
		Slots: []Slot{
			{Start: now.Add(-1 * time.Minute), BatterySetpointKw: -5, PvLimitKw: &cap},
			{Start: now.Add(14 * time.Minute), BatterySetpointKw: -5}, // next slot, no cap
		},
	}
	got := p.ActivePvLimit(now)
	if got == nil || *got != 3.0 {
		t.Fatalf("ActivePvLimit = %v, want 3", got)
	}
	// A slot without a cap -> nil (the core then clears any latched limit).
	if p.ActivePvLimit(now.Add(15*time.Minute)) != nil {
		t.Fatal("uncapped slot should yield nil pv limit")
	}
	// A stale plan yields nil regardless of the slot's cap.
	stale := &Plan{SlotMinutes: 15, ReceivedAt: now.Add(-30 * time.Minute), Slots: p.Slots}
	if stale.ActivePvLimit(now) != nil {
		t.Fatal("stale plan should yield nil pv limit")
	}
}
