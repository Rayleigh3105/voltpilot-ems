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
// whose phase limits make the box harden the station's authorization. setup
// shapes the station's configuration keys before the policy arrives.
func ampereStationWithPhaseLimits(t *testing.T, id string, setup func(st *station)) (*csms.Server, *station) {
	t.Helper()
	now := time.Now().UTC()
	s, endpoint := startServerWithClock(t, func() time.Time { return now }, id)
	cp, st := connectStation(t, s, endpoint, id, func() time.Time { return now })
	st.mu.Lock()
	st.config[csms.KeyAllowedChargingRateUnit] = "Current"
	setup(st)
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

// goeFirmware594 is the go-e Charger V4 as its OCPP documentation lists the
// keys (firmware 59.4): no authorization cache, no LocalPreAuthorize, no
// StopTransactionOnInvalidId, no MaxEnergyOnInvalidId, AuthorizeRemoteTxRequests
// read-only; the offline and local-list switches are writable.
func goeFirmware594(st *station) {
	st.notSupported = map[string]bool{"AuthorizationCacheEnabled": true, "LocalPreAuthorize": true,
		"StopTransactionOnInvalidId": true, "MaxEnergyOnInvalidId": true}
	st.readOnly = map[string]bool{"AuthorizeRemoteTxRequests": true}
	st.config["AuthorizeRemoteTxRequests"] = "true"
}

// TestAnAbsentOptionalAuthorizationKeyIsAlreadyTheSafeState: a station that
// lacks a feature answers NotSupported and lists the key as unknown - there is
// nothing to switch off, so commissioning goes on, and every key the station
// HAS is still set. Before, the go-e (firmware 59.4) could never be
// commissioned, and with phase limits no charge could even start.
func TestAnAbsentOptionalAuthorizationKeyIsAlreadyTheSafeState(t *testing.T) {
	s, st := ampereStationWithPhaseLimits(t, "GOE", goeFirmware594)
	if err := s.Commission(ctx5(t), "GOE", 11, 11, 10*time.Second); err != nil {
		t.Fatalf("the go-e's missing keys must not block commissioning: %v", err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	for key := range st.notSupported {
		if _, has := st.config[key]; has {
			t.Fatalf("nothing may be written for a key the station does not have: %s", key)
		}
	}
	for _, want := range []string{"AllowOfflineTxForUnknownId=false", "LocalAuthorizeOffline=false",
		"LocalAuthListEnabled=false"} {
		if !slices.Contains(st.changed, want) {
			t.Fatalf("existing key %s not set; changed: %v", want, st.changed)
		}
	}
}

// TestAReadOnlyKeyMustAlreadyHoldTheSafeValue - a refused write is fine when
// the station already is in the safe state, and blocks when it is not.
func TestAReadOnlyKeyMustAlreadyHoldTheSafeValue(t *testing.T) {
	s, _ := ampereStationWithPhaseLimits(t, "REMOTE", func(st *station) {
		goeFirmware594(st)
		st.config["AuthorizeRemoteTxRequests"] = "false"
	})
	err := s.Commission(ctx5(t), "REMOTE", 11, 11, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "AuthorizeRemoteTxRequests (Rejected, steht auf false)") {
		t.Fatalf("a read-only key in the unsafe state must block commissioning, got %v", err)
	}
}

// TestAuthorizeRemoteTxRequestsMustExist - the absent-feature rule covers the
// keys that switch something off; a station without AuthorizeRemoteTxRequests
// is still refused.
func TestAuthorizeRemoteTxRequestsMustExist(t *testing.T) {
	s, _ := ampereStationWithPhaseLimits(t, "STRICT", func(st *station) {
		st.notSupported = map[string]bool{"AuthorizeRemoteTxRequests": true}
	})
	err := s.Commission(ctx5(t), "STRICT", 11, 11, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "AuthorizeRemoteTxRequests (NotSupported)") {
		t.Fatalf("a missing AuthorizeRemoteTxRequests must block commissioning, got %v", err)
	}
}

// TestALocalListThatStaysOnBlocks - a missing LocalPreAuthorize is only safe
// while there is no local id store; a local list the station cannot switch
// off still blocks.
func TestALocalListThatStaysOnBlocks(t *testing.T) {
	s, _ := ampereStationWithPhaseLimits(t, "LIST", func(st *station) {
		goeFirmware594(st)
		st.readOnly["LocalAuthListEnabled"] = true
		st.config["LocalAuthListEnabled"] = "true"
	})
	err := s.Commission(ctx5(t), "LIST", 11, 11, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "LocalAuthListEnabled") {
		t.Fatalf("a local list that stays on must block commissioning, got %v", err)
	}
}

// TestAnOptionalKeyTheStationHasMustStillHoldTheSafeValue - NotSupported is
// only "feature absent" when the station also says it does not know the key.
// A station that reports the cache as present and ON keeps blocking.
func TestAnOptionalKeyTheStationHasMustStillHoldTheSafeValue(t *testing.T) {
	s, _ := ampereStationWithPhaseLimits(t, "CACHED", func(st *station) {
		st.notSupported = map[string]bool{"AuthorizationCacheEnabled": true}
		st.config["AuthorizationCacheEnabled"] = "true"
	})
	err := s.Commission(ctx5(t), "CACHED", 11, 11, 10*time.Second)
	if err == nil || !strings.Contains(err.Error(), "AuthorizationCacheEnabled") {
		t.Fatalf("an existing cache that cannot be switched off must block, got %v", err)
	}
}
