package geraet

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

// vektoren sind dieselben Faelle, an denen auch die Cloud ihre Annahme prueft
// (docs/contracts/v2/box-geraet-vectors.json).
type vektoren struct {
	Erkennung []struct {
		Name     string            `json:"name"`
		Arch     string            `json:"arch"`
		Dateien  map[string]string `json:"dateien"`
		Erwartet struct {
			Modell *string `json:"modell"`
			Arch   string  `json:"arch"`
		} `json:"erwartet"`
	} `json:"erkennung"`
}

func ladeVektoren(t *testing.T) vektoren {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "v2", "box-geraet-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Erkennung) == 0 {
		t.Fatal("keine Erkennungs-Faelle")
	}
	return v
}

func TestErkennenNachDenVektoren(t *testing.T) {
	for _, f := range ladeVektoren(t).Erkennung {
		t.Run(f.Name, func(t *testing.T) {
			fsys := fstest.MapFS{}
			for pfad, inhalt := range f.Dateien {
				fsys[pfad] = &fstest.MapFile{Data: []byte(inhalt)}
			}
			got := Erkennen(fsys, f.Arch)
			want := ""
			if f.Erwartet.Modell != nil {
				want = *f.Erwartet.Modell
			}
			if got.Modell != want || got.Arch != f.Erwartet.Arch {
				t.Fatalf("got %+v, want modell=%q arch=%q", got, want, f.Erwartet.Arch)
			}
		})
	}
}

func TestNormalisierenKuerztHartUndVerwirftPlatzhalter(t *testing.T) {
	lang := ""
	for len(lang) < 120 {
		lang += "abcdefghij"
	}
	if got := Normalisieren(lang); len([]rune(got)) != MaxModell {
		t.Fatalf("Laenge %d", len([]rune(got)))
	}
	for _, p := range []string{"Default string", "  default STRING ", "None", "\x00"} {
		if got := Normalisieren(p); got != "" {
			t.Fatalf("Platzhalter %q ergab %q", p, got)
		}
	}
}
