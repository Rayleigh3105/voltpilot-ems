// vp-werkstatt-dienst: der Werkstatt-Dienst im Cluster (Konzept
// „Werkstatt-Automatik“, V1a). Er richtet über die Werkbank-Brücke eine Box
// ein, die mit dem orangen Kabel WERKSTATT an ihrer Buchse LAN steckt, und
// hält jeden Schritt mit einem Beleg fest.
//
//	vp-werkstatt-dienst [dienst]   die Schleife mit Betriebs- und Werkstatt-Seite
//	vp-werkstatt-dienst werkbank   Brücke einmal einrichten bzw. prüfen, Status als JSON
//	vp-werkstatt-dienst eingabe tunnel_adresse <adresse>   Eingabe an den laufenden Lauf
//	vp-werkstatt-dienst pruefe-konfig
//	vp-werkstatt-dienst fassung
//
// Als "ssh" aufgerufen (Verweis im Arbeitsverzeichnis eines Laufs) ist es die
// Durchreiche der Skripte zur Box (internal/durchreiche).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/anzeige"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/apikonto"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/konfig"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/passwort"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// fassung setzt der Bau (-ldflags "-X main.fassung=<commit>").
var fassung = "entwicklung"

func main() {
	if filepath.Base(os.Args[0]) == "ssh" {
		os.Exit(durchreiche.Shim(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
	}
	befehl := "dienst"
	if len(os.Args) > 1 {
		befehl = os.Args[1]
	}
	log := logs.Neu(os.Stdout, os.Getenv("VOLTPILOT_LOGGING_FORMAT"), slog.LevelInfo)
	var err error
	switch befehl {
	case "dienst":
		err = dienstLaufen(log)
	case "werkbank":
		err = werkbankEinmal(log)
	case "eingabe":
		err = eingabe(os.Args[2:])
	case "pruefe-konfig":
		err = pruefeKonfig()
	case "fassung", "version", "--version":
		fmt.Println(fassung)
	default:
		fmt.Fprintf(os.Stderr, "unbekannter Befehl %q (dienst, werkbank, eingabe, pruefe-konfig, fassung)\n", befehl)
		os.Exit(2)
	}
	if err != nil {
		log.Error("beendet mit Fehler", "fehler", err)
		os.Exit(1)
	}
}

func eingabe(args []string) error {
	if len(args) != 2 {
		return errors.New("Aufruf: vp-werkstatt-dienst eingabe <name> <wert>, etwa eingabe tunnel_adresse 10.10.16.5")
	}
	k, err := konfig.Lies(os.Getenv, false)
	if err != nil && k.Steuerung == "" {
		return err
	}
	cl := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", k.Steuerung)
	}}}
	resp, err := cl.PostForm("http://steuerung/eingabe", url.Values{"name": {args[0]}, "wert": {args[1]}})
	if err != nil {
		return fmt.Errorf("Dienst nicht erreichbar (%s): %w", k.Steuerung, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("abgelehnt: %s", strings.TrimSpace(string(b)))
	}
	fmt.Print(string(b))
	return nil
}

func pruefeKonfig() error {
	k, err := konfig.Lies(os.Getenv, os.Getenv("VP_WERKSTATT_GEHEIM") != "")
	if err != nil {
		return err
	}
	fmt.Printf("ok: Brücke %s (Netz %s, Werkstatt-Anschluss %s), LAN %s, Takt %s\n", k.Werkbank.Adresse, k.Werkbank.Netz, k.Werkbank.Werkstatt, k.LanNetz, k.Takt)
	fmt.Printf("ok: Ziele der Weiterleitung %v\n", k.Werkbank.Ziele)
	if err := k.PruefeFuerDienst(); err != nil {
		fmt.Printf("für Läufe an der Box fehlt: %v\n", err)
	} else {
		fmt.Printf("ok: Läufe an der Box (Bauart %s, Box-Netz %s, LAN %s über %s)\n", k.Bauart, k.BoxNetz, k.LanNetz, k.LanBruecke)
	}
	if _, err := (freigabe.Datei{Pfad: k.FreigabeDatei}).Aktuell(); err != nil {
		fmt.Printf("Freigabe: %v\n", err)
	} else {
		fmt.Println("ok: Freigabe lesbar")
	}
	return nil
}

func werkbankEinmal(log *slog.Logger) error {
	k, err := konfig.Lies(os.Getenv, true)
	if err != nil {
		return err
	}
	wb, err := werkbank.Neu(k.Werkbank, log)
	if err != nil {
		return err
	}
	defer wb.Schliesse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	s, erg, err := wb.Bereit(ctx)
	if erg != nil {
		fmt.Fprintf(os.Stderr, "%s (Fassung %s):\n%s\n", erg.Weg, erg.Fassung, erg.Ausgabe)
	}
	if s.Schema != "" {
		b, _ := json.MarshalIndent(s, "", "  ")
		fmt.Println(string(b))
	}
	return err
}

// freigabeQuelle: die API, wenn sie konfiguriert ist (V1), sonst die Datei (V1a).
func freigabeQuelle(k konfig.Konfig) freigabe.Quelle {
	if k.APIURL == "" {
		return freigabe.Datei{Pfad: k.FreigabeDatei}
	}
	return freigabe.API{URL: k.APIURL, BoxArt: freigabe.Mango,
		Token: &apikonto.Konto{TokenURL: k.TokenURL, ClientID: k.ClientID, Secret: k.ClientSecret}}
}

func dienstLaufen(log *slog.Logger) error {
	k, err := konfig.Lies(os.Getenv, true)
	if err != nil {
		return err
	}
	if err := k.PruefeFuerDienst(); err != nil {
		return err
	}
	quelle := "Datei " + k.FreigabeDatei
	if k.APIURL != "" {
		quelle = "API " + k.APIURL
	}
	log.Info("Werkstatt-Dienst startet", "fassung", fassung, "werkbank", k.Werkbank.Adresse, "takt", k.Takt.String(), "freigabe", quelle)
	ablage, err := protokoll.NeueAblage(k.Daten + "/laeufe")
	if err != nil {
		return err
	}
	reg := metriken.Neu()
	reg.Messwert("vp_werkstatt_info", "Fassung des Dienstes.", "fassung").Setze(1, fassung)
	wb, err := werkbank.Neu(k.Werkbank, log)
	if err != nil {
		return err
	}
	defer wb.Schliesse()
	empf, err := passwort.Empfaenger(k.PasswortEmpfaenger)
	if err != nil {
		return err
	}
	mk := &mango.Konfig{
		Werkbank:   wb,
		Fassungen:  &fassungen.Ablage{Dir: filepath.Join(k.Daten, "fassungen"), Token: k.DownloadToken, TokenHost: "git.tecmaxx.de"},
		Arbeit:     k.Arbeit,
		LanNetz:    k.LanNetz,
		LanBruecke: k.LanBruecke,
		DNS:        k.DNS,
		Notfall:    k.Werkbank.Notfall,
		Empfaenger: empf,
		WartungPub: k.WartungPub,
		WartungEP:  k.WartungEndpunkt,
		BoxNetz:    k.BoxNetz,
		Bauart:     k.Bauart,
		Zeiten:     mango.VorgabeZeiten,
		Log:        log.With("logger", "mango"),
	}
	d := dienst.Neu(&dienst.Dienst{
		Log:       log.With("logger", "dienst"),
		Werkbank:  wb,
		Adresse:   k.Werkbank.Adresse,
		Freigaben: freigabeQuelle(k),
		Ablage:    ablage,
		Laeufer:   lauf.NeuerLaeufer(ablage, log.With("logger", "lauf"), reg),
		Takt:      k.Takt,
		Mango:     mk,
	}, reg)
	d.SchliesseOffene()

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	betrieb := &http.Server{Addr: k.HTTP, Handler: anzeige.Betrieb(d, reg), ReadHeaderTimeout: 5 * time.Second}
	werkstatt := &http.Server{Addr: k.Anzeige, Handler: anzeige.Werkstatt(d, ablage, log.With("logger", "anzeige")), ReadHeaderTimeout: 5 * time.Second}
	_ = os.Remove(k.Steuerung)
	sl, err := net.Listen("unix", k.Steuerung)
	if err != nil {
		return fmt.Errorf("Steuerung %s: %w", k.Steuerung, err)
	}
	_ = os.Chmod(k.Steuerung, 0o600)
	steuerung := &http.Server{Handler: anzeige.Steuerung(d), ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = steuerung.Serve(sl) }()
	defer steuerung.Close()

	fehler := make(chan error, 2)
	for _, s := range []*http.Server{betrieb, werkstatt} {
		l, err := net.Listen("tcp", s.Addr)
		if err != nil {
			return fmt.Errorf("%s: %w", s.Addr, err)
		}
		go func(s *http.Server, l net.Listener) {
			if err := s.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
				fehler <- err
			}
		}(s, l)
	}

	schleife := make(chan struct{})
	go func() {
		d.Laufe(ctx)
		close(schleife)
	}()
	select {
	case <-ctx.Done():
	case err = <-fehler:
		cancel()
	}
	<-schleife
	sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer scancel()
	_ = betrieb.Shutdown(sctx)
	_ = werkstatt.Shutdown(sctx)
	log.Info("Werkstatt-Dienst beendet")
	return err
}
