package bestand

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/vertrag"
)

func rsaKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p, err := ssh.NewPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func edKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

type uhr struct{ t time.Time }

func (u *uhr) jetzt() time.Time { return u.t }

func liste(e ...vertrag.Eintrag) vertrag.Liste {
	return vertrag.Liste{Pruefwert: "0123456789abcdef", Eintraege: e}
}

func TestFristInLaufzeitUndGanzeListe(t *testing.T) {
	u := &uhr{t: time.Unix(1000, 0)}
	b := Neu("", u.jetzt)
	a, c := rsaKey(t), rsaKey(t)
	if !b.Uebernimm(liste(vertrag.Eintrag{Rest: 60, Zugang: "anna", Key: a}, vertrag.Eintrag{Rest: 600, Zugang: "carl", Key: c})) {
		t.Fatal("neue Zugänge nicht als Änderung gemeldet")
	}
	if u, ok := b.Pruefe(a); !ok || u.Art != Fenster || u.Zugang != "anna" || u.Fingerabdruck != ssh.FingerprintSHA256(a) {
		t.Fatalf("Fenster-Schlüssel gilt nicht: %+v %v", u, ok)
	}
	// Dieselbe Liste mit neuer Restlaufzeit: keine Änderung der Zugänge, aber
	// die Frist kommt aus dieser Antwort (sie ist kürzer geworden).
	if b.Uebernimm(liste(vertrag.Eintrag{Rest: 10, Zugang: "anna", Key: a}, vertrag.Eintrag{Rest: 600, Zugang: "carl", Key: c})) {
		t.Fatal("gleiche Zugänge als Änderung gemeldet")
	}
	if r, ok := b.NaechsteFrist(); !ok || r != 10*time.Second {
		t.Fatalf("nächste Frist %v %v", r, ok)
	}
	// Die Frist gilt schon bei der Anmeldung, auch wenn noch niemand gestrichen hat.
	u.t = u.t.Add(10 * time.Second)
	if _, ok := b.Pruefe(a); ok {
		t.Fatal("Schlüssel gilt zu seiner Frist noch")
	}
	if b.FensterGilt(ssh.FingerprintSHA256(a)) || !b.FensterGilt(ssh.FingerprintSHA256(c)) {
		t.Fatal("FensterGilt stimmt nicht")
	}
	if !b.Verfalle() || b.Verfalle() {
		t.Fatal("Verfalle meldet das Streichen nicht genau einmal")
	}
	// Die Antwort ist die ganze Liste: Was sie nicht mehr nennt, ist sofort weg.
	if !b.Uebernimm(liste()) {
		t.Fatal("leere Liste nicht als Änderung gemeldet")
	}
	if _, ok := b.Pruefe(c); ok {
		t.Fatal("Schlüssel gilt, obwohl die Liste ihn nicht mehr nennt")
	}
	if len(b.Fenster()) != 0 {
		t.Fatal("Fenster nicht leer")
	}
}

func TestDauerhafteSchluessel(t *testing.T) {
	dir := t.TempDir()
	datei := filepath.Join(dir, "authorized_keys")
	einfach, mitOption, fenster := rsaKey(t), edKey(t), rsaKey(t)
	zeile := func(k ssh.PublicKey) string { return string(ssh.MarshalAuthorizedKey(k)) }
	inhalt := "# Notfall-Schlüssel\n" + zeile(einfach) + "no-pty " + zeile(mitOption) + "kein schluessel\n\n"
	if err := os.WriteFile(datei, []byte(inhalt), 0o600); err != nil {
		t.Fatal(err)
	}
	b := Neu(datei, nil)
	if g, o, err := b.Dauerhaft(); err != nil || g != 1 || o != 1 {
		t.Fatalf("gezählt %d gelten, %d mit Optionen, %v", g, o, err)
	}
	if u, ok := b.Pruefe(einfach); !ok || u.Art != Dauerhaft {
		t.Fatalf("dauerhafter Schlüssel gilt nicht: %+v", u)
	}
	// Eine Zeile mit Optionen gilt im Tunnel nicht.
	if _, ok := b.Pruefe(mitOption); ok {
		t.Fatal("Zeile mit Optionen gilt im Tunnel")
	}
	// Derselbe Schlüssel zugleich im Fenster: die Anmeldung gilt als dauerhaft.
	b.Uebernimm(liste(vertrag.Eintrag{Rest: 60, Zugang: "anna", Key: einfach}, vertrag.Eintrag{Rest: 60, Zugang: "bert", Key: fenster}))
	if u, _ := b.Pruefe(einfach); u.Art != Dauerhaft {
		t.Fatalf("dauerhaft geht nicht vor: %+v", u)
	}
	if u, _ := b.Pruefe(fenster); u.Art != Fenster {
		t.Fatalf("Fenster-Schlüssel: %+v", u)
	}
	// Die Datei wird bei jeder Anmeldung neu gelesen.
	if err := os.WriteFile(datei, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if u, ok := b.Pruefe(einfach); !ok || u.Art != Fenster {
		t.Fatalf("nach dem Entfernen aus der Datei: %+v %v", u, ok)
	}
	// Ohne Datei gilt kein dauerhafter Schlüssel, und das ist kein Fehler.
	_ = os.Remove(datei)
	if g, o, err := b.Dauerhaft(); err != nil || g != 0 || o != 0 {
		t.Fatalf("ohne Datei: %d %d %v", g, o, err)
	}
}
