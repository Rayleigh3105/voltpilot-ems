package attrappe

import (
	"bytes"
	"context"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// TunnelAdressePFC ist die Adresse des PFC200 im Wartungstunnel (Attrappe).
const TunnelAdressePFC = "10.10.16.7"

// ProgrammPFC200 steht für das Programm einer Edge-Industrie-Fassung.
func ProgrammPFC200(fassung string) []byte {
	return []byte("#!/bin/sh\n# vp-edge-industrie " + fassung + "\n")
}

// NeuerPFC200ImFeld ist ein PFC200 nach der Werkbank, ohne Kundenkonto: Edge
// Industrie in der genannten Fassung eingerichtet und gestartet, der
// Wartungstunnel steht, und der Schlüssel des Technikers gilt (am echten
// Gerät hält ihn vp-wartung für die Dauer des Fensters im Speicher).
// Eingerichtet wird mit denselben Befehlen wie im Lauf an der Werkbank.
func NeuerPFC200ImFeld(t testing.TB, ref, fassung string, seq int64, techniker ssh.PublicKey) *PFC200 {
	t.Helper()
	p := NeuerPFC200(t)
	p.Ref, p.Version, p.BestaetigterStand = ref, fassung, seq
	p.imFeld = true
	p.SchreibeDatei("/root/.ssh/authorized_keys", string(ssh.MarshalAuthorizedKey(techniker)))
	p.Lokal(t, "vp-attrappe install "+fassung+" "+strconv.FormatInt(seq, 10), ProgrammPFC200(fassung))
	p.Lokal(t, "vp-attrappe key", []byte("vp-wartung"))
	p.Lokal(t, "vp-attrappe tunnel "+TunnelAdressePFC, nil)
	p.Lokal(t, "/etc/init.d/vp-edge-industrie start", nil)
	return p
}

// Lokal führt einen Befehl im Sandkasten aus, als säße man am Gerät.
func (p *PFC200) Lokal(t testing.TB, befehl string, eingabe []byte) string {
	t.Helper()
	cmd := p.befehl(befehl)
	cmd.Stdin = bytes.NewReader(eingabe)
	aus, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s: %v\n%s", befehl, err, aus)
	}
	return string(aus)
}

// Meldung ist, was die Plattform von der Box hört: die Fassung des laufenden
// Programms, seit wann es läuft, und ob auf der Box ein Zertifikat liegt.
func (p *PFC200) Meldung() (deviceInfo string, start time.Time, zertifikat bool) {
	p.gleicheAb()
	zertifikat = exists(filepath.Join(p.w, "home/voltpilot/daten/identity/device.crt"))
	st, err := os.Stat(filepath.Join(p.z, "edge.laeuft"))
	if err != nil {
		return "", time.Time{}, zertifikat
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return "vp-edge-core " + p.Version, st.ModTime(), zertifikat
}

// NeuGestartet: Das Gerät wurde neu gestartet (reboot) oder ist dabei - das
// darf ein Fernlauf nie.
func (p *PFC200) NeuGestartet() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.neustarts > 0 || exists(filepath.Join(p.z, "neustart"))
}

// Weg ist ein Tunnel-Weg (wartung.Weg) zum PFC200: nur seine Tunnel-Adresse
// an Port 2222 ist darin erreichbar.
func (p *PFC200) Weg() *PFCWeg { return &PFCWeg{p: p} }

// PFCWeg ist der Wartungstunnel zur Attrappe.
type PFCWeg struct {
	p  *PFC200
	zu bool
}

func (w *PFCWeg) Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error) {
	if w.zu {
		return nil, fmt.Errorf("Tunnel geschlossen")
	}
	if ziel != netip.AddrPortFrom(netip.MustParseAddr(TunnelAdressePFC), 2222) {
		return nil, fmt.Errorf("%s: im Tunnel nicht erreichbar", ziel)
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", w.p.sshLn.Addr().String())
}

func (w *PFCWeg) Schliesse() { w.zu = true }
