package box

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

type direkt struct{}

func (direkt) Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "tcp", ziel.String())
}

// stummeBox nimmt die Anmeldung an und beantwortet danach keine Anfrage mehr:
// wie eine Box, deren Weg nach dem Handschlag still abreißt (kein RST).
func stummeBox(t *testing.T) netip.AddrPort {
	t.Helper()
	_, hk, _ := ed25519.GenerateKey(rand.Reader)
	host, _ := ssh.NewSignerFromKey(hk)
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(host)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		t.Cleanup(func() { _ = c.Close() })
		// Handschlag ja, danach keine Kanäle annehmen und nichts mehr lesen.
		_, _, _, _ = ssh.NewServerConn(c, cfg)
	}()
	return netip.MustParseAddrPort(ln.Addr().String())
}

// Hängt die Box nach der Anmeldung, endet Fuehre mit der Frist des Aufrufers,
// auch wenn noch keine Sitzung offen ist.
func TestFuehreEndetMitFristAuchOhneSitzung(t *testing.T) {
	ziel := stummeBox(t)
	v, err := Verbinde(context.Background(), direkt{}, ziel, geheim.Neu(""), nil, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Schliesse()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	ergebnis := make(chan error, 1)
	go func() {
		_, err := v.Fuehre(ctx, "true", nil)
		ergebnis <- err
	}()
	select {
	case err := <-ergebnis:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Fehler %v, erwartet: Frist überschritten", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Fuehre hängt über die Frist hinaus")
	}
}
