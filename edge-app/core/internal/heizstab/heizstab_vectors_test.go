package heizstab

// The controller against the shared scenario vectors
// (docs/contracts/v2/heizstab-regler-vectors.json): block validation and
// tick-by-tick scenarios (surplus with the rod's own draw, hold time, minimum
// run/pause, import, blind, battery order, highest stage, switch budget).

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"
)

const reglerVectorsPath = "../../../../docs/contracts/v2/heizstab-regler-vectors.json"

type vecState struct {
	Stufe       int       `json:"stufe"`
	Seit        *float64  `json:"seit"`
	ZuletztEin  *float64  `json:"zuletzt_ein"`
	ZuletztAus  *float64  `json:"zuletzt_aus"`
	Schaltungen []float64 `json:"schaltungen"`
}

type reglerDoc struct {
	Basis         time.Time         `json:"basis"`
	Stages        []Stage           `json:"stages_pro3"`
	BlockValid    []json.RawMessage `json:"block_valid"`
	BlockInvalid  []json.RawMessage `json:"block_invalid"`
	BlockInactive []json.RawMessage `json:"block_inactive"`
	Scenarios     []struct {
		Name   string          `json:"name"`
		Params json.RawMessage `json:"params"`
		State  *vecState       `json:"state"`
		Steps  []struct {
			T       float64  `json:"t"`
			Grid    *float64 `json:"grid"`
			GridAge float64  `json:"grid_age"`
			Batt    *float64 `json:"batt"`
			Rod     *float64 `json:"rod"`
			Expect  struct {
				Stufe   int      `json:"stufe"`
				Code    string   `json:"code"`
				Changed bool     `json:"changed"`
				NextUp  *float64 `json:"next_up"`
			} `json:"expect"`
		} `json:"steps"`
	} `json:"scenarios"`
}

func loadRegler(t *testing.T) reglerDoc {
	t.Helper()
	raw, err := os.ReadFile(reglerVectorsPath)
	if err != nil {
		t.Fatalf("vectors: %v", err)
	}
	var doc reglerDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("vectors parse: %v", err)
	}
	if len(doc.Scenarios) == 0 || len(doc.Stages) == 0 {
		t.Fatal("vectors: empty")
	}
	return doc
}

func TestReglerVectorsBlocks(t *testing.T) {
	doc := loadRegler(t)
	for _, b := range doc.BlockValid {
		if _, ok, err := ParseParams(b); err != nil || !ok {
			t.Errorf("valid block %s: ok=%v err=%v", b, ok, err)
		}
	}
	for _, b := range doc.BlockInvalid {
		if _, _, err := ParseParams(b); err == nil {
			t.Errorf("invalid block %s was accepted", b)
		}
	}
	for _, b := range doc.BlockInactive {
		if _, ok, err := ParseParams(b); err != nil || ok {
			t.Errorf("inactive block %s: ok=%v err=%v", b, ok, err)
		}
	}
}

func TestReglerVectorsScenarios(t *testing.T) {
	doc := loadRegler(t)
	at := func(s float64) time.Time { return doc.Basis.Add(time.Duration(s * float64(time.Second))) }
	opt := func(s *float64) time.Time {
		if s == nil {
			return time.Time{}
		}
		return at(*s)
	}
	for _, sc := range doc.Scenarios {
		p, ok, err := ParseParams(sc.Params)
		if err != nil || !ok {
			t.Fatalf("%s: params %v %v", sc.Name, ok, err)
		}
		var st State
		if sc.State != nil {
			st = State{Stage: sc.State.Stufe, Since: opt(sc.State.Seit), LastOn: opt(sc.State.ZuletztEin),
				LastOff: opt(sc.State.ZuletztAus)}
			for _, s := range sc.State.Schaltungen {
				st.Switches = append(st.Switches, at(s))
			}
		}
		for _, step := range sc.Steps {
			now := at(step.T)
			in := Inputs{Now: now, GridKw: step.Grid, GridAt: now.Add(-time.Duration(step.GridAge * float64(time.Second))),
				BatteryKw: step.Batt, BatteryAt: now, RodKw: step.Rod}
			d := Step(p, doc.Stages, &st, in)
			e := step.Expect
			if d.Stage != e.Stufe || d.Code != e.Code || d.Changed != e.Changed {
				t.Errorf("%s t=%v: stufe=%d code=%s changed=%v (%s), want %d/%s/%v",
					sc.Name, step.T, d.Stage, d.Code, d.Changed, d.Reason, e.Stufe, e.Code, e.Changed)
				continue
			}
			if e.NextUp != nil && !d.NextUpAt.Equal(at(*e.NextUp)) {
				t.Errorf("%s t=%v: next_up=%v, want %v", sc.Name, step.T, d.NextUpAt.Sub(doc.Basis), *e.NextUp)
			}
			if d.Stage > 0 && math.Abs(d.Kw-doc.Stages[d.Stage-1].Kw) > 1e-9 {
				t.Errorf("%s t=%v: kw=%v", sc.Name, step.T, d.Kw)
			}
		}
	}
}

// A restart forgets nothing: the persisted state still holds the pause.
func TestStateSurvivesARoundTrip(t *testing.T) {
	base := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	st := State{Stage: 0, Since: base, LastOff: base, Switches: []time.Time{base}}
	raw, _ := json.Marshal(st)
	var back State
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	p, _, _ := ParseParams(json.RawMessage(`{"modus":"ueberschuss"}`))
	grid, rod := -3.0, 0.0
	now := base.Add(100 * time.Second)
	back.UpSince = now.Add(-time.Minute)
	d := Step(p, []Stage{{1, 2}}, &back, Inputs{Now: now, GridKw: &grid, GridAt: now, RodKw: &rod})
	if d.Stage != 0 || d.Code != CodeMinPause || !d.NextUpAt.Equal(base.Add(300*time.Second)) {
		t.Fatalf("after a round trip the pause must still hold: %+v", d)
	}
}
