package vertrag

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// Die Fälle, die jede Box-Seite gleich beurteilen muss (Zwilling: pruefe im
// Abholer der Mango, edge-light/scripts/pruefregel-abgleich.sh).
const faelleDatei = "../../../../docs/contracts/fernwartung-schluessel-v1-pruefregel.json"

type fall struct {
	Name       string `json:"name"`
	Antwort    string `json:"antwort"`
	Gilt       bool   `json:"gilt"`
	Pruefwert  string `json:"pruefwert"`
	Schluessel []struct {
		Rest   int    `json:"rest"`
		Zugang string `json:"zugang"`
		Base64 string `json:"base64"`
	} `json:"schluessel"`
}

func TestPruefregelFaelle(t *testing.T) {
	daten, err := os.ReadFile(faelleDatei)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Faelle []fall `json:"faelle"`
	}
	if err := json.Unmarshal(daten, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Faelle) < 30 {
		t.Fatalf("nur %d Fälle gelesen", len(doc.Faelle))
	}
	for _, f := range doc.Faelle {
		t.Run(f.Name, func(t *testing.T) {
			l, err := Pruefe([]byte(f.Antwort))
			if !f.Gilt {
				if err == nil {
					t.Fatalf("angenommen, muss verworfen werden: %+v", l)
				}
				if !IstForm(err) {
					t.Fatalf("anderer Fehler als die Form: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("verworfen: %v", err)
			}
			if l.Pruefwert != f.Pruefwert {
				t.Fatalf("Prüfwert %q, erwartet %q", l.Pruefwert, f.Pruefwert)
			}
			if len(l.Eintraege) != len(f.Schluessel) {
				t.Fatalf("%d Schlüssel, erwartet %d", len(l.Eintraege), len(f.Schluessel))
			}
			for i, s := range f.Schluessel {
				e := l.Eintraege[i]
				if e.Rest != s.Rest || e.Zugang != s.Zugang || e.Base64 != s.Base64 {
					t.Fatalf("Schlüssel %d: %d %s, erwartet %d %s", i, e.Rest, e.Zugang, s.Rest, s.Zugang)
				}
				if base64.StdEncoding.EncodeToString(e.Key.Marshal()) != s.Base64 {
					t.Fatalf("Schlüssel %d: der eingelesene Schlüssel ist ein anderer", i)
				}
			}
		})
	}
}

// Der Vertragsvektor selbst (den Test des Tunnel-Dienstes erzeugt ihn Byte für Byte).
func TestVertragsvektor(t *testing.T) {
	daten, err := os.ReadFile("../../../../docs/contracts/fernwartung-schluessel-v1.example.txt")
	if err != nil {
		t.Fatal(err)
	}
	l, err := Pruefe(daten)
	if err != nil {
		t.Fatal(err)
	}
	if len(l.Eintraege) != 1 || l.Eintraege[0].Rest != 3600 || l.Eintraege[0].Key.Type() != ssh.KeyAlgoRSA {
		t.Fatalf("anders gelesen: %+v", l)
	}
}

func rsaZeile(t *testing.T, bits int) string {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	p, err := ssh.NewPublicKey(&k.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(p.Marshal())
}

// Über die Zeichenprüfung des Mango-Skripts hinaus liest die Go-Seite den
// Schlüssel ein: Was kein RSA-Schlüssel in Normalform ist, gilt nicht.
func TestSchluesselWirdWirklichGelesen(t *testing.T) {
	gut := rsaZeile(t, 2048)
	antwort := func(key string) []byte {
		return []byte("vp-wartung-schluessel 1 0123456789abcdef\nschluessel 60 z ssh-rsa " + key + "\nende 1\n")
	}
	if _, err := Pruefe(antwort(gut)); err != nil {
		t.Fatalf("guter Schlüssel verworfen: %v", err)
	}
	// Um acht Zeichen gekürzt: Länge und Zeichen stimmen, der Schlüssel nicht.
	if _, err := Pruefe(antwort(gut[:len(gut)-8])); err == nil {
		t.Fatal("abgeschnittener Schlüssel angenommen")
	}
	// Nur der Anfang eines RSA-Schlüssels, mit Füllzeichen auf gültige Länge.
	if _, err := Pruefe(antwort("AAAAB3NzaC1yc2E" + strings.Repeat("A", 357))); err == nil {
		t.Fatal("Füllzeichen statt Schlüssel angenommen")
	}
}

// Eine Restlaufzeit mit führender Null nimmt die Go-Seite nicht (der Server
// schreibt keine): Das awk mancher BusyBox liest "060" als 48, das Mango-Skript
// führte dann eine kürzere Frist als der Server meint.
func TestKeineFuehrendeNull(t *testing.T) {
	key := rsaZeile(t, 2048)
	for rest, gilt := range map[string]bool{"60": true, "060": false, "000000060": false, "0": false, "999999999": true} {
		_, err := Pruefe([]byte("vp-wartung-schluessel 1 0123456789abcdef\nschluessel " + rest + " z ssh-rsa " + key + "\nende 1\n"))
		if (err == nil) != gilt {
			t.Errorf("Restlaufzeit %q: gilt %v, erwartet %v", rest, err == nil, gilt)
		}
	}
}

func TestGrenzenWieImAbholer(t *testing.T) {
	// Die Zahlen stehen auch im Kopf von schluessel-holen.sh (MAX_SEK,
	// MAX_ANZAHL, MAX_BYTES).
	daten, err := os.ReadFile("../../../../edge-light/openwrt/files/usr/libexec/vp-wartung/schluessel-holen.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, z := range []string{"MAX_SEK=86400 ", "MAX_ANZAHL=8 ", "MAX_BYTES=16384 "} {
		if !strings.Contains(string(daten), "\n"+z) {
			t.Errorf("im Abholer der Mango steht nicht %q: Grenzen nur gemeinsam ändern", strings.TrimSpace(z))
		}
	}
	if MaxSek != 86400 || MaxAnzahl != 8 || MaxBytes != 16384 {
		t.Error("Grenzen der Go-Regel geändert: nur gemeinsam mit dem Abholer der Mango")
	}
}
