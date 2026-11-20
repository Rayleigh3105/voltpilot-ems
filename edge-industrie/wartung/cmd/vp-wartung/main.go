// vp-wartung ist die Box-Seite des Wartungstunnels auf einem Gerät ohne
// OpenWrt (WAGO PFC200): WireGuard im eigenen Prozess, darin SSH auf 2222 und
// die Web-App 8484, Abholer der Fenster-Schlüssel, Ereignisliste. Auf der
// Mango tut dasselbe edge-light/openwrt/service-tunnel.sh mit dem WireGuard
// des Kerns und Dropbear. Hintergrund: docs/fernwartung.md.
//
//	vp-wartung lauf [-konfig <datei>]         der Dienst (/etc/init.d/vp-wartung)
//	vp-wartung schluessel [-datei <datei>]    Schlüssel der Box erzeugen, falls
//	                                          keiner da ist; nennt den öffentlichen
//	vp-wartung status [-konfig <datei>] [werte]
//	                                          Stand des Dienstes; mit "werte" als
//	                                          Zeilen schluessel=wert
//	vp-wartung ereignisse [-konfig <datei>]   die ganze Ereignisliste
//	vp-wartung pruefe [-konfig <datei>]       Einstellungen, Schlüssel der Box und
//	                                          Host-Schlüssel prüfen, ohne etwas zu
//	                                          starten (wartung.sh ruft es, bevor
//	                                          neue Einstellungen gelten)
//	vp-wartung hostschluessel [-konfig <datei>]
//	                                          die Host-Schlüssel, die der Server im
//	                                          Tunnel zeigt (die des Geräts)
//	vp-wartung fassung
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/bestand"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/ereignisse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/konfig"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/stand"
)

// Fassung setzt der Bau (-ldflags -X main.Fassung=…).
var Fassung = "dev"

func main() {
	if len(os.Args) < 2 {
		aufruf()
	}
	var err error
	switch os.Args[1] {
	case "lauf":
		err = lauf(os.Args[2:])
	case "schluessel":
		err = schluessel(os.Args[2:])
	case "status":
		os.Exit(status(os.Args[2:]))
	case "ereignisse":
		err = zeigeEreignisse(os.Args[2:])
	case "pruefe":
		err = pruefe(os.Args[2:])
	case "hostschluessel":
		err = hostschluessel(os.Args[2:])
	case "fassung":
		fmt.Println(Fassung)
	default:
		aufruf()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "FEHLER:", err)
		os.Exit(1)
	}
}

func aufruf() {
	fmt.Fprintln(os.Stderr, "Aufruf: vp-wartung lauf|schluessel|status [werte]|ereignisse|pruefe|hostschluessel|fassung")
	os.Exit(2)
}

func mitKonfig(name string, args []string) (*flag.FlagSet, *string) {
	fs := flag.NewFlagSet(name, flag.ExitOnError)
	pfad := fs.String("konfig", konfig.Vorgabe, "Einstellungen")
	_ = fs.Parse(args)
	return fs, pfad
}

func lauf(args []string) error {
	_, pfad := mitKonfig("lauf", args)
	k, err := konfig.Lies(*pfad)
	if err != nil {
		return err
	}
	// Ohne Zeit: Die Ausgabe geht an syslog (logger -t vp-wartung).
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	}))
	d, err := dienst.Starte(k, dienst.Optionen{Fassung: Fassung, Log: log})
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	return d.Laufe(ctx)
}

// schluessel erzeugt den WireGuard-Schlüssel der Box, wenn es noch keinen
// gibt. Der private Schlüssel entsteht auf dem Gerät und verlässt es nie;
// ausgegeben wird nur der öffentliche.
func schluessel(args []string) error {
	fs := flag.NewFlagSet("schluessel", flag.ExitOnError)
	datei := fs.String("datei", konfig.Vorgaben().WGSchluessel, "Datei für den privaten Schlüssel")
	_ = fs.Parse(args)
	priv, err := dienst.WGSchluessel(*datei)
	if err != nil {
		if _, serr := os.Stat(*datei); serr == nil {
			return err // es gibt die Datei, aber sie taugt nicht: nie überschreiben
		}
		roh := make([]byte, 32)
		if _, err := rand.Read(roh); err != nil {
			return err
		}
		roh[0] &= 248
		roh[31] = (roh[31] & 127) | 64
		priv = base64.StdEncoding.EncodeToString(roh)
		if err := os.MkdirAll(filepath.Dir(*datei), 0o700); err != nil {
			return err
		}
		f, err := os.OpenFile(*datei, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		if _, err := f.WriteString(priv + "\n"); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
	}
	roh, err := base64.StdEncoding.DecodeString(priv)
	if err != nil || len(roh) != 32 {
		return fmt.Errorf("%s enthält keinen WireGuard-Schlüssel", *datei)
	}
	pub, err := curve25519.X25519(roh, curve25519.Basepoint)
	if err != nil {
		return err
	}
	fmt.Println("oeffentlicher Schluessel des Geraets:")
	fmt.Println(base64.StdEncoding.EncodeToString(pub))
	return nil
}

// pruefe sagt, ob der Dienst mit diesen Einstellungen starten würde: alles,
// was dienst.Starte verlangt, ohne den Tunnel zu öffnen.
func pruefe(args []string) error {
	_, pfad := mitKonfig("pruefe", args)
	k, err := konfig.Lies(*pfad)
	if err != nil {
		return err
	}
	if err := dienst.Pruefe(k); err != nil {
		return err
	}
	fmt.Println("ok")
	return nil
}

func hostschluessel(args []string) error {
	_, pfad := mitKonfig("hostschluessel", args)
	// Auch ohne (vollständige) Einstellungen: Die Vorgaben nennen die Dateien
	// des Geräts.
	k, _ := konfig.Lies(*pfad)
	keys, unlesbar, err := dienst.Hostkeys(k.Hostkeys)
	if err != nil {
		return err
	}
	for _, s := range keys {
		fmt.Println(s.PublicKey().Type(), ssh.FingerprintSHA256(s.PublicKey()))
	}
	// Ein Schlüssel, den das Gerät hat, der Server im Tunnel aber nicht zeigen
	// könnte, ist ein Fehler: Die Werkstatt vergleicht beide Wege.
	if len(unlesbar) > 0 {
		return fmt.Errorf("nicht lesbar: %s", strings.Join(unlesbar, "; "))
	}
	return nil
}

func zeigeEreignisse(args []string) error {
	_, pfad := mitKonfig("ereignisse", args)
	k, _ := konfig.Lies(*pfad)
	z, err := ereignisse.Lies(k.Ereignisse, 0)
	if err != nil {
		return err
	}
	for _, e := range z {
		fmt.Println(e)
	}
	return nil
}

// status zeigt den Stand des Dienstes. Ausgang 0: läuft; 3: läuft nicht.
func status(args []string) int {
	fs, pfad := mitKonfig("status", args)
	werte := fs.Arg(0) == "werte"
	k, kerr := konfig.Lies(*pfad)
	s, err := stand.Lies(k.Stand)
	laeuft := err == nil && s.PID > 0 && lebt(s.PID)
	alter := stand.Laufzeit() - s.Laufzeit
	if laeuft && (alter < 0 || alter > 60) {
		// Der Stand ist alt (oder von vor einem Neustart der Box): Der Dienst hängt.
		laeuft = false
	}
	if laeuft {
		// Die dauerhaften Schlüssel liest auch der Dienst bei jeder Anmeldung
		// neu: hier der Stand der Datei von jetzt, nicht der vom letzten Takt.
		if g, o, err := bestand.Neu(s.DauerDatei, nil).Dauerhaft(); err == nil {
			s.Dauerhaft, s.MitOptionen = g, o
		}
	}
	if werte {
		statusWerte(s, laeuft, alter)
	} else {
		statusText(k, kerr, s, laeuft, alter)
	}
	if !laeuft {
		return 3
	}
	return 0
}

// lebt sagt, ob es den Prozess gibt (auch wenn er einem anderen Benutzer gehört).
func lebt(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// vor rechnet das Alter des Stands zu einer Angabe "vor n s" dazu.
func vor(sek, alter int64) int64 {
	if sek < 0 {
		return -1
	}
	return sek + alter
}

func statusWerte(s stand.Stand, laeuft bool, alter int64) {
	ja := map[bool]string{true: "ja", false: "nein"}
	fmt.Println("laeuft=" + ja[laeuft])
	if !laeuft {
		return
	}
	fmt.Println("fassung=" + s.Fassung)
	fmt.Println("adresse=" + s.Adresse)
	fmt.Println("endpunkt=" + s.Endpunkt)
	fmt.Println("endpunkt_adresse=" + s.EndpunktIP)
	fmt.Printf("handshake_vor=%d\n", vor(s.Handshake, alter))
	fmt.Println("ssh_2222=nur_im_tunnel")
	fmt.Println("web=" + s.Web)
	fmt.Println("host_schluessel=" + strings.Join(s.Hostkeys, ","))
	fmt.Println("schluessel_server=" + s.Server)
	fmt.Printf("antwort_vor=%d\n", vor(s.Antwort, alter))
	fmt.Println("grund=" + s.Grund)
	fmt.Printf("dauerhaft=%d\n", s.Dauerhaft)
	fmt.Printf("dauerhaft_mit_optionen=%d\n", s.MitOptionen)
	fmt.Printf("fenster=%d\n", len(s.Fenster))
	fmt.Printf("sitzungen_dauerhaft=%d\n", s.SitzDauer)
	fmt.Printf("sitzungen_fenster=%d\n", s.SitzFenster)
}

func statusText(k konfig.Konfig, kerr error, s stand.Stand, laeuft bool, alter int64) {
	if !laeuft {
		fmt.Println("Wartungstunnel: laeuft NICHT (pruefen: /etc/init.d/vp-wartung status, syslog mit der Marke vp-wartung)")
		if kerr != nil {
			fmt.Println("  Einstellungen:", kerr)
		}
	} else {
		fmt.Printf("Wartungstunnel: laeuft seit %d s (vp-wartung %s), Adresse %s\n", s.LaeuftSeit+alter, s.Fassung, s.Adresse)
		ziel := s.EndpunktIP
		if ziel == "" {
			ziel = "noch NICHT aufgeloest"
		}
		fmt.Printf("  Wartungsserver %s (%s)\n", s.Endpunkt, ziel)
		if h := vor(s.Handshake, alter); h >= 0 {
			fmt.Printf("  letzter Handshake: vor %d s\n", h)
		} else {
			fmt.Println("  letzter Handshake: seit dem Start KEINER (Weg ins Internet, Uhr der Box, Schluessel im Portal hinterlegt?)")
		}
		fmt.Println("  SSH 2222: nur im Tunnel - der Port lauscht auf keiner Netzbuchse")
		if s.Web == "zu" {
			fmt.Println("  Web-App 8484 im Tunnel: zu")
		} else {
			fmt.Printf("  Web-App 8484 im Tunnel: frei fuer %s (%s)\n", s.Netze, s.Web)
		}
		fmt.Println("  Host-Schluessel im Tunnel (die des Geraets): " + strings.Join(s.Hostkeys, ", "))
		fmt.Printf("Fenster-Schluessel: Abholer laeuft, Server %s durch den Tunnel\n", s.Server)
		if a := vor(s.Antwort, alter); a >= 0 {
			fmt.Printf("  letzte gueltige Antwort des Wartungsservers: vor %d s\n", a)
		} else {
			fmt.Println("  letzte gueltige Antwort des Wartungsservers: seit dem Start keine")
		}
		if s.Grund != "" {
			fmt.Println("  zuletzt ohne Antwort: " + s.Grund)
		}
		fmt.Printf("  dauerhaft aus %s: %d Schluessel (gelten im Tunnel weiter)\n", s.DauerDatei, s.Dauerhaft)
		if s.MitOptionen > 0 {
			fmt.Printf("    %d Zeile(n) mit Optionen vor dem Schluessel gelten im Tunnel NICHT\n", s.MitOptionen)
		}
		if len(s.Fenster) == 0 {
			fmt.Println("  im Fenster: keine")
		}
		for _, f := range s.Fenster {
			fmt.Printf("  im Fenster: Zugang %s, noch %d s\n", f.Zugang, max(f.Rest-alter, 0))
		}
		fmt.Printf("  Sitzungen im Tunnel: %d - dauerhafter Schluessel %d, Fenster-Schluessel %d\n", s.SitzDauer+s.SitzFenster, s.SitzDauer, s.SitzFenster)
	}
	liste := k.Ereignisse
	if s.Ereignisse != "" {
		liste = s.Ereignisse
	}
	z, err := ereignisse.Lies(liste, 0)
	switch {
	case err != nil:
		fmt.Println("  Ereignisse der Fernwartung: nicht lesbar:", err)
	case len(z) == 0:
		fmt.Printf("  Ereignisse der Fernwartung: noch keine in %s\n", liste)
	default:
		fmt.Printf("  Ereignisse der Fernwartung: %d in %s (Flash, hoechstens %d, nie ein Schluessel) - die letzten:\n", len(z), liste, ereignisse.Max)
		if len(z) > 10 {
			z = z[len(z)-10:]
		}
		for _, e := range z {
			fmt.Println("    " + e)
		}
		fmt.Println("    (alle: vp-wartung ereignisse)")
	}
}
