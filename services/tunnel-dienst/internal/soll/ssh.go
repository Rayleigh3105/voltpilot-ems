package soll

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"math/big"
	"strings"
)

// Grenzen des SSH-Schlüssels - dieselben wie in der API (SshSchluessel.java).
const (
	SSHTyp     = "ssh-rsa"
	SSHMinBits = 2048
	// Bis hierher ist die Anmeldung am Dropbear der Mango belegt.
	SSHMaxBits = 4096
	// Länger ist auch ein 4096-Bit-Schlüssel in Normalform nicht (rund 730 Zeichen).
	sshMaxZeile     = 1000
	sshMaxExponent  = 32
	sshUnbrauchbar  = "kein öffentlicher SSH-Schlüssel in Normalform (eine Zeile „ssh-rsa <Base64>“, ohne Optionen und Kommentar)"
	sshFalscheBits  = "RSA-Schlüssel außerhalb von 2048 bis 4096 Bit"
	sshKeinRSAInnen = "der Schlüssel ist innen kein RSA-Schlüssel"
)

// SSHSchluessel ist ein geprüfter öffentlicher SSH-Schlüssel eines Technikers.
type SSHSchluessel struct {
	// Zeile ist die Normalform "ssh-rsa <Base64>", genau so, wie sie in die
	// Schlüsseldatei einer Box gehört.
	Zeile string
	// Fingerabdruck wie `ssh-keygen -lf`: "SHA256:…".
	Fingerabdruck string
	Bits          int
}

// PruefeSSHSchluessel nimmt nur die Normalform an, die die API speichert und
// im Soll-Stand ausliefert: genau eine Zeile, "ssh-rsa", ein Leerzeichen, der
// Schlüssel kürzestmöglich kodiert - keine Optionen davor, kein Kommentar
// dahinter, kein Zeilenumbruch. Alles andere wird abgelehnt und nicht
// "repariert": die Zeile geht unverändert in die Schlüsseldatei einer Box,
// und dort wäre ein Zusatz wie command="…" oder eine zweite Zeile ein eigener
// Zugang.
//
// Die Fehlermeldung wiederholt die Eingabe nie.
func PruefeSSHSchluessel(zeile string) (SSHSchluessel, error) {
	if zeile == "" || len(zeile) > sshMaxZeile {
		return SSHSchluessel{}, errors.New(sshUnbrauchbar)
	}
	rest, ok := strings.CutPrefix(zeile, SSHTyp+" ")
	if !ok || rest == "" {
		return SSHSchluessel{}, errors.New(sshUnbrauchbar)
	}
	for i := 0; i < len(rest); i++ {
		c := rest[i]
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+' || c == '/' || c == '=') {
			return SSHSchluessel{}, errors.New(sshUnbrauchbar)
		}
	}
	blob, err := base64.StdEncoding.Strict().DecodeString(rest)
	if err != nil {
		return SSHSchluessel{}, errors.New(sshUnbrauchbar)
	}
	typ, r, ok1 := sshFeld(blob)
	e, r, ok2 := sshFeld(r)
	n, r, ok3 := sshFeld(r)
	if !ok1 || !ok2 || !ok3 || len(r) != 0 || string(typ) != SSHTyp {
		return SSHSchluessel{}, errors.New(sshKeinRSAInnen)
	}
	exponent, okE := sshZahl(e)
	modul, okN := sshZahl(n)
	// Ein echter RSA-Schlüssel: Modul und Exponent ungerade, Exponent
	// mindestens 3 und so klein wie in der Praxis (üblich 65537).
	if !okE || !okN || modul.Bit(0) == 0 || exponent.Bit(0) == 0 || exponent.Cmp(big.NewInt(2)) <= 0 ||
		exponent.BitLen() > sshMaxExponent {
		return SSHSchluessel{}, errors.New(sshKeinRSAInnen)
	}
	if bits := modul.BitLen(); bits < SSHMinBits || bits > SSHMaxBits {
		return SSHSchluessel{}, errors.New(sshFalscheBits)
	}
	summe := sha256.Sum256(blob)
	return SSHSchluessel{Zeile: zeile, Fingerabdruck: "SHA256:" + base64.RawStdEncoding.EncodeToString(summe[:]),
		Bits: modul.BitLen()}, nil
}

// sshFeld liest ein Feld des SSH-Formats: vier Byte Länge, dann die Bytes.
func sshFeld(b []byte) (feld, rest []byte, ok bool) {
	if len(b) < 4 {
		return nil, nil, false
	}
	n := binary.BigEndian.Uint32(b)
	if uint64(n) > uint64(len(b)-4) {
		return nil, nil, false
	}
	return b[4 : 4+n], b[4+n:], true
}

// sshZahl liest eine positive Zahl in kürzester Kodierung (mpint): kein
// Vorzeichenbit, eine führende Null nur, wo das nächste Byte sie verlangt.
// Dropbear vergleicht Bytes; eine zweite Schreibweise desselben Schlüssels
// passte nicht zu dem, was der SSH-Client anbietet.
func sshZahl(b []byte) (*big.Int, bool) {
	if len(b) == 0 || b[0]&0x80 != 0 {
		return nil, false
	}
	if b[0] == 0 && (len(b) == 1 || b[1]&0x80 == 0) {
		return nil, false
	}
	return new(big.Int).SetBytes(bytes.TrimLeft(b, "\x00")), true
}
