package hostkey

import (
	"bytes"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// Die Dateien in testdata hat Dropbear selbst geschrieben; der öffentliche
// Teil daneben stammt aus dropbearkey -y.
func TestEchteDropbearSchluessel(t *testing.T) {
	for _, name := range []string{
		"dropbear_rsa_host_key", "dropbear_ecdsa_host_key", "dropbear_ecdsa256_host_key",
		"dropbear_ecdsa384_host_key", "dropbear_ed25519_host_key",
	} {
		t.Run(name, func(t *testing.T) {
			s, err := Lies(filepath.Join("testdata", name))
			if err != nil {
				t.Fatal(err)
			}
			soll, err := os.ReadFile(filepath.Join("testdata", name+".pub"))
			if err != nil {
				t.Fatal(err)
			}
			ist := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey())))
			if ist != strings.TrimSpace(string(soll)) {
				t.Fatalf("öffentlicher Schlüssel\n ist  %s\n soll %s", ist, soll)
			}
			// Der Schlüssel unterschreibt, und die Unterschrift passt zum öffentlichen Teil.
			daten := []byte("vp-wartung")
			sig, err := s.Sign(rand.Reader, daten)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.PublicKey().Verify(daten, sig); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Der Dropbear des PFC200 (2022.82) speichert den privaten ECDSA-Wert
// ungekürzt: bei nistp521 bis 528 Bit, also auch größer als die Ordnung der
// Kurve. Am Test-Gerät am 20.11.2026 gefunden (Datei mit 243 statt 242 Byte).
// Es ist derselbe Schlüssel wie der gekürzte Wert.
func TestECDSAMitUngekuerztemWert(t *testing.T) {
	daten, err := os.ReadFile("testdata/dropbear_ecdsa_host_key")
	if err != nil {
		t.Fatal(err)
	}
	soll, err := Dropbear(daten)
	if err != nil {
		t.Fatal(err)
	}
	// Die Datei neu schreiben, mit dem privaten Wert plus 127-mal der Ordnung:
	// 528 Bit mit gesetztem obersten Bit, als mpint also 67 Byte.
	l := leser{b: daten}
	art, kurve, q, d := l.zeichenkette(), l.zeichenkette(), l.zeichenkette(), l.mpint()
	if l.err != nil {
		t.Fatal(l.err)
	}
	gross := new(big.Int).Add(d, new(big.Int).Mul(big.NewInt(127), elliptic.P521().Params().N))
	wert := gross.Bytes()
	if len(wert) != 66 || wert[0]&0x80 == 0 {
		t.Fatalf("der Testwert hat %d Byte, oberstes %#x", len(wert), wert[0])
	}
	var datei bytes.Buffer
	for _, feld := range [][]byte{art, kurve, q, append([]byte{0}, wert...)} {
		_ = binary.Write(&datei, binary.BigEndian, uint32(len(feld)))
		datei.Write(feld)
	}
	if datei.Len() != 243 {
		t.Fatalf("die Datei hat %d Byte", datei.Len())
	}
	ist, err := Dropbear(datei.Bytes())
	if err != nil {
		t.Fatalf("ungekürzter Wert verworfen: %v", err)
	}
	if !bytes.Equal(ist.PublicKey().Marshal(), soll.PublicKey().Marshal()) {
		t.Fatal("der ungekürzte Wert ergibt einen anderen Schlüssel")
	}
	// Ein Wert, der nicht zum Punkt der Datei gehört, bleibt ein Fehler.
	falsch := datei.Bytes()
	falsch[len(falsch)-1] ^= 1
	if _, err := Dropbear(falsch); err == nil {
		t.Fatal("falscher Wert angenommen")
	}
}

func TestKaputteDateien(t *testing.T) {
	rsa, err := os.ReadFile("testdata/dropbear_rsa_host_key")
	if err != nil {
		t.Fatal(err)
	}
	ecdsa, err := os.ReadFile("testdata/dropbear_ecdsa_host_key")
	if err != nil {
		t.Fatal(err)
	}
	// Jede abgeschnittene Datei ist ein Fehler, nie ein halber Schlüssel.
	for _, d := range [][]byte{rsa, ecdsa} {
		for n := 0; n < len(d); n += 7 {
			if _, err := Dropbear(d[:n]); err == nil {
				t.Fatalf("auf %d von %d Byte gekürzt: kein Fehler", n, len(d))
			}
		}
	}
	// Ein verändertes Byte im privaten Teil fällt auf.
	kaputt := append([]byte(nil), ecdsa...)
	kaputt[len(kaputt)-1] ^= 1
	if _, err := Dropbear(kaputt); err == nil {
		t.Fatal("veränderter ECDSA-Schlüssel angenommen")
	}
	kaputt = append([]byte(nil), rsa...)
	kaputt[len(kaputt)-1] ^= 1
	if _, err := Dropbear(kaputt); err == nil {
		t.Fatal("veränderter RSA-Schlüssel angenommen")
	}
	// DSA wird benannt, nicht gelesen.
	dss := append([]byte{0, 0, 0, 7}, "ssh-dss"...)
	if _, err := Dropbear(dss); !errors.Is(err, ErrDSA) {
		t.Fatalf("DSA: %v", err)
	}
	if _, err := Dropbear([]byte("-----BEGIN OPENSSH PRIVATE KEY-----")); err == nil {
		t.Fatal("OpenSSH-Format als Dropbear-Format gelesen")
	}
	if _, err := Lies("testdata/fehlt"); !os.IsNotExist(err) {
		t.Fatalf("fehlende Datei: %v", err)
	}
}
