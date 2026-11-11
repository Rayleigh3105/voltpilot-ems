package wartung

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/ssh"
)

// NeueSchluessel erzeugt die beiden Schlüssel des Techniker-Zugangs
// „Werkstatt-Dienst“ in dir: techniker-wireguard (Base64) und techniker-ssh
// (RSA 3072, OpenSSH-Format; die Schlüsselausgabe an die Box kennt nur
// ssh-rsa). Vorhandene Dateien überschreibt sie nie. Zurück kommen nur die
// öffentlichen Teile, die der Betreiber im Portal beim Zugang einträgt.
func NeueSchluessel(dir, wgDatei, sshDatei string) (wgPub, sshPub string, err error) {
	for _, n := range []string{wgDatei, sshDatei} {
		if _, err := os.Stat(filepath.Join(dir, n)); err == nil {
			return "", "", fmt.Errorf("%s gibt es schon; er wird nicht überschrieben", n)
		}
	}
	priv := make([]byte, 32)
	if _, err := rand.Read(priv); err != nil {
		return "", "", err
	}
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		return "", "", err
	}
	rk, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		return "", "", err
	}
	blk, err := ssh.MarshalPrivateKey(rk, "werkstatt-dienst")
	if err != nil {
		return "", "", err
	}
	sp, err := ssh.NewPublicKey(&rk.PublicKey)
	if err != nil {
		return "", "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	if err := schreibeNeu(filepath.Join(dir, wgDatei), []byte(base64.StdEncoding.EncodeToString(priv)+"\n")); err != nil {
		return "", "", err
	}
	if err := schreibeNeu(filepath.Join(dir, sshDatei), pem.EncodeToMemory(blk)); err != nil {
		return "", "", err
	}
	// Normalform ohne Kommentar: so führt das Portal den Schlüssel, und nur so
	// nimmt ihn der Tunnel-Dienst für die Schlüsselausgabe an.
	return base64.StdEncoding.EncodeToString(pub), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sp))), nil
}

func schreibeNeu(pfad string, inhalt []byte) error {
	f, err := os.OpenFile(pfad, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%s gibt es schon", filepath.Base(pfad))
		}
		return err
	}
	if _, err := f.Write(inhalt); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
