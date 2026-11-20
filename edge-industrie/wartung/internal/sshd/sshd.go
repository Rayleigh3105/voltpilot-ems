// Package sshd ist der SSH-Server der Box im Wartungstunnel (Port 2222). Er
// lauscht nur auf einem Lauscher, den der Tunnel ihm gibt, also auf keiner
// Netzbuchse.
//
// Regeln (docs/fernwartung.md):
//   - Anmeldung nur als root und nur mit einem Schlüssel, den der Bestand
//     jetzt kennt: ein dauerhafter der Box oder ein Fenster-Schlüssel.
//   - Jede Verbindung kennt den Schlüssel, mit dem sie begann. Gilt ein
//     Fenster-Schlüssel nicht mehr (gestrichen, Frist), endet jede Verbindung,
//     die mit genau ihm begann; die mit einem dauerhaften oder einem anderen,
//     noch gültigen Fenster-Schlüssel bleiben.
//   - Beenden heißt: wie ein Verbindungsabbruch, nur sofort. Eine Shell am
//     Terminal bekommt SIGHUP; ein Befehl ohne Terminal scheitert an seiner
//     nächsten Ausgabe oder läuft zu Ende. Niemand wird abgeschossen.
//   - Antwortet die Gegenseite auf drei Lebenszeichen nicht, endet die
//     Verbindung.
package sshd

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/bestand"
)

// Pruefer ist, was der Server vom Bestand der Schlüssel braucht.
type Pruefer interface {
	Pruefe(ssh.PublicKey) (bestand.Urteil, bool)
	FensterGilt(fingerabdruck string) bool
}

// Gruende, mit denen der Server eine Verbindung beendet.
const (
	GrundGestrichen    = "ihr Fenster-Schluessel ist gestrichen"
	GrundLebenszeichen = "die Gegenseite antwortet nicht mehr (Lebenszeichen)"
	GrundProgrammEnde  = "das Tunnel-Programm endet"
	grundGegenseite    = "die Gegenseite hat getrennt"
)

// Server ist der SSH-Server im Tunnel.
type Server struct {
	Hostkeys []ssh.Signer
	Bestand  Pruefer
	// Ereignis bekommt Anmeldung und Ende jeder Sitzung (Ereignisliste und
	// Protokoll); nie einen Schlüssel.
	Ereignis func(string)
	// Geaendert wird gerufen, wenn eine Verbindung dazukam oder ging (nil: nichts).
	Geaendert func()
	Log       *slog.Logger
	// Shell und Heim von root (aus /etc/passwd des Geräts).
	Shell, Heim string
	// Lokal ist die Tunnel-Adresse der Box mit Port, für SSH_CONNECTION.
	Lokal string
	// Lebenszeichen: Abstand der Anfragen an die Gegenseite (0: 300 s, wie
	// dropbear -K 300 auf der Mango); nach drei ohne Antwort endet die Verbindung.
	Lebenszeichen time.Duration
	// Anmeldefrist: so lange hat eine neue Verbindung für die Anmeldung (0: 30 s).
	Anmeldefrist time.Duration
	// MaxVerbindungen zugleich, die Anmeldung eingeschlossen (0: 8).
	MaxVerbindungen int

	einmal  sync.Once
	cfg     *ssh.ServerConfig
	plaetze chan struct{}

	mu    sync.Mutex
	offen map[*verbindung]struct{}
}

type verbindung struct {
	srv    *Server
	sc     *ssh.ServerConn
	urteil bestand.Urteil
	von    string

	mu    sync.Mutex
	grund string
}

const (
	extArt    = "vp-art"
	extZugang = "vp-zugang"
	extFP     = "vp-fingerabdruck"
)

func (s *Server) bereite() {
	s.einmal.Do(func() {
		if s.Log == nil {
			s.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
		}
		if s.Ereignis == nil {
			s.Ereignis = func(string) {}
		}
		if s.Lebenszeichen <= 0 {
			s.Lebenszeichen = 300 * time.Second
		}
		if s.Anmeldefrist <= 0 {
			s.Anmeldefrist = 30 * time.Second
		}
		if s.MaxVerbindungen <= 0 {
			s.MaxVerbindungen = 8
		}
		s.plaetze = make(chan struct{}, s.MaxVerbindungen)
		s.offen = map[*verbindung]struct{}{}
		s.cfg = &ssh.ServerConfig{
			ServerVersion: "SSH-2.0-vp-wartung",
			PublicKeyCallback: func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
				if c.User() != "root" {
					return nil, errors.New("nur root")
				}
				u, ok := s.Bestand.Pruefe(key)
				if !ok {
					return nil, errors.New("unbekannter Schlüssel")
				}
				return &ssh.Permissions{Extensions: map[string]string{
					extArt: string(u.Art), extZugang: u.Zugang, extFP: u.Fingerabdruck,
				}}, nil
			},
		}
		for _, k := range s.Hostkeys {
			s.cfg.AddHostKey(k)
		}
	})
}

// Bediene nimmt Verbindungen an, bis der Lauscher schließt.
func (s *Server) Bediene(ln net.Listener) error {
	s.bereite()
	if len(s.Hostkeys) == 0 {
		return errors.New("kein Host-Schlüssel")
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		select {
		case s.plaetze <- struct{}{}:
			go func() {
				defer func() { <-s.plaetze }()
				s.bediene(c)
			}()
		default:
			s.Log.Warn("Verbindung abgewiesen: zu viele zugleich", "von", c.RemoteAddr().String())
			_ = c.Close()
		}
	}
}

func (s *Server) bediene(c net.Conn) {
	defer c.Close()
	von := c.RemoteAddr().String()
	_ = c.SetDeadline(time.Now().Add(s.Anmeldefrist))
	sc, chans, reqs, err := ssh.NewServerConn(c, s.cfg)
	if err != nil {
		if !errors.Is(err, io.EOF) {
			s.Log.Info("Anmeldung abgewiesen", "von", von, "grund", err.Error())
		}
		return
	}
	_ = c.SetDeadline(time.Time{})
	ext := sc.Permissions.Extensions
	v := &verbindung{srv: s, sc: sc, von: von, urteil: bestand.Urteil{
		Art: bestand.Art(ext[extArt]), Zugang: ext[extZugang], Fingerabdruck: ext[extFP],
	}}
	s.mu.Lock()
	s.offen[v] = struct{}{}
	s.mu.Unlock()
	s.geaendert()
	defer func() {
		s.mu.Lock()
		delete(s.offen, v)
		s.mu.Unlock()
		s.geaendert()
	}()
	// Zwischen Prüfung und Eintrag kann der Schlüssel gestrichen worden sein.
	if v.urteil.Art == bestand.Fenster && !s.Bestand.FensterGilt(v.urteil.Fingerabdruck) {
		v.beende(GrundGestrichen)
	}
	s.Ereignis("Anmeldung: Schluessel " + v.urteil.Fingerabdruck + " (" + v.schluesselText() + ") von " + von)

	fertig := make(chan struct{})
	defer close(fertig)
	go ssh.DiscardRequests(reqs)
	go v.lebenszeichen(fertig)
	var sitzungen sync.WaitGroup
	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			sitzungen.Add(1)
			go func() {
				defer sitzungen.Done()
				v.sitzung(nc)
			}()
		case "direct-tcpip":
			go v.weiterleitung(nc)
		default:
			_ = nc.Reject(ssh.UnknownChannelType, "nicht angeboten")
		}
	}
	_ = sc.Close()
	sitzungen.Wait()
	v.mu.Lock()
	grund := v.grund
	v.mu.Unlock()
	if grund == "" {
		grund = grundGegenseite
	}
	s.Ereignis("Sitzung beendet (" + v.schluesselText() + ", von " + von + "): " + grund)
}

func (s *Server) geaendert() {
	if s.Geaendert != nil {
		s.Geaendert()
	}
}

func (v *verbindung) schluesselText() string {
	if v.urteil.Art == bestand.Fenster {
		return "Fenster-Schluessel, Zugang " + v.urteil.Zugang
	}
	return "dauerhafter Schluessel"
}

// beende schließt die Verbindung; der erste Grund gilt.
func (v *verbindung) beende(grund string) {
	v.mu.Lock()
	if v.grund == "" {
		v.grund = grund
	}
	v.mu.Unlock()
	_ = v.sc.Close()
}

func (v *verbindung) lebenszeichen(fertig <-chan struct{}) {
	t := time.NewTicker(v.srv.Lebenszeichen)
	defer t.Stop()
	antwort := make(chan struct{}, 4)
	offen := 0
	for {
		select {
		case <-fertig:
			return
		case <-antwort:
			offen = 0
		case <-t.C:
			if offen >= 3 {
				v.beende(GrundLebenszeichen)
				return
			}
			offen++
			go func() {
				if _, _, err := v.sc.SendRequest("keepalive@openssh.com", true, nil); err == nil {
					select {
					case antwort <- struct{}{}:
					default:
					}
				}
			}()
		}
	}
}

// BeendeUngueltige beendet jede Verbindung, deren Fenster-Schlüssel nicht mehr
// gilt, und gibt ihre Zahl zurück. Aufgerufen bei jedem Lauf, nicht nur im
// Augenblick des Streichens.
func (s *Server) BeendeUngueltige() int {
	s.bereite()
	s.mu.Lock()
	var weg []*verbindung
	for v := range s.offen {
		if v.urteil.Art == bestand.Fenster && !s.Bestand.FensterGilt(v.urteil.Fingerabdruck) {
			weg = append(weg, v)
		}
	}
	s.mu.Unlock()
	for _, v := range weg {
		v.beende(GrundGestrichen)
	}
	return len(weg)
}

// Sitzungen zählt die offenen Verbindungen nach der Art ihres Schlüssels.
func (s *Server) Sitzungen() (dauerhaft, fenster int) {
	s.bereite()
	s.mu.Lock()
	defer s.mu.Unlock()
	for v := range s.offen {
		if v.urteil.Art == bestand.Fenster {
			fenster++
		} else {
			dauerhaft++
		}
	}
	return
}

// Schliesse beendet alle Verbindungen (das Programm endet).
func (s *Server) Schliesse() {
	s.bereite()
	s.mu.Lock()
	var alle []*verbindung
	for v := range s.offen {
		alle = append(alle, v)
	}
	s.mu.Unlock()
	for _, v := range alle {
		v.beende(GrundProgrammEnde)
	}
}

// weiterleitung bedient "ssh -L": eine Verbindung von der Box aus, wie sie
// root auf der Box selbst öffnen könnte. Sie gehört zur Verbindung und endet
// mit ihr.
func (v *verbindung) weiterleitung(nc ssh.NewChannel) {
	var ziel struct {
		Host    string
		Port    uint32
		VonHost string
		VonPort uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &ziel); err != nil || ziel.Port > 65535 {
		_ = nc.Reject(ssh.ConnectionFailed, "Ziel unlesbar")
		return
	}
	c, err := net.DialTimeout("tcp", net.JoinHostPort(ziel.Host, strconv.Itoa(int(ziel.Port))), 10*time.Second)
	if err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, fmt.Sprintf("%s:%d nicht erreichbar", ziel.Host, ziel.Port))
		return
	}
	defer c.Close()
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	go ssh.DiscardRequests(reqs)
	ende := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(c, ch); ende <- struct{}{} }()
	go func() { _, _ = io.Copy(ch, c); ende <- struct{}{} }()
	<-ende
}
