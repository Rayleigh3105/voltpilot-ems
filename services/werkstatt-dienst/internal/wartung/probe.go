package wartung

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"golang.org/x/crypto/ssh"
)

// Probe ist die Anmeldung des Dienstes an einer Box über den Wartungstunnel
// (Werkstatt-Regel 4 bis 6): als root mit dem SSH-Schlüssel des
// Techniker-Zugangs, den die Box nur im offenen Fenster kennt.
type Probe struct {
	Zugang  Zugang
	SSH     ssh.Signer
	Takt    time.Duration // Abstand der Versuche
	Versuch time.Duration // Frist je TCP-Aufbau und Anmeldung
	// Oeffne baut den Tunnel; nil = Oeffne dieses Pakets (Tests setzen eine Attrappe).
	Oeffne func(Zugang, Server) (Weg, error)
}

// Weg ist ein offener Tunnel.
type Weg interface {
	Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error)
	Schliesse()
}

// Anmeldung ist, was die gelungene Probe belegt.
type Anmeldung struct {
	HostSchluessel string // SHA256:… des Host-Schlüssels, durch den Tunnel gelesen
	Versuche       int
	Dauer          time.Duration
}

// Fingerabdruck ist der des SSH-Schlüssels, mit dem sich der Dienst anmeldet
// (so steht er im Log der Box).
func (p Probe) Fingerabdruck() string { return ssh.FingerprintSHA256(p.SSH.PublicKey()) }

func (p Probe) weg(s Server) (Weg, error) {
	if p.Oeffne != nil {
		return p.Oeffne(p.Zugang, s)
	}
	return Oeffne(p.Zugang, s)
}

func (p Probe) zeiten() (takt, versuch time.Duration) {
	takt, versuch = p.Takt, p.Versuch
	if takt <= 0 {
		takt = 3 * time.Second
	}
	if versuch <= 0 {
		versuch = 10 * time.Second
	}
	return
}

// Anmelden versucht die Anmeldung, bis sie gelingt oder ctx endet: Die Box
// holt den Schlüssel des Zugangs erst, wenn ihr Abholer das Fenster sieht.
func (p Probe) Anmelden(ctx context.Context, s Server, box netip.AddrPort) (Anmeldung, error) {
	takt, versuch := p.zeiten()
	w, err := p.weg(s)
	if err != nil {
		return Anmeldung{}, err
	}
	defer w.Schliesse()
	beginn := time.Now()
	var letzter error
	for n := 1; ; n++ {
		host, err := p.einmal(ctx, w, box, versuch)
		if err == nil {
			return Anmeldung{HostSchluessel: host, Versuche: n, Dauer: time.Since(beginn)}, nil
		}
		letzter = err
		select {
		case <-ctx.Done():
			return Anmeldung{Versuche: n}, fmt.Errorf("Anmeldung über den Tunnel an %s nach %d Versuchen nicht gelungen: %v", box, n, letzter)
		case <-time.After(takt):
		}
	}
}

// einmal: TCP durch den Tunnel, SSH-Anmeldung als root, ein Befehl.
func (p Probe) einmal(ctx context.Context, w Weg, box netip.AddrPort, frist time.Duration) (string, error) {
	vctx, cancel := context.WithTimeout(ctx, frist)
	defer cancel()
	c, err := w.Dial(vctx, box)
	if err != nil {
		return "", err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(frist))
	var host string
	cfg := &ssh.ClientConfig{
		User: "root",
		Auth: []ssh.AuthMethod{ssh.PublicKeys(p.SSH)},
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			host = ssh.FingerprintSHA256(k)
			return nil
		},
		Timeout: frist,
	}
	sc, chans, reqs, err := ssh.NewClientConn(c, box.String(), cfg)
	if err != nil {
		return "", err
	}
	cl := ssh.NewClient(sc, chans, reqs)
	defer cl.Close()
	sess, err := cl.NewSession()
	if err != nil {
		return "", err
	}
	defer sess.Close()
	if out, err := sess.Output("echo vp-werkstatt-probe"); err != nil || string(out) != "vp-werkstatt-probe\n" {
		return "", fmt.Errorf("Befehl über den Tunnel: %q %v", out, err)
	}
	return host, nil
}

// ErrNochErreichbar heißt: nach dem Ende des Fensters ging der TCP-Aufbau noch durch.
var ErrNochErreichbar = errors.New("nach dem Ende des Fensters ist die Box über den Tunnel noch erreichbar")

// NachEnde ist der neue Versuch nach dem Schließen des Fensters (Werkstatt-Regel
// 6): Er muss mit einer Zeitüberschreitung enden, „Connection timed out“. Der
// Tunnel-Dienst setzt das Ende erst beim nächsten Abruf des Soll-Stands um;
// solange der Aufbau noch durchgeht, versucht es die Probe weiter, bis ctx endet.
func (p Probe) NachEnde(ctx context.Context, s Server, box netip.AddrPort) (string, error) {
	takt, versuch := p.zeiten()
	w, err := p.weg(s)
	if err != nil {
		return "", err
	}
	defer w.Schliesse()
	for n := 1; ; n++ {
		vctx, cancel := context.WithTimeout(ctx, versuch)
		c, err := w.Dial(vctx, box)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return "", fmt.Errorf("%w (Frist der Probe vorbei)", ErrNochErreichbar)
			}
			if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
				return fmt.Sprintf("Connection timed out (TCP-Aufbau an %s nach %s ohne Antwort, Versuch %d)", box, versuch, n), nil
			}
			return "", fmt.Errorf("neuer Versuch nach dem Ende: %v (erwartet: Zeitüberschreitung)", err)
		}
		_ = c.Close()
		select {
		case <-ctx.Done():
			return "", ErrNochErreichbar
		case <-time.After(takt):
		}
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
