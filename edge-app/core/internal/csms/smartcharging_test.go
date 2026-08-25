package csms_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

func TestCloudChangeConfigurationPersistsResponseAndPerformsReadback(t *testing.T) {
	now := time.Now().UTC()
	s, endpoint := startServerWithClock(t, func() time.Time { return now }, "CMD-CP")
	_, station := connectStation(t, s, endpoint, "CMD-CP", func() time.Time { return now })
	cmd := map[string]any{"schema_version": "1.0", "type": "ocpp_command", "tenant_id": "tenant-a",
		"site_id": "site-a", "device_id": "device-a", "charge_point_id": "CMD-CP",
		"action_id": "33333333-3333-4333-8333-333333333333", "correlation_id": "ocpp-33333333-3333-4333-8333-333333333333",
		"requested_at": now.Format(time.RFC3339Nano), "deadline_at": now.Add(30 * time.Second).Format(time.RFC3339Nano),
		"request_hash": strings.Repeat("c", 64), "action": "ChangeConfiguration",
		"request": map[string]any{"key": "HeartbeatInterval", "value": "123"}}
	raw, _ := json.Marshal(cmd)
	if err := s.ExecuteCloudCommand(context.Background(), raw, csms.CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	readbackDeadline := time.Now().Add(2 * time.Second)
	ready := false
	for time.Now().Before(readbackDeadline) {
		station.mu.Lock()
		ready = station.targetedConfigurationReads > 0 && station.config["HeartbeatInterval"] == "123"
		station.mu.Unlock()
		if ready {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !ready {
		t.Fatal("ChangeConfiguration response did not trigger a targeted persisted readback")
	}
	if err := s.ExecuteCloudCommand(context.Background(), raw, csms.CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}); err != nil {
		t.Fatalf("QoS1 replay: %v", err)
	}
	station.mu.Lock()
	changedCount := len(station.changed)
	station.mu.Unlock()
	if changedCount != 1 {
		t.Fatalf("replayed command executed %d times", changedCount)
	}
	seenResult, seenReadback := false, false
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !(seenResult && seenReadback) {
		eventRaw, token, ok := s.NextProtocolEvent()
		if !ok {
			time.Sleep(5 * time.Millisecond)
			continue
		}
		var event csms.ProtocolEvent
		_ = json.Unmarshal(eventRaw, &event)
		if event.MessageType == "CallResult" && event.Action == "ChangeConfiguration" && event.CorrelationID == "ocpp-33333333-3333-4333-8333-333333333333" {
			seenResult = true
		}
		if event.MessageType == "CallResult" && event.Action == "GetConfiguration" && strings.HasPrefix(event.CorrelationID, "readback-") {
			seenReadback = true
		}
		if err := s.AckProtocolEvent(token); err != nil {
			t.Fatal(err)
		}
	}
	if !seenResult || !seenReadback {
		t.Fatalf("persisted choreography missing: response=%v readback=%v", seenResult, seenReadback)
	}
}

// station is a charge point that REALLY behaves like one for the parts that
// matter here: it stores the profiles it is told to store, answers
// GetCompositeSchedule from that store with the OCPP precedence
// (TxProfile beats TxDefaultProfile, capped by ChargePointMaxProfile) and
// lets the schedule's `duration` EXPIRE — which is the whole dead man's
// switch. It is the in-process twin of the SAP simulator's profile handling
// (Konzept §6.2), so the fallback is provable in `go test`.
type station struct {
	mu sync.Mutex
	// profiles keyed by (connectorId, chargingProfileId)
	profiles map[[2]int]storedProfile
	config   map[string]string
	// refuseProfiles makes every SetChargingProfile answer Rejected.
	refuseProfiles bool
	// refuseComposite makes GetCompositeSchedule answer Rejected.
	refuseComposite            bool
	now                        func() time.Time
	setCalls                   int
	changed                    []string
	rejectFullConfiguration    bool
	targetedConfigurationReads int
	fullConfigurationReads     int
}

type storedProfile struct {
	purpose   types.ChargingProfilePurposeType
	limitW    float64
	startsAt  time.Time
	duration  time.Duration
	connector int
}

func newStation(now func() time.Time) *station {
	return &station{
		profiles: map[[2]int]storedProfile{},
		config: map[string]string{
			csms.KeyAllowedChargingRateUnit: "Power",
			csms.KeyMaxStackLevel:           "8",
			csms.KeyMaxPeriods:              "24",
			csms.KeyMaxProfilesInstalled:    "10",
		},
		now: now,
	}
}

func (s *station) OnSetChargingProfile(r *smartcharging.SetChargingProfileRequest) (*smartcharging.SetChargingProfileConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setCalls++
	if s.refuseProfiles {
		return smartcharging.NewSetChargingProfileConfirmation(smartcharging.ChargingProfileStatusRejected), nil
	}
	p := r.ChargingProfile
	sp := storedProfile{purpose: p.ChargingProfilePurpose, connector: r.ConnectorId}
	if sch := p.ChargingSchedule; sch != nil {
		if len(sch.ChargingSchedulePeriod) > 0 {
			sp.limitW = sch.ChargingSchedulePeriod[0].Limit
		}
		if sch.StartSchedule != nil {
			sp.startsAt = sch.StartSchedule.Time
		}
		if sch.Duration != nil {
			sp.duration = time.Duration(*sch.Duration) * time.Second
		}
	}
	s.profiles[[2]int{r.ConnectorId, p.ChargingProfileId}] = sp
	return smartcharging.NewSetChargingProfileConfirmation(smartcharging.ChargingProfileStatusAccepted), nil
}

func (s *station) OnClearChargingProfile(r *smartcharging.ClearChargingProfileRequest) (*smartcharging.ClearChargingProfileConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for k := range s.profiles {
		if r.Id != nil && k[1] == *r.Id {
			delete(s.profiles, k)
			found = true
		}
	}
	st := smartcharging.ClearChargingProfileStatusUnknown
	if found {
		st = smartcharging.ClearChargingProfileStatusAccepted
	}
	return smartcharging.NewClearChargingProfileConfirmation(st), nil
}

// effectiveLimitW resolves the station's profile stack the way OCPP says:
// TxProfile (if it applies right now) beats TxDefaultProfile, and the whole
// thing is capped by ChargePointMaxProfile. An EXPIRED TxProfile does not
// apply - that expiry IS the dead man's switch.
func (s *station) effectiveLimitW(connector int) (float64, bool) {
	now := s.now()
	best, have := 0.0, false
	maxW, haveMax := 0.0, false
	for _, p := range s.profiles {
		if p.connector != 0 && p.connector != connector {
			continue
		}
		if p.duration > 0 && !p.startsAt.IsZero() && now.After(p.startsAt.Add(p.duration)) {
			continue // expired
		}
		switch p.purpose {
		case types.ChargingProfilePurposeChargePointMaxProfile:
			maxW, haveMax = p.limitW, true
		case types.ChargingProfilePurposeTxProfile:
			best, have = p.limitW, true
		case types.ChargingProfilePurposeTxDefaultProfile:
			if !have {
				best, have = p.limitW, true
			}
		}
	}
	// A TxProfile always wins over a TxDefault, whatever map order gave us.
	for _, p := range s.profiles {
		if (p.connector == 0 || p.connector == connector) &&
			p.purpose == types.ChargingProfilePurposeTxProfile &&
			!(p.duration > 0 && !p.startsAt.IsZero() && now.After(p.startsAt.Add(p.duration))) {
			best, have = p.limitW, true
		}
	}
	if haveMax && have && best > maxW {
		best = maxW
	}
	return best, have
}

func (s *station) OnGetCompositeSchedule(r *smartcharging.GetCompositeScheduleRequest) (*smartcharging.GetCompositeScheduleConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refuseComposite {
		return &smartcharging.GetCompositeScheduleConfirmation{Status: smartcharging.GetCompositeScheduleStatusRejected}, nil
	}
	limit, ok := s.effectiveLimitW(r.ConnectorId)
	conf := &smartcharging.GetCompositeScheduleConfirmation{
		Status:      smartcharging.GetCompositeScheduleStatusAccepted,
		ConnectorId: &r.ConnectorId,
	}
	if ok {
		conf.ScheduleStart = types.NewDateTime(s.now())
		conf.ChargingSchedule = types.NewChargingSchedule(types.ChargingRateUnitWatts,
			types.NewChargingSchedulePeriod(0, limit))
	}
	return conf, nil
}

// --- core handler: only the two configuration messages matter here ---

func (s *station) OnGetConfiguration(r *core.GetConfigurationRequest) (*core.GetConfigurationConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(r.Key) == 0 {
		s.fullConfigurationReads++
		if s.rejectFullConfiguration {
			return nil, errors.New("empty GetConfiguration is not supported")
		}
	} else {
		s.targetedConfigurationReads++
	}
	var keys []core.ConfigurationKey
	var unknown []string
	requested := append([]string(nil), r.Key...)
	if len(requested) == 0 {
		for k := range s.config {
			requested = append(requested, k)
		}
		sort.Strings(requested)
	}
	for _, k := range requested {
		if v, ok := s.config[k]; ok {
			val := v
			keys = append(keys, core.ConfigurationKey{Key: k, Readonly: true, Value: &val})
		} else {
			unknown = append(unknown, k)
		}
	}
	return &core.GetConfigurationConfirmation{ConfigurationKey: keys, UnknownKey: unknown}, nil
}

// A non-conforming but common station class rejects GetConfiguration with an
// empty key list while answering targeted reads. The complete inventory is
// best-effort: it must never prevent the two permanent safety profiles.
func TestCommissioningSurvivesARefusedFullConfigurationInventory(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", time.Now)
	st.mu.Lock()
	st.rejectFullConfiguration = true
	st.mu.Unlock()

	if err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 0); err != nil {
		t.Fatalf("targeted fallback commissioning failed: %v", err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.targetedConfigurationReads != 1 || st.fullConfigurationReads != 1 {
		t.Fatalf("configuration reads targeted/full = %d/%d, want 1/1",
			st.targetedConfigurationReads, st.fullConfigurationReads)
	}
	if _, ok := st.profiles[[2]int{0, csms.ProfileIDMax}]; !ok {
		t.Fatal("maximum safety profile missing after refused full inventory")
	}
	if _, ok := st.profiles[[2]int{0, csms.ProfileIDTxDefault}]; !ok {
		t.Fatal("default safety profile missing after refused full inventory")
	}
}

func (s *station) OnChangeConfiguration(r *core.ChangeConfigurationRequest) (*core.ChangeConfigurationConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.config[r.Key] = r.Value
	s.changed = append(s.changed, r.Key+"="+r.Value)
	return core.NewChangeConfigurationConfirmation(core.ConfigurationStatusAccepted), nil
}

func (s *station) OnChangeAvailability(*core.ChangeAvailabilityRequest) (*core.ChangeAvailabilityConfirmation, error) {
	return core.NewChangeAvailabilityConfirmation(core.AvailabilityStatusAccepted), nil
}
func (s *station) OnClearCache(*core.ClearCacheRequest) (*core.ClearCacheConfirmation, error) {
	return core.NewClearCacheConfirmation(core.ClearCacheStatusAccepted), nil
}
func (s *station) OnDataTransfer(*core.DataTransferRequest) (*core.DataTransferConfirmation, error) {
	return core.NewDataTransferConfirmation(core.DataTransferStatusRejected), nil
}
func (s *station) OnRemoteStartTransaction(*core.RemoteStartTransactionRequest) (*core.RemoteStartTransactionConfirmation, error) {
	return core.NewRemoteStartTransactionConfirmation(types.RemoteStartStopStatusRejected), nil
}
func (s *station) OnRemoteStopTransaction(*core.RemoteStopTransactionRequest) (*core.RemoteStopTransactionConfirmation, error) {
	return core.NewRemoteStopTransactionConfirmation(types.RemoteStartStopStatusRejected), nil
}
func (s *station) OnReset(*core.ResetRequest) (*core.ResetConfirmation, error) {
	return core.NewResetConfirmation(core.ResetStatusRejected), nil
}
func (s *station) OnUnlockConnector(*core.UnlockConnectorRequest) (*core.UnlockConnectorConfirmation, error) {
	return core.NewUnlockConnectorConfirmation(core.UnlockStatusNotSupported), nil
}

// connectStation wires a full-featured simulated station to the CSMS.
//
// ⚠ It WAITS until the CSMS has recorded the connection. The library reports a
// successful dial as soon as the websocket is up, but the server's own
// new-client callback runs on another goroutine - so a command issued right
// after Start would race it and come back "die Ladesäule ist zurzeit nicht
// verbunden" (which is how this bit once).
func connectStation(t *testing.T, s *csms.Server, endpoint, id string, now func() time.Time) (ocpp16.ChargePoint, *station) {
	t.Helper()
	st := newStation(now)
	cp := ocpp16.NewChargePoint(id, nil, nil)
	cp.SetCoreHandler(st)
	cp.SetSmartChargingHandler(st)
	if err := cp.Start(endpoint); err != nil {
		t.Fatalf("station %s could not connect: %v", id, err)
	}
	t.Cleanup(sync.OnceFunc(cp.Stop))
	waitFor(t, "the CSMS recorded "+id+" as connected", func() bool {
		c, ok := s.Snapshot().ChargerByID(id)
		return ok && c.Connected
	})
	return cp, st
}

// kwStr renders a nullable kW value for a failure message: "nil" reads better
// than a pointer address, and the difference between "no limit reported" and
// "a limit of 0" is exactly what these tests are about.
func kwStr(p *float64) string {
	if p == nil {
		return "nil"
	}
	return fmt.Sprintf("%.3f kW", *p)
}

func ctx5(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return c
}

// TestCommissioningReadsBeforeItCommands is the anti-Deye discipline: ask what
// the station can do, THEN install the two permanent profiles - and the safe
// default is installed at EVERY connect, because a station that rebooted may
// have lost it.
func TestCommissioningReadsBeforeItCommands(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", time.Now)

	if err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 10*time.Second); err != nil {
		t.Fatalf("commission: %v", err)
	}
	c, _ := s.Snapshot().ChargerByID("SAEULE-1")
	if !c.Capabilities.Read || !c.Capabilities.WattsAllowed {
		t.Fatalf("capabilities not read: %+v", c.Capabilities)
	}
	if c.Capabilities.MaxStackLevel != 8 || c.Capabilities.MaxPeriods != 24 || c.Capabilities.MaxProfiles != 10 {
		t.Fatalf("capability values: %+v", c.Capabilities)
	}
	if c.MaxKw == nil || *c.MaxKw != 240 || c.DefaultKw == nil || *c.DefaultKw != 15 {
		t.Fatalf("permanent profiles not recorded: %+v / %+v", c.MaxKw, c.DefaultKw)
	}
	if c.CommissionError != "" || c.CommissionedAt.IsZero() {
		t.Fatalf("commission state: %q / %v", c.CommissionError, c.CommissionedAt)
	}

	st.mu.Lock()
	defer st.mu.Unlock()
	// The two permanent profiles really landed, in WATTS, on connector 0.
	maxP, okMax := st.profiles[[2]int{0, csms.ProfileIDMax}]
	defP, okDef := st.profiles[[2]int{0, csms.ProfileIDTxDefault}]
	if !okMax || !okDef {
		t.Fatalf("profiles at the station: %+v", st.profiles)
	}
	if maxP.limitW != 240000 || defP.limitW != 15000 {
		t.Fatalf("limits: max=%v default=%v (must be watts)", maxP.limitW, defP.limitW)
	}
	// ⚠ The permanent profiles carry NO duration - they must survive our death.
	if maxP.duration != 0 || defP.duration != 0 {
		t.Fatalf("a permanent profile must never expire: max=%v default=%v", maxP.duration, defP.duration)
	}
	if len(st.changed) != 1 || st.changed[0] != csms.KeyMeterValueSampleInterval+"=10" {
		t.Fatalf("meter cadence not requested: %v", st.changed)
	}
}

// TestTheLiveLimitExpiresOnItsOwn is the DEAD MAN'S SWITCH, proven end to end
// against a station that honours the schedule duration: the box commands
// 41 kW, then goes silent, and the station falls back to its stored 15 kW
// default WITHOUT anything of ours running.
func TestTheLiveLimitExpiresOnItsOwn(t *testing.T) {
	var mu sync.Mutex
	fake := time.Date(2026, 8, 20, 13, 24, 0, 0, time.UTC)
	now := func() time.Time { mu.Lock(); defer mu.Unlock(); return fake }

	s, endpoint := startServerWithClock(t, now, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", now)
	if err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 0); err != nil {
		t.Fatalf("commission: %v", err)
	}
	if err := s.ApplyLimit(ctx5(t), "SAEULE-1", 1, 4711, 41); err != nil {
		t.Fatalf("apply: %v", err)
	}

	// While the box is alive the connector holds the commanded limit.
	cs, verdict, err := s.ReadBack(ctx5(t), "SAEULE-1", 1)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	if verdict != csms.ReadbackOK {
		t.Fatalf("verdict = %q, want ok (limit %s)", verdict, kwStr(cs.LimitKw))
	}
	if cs.LimitKw == nil || *cs.LimitKw != 41 {
		t.Fatalf("station reports %s, want 41 kW", kwStr(cs.LimitKw))
	}

	// The box goes silent: no refresh. Time passes beyond the profile duration.
	mu.Lock()
	fake = fake.Add(csms.TxProfileDuration + time.Minute)
	mu.Unlock()

	cs, _, err = s.ReadBack(ctx5(t), "SAEULE-1", 1)
	if err != nil {
		t.Fatalf("readback after the silence: %v", err)
	}
	if cs.LimitKw == nil || *cs.LimitKw != 15 {
		t.Fatalf("the station did not fall back to its safe default: %s", kwStr(cs.LimitKw))
	}
	_ = st
}

// TestAPauseIsALimitOfZeroNotAMissingLimit: in OCPP a pause is expressed as a
// 0 W limit. Clearing the profile instead would REMOVE the constraint and let
// the vehicle draw the default - the opposite of what "pause" means.
func TestAPauseIsALimitOfZeroNotAMissingLimit(t *testing.T) {
	fake := time.Date(2026, 8, 20, 13, 24, 0, 0, time.UTC)
	clock := func() time.Time { return fake }
	s, endpoint := startServerWithClock(t, clock, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", clock)
	if err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 0); err != nil {
		t.Fatalf("commission: %v", err)
	}
	if err := s.ApplyLimit(ctx5(t), "SAEULE-1", 1, 4711, 0); err != nil {
		t.Fatalf("apply pause: %v", err)
	}
	cs, verdict, err := s.ReadBack(ctx5(t), "SAEULE-1", 1)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	if cs.LimitKw == nil || *cs.LimitKw != 0 {
		t.Fatalf("a paused connector must report 0 kW, got %s", kwStr(cs.LimitKw))
	}
	if verdict != csms.ReadbackOK {
		t.Fatalf("verdict = %q, want ok", verdict)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if p, ok := st.profiles[[2]int{1, csms.TxProfileID(1)}]; !ok || p.limitW != 0 {
		t.Fatalf("the pause was not stored as a 0 W TxProfile: %+v", st.profiles)
	}
}

// TestARefusedProfileIsNamedNeverAssumed - the PR-280 lesson on OCPP: an
// accepted command is not a command in force, and a refused one must not look
// like a silent success.
func TestARefusedProfileIsNamedNeverAssumed(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", time.Now)
	st.mu.Lock()
	st.refuseProfiles = true
	st.mu.Unlock()

	err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 0)
	if err == nil {
		t.Fatal("a station that refuses every profile was reported as commissioned")
	}
	c, _ := s.Snapshot().ChargerByID("SAEULE-1")
	if c.CommissionError == "" || !c.CommissionedAt.IsZero() {
		t.Fatalf("refusal not recorded: %+v", c)
	}
	if c.MaxKw != nil || c.DefaultKw != nil {
		t.Fatal("a refused profile must not be recorded as installed")
	}

	// The live limit refusal lands on the connector, verbatim.
	if err := s.ApplyLimit(ctx5(t), "SAEULE-1", 1, 1, 41); err == nil {
		t.Fatal("a refused limit returned success")
	}
	c, _ = s.Snapshot().ChargerByID("SAEULE-1")
	con := c.ConnectorByID(1)
	if con == nil || con.CommandStatus != "Rejected" {
		t.Fatalf("connector command status: %+v", con)
	}
}

// TestAStationThatCannotReportItsPlanIsUnknownNotOk: silence is not agreement.
func TestAStationThatCannotReportItsPlanIsUnknownNotOk(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", time.Now)
	if err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 0); err != nil {
		t.Fatalf("commission: %v", err)
	}
	if err := s.ApplyLimit(ctx5(t), "SAEULE-1", 1, 1, 41); err != nil {
		t.Fatalf("apply: %v", err)
	}
	st.mu.Lock()
	st.refuseComposite = true
	st.mu.Unlock()

	_, verdict, err := s.ReadBack(ctx5(t), "SAEULE-1", 1)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	if verdict != csms.ReadbackUnknown {
		t.Fatalf("verdict = %q, want %q", verdict, csms.ReadbackUnknown)
	}
	c, _ := s.Snapshot().ChargerByID("SAEULE-1")
	if con := c.ConnectorByID(1); con == nil || con.Readback != csms.ReadbackUnknown || con.ReadbackNote == "" {
		t.Fatalf("readback state: %+v", con)
	}
}

// TestAnAmpereOnlyStationIsRefusedByName: converting kW to amperes needs a
// voltage and a phase count OCPP never tells us. Guessing them is how a load
// manager overshoots a connection - so the station is NAMED as unsupported
// and gets no profile at all.
func TestAnAmpereOnlyStationIsRefusedByName(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	_, st := connectStation(t, s, endpoint, "SAEULE-1", time.Now)
	st.mu.Lock()
	st.config[csms.KeyAllowedChargingRateUnit] = "Current"
	st.mu.Unlock()

	err := s.Commission(ctx5(t), "SAEULE-1", 240, 15, 0)
	if err == nil {
		t.Fatal("an ampere-only station was commissioned")
	}
	c, _ := s.Snapshot().ChargerByID("SAEULE-1")
	if !c.Capabilities.AmpsAllowed || c.Capabilities.WattsAllowed {
		t.Fatalf("capabilities: %+v", c.Capabilities)
	}
	if c.CommissionError == "" {
		t.Fatal("refused without a reason")
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if len(st.profiles) != 0 {
		t.Fatalf("a limit was written to a station we cannot address: %+v", st.profiles)
	}
}

// TestCommandingADisconnectedStationSaysSoInsteadOfHanging: the three
// preconditions of any command each have their own named error.
func TestCommandingADisconnectedStationSaysSo(t *testing.T) {
	s, _ := startServer(t, "SAEULE-1")
	if err := s.ApplyLimit(ctx5(t), "SAEULE-1", 1, 1, 41); err != csms.ErrNotConnected {
		t.Fatalf("err = %v, want ErrNotConnected", err)
	}
	if err := s.ApplyLimit(ctx5(t), "FREMDE", 1, 1, 41); err != csms.ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	// ... and the refusal is recorded on the connector, not swallowed.
	c, _ := s.Snapshot().ChargerByID("SAEULE-1")
	if con := c.ConnectorByID(1); con == nil || con.CommandStatus == "" {
		t.Fatalf("the refusal left no trace: %+v", con)
	}

	off, err := csms.New(csms.Options{Enabled: false, DataDir: t.TempDir(), Log: quiet()})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	if err := off.ApplyLimit(ctx5(t), "X", 1, 1, 1); err != csms.ErrDisabled {
		t.Fatalf("err = %v, want ErrDisabled", err)
	}
}

// TestActiveConnectorsAreTheClaimants: which connectors claim budget is a
// question with exactly one answer, and it must not include a plug that has
// finished.
func TestActiveConnectorsAreTheClaimants(t *testing.T) {
	s, endpoint := startServer(t, "SAEULE-1")
	cp, _ := connectStation(t, s, endpoint, "SAEULE-1", time.Now)

	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusCharging); err != nil {
		t.Fatalf("status: %v", err)
	}
	if _, err := cp.StatusNotification(2, core.NoError, core.ChargePointStatusAvailable); err != nil {
		t.Fatalf("status: %v", err)
	}
	if _, err := cp.StartTransaction(1, "TAG", 0, types.NewDateTime(time.Now())); err != nil {
		t.Fatalf("start: %v", err)
	}
	waitFor(t, "session on connector 1", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})

	// A connector that goes Finishing stops claiming, even though its
	// transaction has not been closed yet.
	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusFinishing); err != nil {
		t.Fatalf("status: %v", err)
	}
	waitFor(t, "the finishing connector stops claiming", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 0
	})

	// A suspended vehicle KEEPS its claim: it may resume within a second, and
	// handing the power away and back is worse than holding it.
	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusSuspendedEV); err != nil {
		t.Fatalf("status: %v", err)
	}
	waitFor(t, "the suspended connector keeps its claim", func() bool {
		c, _ := s.Snapshot().ChargerByID("SAEULE-1")
		return len(c.ActiveConnectors()) == 1
	})
}

// TestConnectorCountNeverUnderCounts: the emergency default is the free power
// DIVIDED by the plug count, so an under-count makes every station's fallback
// too big. The operator's declaration and the station's own reports are
// combined with max(), never with "whichever we saw last".
func TestConnectorCountNeverUnderCounts(t *testing.T) {
	s, endpoint := startServer(t)
	if _, err := s.Add(csms.AddRequest{ID: "SAEULE-1", Connectors: 2}); err != nil {
		t.Fatalf("add: %v", err)
	}
	if got := s.Snapshot().ConnectorCount(); got != 2 {
		t.Fatalf("declared count = %d, want 2", got)
	}
	cp, _ := connectStation(t, s, endpoint, "SAEULE-1", time.Now)
	for i := 1; i <= 4; i++ {
		if _, err := cp.StatusNotification(i, core.NoError, core.ChargePointStatusAvailable); err != nil {
			t.Fatalf("status %d: %v", i, err)
		}
	}
	waitFor(t, "the station's own report wins when it is larger", func() bool {
		return s.Snapshot().ConnectorCount() == 4
	})
}

// TestUpdateKeepsWhatItIsNotToldAbout - PATCH semantics, and a refusal changes
// nothing.
func TestUpdateKeepsWhatItIsNotToldAbout(t *testing.T) {
	s, _ := startServer(t)
	if _, err := s.Add(csms.AddRequest{ID: "SAEULE-1", Label: "Hof Nord", RatedKw: 240, MinKw: 30, Connectors: 2}); err != nil {
		t.Fatalf("add: %v", err)
	}
	prio := true
	got, err := s.Update("SAEULE-1", csms.UpdateRequest{Priority: &prio})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if !got.Priority || got.Label != "Hof Nord" || got.RatedKw != 240 || got.MinKw != 30 || got.Connectors != 2 {
		t.Fatalf("update lost fields: %+v", got)
	}

	bad := 999.0
	if _, err := s.Update("SAEULE-1", csms.UpdateRequest{MinKw: &bad}); err == nil {
		t.Fatal("a minimum above the rating was accepted")
	}
	after := s.List()
	if len(after) != 1 || after[0].MinKw != 30 || !after[0].Priority {
		t.Fatalf("a refused update changed the stored charger: %+v", after)
	}
	if _, err := s.Update("FREMDE", csms.UpdateRequest{Priority: &prio}); err != csms.ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	_ = fmt.Sprint()
}
