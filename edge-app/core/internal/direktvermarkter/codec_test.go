package direktvermarkter_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/direktvermarkter"
)

// The shared vectors live in the catalog, read BY PATH (like
// modbusprofil's modbus-tcp-vectors.json): a vectors edit that this twin
// does not follow fails `go test` even where Python never runs.
func vectorsPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "catalog", "direktvermarkter", "vectors", "luox.json")
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

type vectors struct {
	WordOrderRuntime string `json:"wortfolge_laufzeit"`
	OnStaleRuntime   string `json:"bei_veraltet_laufzeit"`
	Decode           []struct {
		Name      string   `json:"name"`
		Bedeutung string   `json:"bedeutung"`
		Typ       string   `json:"typ"`
		WordOrder string   `json:"wortfolge"`
		Regs      []uint16 `json:"regs"`
		Value     float64  `json:"value"`
	} `json:"decode"`
	Encode []struct {
		Name      string   `json:"name"`
		Bedeutung string   `json:"bedeutung"`
		Typ       string   `json:"typ"`
		WordOrder string   `json:"wortfolge"`
		Value     float64  `json:"value"`
		Regs      []uint16 `json:"regs"`
	} `json:"encode"`
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
	if len(v.Decode) == 0 || len(v.Encode) == 0 {
		t.Fatal("Vektoren leer")
	}
	return v
}

func TestDecodeVectors(t *testing.T) {
	for _, c := range loadVectors(t).Decode {
		got, ok := direktvermarkter.Decode(c.Regs, c.Typ, c.WordOrder)
		if !ok {
			t.Errorf("%s: Decode nicht ok", c.Name)
			continue
		}
		if got != c.Value {
			t.Errorf("%s: Decode(%v, %q, %q) = %v, Vektor %v", c.Name, c.Regs, c.Typ, c.WordOrder, got, c.Value)
		}
	}
}

func TestEncodeVectors(t *testing.T) {
	for _, c := range loadVectors(t).Encode {
		got, ok := direktvermarkter.Encode(c.Value, c.Typ, c.WordOrder)
		if !ok {
			t.Errorf("%s: Encode nicht ok", c.Name)
			continue
		}
		if len(got) != len(c.Regs) {
			t.Errorf("%s: Encode(%v, %q, %q) = %v, Vektor %v", c.Name, c.Value, c.Typ, c.WordOrder, got, c.Regs)
			continue
		}
		for i := range got {
			if got[i] != c.Regs[i] {
				t.Errorf("%s: Encode(%v, %q, %q) = %v, Vektor %v", c.Name, c.Value, c.Typ, c.WordOrder, got, c.Regs)
				break
			}
		}
	}
}

// TestEncodeDecodeRoundTrip proves the two halves of the write path agree
// with each other for every register the profile declares, in both
// candidate word orders - not just with the vectors' own fixed examples.
func TestEncodeDecodeRoundTrip(t *testing.T) {
	p, ok := direktvermarkter.For("luox")
	if !ok {
		t.Fatal("luox not embedded")
	}
	samples := map[string]float64{"u16": 55, "s16": -1, "u32": 123456, "s32": -1350}
	for _, r := range p.Register {
		value, ok := samples[r.Type]
		if !ok {
			t.Fatalf("no sample for type %q (%s)", r.Type, r.Meaning)
		}
		for _, order := range []string{"little", "big"} {
			regs, ok := direktvermarkter.Encode(value, r.Type, order)
			if !ok {
				t.Errorf("%s/%s: Encode failed", r.Meaning, order)
				continue
			}
			got, ok := direktvermarkter.Decode(regs, r.Type, order)
			if !ok || got != value {
				t.Errorf("%s/%s: round trip %v -> %v -> %v", r.Meaning, order, value, regs, got)
			}
		}
	}
}

func TestEncodeRejectsOutOfRange(t *testing.T) {
	cases := []struct {
		value float64
		typ   string
	}{
		{-1, "u16"},
		{65536, "u16"},
		{-32769, "s16"},
		{32768, "s16"},
		{-1, "u32"},
		{4294967296, "u32"},
		{1.5, "u16"},
	}
	for _, c := range cases {
		if _, ok := direktvermarkter.Encode(c.value, c.typ, "little"); ok {
			t.Errorf("Encode(%v, %q) should be rejected", c.value, c.typ)
		}
	}
}
