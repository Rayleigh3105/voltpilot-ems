// Package hostkey liest die Host-Schlüssel, die der Dropbear des Geräts schon
// hat (/etc/dropbear/dropbear_*_host_key, Dropbears eigenes Format). Der
// SSH-Server im Wartungstunnel zeigt damit dieselben Host-Schlüssel wie SSH im
// LAN: Die Werkstatt liest den Fingerabdruck auf zwei Wegen und verlangt, dass
// beide gleich sind.
//
// Das Format (dropbear, signkey.c, rsa.c, ecdsa.c, ed25519.c):
//
//	ssh-rsa                string "ssh-rsa", mpint e, mpint n, mpint d, mpint p, mpint q
//	ecdsa-sha2-nistp…      string Art, string Kurve, string Q (Punkt), mpint d
//	ssh-ed25519            string "ssh-ed25519", uint32 64, 32 Byte privat, 32 Byte öffentlich
//
// DSA (ssh-dss) liest dieses Paket nicht: Der Go-Server bietet es nicht an.
package hostkey

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/x509"
	"encoding/asn1"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"os"

	"golang.org/x/crypto/ssh"
)

// ErrDSA: Die Datei ist ein DSA-Schlüssel; er wird nicht verwendet.
var ErrDSA = errors.New("DSA-Host-Schlüssel wird nicht verwendet")

// Lies liest einen Host-Schlüssel aus einer Datei im Dropbear-Format.
func Lies(pfad string) (ssh.Signer, error) {
	daten, err := os.ReadFile(pfad)
	if err != nil {
		return nil, err
	}
	s, err := Dropbear(daten)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", pfad, err)
	}
	return s, nil
}

// Dropbear liest einen privaten Schlüssel in Dropbears Format.
func Dropbear(daten []byte) (ssh.Signer, error) {
	l := leser{b: daten}
	art := string(l.zeichenkette())
	if l.err != nil {
		return nil, errors.New("kein Schlüssel im Dropbear-Format")
	}
	switch art {
	case ssh.KeyAlgoRSA:
		return liesRSA(&l)
	case ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521:
		return liesECDSA(&l, art)
	case ssh.KeyAlgoED25519:
		return liesEd25519(&l)
	case ssh.InsecureKeyAlgoDSA:
		return nil, ErrDSA
	}
	return nil, fmt.Errorf("unbekannte Schlüsselart %q", art)
}

func liesRSA(l *leser) (ssh.Signer, error) {
	e, n, d := l.mpint(), l.mpint(), l.mpint()
	if l.err != nil {
		return nil, errors.New("RSA-Schlüssel abgeschnitten")
	}
	// p und q schreibt Dropbear nur, wenn es sie kennt. Ohne sie rechnet
	// crypto/rsa nicht.
	p, q := l.mpint(), l.mpint()
	if l.err != nil {
		return nil, errors.New("RSA-Schlüssel ohne Primfaktoren (p, q)")
	}
	if !e.IsInt64() || e.Int64() < 3 || e.Int64() > 1<<31-1 {
		return nil, errors.New("RSA-Exponent außerhalb des Üblichen")
	}
	key := &rsa.PrivateKey{
		PublicKey: rsa.PublicKey{N: n, E: int(e.Int64())},
		D:         d,
		Primes:    []*big.Int{p, q},
	}
	if err := key.Validate(); err != nil {
		return nil, fmt.Errorf("RSA-Schlüssel nicht stimmig: %v", err)
	}
	key.Precompute()
	return ssh.NewSignerFromKey(key)
}

// SEC 1, Anhang C.4: ECPrivateKey.
type ecPrivat struct {
	Version int
	Privat  []byte
	Kurve   asn1.ObjectIdentifier `asn1:"optional,explicit,tag:0"`
}

var kurven = map[string]struct {
	oid   asn1.ObjectIdentifier
	bytes int
	kurve elliptic.Curve
}{
	ssh.KeyAlgoECDSA256: {asn1.ObjectIdentifier{1, 2, 840, 10045, 3, 1, 7}, 32, elliptic.P256()},
	ssh.KeyAlgoECDSA384: {asn1.ObjectIdentifier{1, 3, 132, 0, 34}, 48, elliptic.P384()},
	ssh.KeyAlgoECDSA521: {asn1.ObjectIdentifier{1, 3, 132, 0, 35}, 66, elliptic.P521()},
}

func liesECDSA(l *leser, art string) (ssh.Signer, error) {
	kurve, q, d := l.zeichenkette(), l.zeichenkette(), l.mpint()
	if l.err != nil {
		return nil, errors.New("ECDSA-Schlüssel abgeschnitten")
	}
	k := kurven[art]
	if d.Sign() <= 0 || len(d.Bytes()) > k.bytes {
		return nil, errors.New("ECDSA-Schlüssel nicht stimmig")
	}
	// Ältere Dropbear (2022.82 auf dem PFC200, mit dem libtomcrypt von damals)
	// speichern den privaten Wert, wie er gewürfelt wurde: so lang wie die
	// Kurve in ganzen Bytes, bei nistp521 also bis 528 Bit, und nicht auf die
	// Ordnung der Kurve gekürzt. Gerechnet wird ohnehin modulo der Ordnung;
	// dass der gekürzte Wert derselbe Schlüssel ist, belegt unten der Punkt.
	d.Mod(d, k.kurve.Params().N)
	if d.Sign() == 0 {
		return nil, errors.New("ECDSA-Schlüssel nicht stimmig")
	}
	// Über SEC 1 eingelesen: crypto/x509 prüft den Wert und rechnet den
	// öffentlichen Punkt selbst aus.
	der, err := asn1.Marshal(ecPrivat{Version: 1, Privat: d.FillBytes(make([]byte, k.bytes)), Kurve: k.oid})
	if err != nil {
		return nil, err
	}
	var key *ecdsa.PrivateKey
	if key, err = x509.ParseECPrivateKey(der); err != nil {
		return nil, fmt.Errorf("ECDSA-Schlüssel nicht stimmig: %v", err)
	}
	s, err := ssh.NewSignerFromKey(key)
	if err != nil {
		return nil, err
	}
	// Der Punkt in der Datei muss der sein, der zum privaten Wert gehört.
	var soll bytes.Buffer
	for _, t := range [][]byte{[]byte(art), kurve, q} {
		_ = binary.Write(&soll, binary.BigEndian, uint32(len(t)))
		soll.Write(t)
	}
	if !bytes.Equal(soll.Bytes(), s.PublicKey().Marshal()) {
		return nil, errors.New("ECDSA-Schlüssel nicht stimmig: der öffentliche Punkt passt nicht zum privaten Wert")
	}
	return s, nil
}

func liesEd25519(l *leser) (ssh.Signer, error) {
	beide := l.zeichenkette()
	if l.err != nil || len(beide) != 64 {
		return nil, errors.New("Ed25519-Schlüssel abgeschnitten")
	}
	key := ed25519.NewKeyFromSeed(beide[:32])
	if !bytes.Equal(key.Public().(ed25519.PublicKey), beide[32:]) {
		return nil, errors.New("Ed25519-Schlüssel nicht stimmig")
	}
	return ssh.NewSignerFromKey(key)
}

// leser liest die Felder des SSH-Drahtformats; nach dem ersten Fehler liefert
// er nur noch Leeres.
type leser struct {
	b   []byte
	err error
}

func (l *leser) zeichenkette() []byte {
	if l.err != nil {
		return nil
	}
	if len(l.b) < 4 {
		l.err = errors.New("abgeschnitten")
		return nil
	}
	n := binary.BigEndian.Uint32(l.b)
	if uint64(n) > uint64(len(l.b)-4) {
		l.err = errors.New("abgeschnitten")
		return nil
	}
	s := l.b[4 : 4+n]
	l.b = l.b[4+n:]
	return s
}

func (l *leser) mpint() *big.Int {
	s := l.zeichenkette()
	if l.err != nil {
		return new(big.Int)
	}
	if len(s) > 0 && s[0]&0x80 != 0 {
		l.err = errors.New("negative Zahl")
		return new(big.Int)
	}
	return new(big.Int).SetBytes(s)
}
