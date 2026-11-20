package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Der Schlüssel der Box entsteht einmal, mit Rechten nur für root, und ein
// zweiter Aufruf lässt ihn stehen.
func TestSchluesselEntstehtEinmal(t *testing.T) {
	datei := filepath.Join(t.TempDir(), "wartung", "wg.key")
	if err := schluessel([]string{"-datei", datei}); err != nil {
		t.Fatal(err)
	}
	erster, err := os.ReadFile(datei)
	if err != nil || len(erster) != 45 {
		t.Fatalf("Schlüsseldatei: %d Byte, %v", len(erster), err)
	}
	if st, _ := os.Stat(datei); st.Mode().Perm() != 0o600 {
		t.Fatalf("Rechte der Schlüsseldatei: %v", st.Mode().Perm())
	}
	if st, _ := os.Stat(filepath.Dir(datei)); st.Mode().Perm() != 0o700 {
		t.Fatalf("Rechte des Ordners: %v", st.Mode().Perm())
	}
	if err := schluessel([]string{"-datei", datei}); err != nil {
		t.Fatal(err)
	}
	if zweiter, _ := os.ReadFile(datei); string(zweiter) != string(erster) {
		t.Fatal("der zweite Aufruf hat den Schlüssel ersetzt")
	}
	// Eine Datei, die es gibt, aber nicht taugt, wird nie überschrieben.
	if err := os.Chmod(datei, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := schluessel([]string{"-datei", datei}); err == nil {
		t.Fatal("für andere lesbare Schlüsseldatei angenommen")
	}
	if danach, _ := os.ReadFile(datei); string(danach) != string(erster) {
		t.Fatal("die Schlüsseldatei wurde überschrieben")
	}
}

// Ohne laufenden Dienst meldet status den Ausgang 3.
func TestStatusOhneDienst(t *testing.T) {
	dir := t.TempDir()
	k := filepath.Join(dir, "konfig")
	inhalt := "adresse = 10.10.16.7\nserver_pubkey = abc=\nstand = " + filepath.Join(dir, "stand") + "\nereignisse = " + filepath.Join(dir, "ereignisse") + "\n"
	if err := os.WriteFile(k, []byte(inhalt), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := status([]string{"-konfig", k}); code != 3 {
		t.Fatalf("Ausgang %d", code)
	}
	if code := status([]string{"-konfig", k, "werte"}); code != 3 {
		t.Fatalf("Ausgang %d", code)
	}
}

// pruefe sagt vor dem Start, was dem Dienst fehlte; wartung.sh legt neue
// Einstellungen erst danach ab.
func TestPruefeVorDemStart(t *testing.T) {
	dir := t.TempDir()
	k := filepath.Join(dir, "konfig")
	key := filepath.Join(dir, "wg.key")
	schreibe := func(server string) {
		t.Helper()
		inhalt := "adresse = 10.10.16.7\nserver_pubkey = " + server + "\nwg_schluessel = " + key +
			"\nhostkeys = ../../internal/hostkey/testdata/dropbear_rsa_host_key\n"
		if err := os.WriteFile(k, []byte(inhalt), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	gut := "VQ/dbdRtEw9xQnktC3HwmyzOfohm2/peZoVD/XTXcyo="
	schreibe(gut)
	// Ohne Schlüssel der Box.
	if err := pruefe([]string{"-konfig", k}); err == nil {
		t.Fatal("ohne Schlüssel der Box angenommen")
	}
	if err := schluessel([]string{"-datei", key}); err != nil {
		t.Fatal(err)
	}
	if err := pruefe([]string{"-konfig", k}); err != nil {
		t.Fatalf("gute Einstellungen verworfen: %v", err)
	}
	// Ein Server-Schlüssel, der keiner ist; eine leere Datei (abgerissene Übertragung).
	schreibe("AAAA")
	if err := pruefe([]string{"-konfig", k}); err == nil {
		t.Fatal("falscher Server-Schlüssel angenommen")
	}
	if err := os.WriteFile(k, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := pruefe([]string{"-konfig", k}); err == nil {
		t.Fatal("leere Einstellungen angenommen")
	}
}
