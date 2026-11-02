package passwort

import (
	"io"
	"regexp"
	"strings"
	"testing"

	"filippo.io/age"
	"filippo.io/age/armor"
)

func TestFormUndZufall(t *testing.T) {
	form := regexp.MustCompile(`^[` + Zeichen + `]{4}(-[` + Zeichen + `]{4}){4}$`)
	gesehen := map[string]bool{}
	for i := 0; i < 50; i++ {
		pw, err := Neu()
		if err != nil {
			t.Fatal(err)
		}
		if !form.MatchString(pw.Offenbaren()) || gesehen[pw.Offenbaren()] {
			t.Fatalf("%q", pw.Offenbaren())
		}
		gesehen[pw.Offenbaren()] = true
		pw.Vergessen()
	}
	if len(Zeichen) != 56 {
		t.Fatalf("%d Zeichen, das Portal hat 56", len(Zeichen))
	}
	for _, c := range "lo01IO" { // wie im Portal: i und j bleiben
		if strings.ContainsRune(Zeichen, c) {
			t.Fatalf("verwechselbares Zeichen %q", c)
		}
	}
}

func TestNurDerSchluesselEntschluesselt(t *testing.T) {
	id, _ := age.GenerateX25519Identity()
	fremd, _ := age.GenerateX25519Identity()
	r, err := Empfaenger(id.Recipient().String())
	if err != nil {
		t.Fatal(err)
	}
	pw, _ := Neu()
	defer pw.Vergessen()
	text, err := Verschluessle(pw, r)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(text, "-----BEGIN AGE ENCRYPTED FILE-----") || strings.Contains(text, pw.Offenbaren()) {
		t.Fatalf("%s", text)
	}
	klar, err := age.Decrypt(armor.NewReader(strings.NewReader(text)), id)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(klar)
	if strings.TrimSpace(string(b)) != pw.Offenbaren() {
		t.Fatal("entschlüsselt falsch")
	}
	if _, err := age.Decrypt(armor.NewReader(strings.NewReader(text)), fremd); err == nil {
		t.Fatal("fremder Schlüssel entschlüsselt")
	}
	if _, err := Empfaenger("ssh-ed25519 AAAA"); err == nil {
		t.Fatal("kein age-Empfänger angenommen")
	}
}
