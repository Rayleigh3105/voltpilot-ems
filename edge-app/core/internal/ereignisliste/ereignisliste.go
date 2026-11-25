// Package ereignisliste führt eine Ereignisliste auf dem Flash der Box: nur,
// wenn ein Ereignis dazukam, mit fester Obergrenze, nie ein Schlüssel. Erster
// Nutzer ist der Direktvermarktungs-Anschluss (vp-direktvermarktung-konzept d2
// §5.4 "Nachweis": Ereignisliste im Flash).
//
// Zeilenformat, Obergrenzen und Schlüssel-Maskierung sind der Go-Zwilling der
// Fernwartungs-Liste (edge-industrie/wartung/internal/ereignisse - ein eigenes
// Go-Modul, das dieser Core nicht importieren kann; die Shell-Fassung der
// Mango ist edge-light/openwrt/.../vp-wartung/schluessel-holen.sh). Die drei
// Fassungen teilen dieselben Konstanten 250/200/400.
package ereignisliste

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	Max     = 250 // mehr Zeilen hat die Liste nie
	Bleiben = 200 // so viele bleiben, wenn sie gekürzt wird
	Breite  = 400 // längere Zeilen werden abgeschnitten
)

// So beginnt jeder öffentliche SSH-Schlüssel in Base64 (RSA, Ed25519, ECDSA);
// PEM-Blöcke fängt die zweite Maske. Beide greifen nur als letzte Sicherung -
// die Ereignistexte selbst tragen nie Material.
var (
	schluesselMuster = regexp.MustCompile(`AAAA(B3NzaC1|C3NzaC1|E2VjZHNh)`)
	pemMuster        = regexp.MustCompile(`-----BEGIN [A-Z ]+-----`)
)

// Liste schreibt die Ereignisliste. Der Nullwert schreibt nichts.
type Liste struct {
	Pfad  string
	Jetzt func() time.Time // nil: time.Now

	mu       sync.Mutex
	zeilen   int
	gezaehlt bool // zeilen stimmt erst nach dem ersten Lesen der Datei
}

// Schreibe hängt ein Ereignis an. Ein Fehler (Flash voll, Verzeichnis fehlt)
// hält nichts an: Er kommt zurück, damit ihn das Protokoll nennt.
func (l *Liste) Schreibe(text string) error {
	if l == nil || l.Pfad == "" {
		return nil
	}
	if schluesselMuster.MatchString(text) {
		// Nie ein Schlüssel in der Liste, auch nicht durch einen Fehler anderswo.
		text = schluesselMuster.ReplaceAllString(text, "[schluessel]")
	}
	if pemMuster.MatchString(text) {
		text = pemMuster.ReplaceAllString(text, "[schluessel]")
	}
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' {
			return ' '
		}
		return r
	}, text)
	jetzt := time.Now
	if l.Jetzt != nil {
		jetzt = l.Jetzt
	}
	zeile := jetzt().Format("2006-01-02T15:04:05Z07:00") + " " + text
	if len(zeile) > Breite {
		zeile = zeile[:Breite]
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.gezaehlt {
		alt, _ := os.ReadFile(l.Pfad)
		l.zeilen = bytes.Count(alt, []byte("\n"))
		l.gezaehlt = true
	}
	if l.zeilen+1 <= Max {
		f, err := os.OpenFile(l.Pfad, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
		if err != nil {
			return err
		}
		if _, err := f.WriteString(zeile + "\n"); err != nil {
			_ = f.Close()
			return err
		}
		l.zeilen++
		return f.Close()
	}
	// Obergrenze erreicht: Eine gekürzte Fassung ersetzt die Liste in einem
	// Zug, oder es bleibt beim Alten.
	alt, err := os.ReadFile(l.Pfad)
	if err != nil {
		return err
	}
	z := strings.Split(strings.TrimRight(string(alt), "\n"), "\n")
	if len(z) > Bleiben-1 {
		z = z[len(z)-(Bleiben-1):]
	}
	z = append(z, zeile)
	neu := filepath.Join(filepath.Dir(l.Pfad), "."+filepath.Base(l.Pfad)+".neu")
	if err := os.WriteFile(neu, []byte(strings.Join(z, "\n")+"\n"), 0o600); err != nil {
		_ = os.Remove(neu)
		return err
	}
	if err := os.Rename(neu, l.Pfad); err != nil {
		_ = os.Remove(neu)
		return err
	}
	l.zeilen = len(z)
	return nil
}

// Lies gibt die Zeilen der Liste (älteste zuerst); letzte > 0: nur so viele
// vom Ende. Fehlt die Datei, ist die Liste leer.
func Lies(pfad string, letzte int) ([]string, error) {
	daten, err := os.ReadFile(pfad)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	t := strings.TrimRight(string(daten), "\n")
	if t == "" {
		return nil, nil
	}
	z := strings.Split(t, "\n")
	if letzte > 0 && len(z) > letzte {
		z = z[len(z)-letzte:]
	}
	return z, nil
}
