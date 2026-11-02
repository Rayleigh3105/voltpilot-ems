package protokoll

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

func TestNurAnhaengenUndSchwaerzen(t *testing.T) {
	dir := t.TempDir()
	a, err := NeueAblage(dir)
	if err != nil {
		t.Fatal(err)
	}
	g := geheim.Neu("geheimer-wert-im-beleg")
	defer g.Vergessen()
	k := "2026-11-02-090000-ab12"
	if err := a.Schreibe(Eintrag{Lauf: k, Art: LaufBegonnen, Angaben: map[string]string{"freigabe": "f-1"}}); err != nil {
		t.Fatal(err)
	}
	erste, _ := os.ReadFile(filepath.Join(dir, k+".jsonl"))
	lang := strings.Repeat("x", MaxWert+100)
	if err := a.Schreibe(Eintrag{Lauf: k, Art: SchrittBelegt, Schritt: "s", Beleg: Beleg{}.Mit("ausgabe", "Box sagt geheimer-wert-im-beleg").Mit("lang", lang)}); err != nil {
		t.Fatal(err)
	}
	alles, _ := os.ReadFile(filepath.Join(dir, k+".jsonl"))
	if !strings.HasPrefix(string(alles), string(erste)) {
		t.Fatal("die erste Zeile wurde verändert")
	}
	if strings.Contains(string(alles), "geheimer-wert") || !strings.Contains(string(alles), "[geheim]") {
		t.Fatalf("nicht geschwärzt: %s", alles)
	}
	st, _ := os.Stat(filepath.Join(dir, k+".jsonl"))
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("Rechte %v", st.Mode().Perm())
	}
	es, err := a.Lies(k)
	if err != nil || len(es) != 2 {
		t.Fatalf("Lies: %v %d", err, len(es))
	}
	if v, _ := es[1].Beleg.Wert("lang"); len(v) > MaxWert+40 || !strings.HasSuffix(v, "(gekürzt)") {
		t.Fatalf("nicht gekürzt: %d", len(v))
	}
	if err := a.Schreibe(Eintrag{Lauf: "../weg", Art: LaufBegonnen}); err == nil {
		t.Fatal("ungültige Kennung angenommen")
	}
	_ = a.Schreibe(Eintrag{Lauf: "2026-11-03-090000-cd34", Art: LaufBegonnen, Angaben: map[string]string{"freigabe": "f-1"}})
	_ = a.Schreibe(Eintrag{Lauf: "2026-11-01-090000-ef56", Art: LaufBegonnen, Angaben: map[string]string{"freigabe": "f-2"}})
	ls, _ := a.Laeufe()
	if strings.Join(ls, " ") != "2026-11-03-090000-cd34 2026-11-02-090000-ab12 2026-11-01-090000-ef56" {
		t.Fatalf("Reihenfolge %v", ls)
	}
	if n, _ := a.Begonnen("f-1"); n != 2 {
		t.Fatalf("Begonnen f-1 = %d", n)
	}
	if !(Beleg{}).Mit("a", " ").Leer() || (Beleg{}).Mit("a", "x").Leer() {
		t.Fatal("Leer")
	}
}
