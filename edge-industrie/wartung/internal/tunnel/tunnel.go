// Package tunnel ist der Wartungstunnel der Box: WireGuard im eigenen Prozess
// (wireguard-go mit netstack), derselbe Baustein wie auf der Seite des
// Werkstatt-Dienstes (services/werkstatt-dienst/internal/wartung).
//
// Es gibt keine Schnittstelle im Kern, keine Route und keine Regel in der
// Firewall des Geräts: Die Tunnel-Adresse lebt nur in diesem Prozess. Was im
// Tunnel lauscht (SSH 2222, Web-App 8484), lauscht auf keiner Netzbuchse; was
// die Box durch den Tunnel fragt (Schlüsselausgabe), kann auf keinem anderen
// Weg hinaus. WireGuard nimmt vom Server nur Absender aus den erlaubten
// Netzen an (das Techniker-Netz).
package tunnel

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Konfig beschreibt den Tunnel der Box.
type Konfig struct {
	Privat    string         // WireGuard-Privatschlüssel der Box, Base64
	Adresse   netip.Addr     // Tunnel-Adresse der Box (aus dem Portal)
	ServerPub string         // öffentlicher Schlüssel des Wartungsservers, Base64
	Netze     []netip.Prefix // erlaubte Absender: das Techniker-Netz
	Keepalive int            // Sekunden; 0: 25
	// Endpunkt des Servers als ip:port, wenn er schon bekannt ist. WireGuard
	// meldet sich sofort beim Server; ein Versuch ohne Endpunkt kostet fünf
	// Sekunden bis zum nächsten.
	Endpunkt string
	// Fehler bekommt Meldungen von WireGuard (nil: verworfen). Ein Schlüssel
	// steht nie darin.
	Fehler func(string)
}

// Tunnel ist der laufende Tunnel.
type Tunnel struct {
	dev       *device.Device
	net       *netstack.Net
	adresse   netip.Addr
	serverHex string

	mu        sync.Mutex
	endpunkt  string    // zuletzt gesetzt, ip:port
	handWert  string    // last_handshake_time_sec, wie zuletzt gelesen
	handZeit  time.Time // wann sich handWert zuletzt geändert hat (monotone Uhr)
	geschloss bool
}

// Oeffne baut den Tunnel auf. Ohne Endpunkt (der Name des Servers war noch
// nicht auflösbar) lauscht im Tunnel schon alles, erreichbar ist es erst,
// wenn SetzeEndpunkt ihn nachreicht.
func Oeffne(k Konfig) (*Tunnel, error) {
	if !k.Adresse.Is4() {
		return nil, errors.New("Tunnel-Adresse fehlt")
	}
	priv, err := SchluesselHex(k.Privat)
	if err != nil {
		return nil, fmt.Errorf("Schlüssel der Box: %v", err)
	}
	pub, err := SchluesselHex(k.ServerPub)
	if err != nil {
		return nil, fmt.Errorf("Schlüssel des Wartungsservers: %v", err)
	}
	if len(k.Netze) == 0 {
		return nil, errors.New("kein erlaubtes Netz")
	}
	keep := k.Keepalive
	if keep <= 0 {
		keep = 25
	}
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{k.Adresse}, nil, 1280)
	if err != nil {
		return nil, err
	}
	fehler := k.Fehler
	if fehler == nil {
		fehler = func(string) {}
	}
	log := &device.Logger{
		Verbosef: func(string, ...any) {},
		Errorf:   func(f string, a ...any) { fehler(fmt.Sprintf(f, a...)) },
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), log)
	cfg := []string{"private_key=" + priv, "public_key=" + pub}
	if k.Endpunkt != "" {
		if _, err := netip.ParseAddrPort(k.Endpunkt); err != nil {
			return nil, fmt.Errorf("Endpunkt %q: %v", k.Endpunkt, err)
		}
		cfg = append(cfg, "endpoint="+k.Endpunkt)
	}
	for _, n := range k.Netze {
		cfg = append(cfg, "allowed_ip="+n.Masked().String())
	}
	cfg = append(cfg, fmt.Sprintf("persistent_keepalive_interval=%d", keep))
	if err := dev.IpcSet(strings.Join(cfg, "\n") + "\n"); err != nil {
		dev.Close()
		// Die Meldung von wireguard-go kann die Zeile mit dem Schlüssel zitieren.
		return nil, errors.New("WireGuard nimmt die Einstellungen nicht an")
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	return &Tunnel{dev: dev, net: tnet, adresse: k.Adresse, serverHex: pub, endpunkt: k.Endpunkt}, nil
}

// Adresse ist die Tunnel-Adresse der Box.
func (t *Tunnel) Adresse() netip.Addr { return t.adresse }

// Lausche öffnet einen TCP-Port an der Tunnel-Adresse. Er existiert nur im
// Tunnel.
func (t *Tunnel) Lausche(port uint16) (net.Listener, error) {
	return t.net.ListenTCPAddrPort(netip.AddrPortFrom(t.adresse, port))
}

// Dial öffnet eine TCP-Verbindung durch den Tunnel.
func (t *Tunnel) Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error) {
	return t.net.DialContextTCPAddrPort(ctx, ziel)
}

// SetzeEndpunkt setzt die Adresse des Wartungsservers (ip:port).
func (t *Tunnel) SetzeEndpunkt(ipPort string) error {
	if _, err := netip.ParseAddrPort(ipPort); err != nil {
		return fmt.Errorf("Endpunkt %q: %v", ipPort, err)
	}
	if err := t.dev.IpcSet("public_key=" + t.serverHex + "\nupdate_only=true\nendpoint=" + ipPort + "\n"); err != nil {
		return errors.New("WireGuard nimmt den Endpunkt nicht an")
	}
	t.mu.Lock()
	t.endpunkt = ipPort
	t.mu.Unlock()
	return nil
}

// Endpunkt ist die zuletzt gesetzte Adresse des Servers; leer, solange keine
// gesetzt ist.
func (t *Tunnel) Endpunkt() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.endpunkt
}

// Handshake sagt, wie lange der letzte Handshake mit dem Server her ist; ok
// false, solange es keinen gab. Gemessen wird in Laufzeit: WireGuard nennt
// den Handshake in Uhrzeit, und die Uhr der Box kann springen. Darum zählt,
// wann dieser Prozess den Wert zuletzt sich ändern sah; wer selten fragt,
// bekommt ein entsprechend gröberes Alter.
func (t *Tunnel) Handshake() (time.Duration, bool) {
	wert := ""
	if s, err := t.dev.IpcGet(); err == nil {
		for _, z := range strings.Split(s, "\n") {
			if v, ok := strings.CutPrefix(z, "last_handshake_time_sec="); ok {
				wert = v
			}
			if v, ok := strings.CutPrefix(z, "last_handshake_time_nsec="); ok {
				wert += "." + v
			}
		}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if wert != "" && wert != "0.0" && wert != t.handWert {
		t.handWert, t.handZeit = wert, time.Now()
	}
	if t.handZeit.IsZero() {
		return 0, false
	}
	return time.Since(t.handZeit), true
}

// Schliesse baut den Tunnel ab.
func (t *Tunnel) Schliesse() {
	t.mu.Lock()
	zu := t.geschloss
	t.geschloss = true
	t.mu.Unlock()
	if !zu {
		t.dev.Close()
	}
}

// SchluesselHex wandelt einen WireGuard-Schlüssel (32 Byte, Base64) in die
// Schreibweise der WireGuard-Schnittstelle.
func SchluesselHex(b64 string) (string, error) {
	roh, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(roh) != 32 {
		return "", errors.New("kein WireGuard-Schlüssel (32 Byte, Base64)")
	}
	return hex.EncodeToString(roh), nil
}
