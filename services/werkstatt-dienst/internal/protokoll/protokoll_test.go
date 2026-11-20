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

// Die Spur einer Box zählt ein Passwort als gesetzt, wenn der Schritt belegt
// ist - oder wenn er scheiterte, nachdem das verschlüsselte Passwort schon im
// Beleg stand (PFC200: der Schritt zugaenge hat mehrere Teile). Ein Schritt,
// der vorher scheiterte, hat nichts gesetzt.
func TestSpurKenntGesetztePasswoerter(t *testing.T) {
	a, err := NeueAblage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	schreibe := func(lauf, mac string, es ...Eintrag) {
		t.Helper()
		alle := append([]Eintrag{{Art: LaufBegonnen, Angaben: map[string]string{"mac": mac}}}, es...)
		for _, e := range alle {
			e.Lauf = lauf
			if err := a.Schreibe(e); err != nil {
				t.Fatal(err)
			}
		}
	}
	erkannt := Eintrag{Art: SchrittBelegt, Schritt: "erkennen", Beleg: Beleg{}.Mit("host_schluessel", "ecdsa-sha2-nistp521 SHA256:abc")}
	schreibe("2026-11-20-100000-aaaa", "00:30:de:00:00:01", erkannt, Eintrag{Art: SchrittBelegt, Schritt: "zugaenge", Beleg: Beleg{}.Mit("passwort_age", "x")})
	schreibe("2026-11-20-100100-bbbb", "00:30:de:00:00:02", erkannt, Eintrag{Art: SchrittGescheitert, Schritt: "zugaenge", Beleg: Beleg{}.Mit("passwort_age", "x")})
	schreibe("2026-11-20-100200-cccc", "00:30:de:00:00:03", erkannt, Eintrag{Art: SchrittGescheitert, Schritt: "zugaenge", Beleg: Beleg{}.Mit("lauf_schluessel", "y")})
	schreibe("2026-11-20-100300-dddd", "94:83:c4:00:00:04", erkannt, Eintrag{Art: SchrittBelegt, Schritt: "passwort", Beleg: Beleg{}.Mit("passwort_age", "x")})
	for mac, soll := range map[string]bool{"00:30:de:00:00:01": true, "00:30:de:00:00:02": true, "00:30:de:00:00:03": false, "94:83:c4:00:00:04": true} {
		sp, ok, err := a.SpurDerMAC(mac, "")
		if err != nil || ok != soll || (ok && (sp.Host != "SHA256:abc" || !sp.PasswortGesetzt)) {
			t.Errorf("%s: gefunden %v (%+v, %v), erwartet %v", mac, ok, sp, err, soll)
		}
	}
}
