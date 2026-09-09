package csms_test

import (
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
	"math"
	"testing"
	"time"
)

func TestAmpereOnlyStationUsesDeclaredWiringAndConfirmsSchedule(t *testing.T) {
	for _, phases := range [][]int{{2}, {1, 2, 3}} {
		t.Run(ocppcontrol.Key("phases", len(phases)), func(t *testing.T) {
			now := time.Now().UTC()
			s, endpoint := startServerWithClock(t, func() time.Time { return now }, "AC")
			cp, st := connectStation(t, s, endpoint, "AC", func() time.Time { return now })
			st.mu.Lock()
			st.config[csms.KeyAllowedChargingRateUnit] = "Current"
			st.mu.Unlock()
			if err := s.Commission(ctx5(t), "AC", 22, 2, 10*time.Second); err == nil {
				t.Fatal("A-only station without wiring commissioned")
			}
			if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusAvailable); err != nil {
				t.Fatal(err)
			}
			p := ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "free"}, PhaseLimitsA: []float64{16, 16, 16}, Electrical: []ocppcontrol.Electrical{{ChargePointID: "AC", ConnectorID: 1, VoltageV: 253, Phases: phases, MaxCurrentA: 32}}}
			if err := s.SetControlPolicy(p); err != nil {
				t.Fatal(err)
			}
			if err := s.Commission(ctx5(t), "AC", 22, 2, 10*time.Second); err != nil {
				t.Fatal(err)
			}
			tx, err := cp.StartTransaction(1, "CARD", 0, types.NewDateTime(now))
			if err != nil {
				t.Fatal(err)
			}
			if err := s.ApplyLimit(ctx5(t), "AC", 1, tx.TransactionId, 5); err != nil {
				t.Fatal(err)
			}
			cs, verdict, err := s.ReadBack(ctx5(t), "AC", 1)
			if err != nil || verdict != csms.ReadbackOK {
				t.Fatalf("readback: %+v %s %v", cs, verdict, err)
			}
			st.mu.Lock()
			profile := st.profiles[[2]int{1, 11}]
			st.mu.Unlock()
			if profile.rateUnit != types.ChargingRateUnitAmperes || profile.phases != len(phases) || profile.limitW > 16 || profile.limitW*253*float64(len(phases)) > 5000.001 {
				t.Fatalf("unsafe A wire profile: %+v", profile)
			}
			if cs.LimitKw == nil || math.Abs(*cs.LimitKw-profile.limitW*253*float64(len(phases))/1000) > .001 {
				t.Fatal("A readback conversion not based on declared wiring")
			}
		})
	}
}

func TestLocalCardGrantAndRevokeAreSharedByAuthorizeAndStart(t *testing.T) {
	now := time.Now().UTC()
	s, endpoint := startServerWithClock(t, func() time.Time { return now }, "CARDS")
	cp, st := connectStation(t, s, endpoint, "CARDS", func() time.Time { return now })
	if _, err := cp.Authorize("PRIVATE-CARD"); err != nil {
		t.Fatal(err)
	}
	seen := s.ControlStatus(false, now).SeenTags
	if len(seen) != 1 {
		t.Fatal("card pseudonym not recorded")
	}
	p := ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "allowlist", AllowedTags: seen}}
	if err := s.SetControlPolicy(p); err != nil {
		t.Fatal(err)
	}
	denied, _ := cp.Authorize("PRIVATE-CARD")
	if denied.IdTagInfo.Status != types.AuthorizationStatusInvalid {
		t.Fatal("authorization cache setup bypassed")
	}
	if err := s.Commission(ctx5(t), "CARDS", 22, 2, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	accepted, err := cp.Authorize("PRIVATE-CARD")
	if err != nil || accepted.IdTagInfo.Status != types.AuthorizationStatusAccepted {
		t.Fatal("local grant not usable")
	}
	unknown, _ := cp.StartTransaction(1, "UNKNOWN", 0, types.NewDateTime(now))
	if unknown.IdTagInfo.Status != types.AuthorizationStatusInvalid {
		t.Fatal("Start bypassed allowlist")
	}
	st.mu.Lock()
	cache := st.config["AuthorizationCacheEnabled"]
	st.mu.Unlock()
	if cache != "false" {
		t.Fatal("station cache not disabled")
	}
	started, err := cp.StartTransaction(1, "PRIVATE-CARD", 0, types.NewDateTime(now))
	if err != nil || started.IdTagInfo.Status != types.AuthorizationStatusAccepted {
		t.Fatal("granted card did not start")
	}
	p.Revision++
	p.Authorization.AllowedTags = nil
	if err := s.SetControlPolicy(p); err != nil {
		t.Fatal(err)
	}
	revoked, _ := cp.StartTransaction(2, "PRIVATE-CARD", 0, types.NewDateTime(now))
	if revoked.IdTagInfo.Status != types.AuthorizationStatusInvalid {
		t.Fatal("revoked card starts offline")
	}
	duplicate, err := cp.StartTransaction(1, "PRIVATE-CARD", 0, types.NewDateTime(now))
	if err != nil || duplicate.TransactionId != started.TransactionId || duplicate.IdTagInfo.Status != types.AuthorizationStatusAccepted {
		t.Fatal("revocation changed the existing transaction on replay")
	}
}
