// Package lauf führt den Lauf einer Box: eine feste Folge von Schritten, in
// der jeder Schritt mit einem Beleg aus der echten Ausgabe endet. Fehlt der
// Beleg oder scheitert der Schritt, hält der Lauf an; ein Weitermachen ohne
// Beleg gibt es nicht. Übersprungen wird nichts.
//
// Zustände: laeuft → (wartet ↔ laeuft) → fertig | angehalten.
// Jeder Übergang steht als Zeile im Schritt-Protokoll (internal/protokoll).
package lauf

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// Zustand eines Laufs.
type Zustand string

const (
	Laeuft     Zustand = "laeuft"
	Wartet     Zustand = "wartet"
	Fertig     Zustand = "fertig"
	Angehalten Zustand = "angehalten"
)

// VorgabeFrist gilt für einen Schritt ohne eigene Frist.
const VorgabeFrist = 10 * time.Minute

// Schritt ist ein Schritt des Laufs.
type Schritt struct {
	Kennung string // fest, klein: "erkennen", "openwrt", …
	Titel   string // in Alltagsworten, für die Anzeige
	Frist   time.Duration
	Tun     func(ctx context.Context, k *Kontext) (protokoll.Beleg, error)
}

// Handgriff heißt: Ohne einen Menschen geht es nicht weiter (Reset-Knopf,
// zweites Gerät am Werkstatt-Anschluss). Der Lauf hält an und zeigt Was.
type Handgriff struct {
	Was   string // was der Mensch tun soll
	Grund string // was passiert ist
}

func (h Handgriff) Error() string { return h.Grund + " – " + h.Was }

// Stand ist eine Momentaufnahme des Laufs für Anzeige und Metriken.
type Stand struct {
	Kennung  string `json:"kennung"`
	Freigabe string `json:"freigabe"`
	BoxArt   string `json:"box_art"`
	// Box ist die Kennung der Box, sobald sie feststeht (für die Bildschirme).
	Box       string    `json:"box,omitempty"`
	Beginn    time.Time `json:"beginn"`
	Ende      time.Time `json:"ende,omitzero"`
	Zustand   Zustand   `json:"zustand"`
	Schritt   string    `json:"schritt,omitempty"`
	Titel     string    `json:"titel,omitempty"`
	Erledigt  []string  `json:"erledigt"`
	Grund     string    `json:"grund,omitempty"`
	Handgriff string    `json:"handgriff,omitempty"`
	WartetAuf string    `json:"wartet_auf,omitempty"`
	Hinweis   string    `json:"hinweis,omitempty"`
}

// Lauf ist der Lauf einer Box.
type Lauf struct {
	mu      sync.Mutex
	stand   Stand
	eingabe chan eingabe
	werte   map[string]string
}

type eingabe struct{ name, wert string }

// Neu legt einen Lauf an. Die Kennung beginnt mit dem Zeitpunkt (UTC), so
// sortieren sich die Protokolle von selbst.
func Neu(jetzt time.Time, freigabe, boxArt string) *Lauf {
	var z [2]byte
	_, _ = rand.Read(z[:])
	k := jetzt.UTC().Format("2006-01-02-150405") + "-" + hex.EncodeToString(z[:])
	return &Lauf{
		stand:   Stand{Kennung: k, Freigabe: freigabe, BoxArt: boxArt, Beginn: jetzt.UTC(), Zustand: Laeuft, Erledigt: []string{}},
		eingabe: make(chan eingabe),
		werte:   map[string]string{},
	}
}

// Kennung des Laufs.
func (l *Lauf) Kennung() string { return l.stand.Kennung }

// Stand gibt eine Kopie des aktuellen Stands.
func (l *Lauf) Stand() Stand {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.stand
	// Nie nil: eine nil-Liste ginge als null ans Portal, der Vertrag sagt Liste
	// (werkstatt-ansicht-v1, Werkbank-Absturz vom 04.11.2026).
	s.Erledigt = append([]string{}, l.stand.Erledigt...)
	return s
}

func (l *Lauf) aendere(f func(*Stand)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	f(&l.stand)
	// Der Stand geht an die Anzeige: Texte aus Fehlern und Ausgaben schwärzen.
	l.stand.Grund = geheim.Schwaerze(l.stand.Grund)
	l.stand.Handgriff = geheim.Schwaerze(l.stand.Handgriff)
	l.stand.Hinweis = geheim.Schwaerze(l.stand.Hinweis)
}

// Gib reicht eine Eingabe an einen wartenden Schritt (etwa die Tunnel-Adresse
// aus dem Portal). Fehler, wenn der Lauf nicht genau darauf wartet.
func (l *Lauf) Gib(ctx context.Context, name, wert string) error {
	s := l.Stand()
	if s.Zustand != Wartet || s.WartetAuf != name {
		return fmt.Errorf("Lauf %s wartet nicht auf %q", s.Kennung, name)
	}
	select {
	case l.eingabe <- eingabe{name: name, wert: wert}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(5 * time.Second):
		return fmt.Errorf("Lauf %s nimmt die Eingabe nicht an", s.Kennung)
	}
}

// Kontext bekommt jeder Schritt.
type Kontext struct {
	Lauf    *Lauf
	Log     *slog.Logger
	ablage  *protokoll.Ablage
	schritt string
}

// Box nennt die Kennung der Box im Stand, sobald sie feststeht.
func (k *Kontext) Box(ref string) {
	k.Lauf.aendere(func(s *Stand) { s.Box = ref })
}

// Merke hält einen Wert für spätere Schritte fest (MAC, Host-Schlüssel,
// Referenz). Nur Werte, die keine Geheimnisse sind.
func (k *Kontext) Merke(name, wert string) {
	k.Lauf.mu.Lock()
	defer k.Lauf.mu.Unlock()
	k.Lauf.werte[name] = wert
}

// Wert gibt einen gemerkten Wert zurück.
func (k *Kontext) Wert(name string) (string, bool) {
	k.Lauf.mu.Lock()
	defer k.Lauf.mu.Unlock()
	v, ok := k.Lauf.werte[name]
	return v, ok
}

// Warte stellt den Lauf auf „wartet“, bis jemand mit Lauf.Gib den Wert name
// liefert, und schreibt beides ins Protokoll.
func (k *Kontext) Warte(ctx context.Context, name, hinweis string) (string, error) {
	k.Lauf.aendere(func(s *Stand) { s.Zustand, s.WartetAuf, s.Hinweis = Wartet, name, hinweis })
	defer k.Lauf.aendere(func(s *Stand) { s.Zustand, s.WartetAuf, s.Hinweis = Laeuft, "", "" })
	if err := k.ablage.Schreibe(protokoll.Eintrag{Lauf: k.Lauf.Kennung(), Art: protokoll.Wartet, Schritt: k.schritt, Grund: hinweis, Angaben: map[string]string{"auf": name}}); err != nil {
		return "", err
	}
	k.Log.Info("Lauf wartet", "auf", name, "hinweis", hinweis)
	for {
		select {
		case e := <-k.Lauf.eingabe:
			if e.name != name {
				continue
			}
			if err := k.ablage.Schreibe(protokoll.Eintrag{Lauf: k.Lauf.Kennung(), Art: protokoll.Eingabe, Schritt: k.schritt, Angaben: map[string]string{name: e.wert}}); err != nil {
				return "", err
			}
			return e.wert, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

// Laeufer führt Läufe aus.
type Laeufer struct {
	Ablage *protokoll.Ablage
	Log    *slog.Logger
	Jetzt  func() time.Time

	dauer metriken.Messwert
	ende  metriken.Zaehler
	aktiv metriken.Messwert
}

// NeuerLaeufer legt einen Läufer an und meldet seine Metriken an.
func NeuerLaeufer(ablage *protokoll.Ablage, log *slog.Logger, reg *metriken.Register) *Laeufer {
	l := &Laeufer{
		Ablage: ablage,
		Log:    log,
		Jetzt:  time.Now,
		dauer:  reg.Messwert("vp_werkstatt_schritt_letzte_dauer_seconds", "Dauer des letzten belegten Schritts dieser Art (Prüfstein PS-3).", "schritt"),
		ende:   reg.Zaehler("vp_werkstatt_laeufe_total", "Beendete Läufe nach Ergebnis.", "ergebnis"),
		aktiv:  reg.Messwert("vp_werkstatt_lauf_aktiv", "1, solange ein Lauf an einer Box arbeitet."),
	}
	l.ende.Null(string(Fertig))
	l.ende.Null(string(Angehalten))
	l.aktiv.Setze(0)
	return l
}

// Fahre führt die Schritte nacheinander aus und gibt den Endzustand zurück.
// angaben steht im ersten Eintrag des Protokolls (Freigabe, Fassungen).
func (r *Laeufer) Fahre(ctx context.Context, l *Lauf, angaben map[string]string, schritte []Schritt) Zustand {
	log := r.Log.With("request_id", l.Kennung())
	r.aktiv.Setze(1)
	defer r.aktiv.Setze(0)
	s := l.Stand()
	a := map[string]string{"freigabe": s.Freigabe, "box_art": s.BoxArt}
	for k, v := range angaben {
		a[k] = v
	}
	if err := r.Ablage.Schreibe(protokoll.Eintrag{Zeit: r.Jetzt().UTC(), Lauf: l.Kennung(), Art: protokoll.LaufBegonnen, Angaben: a}); err != nil {
		log.Error("Protokoll nicht schreibbar, Lauf beginnt nicht", "fehler", err)
		return r.beende(l, log, Angehalten, "", fmt.Sprintf("Protokoll nicht schreibbar: %v", err), "")
	}
	log.Info("Lauf begonnen", "freigabe", s.Freigabe, "box_art", s.BoxArt)
	for _, st := range schritte {
		zustand, grund, handgriff := r.schritt(ctx, l, log, st)
		if zustand != Laeuft {
			return r.beende(l, log, zustand, st.Kennung, grund, handgriff)
		}
	}
	return r.beende(l, log, Fertig, "", "", "")
}

func (r *Laeufer) schritt(ctx context.Context, l *Lauf, log *slog.Logger, st Schritt) (zustand Zustand, grund, handgriff string) {
	log = log.With("schritt", st.Kennung)
	l.aendere(func(s *Stand) { s.Schritt, s.Titel = st.Kennung, st.Titel })
	beginn := r.Jetzt()
	if err := r.Ablage.Schreibe(protokoll.Eintrag{Zeit: beginn.UTC(), Lauf: l.Kennung(), Art: protokoll.SchrittBegonnen, Schritt: st.Kennung}); err != nil {
		return Angehalten, fmt.Sprintf("Protokoll nicht schreibbar: %v", err), ""
	}
	log.Info("Schritt begonnen", "titel", st.Titel)
	frist := st.Frist
	if frist <= 0 {
		frist = VorgabeFrist
	}
	sctx, cancel := context.WithTimeout(ctx, frist)
	defer cancel()
	beleg, err := tue(sctx, st, &Kontext{Lauf: l, Log: log, ablage: r.Ablage, schritt: st.Kennung})
	dauer := r.Jetzt().Sub(beginn)
	if err == nil && beleg.Leer() {
		err = errors.New("Schritt ohne Beleg: der Dienst hält an")
	}
	if err != nil {
		var h Handgriff
		switch {
		case errors.As(err, &h):
			handgriff = h.Was
			grund = h.Grund
		case ctx.Err() != nil:
			grund = "Der Dienst wurde beendet, der Lauf hält an."
		case errors.Is(err, context.DeadlineExceeded) || sctx.Err() != nil:
			grund = fmt.Sprintf("Frist von %s überschritten: %v", frist, err)
		default:
			grund = err.Error()
		}
		e := protokoll.Eintrag{Zeit: r.Jetzt().UTC(), Lauf: l.Kennung(), Art: protokoll.SchrittGescheitert, Schritt: st.Kennung, Grund: grund, Beleg: beleg, DauerSek: dauer.Seconds()}
		if handgriff != "" {
			e.Angaben = map[string]string{"handgriff": handgriff}
		}
		if werr := r.Ablage.Schreibe(e); werr != nil {
			log.Error("Protokoll nicht schreibbar", "fehler", werr)
		}
		log.Warn("Schritt gescheitert", "grund", grund)
		return Angehalten, grund, handgriff
	}
	if err := r.Ablage.Schreibe(protokoll.Eintrag{Zeit: r.Jetzt().UTC(), Lauf: l.Kennung(), Art: protokoll.SchrittBelegt, Schritt: st.Kennung, Beleg: beleg, DauerSek: dauer.Seconds()}); err != nil {
		return Angehalten, fmt.Sprintf("Protokoll nicht schreibbar: %v", err), ""
	}
	r.dauer.Setze(dauer.Seconds(), st.Kennung)
	l.aendere(func(s *Stand) { s.Erledigt = append(s.Erledigt, st.Kennung) })
	log.Info("Schritt belegt", "dauer_s", fmt.Sprintf("%.1f", dauer.Seconds()))
	return Laeuft, "", ""
}

// tue ruft den Schritt auf; eine Panik hält den Lauf an statt den Dienst.
func tue(ctx context.Context, st Schritt, k *Kontext) (b protokoll.Beleg, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("Fehler im Dienst (%v)", p)
		}
	}()
	return st.Tun(ctx, k)
}

func (r *Laeufer) beende(l *Lauf, log *slog.Logger, z Zustand, schritt, grund, handgriff string) Zustand {
	ende := r.Jetzt().UTC()
	l.aendere(func(s *Stand) {
		s.Zustand, s.Grund, s.Handgriff, s.Ende = z, grund, handgriff, ende
		if z == Fertig {
			s.Schritt, s.Titel = "", ""
		}
	})
	if err := r.Ablage.Schreibe(protokoll.Eintrag{Zeit: ende, Lauf: l.Kennung(), Art: protokoll.LaufBeendet, Schritt: schritt, Zustand: string(z), Grund: grund}); err != nil {
		log.Error("Protokoll nicht schreibbar", "fehler", err)
	}
	r.ende.Plus(string(z))
	if z == Fertig {
		log.Info("Lauf fertig")
	} else {
		log.Warn("Lauf angehalten", "schritt", schritt, "grund", grund)
	}
	return z
}
