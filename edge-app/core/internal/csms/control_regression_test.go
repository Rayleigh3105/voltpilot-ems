package csms_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
)

// Real websocket regressions for the OCPP control hardening.
func TestRegressionCloudCannotRemoveOrReplaceSafetyProfiles(t *testing.T) {
	cases := []struct {
		name, action, payload string
		profileID             int
		watts                 float64
	}{
		{"delete_station_cap", "ClearChargingProfile", `{"id":1}`, 1, 0},
		{"replace_fallback", "SetChargingProfile", `{"connectorId":0,"csChargingProfiles":{"chargingProfileId":2,"stackLevel":0,"chargingProfilePurpose":"TxDefaultProfile","chargingProfileKind":"Absolute","chargingSchedule":{"chargingRateUnit":"W","chargingSchedulePeriod":[{"startPeriod":0,"limit":90000}]}}}`, 2, 90000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			now := time.Now().UTC()
			s, endpoint := startServerWithClock(t, func() time.Time { return now }, "AUDIT-CP")
			_, st := connectStation(t, s, endpoint, "AUDIT-CP", func() time.Time { return now })
			if err := s.Commission(ctx5(t), "AUDIT-CP", 100, 5, 10*time.Second); err != nil {
				t.Fatal(err)
			}
			cmd := map[string]any{"schema_version": "1.0", "type": "ocpp_command", "tenant_id": "tenant-a", "site_id": "site-a", "device_id": "device-a", "charge_point_id": "AUDIT-CP", "action_id": "33333333-3333-4333-8333-333333333333", "correlation_id": "ocpp-33333333-3333-4333-8333-333333333333", "requested_at": now.Format(time.RFC3339Nano), "deadline_at": now.Add(30 * time.Second).Format(time.RFC3339Nano), "request_hash": strings.Repeat("c", 64), "action": tc.action, "request": json.RawMessage(tc.payload)}
			raw, _ := json.Marshal(cmd)
			if err := s.ExecuteCloudCommand(context.Background(), raw, csms.CommandIdentity{TenantID: "tenant-a", SiteID: "site-a", DeviceID: "device-a"}); err != nil {
				return
			}
			waitFor(t, "cloud mutation reached simulated station", func() bool {
				st.mu.Lock()
				defer st.mu.Unlock()
				p, exists := st.profiles[[2]int{0, tc.profileID}]
				if tc.action == "ClearChargingProfile" {
					return !exists
				}
				return exists && p.limitW == tc.watts
			})
			c, _ := s.Snapshot().ChargerByID("AUDIT-CP")
			t.Errorf("safety profile %d mutated through cloud gateway; station is still commissioned=%v, recorded fallback=%s, recorded cap=%s", tc.profileID, !c.CommissionedAt.IsZero(), kwStr(c.DefaultKw), kwStr(c.MaxKw))
		})
	}
}

func TestRegressionHistoricalMeterValuesMustNotBecomeLive(t *testing.T) {
	now := time.Now().UTC()
	s, endpoint := startServerWithClock(t, func() time.Time { return now }, "AUDIT-METER")
	cp, _ := connectCP(t, endpoint, "AUDIT-METER")
	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusCharging); err != nil {
		t.Fatal(err)
	}
	if _, err := cp.StartTransaction(1, "AUDIT-TAG", 1000, types.NewDateTime(now)); err != nil {
		t.Fatal(err)
	}
	old := now.Add(-time.Hour)
	if _, err := cp.MeterValues(1, []types.MeterValue{{Timestamp: types.NewDateTime(old), SampledValue: []types.SampledValue{{Value: "90000", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}}}}); err != nil {
		t.Fatal(err)
	}
	kw, complete := s.Snapshot().ChargingTotal(now, 30*time.Second)
	if complete {
		t.Errorf("one-hour-old power entered LIVE charging total: %.1f kW, complete=%v", kw, complete)
	}
}

func TestRegressionEnergyOnlyMustNotRefreshOldPower(t *testing.T) {
	var clock atomic.Int64
	clock.Store(time.Now().UTC().UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	s, endpoint := startServerWithClock(t, now, "AUDIT-PARTIAL")
	cp, _ := connectCP(t, endpoint, "AUDIT-PARTIAL")
	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusCharging); err != nil {
		t.Fatal(err)
	}
	if _, err := cp.StartTransaction(1, "AUDIT-TAG", 1000, types.NewDateTime(now())); err != nil {
		t.Fatal(err)
	}
	if _, err := cp.MeterValues(1, []types.MeterValue{{Timestamp: types.NewDateTime(now()), SampledValue: []types.SampledValue{{Value: "90000", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}}}}); err != nil {
		t.Fatal(err)
	}
	clock.Add(int64(time.Minute))
	if _, complete := s.Snapshot().ChargingTotal(now(), 30*time.Second); complete {
		t.Fatal("precondition: original power must be stale")
	}
	if _, err := cp.MeterValues(1, []types.MeterValue{{Timestamp: types.NewDateTime(now()), SampledValue: []types.SampledValue{{Value: "2000", Measurand: types.MeasurandEnergyActiveImportRegister, Unit: types.UnitOfMeasureWh}}}}); err != nil {
		t.Fatal(err)
	}
	kw, complete := s.Snapshot().ChargingTotal(now(), 30*time.Second)
	if complete {
		t.Errorf("energy-only update revived stale power: %.1f kW, complete=%v", kw, complete)
	}
}

func TestRegressionCoreRestartMustRecoverRunningTransaction(t *testing.T) {
	dir := t.TempDir()
	boot := func() (*csms.Server, string) {
		s, err := csms.New(csms.Options{Enabled: true, DataDir: dir, Log: quiet()})
		if err != nil {
			t.Fatal(err)
		}
		if len(s.List()) == 0 {
			if _, err := s.Add(csms.AddRequest{ID: "AUDIT-RESTART"}); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		return s, fmt.Sprintf("ws://127.0.0.1:%d%s", s.Snapshot().Port, s.Snapshot().URLPath)
	}
	s1, endpoint1 := boot()
	cp1, stop1 := connectCP(t, endpoint1, "AUDIT-RESTART")
	if _, err := cp1.StatusNotification(1, core.NoError, core.ChargePointStatusCharging); err != nil {
		t.Fatal(err)
	}
	tx, err := cp1.StartTransaction(1, "AUDIT-TAG", 1000, types.NewDateTime(time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	before, _ := s1.Snapshot().ChargerByID("AUDIT-RESTART")
	if len(before.ActiveConnectors()) != 1 {
		t.Fatal("precondition: transaction is active before restart")
	}
	stop1()
	s1.Stop()
	s2, endpoint2 := boot()
	t.Cleanup(s2.Stop)
	cp2, _ := connectCP(t, endpoint2, "AUDIT-RESTART")
	if _, err := cp2.StatusNotification(1, core.NoError, core.ChargePointStatusCharging); err != nil {
		t.Fatal(err)
	}
	if _, err := cp2.MeterValues(1, []types.MeterValue{{Timestamp: types.NewDateTime(time.Now()), SampledValue: []types.SampledValue{{Value: "5000", Measurand: types.MeasurandPowerActiveImport, Unit: types.UnitOfMeasureW}}}}, func(r *core.MeterValuesRequest) { r.TransactionId = &tx.TransactionId }); err != nil {
		t.Fatal(err)
	}
	after, _ := s2.Snapshot().ChargerByID("AUDIT-RESTART")
	if len(after.ActiveConnectors()) != 1 {
		t.Errorf("after core restart: station reports Charging and transactionId=%d, but active allocation participants=%d, session=%v", tx.TransactionId, len(after.ActiveConnectors()), after.ConnectorByID(1).Session)
	}
}
