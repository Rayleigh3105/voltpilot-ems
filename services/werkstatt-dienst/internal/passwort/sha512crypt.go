package passwort

import (
	"crypto/rand"
	"crypto/sha512"
	"errors"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// SHA-512-crypt ("$6$", Drepper, https://www.akkadia.org/drepper/SHA-crypt.txt)
// mit den üblichen 5000 Runden: die Form, in der /etc/shadow ein Passwort
// hält. Der Dienst rechnet den Wert selbst, damit ein Passwort nie als
// Argument eines Befehls auf dem Gerät steht (dort läse es jeder aus der
// Prozessliste); auf das Gerät geht nur der Hash.

const (
	saltZeichen  = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	saltLaenge   = 16
	cryptRunden  = 5000
	cryptPraefix = "$6$"
)

// ShadowHash gibt das Passwort als Hash in der Form von /etc/shadow zurück,
// mit einem frischen Zufalls-Salt.
func ShadowHash(pw geheim.Geheim) (string, error) {
	n := len(saltZeichen)
	grenze := 256 - 256%n
	var salt []byte
	buf := make([]byte, 32)
	for len(salt) < saltLaenge {
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		for _, b := range buf {
			if int(b) < grenze && len(salt) < saltLaenge {
				salt = append(salt, saltZeichen[int(b)%n])
			}
		}
	}
	return Sha512Crypt(pw.Offenbaren(), string(salt))
}

// Sha512Crypt rechnet SHA-512-crypt für ein Passwort und ein Salt (1 bis 16
// Zeichen aus ./0-9A-Za-z).
func Sha512Crypt(passwort, salt string) (string, error) {
	if salt == "" || len(salt) > saltLaenge || strings.Trim(salt, saltZeichen) != "" {
		return "", errors.New("Salt: 1 bis 16 Zeichen aus ./0-9A-Za-z")
	}
	key, s := []byte(passwort), []byte(salt)

	b := sha512.New()
	b.Write(key)
	b.Write(s)
	b.Write(key)
	bSum := b.Sum(nil)

	a := sha512.New()
	a.Write(key)
	a.Write(s)
	n := len(key)
	for ; n > sha512.Size; n -= sha512.Size {
		a.Write(bSum)
	}
	a.Write(bSum[:n])
	for n = len(key); n > 0; n >>= 1 {
		if n&1 != 0 {
			a.Write(bSum)
		} else {
			a.Write(key)
		}
	}
	alt := a.Sum(nil)

	dp := sha512.New()
	for range key {
		dp.Write(key)
	}
	p := wiederhole(dp.Sum(nil), len(key))

	ds := sha512.New()
	for i := 0; i < 16+int(alt[0]); i++ {
		ds.Write(s)
	}
	sFolge := wiederhole(ds.Sum(nil), len(s))

	for i := 0; i < cryptRunden; i++ {
		c := sha512.New()
		if i&1 != 0 {
			c.Write(p)
		} else {
			c.Write(alt)
		}
		if i%3 != 0 {
			c.Write(sFolge)
		}
		if i%7 != 0 {
			c.Write(p)
		}
		if i&1 != 0 {
			c.Write(alt)
		} else {
			c.Write(p)
		}
		alt = c.Sum(nil)
	}

	var out strings.Builder
	out.WriteString(cryptPraefix)
	out.WriteString(salt)
	out.WriteByte('$')
	drei := func(b2, b1, b0 byte, zeichen int) {
		w := uint(b2)<<16 | uint(b1)<<8 | uint(b0)
		for ; zeichen > 0; zeichen-- {
			out.WriteByte(saltZeichen[w&0x3f])
			w >>= 6
		}
	}
	// Die Reihenfolge der Bytes ist Teil des Verfahrens.
	for i, x, y, z := 0, 0, 21, 42; i < 21; i++ {
		drei(alt[x], alt[y], alt[z], 4)
		x, y, z = y+1, z+1, x+1
	}
	drei(0, 0, alt[63], 2)
	return out.String(), nil
}

// wiederhole gibt die ersten n Bytes der endlos wiederholten Folge zurück.
func wiederhole(folge []byte, n int) []byte {
	out := make([]byte, 0, n)
	for len(out) < n {
		rest := n - len(out)
		if rest > len(folge) {
			rest = len(folge)
		}
		out = append(out, folge[:rest]...)
	}
	return out
}
