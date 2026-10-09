// Package probe liefert Prüfmaterial für Tests und die Integrationsprobe.
package probe

import (
	"encoding/base64"
	"encoding/binary"
	"math/big"
)

// SSHBlob kodiert einen öffentlichen RSA-Schlüssel im SSH-Format aus den
// rohen Feldern - auch aus solchen, die kein gültiger Schlüssel sind.
func SSHBlob(typ string, e, n []byte) string {
	var b []byte
	for _, feld := range [][]byte{[]byte(typ), e, n} {
		b = binary.BigEndian.AppendUint32(b, uint32(len(feld)))
		b = append(b, feld...)
	}
	return base64.StdEncoding.EncodeToString(b)
}

// MPInt ist die kürzeste Kodierung einer positiven Zahl im SSH-Format.
func MPInt(z *big.Int) []byte {
	b := z.Bytes()
	if len(b) > 0 && b[0]&0x80 != 0 {
		b = append([]byte{0}, b...)
	}
	return b
}

// SSHZeile liefert die Normalform "ssh-rsa <Base64>" eines Schlüssels mit
// einem Modul von genau bits Bit; verschiedene nr ergeben verschiedene
// Schlüssel. Der Modul ist ungerade, aber keine echte RSA-Zahl: anmelden kann
// sich damit niemand. Für alles, was nur Form, Länge und Fingerabdruck prüft.
func SSHZeile(bits, nr int) string {
	n := new(big.Int).Lsh(big.NewInt(1), uint(bits-1))
	n.Add(n, big.NewInt(int64(2*nr+1)))
	return "ssh-rsa " + SSHBlob("ssh-rsa", MPInt(big.NewInt(65537)), MPInt(n))
}
