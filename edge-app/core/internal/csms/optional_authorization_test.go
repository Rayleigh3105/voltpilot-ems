package csms_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
)

// ampereStationWithPhaseLimits is the go-e on the Edge-Light pilot: amperes
// only, one plug on three phases, 16 A, phase budgets 16/16/16 - the setup
// whose phase limits make the box harden the station's authorization.
func ampereStationWithPhaseLimits(t *testing.T, id string, notSupported map[string]bool, config map[string]string) (*csms.Server, *station) {
	t.Helper()
	now := time.Now().UTC()
	s, endpoint := startServerWithClock(t, func() time.Time { return now }, id)
	cp, st := connectStation(t, s, endpoint, id, func() time.Time { return now })
	st.mu.Lock()
	st.config[csms.KeyAllowedChargingRateUnit] = "Current"
	st.notSupported = notSupported
	for k, v := range config {
		st.config[k] = v
	}
	st.mu.Unlock()
	if _, err := cp.StatusNotification(1, core.NoError, core.ChargePointStatusAvailable); err != nil {
		t.Fatal(err)
	}
	p := ocppcontrol.Policy{Revision: 1, Authorization: ocppcontrol.Authorization{Mode: "free"},
		PhaseLimitsA: []float64{16, 16, 16},
		Electrical: []ocppcontrol.Electrical{{ChargePointID: id, ConnectorID: 1, VoltageV: 230,
			Phases: []int{1, 2, 3}, MaxCurrentA: 16}}}
	if err := s.SetControlPolicy(p); err != nil {
		t.Fatal(err)
	}
	return s, st
}

// TestAnAbsentOptionalAuthorizationKeyIsAlreadyTheSafeState: a station that
// has no authorization cache answers NotSupported and lists the key as unknown
// - there is no cache to switch off, so commissioning goes on, and every
// REQUIRED key is still set. Before, the go-e (firmware 59.4) could never be
// commissioned, and with phase limits no charge could even start.
func TestAnAbsentOptionalAuthorizationKeyIsAlreadyTheSafeState(t *testing.T) {
	s, st := ampereStationWithPhaseLimits(t, "GOE",
		map[string]bool{"AuthorizationCacheEnabled": true}, nil)
	if err := s.Commission(ctx5(t), "GOE", 11, 11, 10*time.Second); err != nil {
		t.Fatalf("a missing optional key must not block commissioning: %v", err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, has := st.config["AuthorizationCacheEnabled"]; has {
		t.Fatal("nothing may be written for a key the station does not have")
	}
	for _, want := range []string{"LocalAuthorizeOffline=false", "LocalPreAuthorize=false",
		"StopTransactionOnInvalidId=true", "AuthorizeRemoteTxRequests=true"} {
		if !slices.Contains(st.changed, want) {
			t.Fatalf("required key %s not set; changed: %v", want, st.changed)
		}
	}
}

// TestARequiredAuthorizationKeyMustStillBeAccepted - the exception is for the
// optional keys only: a station that refuses LocalAuthorizeOffline could start
// a charge without the box and is still refused.
func TestARequiredAuthorizationKeyMustStillBeAccepted(t *testing.T) {
	s, _ := ampereStationWithPhaseLimits(t, "STRICT",
		map[string]bool{"LocalAuthorizeOffline": true}, nil)
	err := s.Commission(ctx5(t), "STRICT", 11, 11, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "LocalAuthorizeOffline") {
		t.Fatalf("a refused required key must block commissioning, got %v", err)
	}
}

// TestAnOptionalKeyTheStationHasMustStillHoldTheSafeValue - NotSupported is
// only "feature absent" when the station also says it does not know the key.
// A station that reports the cache as present and ON keeps blocking.
func TestAnOptionalKeyTheStationHasMustStillHoldTheSafeValue(t *testing.T) {
	s, _ := ampereStationWithPhaseLimits(t, "CACHED",
		map[string]bool{"AuthorizationCacheEnabled": true},
		map[string]string{"AuthorizationCacheEnabled": "true"})
	err := s.Commission(ctx5(t), "CACHED", 11, 11, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "AuthorizationCacheEnabled") {
		t.Fatalf("an existing cache that cannot be switched off must block, got %v", err)
	}
}
