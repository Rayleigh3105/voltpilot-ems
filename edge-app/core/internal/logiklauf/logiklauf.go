// Package logiklauf runs delivered Steuerlogiken on the box (contract
// docs/contracts/v2/steuerlogik.md and steuerlogik-rueckmeldung.md): every
// second the core computes with the box's real inputs and states what it
// would switch.
//
// A logic runs ALONG (Stufe 2) or ARMED ("scharf", Stufe 3). This package
// never switches either way, by construction: it imports neither the arbiter
// (desired) nor any device driver, and its Deps carry only read functions.
// Along, its wishes leave it only as the heartbeat block "logik", the
// comparison log "würde schalten" against "ist geschaltet" (report §3.2,
// §8.4). Armed, the agent reads them through Wuensche and hands them to the
// arbiter - the one place a wish becomes a command (agent/steuerlogik.go).
// logiklauf_test.go holds the import allowlist that keeps it so.
//
// Set values (Stellwerte) arrive with the bundle; the same logic text with
// other values or another mode keeps its run and state - a set value never
// restarts a logic (report §6.6 point 4).
//
// Inputs the box does not deliver are missing as unknown; the core handles
// that by max_age, nothing is invented. A run's remembered state lives
// throttled on disk (logik-laeufe.json) so a restart applies the contract's
// after_restart rules instead of forgetting everything.
package logiklauf

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"
	// The core ships on zoneinfo-less images (Alpine, OpenWrt); clock and
	// time windows of a logic are wall-clock in the SITE timezone.
	_ "time/tzdata"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sonnenstand"
)

const (
	stateFile = "logik-laeufe.json"
	// saveEvery throttles disk writes (Edge Light sits on flash): a run is
	// saved after a state change at most every 30 s, and when the set of
	// logics changes or the box program stops.
	saveEvery = 30 * time.Second
	// MaxWechsel bounds the comparison log per logic in the heartbeat.
	MaxWechsel = 16
	// MaxMeldungen bounds the logic's own notifications per logic in the heartbeat.
	MaxMeldungen = 8
	// MaxLaeufe bounds the logics running along (the deployment budget allows
	// only a few anyway).
	MaxLaeufe = 8
	// DefaultZeitzone is the site time when a delivery names none (the Tag der
	// Anlage of the fleet).
	DefaultZeitzone = "Europe/Berlin"
	// SourceSonne is the input the run computes itself from the site location.
	SourceSonne = "sun.elevation"
)

// Ort is where the plant is: its timezone (clock, time windows, the day) and
// its location (sun elevation). Without a location sun.elevation is unknown.
type Ort struct {
	Zeitzone string
	Breite   *float64
	Laenge   *float64
}

// Auftrag is one verified Steuerlogik artifact to run along.
type Auftrag struct {
	FlowID  string
	Fassung int
	Hash    string
	// Dokument is the canonical JSON of the logic (steuerlogik.md).
	Dokument []byte
	Ort      Ort
	// Scharf: the logic's wishes go to the arbiter (Stufe 3); otherwise it
	// runs along and only reports.
	Scharf bool
	// Stellwerte are the set values in the document's form; a setting not
	// named keeps its default. StellStand is their revision.
	Stellwerte map[string]any
	StellStand int64
}

// Wunsch is what an armed logic wants for one of its devices this beat.
type Wunsch struct {
	FlowID   string
	Fassung  int
	Geraet   string
	EntityID string
	Ausgang  logik.Ausgang
}

// Ist is the observed switch state of a device: the read-back state of its
// outputs. nil = unknown - unknown is never "off".
type Ist struct {
	Stufe *int
	Ein   *bool
	// Sollwert and Betriebsart are the read-back of a device that regulates
	// itself (K2/K3); nil/"" = unknown.
	Sollwert    *float64
	Betriebsart string
}

// Deps wires the run to the box. Read paths only: values, device data and
// observed switch state. No dependency may carry a write path.
type Deps struct {
	DataDir string
	// Quelle reads an input by its source name (site.grid, battery.soc,
	// <entity>.temperature, …). An empty EinWert means unknown.
	Quelle func(source string, now time.Time) logik.EinWert
	// Geraet gives a device's data (outputs, kW per output, setpoint range)
	// and its observed state.
	Geraet func(entityID string, now time.Time) (logik.GeraetStamm, Ist)
	// Jetzt is the clock (tests); nil = time.Now.
	Jetzt func() time.Time
}

// Laufzeit runs the delivered logics along.
type Laufzeit struct {
	mu   sync.Mutex
	deps Deps

	laeufe      map[string]*einLauf
	reihenfolge []string
	letzterTakt time.Time
	dirty       bool
	gespeichert time.Time
}

// einLauf is one logic running along or armed.
type einLauf struct {
	auftrag    Auftrag
	L          *logik.Logik
	st         *logik.Lauf
	ort        *time.Location
	seit       time.Time
	scharfSeit time.Time
	lage       logik.Lage
	tag        string
	fehler     int
	gemeldet   map[string]bool // runtime errors already logged (one line each)
	geraete    map[string]*geraetVergleich
	wechsel    []cloud.LogikWechsel
	nr         int64
	// letzte is the last beat: its outputs (the wishes of an armed logic) and
	// its input, for the "Warum?" list and the help sentences of the heartbeat.
	letzte    map[string]logik.Ausgang
	letzteEin *logik.Eingabe
	meldungen []cloud.LogikMeldung
	meldungNr int64
}

// geraetVergleich holds the comparison counters of one device for the day.
type geraetVergleich struct {
	// begonnen: the first beat of a run sets both sides without a line - the
	// starting state is no change (the §3.2 comparison counts changes).
	begonnen bool
	wunsch   *cloud.LogikStand
	ist      *cloud.LogikStand

	verglichenS   float64
	abweichendS   float64
	streckeS      float64
	laengsteS     float64
	wunschWechsel int
	istWechsel    int
}

// New builds the run. It computes nothing until Angleichen hands it logics.
func New(d Deps) *Laufzeit {
	if d.Jetzt == nil {
		d.Jetzt = time.Now
	}
	return &Laufzeit{deps: d, laeufe: map[string]*einLauf{}}
}

// Lies reads a logic document with the core's own strict reader - the box
// never reads the language a second, different way.
func Lies(dokument []byte) (*logik.Logik, error) {
	return logik.Lesen(dokument)
}

// Zone resolves the site timezone of an Ort (empty = DefaultZeitzone).
func Zone(o Ort) (*time.Location, error) {
	tz := o.Zeitzone
	if tz == "" {
		tz = DefaultZeitzone
	}
	return time.LoadLocation(tz)
}

// Angleichen runs exactly these logics along and stops all others. An
// unchanged logic (same version, same hash) keeps running undisturbed.
func (lz *Laufzeit) Angleichen(auftraege []Auftrag) error {
	lz.mu.Lock()
	defer lz.mu.Unlock()
	if len(auftraege) > MaxLaeufe {
		return fmt.Errorf("mehr als %d Logiken ausgeliefert", MaxLaeufe)
	}
	jetzt := lz.deps.Jetzt()
	neu := map[string]*einLauf{}
	var reihenfolge []string
	herr := map[string]string{} // entity -> flow_id of the armed logic that claims it
	for _, a := range auftraege {
		if _, doppelt := neu[a.FlowID]; doppelt {
			return fmt.Errorf("Logik %s doppelt ausgeliefert", a.FlowID)
		}
		reihenfolge = append(reihenfolge, a.FlowID)
		ort, err := Zone(a.Ort)
		if err != nil {
			return fmt.Errorf("Logik %s: Zeitzone %q unbekannt", a.FlowID, a.Ort.Zeitzone)
		}
		l := lz.laeufe[a.FlowID]
		var vorig *einLauf
		if l != nil && (l.auftrag.Fassung != a.Fassung || !bytes.Equal(l.auftrag.Dokument, a.Dokument)) {
			vorig, l = l, nil // another version or another text: a new run
		}
		var L *logik.Logik
		if l != nil {
			L = l.L
		} else if L, err = Lies(a.Dokument); err != nil {
			return fmt.Errorf("Logik %s nicht lesbar: %w", a.FlowID, err)
		}
		werte, err := L.PruefeStellwerte(a.Stellwerte)
		if err != nil {
			return fmt.Errorf("Logik %s: Stellwerte passen nicht: %w", a.FlowID, err)
		}
		if a.Scharf {
			for _, g := range L.GeraetListe {
				e := L.Geraete[g].Entity
				if anderer, ok := herr[e]; ok {
					return fmt.Errorf("Gerät %s gehört zwei scharfen Logiken (%s und %s)", e, anderer, a.FlowID)
				}
				herr[e] = a.FlowID
			}
		}
		if l == nil {
			l = &einLauf{L: L, seit: jetzt, gemeldet: map[string]bool{},
				geraete: map[string]*geraetVergleich{}, tag: ortsTag(jetzt, ort)}
			if vorig != nil {
				// A new version (or "Zurück" to an earlier one) keeps the states
				// of the same name and kind (report §8.9); the rest begins as
				// after a restart.
				l.st = L.UebernimmLauf(vorig.L, vorig.st, unixSekunden(jetzt))
				slog.Info("steuerlogik: neue Fassung übernimmt die Zustände der vorigen", "flow_id", a.FlowID,
					"von", vorig.auftrag.Fassung, "auf", a.Fassung)
			} else {
				l.st = lz.ladeGesichertenLauf(L, a, jetzt)
			}
			if a.Scharf {
				l.scharfSeit = jetzt
				slog.Info("steuerlogik: Logik ist scharf (schaltet über den Schiedsrichter)", "flow_id", a.FlowID,
					"fassung", a.Fassung, "name", L.Name)
			} else {
				slog.Info("steuerlogik: Logik läuft mit (schaltet nichts)", "flow_id", a.FlowID,
					"fassung", a.Fassung, "name", L.Name)
			}
		} else if l.auftrag.Scharf != a.Scharf {
			if a.Scharf {
				l.scharfSeit = jetzt
				slog.Info("steuerlogik: Logik ist scharf (schaltet über den Schiedsrichter)", "flow_id", a.FlowID,
					"fassung", a.Fassung, "name", L.Name)
			} else {
				l.scharfSeit = time.Time{}
				slog.Info("steuerlogik: Logik läuft wieder nur mit (schaltet nichts)", "flow_id", a.FlowID,
					"fassung", a.Fassung, "name", L.Name)
			}
		}
		if l.auftrag.StellStand != a.StellStand || l.auftrag.Hash != a.Hash {
			slog.Info("steuerlogik: Stellwerte übernommen", "flow_id", a.FlowID, "stand", a.StellStand)
		}
		L.SetzeStellwerte(l.st, werte)
		l.auftrag, l.ort = a, ort
		neu[a.FlowID] = l
		lz.dirty = true
	}
	for id, l := range lz.laeufe {
		if neu[id] == nil {
			lz.dirty = true
			if l.auftrag.Scharf {
				slog.Info("steuerlogik: Logik gestoppt, ihre Geräte sind frei", "flow_id", id)
			} else {
				slog.Info("steuerlogik: Logik gestoppt", "flow_id", id)
			}
		}
	}
	lz.laeufe = neu
	lz.reihenfolge = reihenfolge
	lz.speichereLocked(jetzt, true)
	return nil
}

// ladeGesichertenLauf reads this logic's remembered state from disk when
// version and hash match and applies the restart rules; otherwise a new run
// begins.
func (lz *Laufzeit) ladeGesichertenLauf(L *logik.Logik, a Auftrag, jetzt time.Time) *logik.Lauf {
	js := unixSekunden(jetzt)
	if doc := lz.liesPlatte(); doc != nil {
		g, ok := doc.Laeufe[a.FlowID]
		gleich := ok && g.Fassung == a.Fassung && (g.ContentHash == a.Hash || (g.LogikHash != "" && g.LogikHash == logikHash(a.Dokument)))
		if gleich && len(g.Lauf) > 0 {
			st, err := L.LadeLauf(g.Lauf, js)
			if err == nil {
				L.Neustart(st, js)
				return st
			}
			slog.Warn("steuerlogik: gesicherter Lauf nicht lesbar - Neubeginn", "flow_id", a.FlowID, "err", err)
		}
	}
	return L.NeuerLauf(js)
}

// Tick is one beat over all logics running along. It only reads and keeps
// the result for the heartbeat; nothing leaves the box as a command.
func (lz *Laufzeit) Tick(now time.Time) {
	lz.mu.Lock()
	defer lz.mu.Unlock()
	if len(lz.laeufe) == 0 {
		lz.letzterTakt = time.Time{}
		return
	}
	dt := 1.0
	if !lz.letzterTakt.IsZero() {
		dt = now.Sub(lz.letzterTakt).Seconds()
		if dt <= 0 {
			return // the clock went back or did not move: no beat
		}
	}
	lz.letzterTakt = now
	for _, id := range lz.reihenfolge {
		lz.taktEiner(lz.laeufe[id], now, dt)
	}
	lz.speichereLocked(now, false)
}

func (lz *Laufzeit) taktEiner(l *einLauf, now time.Time, dt float64) {
	ort := now.In(l.ort)
	if tag := ortsTag(now, l.ort); tag != l.tag {
		// Local midnight: today's comparison counters start over (the core
		// resets its own day counters through Eingabe.Tag).
		for _, g := range l.geraete {
			g.verglichenS, g.abweichendS, g.streckeS, g.laengsteS = 0, 0, 0, 0
			g.wunschWechsel, g.istWechsel = 0, 0
		}
		l.fehler = 0
		l.tag = tag
	}
	ein := &logik.Eingabe{
		Jetzt:     unixSekunden(now),
		UhrMin:    float64(ort.Hour())*60 + float64(ort.Minute()) + float64(ort.Second())/60,
		Tag:       ort.Year()*1000 + ort.YearDay(),
		Wochentag: (int(ort.Weekday()) + 6) % 7,
		DT:        dt,
		Werte:     map[string]logik.EinWert{},
		Geraete:   map[string]logik.GeraetStamm{},
	}
	for _, n := range l.L.WertListe {
		ein.Werte[n] = lz.quelle(l, l.L.Werte[n].Source, now)
	}
	iste := map[string]Ist{}
	for _, g := range l.L.GeraetListe {
		stamm, ist := lz.deps.Geraet(l.L.Geraete[g].Entity, now)
		if stamm.Stufe == nil {
			// The core's .on/.level and its output hours read the read-back
			// state; for an on/off device that is 0 or 1 output.
			switch {
			case ist.Stufe != nil:
				v := float64(*ist.Stufe)
				stamm.Stufe = &v
			case ist.Ein != nil:
				v := 0.0
				if *ist.Ein {
					v = 1
				}
				stamm.Stufe = &v
			}
		}
		if stamm.Sollwert == nil && ist.Sollwert != nil {
			v := *ist.Sollwert
			stamm.Sollwert = &v
		}
		if stamm.Betriebsart == "" {
			stamm.Betriebsart = ist.Betriebsart
		}
		ein.Geraete[g] = stamm
		iste[g] = ist
	}
	erg := l.L.Takt(l.st, ein)
	l.letzte, l.letzteEin = erg.Ausgaenge, ein
	for _, e := range erg.Ereignisse {
		if e.Was == "meldung" {
			l.meldungNr++
			l.meldungen = append(l.meldungen, cloud.LogikMeldung{Nr: l.meldungNr, T: now.UTC().Format(time.RFC3339),
				An: append([]string(nil), e.An...), Text: e.Text})
			if len(l.meldungen) > MaxMeldungen {
				l.meldungen = l.meldungen[len(l.meldungen)-MaxMeldungen:]
			}
			lz.dirty = true
			continue
		}
		if e.Was == "fehler" {
			l.fehler++
			if !l.gemeldet[e.Grund] && len(l.gemeldet) < 32 {
				l.gemeldet[e.Grund] = true
				slog.Warn("steuerlogik: Ausdruck nicht rechenbar", "flow_id", l.auftrag.FlowID, "grund", e.Grund)
			}
			continue
		}
		lz.dirty = true // a remembered state changed
	}
	l.lage = erg.Lage
	l.vergleiche(erg, iste, now, dt)
}

// quelle reads one input: the sun from the site location, everything else
// from the box.
func (lz *Laufzeit) quelle(l *einLauf, source string, now time.Time) logik.EinWert {
	if source == SourceSonne {
		o := l.auftrag.Ort
		if o.Breite == nil || o.Laenge == nil {
			return logik.EinWert{}
		}
		v := sonnenstand.Elevation(*o.Breite, *o.Laenge, now)
		return logik.EinWert{Zahl: &v}
	}
	if lz.deps.Quelle == nil {
		return logik.EinWert{}
	}
	return lz.deps.Quelle(source, now)
}

// vergleiche keeps the comparison log of one beat: "würde schalten" (the
// core's wish) against "ist geschaltet" (the observed state).
func (l *einLauf) vergleiche(erg logik.TaktErgebnis, iste map[string]Ist, now time.Time, dt float64) {
	for _, g := range l.L.GeraetListe {
		v := l.geraete[g]
		if v == nil {
			v = &geraetVergleich{}
			l.geraete[g] = v
		}
		wunsch := wunschStand(erg.Ausgaenge[g])
		ist := istStand(iste[g])

		// "Hätte die Logik zur selben Zeit dasselbe getan?" (report §8.4):
		// every change of either side is a line with the other side next to it.
		if v.begonnen && !gleicherStand(v.wunsch, wunsch) {
			v.wunschWechsel++
			l.merke(now, g, "wunsch", wunsch, ist, erg.Lage.Titel)
		}
		if v.begonnen && !gleicherStand(v.ist, ist) {
			v.istWechsel++
			l.merke(now, g, "ist", ist, wunsch, erg.Lage.Titel)
		}
		v.wunsch, v.ist, v.begonnen = wunsch, ist, true

		// Seconds are compared only while both sides are known.
		weicht, vergleichbar := abweichung(wunsch, ist)
		if !vergleichbar {
			v.streckeS = 0
			continue
		}
		v.verglichenS += dt
		if weicht {
			v.abweichendS += dt
			v.streckeS += dt
			if v.streckeS > v.laengsteS {
				v.laengsteS = v.streckeS
			}
		} else {
			v.streckeS = 0
		}
	}
}

// wunschStand maps the core's output to a switch state; nil = no wish.
func wunschStand(a logik.Ausgang) *cloud.LogikStand {
	s := &cloud.LogikStand{}
	hat := false
	if a.HatStufe {
		n := a.Stufe
		s.Stufe, hat = &n, true
	}
	if a.HatEin && a.Ein != nil {
		e := *a.Ein
		s.Ein, hat = &e, true
	}
	if a.HatSollwert && a.Sollwert != nil && a.Sollwert.Art == logik.WertZahl {
		v := a.Sollwert.V
		s.Sollwert, hat = &v, true
	}
	if a.HatBetriebsart && a.Betriebsart != "" {
		s.Betriebsart, hat = a.Betriebsart, true
	}
	if a.HatAnteil && a.Anteil != nil {
		v := *a.Anteil
		s.Anteil, hat = &v, true
	}
	if !hat {
		return nil
	}
	return s
}

// istStand maps the observed state; nil = unknown.
func istStand(i Ist) *cloud.LogikStand {
	if i.Stufe == nil && i.Ein == nil && i.Sollwert == nil && i.Betriebsart == "" {
		return nil
	}
	s := &cloud.LogikStand{Betriebsart: i.Betriebsart}
	if i.Sollwert != nil {
		v := *i.Sollwert
		s.Sollwert = &v
	}
	if i.Stufe != nil {
		n := *i.Stufe
		s.Stufe = &n
	}
	if i.Ein != nil {
		e := *i.Ein
		s.Ein = &e
	}
	return s
}

// abweichung says whether wish and observed state differ, and whether the
// two can be compared at all. A level against on/off compares "0 = off";
// setpoint and mode compare where the device reads them back (K2/K3; a
// setpoint within 0.05 K counts as the same); a share has no observed state.
// A device with several outputs differs when any compared output differs.
func abweichung(w, i *cloud.LogikStand) (weicht, vergleichbar bool) {
	if w == nil || i == nil {
		return false, false
	}
	weicht, vergleichbar = schaltAbweichung(w, i)
	if w.Sollwert != nil && i.Sollwert != nil {
		vergleichbar = true
		d := *w.Sollwert - *i.Sollwert
		weicht = weicht || d > 0.05 || d < -0.05
	}
	if w.Betriebsart != "" && i.Betriebsart != "" {
		vergleichbar = true
		weicht = weicht || w.Betriebsart != i.Betriebsart
	}
	return weicht, vergleichbar
}

func schaltAbweichung(w, i *cloud.LogikStand) (weicht, vergleichbar bool) {
	switch {
	case w.Stufe != nil && i.Stufe != nil:
		return *w.Stufe != *i.Stufe, true
	case w.Ein != nil && i.Ein != nil:
		return *w.Ein != *i.Ein, true
	case w.Stufe != nil && i.Ein != nil:
		return (*w.Stufe > 0) != *i.Ein, true
	case w.Ein != nil && i.Stufe != nil:
		return *w.Ein != (*i.Stufe > 0), true
	}
	return false, false
}

func gleicherStand(a, b *cloud.LogikStand) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return gleichInt(a.Stufe, b.Stufe) && gleichBool(a.Ein, b.Ein) && gleichZahl(a.Sollwert, b.Sollwert) &&
		a.Betriebsart == b.Betriebsart && gleichZahl(a.Anteil, b.Anteil)
}

func gleichInt(a, b *int) bool   { return (a == nil) == (b == nil) && (a == nil || *a == *b) }
func gleichBool(a, b *bool) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }
func gleichZahl(a, b *float64) bool {
	return (a == nil) == (b == nil) && (a == nil || *a == *b)
}

func (l *einLauf) merke(now time.Time, geraet, was string, neu, andere *cloud.LogikStand, lage string) {
	l.nr++
	l.wechsel = append(l.wechsel, cloud.LogikWechsel{
		Nr: l.nr, T: now.UTC().Format(time.RFC3339), Geraet: geraet, Was: was,
		Neu: kopieStand(neu), Andere: kopieStand(andere), Lage: lage,
	})
	if len(l.wechsel) > MaxWechsel {
		l.wechsel = l.wechsel[len(l.wechsel)-MaxWechsel:]
	}
}

// The run states of the heartbeat block (closed vocabulary, steuerlogik-rueckmeldung.md).
const (
	ZustandMitlaufend = "mitlaufend"
	ZustandScharf     = "scharf"
)

// Wuensche are the wishes of the armed logics from the last beat, in the order
// of the logics and their devices. A logic running along wishes nothing here.
func (lz *Laufzeit) Wuensche() []Wunsch {
	lz.mu.Lock()
	defer lz.mu.Unlock()
	var out []Wunsch
	for _, id := range lz.reihenfolge {
		l := lz.laeufe[id]
		if l == nil || !l.auftrag.Scharf || l.letzte == nil {
			continue
		}
		for _, g := range l.L.GeraetListe {
			a, ok := l.letzte[g]
			if !ok {
				continue
			}
			out = append(out, Wunsch{FlowID: id, Fassung: l.auftrag.Fassung, Geraet: g,
				EntityID: l.L.Geraete[g].Entity, Ausgang: a})
		}
	}
	return out
}

// Beansprucht names the devices of the armed logics (entity -> flow_id), also
// before their first beat: the plan leaves them alone from the moment of arming.
func (lz *Laufzeit) Beansprucht() map[string]string {
	lz.mu.Lock()
	defer lz.mu.Unlock()
	out := map[string]string{}
	for id, l := range lz.laeufe {
		if !l.auftrag.Scharf {
			continue
		}
		for _, g := range l.L.GeraetListe {
			out[l.L.Geraete[g].Entity] = id
		}
	}
	return out
}

// Summary is the heartbeat block; nil while nothing runs along.
func (lz *Laufzeit) Summary() *cloud.LogikSummary {
	lz.mu.Lock()
	defer lz.mu.Unlock()
	if len(lz.laeufe) == 0 {
		return nil
	}
	now := lz.deps.Jetzt()
	sum := &cloud.LogikSummary{}
	for _, id := range lz.reihenfolge {
		l := lz.laeufe[id]
		e := cloud.LogikLauf{
			FlowID: l.auftrag.FlowID, FlowVersion: l.auftrag.Fassung, ContentHash: l.auftrag.Hash,
			Name: l.L.Name, Zustand: ZustandMitlaufend, Seit: l.seit.UTC().Format(time.RFC3339), Tag: l.tag,
			Fehler: l.fehler,
		}
		if l.auftrag.Scharf {
			e.Zustand = ZustandScharf
			e.ScharfSeit = l.scharfSeit.UTC().Format(time.RFC3339)
		}
		e.Stellwerte = &cloud.LogikStellwerte{Stand: l.auftrag.StellStand}
		for _, j := range l.L.StellwerteJetzt(l.st, l.letzteEin) {
			e.Stellwerte.Werte = append(e.Stellwerte.Werte, cloud.LogikStellwert{Kennung: j.Kennung, Wert: j.Wert,
				Text: j.Text, Hilfe: j.Hilfe})
		}
		for _, g := range l.L.Warum(l.st, l.letzteEin) {
			w := cloud.LogikWarum{Zustand: g.Zustand, Name: g.Name, Satz: g.Satz, Eigen: g.Eigen, Was: g.Was,
				Schritt: g.Schritt, Modus: g.Modus, WartetS: g.WartetS}
			for _, b := range g.Bedingungen {
				wb := cloud.LogikBedingung{Name: b.Name, Ok: b.Ok, Allgemein: b.Allgemein}
				for _, x := range b.Werte {
					wb.Werte = append(wb.Werte, cloud.LogikWert{Name: x.Name, Text: x.Text})
				}
				w.Bedingungen = append(w.Bedingungen, wb)
			}
			e.Warum = append(e.Warum, w)
		}
		e.Meldungen = append([]cloud.LogikMeldung(nil), l.meldungen...)
		if l.lage.Titel != "" {
			e.Lage = &cloud.LogikLage{Nr: l.lage.Nr, Titel: l.lage.Titel, Art: l.lage.Art, Satz: l.lage.Satz}
		}
		if z := l.L.ZustandKurz(l.st, unixSekunden(now)); len(z) > 0 {
			e.Zustaende = z
		}
		e.Unbekannt = lz.unbekannteEingaenge(l, now)
		if len(l.geraete) > 0 {
			e.Geraete = map[string]cloud.LogikGeraet{}
			for g, v := range l.geraete {
				e.Geraete[g] = cloud.LogikGeraet{
					EntityID: l.L.Geraete[g].Entity, Name: l.L.Geraete[g].Name,
					Wunsch: kopieStand(v.wunsch), Ist: kopieStand(v.ist),
					VerglichenS: int(v.verglichenS), AbweichendS: int(v.abweichendS),
					LaengsteAbweichungS: int(v.laengsteS),
					WunschWechsel:       v.wunschWechsel, IstWechsel: v.istWechsel,
				}
			}
		}
		e.Wechsel = append([]cloud.LogikWechsel(nil), l.wechsel...)
		sum.Laeufe = append(sum.Laeufe, e)
	}
	return sum
}

// unbekannteEingaenge names the inputs without a fresh value right now - the
// honest gap of the plant (Fühler not yet bound, no price on the box).
func (lz *Laufzeit) unbekannteEingaenge(l *einLauf, now time.Time) []string {
	var out []string
	for _, n := range l.L.WertListe {
		e := l.L.Werte[n]
		w := lz.quelle(l, e.Source, now)
		fehlt := w.Zahl == nil && w.Bool == nil
		if !fehlt && e.HatMaxAge && e.MaxAge >= 0 && w.Alter > e.MaxAge {
			fehlt = true
		}
		if fehlt {
			out = append(out, n)
		}
	}
	return out
}

func kopieStand(s *cloud.LogikStand) *cloud.LogikStand {
	if s == nil {
		return nil
	}
	c := *s
	if s.Stufe != nil {
		v := *s.Stufe
		c.Stufe = &v
	}
	if s.Ein != nil {
		v := *s.Ein
		c.Ein = &v
	}
	if s.Sollwert != nil {
		v := *s.Sollwert
		c.Sollwert = &v
	}
	if s.Anteil != nil {
		v := *s.Anteil
		c.Anteil = &v
	}
	return &c
}

// --- disk --------------------------------------------------------------------

type platte struct {
	SchemaVersion int                        `json:"schema_version"`
	Laeufe        map[string]gesicherteLogik `json:"laeufe"`
}

type gesicherteLogik struct {
	Fassung     int    `json:"fassung"`
	ContentHash string `json:"content_hash"`
	// LogikHash identifies the logic text alone: another mode or other set
	// values change the artifact's hash but keep the run.
	LogikHash string          `json:"logik_hash,omitempty"`
	Lauf      json.RawMessage `json:"lauf"`
}

// logikHash is the hash of a logic document (its canonical JSON text).
func logikHash(dokument []byte) string {
	sum := sha256.Sum256(dokument)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (lz *Laufzeit) plattePfad() string {
	return filepath.Join(lz.deps.DataDir, stateFile)
}

func (lz *Laufzeit) liesPlatte() *platte {
	if lz.deps.DataDir == "" {
		return nil
	}
	roh, err := os.ReadFile(lz.plattePfad())
	if err != nil {
		return nil
	}
	var doc platte
	if json.Unmarshal(roh, &doc) != nil || doc.SchemaVersion != 1 {
		slog.Warn("steuerlogik: gespeicherte Läufe nicht lesbar - Neubeginn")
		return nil
	}
	return &doc
}

// speichereLocked writes the runs throttled and atomically (tmp + rename).
// sofort forces the write (Angleichen, Stop).
func (lz *Laufzeit) speichereLocked(now time.Time, sofort bool) {
	if lz.deps.DataDir == "" || !lz.dirty {
		return
	}
	if !sofort && now.Sub(lz.gespeichert) < saveEvery {
		return
	}
	doc := platte{SchemaVersion: 1, Laeufe: map[string]gesicherteLogik{}}
	for id, l := range lz.laeufe {
		roh, err := l.L.SichereLauf(l.st)
		if err != nil {
			slog.Warn("steuerlogik: Lauf nicht sicherbar", "flow_id", id, "err", err)
			continue
		}
		doc.Laeufe[id] = gesicherteLogik{Fassung: l.auftrag.Fassung, ContentHash: l.auftrag.Hash,
			LogikHash: logikHash(l.auftrag.Dokument), Lauf: roh}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		slog.Warn("steuerlogik: Läufe nicht gespeichert", "err", err)
		return
	}
	tmp := lz.plattePfad() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		slog.Warn("steuerlogik: Läufe nicht gespeichert", "err", err)
		return
	}
	if err := os.Rename(tmp, lz.plattePfad()); err != nil {
		slog.Warn("steuerlogik: Läufe nicht gespeichert", "err", err)
		return
	}
	lz.dirty = false
	lz.gespeichert = now
}

// Stop saves the runs when the box program shuts down.
func (lz *Laufzeit) Stop() {
	lz.mu.Lock()
	defer lz.mu.Unlock()
	lz.speichereLocked(lz.deps.Jetzt(), true)
}

func unixSekunden(t time.Time) float64 {
	return float64(t.UnixNano()) / 1e9
}

// ortsTag is the local date in the site timezone.
func ortsTag(t time.Time, ort *time.Location) string {
	return t.In(ort).Format("2006-01-02")
}
