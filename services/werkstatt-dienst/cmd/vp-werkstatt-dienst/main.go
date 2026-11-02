// vp-werkstatt-dienst: der Werkstatt-Dienst im Cluster (Konzept
// „Werkstatt-Automatik“, V1a). Er richtet über die Werkbank-Brücke eine Box
// ein, die mit dem orangen Kabel WERKSTATT an ihrer Buchse LAN steckt, und
// hält jeden Schritt mit einem Beleg fest.
//
//	vp-werkstatt-dienst [dienst]   die Schleife mit Betriebs- und Werkstatt-Seite
//	vp-werkstatt-dienst werkbank   Brücke einmal einrichten bzw. prüfen, Status als JSON
//	vp-werkstatt-dienst pruefe-konfig
//	vp-werkstatt-dienst fassung
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/anzeige"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/konfig"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// fassung setzt der Bau (-ldflags "-X main.fassung=<commit>").
var fassung = "entwicklung"

func main() {
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
	case "pruefe-konfig":
		err = pruefeKonfig()
	case "fassung", "version", "--version":
		fmt.Println(fassung)
	default:
		fmt.Fprintf(os.Stderr, "unbekannter Befehl %q (dienst, werkbank, pruefe-konfig, fassung)\n", befehl)
		os.Exit(2)
	}
	if err != nil {
		log.Error("beendet mit Fehler", "fehler", err)
		os.Exit(1)
	}
}

func pruefeKonfig() error {
	k, err := konfig.Lies(os.Getenv, os.Getenv("VP_WERKSTATT_GEHEIM") != "")
	if err != nil {
		return err
	}
	fmt.Printf("ok: Brücke %s (Netz %s, Werkstatt-Anschluss %s), LAN %s, Takt %s\n", k.Werkbank.Adresse, k.Werkbank.Netz, k.Werkbank.Werkstatt, k.LanNetz, k.Takt)
	fmt.Printf("ok: Ziele der Weiterleitung %v\n", k.Werkbank.Ziele)
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

func dienstLaufen(log *slog.Logger) error {
	k, err := konfig.Lies(os.Getenv, true)
	if err != nil {
		return err
	}
	log.Info("Werkstatt-Dienst startet", "fassung", fassung, "werkbank", k.Werkbank.Adresse, "takt", k.Takt.String())
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
	d := dienst.Neu(&dienst.Dienst{
		Log:       log.With("logger", "dienst"),
		Werkbank:  wb,
		Adresse:   k.Werkbank.Adresse,
		Freigaben: freigabe.Datei{Pfad: k.FreigabeDatei},
		Ablage:    ablage,
		Laeufer:   lauf.NeuerLaeufer(ablage, log.With("logger", "lauf"), reg),
		Takt:      k.Takt,
	}, reg)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	betrieb := &http.Server{Addr: k.HTTP, Handler: anzeige.Betrieb(d, reg), ReadHeaderTimeout: 5 * time.Second}
	werkstatt := &http.Server{Addr: k.Anzeige, Handler: anzeige.Werkstatt(d, ablage, log.With("logger", "anzeige")), ReadHeaderTimeout: 5 * time.Second}
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
