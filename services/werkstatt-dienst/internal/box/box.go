// Package box spricht mit der Box am Werkstatt-Anschluss: SSH als root, durch
// die Werkbank-Brücke (Weg), nie direkt.
//
// Anmeldung: ohne Passwort (Mango ab Werk, frisches OpenWrt: der Client
// versucht erst "none", dann ein leeres Passwort) oder mit dem Passwort, das
// der Dienst gesetzt hat. Den Host-Schlüssel prüft eine Regel des Laufs:
// Nach dem Aufspielen von OpenWrt gilt für den ganzen Lauf genau der
// Schlüssel, den die Box dann zeigt.
package box

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Weg öffnet Verbindungen zu den Werkstatt-Adressen (die Brücke).
type Weg interface {
	Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error)
}

// HostRegel prüft den Host-Schlüssel der Box; nil nimmt jeden an.
type HostRegel func(ssh.PublicKey) error

// GenauDieser lässt nur den Schlüssel mit diesem Fingerabdruck zu.
func GenauDieser(fingerabdruck string) HostRegel {
	return func(k ssh.PublicKey) error {
		if ist := ssh.FingerprintSHA256(k); ist != fingerabdruck {
			return fmt.Errorf("Host-Schlüssel der Box ist %s, in diesem Lauf gilt %s: nicht verbunden", ist, fingerabdruck)
		}
		return nil
	}
}

// Verbindung ist eine SSH-Verbindung zur Box.
type Verbindung struct {
	Ziel netip.AddrPort
	cl   *ssh.Client
	host ssh.PublicKey
	mu   sync.Mutex
}

// Abgewiesen: Die Box hat die Anmeldung nicht angenommen. Host ist der
// Fingerabdruck ihres Host-Schlüssels aus dem Handshake davor (leer, wenn die
// Regel des Laufs ihn schon verworfen hat): Damit lässt sich eine Box
// wiedererkennen, ohne dass man hineinkommt.
type Abgewiesen struct {
	Ziel netip.AddrPort
	Host string
}

func (a Abgewiesen) Error() string { return fmt.Sprintf("%s nimmt die Anmeldung nicht an", a.Ziel) }

// Verbinde meldet sich als root an. pw leer: ohne Passwort.
func Verbinde(ctx context.Context, weg Weg, ziel netip.AddrPort, pw geheim.Geheim, regel HostRegel, zeit time.Duration) (*Verbindung, error) {
	if zeit <= 0 {
		zeit = 20 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, zeit)
	defer cancel()
	conn, err := weg.Dial(ctx, ziel)
	if err != nil {
		return nil, err
	}
	var host ssh.PublicKey
	cfg := &ssh.ClientConfig{
		User: "root",
		Auth: []ssh.AuthMethod{ssh.Password(pw.Offenbaren())},
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			host = k
			if regel != nil {
				return regel(k)
			}
			return nil
		},
		Timeout: zeit,
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	sc, chans, reqs, err := ssh.NewClientConn(conn, ziel.String(), cfg)
	if err != nil {
		_ = conn.Close()
		if strings.Contains(err.Error(), "unable to authenticate") {
			ab := Abgewiesen{Ziel: ziel}
			if host != nil {
				ab.Host = ssh.FingerprintSHA256(host)
			}
			return nil, ab
		}
		return nil, fmt.Errorf("SSH zu %s: %s", ziel, geheim.Schwaerze(err.Error()))
	}
	_ = conn.SetDeadline(time.Time{})
	return &Verbindung{Ziel: ziel, cl: ssh.NewClient(sc, chans, reqs), host: host}, nil
}

// HostFingerabdruck ist der SHA256-Fingerabdruck des Host-Schlüssels, wie
// ssh-keygen -lf ihn zeigt.
func (v *Verbindung) HostFingerabdruck() string { return ssh.FingerprintSHA256(v.host) }

// HostArt ist die Art des Host-Schlüssels (ssh-rsa, ssh-ed25519, …).
func (v *Verbindung) HostArt() string { return v.host.Type() }

// Client gibt die SSH-Verbindung (für die Durchreiche der Skripte).
func (v *Verbindung) Client() *ssh.Client { return v.cl }

// Schliesse schließt die Verbindung.
func (v *Verbindung) Schliesse() {
	if v != nil && v.cl != nil {
		_ = v.cl.Close()
	}
}

// Ergebnis eines Befehls auf der Box.
type Ergebnis struct {
	Aus, Fehl string
	Code      int
}

// Text ist Ausgabe und Fehlerausgabe zusammen, gekürzt.
func (e Ergebnis) Text() string {
	t := strings.TrimSpace(e.Aus)
	if f := strings.TrimSpace(e.Fehl); f != "" {
		if t != "" {
			t += "\n"
		}
		t += f
	}
	return t
}

// Abgerissen: Die Verbindung brach ab, bevor der Befehl ein Ergebnis hatte
// (sysupgrade, reboot).
var Abgerissen = errors.New("Verbindung zur Box abgerissen")

// Fuehre führt einen Befehl aus. Ein Ausgang ungleich 0 ist kein Fehler,
// sondern steht im Ergebnis; Fehler heißt: kein Ergebnis.
func (v *Verbindung) Fuehre(ctx context.Context, befehl string, ein io.Reader) (Ergebnis, error) {
	// Schon das Öffnen der Sitzung wartet auf die Box, bei still abgerissenem
	// Weg (keine Antwort, kein RST) ohne Ende. Darum gilt ctx auch hier: Läuft
	// es ab, schließt Fuehre die Verbindung, nur das beendet das Warten. Sonst
	// hängt ein Schritt weit über seine Frist (Probe-Lauf 473: internet_weg
	// 24 Minuten statt 3).
	type geoeffnet struct {
		s   *ssh.Session
		err error
	}
	auf := make(chan geoeffnet, 1)
	go func() {
		s, err := v.cl.NewSession()
		auf <- geoeffnet{s, err}
	}()
	var s *ssh.Session
	select {
	case g := <-auf:
		if g.err != nil {
			return Ergebnis{}, fmt.Errorf("%w: %v", Abgerissen, g.err)
		}
		s = g.s
	case <-ctx.Done():
		_ = v.cl.Close()
		return Ergebnis{}, ctx.Err()
	}
	defer s.Close()
	var err error
	var o, e bytes.Buffer
	s.Stdout, s.Stderr = &o, &e
	if ein != nil {
		s.Stdin = ein
	}
	fertig := make(chan error, 1)
	go func() { fertig <- s.Run(befehl) }()
	select {
	case err = <-fertig:
	case <-ctx.Done():
		_ = s.Close()
		return Ergebnis{Aus: o.String(), Fehl: e.String()}, ctx.Err()
	}
	erg := Ergebnis{Aus: o.String(), Fehl: e.String()}
	var ee *ssh.ExitError
	var em *ssh.ExitMissingError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		erg.Code = ee.ExitStatus()
	case errors.As(err, &em), errors.Is(err, io.EOF):
		return erg, Abgerissen
	default:
		return erg, fmt.Errorf("%w: %v", Abgerissen, err)
	}
	return erg, nil
}

// Werte führt einen Befehl aus, der Zeilen schluessel=wert ausgibt, und gibt
// sie als Abbildung zurück.
func (v *Verbindung) Werte(ctx context.Context, befehl string) (map[string]string, Ergebnis, error) {
	erg, err := v.Fuehre(ctx, befehl, nil)
	if err != nil {
		return nil, erg, err
	}
	m := map[string]string{}
	for _, z := range strings.Split(erg.Aus, "\n") {
		if k, w, ok := strings.Cut(strings.TrimSpace(z), "="); ok {
			m[k] = strings.TrimSpace(w)
		}
	}
	return m, erg, nil
}
