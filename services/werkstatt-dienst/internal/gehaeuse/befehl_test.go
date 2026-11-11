package gehaeuse

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Ein nachgebautes bauen.sh: schreibt wie das Gehäuse-Programm nach aus/kennung/<ref>/.
const bauenSh = `#!/bin/sh
[ "$1" = "--referenz" ] || exit 2
d="$(dirname "$0")/aus/kennung/$2"
mkdir -p "$d"
echo "== Gehäuse für $2"
printf '3mf' > "$d/gehaeuse-$2.3mf"
printf '3mf' > "$d/unterteil-$2.3mf"
if [ "$2" = "edge-abcdefj" ]; then
  printf -- '- **Fehler:** Bambu Studio fehlt (./einrichten.sh --bambu)\n' > "$d/pruefung.md"
  echo "FEHLER: Bambu Studio fehlt" >&2
  exit 1
fi
printf -- '- Keine verletzte Regel; der QR-Code ist aus dem G-Code lesbar.\n' > "$d/pruefung.md"
`

func TestBefehlBautMitDemProgrammAufDiesemRechner(t *testing.T) {
	prog := t.TempDir()
	if err := os.WriteFile(filepath.Join(prog, "bauen.sh"), []byte(bauenSh), 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := Neu(t.TempDir(), Befehl{Programm: prog}, nil, time.Minute, time.Hour, stumm)
	if err != nil {
		t.Fatal(err)
	}
	starte(t, w)
	_, _ = w.Bestelle(refA, "", false)
	_, _ = w.Bestelle(refB, "", false)
	a := warteAuf(t, w, refA, Fertig)
	if len(a.Dateien) != 3 {
		t.Errorf("abgelegt: %+v", a.Dateien)
	}
	b := warteAuf(t, w, refB, Fehler)
	if !strings.Contains(b.Grund, "bauen.sh endete mit 1") || !strings.Contains(b.Grund, "Bambu Studio fehlt") {
		t.Errorf("Grund: %q", b.Grund)
	}
	p, ok := w.Datei(refB, Ausgabe)
	if !ok || !strings.Contains(mussLesen(t, p), "FEHLER: Bambu Studio fehlt") {
		t.Errorf("Ausgabe: %v", ok)
	}
	if _, err := os.Stat(filepath.Join(prog, "aus", "kennung", refA)); !os.IsNotExist(err) {
		t.Errorf("die Ausgabe des Programms bleibt nicht doppelt liegen: %v", err)
	}
}

func TestBefehlEndetMitDerFrist(t *testing.T) {
	prog := t.TempDir()
	_ = os.WriteFile(filepath.Join(prog, "bauen.sh"), []byte("#!/bin/sh\nsleep 30\n"), 0o755)
	w, _ := Neu(t.TempDir(), Befehl{Programm: prog}, nil, 100*time.Millisecond, time.Hour, stumm)
	starte(t, w)
	start := time.Now()
	_, _ = w.Bestelle(refA, "", false)
	a := warteAuf(t, w, refA, Fehler)
	if time.Since(start) > 5*time.Second || !strings.Contains(a.Grund, "nicht in 100ms fertig") {
		t.Errorf("nach %s: %q", time.Since(start), a.Grund)
	}
}
