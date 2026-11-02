// Package wartung ist der Weg des Dienstes zur Box über den Wartungstunnel,
// als Techniker-Zugang „Werkstatt-Dienst“ (WI-5 A): WireGuard im eigenen
// Prozess (wireguard-go mit netstack), ohne NET_ADMIN und ohne Gerät im Pod.
// Der Tunnel kennt nur das Box-Netz; alles andere geht nicht hinein.
package wartung

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

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Zugang ist der Techniker-Zugang des Dienstes: sein WireGuard-Schlüssel und
// seine Adresse im Techniker-Netz (wie im Portal unter Fernwartung angelegt).
type Zugang struct {
	Privat  geheim.Geheim // WireGuard-Privatschlüssel, Base64
	Adresse netip.Addr
}

// Server ist der Wartungsserver aus der Einlösung (oder der Konfiguration).
type Server struct {
	PublicKey string                       // Base64
	Endpunkt  string                       // host:port
	BoxNetz   netip.Prefix                 // nur dorthin führt der Tunnel
	Aufloesen func(string) (string, error) // für Tests; nil = net.ResolveUDPAddr
}

// Tunnel ist ein offener Wartungstunnel.
type Tunnel struct {
	dev  *device.Device
	net  *netstack.Net
	once sync.Once
}

// Oeffne baut den Tunnel auf. Ein Handshake entsteht erst mit dem ersten Paket.
func Oeffne(z Zugang, s Server) (*Tunnel, error) {
	if !z.Adresse.Is4() {
		return nil, errors.New("Techniker-Adresse fehlt")
	}
	priv, err := schluesselHex(z.Privat.Offenbaren())
	if err != nil {
		return nil, fmt.Errorf("WireGuard-Schlüssel des Techniker-Zugangs: %v", err)
	}
	pub, err := schluesselHex(s.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("Schlüssel des Wartungsservers: %v", err)
	}
	if !s.BoxNetz.IsValid() {
		return nil, errors.New("Box-Netz fehlt")
	}
	ep := s.Endpunkt
	if s.Aufloesen != nil {
		if ep, err = s.Aufloesen(ep); err != nil {
			return nil, err
		}
	} else {
		a, err := net.ResolveUDPAddr("udp", ep)
		if err != nil {
			return nil, fmt.Errorf("Wartungsserver %s: %v", s.Endpunkt, err)
		}
		ep = a.String()
	}
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{z.Adresse}, nil, 1280)
	if err != nil {
		return nil, err
	}
	dev := device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	cfg := strings.Join([]string{
		"private_key=" + priv,
		"public_key=" + pub,
		"endpoint=" + ep,
		"allowed_ip=" + s.BoxNetz.Masked().String(),
		"persistent_keepalive_interval=15",
	}, "\n") + "\n"
	if err := dev.IpcSet(cfg); err != nil {
		dev.Close()
		return nil, fmt.Errorf("WireGuard einrichten: %v", geheim.Schwaerze(err.Error()))
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	return &Tunnel{dev: dev, net: tnet}, nil
}

// Dial öffnet eine TCP-Verbindung durch den Tunnel.
func (t *Tunnel) Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error) {
	return t.net.DialContextTCPAddrPort(ctx, ziel)
}

// Handshake sagt, ob seit dem Öffnen ein Handshake mit dem Server gelang.
func (t *Tunnel) Handshake() bool {
	s, err := t.dev.IpcGet()
	if err != nil {
		return false
	}
	for _, z := range strings.Split(s, "\n") {
		if v, ok := strings.CutPrefix(z, "last_handshake_time_sec="); ok && v != "0" {
			return true
		}
	}
	return false
}

// Schliesse baut den Tunnel ab.
func (t *Tunnel) Schliesse() {
	t.once.Do(func() { t.dev.Close() })
}

func schluesselHex(b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil || len(raw) != 32 {
		return "", errors.New("kein WireGuard-Schlüssel (32 Byte, Base64)")
	}
	return hex.EncodeToString(raw), nil
}
