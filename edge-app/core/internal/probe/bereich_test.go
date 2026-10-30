package probe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type bereichVektoren struct {
	Suchbereich struct {
		Faelle []struct {
			Adresse       string `json:"adresse"`
			Schnittstelle string `json:"schnittstelle"`
			Netz          string `json:"netz"`
			BoxAdresse    string `json:"box_adresse"`
			Ausschnitt    *bool  `json:"ausschnitt"`
			Abgelehnt     string `json:"abgelehnt"`
		} `json:"faelle"`
	} `json:"suchbereich"`
	Bereich struct {
		Faelle []struct {
			Netz       string `json:"netz"`
			BoxAdresse string `json:"box_adresse"`
			Gueltig    bool   `json:"gueltig"`
			Grund      string `json:"grund"`
		} `json:"faelle"`
	} `json:"bereich"`
	Ziel struct {
		Bereiche []struct {
			Netz       string `json:"netz"`
			BoxAdresse string `json:"box_adresse"`
		} `json:"bereiche"`
		Faelle []struct {
			IP      string `json:"ip"`
			Port    int    `json:"port"`
			Erlaubt bool   `json:"erlaubt"`
			Grund   string `json:"grund"`
		} `json:"faelle"`
	} `json:"ziel"`
}

func ladeBereichVektoren(t *testing.T) bereichVektoren {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "contracts", "lan-range-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v bereichVektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Suchbereich.Faelle) == 0 || len(v.Bereich.Faelle) == 0 || len(v.Ziel.Faelle) == 0 {
		t.Fatal("lan-range-vectors.json: a family is empty")
	}
	return v
}

// The box forms its search networks only from its own addresses - with the
// interface rules (tunnel, container) that only the box can apply.
func TestSuchBereichFolgtDenGeteiltenVektoren(t *testing.T) {
	for _, c := range ladeBereichVektoren(t).Suchbereich.Faelle {
		b, grund := SuchBereich(c.Adresse, c.Schnittstelle)
		if grund != c.Abgelehnt {
			t.Fatalf("%q (%s): grund %q, want %q", c.Adresse, c.Schnittstelle, grund, c.Abgelehnt)
		}
		if grund != "" {
			continue
		}
		if b.Netz.String() != c.Netz || b.BoxAdresse.String() != c.BoxAdresse {
			t.Fatalf("%q: %s / %s, want %s / %s", c.Adresse, b.Netz, b.BoxAdresse, c.Netz, c.BoxAdresse)
		}
		if (b.Ausschnitt == nil) != (c.Ausschnitt == nil) || (b.Ausschnitt != nil && *b.Ausschnitt != *c.Ausschnitt) {
			t.Fatalf("%q: ausschnitt %v, want %v", c.Adresse, b.Ausschnitt, c.Ausschnitt)
		}
		// What the box forms, the cloud must accept as a reported pair.
		if _, g := PruefeBereich(c.Netz, c.BoxAdresse); g != "" {
			t.Fatalf("%q: formed %s but the pair check refuses it: %s", c.Adresse, c.Netz, g)
		}
	}
}

func TestPruefeBereichFolgtDenGeteiltenVektoren(t *testing.T) {
	for _, c := range ladeBereichVektoren(t).Bereich.Faelle {
		_, grund := PruefeBereich(c.Netz, c.BoxAdresse)
		if (grund == "") != c.Gueltig || grund != c.Grund {
			t.Fatalf("%s / %s: grund %q, want gueltig=%v grund %q", c.Netz, c.BoxAdresse, grund, c.Gueltig, c.Grund)
		}
	}
}

func TestZielImBereichFolgtDenGeteiltenVektoren(t *testing.T) {
	v := ladeBereichVektoren(t)
	var bereiche []Bereich
	for _, b := range v.Ziel.Bereiche {
		x, grund := PruefeBereich(b.Netz, b.BoxAdresse)
		if grund != "" {
			t.Fatalf("ziel range %s: %s", b.Netz, grund)
		}
		bereiche = append(bereiche, x)
	}
	for _, c := range v.Ziel.Faelle {
		grund := ZielImBereich(c.IP, bereiche)
		if (grund == "") != c.Erlaubt || grund != c.Grund {
			t.Fatalf("%q:%d: grund %q, want erlaubt=%v grund %q", c.IP, c.Port, grund, c.Erlaubt, c.Grund)
		}
	}
	// A range is stricter than a host: every allowed target is also a private
	// host for the probe channel, never the other way round.
	for _, c := range v.Ziel.Faelle {
		if c.Erlaubt && !IsPrivateHost(c.IP) {
			t.Fatalf("%q is a range target but not a private host", c.IP)
		}
	}
}
