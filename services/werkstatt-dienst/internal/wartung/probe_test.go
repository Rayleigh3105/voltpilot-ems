package wartung

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// sshAufBox: ein SSH-Server auf der Box-Adresse im netstack der Gegenstelle.
// Den Schlüssel des Zugangs nimmt er erst an, wenn offen gesetzt ist.
// abgewiesen: die Box hat eine Anmeldung abgewiesen.
var abgewiesen atomic.Bool

func sshAufBox(t *testing.T, ln net.Listener, erlaubt ssh.PublicKey, offen *atomic.Bool) ssh.PublicKey {
	t.Helper()
	_, hk, _ := ed25519.GenerateKey(rand.Reader)
	host, _ := ssh.NewSignerFromKey(hk)
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		if offen.Load() && string(k.Marshal()) == string(erlaubt.Marshal()) {
			return nil, nil
		}
		abgewiesen.Store(true)
		return nil, errors.New("abgewiesen")
	}}
	cfg.AddHostKey(host)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					_ = c.Close()
					return
				}
				defer sc.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					kanal, anf, _ := ch.Accept()
					go func() {
						for r := range anf {
							if r.Type == "exec" {
								_ = r.Reply(true, nil)
								_, _ = kanal.Write([]byte("vp-werkstatt-probe\n"))
								_, _ = kanal.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{0}))
								_ = kanal.Close()
							}
						}
					}()
				}
			}()
		}
	}()
	return host.PublicKey()
}

func TestProbeImFensterUndDanach(t *testing.T) {
	tPriv, tPub := schluesselpaar(t)
	adresse := netip.MustParseAddr("10.10.32.50")
	sPub, port, box, dev := gegenstelleMitGeraet(t, tPub, adresse)
	ln, err := box.ListenTCPAddrPort(netip.MustParseAddrPort("10.10.16.5:2222"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	rk, _ := rsa.GenerateKey(rand.Reader, 2048)
	signer, _ := ssh.NewSignerFromKey(rk)
	var offen atomic.Bool
	abgewiesen.Store(false)
	hostPub := sshAufBox(t, ln, signer.PublicKey(), &offen)
	// Die Box holt den Schlüssel erst etwas später: Der erste Versuch wird
	// abgewiesen, danach ist er da (nach Ereignis statt nach Uhr, damit ein
	// langsamer Handschlag unter -race nicht beide Seiten überholt).
	go func() {
		for !abgewiesen.Load() {
			time.Sleep(10 * time.Millisecond)
		}
		offen.Store(true)
	}()

	// Je Versuch reichlich Zeit: Unter -race braucht der SSH-Handschlag durch
	// WireGuard im Prozess deutlich über eine Sekunde.
	p := Probe{Zugang: Zugang{Privat: geheim.Neu(base64.StdEncoding.EncodeToString(tPriv)), Adresse: adresse}, SSH: signer,
		Takt: 200 * time.Millisecond, Versuch: 10 * time.Second}
	defer p.Zugang.Privat.Vergessen()
	s := Server{PublicKey: base64.StdEncoding.EncodeToString(sPub), Endpunkt: "127.0.0.1:" + port, BoxNetz: netip.MustParsePrefix("10.10.16.0/20")}
	ziel := netip.MustParseAddrPort("10.10.16.5:2222")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	an, err := p.Anmelden(ctx, s, ziel)
	if err != nil {
		t.Fatal(err)
	}
	if an.HostSchluessel != ssh.FingerprintSHA256(hostPub) || an.Versuche < 2 {
		t.Fatalf("%+v", an)
	}
	if !strings.HasPrefix(p.Fingerabdruck(), "SHA256:") {
		t.Fatal(p.Fingerabdruck())
	}
	// Fenster zu: der Wartungsserver streicht den Weg des Technikers (hier: der Peer verschwindet).
	if err := dev.IpcSet("public_key=" + hex.EncodeToString(tPub) + "\nremove=true\n"); err != nil {
		t.Fatal(err)
	}
	// Nach dem Ende wartet jeder Versuch auf die Zeitüberschreitung: hier kurz.
	p.Versuch = 1500 * time.Millisecond
	nach, err := p.NachEnde(ctx, s, ziel)
	if err != nil || !strings.HasPrefix(nach, "Connection timed out") {
		t.Fatalf("%q %v", nach, err)
	}
}

func TestNachEndeOhneZeitueberschreitungIstKeinBeleg(t *testing.T) {
	tPriv, tPub := schluesselpaar(t)
	adresse := netip.MustParseAddr("10.10.32.50")
	sPub, port, _ := gegenstelle(t, tPub, adresse) // niemand lauscht: die Box antwortet mit RST
	p := Probe{Zugang: Zugang{Privat: geheim.Neu(base64.StdEncoding.EncodeToString(tPriv)), Adresse: adresse},
		Takt: 100 * time.Millisecond, Versuch: 2 * time.Second}
	defer p.Zugang.Privat.Vergessen()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := p.NachEnde(ctx, Server{PublicKey: base64.StdEncoding.EncodeToString(sPub), Endpunkt: "127.0.0.1:" + port,
		BoxNetz: netip.MustParsePrefix("10.10.16.0/20")}, netip.MustParseAddrPort("10.10.16.5:2222"))
	if err == nil || !strings.Contains(err.Error(), "erwartet: Zeitüberschreitung") {
		t.Fatalf("%v", err)
	}
}
