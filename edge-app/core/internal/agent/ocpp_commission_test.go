package agent

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppsim"
)

// commissionArgs are the numbers ocppStep commissions a station with.
func commissionArgs(a *Agent) (float64, lastmgmt.SafeDefault) {
	set := a.ocpp.currentSettings()
	snap := a.ocpp.srv.Snapshot()
	return set.GridLimitKw * (1 - set.MarginPct/100),
		lastmgmt.DeriveSafeDefault(set.GridLimitKw, effectiveMaxHouseLoad(set), snap.ConnectorCount())
}

// TestASlowStationIsStillSetUp is W-08 (audit probe "TestAuditSlow", 1.3 s
// per answer): one 10-s deadline around the whole set-up failed every station
// slower than about 1.25 s per answer - a set-up is a dozen requests - and the
// station never got a limit. Every request has its own deadline now.
func TestASlowStationIsStillSetUp(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 20)
	if _, err := a.ocpp.srv.Add(csmsAdd("LANGSAM", 1, 11)); err != nil {
		t.Fatal(err)
	}
	st := ocppsim.New(ocppsim.Config{ID: "LANGSAM", Connectors: 1, ReplyDelay: 1300 * time.Millisecond})
	t.Cleanup(st.Stop)
	for deadline := time.Now().Add(5 * time.Second); ; {
		err := st.Connect(ocppEndpoint(a))
		if err == nil {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("connect: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	deadline := time.Now().Add(2 * time.Minute)
	for {
		c, _ := a.ocpp.srv.Snapshot().ChargerByID("LANGSAM")
		if c.ProfilesInForce() {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("a station answering in 1.3 s was never set up: %q", c.CommissionError)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if kw := findProfileSoft(st, "ChargePointMaxProfile"); kw <= 0 {
		t.Fatalf("whole-station cap = %v kW after the set-up", kw)
	}
}

// TestAFailedSetUpWaitsBeforeItRetries is W-08: a failed set-up used to run
// again on every change signal - every meter value, every status - each time
// capping the car at 0 W first. It now backs off: one tick, then twice as
// long each time, at most five minutes; a new boot or new numbers retry at once.
func TestAFailedSetUpWaitsBeforeItRetries(t *testing.T) {
	for fails, want := range map[int]time.Duration{1: 20 * time.Second, 2: 40 * time.Second,
		3: 80 * time.Second, 4: 160 * time.Second, 5: 5 * time.Minute, 9: 5 * time.Minute} {
		if got := ocppCommissionBackoff(fails); got != want {
			t.Fatalf("backoff after %d failures = %v, want %v", fails, got, want)
		}
	}

	a := ocppAgent(t, nil)
	ocppSite(t, a, 20)
	if _, err := a.ocpp.srv.Add(csmsAdd("FERN", 1, 11)); err != nil {
		t.Fatal(err)
	}
	planable, safe := commissionArgs(a)
	// The registered station is not on the socket: every attempt fails at once.
	c := csms.ChargerState{Charger: csms.Charger{ID: "FERN", RatedKw: 11}, Connected: true}
	retry := func() ocppCommissionRetry {
		a.ocpp.mu.Lock()
		defer a.ocpp.mu.Unlock()
		return a.ocpp.commissionRetry["FERN"]
	}
	now := time.Date(2026, 10, 26, 18, 0, 0, 0, time.UTC)
	ctx := context.Background()
	a.ocppCommission(ctx, c, planable, safe, now)
	if r := retry(); r.fails != 1 || !r.next.Equal(now.Add(20*time.Second)) {
		t.Fatalf("after the first failure: %+v", r)
	}
	a.ocppCommission(ctx, c, planable, safe, now.Add(5*time.Second))
	if r := retry(); r.fails != 1 {
		t.Fatalf("a retry ran inside the backoff: %+v", r)
	}
	a.ocppCommission(ctx, c, planable, safe, now.Add(21*time.Second))
	if r := retry(); r.fails != 2 || !r.next.Equal(now.Add(61*time.Second)) {
		t.Fatalf("after the second failure: %+v", r)
	}
	// A reboot is a new set-up: it does not wait out the old one's backoff.
	c.BootedAt = now.Add(22 * time.Second)
	a.ocppCommission(ctx, c, planable, safe, now.Add(23*time.Second))
	if r := retry(); r.fails != 1 {
		t.Fatalf("a new boot waited for the old backoff: %+v", r)
	}
}

// TestAReconnectIsNoReasonToSetUpAgain is W-07 at the executor: the set-up
// fingerprint used to carry the connection time, so every reconnect of an
// idle station - once a minute - ran the whole set-up, 0-W guard included.
func TestAReconnectIsNoReasonToSetUpAgain(t *testing.T) {
	a := ocppAgent(t, nil)
	ocppSite(t, a, 20)
	ocppStation(t, a, "GARAGE", 1, 11)
	deadline := time.Now().Add(30 * time.Second)
	var c csms.ChargerState
	for {
		// The set-up must belong to the station's CURRENT boot: the first pass
		// may start before the simulator's BootNotification, and the loop then
		// rightly sets the booted station up once more.
		c, _ = a.ocpp.srv.Snapshot().ChargerByID("GARAGE")
		a.ocpp.mu.Lock()
		fp := a.ocpp.commissioned["GARAGE"]
		a.ocpp.mu.Unlock()
		if !c.BootedAt.IsZero() && strings.HasPrefix(fp, fmt.Sprintf("%d|", c.BootedAt.UnixNano())) && c.ProfilesInForce() {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("never set up: %q", c.CommissionError)
		}
		time.Sleep(20 * time.Millisecond)
	}
	planable, safe := commissionArgs(a)
	reconnected := c
	reconnected.ConnectedAt = c.ConnectedAt.Add(time.Minute)
	a.ocppCommission(context.Background(), reconnected, planable, safe, time.Now().UTC())
	after, _ := a.ocpp.srv.Snapshot().ChargerByID("GARAGE")
	if !after.CommissionedAt.Equal(c.CommissionedAt) {
		t.Fatalf("a reconnect without a reboot ran the set-up again (%v -> %v)", c.CommissionedAt, after.CommissionedAt)
	}
}

// TestASilentWallboxIsNamedAsTheGap is W-06 (audit probe L3): a station that
// meters no power left „Nur Sonne" blind after a minute, and the sentence the
// customer read blamed the connection point. It names the wallbox now.
func TestASilentWallboxIsNamedAsTheGap(t *testing.T) {
	a, _ := boostAgent(t) // „Nur Sonne", one car plugged, no meter value yet
	now := time.Now().UTC()
	a.ocppObserve(now, map[string]float64{"power_kw": -8}, nil)
	set := a.ocpp.currentSettings()
	later := now.Add(2 * time.Minute)
	v := a.ocppSurplusFor(later, set, lastmgmt.PolicySolarOnly)
	if !v.Blind || !strings.HasPrefix(v.Reason, "Die Wallbox meldet keine Leistung") {
		t.Fatalf("blind=%v reason=%q, want the wallbox named", v.Blind, v.Reason)
	}
	if v.Kw != 0 || !v.Active {
		t.Fatalf("„Nur Sonne“ without proof must still hold at 0 kW: %+v", v)
	}

	// Without a charging station in the gap a blind lane is the connection
	// point's own - the sentence must not blame a wallbox.
	b := ocppAgent(t, nil)
	ocppSite(t, b, 0)
	ocppPolicy(t, b, lastmgmt.PolicySolarOnly, lastmgmt.StorageBeforeCars)
	v = b.ocppSurplusFor(later, b.ocpp.currentSettings(), lastmgmt.PolicySolarOnly)
	if !v.Blind || strings.HasPrefix(v.Reason, "Die Wallbox") {
		t.Fatalf("blind=%v reason=%q, want the connection point's own sentence", v.Blind, v.Reason)
	}
}
