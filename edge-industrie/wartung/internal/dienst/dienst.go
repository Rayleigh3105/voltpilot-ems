// Package dienst ist das laufende Tunnel-Programm der Box: Es öffnet den
// Wartungstunnel, lässt darin SSH (2222) und die Durchreiche zur Web-App
// (8484) lauschen, holt die Fenster-Schlüssel ab, streicht Verfallenes,
// beendet die Sitzungen gestrichener Schlüssel und führt die Ereignisliste.
//
// Es gehört zum Betriebssystem der Box, NICHT zu vp-edge-industrie: Ein Update,
// ein Absturz oder ein falsches Programm dort berühren die Anmeldung im
// Wartungstunnel nicht, und kein Update aus dem Portal tauscht dieses
// Programm (es kommt durch Werkstatt oder Fernlauf).
package dienst

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/abholer"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/bestand"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/ereignisse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/hostkey"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/konfig"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/sshd"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/stand"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/tunnel"
)

// Ports im Tunnel, wie auf der Mango.
const (
	PortSSH = 2222
	PortWeb = 8484
)

// Ohne Handshake seit so langer Zeit löst der Dienst den Namen des
// Wartungsservers neu auf (WireGuard selbst tut das nie), höchstens so oft.
const (
	handshakeAlt     = 3 * time.Minute
	aufloesenAbstand = time.Minute
)

// Optionen sind, was ein Lauf neben den Einstellungen braucht; der Nullwert
// ist der Betrieb auf dem Gerät.
type Optionen struct {
	Fassung string
	Log     *slog.Logger
	// Aufloesen macht aus name:port eine Adresse ip:port (nil: DNS des Geräts).
	Aufloesen func(ctx context.Context, endpunkt string) (string, error)
	// Shell und Heim von root (leer: aus /etc/passwd, sonst /bin/sh und /root).
	Shell, Heim string
	Takt        time.Duration // Verfallenes streichen, Stand schreiben (0: 1 s)
	// Für Tests kürzer; 0 sind die Vorgaben der Pakete.
	Warte, Vorlauf, Pause, Lebenszeichen time.Duration
}

// Dienst ist das laufende Programm.
type Dienst struct {
	k   konfig.Konfig
	opt Optionen
	log *slog.Logger

	tunnel   *tunnel.Tunnel
	bestand  *bestand.Bestand
	liste    *ereignisse.Liste
	ssh      *sshd.Server
	abholer  *abholer.Abholer
	lnSSH    net.Listener
	lnWeb    net.Listener
	hostkeys []string
	beginn   time.Time

	mu           sync.Mutex
	fensterText  string    // zuletzt gemeldete Zugänge
	aufgeloest   time.Time // letzter Versuch, den Servernamen aufzulösen
	loestAuf     bool
	standMu      sync.Mutex // einer schreibt den Stand zur Zeit
	standZuletzt time.Time
	standInhalt  string
	gemeldet     map[string]time.Time // wann eine Störung zuletzt im Protokoll stand
}

// Dieselbe Störung steht höchstens so oft im Protokoll: Ohne Internet meldet
// WireGuard sie alle fünf Sekunden, und das Protokoll des Geräts liegt im Flash.
const stoerungAbstand = 30 * time.Minute

// selten schreibt eine Störung ins Protokoll, dieselbe aber nur alle
// stoerungAbstand wieder.
func (d *Dienst) selten(text string) {
	d.mu.Lock()
	if d.gemeldet == nil {
		d.gemeldet = map[string]time.Time{}
	}
	zuletzt, bekannt := d.gemeldet[text]
	schreiben := !bekannt || time.Since(zuletzt) >= stoerungAbstand
	if schreiben {
		if len(d.gemeldet) >= 64 {
			// Nie mehr merken als eine Handvoll: lieber einmal doppelt melden.
			d.gemeldet = map[string]time.Time{}
		}
		d.gemeldet[text] = time.Now()
	}
	d.mu.Unlock()
	if schreiben {
		d.log.Warn(text)
	}
}

// Hostkeys liest die Host-Schlüssel des Geräts. Dateien, die es nicht gibt,
// und DSA-Schlüssel werden übergangen. Eine Datei, die es gibt, die sich aber
// nicht lesen lässt, nennt unlesbar: Der Server zeigte sonst weniger
// Schlüssel als der Dropbear des Geräts, und "auf zwei Wegen gleich" hinge an
// der Wahl des Clients. Ohne einen einzigen Schlüssel ist es ein Fehler: Eine
// eigene, zweite Identität erzeugt das Programm nie.
func Hostkeys(pfade []string) (keys []ssh.Signer, unlesbar []string, err error) {
	for _, p := range pfade {
		s, lerr := hostkey.Lies(p)
		switch {
		case lerr == nil:
			keys = append(keys, s)
		case os.IsNotExist(lerr), errors.Is(lerr, hostkey.ErrDSA):
		default:
			unlesbar = append(unlesbar, lerr.Error())
		}
	}
	if len(keys) == 0 {
		return nil, unlesbar, fmt.Errorf("kein Host-Schlüssel des Geräts lesbar (%s) %s", strings.Join(pfade, ", "), strings.Join(unlesbar, "; "))
	}
	return keys, unlesbar, nil
}

// WGSchluessel liest den privaten WireGuard-Schlüssel der Box. Eine Datei,
// die andere als ihr Besitzer lesen können, nimmt das Programm nicht.
func WGSchluessel(pfad string) (string, error) {
	st, err := os.Stat(pfad)
	if err != nil {
		return "", fmt.Errorf("Schlüssel der Box fehlt (%s): erst \"vp-wartung schluessel\"", pfad)
	}
	if st.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("%s ist für andere lesbar (%04o): nicht verwendet", pfad, st.Mode().Perm())
	}
	daten, err := os.ReadFile(pfad)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(daten)), nil
}

// Pruefe sagt, ob der Dienst mit diesen Einstellungen starten würde, ohne den
// Tunnel zu öffnen: Einstellungen vollständig, beide WireGuard-Schlüssel in
// Form, ein Host-Schlüssel des Geräts lesbar und keiner unlesbar.
func Pruefe(k konfig.Konfig) error {
	if err := k.Pruefe(); err != nil {
		return err
	}
	priv, err := WGSchluessel(k.WGSchluessel)
	if err != nil {
		return err
	}
	if _, err := tunnel.SchluesselHex(priv); err != nil {
		return fmt.Errorf("Schlüssel der Box (%s): %v", k.WGSchluessel, err)
	}
	if _, err := tunnel.SchluesselHex(k.ServerPub); err != nil {
		return fmt.Errorf("server_pubkey: %v", err)
	}
	_, unlesbar, err := Hostkeys(k.Hostkeys)
	if err != nil {
		return err
	}
	if len(unlesbar) > 0 {
		return fmt.Errorf("Host-Schlüssel des Geräts nicht lesbar: %s", strings.Join(unlesbar, "; "))
	}
	return nil
}

// Starte öffnet den Tunnel und alles, was darin lauscht.
func Starte(k konfig.Konfig, opt Optionen) (*Dienst, error) {
	if err := k.Pruefe(); err != nil {
		return nil, err
	}
	if opt.Log == nil {
		opt.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opt.Takt <= 0 {
		opt.Takt = time.Second
	}
	priv, err := WGSchluessel(k.WGSchluessel)
	if err != nil {
		return nil, err
	}
	keys, unlesbar, err := Hostkeys(k.Hostkeys)
	if err != nil {
		return nil, err
	}
	d := &Dienst{k: k, opt: opt, log: opt.Log, beginn: time.Now()}
	for _, u := range unlesbar {
		d.log.Warn("Host-Schlüssel des Geräts nicht lesbar, der Server im Tunnel zeigt ihn nicht: " + u)
	}
	for _, s := range keys {
		d.hostkeys = append(d.hostkeys, s.PublicKey().Type()+" "+ssh.FingerprintSHA256(s.PublicKey()))
	}
	// Erst der Endpunkt, dann der Tunnel. Gibt es beim Start noch kein DNS,
	// reicht der Takt ihn nach.
	aufloesen := opt.Aufloesen
	if aufloesen == nil {
		aufloesen = Aufloesen
	}
	actx, ende := context.WithTimeout(context.Background(), 5*time.Second)
	endpunkt, aerr := aufloesen(actx, k.Endpunkt)
	ende()
	if aerr != nil {
		d.selten("Wartungsserver " + k.Endpunkt + " nicht auflösbar: " + aerr.Error())
		endpunkt = ""
	}
	d.aufgeloest = time.Now()
	d.tunnel, err = tunnel.Oeffne(tunnel.Konfig{
		Privat: priv, Adresse: k.Adresse, ServerPub: k.ServerPub, Netze: k.Netze, Endpunkt: endpunkt,
		Fehler: func(m string) { d.selten("WireGuard: " + m) },
	})
	if err != nil {
		return nil, err
	}
	if d.lnSSH, err = d.tunnel.Lausche(PortSSH); err != nil {
		d.tunnel.Schliesse()
		return nil, fmt.Errorf("SSH im Tunnel: %v", err)
	}
	if k.Web {
		if d.lnWeb, err = d.tunnel.Lausche(PortWeb); err != nil {
			d.tunnel.Schliesse()
			return nil, fmt.Errorf("Web-App im Tunnel: %v", err)
		}
	}
	d.bestand = bestand.Neu(k.Dauerhaft, nil)
	d.liste = &ereignisse.Liste{Pfad: k.Ereignisse}
	shell, heim := opt.Shell, opt.Heim
	if shell == "" || heim == "" {
		s, h := rootAusPasswd("/etc/passwd")
		if shell == "" {
			shell = s
		}
		if heim == "" {
			heim = h
		}
	}
	d.ssh = &sshd.Server{
		Hostkeys: keys, Bestand: d.bestand, Ereignis: d.ereignis, Geaendert: d.schreibeStand, Log: d.log,
		Shell: shell, Heim: heim,
		Lokal:         net.JoinHostPort(k.Adresse.String(), strconv.Itoa(PortSSH)),
		Lebenszeichen: opt.Lebenszeichen,
	}
	d.abholer = &abholer.Abholer{
		Dial:    d.tunnel.Dial,
		Server:  k.SchluesselServer,
		Bestand: d.bestand,
		Uebernommen: func(bool) {
			// Erst die Sitzungen, dann die Meldung: Im selben Zug, in dem ein
			// Schlüssel aus der Liste fällt, enden seine Sitzungen.
			d.ssh.BeendeUngueltige()
			d.meldeFenster()
			d.schreibeStand()
		},
		Melde: func(m string) { d.log.Info(m) },
		Warte: opt.Warte, Vorlauf: opt.Vorlauf, Pause: opt.Pause,
	}
	return d, nil
}

// HostSchluessel nennt die Host-Schlüssel, die der Server im Tunnel zeigt
// (Art und Fingerabdruck).
func (d *Dienst) HostSchluessel() []string { return d.hostkeys }

// ereignis schreibt in die Ereignisliste und ins Protokoll.
func (d *Dienst) ereignis(text string) {
	d.log.Info(text)
	if err := d.liste.Schreibe(text); err != nil {
		d.log.Warn("Ereignisliste nicht geschrieben", "grund", err.Error())
	}
}

// meldeFenster hält fest, wenn sich die Fenster-Schlüssel geändert haben: nur
// die Zugänge, nie ein Schlüssel.
func (d *Dienst) meldeFenster() {
	var z []string
	for _, f := range d.bestand.Fenster() {
		z = append(z, f.Zugang)
	}
	text := strings.Join(z, " ")
	if text == "" {
		text = "keine"
	}
	d.mu.Lock()
	gleich := d.fensterText == text || (d.fensterText == "" && text == "keine")
	d.fensterText = text
	d.mu.Unlock()
	if !gleich {
		d.ereignis("Fenster-Schluessel jetzt: " + text)
	}
}

// Laufe bedient den Tunnel, bis ctx endet.
func (d *Dienst) Laufe(ctx context.Context) error {
	d.log.Info("Wartungstunnel offen", "adresse", d.k.Adresse.String(), "server", d.k.Endpunkt, "server_adresse", d.tunnel.Endpunkt(),
		"ssh", PortSSH, "host_schluessel", strings.Join(d.hostkeys, ", "))
	// SIGHUP annehmen und übergehen. Das Dienst-Skript startet das Programm
	// mit ignoriertem SIGHUP, und ein ignoriertes Signal erbt jeder Prozess
	// einer Sitzung: Eine Shell am Terminal bekäme beim Ende der Verbindung
	// dann kein SIGHUP. Ein angenommenes Signal steht im Kindprozess wieder auf
	// seiner Vorgabe.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = d.ssh.Bediene(d.lnSSH) }()
	go func() { defer wg.Done(); d.abholer.Laufe(ctx) }()
	if d.lnWeb != nil {
		wg.Add(1)
		go func() { defer wg.Done(); d.bedieneWeb(ctx) }()
	}
	t := time.NewTicker(d.opt.Takt)
	defer t.Stop()
	d.takt(ctx)
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-t.C:
			d.takt(ctx)
		}
	}
	_ = d.lnSSH.Close()
	if d.lnWeb != nil {
		_ = d.lnWeb.Close()
	}
	d.ssh.Schliesse()
	wg.Wait()
	d.tunnel.Schliesse()
	_ = os.Remove(d.k.Stand)
	return nil
}

// takt läuft unabhängig vom Abholer: Hängt der, verfällt trotzdem jeder
// Fenster-Schlüssel zu seiner Frist, und seine Sitzungen enden.
func (d *Dienst) takt(ctx context.Context) {
	d.bestand.Verfalle()
	d.ssh.BeendeUngueltige()
	d.meldeFenster()
	d.endpunktPflegen(ctx)
	d.schreibeStand()
}

// endpunktPflegen löst den Namen des Wartungsservers wieder auf, solange kein
// frischer Handshake da ist (der Server kann umgezogen sein, oder beim Start
// gab es noch kein DNS).
func (d *Dienst) endpunktPflegen(ctx context.Context) {
	alter, ok := d.tunnel.Handshake()
	d.mu.Lock()
	faellig := !d.loestAuf && (((!ok || alter > handshakeAlt) && time.Since(d.aufgeloest) > aufloesenAbstand) ||
		(d.tunnel.Endpunkt() == "" && time.Since(d.aufgeloest) > 10*time.Second))
	if faellig {
		d.loestAuf, d.aufgeloest = true, time.Now()
	}
	d.mu.Unlock()
	if !faellig {
		return
	}
	go func() {
		defer func() {
			d.mu.Lock()
			d.loestAuf = false
			d.mu.Unlock()
		}()
		d.loeseAuf(ctx, 15*time.Second)
	}()
}

// loeseAuf setzt den Endpunkt des Tunnels neu, wenn der Name jetzt eine
// andere Adresse nennt.
func (d *Dienst) loeseAuf(ctx context.Context, frist time.Duration) {
	actx, ende := context.WithTimeout(ctx, frist)
	defer ende()
	aufloesen := d.opt.Aufloesen
	if aufloesen == nil {
		aufloesen = Aufloesen
	}
	ip, err := aufloesen(actx, d.k.Endpunkt)
	if err != nil {
		d.selten("Wartungsserver " + d.k.Endpunkt + " nicht auflösbar: " + err.Error())
		return
	}
	if ip == d.tunnel.Endpunkt() {
		return
	}
	if err := d.tunnel.SetzeEndpunkt(ip); err != nil {
		d.log.Warn(err.Error())
		return
	}
	d.log.Info("Wartungsserver", "server", d.k.Endpunkt, "adresse", ip)
}

// Aufloesen macht aus name:port die erste IPv4-Adresse mit Port.
func Aufloesen(ctx context.Context, endpunkt string) (string, error) {
	host, port, err := net.SplitHostPort(endpunkt)
	if err != nil {
		return "", err
	}
	p, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return "", err
	}
	if a, err := netip.ParseAddr(host); err == nil {
		return netip.AddrPortFrom(a, uint16(p)).String(), nil
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", host)
	if err != nil {
		return "", err
	}
	if len(ips) == 0 {
		return "", errors.New("keine IPv4-Adresse")
	}
	return netip.AddrPortFrom(ips[0].Unmap(), uint16(p)).String(), nil
}

// bedieneWeb reicht die Web-App der Box in den Tunnel durch. WER anfragt und
// OB ein Fenster offen ist, prüft die Box nicht: Die Schranke ist das Fenster
// am Wartungsserver; WireGuard nimmt nur Absender aus dem Techniker-Netz an.
func (d *Dienst) bedieneWeb(ctx context.Context) {
	plaetze := make(chan struct{}, 32)
	for {
		c, err := d.lnWeb.Accept()
		if err != nil {
			return
		}
		select {
		case plaetze <- struct{}{}:
		default:
			_ = c.Close()
			continue
		}
		go func() {
			defer func() { <-plaetze }()
			defer c.Close()
			var dialer net.Dialer
			dctx, ende := context.WithTimeout(ctx, 10*time.Second)
			z, err := dialer.DialContext(dctx, "tcp", d.k.WebZiel)
			ende()
			if err != nil {
				return
			}
			defer z.Close()
			fertig := make(chan struct{}, 2)
			go func() { _, _ = io.Copy(z, c); fertig <- struct{}{} }()
			go func() { _, _ = io.Copy(c, z); fertig <- struct{}{} }()
			select {
			case <-fertig:
			case <-ctx.Done():
			}
		}()
	}
}

// Stand ist der Stand jetzt, wie "status" ihn zeigt.
func (d *Dienst) Stand() stand.Stand {
	s := stand.Stand{
		Fassung:    d.opt.Fassung,
		PID:        os.Getpid(),
		Laufzeit:   stand.Laufzeit(),
		LaeuftSeit: int64(time.Since(d.beginn) / time.Second),
		Adresse:    d.k.Adresse.String(),
		Endpunkt:   d.k.Endpunkt,
		EndpunktIP: d.tunnel.Endpunkt(),
		Hostkeys:   d.hostkeys,
		Server:     d.k.SchluesselServer.String(),
		DauerDatei: d.k.Dauerhaft,
		Ereignisse: d.k.Ereignisse,
		Web:        "zu",
	}
	var netze []string
	for _, n := range d.k.Netze {
		netze = append(netze, n.String())
	}
	s.Netze = strings.Join(netze, ",")
	if d.k.Web {
		s.Web = "netz -> " + d.k.WebZiel
	}
	s.Handshake = stand.Sekunden(d.tunnel.Handshake())
	seit, ok, grund := d.abholer.Stand()
	s.Antwort, s.Grund = stand.Sekunden(seit, ok), grund
	s.Dauerhaft, s.MitOptionen, _ = d.bestand.Dauerhaft()
	s.Fenster = []stand.Fenster{}
	for _, f := range d.bestand.Fenster() {
		s.Fenster = append(s.Fenster, stand.Fenster{Zugang: f.Zugang, Rest: int64(f.Rest / time.Second)})
	}
	s.SitzDauer, s.SitzFenster = d.ssh.Sitzungen()
	return s
}

// schreibeStand ersetzt die Stand-Datei: wenn sich etwas geändert hat, sonst
// alle fünf Sekunden (damit "status" das Alter sieht).
func (d *Dienst) schreibeStand() {
	if d.k.Stand == "" {
		return
	}
	d.standMu.Lock()
	defer d.standMu.Unlock()
	s := d.Stand()
	// Vergleich ohne die Angaben, die mit jeder Sekunde laufen.
	v := s
	v.Laufzeit, v.LaeuftSeit, v.Handshake, v.Antwort = 0, 0, 0, 0
	v.Fenster = nil
	inhalt := fmt.Sprintf("%+v|%v|%v", v, s.Handshake >= 0, s.Antwort >= 0)
	for _, f := range s.Fenster {
		inhalt += "|" + f.Zugang
	}
	d.mu.Lock()
	faellig := inhalt != d.standInhalt || time.Since(d.standZuletzt) >= 5*time.Second
	if faellig {
		d.standInhalt, d.standZuletzt = inhalt, time.Now()
	}
	d.mu.Unlock()
	if !faellig {
		return
	}
	if err := stand.Schreibe(d.k.Stand, s); err != nil {
		d.selten("Stand nicht geschrieben (" + d.k.Stand + "): " + err.Error())
	}
}

// rootAusPasswd liest Heim und Shell von root (uid 0).
func rootAusPasswd(pfad string) (shell, heim string) {
	shell, heim = "/bin/sh", "/root"
	daten, err := os.ReadFile(pfad)
	if err != nil {
		return
	}
	for _, z := range strings.Split(string(daten), "\n") {
		f := strings.Split(z, ":")
		if len(f) >= 7 && f[2] == "0" {
			if f[5] != "" {
				heim = f[5]
			}
			if f[6] != "" {
				shell = f[6]
			}
			return
		}
	}
	return
}
