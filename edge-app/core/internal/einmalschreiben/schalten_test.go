package einmalschreiben

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

type schaltAntwort struct {
	Regs   []uint16 `json:"regs"`
	Coils  []int    `json:"coils"`
	OK     bool     `json:"ok"`
	Fehler *string  `json:"fehler"`
}

type schaltVektoren struct {
	SchaltPlan []struct {
		Op   map[string]any `json:"op"`
		Plan *struct {
			Host   string `json:"host"`
			Port   int    `json:"port"`
			UnitID int    `json:"unitId"`
			FC     int    `json:"fc"`
			Addr   int    `json:"addr"`
			Value  int    `json:"value"`
		} `json:"plan"`
	} `json:"schalt_plan"`
	SchaltLaeufe []struct {
		Name      string           `json:"name"`
		Op        map[string]any   `json:"op"`
		Antworten []schaltAntwort  `json:"antworten"`
		Aufrufe   []map[string]any `json:"aufrufe"`
		Ergebnis  SchaltErgebnis   `json:"ergebnis"`
	} `json:"schalt_laeufe"`
}

func loadSchaltVektoren(t *testing.T) schaltVektoren {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatal(err)
	}
	var v schaltVektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.SchaltPlan) < 10 || len(v.SchaltLaeufe) < 10 {
		t.Fatalf("Schalt-Vektoren fehlen: %d/%d", len(v.SchaltPlan), len(v.SchaltLaeufe))
	}
	return v
}

func TestSchaltPlanVectors(t *testing.T) {
	for _, c := range loadSchaltVektoren(t).SchaltPlan {
		p, ok := SchaltPlanAus(c.Op)
		switch {
		case c.Plan == nil && !ok:
		case c.Plan == nil || !ok:
			t.Errorf("%v: Go %v %+v, JS %+v", c.Op, ok, p, c.Plan)
		case p.Host != c.Plan.Host || p.Port != c.Plan.Port || p.UnitID != c.Plan.UnitID || p.FC != c.Plan.FC ||
			p.Addr != c.Plan.Addr || *p.Value != c.Plan.Value:
			t.Errorf("%v:\n Go %+v (Wert %d)\n JS %+v", c.Op, p, *p.Value, *c.Plan)
		}
	}
}

// schaltSkript plays a switch run's answers (coils as 0/1, like the palette's
// connection manager) and records the calls in the JS deps' shape.
type schaltSkript struct {
	antworten []schaltAntwort
	aufrufe   []map[string]any
}

func (s *schaltSkript) next() schaltAntwort {
	if len(s.antworten) == 0 {
		f := "Vektor: keine Antwort mehr"
		return schaltAntwort{Fehler: &f}
	}
	a := s.antworten[0]
	s.antworten = s.antworten[1:]
	return a
}

func (s *schaltSkript) LiesRegister(_ context.Context, p Plan) ([]uint16, string) {
	s.aufrufe = append(s.aufrufe, map[string]any{"lesen": map[string]any{"fc": 3, "host": p.Host, "port": p.Port,
		"unitId": p.UnitID, "addr": p.Addr, "count": 1}})
	a := s.next()
	if a.Fehler != nil {
		return nil, *a.Fehler
	}
	return a.Regs, ""
}

func (s *schaltSkript) LiesSpulen(_ context.Context, p Plan) ([]bool, string) {
	s.aufrufe = append(s.aufrufe, map[string]any{"spulen": map[string]any{"host": p.Host, "port": p.Port,
		"unitId": p.UnitID, "addr": p.Addr, "count": 1}})
	a := s.next()
	if a.Fehler != nil {
		return nil, *a.Fehler
	}
	bits := []bool{}
	for _, c := range a.Coils {
		bits = append(bits, c != 0)
	}
	return bits, ""
}

func (s *schaltSkript) Schreibe(_ context.Context, p Plan) string {
	s.aufrufe = append(s.aufrufe, map[string]any{"schreiben": map[string]any{"host": p.Host, "port": p.Port,
		"unitId": p.UnitID, "fc": p.FC, "addr": p.Addr, "value": *p.Value}})
	if a := s.next(); a.Fehler != nil {
		return *a.Fehler
	}
	return ""
}

func (s *schaltSkript) Warte(context.Context, time.Duration) {}

func TestSchaltLaufVectors(t *testing.T) {
	for _, c := range loadSchaltVektoren(t).SchaltLaeufe {
		s := &schaltSkript{antworten: c.Antworten, aufrufe: []map[string]any{}}
		if p, ok := SchaltPlanAus(c.Op); ok {
			s.aufrufe = append(s.aufrufe, map[string]any{"spur": p.Host + ":" + itoa(p.Port)})
		}
		got := Schalten(context.Background(), c.Op, s)
		if !reflect.DeepEqual(got, c.Ergebnis) {
			t.Errorf("%s:\n Go %+v\n JS %+v", c.Name, got, c.Ergebnis)
		}
		if g, j := normalize(t, s.aufrufe), normalize(t, c.Aufrufe); !reflect.DeepEqual(g, j) {
			t.Errorf("%s: Aufrufe\n Go %v\n JS %v", c.Name, g, j)
		}
	}
}
