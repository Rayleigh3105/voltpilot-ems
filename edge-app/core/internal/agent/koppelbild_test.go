package agent

import (
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

// The heartbeat carries Layer 1's Koppelbild status as it came; an empty list
// (no controller with an Erzeuger plan) drops the block, a broken payload
// keeps the last good one.
func TestKoppelStatusFuerDenHerzschlag(t *testing.T) {
	a := &Agent{}
	if a.koppelSummary() != nil {
		t.Fatal("ohne Stand ein Block")
	}
	a.onKoppelStatus(TopicKoppelStatus, []byte(`[{"steuerung":"s1","lage":"bereit","plaetze":[]}]`))
	if string(a.koppelSummary()) != `[{"steuerung":"s1","lage":"bereit","plaetze":[]}]` {
		t.Fatalf("Block %s", a.koppelSummary())
	}
	a.onKoppelStatus(TopicKoppelStatus, []byte(`{kaputt`))
	if a.koppelSummary() == nil {
		t.Fatal("ein kaputter Stand löscht den letzten guten")
	}
	a.onKoppelStatus(TopicKoppelStatus, []byte(`[]`))
	if a.koppelSummary() != nil {
		t.Fatal("leere Liste behält den Block")
	}
}

// The timetable's PV limit reaches an Anlagensteuerung with a released
// limit_kw Stellplatz on its whole generation (koppelbild.md §15), clamped to
// the Stellplatz band; a limit_kw Stellplatz on another target gets nothing.
func TestFahrplanGrenzeGehtAnDenStellplatz(t *testing.T) {
	a := followAgent(t)
	now := time.Now().UTC().Truncate(time.Second)
	f := func(v float64) *float64 { return &v }
	stellplatz := func(id, ziel string) entities.Entity {
		return entities.Entity{ID: id, Type: entities.TypeAnlagensteuerung, Label: id,
			Capabilities: entities.Capabilities{Actuate: []entities.ActuateCap{
				{Command: entities.CmdLimitKw, Min: f(0), Max: f(150), Platz: 1, Ziel: ziel}}},
			Guards: entities.Guards{Failsafe: entities.Failsafe{Behavior: "release"}}}
	}
	a.applyEntityRegistry(entities.Registry{Revision: "r-koppel", PublishedAt: now, Entities: []entities.Entity{
		stellplatz("as-gesamt", "erzeugung_gesamt"), stellplatz("as-einspeisung", "einspeisung")}})
	a.mu.Lock()
	a.currentPlan = freshPlan(now, 0, f(159))
	a.mu.Unlock()
	a.runPlanExecutors(now)
	a.arb.Tick()
	d, ok := a.arb.DecisionFor("as-gesamt")
	if !ok || d.Granted.LimitKw == nil || *d.Granted.LimitKw != 150 {
		t.Fatalf("Erzeugung gesamt: %+v", d)
	}
	if d, ok := a.arb.DecisionFor("as-einspeisung"); ok && d.Granted.LimitKw != nil {
		t.Fatalf("Einspeisung bekam die Fahrplan-Grenze: %+v", d)
	}
}
