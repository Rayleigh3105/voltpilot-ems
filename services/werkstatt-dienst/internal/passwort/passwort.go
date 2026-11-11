// Package passwort erzeugt das Root-Passwort einer Box und verschlüsselt es
// für den age-Schlüssel „Box-Passwörter“ des Betreibers (Entscheid WI-6 A).
//
// Wie das Portal (werkstatt.ts, erzeugePasswort; Entscheid 3a): 20 Zeichen aus
// 56 ohne verwechselbare, in fünf Gruppen zu vier, rund 116 Bit. Das Passwort
// lebt nur als geheim.Geheim im Speicher des Laufs; abgelegt wird nur der
// verschlüsselte Text. Entschlüsseln kann nur, wer den privaten age-Schlüssel
// hat - der Cluster nicht.
package passwort

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"strings"

	"filippo.io/age"
	"filippo.io/age/armor"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Zeichen wie PASSWORT_ZEICHEN im Portal.
const Zeichen = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const (
	gruppen = 5
	gruppe  = 4
)

// Neu erzeugt ein Passwort.
func Neu() (geheim.Geheim, error) {
	n := len(Zeichen)
	grenze := 256 - 256%n
	var z []byte
	buf := make([]byte, 32)
	for len(z) < gruppen*gruppe {
		if _, err := rand.Read(buf); err != nil {
			return geheim.Geheim{}, err
		}
		for _, b := range buf {
			if int(b) < grenze && len(z) < gruppen*gruppe {
				z = append(z, Zeichen[int(b)%n])
			}
		}
	}
	var t strings.Builder
	for i := 0; i < len(z); i += gruppe {
		if i > 0 {
			t.WriteByte('-')
		}
		t.Write(z[i : i+gruppe])
	}
	return geheim.Neu(t.String()), nil
}

// Empfaenger liest den öffentlichen age-Schlüssel (age1…).
func Empfaenger(s string) (age.Recipient, error) {
	r, err := age.ParseX25519Recipient(strings.TrimSpace(s))
	if err != nil {
		return nil, fmt.Errorf("age-Empfänger %q: %v", s, err)
	}
	return r, nil
}

// Verschluessle gibt das Passwort für den Empfänger verschlüsselt zurück
// (ASCII-Hülle, entschlüsseln mit "age -d -i <schlüssel>").
func Verschluessle(pw geheim.Geheim, r age.Recipient) (string, error) {
	var out bytes.Buffer
	aw := armor.NewWriter(&out)
	w, err := age.Encrypt(aw, r)
	if err != nil {
		return "", err
	}
	if _, err := w.Write([]byte(pw.Offenbaren() + "\n")); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	if err := aw.Close(); err != nil {
		return "", err
	}
	return out.String(), nil
}
