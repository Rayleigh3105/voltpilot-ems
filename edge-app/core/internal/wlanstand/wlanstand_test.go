package wlanstand

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestStandListMarke(t *testing.T) {
	cases := []struct {
		name   string
		skript string
		want   int
	}{
		{"Marke", "#!/bin/sh\nset -u\nWLAN_STAND=3\nBEFEHL=x\n", 3},
		{"keine Marke (Stand vor der Marke)", "#!/bin/sh\nset -u\n", 0},
		{"null ist kein Stand", "WLAN_STAND=0\n", 0},
		{"eingerueckt zaehlt nicht", "  WLAN_STAND=4\n", 0},
		{"Kommentar zaehlt nicht", "# WLAN_STAND=5\n", 0},
		{"Loader-Marke zaehlt nicht", "LOADER_STAND=6\n", 0},
		{"Unsinn", "WLAN_STAND=abc\n", 0},
		{"leer", "", 0},
	}
	for _, c := range cases {
		if got := Stand([]byte(c.skript)); got != c.want {
			t.Errorf("%s: Stand = %d, erwartet %d", c.name, got, c.want)
		}
	}
}

func TestEingebetteterStandGesetzt(t *testing.T) {
	if EingebetteterStand() < 1 {
		t.Fatalf("das eingebettete wlan-anschluss.sh traegt keine WLAN_STAND-Marke - ohne sie wird es nie eingespielt")
	}
	if n := len(standZeile.FindAllIndex(anschlussSH, -1)); n != 1 {
		t.Fatalf("wlan-anschluss.sh traegt %d WLAN_STAND-Marken, erwartet genau 1", n)
	}
	if n := len(standZeile.FindAllIndex(einrichtungSH, -1)); n != 0 {
		t.Fatalf("einrichtung-wlan.sh traegt %d WLAN_STAND-Marken - den Stand traegt allein wlan-anschluss.sh", n)
	}
}

// TestKopienGleichQuelle: die eingebetteten Kopien muessen byte-gleich mit den
// Quellen unter edge-light/openwrt/files/ sein (sonst braechte das Update andere
// Skripte auf die Boxen als install.sh und die Werkstatt).
func TestKopienGleichQuelle(t *testing.T) {
	quellen := filepath.Join("..", "..", "..", "..", "edge-light", "openwrt", "files", "usr", "libexec", "vp-edge-light")
	for _, q := range []struct {
		name  string
		kopie []byte
	}{
		{"wlan-anschluss.sh", anschlussSH},
		{"einrichtung-wlan.sh", einrichtungSH},
	} {
		quelle, err := os.ReadFile(filepath.Join(quellen, q.name))
		if err != nil {
			t.Fatalf("%s: Quelle nicht lesbar: %v", q.name, err)
		}
		if !bytes.Equal(q.kopie, quelle) {
			t.Errorf("%s: eingebettete Kopie weicht von der Quelle ab - Quelle nach "+
				"edge-app/core/internal/wlanstand/ kopieren, WLAN_STAND erhoehen und stand-verlauf fortschreiben", q.name)
		}
	}
}

// TestStandVerlauf erzwingt das Ritual bei jeder Aenderung: streng steigende
// Staende, und die LETZTE Zeile beschreibt genau die eingebetteten Kopien.
// Ohne neuen Stand erreicht eine Aenderung keine Box im Feld, denn der
// Rueckschritt-Schutz vergleicht nur Staende, nie Inhalte.
func TestStandVerlauf(t *testing.T) {
	raw, err := os.ReadFile("stand-verlauf")
	if err != nil {
		t.Fatal(err)
	}
	type zeile struct {
		stand                     int
		anschlussSHA, einrichtSHA string
	}
	var verlauf []zeile
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for sc.Scan() {
		s := strings.TrimSpace(sc.Text())
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		f := strings.Fields(s)
		if len(f) != 3 {
			t.Fatalf("stand-verlauf: Zeile %q hat nicht 3 Felder (<stand> <sha256 wlan-anschluss.sh> <sha256 einrichtung-wlan.sh>)", s)
		}
		n, err := strconv.Atoi(f[0])
		if err != nil || n < 1 {
			t.Fatalf("stand-verlauf: %q ist kein Stand", f[0])
		}
		verlauf = append(verlauf, zeile{stand: n, anschlussSHA: f[1], einrichtSHA: f[2]})
	}
	if len(verlauf) == 0 {
		t.Fatal("stand-verlauf ist leer")
	}
	for i := 1; i < len(verlauf); i++ {
		if verlauf[i].stand <= verlauf[i-1].stand {
			t.Fatalf("stand-verlauf: Stand %d nach %d - Staende muessen streng steigen", verlauf[i].stand, verlauf[i-1].stand)
		}
	}
	letzte := verlauf[len(verlauf)-1]
	if letzte.stand != EingebetteterStand() {
		t.Fatalf("stand-verlauf endet bei Stand %d, wlan-anschluss.sh traegt WLAN_STAND=%d - beide gemeinsam fortschreiben",
			letzte.stand, EingebetteterStand())
	}
	sha := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	if letzte.anschlussSHA != sha(anschlussSH) {
		t.Errorf("stand-verlauf: sha256 von wlan-anschluss.sh ist %s, letzte Zeile nennt %s - Skript geaendert? "+
			"WLAN_STAND erhoehen und eine NEUE Zeile anhaengen", sha(anschlussSH), letzte.anschlussSHA)
	}
	if letzte.einrichtSHA != sha(einrichtungSH) {
		t.Errorf("stand-verlauf: sha256 von einrichtung-wlan.sh ist %s, letzte Zeile nennt %s - Skript geaendert? "+
			"WLAN_STAND erhoehen und eine NEUE Zeile anhaengen", sha(einrichtungSH), letzte.einrichtSHA)
	}
}

// Die eingebetteten Kopien bestehen die Pruefung, an der jede neue Fassung
// vor dem Ersetzen vorbei muss.
func TestEingebetteteKopienBestehenShN(t *testing.T) {
	dir := t.TempDir()
	p := &Pflege{}
	for name, inhalt := range map[string][]byte{"wlan-anschluss.sh": anschlussSH, "einrichtung-wlan.sh": einrichtungSH} {
		pfad := filepath.Join(dir, name)
		if err := os.WriteFile(pfad, inhalt, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := p.syntax(pfad); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// ---- Einspielen -------------------------------------------------------------

// Die alten Skripte der Boxen im Feld tragen keine Marke.
const (
	alterAnschluss   = "#!/bin/sh\n# alter WLAN-Anschluss ohne Marke\nexit 0\n"
	alteEinrichtung  = "#!/bin/sh\n# alter Waechter\nexit 0\n"
	neueEinrichtung  = "#!/bin/sh\n# neuer Waechter\nexit 0\n"
	neuerAnschlussV2 = "#!/bin/sh\nWLAN_STAND=2\n" +
		"case \"$1\" in wege) echo x >>\"$(dirname \"$0\")/wege-aufrufe\"; echo ergaenzt=192.168.2.169 ;; esac\n"
)

func box(t *testing.T) (dir string, p *Pflege) {
	t.Helper()
	dir = filepath.Join(t.TempDir(), "usr", "libexec", "vp-edge-light")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, &Pflege{Anschluss: filepath.Join(dir, "wlan-anschluss.sh")}
}

func schreibe(t *testing.T, pfad, inhalt string) {
	t.Helper()
	if err := os.WriteFile(pfad, []byte(inhalt), 0o755); err != nil {
		t.Fatal(err)
	}
}

func lies(t *testing.T, pfad string) string {
	t.Helper()
	b, err := os.ReadFile(pfad)
	if err != nil {
		t.Fatalf("%s: %v", pfad, err)
	}
	return string(b)
}

func fehlt(t *testing.T, pfad string) {
	t.Helper()
	if _, err := os.Stat(pfad); !os.IsNotExist(err) {
		t.Fatalf("%s liegt da (err=%v), erwartet: fehlt", filepath.Base(pfad), err)
	}
}

// staende haelt mtime und Inhalt aller Dateien im Verzeichnis fest.
func staende(t *testing.T, dir string) map[string]string {
	t.Helper()
	m := map[string]string{}
	eintraege, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range eintraege {
		fi, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		m[e.Name()] = fi.ModTime().String() + " " + lies(t, filepath.Join(dir, e.Name()))
	}
	return m
}

// Alter Stand (keine Marke): beide Skripte werden durch die eingebetteten
// Kopien ersetzt, die alten bleiben als .alt daneben, ein halber Schreibrest
// verschwindet; ein zweiter Lauf schreibt nichts mehr.
func TestEinspielenErneuertAltenStand(t *testing.T) {
	dir, p := box(t)
	schreibe(t, p.Anschluss, alterAnschluss)
	einr := filepath.Join(dir, EinrichtungName)
	schreibe(t, einr, alteEinrichtung)
	// Strom weg mitten in einem frueheren Schreiben: der Rest stoert nicht.
	schreibe(t, p.Anschluss+".neu", "#!/bin/sh\nWLAN_STA")

	erg, err := p.einspielen()
	if err != nil {
		t.Fatal(err)
	}
	if erg.Vorher != 0 || erg.Nachher != EingebetteterStand() || len(erg.Geschrieben) != 2 {
		t.Fatalf("Ergebnis %+v", erg)
	}
	if lies(t, p.Anschluss) != string(anschlussSH) || lies(t, einr) != string(einrichtungSH) {
		t.Fatal("die Skripte sind nicht die eingebetteten Kopien")
	}
	if lies(t, p.Anschluss+Alt) != alterAnschluss || lies(t, einr+Alt) != alteEinrichtung {
		t.Fatal("die alten Fassungen liegen nicht als .alt daneben")
	}
	for _, f := range []string{p.Anschluss, einr} {
		fi, err := os.Stat(f)
		if err != nil || fi.Mode().Perm()&0o111 == 0 {
			t.Fatalf("%s ist nicht ausfuehrbar (%v, err=%v) - cron ruft es direkt", filepath.Base(f), fi.Mode(), err)
		}
		fehlt(t, f+".neu")
		fehlt(t, f+Alt+".neu")
	}

	vor := staende(t, dir)
	time.Sleep(10 * time.Millisecond)
	erg, err = p.einspielen()
	if err != nil || len(erg.Geschrieben) != 0 || erg.Vorher != EingebetteterStand() {
		t.Fatalf("zweiter Lauf: %+v err=%v", erg, err)
	}
	if nach := staende(t, dir); len(nach) != len(vor) {
		t.Fatalf("zweiter Lauf: Dateien %v, vorher %v", nach, vor)
	} else {
		for k, v := range vor {
			if nach[k] != v {
				t.Fatalf("der zweite Lauf hat %s erneut geschrieben", k)
			}
		}
	}
}

// Kein Rueckschritt: ein NEUERER Stand im Flash (Rueckfall auf eine aeltere
// Programmfassung) bleibt stehen, samt seinem Waechter; gleicher Stand
// schreibt ebenfalls nichts.
func TestEinspielenNieEinenAelterenStand(t *testing.T) {
	dir, p := box(t)
	neuer := "#!/bin/sh\nWLAN_STAND=99999\n# aus einer neueren Programmfassung\n"
	schreibe(t, p.Anschluss, neuer)
	einr := filepath.Join(dir, EinrichtungName)
	schreibe(t, einr, "#!/bin/sh\n# gehoert zu Stand 99999\n")
	vor := staende(t, dir)

	erg, err := p.einspielen()
	if err != nil || len(erg.Geschrieben) != 0 || erg.Vorher != 99999 || erg.Nachher != 99999 {
		t.Fatalf("Ergebnis %+v err=%v", erg, err)
	}
	for k, v := range staende(t, dir) {
		if vor[k] != v {
			t.Fatalf("%s wurde ueberschrieben (Rueckschritt)", k)
		}
	}

	_, q := box(t)
	schreibe(t, q.Anschluss, string(anschlussSH))
	if erg, err := q.einspielen(); err != nil || len(erg.Geschrieben) != 0 {
		t.Fatalf("gleicher Stand: %+v err=%v", erg, err)
	}
	fehlt(t, q.Anschluss+Alt)
}

// Nur ersetzen, nie einrichten: ohne wlan-anschluss.sh wird nichts angelegt;
// ohne einrichtung-wlan.sh wird nur wlan-anschluss.sh ersetzt - der Waechter
// bleibt weg (ohne seinen cron-Eintrag aus install.sh waere er halb da).
func TestEinspielenNurErsetzenNieEinrichten(t *testing.T) {
	dir, p := box(t)
	erg, err := p.einspielen()
	if err != nil || !erg.KeinSkript || len(erg.Geschrieben) != 0 {
		t.Fatalf("ohne Skript: %+v err=%v", erg, err)
	}
	if e, _ := os.ReadDir(dir); len(e) != 0 {
		t.Fatalf("ohne Skript wurde etwas angelegt: %v", e)
	}

	schreibe(t, p.Anschluss, alterAnschluss)
	if erg, err := p.einspielen(); err != nil || len(erg.Geschrieben) != 1 || erg.Geschrieben[0] != p.Anschluss {
		t.Fatalf("ohne Waechter: %+v err=%v", erg, err)
	}
	if lies(t, p.Anschluss) != string(anschlussSH) {
		t.Fatal("wlan-anschluss.sh wurde nicht ersetzt")
	}
	fehlt(t, filepath.Join(dir, EinrichtungName))
	fehlt(t, filepath.Join(dir, EinrichtungName+Alt))
}

// Strom weg zwischen den beiden Skripten: der Waechter ist schon neu, der
// Stand-Traeger noch alt. Der naechste Lauf holt nur den Rest nach; die
// Sicherung des Waechters bleibt die urspruengliche Fassung.
func TestEinspielenHoltDenRestNach(t *testing.T) {
	dir, p := box(t)
	einr := filepath.Join(dir, EinrichtungName)
	schreibe(t, p.Anschluss, alterAnschluss)
	schreibe(t, einr, string(einrichtungSH))
	schreibe(t, einr+Alt, alteEinrichtung)
	vorEinr := staende(t, dir)
	time.Sleep(10 * time.Millisecond)

	erg, err := p.einspielen()
	if err != nil || len(erg.Geschrieben) != 1 || erg.Geschrieben[0] != p.Anschluss {
		t.Fatalf("Ergebnis %+v err=%v", erg, err)
	}
	nach := staende(t, dir)
	for _, k := range []string{EinrichtungName, EinrichtungName + Alt} {
		if nach[k] != vorEinr[k] {
			t.Fatalf("%s wurde erneut geschrieben", k)
		}
	}
	if lies(t, p.Anschluss) != string(anschlussSH) || lies(t, p.Anschluss+Alt) != alterAnschluss {
		t.Fatal("wlan-anschluss.sh nicht nachgeholt")
	}
}

// Eine neue Fassung, die `sh -n` nicht besteht, kommt nie an ihren Platz: die
// alte bleibt unversehrt, die temporaere Datei verschwindet.
func TestEinspielenVerwirftSyntaxfehler(t *testing.T) {
	dir, p := box(t)
	p.sollAnschluss = []byte("#!/bin/sh\nWLAN_STAND=2\nif then fi (\n")
	p.sollEinrichtung = []byte(neueEinrichtung)
	schreibe(t, p.Anschluss, alterAnschluss)

	if _, err := p.einspielen(); err == nil || !strings.Contains(err.Error(), "-n") {
		t.Fatalf("err=%v, erwartet die Ablehnung durch sh -n", err)
	}
	if lies(t, p.Anschluss) != alterAnschluss {
		t.Fatal("das alte Skript ist nicht mehr unversehrt")
	}
	fehlt(t, p.Anschluss+".neu")
	fehlt(t, filepath.Join(dir, EinrichtungName))

	// Ohne Shell zum Pruefen wird ebenfalls nichts ersetzt.
	q := &Pflege{Anschluss: p.Anschluss, Shell: filepath.Join(dir, "keine-shell")}
	if _, err := q.einspielen(); err == nil {
		t.Fatal("ohne pruefende Shell wurde eingespielt")
	}
	if lies(t, p.Anschluss) != alterAnschluss {
		t.Fatal("ohne pruefende Shell ist das alte Skript nicht mehr unversehrt")
	}
}

// Ein beschaedigt geschriebener Stand wird verworfen: die Pruefung nach dem
// Schreiben schlaegt fehl, das alte Skript bleibt, kein Rest bleibt liegen.
func TestEinspielenVerwirftBeschaedigtesGeschriebenes(t *testing.T) {
	_, p := box(t)
	schreibe(t, p.Anschluss, alterAnschluss)
	p.NachSchreiben = func(tmp string) {
		if err := os.WriteFile(tmp, []byte("#!/bin/sh\nWLAN_STAND=1\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := p.einspielen(); err == nil {
		t.Fatal("ein beschaedigt geschriebener Stand wurde angenommen")
	}
	if lies(t, p.Anschluss) != alterAnschluss {
		t.Fatal("das alte Skript ist nicht mehr unversehrt")
	}
	fehlt(t, p.Anschluss+".neu")
}

// Nach dem Ersetzen von wlan-anschluss.sh ruft der Lauf genau einmal dessen
// `wege` (die neue Fassung) - und nie, wenn nichts ersetzt wurde.
func TestLaufRuftWegeNurNachDemErsetzen(t *testing.T) {
	dir, p := box(t)
	p.sollAnschluss = []byte(neuerAnschlussV2)
	p.sollEinrichtung = []byte(neueEinrichtung)
	schreibe(t, p.Anschluss, alterAnschluss)
	schreibe(t, filepath.Join(dir, EinrichtungName), alteEinrichtung)
	aufrufe := filepath.Join(dir, "wege-aufrufe")

	erg, err := p.Lauf(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if erg.Wege != "ergaenzt=192.168.2.169" || erg.WegeFehler != "" {
		t.Fatalf("wege: %q / %q", erg.Wege, erg.WegeFehler)
	}
	if lies(t, aufrufe) != "x\n" {
		t.Fatalf("wege lief %q mal", lies(t, aufrufe))
	}

	erg, err = p.Lauf(context.Background())
	if err != nil || len(erg.Geschrieben) != 0 || erg.Wege != "" {
		t.Fatalf("zweiter Lauf: %+v err=%v", erg, err)
	}
	if lies(t, aufrufe) != "x\n" {
		t.Fatal("ohne Ersetzen lief wege erneut")
	}
}
