package agent

// The heating-rod controller over the REAL path: house measurement -> the
// controller's stage -> a rule-class wish -> arbiter -> the Shelly stage
// executor -> one output of the Pro 3 on. Plus: the memory survives a restart
// (a pause is not forgotten), and nothing is wished while consumer control is
// off.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/desired"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/heizstab"
)

func heizstabRodRegistry(id, ip string, port int, block string) entities.Registry {
	reg := stageRodRegistry(id, ip, port)
	reg.Entities[0].Heizstab = json.RawMessage(block)
	return reg
}

func onCount(on [3]bool) int {
	n := 0
	for _, o := range on {
		if o {
			n++
		}
	}
	return n
}

func TestHeizstabSurplusStartsOnePhaseOverTheRealPath(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-regler"
	reg := heizstabRodRegistry(id, host, port, `{"modus":"ueberschuss"}`)
	arb := minimalArbiter(reg)
	a := shellyAgent(t, reg, arb, srv.Client())
	fp, asserted := map[string]string{}, map[string]time.Time{}
	t0 := time.Now().UTC()

	// The executor reads the rod once (nothing wished yet: fail-safe off).
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0)
	if !a.heizstabOwns(id) {
		t.Fatal("the controller must own a rod with an active block")
	}

	// 2.5 kW export: enough for one phase (2.0 kW + 0.2 reserve) - after 60 s.
	a.heizstabObserve(t0, map[string]float64{"power_kw": -2.5}, nil)
	a.runHeizstab(t0)
	if d := a.heizstabSummary(id); d == nil || d.Stufe != 0 || d.Code != heizstab.CodeWaitUp {
		t.Fatalf("first tick = %+v", d)
	}
	t1 := t0.Add(61 * time.Second)
	a.heizstabObserve(t1, map[string]float64{"power_kw": -2.5}, nil)
	a.runHeizstab(t1)
	dec, ok := arb.DecisionFor(id)
	if !ok || dec.HolderKind != string(desired.SourceHeizstab) || dec.Granted.SetpointKw == nil ||
		*dec.Granted.SetpointKw != 2.0 {
		t.Fatalf("decision = %+v", dec)
	}
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t1)
	if on, _ := dev.snapshot(); onCount(on) != 1 {
		t.Fatalf("one phase must run, got %v", on)
	}
	hb := a.consumersSummary()[id]
	if hb.Heizstab == nil || hb.Heizstab.Stufe != 1 || hb.Heizstab.Ausgaenge != 1 || hb.Heizstab.Kw != 2.0 ||
		hb.Heizstab.VerfuegbarKw == nil || hb.Stage == nil || *hb.Stage.Confirmed != 1 {
		t.Fatalf("heartbeat = %+v / %+v", hb.Heizstab, hb.Stage)
	}

	// The running phase is added back: 0.4 kW export with 2.0 kW running is
	// NOT "no surplus" - the rod stays at one phase instead of fluttering.
	t2 := t1.Add(30 * time.Second)
	a.heizstabObserve(t2, map[string]float64{"power_kw": -0.4}, nil)
	a.runHeizstab(t2)
	if d := a.heizstabSummary(id); d.Stufe != 1 || d.Code != heizstab.CodeSurplus {
		t.Fatalf("the rod's own draw must count back: %+v", d)
	}
}

func TestHeizstabMemorySurvivesARestart(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-neustart"
	reg := heizstabRodRegistry(id, host, port, `{"modus":"ueberschuss","mindestlauf_s":60}`)
	arb := minimalArbiter(reg)
	a := shellyAgent(t, reg, arb, srv.Client())
	fp, asserted := map[string]string{}, map[string]time.Time{}
	t0 := time.Now().UTC()
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0)
	for _, s := range []int{0, 61} {
		at := t0.Add(time.Duration(s) * time.Second)
		a.heizstabObserve(at, map[string]float64{"power_kw": -2.5}, nil)
		a.runHeizstab(at)
	}
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0.Add(61*time.Second))
	// Import for 30 s after the minimum run: off.
	for _, s := range []int{130, 160} {
		at := t0.Add(time.Duration(s) * time.Second)
		a.heizstabObserve(at, map[string]float64{"power_kw": 1.0}, nil)
		a.runHeizstab(at)
	}
	if d := a.heizstabSummary(id); d.Stufe != 0 {
		t.Fatalf("expected off, got %+v", d)
	}
	a.runShellyControlPass(context.Background(), a.shellyDoer, fp, asserted, t0.Add(160*time.Second))
	if on, _ := dev.snapshot(); onCount(on) != 0 {
		t.Fatalf("the rod must be off, got %v", on)
	}

	// Restart: a fresh agent on the same data dir still knows the pause.
	b := shellyAgent(t, reg, minimalArbiter(reg), srv.Client())
	b.Cfg.DataDir = a.Cfg.DataDir
	b.shellyGroups = a.shellyGroups // the readback of the rod (0 kW), as the executor would refill it
	for _, s := range []int{170, 231} {
		at := t0.Add(time.Duration(s) * time.Second)
		b.heizstabObserve(at, map[string]float64{"power_kw": -3.0}, nil)
		b.runHeizstab(at)
	}
	if d := b.heizstabSummary(id); d.Stufe != 0 || d.Code != heizstab.CodeMinPause {
		t.Fatalf("after a restart the pause must still hold: %+v", d)
	}
}

func TestHeizstabWishesNothingWhileConsumerControlIsOff(t *testing.T) {
	dev := newPro3Stage()
	srv := httptest.NewServer(dev.handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	id := "rod-aus"
	reg := heizstabRodRegistry(id, host, port, `{"modus":"ueberschuss"}`)
	arb := minimalArbiter(reg)
	a := shellyAgent(t, reg, arb, srv.Client())
	a.Cfg.ConsumerControlEnabled = false
	t0 := time.Now().UTC()
	for _, s := range []int{0, 61, 122} {
		at := t0.Add(time.Duration(s) * time.Second)
		a.heizstabObserve(at, map[string]float64{"power_kw": -8}, nil)
		a.runHeizstab(at)
	}
	if dec, ok := arb.DecisionFor(id); ok && dec.HolderKind == string(desired.SourceHeizstab) {
		t.Fatalf("a wish went out with consumer control off: %+v", dec)
	}
	if a.heizstabOwns(id) || a.heizstabSummary(id) != nil {
		t.Fatal("no controller may run while consumer control is off")
	}
}

// A rod whose driver knows no stages (a single output without an output set)
// is never driven by the controller - and the plan keeps it.
func TestHeizstabNeedsADriverWithStages(t *testing.T) {
	reg := rodShellyRegistry("rod-einzeln", "192.168.178.43", 80, false, 0)
	reg.Entities[0].Heizstab = json.RawMessage(`{"modus":"ueberschuss"}`)
	a := shellyAgent(t, reg, minimalArbiter(reg), nil)
	if a.heizstabOwns("rod-einzeln") {
		t.Fatal("a single output has no stages for the controller")
	}
	a.heizstabObserve(time.Now(), map[string]float64{"power_kw": -8}, nil)
	a.runHeizstab(time.Now())
	if a.heizstabSummary("rod-einzeln") != nil {
		t.Fatal("no verdict for a rod the controller does not drive")
	}
}
