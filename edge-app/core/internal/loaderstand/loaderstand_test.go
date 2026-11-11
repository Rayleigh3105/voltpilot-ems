package loaderstand

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestStandListMarke(t *testing.T) {
	cases := []struct {
		name   string
		skript string
		want   int
	}{
		{"Marke", "#!/bin/sh\nLOADER_STAND=3\nlog x\n", 3},
		{"keine Marke (alter Loader)", "#!/bin/sh\nlog x\n", 0},
		{"null ist kein Stand", "LOADER_STAND=0\n", 0},
		{"eingerueckt zaehlt nicht", "  LOADER_STAND=4\n", 0},
		{"Kommentar zaehlt nicht", "# LOADER_STAND=5\n", 0},
		{"Unsinn", "LOADER_STAND=abc\n", 0},
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
		t.Fatalf("der eingebettete Loader traegt keine LOADER_STAND-Marke - ohne sie wird er nie eingespielt")
	}
	if n := len(standZeile.FindAllIndex(bootSH, -1)); n != 1 {
		t.Fatalf("boot.sh traegt %d LOADER_STAND-Marken, erwartet genau 1", n)
	}
}

// TestKopienGleichQuelle: die eingebetteten Kopien muessen byte-gleich mit den
// Quellen unter edge-light/openwrt/files/ sein (eine Kopie, die abweicht,
// brachte sonst einen anderen Loader auf die Boxen als der Wartungstunnel).
func TestKopienGleichQuelle(t *testing.T) {
	repo := filepath.Join("..", "..", "..", "..")
	quellen := []struct {
		name  string
		kopie []byte
		pfad  string
	}{
		{"boot.sh", bootSH, filepath.Join(repo, "edge-light", "openwrt", "files", "usr", "libexec", "vp-edge-light", "boot.sh")},
		{"vp-edge-light.init", initSkript, filepath.Join(repo, "edge-light", "openwrt", "files", "etc", "init.d", "vp-edge-light")},
	}
	for _, q := range quellen {
		quelle, err := os.ReadFile(q.pfad)
		if err != nil {
			t.Fatalf("%s: Quelle nicht lesbar: %v", q.name, err)
		}
		if !bytes.Equal(q.kopie, quelle) {
			t.Errorf("%s: eingebettete Kopie weicht von %s ab - Quelle nach "+
				"edge-app/core/internal/loaderstand/ kopieren, LOADER_STAND erhoehen und stand-verlauf fortschreiben", q.name, q.pfad)
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
		stand            int
		bootSHA, initSHA string
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
			t.Fatalf("stand-verlauf: Zeile %q hat nicht 3 Felder (<stand> <sha256 boot.sh> <sha256 init>)", s)
		}
		n, err := strconv.Atoi(f[0])
		if err != nil || n < 1 {
			t.Fatalf("stand-verlauf: %q ist kein Stand", f[0])
		}
		verlauf = append(verlauf, zeile{stand: n, bootSHA: f[1], initSHA: f[2]})
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
		t.Fatalf("stand-verlauf endet bei Stand %d, boot.sh traegt LOADER_STAND=%d - beide gemeinsam fortschreiben",
			letzte.stand, EingebetteterStand())
	}
	sha := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	if letzte.bootSHA != sha(bootSH) {
		t.Errorf("stand-verlauf: sha256 von boot.sh ist %s, letzte Zeile nennt %s - boot.sh geaendert? "+
			"LOADER_STAND erhoehen und eine NEUE Zeile anhaengen", sha(bootSH), letzte.bootSHA)
	}
	if letzte.initSHA != sha(initSkript) {
		t.Errorf("stand-verlauf: sha256 des Init-Skripts ist %s, letzte Zeile nennt %s - Init geaendert? "+
			"LOADER_STAND erhoehen und eine NEUE Zeile anhaengen", sha(initSkript), letzte.initSHA)
	}
}
