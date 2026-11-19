package modbusprofil

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"testing"
)

// The shared vectors live next to the JS source of truth and are read BY PATH:
// modbus-tcp-vectors.gen.js writes them from modbus-tcp.js and
// vp-modbus-probe.js, modbus-tcp-vectors.test.js keeps them current.
func vectorsPath(t *testing.T) string {
	t.Helper()
	_, here, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(here), "..", "..", "..", "nodered", "modbus-tcp-vectors.json")
}

type vecOp struct {
	ID        *string `json:"id"`
	Host      string  `json:"host"`
	Port      int     `json:"port"`
	UnitID    int     `json:"unit_id"`
	FC        int     `json:"fc"`
	Address   int     `json:"address"`
	DataType  string  `json:"data_type"`
	WordOrder string  `json:"word_order"`
}

type vectors struct {
	RegisterCount []struct {
		DataType string `json:"data_type"`
		Count    *int   `json:"count"`
	} `json:"register_count"`
	DecodeValue []struct {
		Name      string   `json:"name"`
		Regs      []uint16 `json:"regs"`
		DataType  string   `json:"data_type"`
		WordOrder string   `json:"word_order"`
		Value     *float64 `json:"value"`
	} `json:"decode_value"`
	ProfileRead map[string]*Read `json:"profile_read"`
	Profile     []struct {
		Name    string   `json:"name"`
		Profile string   `json:"profile"`
		Regs    []uint16 `json:"regs"`
		Decode  *Result  `json:"decode"`
	} `json:"profile"`
	Classify []struct {
		Meldung  string `json:"meldung"`
		Ergebnis struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"ergebnis"`
	} `json:"classify"`
	Probe []struct {
		Name      string  `json:"name"`
		Ops       []vecOp `json:"ops"`
		Antworten []struct {
			Regs   []uint16 `json:"regs"`
			Fehler *string  `json:"fehler"`
		} `json:"antworten"`
		Plaene  []Leseplan `json:"plaene"`
		Results []Ergebnis `json:"results"`
	} `json:"probe"`
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
	if len(v.DecodeValue) == 0 || len(v.Profile) == 0 || len(v.Probe) == 0 {
		t.Fatal("Vektoren leer")
	}
	return v
}

func TestRegisterCountVectors(t *testing.T) {
	for _, c := range loadVectors(t).RegisterCount {
		want := 0
		if c.Count != nil {
			want = *c.Count
		}
		if got := RegisterCount(c.DataType); got != want {
			t.Errorf("RegisterCount(%q) = %d, JS %d", c.DataType, got, want)
		}
	}
}

func TestDecodeValueVectors(t *testing.T) {
	for _, c := range loadVectors(t).DecodeValue {
		got, ok := DecodeValue(c.Regs, c.DataType, c.WordOrder)
		switch {
		case c.Value == nil && ok:
			t.Errorf("%s: Go %v, JS null", c.Name, got)
		case c.Value != nil && !ok:
			t.Errorf("%s: Go kein Wert, JS %v", c.Name, *c.Value)
		case c.Value != nil && got != *c.Value:
			t.Errorf("%s: Go %v, JS %v", c.Name, got, *c.Value)
		}
	}
}

func TestProfileVectors(t *testing.T) {
	v := loadVectors(t)
	for name, want := range v.ProfileRead {
		profile := name
		if name == "unbekannt" {
			profile = "kompakt2"
		}
		got, ok := ProfileRead(profile)
		switch {
		case want == nil && ok:
			t.Errorf("ProfileRead(%q) = %+v, JS null", profile, got)
		case want != nil && (!ok || got != *want):
			t.Errorf("ProfileRead(%q) = %+v %v, JS %+v", profile, got, ok, *want)
		}
	}
	for _, c := range v.Profile {
		got := DecodeProfile(c.Profile, c.Regs)
		if !reflect.DeepEqual(got, c.Decode) {
			t.Errorf("%s: Go %+v, JS %+v", c.Name, got, c.Decode)
		}
		if got == nil {
			continue
		}
		// The JSON of both sides must match byte for byte (no "-0").
		gj, _ := json.Marshal(got)
		jj, _ := json.Marshal(c.Decode)
		if string(gj) != string(jj) {
			t.Errorf("%s: JSON Go %s, JS %s", c.Name, gj, jj)
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

// TestProbeVectors runs runOps' cases step by step through Lies with the same
// scripted reader: the same plans asked, the same answers given.
func TestProbeVectors(t *testing.T) {
	for _, c := range loadVectors(t).Probe {
		var plaene []Leseplan
		next := 0
		leser := func(_ context.Context, p Leseplan) ([]uint16, string) {
			plaene = append(plaene, p)
			if next >= len(c.Antworten) {
				return nil, "Vektor: keine Antwort mehr"
			}
			a := c.Antworten[next]
			next++
			if a.Fehler != nil {
				return nil, *a.Fehler
			}
			return append([]uint16(nil), a.Regs...), ""
		}
		var results []Ergebnis
		for i, o := range c.Ops {
			id := strconv.Itoa(i)
			if o.ID != nil {
				id = *o.ID
			}
			results = append(results, Lies(context.Background(), id, LeseOp{Host: o.Host, Port: o.Port,
				UnitID: o.UnitID, FC: o.FC, Address: o.Address, DataType: o.DataType, WordOrder: o.WordOrder}, leser))
		}
		if len(plaene) == 0 {
			plaene = []Leseplan{}
		}
		if !reflect.DeepEqual(plaene, c.Plaene) {
			t.Errorf("%s: Leseplaene Go %+v, JS %+v", c.Name, plaene, c.Plaene)
		}
		gj, _ := json.Marshal(results)
		jj, _ := json.Marshal(c.Results)
		if string(gj) != string(jj) {
			t.Errorf("%s: Ergebnisse\n Go %s\n JS %s", c.Name, gj, jj)
		}
	}
}
