package agent

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan2"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

type planResultVectors struct {
	Gruende    []string `json:"gruende"`
	Identitaet struct {
		DeviceID string `json:"device_id"`
	} `json:"identitaet"`
	Box []struct {
		Name     string          `json:"name"`
		Plan     json.RawMessage `json:"plan"`
		Roh      string          `json:"roh"`
		Erwartet struct {
			Angenommen  bool   `json:"angenommen"`
			Grund       string `json:"grund"`
			PlanID      string `json:"plan_id"`
			GeneratedAt string `json:"generated_at"`
		} `json:"erwartet"`
	} `json:"box"`
}

func loadPlanResultVectors(t *testing.T) planResultVectors {
	t.Helper()
	raw, err := os.ReadFile("../../../../docs/contracts/v2/plan-result-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v planResultVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// Every verdict - the acceptance and each rejection kind - yields exactly the
// receipt the shared vectors name (Go twin of PlanResultListenerTest).
func TestPlanQuittungBeiAnnahmeUndJederAblehnungsart(t *testing.T) {
	v := loadPlanResultVectors(t)
	want := []string{plan2.GrundUnlesbar, plan2.GrundSchemaVersionUnbekannt, plan2.GrundSlotMinutesUngueltig,
		plan2.GrundKeineEntitaeten, plan2.GrundFremdeBox}
	if !reflect.DeepEqual(v.Gruende, want) {
		t.Fatalf("closed vocabulary drifted: vectors %v, Go %v", v.Gruende, want)
	}
	seen := map[string]bool{}
	now := time.Date(2027, 6, 15, 8, 15, 3, 0, time.UTC)
	for _, c := range v.Box {
		payload := []byte(c.Roh)
		if c.Plan != nil {
			payload = c.Plan
		}
		p, r, err := beurteilePlan2(payload, v.Identitaet.DeviceID, now)
		if r.Angenommen != c.Erwartet.Angenommen || r.Grund != c.Erwartet.Grund ||
			r.PlanID != c.Erwartet.PlanID || r.GeneratedAt != c.Erwartet.GeneratedAt || !r.At.Equal(now) {
			t.Fatalf("%s: receipt %+v, want %+v", c.Name, r, c.Erwartet)
		}
		if (p != nil) != c.Erwartet.Angenommen || (err == nil) != c.Erwartet.Angenommen {
			t.Fatalf("%s: plan applied %v / err %v disagrees with the receipt", c.Name, p != nil, err)
		}
		seen[r.Grund] = true
	}
	for _, g := range want {
		if !seen[g] {
			t.Fatalf("no vector exercises rejection %q", g)
		}
	}
	if !seen[""] {
		t.Fatal("no vector exercises the acceptance")
	}
}

// A box without its own device id yet (before enrollment state settles) keeps
// today's tolerance: the identity check only rejects a NAMED other box.
func TestPlanQuittungOhneEigeneKennungBleibtWieHeute(t *testing.T) {
	v := loadPlanResultVectors(t)
	p, r, err := beurteilePlan2(v.Box[0].Plan, "", time.Now())
	if p == nil || err != nil || !r.Angenommen {
		t.Fatalf("accepted plan rejected without an own device id: %+v %v", r, err)
	}
}

// Heartbeat WITHOUT block while no plan 2.0 is held (every box without a v2
// plan - the heartbeat stays as before apart from supports[]); WITH block
// once a plan is held, carrying the feed-in guard stage and measurement age
// that exist today and nothing IP-17/IP-18 has not built yet.
func TestHerzschlagMitUndOhneBlock(t *testing.T) {
	a := &Agent{State: state.New("", "")}
	if b := a.gemeinsameSteuerung(); b != nil {
		t.Fatalf("block without a plan 2.0: %+v", b)
	}
	a.curPlan2 = &plan2.Plan{SlotMinutes: 15}
	if b := a.gemeinsameSteuerung(); b != nil {
		t.Fatalf("block for a plan without plan_id: %+v", b)
	}
	a.curPlan2 = &plan2.Plan{PlanID: "4711aaaa-0000-4000-8000-000000004711", SlotMinutes: 15}
	b := a.gemeinsameSteuerung()
	if b == nil || b.PlanID != "4711aaaa-0000-4000-8000-000000004711" || b.Waechter != nil || b.MesspunktAlterS != nil {
		t.Fatalf("block without feed-in guard: %+v", b)
	}
	age := 4
	a.State.Update(func(s *state.Snapshot) {
		s.ExportGuard = &state.ExportGuardInfo{LimitKw: 100, State: "regelt", MeasurementAgeSeconds: &age}
	})
	b = a.gemeinsameSteuerung()
	raw, _ := json.Marshal(b)
	if string(raw) != `{"plan_id":"4711aaaa-0000-4000-8000-000000004711","waechter":{"einspeisung":"regelt"},"messpunkt_alter_s":4}` {
		t.Fatalf("block on the wire: %s", raw)
	}
	a.curPlan2 = nil // retained clear: the mirror disappears with the plan
	if b := a.gemeinsameSteuerung(); b != nil {
		t.Fatalf("block after the plan was cleared: %+v", b)
	}
	if !slices.Contains(cloud.BuiltSupports(), "plan_quittung") {
		t.Fatal("receipt built but plan_quittung not advertised")
	}
}
