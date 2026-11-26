package agent

// Reproduction + regression for the ~10 s Heizstab/Shelly switch-confirmation
// delay the captain reported switching a phase in "Wie der Kunde es sieht"
// (vp-schalten-sofort): the device write+readback was already fast
// (consumerControlTick), but the confirmed state only left the box on the
// next regular status heartbeat - up to statusHeartbeatEvery - because
// nothing asked for an early one on a consumer change (only OCPP charge
// points and Direktvermarktung had that, ocpp_status_kick.go). This file
// proves consumer_status_kick.go closes that gap: the moment
// onEntityReadback sees a visible change, the heartbeat follows within
// statusKickMinGap, not on the next tick.

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// consumerHeartbeatRecorder is the consumers-block analogue of
// heartbeatRecorder (ocpp_status_kick_test.go), typed for ConsumersSummary.
type consumerHeartbeatRecorder struct {
	mu   sync.Mutex
	at   []time.Time
	sent []cloud.ConsumersSummary
	sum  func() cloud.ConsumersSummary
}

func (r *consumerHeartbeatRecorder) publish() bool {
	s := r.sum()
	r.mu.Lock()
	r.at = append(r.at, time.Now())
	r.sent = append(r.sent, s)
	r.mu.Unlock()
	return true
}

func (r *consumerHeartbeatRecorder) snapshot() ([]time.Time, []cloud.ConsumersSummary) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]time.Time(nil), r.at...), append([]cloud.ConsumersSummary(nil), r.sent...)
}

// confirmedStageAt returns the time of the first recorded heartbeat whose
// entry for id reports the given confirmed output count, zero if none yet.
func confirmedStageAt(at []time.Time, sent []cloud.ConsumersSummary, id string, confirmed int, from int) time.Time {
	for i := from; i < len(sent); i++ {
		e, ok := sent[i][id]
		if ok && e.Stage != nil && e.Stage.Confirmed != nil && *e.Stage.Confirmed == confirmed {
			return at[i]
		}
	}
	return time.Time{}
}

// The reproduction: a 3-output Heizstab (Pro 3 stub) switched fully on, then
// fully off, against the real production heartbeat cadence
// (statusHeartbeatEvery/statusKickMinGap). Both confirmations must reach the
// recorded heartbeat well within statusKickMinGap of the device readback
// landing - never on the next statusHeartbeatEvery tick (15 s).
func TestHeizstabSwitchConfirmationReachesTheHeartbeatWithinSecondsNotOnTheNextTick(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-sofort"
	reg := stageRodRegistry(id, host, port)
	arb := minimalArbiter(reg)

	bus, readbacks, done := stageBus(t, id)
	defer done()

	a := shellyAgent(t, reg, arb, srv.Client())
	a.Bus = bus
	if err := a.Bus.Subscribe(entities.TopicPrefix+"+/readback", readbackSubscriptionID, a.onEntityReadback); err != nil {
		t.Fatal(err)
	}

	rec := &consumerHeartbeatRecorder{sum: a.consumersSummary}
	ctx, cancel := context.WithCancel(context.Background())
	hbDone := make(chan struct{})
	go func() {
		defer close(hbDone)
		statusHeartbeatLoop(ctx, statusHeartbeatEvery, statusKickMinGap, a.statusKick(), a.priorityStatusKick(), rec.publish)
	}()
	t.Cleanup(func() { cancel(); <-hbDone })

	fp, asserted := map[string]string{}, map[string]time.Time{}

	// A box's own startup self-assert runs before any customer ever opens
	// the portal: no decision yet -> fail-safe writes everything off. This
	// seeds the fingerprint baseline exactly like a real box would, well
	// before the switch below - "a box that starts asks for nothing".
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, time.Now())
	waitFor(t, 3*time.Second, "the startup self-assert readback", func() bool { return len(readbacks()) > 0 })

	// Switch fully on.
	submitSetpointWish(arb, id, 6.0, "on1")
	onWriteAt := time.Now()
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, onWriteAt)
	waitFor(t, statusKickMinGap+2*time.Second, "the heartbeat confirms all 3 outputs on", func() bool {
		at, sent := rec.snapshot()
		return !confirmedStageAt(at, sent, id, 3, 0).IsZero()
	})
	at, sent := rec.snapshot()
	onAt := confirmedStageAt(at, sent, id, 3, 0)
	if d := onAt.Sub(onWriteAt); d >= statusHeartbeatEvery {
		t.Fatalf("switch-on confirmation waited for the regular tick: %v", d)
	}
	t.Logf("switch on -> confirmed heartbeat: %v", onAt.Sub(onWriteAt))

	// Let the collected early heartbeat go out and the gap elapse, so the
	// next kick is measured from a clean baseline.
	time.Sleep(statusKickMinGap + 200*time.Millisecond)
	beforeOff, _ := rec.snapshot()
	fromIdx := len(beforeOff)

	// Switch fully off.
	submitOnOffWish(arb, id, false, "off1")
	offWriteAt := time.Now()
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, offWriteAt)
	waitFor(t, statusKickMinGap+2*time.Second, "the heartbeat confirms all outputs off", func() bool {
		at, sent := rec.snapshot()
		return !confirmedStageAt(at, sent, id, 0, fromIdx).IsZero()
	})
	at2, sent2 := rec.snapshot()
	offAt := confirmedStageAt(at2, sent2, id, 0, fromIdx)
	if d := offAt.Sub(offWriteAt); d >= statusHeartbeatEvery {
		t.Fatalf("switch-off confirmation waited for the regular tick: %v", d)
	}
	t.Logf("switch off -> confirmed heartbeat: %v", offAt.Sub(offWriteAt))
}

func intPtr(v int) *int { return &v }

// The fingerprint is made of WORDS the customer can see on the card: a
// moving measurement or day counter asks for nothing, while state, the
// readback verdict, the stage and the heating-rod controller's own verdict
// each do.
func TestConsumersStatusFingerprintIgnoresMovingMeasurements(t *testing.T) {
	kw := func(v float64) *float64 { return &v }
	trueV := true
	base := cloud.ConsumersSummary{"rod": {
		State: "running_manual", Confirmed: &trueV, ActualKw: kw(1.2),
		RequirementProgress: &cloud.ConsumerRequirementProgress{RuntimeSecondsToday: 10, StartsToday: 1},
		Heizstab:            &cloud.ConsumerHeizstab{Stufe: 1, Ausgaenge: 1, Kw: 2, VerfuegbarKw: kw(3), HoeherAb: "2026-11-26T12:00:00Z", Seit: "2026-11-26T11:00:00Z"},
	}}
	moved := cloud.ConsumersSummary{"rod": {
		State: "running_manual", Confirmed: &trueV, ActualKw: kw(1.9),
		RequirementProgress: &cloud.ConsumerRequirementProgress{RuntimeSecondsToday: 70, StartsToday: 1},
		Heizstab:            &cloud.ConsumerHeizstab{Stufe: 1, Ausgaenge: 1, Kw: 2, VerfuegbarKw: kw(5.5), HoeherAb: "2026-11-26T12:05:00Z", Seit: "2026-11-26T11:00:00Z"},
	}}
	if consumersStatusFingerprint(base) != consumersStatusFingerprint(moved) {
		t.Fatal("a moving measurement, day counter or surplus/timer forecast must not ask for an early heartbeat")
	}
}

func TestConsumersStatusFingerprintNoticesAVisibleChange(t *testing.T) {
	trueV, falseV := true, false
	base := cloud.ConsumersSummary{"rod": {State: "waiting", Confirmed: &falseV}}
	baseFP := consumersStatusFingerprint(base)
	cases := map[string]cloud.ConsumersSummary{
		"state changes":     {"rod": {State: "running_manual", Confirmed: &falseV}},
		"confirmed flips":   {"rod": {State: "waiting", Confirmed: &trueV}},
		"confirmed appears": {"rod": {State: "waiting"}},
		"reason appears":    {"rod": {State: "waiting", ReasonCode: "guard_min_off", Confirmed: &falseV}},
		"stage appears":     {"rod": {State: "waiting", Confirmed: &falseV, Stage: &cloud.ConsumerStage{Commanded: 1, Confirmed: intPtr(1)}}},
		"heizstab appears":  {"rod": {State: "waiting", Confirmed: &falseV, Heizstab: &cloud.ConsumerHeizstab{Stufe: 1, Code: "surplus"}}},
		"a second entity":   {"rod": {State: "waiting", Confirmed: &falseV}, "rod-2": {State: "waiting"}},
	}
	for name, other := range cases {
		if consumersStatusFingerprint(other) == baseFP {
			t.Fatalf("%s must ask for an early heartbeat", name)
		}
	}
}

// outputs_on and mismatch_since are part of the visible stage: a deviation
// starting or a different set of outputs reported on must be noticed even
// when the commanded/confirmed counts stay the same.
func TestConsumersStatusFingerprintNoticesStageDetail(t *testing.T) {
	base := consumersStatusFingerprint(cloud.ConsumersSummary{"rod": {Stage: &cloud.ConsumerStage{
		Commanded: 2, Confirmed: intPtr(2), OutputsOn: []int{0, 1},
	}}})
	cases := map[string]cloud.ConsumersSummary{
		"different outputs on": {"rod": {Stage: &cloud.ConsumerStage{
			Commanded: 2, Confirmed: intPtr(2), OutputsOn: []int{0, 2},
		}}},
		"a mismatch begins": {"rod": {Stage: &cloud.ConsumerStage{
			Commanded: 2, Confirmed: intPtr(2), OutputsOn: []int{0, 1}, MismatchSince: "2026-11-26T11:00:00Z",
		}}},
	}
	for name, other := range cases {
		if consumersStatusFingerprint(other) == base {
			t.Fatalf("%s must ask for an early heartbeat", name)
		}
	}
}
