// Package vertrag ist die Prüfregel der Box für die Antwort der
// Schlüsselausgabe (docs/contracts/fernwartung-schluessel-v1.md).
//
// Sie ist der Go-Zwilling von pruefe in
// edge-light/openwrt/files/usr/libexec/vp-wartung/schluessel-holen.sh (Mango).
// Beide und der Vertrag ändern sich nur gemeinsam; die Fälle in
// docs/contracts/fernwartung-schluessel-v1-pruefregel.json prüfen beide
// (edge-light/scripts/pruefregel-abgleich.sh).
package vertrag

import (
	"crypto/rsa"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

const (
	// MaxSek ist das längste Fenster, das die Box annimmt (24 h); eine
	// längere Restlaufzeit wird gekappt.
	MaxSek = 86400
	// MaxAnzahl: Mehr Schlüssel auf einmal nimmt die Box nicht an.
	MaxAnzahl = 8
	// MaxBytes: Eine Antwort ab dieser Größe ist keine.
	MaxBytes = 16384
)

// Eintrag ist ein Fenster-Schlüssel aus einer gültigen Antwort.
type Eintrag struct {
	Rest   int    // Sekunden bis zum Ende des Fensters, gekappt auf MaxSek
	Zugang string // ID des Techniker-Zugangs aus dem Portal
	Base64 string // der Schlüssel in Normalform, ohne "ssh-rsa "
	Key    ssh.PublicKey
}

// Liste ist eine gültige Antwort: die ganze Liste, mit ihrem Prüfwert.
type Liste struct {
	Pruefwert string
	Eintraege []Eintrag
}

var errForm = errors.New("Antwort verworfen (Form)")

func schlecht(grund string, a ...any) (Liste, error) {
	return Liste{}, fmt.Errorf("%w: %s", errForm, fmt.Sprintf(grund, a...))
}

// Pruefe liest eine Antwort 200 der Schlüsselausgabe. Nur eine vollständige,
// formgerechte Antwort gilt; die Box prüft jede Zeile selbst, auch den
// Schlüssel. Die Größe (MaxBytes) prüft, wer die Antwort liest.
func Pruefe(antwort []byte) (Liste, error) {
	zeilen := strings.Split(string(antwort), "\n")
	// Ein Zeilenende nach der letzten Zeile gehört zu ihr.
	if n := len(zeilen); n > 0 && zeilen[n-1] == "" {
		zeilen = zeilen[:n-1]
	}
	if len(zeilen) == 0 {
		return schlecht("leer")
	}
	kopf := strings.Split(zeilen[0], " ")
	if len(kopf) != 3 || kopf[0] != "vp-wartung-schluessel" || kopf[1] != "1" || !istPruefwert(kopf[2]) {
		return schlecht("Kopfzeile")
	}
	l := Liste{Pruefwert: kopf[2]}
	zu := false
	for i, z := range zeilen[1:] {
		if zu {
			return schlecht("Zeile %d nach ende", i+2)
		}
		f := strings.Split(z, " ")
		switch f[0] {
		case "schluessel":
			if len(f) != 5 {
				return schlecht("Zeile %d: schluessel hat nicht fünf Felder", i+2)
			}
			sek, ok := restlaufzeit(f[1])
			if !ok {
				return schlecht("Zeile %d: Restlaufzeit", i+2)
			}
			if !istZugang(f[2]) {
				return schlecht("Zeile %d: Zugang", i+2)
			}
			key, ok := rsaSchluessel(f[3], f[4])
			if !ok {
				return schlecht("Zeile %d: Schlüssel", i+2)
			}
			if len(l.Eintraege) >= MaxAnzahl {
				return schlecht("mehr als %d Schlüssel", MaxAnzahl)
			}
			l.Eintraege = append(l.Eintraege, Eintrag{Rest: sek, Zugang: f[2], Base64: f[4], Key: key})
		case "ende":
			if len(f) != 2 || !nurZiffern(f[1]) {
				return schlecht("Zeile %d: ende", i+2)
			}
			n, err := strconv.Atoi(f[1])
			if err != nil || n != len(l.Eintraege) {
				return schlecht("ende nennt %s, gelesen %d", f[1], len(l.Eintraege))
			}
			zu = true
		default:
			return schlecht("Zeile %d: unbekannt", i+2)
		}
	}
	if !zu {
		return schlecht("abgeschnitten: ende fehlt")
	}
	return l, nil
}

func istPruefwert(s string) bool {
	if len(s) != 16 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func nurZiffern(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// restlaufzeit: ganze Sekunden, mindestens 1, höchstens neun Ziffern; über
// MaxSek gekappt. Eine führende Null gilt nicht: Der Server schreibt keine,
// und das awk mancher BusyBox läse die Zahl dann zur Basis acht.
func restlaufzeit(s string) (int, bool) {
	if !nurZiffern(s) || len(s) > 9 || s[0] == '0' {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 1 {
		return 0, false
	}
	if n > MaxSek {
		n = MaxSek
	}
	return n, true
}

func istZugang(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// rsaSchluessel: "ssh-rsa" und der Schlüssel in Normalform, RSA 2048 bis 4096
// Bit. Die Grenzen der Zeichenkette sind die des Mango-Skripts; darüber hinaus
// liest die Go-Seite den Schlüssel wirklich ein (das Mango-Skript überlässt
// das Dropbear, der einen unlesbaren Schlüssel nie annimmt).
func rsaSchluessel(art, b64 string) (ssh.PublicKey, bool) {
	if art != "ssh-rsa" || !strings.HasPrefix(b64, "AAAAB3NzaC1yc2E") {
		return nil, false
	}
	if len(b64) < 360 || len(b64) > 720 || len(b64)%4 != 0 {
		return nil, false
	}
	kern := strings.TrimRight(b64, "=")
	if len(kern) <= len("AAAAB3NzaC1yc2E") {
		return nil, false
	}
	for _, c := range kern {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/') {
			return nil, false
		}
	}
	roh, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, false
	}
	key, err := ssh.ParsePublicKey(roh)
	if err != nil || key.Type() != ssh.KeyAlgoRSA {
		return nil, false
	}
	ck, ok := key.(ssh.CryptoPublicKey)
	if !ok {
		return nil, false
	}
	pk, ok := ck.CryptoPublicKey().(*rsa.PublicKey)
	if !ok || pk.N.BitLen() < 2048 || pk.N.BitLen() > 4096 {
		return nil, false
	}
	// Normalform: genau die Bytes, die der Schlüssel neu kodiert ergibt.
	if base64.StdEncoding.EncodeToString(key.Marshal()) != b64 {
		return nil, false
	}
	return key, true
}

// IstForm sagt, ob err eine verworfene Antwort meint.
func IstForm(err error) bool { return errors.Is(err, errForm) }
