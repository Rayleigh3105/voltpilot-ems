// Package abholer fragt die Schlüsselausgabe des Wartungsservers, wessen
// SSH-Schlüssel sich gerade an dieser Box anmelden darf
// (docs/contracts/fernwartung-schluessel-v1.md), und übernimmt jede gültige
// Antwort in den Bestand.
//
// Regeln:
//   - Gefragt wird nur durch den Tunnel: Der Abholer hat keinen anderen Weg
//     als den, den der Tunnel ihm gibt.
//   - Nur eine vollständige, formgerechte Antwort 200 gilt. Alles andere
//     ändert den Stand der Box nicht: Es kommt nichts dazu, und was da ist,
//     verfällt zu seiner Frist (die führt der Bestand, nicht der Abholer).
//   - Die Box nennt den Prüfwert einer Antwort erst, nachdem sie diese geprüft
//     und übernommen hat.
//   - Vor einer Frist fragt die Box wieder: Das Fenster kann verlängert
//     worden sein.
package abholer

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/vertrag"
)

// Bestand ist, was der Abholer vom Bestand der Schlüssel braucht.
type Bestand interface {
	Uebernimm(vertrag.Liste) bool
	NaechsteFrist() (time.Duration, bool)
}

// Abholer ist der Dauerlauf.
type Abholer struct {
	// Dial öffnet eine Verbindung durch den Tunnel.
	Dial    func(ctx context.Context, ziel netip.AddrPort) (net.Conn, error)
	Server  netip.AddrPort // Schlüsselausgabe: Server-Adresse im Techniker-Netz
	Bestand Bestand
	// Uebernommen wird nach jeder übernommenen Antwort gerufen (anders: die
	// Zugänge haben sich geändert).
	Uebernommen func(anders bool)
	// Melde bekommt den Wechsel des Zustands, nicht jeden Durchgang.
	Melde func(string)

	Warte   time.Duration // längstes Halten am Server (0: 45 s; höchstens 300 s)
	Vorlauf time.Duration // so lange vor einer Frist fragt die Box wieder (0: 5 s)
	Pause   time.Duration // nach einer Anfrage ohne gültige Antwort (0: 5 s)

	mu      sync.Mutex
	zuletzt time.Time // letzte gültige Antwort (monotone Uhr)
	grund   string    // warum die letzte Anfrage keine gültige Antwort brachte
}

// Stand: wann zuletzt eine gültige Antwort kam (ok false: seit dem Start
// keine) und warum die letzte Anfrage keine brachte (leer: sie brachte eine).
func (a *Abholer) Stand() (seit time.Duration, ok bool, grund string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.zuletzt.IsZero() {
		return 0, false, a.grund
	}
	return time.Since(a.zuletzt), true, a.grund
}

func (a *Abholer) zeiten() (warte, vorlauf, pause time.Duration) {
	warte, vorlauf, pause = a.Warte, a.Vorlauf, a.Pause
	if warte <= 0 {
		warte = 45 * time.Second
	}
	if warte > 300*time.Second {
		warte = 300 * time.Second // mehr lässt der Server nicht zu
	}
	if vorlauf <= 0 {
		vorlauf = 5 * time.Second
	}
	if pause <= 0 {
		pause = 5 * time.Second
	}
	return
}

// Laufe fragt, bis ctx endet.
func (a *Abholer) Laufe(ctx context.Context) {
	melde := a.Melde
	if melde == nil {
		melde = func(string) {}
	}
	_, _, pause := a.zeiten()
	kennung := ""
	zustand := "start"
	for ctx.Err() == nil {
		w := a.wartezeit()
		l, err := a.frage(ctx, w, kennung)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			grund := err.Error()
			a.mu.Lock()
			a.grund = grund
			a.mu.Unlock()
			if zustand != grund {
				melde(grund)
			}
			zustand = grund
			schlafe(ctx, pause)
			continue
		}
		anders := a.Bestand.Uebernimm(l)
		kennung = l.Pruefwert
		a.mu.Lock()
		a.zuletzt, a.grund = time.Now(), ""
		a.mu.Unlock()
		if zustand != "ok" {
			melde("Wartungsserver antwortet (" + a.Server.String() + " durch den Tunnel)")
		}
		zustand = "ok"
		if a.Uebernommen != nil {
			a.Uebernommen(anders)
		}
		if w < time.Second {
			// Kurz vor einer Frist antwortet der Server sofort: nicht im Kreis fragen.
			schlafe(ctx, 2*time.Second)
		}
	}
}

// wartezeit: So lange hält die nächste Anfrage am Server, nicht länger als
// bis kurz vor die nächste Frist.
func (a *Abholer) wartezeit() time.Duration {
	warte, vorlauf, _ := a.zeiten()
	if rest, ok := a.Bestand.NaechsteFrist(); ok {
		d := rest - vorlauf
		if d < 0 {
			d = 0
		}
		if d < warte {
			warte = d
		}
	}
	return warte.Truncate(time.Second)
}

// frage stellt eine Anfrage: eine Verbindung, eine Antwort.
func (a *Abholer) frage(ctx context.Context, warte time.Duration, kennung string) (vertrag.Liste, error) {
	ctx, ende := context.WithTimeout(ctx, warte+15*time.Second)
	defer ende()
	tr := &http.Transport{
		Proxy:             nil, // kein Proxy, auch nicht aus der Umgebung
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return a.Dial(ctx, a.Server)
		},
	}
	defer tr.CloseIdleConnections()
	url := fmt.Sprintf("http://%s/v1/schluessel?warte=%d&stand=%s", a.Server, int(warte/time.Second), kennung)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return vertrag.Liste{}, err
	}
	antwort, err := (&http.Client{Transport: tr}).Do(req)
	if err != nil {
		return vertrag.Liste{}, fmt.Errorf("keine Antwort von %s (Tunnel ohne Handshake oder Schluesselausgabe am Server aus)", a.Server)
	}
	defer antwort.Body.Close()
	if antwort.StatusCode != http.StatusOK {
		return vertrag.Liste{}, errors.New(statusGrund(a.Server, antwort.StatusCode))
	}
	// Eine Antwort ab MaxBytes ist keine: nicht mehr lesen, als dafür nötig.
	daten, err := io.ReadAll(io.LimitReader(antwort.Body, vertrag.MaxBytes))
	if err != nil {
		return vertrag.Liste{}, fmt.Errorf("Antwort von %s abgerissen", a.Server)
	}
	if len(daten) >= vertrag.MaxBytes {
		return vertrag.Liste{}, errors.New("Antwort verworfen (zu gross)")
	}
	l, err := vertrag.Pruefe(daten)
	if err != nil {
		return vertrag.Liste{}, errors.New("Antwort verworfen (Form) - nichts uebernommen")
	}
	return l, nil
}

func statusGrund(server netip.AddrPort, code int) string {
	switch code {
	case http.StatusServiceUnavailable:
		return fmt.Sprintf("%s gibt keine Liste aus (503: kein frischer Soll-Stand am Wartungsserver)", server)
	case http.StatusTooManyRequests:
		return fmt.Sprintf("Anfrage an %s abgeloest (429: eine neuere Anfrage dieser Box)", server)
	case http.StatusForbidden:
		return fmt.Sprintf("%s weist die Box ab (403: der Absender ist keine Box-Adresse)", server)
	}
	return fmt.Sprintf("%s antwortet mit %d", server, code)
}

func schlafe(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
