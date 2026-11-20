package ereignisse

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestObergrenzeUndNieEinSchluessel(t *testing.T) {
	pfad := filepath.Join(t.TempDir(), "ereignisse")
	fest := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	l := &Liste{Pfad: pfad, Jetzt: func() time.Time { return fest }}
	for i := 1; i <= Max; i++ {
		if err := l.Schreibe(fmt.Sprintf("Ereignis %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	z, err := Lies(pfad, 0)
	if err != nil || len(z) != Max {
		t.Fatalf("%d Zeilen, %v", len(z), err)
	}
	if z[0] != "2026-11-20T10:00:00Z Ereignis 1" {
		t.Fatalf("erste Zeile %q", z[0])
	}
	// Das nächste Ereignis kürzt: die neuesten bleiben, nie mehr als Max.
	if err := l.Schreibe("Ereignis 251"); err != nil {
		t.Fatal(err)
	}
	z, _ = Lies(pfad, 0)
	if len(z) != Bleiben || !strings.HasSuffix(z[len(z)-1], "Ereignis 251") || !strings.HasSuffix(z[0], "Ereignis 52") {
		t.Fatalf("nach dem Kürzen %d Zeilen, erste %q, letzte %q", len(z), z[0], z[len(z)-1])
	}
	// Ein neuer Prozess zählt die vorhandenen Zeilen und hält die Grenze weiter.
	l2 := &Liste{Pfad: pfad}
	for i := 0; i < 2*Max; i++ {
		if err := l2.Schreibe("weiter"); err != nil {
			t.Fatal(err)
		}
		if n, _ := Lies(pfad, 0); len(n) > Max {
			t.Fatalf("%d Zeilen, mehr als %d", len(n), Max)
		}
	}
	// Ein Schlüssel steht nie in der Liste; eine Zeile ist höchstens Breite lang
	// und bleibt eine Zeile.
	if err := l2.Schreibe("Anmeldung mit ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB und\nzweiter Zeile " + strings.Repeat("x", 2*Breite)); err != nil {
		t.Fatal(err)
	}
	roh, _ := os.ReadFile(pfad)
	if strings.Contains(string(roh), "AAAAB3NzaC1") {
		t.Fatal("ein Schlüssel steht in der Ereignisliste")
	}
	z, _ = Lies(pfad, 1)
	if len(z) != 1 || len(z[0]) > Breite || !strings.Contains(z[0], "[schluessel]") || !strings.Contains(z[0], "und zweiter Zeile") {
		t.Fatalf("letzte Zeile %q", z[0])
	}
	if st, _ := os.Stat(pfad); st.Mode().Perm() != 0o600 {
		t.Fatalf("Rechte %v", st.Mode().Perm())
	}
}

func TestOhnePfadUndOhneDatei(t *testing.T) {
	var keine *Liste
	if err := keine.Schreibe("x"); err != nil {
		t.Fatal(err)
	}
	if err := (&Liste{}).Schreibe("x"); err != nil {
		t.Fatal(err)
	}
	if z, err := Lies(filepath.Join(t.TempDir(), "fehlt"), 10); err != nil || z != nil {
		t.Fatalf("%v %v", z, err)
	}
	// Fehlt das Verzeichnis, kommt der Fehler zurück, und nichts bricht ab.
	if err := (&Liste{Pfad: filepath.Join(t.TempDir(), "fehlt", "ereignisse")}).Schreibe("x"); err == nil {
		t.Fatal("kein Fehler ohne Verzeichnis")
	}
}
