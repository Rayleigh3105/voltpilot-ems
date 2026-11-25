// Package wlanstand traegt die WLAN-Skripte von Edge Light
// (wlan-anschluss.sh, einrichtung-wlan.sh) als eingebettete Kopien im
// Programm und spielt sie in den Flash ein, damit Fixes an ihnen jede Box ueber
// den normalen signierten Update-Weg erreichen - ohne Werkstatt und ohne
// Wartungstunnel (Muster: internal/loaderstand, agent/loader_pflege.go).
//
// Ueber diese Skripte haengt eine WLAN-Box am Netz, und der Wartungstunnel
// laeuft darueber. Deshalb gilt beim Einspielen (jede Regel mit Test belegt):
//
//  1. Kein Rueckschritt: eingespielt wird nur, wenn der eingebettete Stand
//     NEUER ist als die WLAN_STAND-Marke von wlan-anschluss.sh im Flash
//     (keine Marke = 0). Ein Stand gilt fuer beide Skripte.
//  2. Nur ersetzen, nie einrichten: fehlt wlan-anschluss.sh, schreibt der Lauf
//     nichts; fehlt einrichtung-wlan.sh, bleibt sie weg (ihr cron-Eintrag kommt
//     nur mit install.sh). Konfiguration, cron, Hotplug-Haken und Tunnel fasst
//     der Lauf nie an.
//  3. Nie eine halbe Fassung: jede Datei ueber internal/flashdatei (.neu,
//     fsync, zuruecklesen, Pruefsumme, atomar umbenennen); vor dem Umbenennen
//     muss die neue Fassung `sh -n` bestehen.
//  4. Die alte Fassung bleibt als Rueckfall daneben liegen (<skript>.alt).
//  5. Flash schonen: geschrieben wird nur, was sich aendert (einrichtung-wlan.sh
//     nur bei anderem Inhalt, eine .alt nur, wenn sie nicht schon die alte
//     Fassung ist); ein zweiter Lauf schreibt nichts.
//  6. Nichts startet neu: kein verbinden, kein ifup, kein Netz-Neustart. Die
//     neue Fassung wirkt beim naechsten Takt (cron) oder ifup. Nach dem Ersetzen
//     von wlan-anschluss.sh ruft der Lauf einmal `wlan-anschluss.sh wege` - das
//     ergaenzt nur die eigenen Wege der Box zu ihren Geraeten und tut am
//     Kabelweg nichts.
//
// Reihenfolge: einrichtung-wlan.sh zuerst, wlan-anschluss.sh (der Stand-Traeger)
// zuletzt. Strom weg dazwischen laesst den alten Stand stehen, und der naechste
// Lauf holt den Rest nach. Die neue einrichtung-wlan.sh vertraegt die alte
// wlan-anschluss.sh (deren unbekanntes `wege` scheitert still).
//
// Die Kopien hier muessen byte-gleich mit den Quellen unter
// edge-light/openwrt/files/ sein, und JEDE Aenderung braucht einen neuen Stand
// samt Zeile in stand-verlauf - beides erzwingt der Test dieses Pakets.
package wlanstand

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/flashdatei"
)

//go:embed wlan-anschluss.sh
var anschlussSH []byte

//go:embed einrichtung-wlan.sh
var einrichtungSH []byte

var standZeile = regexp.MustCompile(`(?m)^WLAN_STAND=([0-9]+)$`)

const (
	// EinrichtungName ist der Waechter des Einrichtungs-WLANs; er liegt neben
	// wlan-anschluss.sh (install.sh legt beide nebeneinander).
	EinrichtungName = "einrichtung-wlan.sh"
	// Alt ist die Endung der vorigen Fassung, die neben der neuen liegen
	// bleibt (Rueckfall von Hand: mv <skript>.alt <skript>).
	Alt = ".alt"

	// syntaxZeit begrenzt `sh -n` (Millisekunden auf der Mango).
	syntaxZeit = 20 * time.Second
	// wegeZeit begrenzt `wlan-anschluss.sh wege` (liest ip rule/route).
	wegeZeit = 30 * time.Second
)

// Anschluss ist das eingebettete wlan-anschluss.sh (Kopie von
// edge-light/openwrt/files/usr/libexec/vp-edge-light/wlan-anschluss.sh).
func Anschluss() []byte { return append([]byte(nil), anschlussSH...) }

// Einrichtung ist das eingebettete einrichtung-wlan.sh (Kopie von
// edge-light/openwrt/files/usr/libexec/vp-edge-light/einrichtung-wlan.sh).
func Einrichtung() []byte { return append([]byte(nil), einrichtungSH...) }

// Stand liest die WLAN_STAND-Marke von wlan-anschluss.sh; 0 heisst: keine
// Marke (ein Stand vor der Marke) oder unlesbar - ein solcher Stand wird nie
// eingespielt.
func Stand(skript []byte) int {
	m := standZeile.FindSubmatch(skript)
	if m == nil {
		return 0
	}
	n, err := strconv.Atoi(string(m[1]))
	if err != nil || n < 1 {
		return 0
	}
	return n
}

// EingebetteterStand ist der Stand der eingebetteten Kopien.
func EingebetteterStand() int { return Stand(anschlussSH) }

// Ergebnis beschreibt einen Lauf von Pflege.Lauf.
type Ergebnis struct {
	// Vorher ist der Stand im Flash vor dem Lauf, Nachher danach (0 = keine
	// Marke).
	Vorher, Nachher int
	// KeinSkript: am Pfad liegt kein wlan-anschluss.sh - nichts eingerichtet.
	KeinSkript bool
	// Geschrieben nennt die ersetzten Skripte (ohne ihre .alt); leer = der
	// Lauf hat nichts geschrieben.
	Geschrieben []string
	// Wege ist die Ausgabe von `wlan-anschluss.sh wege` nach dem Ersetzen
	// (etwa "ergaenzt=192.168.2.169"), WegeFehler sein Fehler; beide leer,
	// wenn wlan-anschluss.sh nicht ersetzt wurde.
	Wege, WegeFehler string
}

// Pflege spielt die eingebetteten WLAN-Skripte ein (siehe Paket).
type Pflege struct {
	// Anschluss ist der Pfad von wlan-anschluss.sh (Config.WlanSkript);
	// einrichtung-wlan.sh liegt daneben.
	Anschluss string
	// Shell prueft eine neue Fassung vor dem Ersetzen mit -n; "" = /bin/sh.
	Shell string
	// NachSchreiben (Testnaht, nil = echt): flashdatei.Optionen.NachSchreiben
	// fuer die beiden Skripte.
	NachSchreiben func(tmp string)

	// sollAnschluss/sollEinrichtung ersetzen die eingebetteten Kopien (nur
	// fuer die Tests dieses Pakets).
	sollAnschluss, sollEinrichtung []byte
}

func (p *Pflege) soll() (anschluss, einrichtung []byte) {
	if p.sollAnschluss != nil {
		return p.sollAnschluss, p.sollEinrichtung
	}
	return anschlussSH, einrichtungSH
}

// Lauf prueft einmal, spielt noetigenfalls ein und ruft nach dem Ersetzen von
// wlan-anschluss.sh einmal dessen `wege`. Ein Fehler heisst: nicht (ganz)
// eingespielt, ein weiterer Lauf holt es nach; was schon ersetzt ist, bleibt.
func (p *Pflege) Lauf(ctx context.Context) (Ergebnis, error) {
	erg, err := p.einspielen()
	if err != nil || !erg.anschlussErsetzt(p.Anschluss) {
		return erg, err
	}
	wctx, cancel := context.WithTimeout(ctx, wegeZeit)
	defer cancel()
	aus, werr := exec.CommandContext(wctx, p.Anschluss, "wege").CombinedOutput()
	erg.Wege = strings.TrimSpace(string(aus))
	if werr != nil {
		erg.WegeFehler = werr.Error()
	}
	return erg, nil
}

func (e Ergebnis) anschlussErsetzt(pfad string) bool {
	for _, g := range e.Geschrieben {
		if g == pfad {
			return true
		}
	}
	return false
}

func (p *Pflege) einspielen() (Ergebnis, error) {
	anschlussSoll, einrichtungSoll := p.soll()
	soll := Stand(anschlussSoll)
	if soll < 1 {
		// Ohne Marke wuerde jede Box auf Stand 0 gezogen - der Test dieses
		// Pakets erzwingt die Marke, das hier ist der Gurt zum Hosentraeger.
		return Ergebnis{}, errors.New("die eingebettete Fassung traegt keinen WLAN_STAND - nichts wird eingespielt")
	}
	ist, err := os.ReadFile(p.Anschluss)
	if errors.Is(err, fs.ErrNotExist) {
		return Ergebnis{KeinSkript: true}, nil
	}
	if err != nil {
		return Ergebnis{}, err
	}
	erg := Ergebnis{Vorher: Stand(ist), Nachher: Stand(ist)}
	if erg.Vorher >= soll {
		return erg, nil
	}
	einrichtung := filepath.Join(filepath.Dir(p.Anschluss), EinrichtungName)
	switch alt, rerr := os.ReadFile(einrichtung); {
	case errors.Is(rerr, fs.ErrNotExist):
		// nie einrichten
	case rerr != nil:
		return erg, fmt.Errorf("%s: %w", EinrichtungName, rerr)
	case !bytes.Equal(alt, einrichtungSoll):
		if werr := p.ersetzen(einrichtung, alt, einrichtungSoll); werr != nil {
			return erg, fmt.Errorf("%s: %w", EinrichtungName, werr)
		}
		erg.Geschrieben = append(erg.Geschrieben, einrichtung)
	}
	if werr := p.ersetzen(p.Anschluss, ist, anschlussSoll); werr != nil {
		return erg, fmt.Errorf("%s: %w", filepath.Base(p.Anschluss), werr)
	}
	erg.Geschrieben = append(erg.Geschrieben, p.Anschluss)
	erg.Nachher = soll
	return erg, nil
}

// ersetzen legt zuerst die bisherige Fassung als Rueckfall daneben (nur wenn
// sie dort nicht schon liegt) und ersetzt dann das Skript - geprueft mit
// sh -n, bevor es umbenannt wird.
func (p *Pflege) ersetzen(pfad string, alt, neu []byte) error {
	if da, err := os.ReadFile(pfad + Alt); err != nil || !bytes.Equal(da, alt) {
		if werr := flashdatei.Ersetzen(pfad+Alt, alt, flashdatei.Optionen{}); werr != nil {
			return fmt.Errorf("Rueckfall %s: %w", filepath.Base(pfad+Alt), werr)
		}
	}
	return flashdatei.Ersetzen(pfad, neu, flashdatei.Optionen{NachSchreiben: p.NachSchreiben, Pruefe: p.syntax})
}

func (p *Pflege) syntax(tmp string) error {
	shell := p.Shell
	if shell == "" {
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), syntaxZeit)
	defer cancel()
	if aus, err := exec.CommandContext(ctx, shell, "-n", tmp).CombinedOutput(); err != nil {
		return fmt.Errorf("%s -n: %v: %s", shell, err, strings.TrimSpace(string(aus)))
	}
	return nil
}
