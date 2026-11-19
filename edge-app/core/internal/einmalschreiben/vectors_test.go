package einmalschreiben

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// register-write-vectors.gen.js writes them from register-write.js and
// switch-write.js, register-write-vectors.test.js keeps them current.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "register-write-vectors.json")
}

type antwort struct {
	Regs   []uint16 `json:"regs"`
	Coils  []bool   `json:"coils"`
	OK     bool     `json:"ok"`
	Fehler *string  `json:"fehler"`
}

type vectors struct {
	SettleMs int `json:"settle_ms"`
	Plan     []struct {
		Req  map[string]any `json:"req"`
		Plan *Plan          `json:"plan"`
	} `json:"plan"`
	Classify []struct {
		Meldung  string `json:"meldung"`
		Ergebnis struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"ergebnis"`
	} `json:"classify"`
	Laeufe []struct {
		Name      string           `json:"name"`
		Req       map[string]any   `json:"req"`
		Antworten []antwort        `json:"antworten"`
		Aufrufe   []map[string]any `json:"aufrufe"`
		Ergebnis  Ergebnis         `json:"ergebnis"`
	} `json:"laeufe"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("Vektoren nicht lesbar: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren unlesbar: %v", err)
	}
	if len(v.Plan) == 0 || len(v.Laeufe) == 0 {
		t.Fatal("Vektoren leer")
	}
	return v
}

func TestSettleMatchesTheVectors(t *testing.T) {
	if got := Settle.Milliseconds(); got != int64(loadVectors(t).SettleMs) {
		t.Fatalf("Settle %d ms, JS %d ms", got, loadVectors(t).SettleMs)
	}
}

func TestPlanVectors(t *testing.T) {
	for _, c := range loadVectors(t).Plan {
		got, ok := PlanAus(c.Req)
		switch {
		case c.Plan == nil && ok:
			t.Errorf("%v: Go %+v, JS verworfen", c.Req, got)
		case c.Plan != nil && !ok:
			t.Errorf("%v: Go verworfen, JS %+v", c.Req, *c.Plan)
		case c.Plan != nil && !reflect.DeepEqual(got, *c.Plan):
			t.Errorf("%v:\n Go %+v\n JS %+v", c.Req, got, *c.Plan)
		}
	}
}

func TestKlassifiziereVectors(t *testing.T) {
	for _, c := range loadVectors(t).Classify {
		code, satz := Klassifiziere(c.Meldung)
		if code != c.Ergebnis.Code || satz != c.Ergebnis.Message {
			t.Errorf("%q: Go %s %q, JS %s %q", c.Meldung, code, satz, c.Ergebnis.Code, c.Ergebnis.Message)
		}
	}
}

// skript plays the vectors' answers and records the calls in the shape of the
// JS deps (lesen/spulen/schreiben/warten).
type skript struct {
	antworten []antwort
	aufrufe   []map[string]any
}

func (s *skript) next() antwort {
	if len(s.antworten) == 0 {
		f := "Vektor: keine Antwort mehr"
		return antwort{Fehler: &f}
	}
	a := s.antworten[0]
	s.antworten = s.antworten[1:]
	return a
}

func (s *skript) LiesRegister(_ context.Context, p Plan) ([]uint16, string) {
	s.aufrufe = append(s.aufrufe, map[string]any{"lesen": map[string]any{"fc": 3, "host": p.Host, "port": p.Port,
		"unitId": p.UnitID, "addr": p.Addr, "count": 1}})
	a := s.next()
	if a.Fehler != nil {
		return nil, *a.Fehler
	}
	return a.Regs, ""
}

func (s *skript) LiesSpulen(_ context.Context, p Plan) ([]bool, string) {
	s.aufrufe = append(s.aufrufe, map[string]any{"spulen": map[string]any{"host": p.Host, "port": p.Port,
		"unitId": p.UnitID, "addr": p.Addr, "count": 1}})
	a := s.next()
	if a.Fehler != nil {
		return nil, *a.Fehler
	}
	return a.Coils, ""
}

func (s *skript) Schreibe(_ context.Context, p Plan) string {
	s.aufrufe = append(s.aufrufe, map[string]any{"schreiben": map[string]any{"host": p.Host, "port": p.Port,
		"unitId": p.UnitID, "fc": p.FC, "addr": p.Addr, "value": *p.Value}})
	if a := s.next(); a.Fehler != nil {
		return *a.Fehler
	}
	return ""
}

func (s *skript) Warte(_ context.Context, d time.Duration) {
	s.aufrufe = append(s.aufrufe, map[string]any{"warten": d.Milliseconds()})
}

// normalize turns a value into its JSON form so Go and JS calls compare alike.
func normalize(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}

func TestLaufVectors(t *testing.T) {
	for _, c := range loadVectors(t).Laeufe {
		s := &skript{antworten: c.Antworten, aufrufe: []map[string]any{}}
		var got Ergebnis
		if p, ok := PlanAus(c.Req); ok {
			// The lane the JS arbiter is asked for: host:port of the plan.
			s.aufrufe = append(s.aufrufe, map[string]any{"spur": p.Host + ":" + itoa(p.Port)})
			got = Ausfuehren(context.Background(), p, s)
		} else {
			got = Ungueltig()
		}
		if !reflect.DeepEqual(got, c.Ergebnis) {
			t.Errorf("%s:\n Go %+v\n JS %+v", c.Name, got, c.Ergebnis)
		}
		if g, j := normalize(t, s.aufrufe), normalize(t, c.Aufrufe); !reflect.DeepEqual(g, j) {
			t.Errorf("%s: Aufrufe\n Go %v\n JS %v", c.Name, g, j)
		}
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }
