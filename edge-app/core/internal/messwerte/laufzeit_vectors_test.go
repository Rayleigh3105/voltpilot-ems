package messwerte

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func laufzeitVektorenPfad() string {
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "measurements", "measurement-runtime-vectors.json")
}

// skriptIO answers from the vector tables and records in the JS run's shape.
type skriptIO struct {
	t       *testing.T
	modbus  map[string]json.RawMessage
	json    map[string]json.RawMessage
	pub     []any
	anfr    []any
	belege  []any
	ocppAuf []any
}

type vektorFehler struct {
	Fehler string `json:"fehler"`
	Code   string `json:"code"`
}

func (s *skriptIO) antwort(tab map[string]json.RawMessage, key string) (json.RawMessage, error) {
	raw, ok := tab[key]
	if !ok {
		return nil, &Lesefehler{Klasse: "no_answer", Text: "Vektor: keine Antwort fuer " + key}
	}
	var f vektorFehler
	if json.Unmarshal(raw, &f) == nil && f.Fehler != "" {
		return nil, &Lesefehler{Klasse: f.Code, Text: f.Fehler}
	}
	return raw, nil
}

func (s *skriptIO) LiesRegister(_ context.Context, a Leseauftrag) ([]uint16, error) {
	key := a.Target.Key + ":" + jsNumberString(float64(a.Start)) + ":" + jsNumberString(float64(a.Count))
	var kind any
	if a.SourceKind != "" {
		kind = a.SourceKind
	}
	s.anfr = append(s.anfr, map[string]any{"modbus": key, "source_kind": kind})
	raw, err := s.antwort(s.modbus, key)
	if err != nil {
		return nil, err
	}
	var w []uint16
	if err := json.Unmarshal(raw, &w); err != nil {
		s.t.Fatalf("Woerter %s: %v", raw, err)
	}
	return w, nil
}

func (s *skriptIO) LiesJSON(_ context.Context, a JSONAuftrag) ([]any, error) {
	keys := []string{}
	for _, p := range a.Points {
		keys = append(keys, p.PointKey)
	}
	s.anfr = append(s.anfr, map[string]any{"json": a.Group, "filter": a.Filter, "points": keys})
	raw, err := s.antwort(s.json, a.Group)
	if err != nil {
		return nil, err
	}
	v, err := ParseGeraeteJSON(raw)
	if err != nil {
		s.t.Fatal(err)
	}
	if o, ok := v.(*Objekt); ok {
		if arr, ok := o.vals["__vpResponses"].([]any); ok {
			return arr, nil
		}
	}
	return []any{v}, nil
}

func (s *skriptIO) Beleg(b Beleg) {
	m := map[string]any{}
	if b.Target != nil {
		m["target"] = *b.Target
	} else {
		m["target"] = nil
	}
	if b.EntityID != "" {
		m["entity_id"] = b.EntityID
	}
	if b.Requests != nil {
		m["requests"] = *b.Requests
	}
	if b.Samples != nil {
		m["samples"] = *b.Samples
	}
	if b.Failed {
		m["failed"], m["error_class"] = true, b.ErrorClass
	}
	if b.PointKey != "" {
		m["point_key"] = b.PointKey
	}
	s.belege = append(s.belege, m)
}

func (s *skriptIO) Status(st Status) {
	s.pub = append(s.pub, map[string]any{"topic": TopicStatus, "retained": true, "payload": map[string]any{
		"revision": st.Revision, "applied_at": isoMillis(st.AppliedAt), "accepted": st.Accepted, "rejected": st.Rejected}})
}

func (s *skriptIO) Proben(b Probenstapel) {
	s.pub = append(s.pub, map[string]any{"topic": TopicSamples, "retained": false, "payload": b})
}

func (s *skriptIO) OcppKonfigurieren(revision *float64, values map[string]string) {
	s.ocppAuf = append(s.ocppAuf, map[string]any{"revision": revision, "configuration": values})
}

func TestLaufzeitVectors(t *testing.T) {
	raw, err := os.ReadFile(laufzeitVektorenPfad())
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		T0     string `json:"t0"`
		Faelle []struct {
			Name      string         `json:"name"`
			IO        vektorOptionen `json:"io"`
			Protokoll []struct {
				Schritt struct {
					Zeit    *int64                     `json:"zeit"`
					Apply   *Konfig                    `json:"apply"`
					Options vektorOptionen             `json:"options"`
					Tick    bool                       `json:"tick"`
					Modbus  map[string]json.RawMessage `json:"modbus"`
					JSON    map[string]json.RawMessage `json:"json"`
					Ocpp    *struct {
						Revision float64 `json:"revision"`
						Antwort  struct {
							Applied *bool `json:"applied"`
						} `json:"antwort"`
					} `json:"ocpp_ergebnis"`
					Zaehler *struct {
						At     *int64         `json:"at"`
						Values []SampledValue `json:"values"`
					} `json:"zaehler"`
				} `json:"schritt"`
				Ergebnis       any `json:"ergebnis"`
				Veroeffentlich any `json:"veroeffentlicht"`
				Anfragen       any `json:"anfragen"`
				Belege         any `json:"belege"`
				OcppAuftraege  any `json:"ocpp_auftraege"`
			} `json:"protokoll"`
		} `json:"faelle"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || len(v.Faelle) == 0 {
		t.Fatalf("Vektoren: %v", err)
	}
	t0, _ := time.Parse(time.RFC3339, v.T0)
	for _, f := range v.Faelle {
		zeit := int64(0)
		io := &skriptIO{t: t}
		lz := NeueLaufzeit(io, func() time.Time { return t0.Add(time.Duration(zeit) * time.Millisecond) },
			func() int64 { return 1000000 + zeit })
		var k *Katalog
		for i, p := range f.Protokoll {
			s := p.Schritt
			if s.Zeit != nil {
				zeit = *s.Zeit
			}
			io.modbus, io.json = s.Modbus, s.JSON
			io.pub, io.anfr, io.belege, io.ocppAuf = []any{}, []any{}, []any{}, []any{}
			var ergebnis any
			switch {
			case s.Apply != nil:
				var keys []string
				for _, a := range s.Apply.Selections {
					keys = append(keys, a.PointKey)
				}
				if k, err = LadeKatalog(keys); err != nil {
					t.Fatal(err)
				}
				o := f.IO.planOptionen()
				o.ByteOrder, o.ByteOrders = s.Options.ByteOrder, s.Options.ByteOrders
				plan, err := lz.Apply(k, *s.Apply, o)
				if err != nil {
					t.Fatal(err)
				}
				ergebnis = map[string]any{"applied": plan.Applied, "pending": plan.Applied && len(plan.OcppConfiguration) > 0}
			case s.Tick:
				ergebnis = map[string]any{"samples": len(lz.Tick(context.Background()))}
			case s.Ocpp != nil:
				rev := s.Ocpp.Revision
				lz.OcppErgebnis(k, &rev, s.Ocpp.Antwort.Applied == nil || *s.Ocpp.Antwort.Applied)
			case s.Zaehler != nil:
				var at time.Time
				if s.Zaehler.At != nil {
					at = t0.Add(time.Duration(*s.Zaehler.At) * time.Millisecond)
				}
				ergebnis = map[string]any{"samples": len(lz.OnMeterValues(s.Zaehler.Values, at))}
			}
			for _, c := range []struct {
				was     string
				go_, js any
			}{{"ergebnis", ergebnis, p.Ergebnis}, {"veroeffentlicht", io.pub, p.Veroeffentlich},
				{"anfragen", io.anfr, p.Anfragen}, {"belege", io.belege, p.Belege}, {"ocpp_auftraege", io.ocppAuf, p.OcppAuftraege}} {
				g := alsJSON(t, c.go_)
				if !gleich(g, alsJSON(t, c.js)) {
					gj, _ := json.Marshal(g)
					jj, _ := json.Marshal(c.js)
					t.Errorf("%s, Schritt %d: %s\n Go %s\n JS %s", f.Name, i, c.was, gj, jj)
				}
			}
		}
	}
}
