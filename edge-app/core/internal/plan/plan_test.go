package plan

import (
	"os"
	"path/filepath"
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

func TestUnplannedLoadDischargeIsAdditiveAndFailsClosed(t *testing.T) {
	legacy := mustParse(t, time.Now())
	if legacy.EffectiveFloorSoc() != nil || legacy.ActiveUnplannedLoadDischarge(legacy.Slots[0].Start.Add(time.Minute)) {
		t.Fatal("a legacy plan must never acquire the new discharge authority")
	}
	payload := `{"schema_version":"1.0","slot_minutes":15,"effective_floor_soc_pct":35,"slots":[{"start":"2026-07-01T09:00:00Z","battery_setpoint_kw":0,"unplanned_load_discharge":true}]}`
	p, err := Parse([]byte(payload), time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if floor := p.EffectiveFloorSoc(); floor == nil || *floor != 35 {
		t.Fatalf("floor = %v, want 35", floor)
	}
	if !p.ActiveUnplannedLoadDischarge(time.Date(2026, 7, 1, 9, 1, 0, 0, time.UTC)) {
		t.Fatal("fresh idle slot carrying both facts must be authorized")
	}
	charged, _ := Parse([]byte(`{"schema_version":"1.0","slot_minutes":15,"effective_floor_soc_pct":35,"slots":[{"start":"2026-07-01T09:00:00Z","battery_setpoint_kw":2,"unplanned_load_discharge":true}]}`), p.ReceivedAt)
	if charged.ActiveUnplannedLoadDischarge(time.Date(2026, 7, 1, 9, 1, 0, 0, time.UTC)) {
		t.Fatal("a charge slot must never be reinterpreted")
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

// The price-aware trim duty: only an EXPLICIT true carries it, the flag follows
// the ACTIVE slot exactly like the PV cap, and a stale plan drops it (the
// self-consumption fallback never grid-charges, so there is nothing to protect).
func TestParseAndActivateChargeFromSurplusOnly(t *testing.T) {
	payload := `{
      "schema_version": "1.0",
      "plan_id": "11111111-2222-3333-4444-555555555555",
      "generated_at": "2026-07-30T12:30:00Z",
      "slot_minutes": 15,
      "slots": [
        { "start": "2026-07-30T12:30:00Z", "battery_setpoint_kw": 10.8, "charge_from_surplus_only": true },
        { "start": "2026-07-30T12:45:00Z", "battery_setpoint_kw": 10.8, "charge_from_surplus_only": false },
        { "start": "2026-07-30T13:00:00Z", "battery_setpoint_kw": 10.8 }
      ]
    }`
	rx := time.Date(2026, 7, 30, 12, 31, 0, 0, time.UTC)
	p, err := Parse([]byte(payload), rx)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := []bool{true, false, false}
	for i, w := range want {
		if p.Slots[i].ChargeFromSurplusOnly != w {
			t.Fatalf("slot %d duty = %v, want %v", i, p.Slots[i].ChargeFromSurplusOnly, w)
		}
	}
	if !p.ActiveChargeFromSurplusOnly(rx) {
		t.Fatal("the active first slot must carry the duty")
	}
	if p.ActiveChargeFromSurplusOnly(time.Date(2026, 7, 30, 12, 46, 0, 0, time.UTC)) {
		t.Fatal("an explicit false slot carries no duty")
	}
	// Stale plan / no active slot -> no duty.
	stale := &Plan{SlotMinutes: 15, ReceivedAt: rx.Add(-30 * time.Minute), Slots: p.Slots}
	if stale.ActiveChargeFromSurplusOnly(rx) {
		t.Fatal("a stale plan must carry no duty")
	}
	if p.ActiveChargeFromSurplusOnly(rx.Add(4 * time.Hour)) {
		t.Fatal("outside every slot there is no duty")
	}
	// A legacy payload (no field anywhere) is byte-for-byte the old behavior.
	legacy := mustParse(t, rx)
	for i := range legacy.Slots {
		if legacy.Slots[i].ChargeFromSurplusOnly {
			t.Fatalf("legacy slot %d must carry no duty", i)
		}
	}
	if legacy.ActiveChargeFromSurplusOnly(time.Date(2026, 7, 1, 9, 5, 0, 0, time.UTC)) {
		t.Fatal("legacy plan must carry no duty")
	}
}

// The load-following duty follows the SAME rules as the trim duty: only an
// EXPLICIT true carries it, it follows the ACTIVE slot, and a stale plan drops it
// (the self-consumption fallback already follows the measured load).
func TestParseAndActivateCoverLoadFromBattery(t *testing.T) {
	payload := `{
      "schema_version": "1.0",
      "plan_id": "11111111-2222-3333-4444-555555555555",
      "generated_at": "2026-07-30T19:10:00Z",
      "slot_minutes": 15,
      "slots": [
        { "start": "2026-07-30T19:15:00Z", "battery_setpoint_kw": -4.332, "cover_load_from_battery": true },
        { "start": "2026-07-30T19:30:00Z", "battery_setpoint_kw": -4.481, "cover_load_from_battery": false },
        { "start": "2026-07-30T19:45:00Z", "battery_setpoint_kw": -5.331 }
      ]
    }`
	rx := time.Date(2026, 7, 30, 19, 16, 0, 0, time.UTC)
	p, err := Parse([]byte(payload), rx)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := []bool{true, false, false}
	for i, w := range want {
		if p.Slots[i].CoverLoadFromBattery != w {
			t.Fatalf("slot %d duty = %v, want %v", i, p.Slots[i].CoverLoadFromBattery, w)
		}
	}
	if !p.ActiveCoverLoadFromBattery(rx) {
		t.Fatal("the active first slot must carry the duty")
	}
	if p.ActiveCoverLoadFromBattery(time.Date(2026, 7, 30, 19, 31, 0, 0, time.UTC)) {
		t.Fatal("an explicit false slot carries no duty")
	}
	// Stale plan / no active slot -> no duty.
	stale := &Plan{SlotMinutes: 15, ReceivedAt: rx.Add(-30 * time.Minute), Slots: p.Slots}
	if stale.ActiveCoverLoadFromBattery(rx) {
		t.Fatal("a stale plan must carry no duty")
	}
	if p.ActiveCoverLoadFromBattery(rx.Add(4 * time.Hour)) {
		t.Fatal("outside every slot there is no duty")
	}
	// A legacy payload (no field anywhere) is byte-for-byte the old behavior.
	legacy := mustParse(t, rx)
	for i := range legacy.Slots {
		if legacy.Slots[i].CoverLoadFromBattery {
			t.Fatalf("legacy slot %d must carry no duty", i)
		}
	}
	// The two duties are INDEPENDENT: neither flag ever implies the other.
	if p.Slots[0].ChargeFromSurplusOnly {
		t.Fatal("cover_load_from_battery must not imply charge_from_surplus_only")
	}
}

// The surplus-absorption duty follows the SAME rules as its two siblings: only
// an EXPLICIT true carries it, it follows the ACTIVE slot, and a stale plan drops
// it (the self-consumption fallback already charges the measured surplus).
func TestParseAndActivateChargeSurplusToBattery(t *testing.T) {
	payload := `{
      "schema_version": "1.0",
      "plan_id": "11111111-2222-3333-4444-555555555555",
      "generated_at": "2026-08-02T08:25:00Z",
      "slot_minutes": 15,
      "slots": [
        { "start": "2026-08-02T08:30:00Z", "battery_setpoint_kw": 0.0, "charge_surplus_to_battery": true },
        { "start": "2026-08-02T08:45:00Z", "battery_setpoint_kw": 3.0, "charge_surplus_to_battery": false },
        { "start": "2026-08-02T09:00:00Z", "battery_setpoint_kw": 12.0 }
      ]
    }`
	rx := time.Date(2026, 8, 2, 8, 31, 0, 0, time.UTC)
	p, err := Parse([]byte(payload), rx)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := []bool{true, false, false}
	for i, w := range want {
		if p.Slots[i].ChargeSurplusToBattery != w {
			t.Fatalf("slot %d duty = %v, want %v", i, p.Slots[i].ChargeSurplusToBattery, w)
		}
	}
	if !p.ActiveChargeSurplusToBattery(rx) {
		t.Fatal("the active first slot must carry the duty")
	}
	if p.ActiveChargeSurplusToBattery(time.Date(2026, 8, 2, 8, 46, 0, 0, time.UTC)) {
		t.Fatal("an explicit false slot carries no duty")
	}
	// Stale plan / no active slot -> no duty.
	stale := &Plan{SlotMinutes: 15, ReceivedAt: rx.Add(-30 * time.Minute), Slots: p.Slots}
	if stale.ActiveChargeSurplusToBattery(rx) {
		t.Fatal("a stale plan must carry no duty")
	}
	if p.ActiveChargeSurplusToBattery(rx.Add(4 * time.Hour)) {
		t.Fatal("outside every slot there is no duty")
	}
	// A legacy payload (no field anywhere) is byte-for-byte the old behavior.
	legacy := mustParse(t, rx)
	for i := range legacy.Slots {
		if legacy.Slots[i].ChargeSurplusToBattery {
			t.Fatalf("legacy slot %d must carry no duty", i)
		}
	}
	// The three duties are INDEPENDENT: no flag ever implies another.
	if p.Slots[0].ChargeFromSurplusOnly || p.Slots[0].CoverLoadFromBattery {
		t.Fatal("charge_surplus_to_battery must not imply either sibling duty")
	}
}

// The COMMITTED contract fixtures are what the device really parses: the same
// bytes the cloud publishes and the Python contract test validates
// (docs/contracts/examples/, read by path on purpose - moving a fixture must
// break this test).
func TestCommittedContractFixturesParse(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")
	rx := time.Date(2026, 7, 30, 12, 31, 0, 0, time.UTC)

	plain, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.valid.plain.json"))
	if err != nil {
		t.Fatal(err)
	}
	pp, err := Parse(plain, rx)
	if err != nil {
		t.Fatalf("plain fixture: %v", err)
	}
	if pp.ActiveChargeFromSurplusOnly(rx) {
		t.Fatal("the plain fixture carries no trim duty")
	}
	if kw, _, ok := pp.ActiveSetpoint(rx); !ok || kw != 10.8 {
		t.Fatalf("plain fixture setpoint = %v ok=%v, want 10.8", kw, ok)
	}

	trimmed, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.valid.surplus-only-charge.json"))
	if err != nil {
		t.Fatal(err)
	}
	tp, err := Parse(trimmed, rx)
	if err != nil {
		t.Fatalf("trimmed fixture: %v", err)
	}
	if !tp.ActiveChargeFromSurplusOnly(rx) {
		t.Fatal("the trimmed fixture's active slot must carry the duty")
	}
	// The last slots of that fixture are a plain charge and a discharge.
	if tp.Slots[2].ChargeFromSurplusOnly || tp.Slots[3].ChargeFromSurplusOnly {
		t.Fatal("only the marked slots carry the duty")
	}

	// The discharge-side fixture (the Pilsting night shape).
	covering, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.valid.cover-load.json"))
	if err != nil {
		t.Fatal(err)
	}
	nightRx := time.Date(2026, 7, 30, 19, 16, 0, 0, time.UTC)
	cp, err := Parse(covering, nightRx)
	if err != nil {
		t.Fatalf("cover-load fixture: %v", err)
	}
	if !cp.ActiveCoverLoadFromBattery(nightRx) {
		t.Fatal("the cover-load fixture's active slot must carry the duty")
	}
	if kw, _, ok := cp.ActiveSetpoint(nightRx); !ok || kw != -4.332 {
		t.Fatalf("cover-load fixture setpoint = %v ok=%v, want -4.332", kw, ok)
	}
	// Its last two slots are a full-power discharge and an idle slot - neither
	// carries the duty, and NO slot of it carries the charge-side one.
	if cp.Slots[2].CoverLoadFromBattery || cp.Slots[3].CoverLoadFromBattery {
		t.Fatal("only the marked slots carry the duty")
	}
	for i := range cp.Slots {
		if cp.Slots[i].ChargeFromSurplusOnly {
			t.Fatalf("cover-load fixture slot %d must carry no trim duty", i)
		}
	}
	// ...and the charge-side fixture carries no load-following duty.
	for i := range tp.Slots {
		if tp.Slots[i].CoverLoadFromBattery {
			t.Fatalf("surplus-only fixture slot %d must carry no load-following duty", i)
		}
	}
	// The plain fixture carries neither.
	if pp.ActiveCoverLoadFromBattery(rx) {
		t.Fatal("the plain fixture carries no load-following duty")
	}

	// The charge-side ABSORPTION fixture (the Pilsting morning shape: a fully
	// curtailed slot commanding 0,0 kW while the real surplus is exported).
	absorbing, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.valid.absorb-surplus.json"))
	if err != nil {
		t.Fatal(err)
	}
	mornRx := time.Date(2026, 8, 2, 8, 31, 0, 0, time.UTC)
	ap, err := Parse(absorbing, mornRx)
	if err != nil {
		t.Fatalf("absorb-surplus fixture: %v", err)
	}
	if !ap.ActiveChargeSurplusToBattery(mornRx) {
		t.Fatal("the absorb-surplus fixture's active slot must carry the duty")
	}
	if kw, _, ok := ap.ActiveSetpoint(mornRx); !ok || kw != 0.0 {
		t.Fatalf("absorb-surplus fixture setpoint = %v ok=%v, want 0.0", kw, ok)
	}
	// Its first slot is fully curtailed (cap 0 kW) - the Fahrplan "Abregeln"
	// shape the observed morning showed.
	if ap.Slots[0].PvLimitKw == nil || *ap.Slots[0].PvLimitKw != 0.0 {
		t.Fatalf("absorb-surplus fixture slot 0 pv_limit = %v, want 0.0", ap.Slots[0].PvLimitKw)
	}
	// Its last two slots (a plain charge and a discharge) carry no duty, and NO
	// slot of it carries either sibling duty.
	if ap.Slots[2].ChargeSurplusToBattery || ap.Slots[3].ChargeSurplusToBattery {
		t.Fatal("only the marked slots carry the duty")
	}
	for i := range ap.Slots {
		if ap.Slots[i].ChargeFromSurplusOnly || ap.Slots[i].CoverLoadFromBattery {
			t.Fatalf("absorb-surplus fixture slot %d must carry no sibling duty", i)
		}
	}
	// ...and the other three fixtures carry no absorption duty.
	if pp.ActiveChargeSurplusToBattery(rx) {
		t.Fatal("the plain fixture carries no absorption duty")
	}
	for i := range tp.Slots {
		if tp.Slots[i].ChargeSurplusToBattery {
			t.Fatalf("surplus-only fixture slot %d must carry no absorption duty", i)
		}
	}
	for i := range cp.Slots {
		if cp.Slots[i].ChargeSurplusToBattery {
			t.Fatalf("cover-load fixture slot %d must carry no absorption duty", i)
		}
	}

	// The REDUCE-ONLY fixture (the Herzogau night shape, 2026-09-08): a slot
	// that carries ONLY the limit right, one that carries it ALONGSIDE the
	// economic duty (the cloud emits it as a superset), a planned sale and a
	// planned charge that carry neither.
	limiting, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.valid.limit-discharge.json"))
	if err != nil {
		t.Fatal(err)
	}
	nightRx2 := time.Date(2026, 9, 4, 21, 16, 0, 0, time.UTC)
	dp, err := Parse(limiting, nightRx2)
	if err != nil {
		t.Fatalf("limit-discharge fixture: %v", err)
	}
	if !dp.ActiveLimitDischargeToLoad(nightRx2) {
		t.Fatal("the limit-discharge fixture's active slot must carry the right")
	}
	// Its FIRST slot deliberately carries the right WITHOUT the economic duty -
	// that combination IS the fix (lambda above the fixed import price).
	if dp.ActiveCoverLoadFromBattery(nightRx2) {
		t.Fatal("the fixture's first slot must carry no economic duty")
	}
	if kw, _, ok := dp.ActiveSetpoint(nightRx2); !ok || kw != -6.06 {
		t.Fatalf("limit-discharge fixture setpoint = %v ok=%v, want -6.06", kw, ok)
	}
	// The second slot carries BOTH - the superset case an edge must handle.
	if !dp.Slots[1].LimitDischargeToLoad || !dp.Slots[1].CoverLoadFromBattery {
		t.Fatal("the fixture's second slot must carry both grants")
	}
	// The sale and the charge carry neither.
	for _, i := range []int{2, 3} {
		if dp.Slots[i].LimitDischargeToLoad || dp.Slots[i].CoverLoadFromBattery {
			t.Fatalf("limit-discharge fixture slot %d must carry no grant", i)
		}
	}
	// ...and no OTHER fixture carries the new right: absent means absent.
	for name, other := range map[string]*Plan{"plain": pp, "surplus-only": tp, "cover-load": cp, "absorb": ap} {
		for i := range other.Slots {
			if other.Slots[i].LimitDischargeToLoad {
				t.Fatalf("%s fixture slot %d must carry no limit right", name, i)
			}
		}
	}

	// The FEED-IN LIMIT fixture (the Pilsting shape: a 30 kW connection-point
	// limit alongside an ordinary plan, one of whose slots also curtails).
	limited, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.valid.export-limit.json"))
	if err != nil {
		t.Fatal(err)
	}
	limRx := time.Date(2026, 8, 6, 9, 1, 0, 0, time.UTC)
	lp, err := Parse(limited, limRx)
	if err != nil {
		t.Fatalf("export-limit fixture: %v", err)
	}
	if lp.ExportLimit() == nil || *lp.ExportLimit() != 30.0 {
		t.Fatalf("export-limit fixture limit = %v, want 30", lp.ExportLimit())
	}
	// It survives staleness on purpose: a dead optimizer must never hand a plant
	// back its unlimited feed-in.
	lp.ReceivedAt = limRx.Add(-2 * StaleAfter)
	if lp.ExportLimit() == nil {
		t.Fatal("the feed-in limit must survive plan staleness")
	}
	if lp.ActivePvLimit(limRx) != nil {
		t.Fatal("the fixture's active slot carries no planned curtailment")
	}
	// The other fixtures carry no limit - absent means absent, never a guess.
	for name, other := range map[string]*Plan{"plain": pp, "surplus-only": tp, "cover-load": cp, "absorb": ap} {
		if other.ExportLimit() != nil {
			t.Fatalf("%s fixture must carry no feed-in limit", name)
		}
	}
}

// A malformed feed-in limit leaves the site with NO limit and the honest state
// that says so - never a nonsensical compliance target. The committed invalid
// fixture is the same bytes the schema rejects.
func TestAMalformedFeedInLimitIsDroppedNotGuessed(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")
	raw, err := os.ReadFile(filepath.Join(dir, "mqtt-schedule.invalid.export-limit-negative.json"))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Parse(raw, time.Date(2026, 8, 6, 9, 1, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("the payload is otherwise well-formed: %v", err)
	}
	if p.ExportLimit() != nil {
		t.Fatalf("a negative limit must be dropped, got %v", *p.ExportLimit())
	}
}
