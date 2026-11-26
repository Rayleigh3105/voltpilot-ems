package steuerplan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The Go path writes the 47077 step of the Huawei profile's sequences
// (catalog/control-profiles/profiles/huawei.json adapter.folgen, which the
// Node-RED adapter is held to by control-profiles.test.js) and nothing else of
// them: Halten and Laden their 47077 = 0, Decken and the Rückgabe their 47077 =
// "ausgangswert". 47075 (charge limit) is not released until it is measured
// under PV surplus (captain, 26.11.2026); Netzladen has no Go sequence.
func TestHuaweiFolgenWieImProfil(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "catalog", "control-profiles", "profiles", "huawei.json"))
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Adapter struct {
			Folgen map[string]struct {
				Schreibfolge []struct {
					Wert any `json:"wert"`
					Ziel struct {
						Register int `json:"register"`
					} `json:"ziel"`
				} `json:"schreibfolge"`
			} `json:"folgen"`
		} `json:"adapter"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	for _, f := range []struct {
		profil string
		kw     float64
		extra  Obj
		folge  string
	}{
		{"halten", 0, nil, FolgeEntladenSperren},
		{"laden_gedrosselt", 1.5, nil, FolgeEntladenSperren},
		{"decken", -1, nil, FolgeEntladenFrei},
		{"rueckgabe", 1, Obj{"control_enabled": false}, FolgeRueckgabe},
	} {
		e := planHuaweiTest(f.kw, f.extra, true, true)
		if e.Folge != f.folge || len(e.Schritte) != 1 || e.Schritte[0].Feld.Addr != HuaweiRegMaxEntladen {
			t.Fatalf("%s: %+v", f.profil, e)
		}
		var step *struct {
			Wert any `json:"wert"`
			Ziel struct {
				Register int `json:"register"`
			} `json:"ziel"`
		}
		for i := range p.Adapter.Folgen[f.profil].Schreibfolge {
			if s := &p.Adapter.Folgen[f.profil].Schreibfolge[i]; s.Ziel.Register == HuaweiRegMaxEntladen {
				step = s
			}
		}
		if step == nil {
			t.Fatalf("%s: das Profil hat keinen 47077-Schritt", f.profil)
		}
		s := e.Schritte[0]
		switch v := step.Wert.(type) {
		case float64:
			if s.AusAusgang || s.Wert != int(v) {
				t.Errorf("%s: Go %+v, Profil %v", f.profil, s, v)
			}
		case string:
			if (v == "ausgangswert") != s.AusAusgang {
				t.Errorf("%s: Profil %q, Go AusAusgang=%v", f.profil, v, s.AusAusgang)
			}
		}
	}
	if _, ok := p.Adapter.Folgen["netzladen"]; !ok {
		t.Fatal("das Profil führt Netzladen weiter als gesperrten Entwurf")
	}
	if e := planHuaweiTest(1.5, Obj{"grid_charge_allowed": true}, true, false); e.Folge != FolgeEntladenSperren {
		t.Fatalf("Netzladen -> nur Entladen sperren: %+v", e)
	}
}
