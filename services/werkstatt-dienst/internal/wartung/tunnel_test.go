package wartung

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

func schluesselpaar(t *testing.T) (priv, pub []byte) {
	t.Helper()
	priv = make([]byte, 32)
	_, _ = rand.Read(priv)
	priv[0] &= 248
	priv[31] = (priv[31] & 127) | 64
	pub, err := curve25519.X25519(priv, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return priv, pub
}

// gegenstelle ist ein WireGuard-Peer mit eigenem netstack, der unter der
// Adresse einer Box im Box-Netz TCP annimmt (statt Wartungsserver und Box).
func gegenstelle(t *testing.T, technikerPub []byte, technikerAdresse netip.Addr) (pub []byte, port string, n *netstack.Net) {
	pub, port, n, _ = gegenstelleMitGeraet(t, technikerPub, technikerAdresse)
	return
}

func gegenstelleMitGeraet(t *testing.T, technikerPub []byte, technikerAdresse netip.Addr) (pub []byte, port string, n *netstack.Net, dev *device.Device) {
	t.Helper()
	priv, pub := schluesselpaar(t)
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.10.16.5")}, nil, 1280)
	if err != nil {
		t.Fatal(err)
	}
	dev = device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	t.Cleanup(dev.Close)
	if err := dev.IpcSet("private_key=" + hex.EncodeToString(priv) + "\nlisten_port=0\npublic_key=" + hex.EncodeToString(technikerPub) +
		"\nallowed_ip=" + technikerAdresse.String() + "/32\n"); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	stand, _ := dev.IpcGet()
	for _, z := range strings.Split(stand, "\n") {
		if v, ok := strings.CutPrefix(z, "listen_port="); ok {
			port = v
		}
	}
	return pub, port, tnet, dev
}

func TestTunnelZurBox(t *testing.T) {
	tPriv, tPub := schluesselpaar(t)
	adresse := netip.MustParseAddr("10.10.32.50")
	sPub, port, box := gegenstelle(t, tPub, adresse)
	ln, err := box.ListenTCPAddrPort(netip.MustParseAddrPort("10.10.16.5:2222"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.Copy(c, c)
	}()
	privText := base64.StdEncoding.EncodeToString(tPriv)
	z := Zugang{Privat: geheim.Neu(privText), Adresse: adresse}
	defer z.Privat.Vergessen()
	tun, err := Oeffne(z, Server{PublicKey: base64.StdEncoding.EncodeToString(sPub), Endpunkt: "127.0.0.1:" + port,
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20")})
	if err != nil {
		t.Fatal(err)
	}
	defer tun.Schliesse()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := tun.Dial(ctx, netip.MustParseAddrPort("10.10.16.5:2222"))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = c.Write([]byte("hallo\n"))
	buf := make([]byte, 6)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hallo\n" {
		t.Fatalf("%q %v", buf, err)
	}
	_ = c.Close()
	if !tun.Handshake() {
		t.Fatal("kein Handshake")
	}
	// Außerhalb des Box-Netzes führt der Tunnel nirgends hin.
	kurz, cancel2 := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel2()
	if _, err := tun.Dial(kurz, netip.MustParseAddrPort("192.0.2.1:22")); err == nil {
		t.Fatal("Verbindung außerhalb des Box-Netzes")
	}
}

func TestOeffnePrueftSchluessel(t *testing.T) {
	z := Zugang{Privat: geheim.Neu("kein-schluessel-123"), Adresse: netip.MustParseAddr("10.10.32.50")}
	defer z.Privat.Vergessen()
	_, err := Oeffne(z, Server{PublicKey: "x", Endpunkt: "127.0.0.1:1", BoxNetz: netip.MustParsePrefix("10.10.16.0/20")})
	if err == nil || strings.Contains(err.Error(), "kein-schluessel-123") {
		t.Fatalf("%v", err)
	}
}
