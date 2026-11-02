package wartung

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestNeueSchluessel(t *testing.T) {
	dir := t.TempDir()
	wg, sp, err := NeueSchluessel(dir, "techniker-wireguard", "techniker-ssh")
	if err != nil {
		t.Fatal(err)
	}
	if len(wg) != 44 || !strings.HasPrefix(sp, "ssh-rsa ") || len(strings.Fields(sp)) != 2 {
		t.Fatalf("%q %q", wg, sp)
	}
	for _, n := range []string{"techniker-wireguard", "techniker-ssh"} {
		i, err := os.Stat(filepath.Join(dir, n))
		if err != nil || i.Mode().Perm() != 0o600 {
			t.Fatalf("%s: %v %v", n, i, err)
		}
	}
	b, _ := os.ReadFile(filepath.Join(dir, "techniker-ssh"))
	s, err := ssh.ParsePrivateKey(b)
	if err != nil || s.PublicKey().Type() != ssh.KeyAlgoRSA {
		t.Fatalf("SSH-Schlüssel: %v", err)
	}
	if _, _, err := NeueSchluessel(dir, "techniker-wireguard", "techniker-ssh"); err == nil {
		t.Fatal("überschrieben")
	}
}
