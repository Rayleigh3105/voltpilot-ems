package ausgabe

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

// SchalterBefehl ist der Unterbefehl, mit dem der Dienst den Schalter als
// eigenen Prozess startet. Von Hand ruft ihn niemand auf: ohne den Kanal des
// Dienstes beendet er sich sofort.
const SchalterBefehl = "schluessel-schalter"

// Umgebung des Schalters - der Dienst gibt ihm nur das mit.
const (
	envAdresse = "VP_SCHALTER_ADRESSE"
	envBoxNetz = "VP_SCHALTER_BOX_NETZ"
	// kanalFD: der Kanal zur Stelle ist die erste zusätzliche Datei des Prozesses.
	kanalFD = 3
	// neustartPause: so lange wartet der Dienst, bevor er einen beendeten
	// Schalter neu startet; nach jedem schnellen Ende doppelt so lange, bis
	// neustartPauseMax.
	neustartPause    = 5 * time.Second
	neustartPauseMax = 5 * time.Minute
)

// Betreibe hält den Schalter am Laufen, bis ctx endet: starten, über den
// Kanal bedienen, bei einem Ende neu starten. Der Abgleich von Peers und
// Fenstern hängt nicht daran - fällt der Schalter aus, bekommt nur keine Box
// eine Liste.
func (s *Stelle) Betreibe(ctx context.Context, programm string, adresse netip.AddrPort) {
	pause := neustartPause
	for ctx.Err() == nil {
		start := time.Now()
		err := s.einSchalter(ctx, programm, adresse)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			pause = neustartPause
		}
		s.Log.Error("Schlüsselausgabe: Schalter beendet, neuer Start folgt", "fehler", err, "pause", pause)
		select {
		case <-ctx.Done():
		case <-time.After(pause):
		}
		pause = min(2*pause, neustartPauseMax)
	}
}

func (s *Stelle) einSchalter(ctx context.Context, programm string, adresse netip.AddrPort) error {
	paar, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("Kanal anlegen: %w", err)
	}
	hier := os.NewFile(uintptr(paar[0]), "kanal-stelle")
	dort := os.NewFile(uintptr(paar[1]), "kanal-schalter")
	kanal, err := net.FileConn(hier)
	hier.Close()
	if err != nil {
		dort.Close()
		return fmt.Errorf("Kanal anlegen: %w", err)
	}
	defer kanal.Close()

	cmd := exec.Command(programm, SchalterBefehl)
	// Nur was der Schalter braucht - keine Zugangsdaten, kein Zustandsverzeichnis.
	cmd.Env = []string{envAdresse + "=" + adresse.String(), envBoxNetz + "=" + s.BoxNetz.String()}
	cmd.Stderr = os.Stderr
	cmd.ExtraFiles = []*os.File{dort}
	err = cmd.Start()
	dort.Close()
	if err != nil {
		return fmt.Errorf("Schalter starten: %w", err)
	}
	fertig := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
		case <-fertig:
		}
		// Ohne Kanal hört der Schalter von selbst auf; das Signal nur zur Sicherheit.
		kanal.Close()
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}()
	fehler := s.Bediene(ctx, kanal)
	close(fertig)
	warten := cmd.Wait()
	if fehler == nil {
		fehler = warten
	}
	return fehler
}

// SchalterHaupt ist der Prozess des Schalters: Rechte ablegen, im Tunnel
// lauschen, Dateizugriff sperren, bedienen. Rückgabe ist der Exit-Code.
func SchalterHaupt(log *slog.Logger) int {
	// Als Erstes, vor jedem Byte aus dem Tunnel.
	if err := LegeRechteAb(); err != nil {
		log.Error("Schlüsselausgabe: Schalter startet nicht", "fehler", err)
		return 1
	}
	adresse, err1 := netip.ParseAddrPort(os.Getenv(envAdresse))
	boxNetz, err2 := netip.ParsePrefix(os.Getenv(envBoxNetz))
	datei := os.NewFile(kanalFD, "kanal")
	if err1 != nil || err2 != nil || datei == nil {
		log.Error("Schlüsselausgabe: der Schalter wird nur vom Dienst gestartet (" + SchalterBefehl + " ist kein Befehl für die Hand)")
		return 2
	}
	kanal, err := net.FileConn(datei)
	datei.Close()
	if err != nil {
		log.Error("Schlüsselausgabe: kein Kanal zum Dienst", "fehler", err)
		return 2
	}
	defer kanal.Close()

	l, err := net.Listen("tcp4", adresse.String())
	if err != nil {
		log.Error("Schlüsselausgabe: Schalter kann nicht lauschen", "adresse", adresse, "fehler", err)
		return 1
	}
	defer l.Close()

	// Die Zeitzone jetzt laden: nach der Sperre ist /etc/localtime nicht mehr lesbar.
	_ = time.Now().Local().Format(time.RFC3339)
	dateien := "gesperrt"
	if err := SperreDateien(); err != nil {
		dateien = "nicht gesperrt (" + err.Error() + ")"
	}
	log.Info("Schlüsselausgabe lauscht", "adresse", adresse, "boxNetz", boxNetz, "rechte", "keine",
		"dateizugriff", dateien, "pid", strconv.Itoa(os.Getpid()))
	if os.Geteuid() == 0 {
		log.Warn("Schlüsselausgabe: der Dienst läuft als root; der Schalter hat seine Rechte abgelegt, bleibt aber root. Vorgesehen ist ein eigener Benutzer (deploy/vp-tunnel-dienst.service)")
	}

	schalter := NeuerSchalter(kanal, boxNetz, log)
	if err := schalter.anschluss.sende("bereit\n"); err != nil {
		log.Error("Schlüsselausgabe: kein Kanal zum Dienst", "fehler", err)
		return 1
	}
	if err := schalter.Bedienen(context.Background(), l); err != nil {
		log.Error("Schlüsselausgabe: Schalter beendet", "fehler", err)
		return 1
	}
	return 0
}
