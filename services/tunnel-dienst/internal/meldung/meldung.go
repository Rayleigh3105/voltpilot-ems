// Package meldung ist die Rückmeldung des Dienstes ans Portal: je Box
// "verbunden seit" und "zuletzt gefragt um", je Fenster "Schlüssel abgeholt
// um" (Vertrag: docs/contracts/fernwartung-rueckmeldung-v1.md). Sonst steht
// nichts darin - kein Schlüssel, kein Fingerabdruck, keine Adresse.
//
// Die Rückmeldung ist Anzeige im Portal und darf die eigentliche Arbeit nie
// stören:
//   - Sie läuft neben dem Abgleich her, in einem eigenen Aufruf mit eigener
//     Frist. Läuft der vorige noch, entfällt der neue.
//   - Sie liest nur: den Stand des letzten Laufs (dienst.Lage), die
//     Handshakes von WireGuard, den Speicher der Schlüsselausgabe.
//   - Sie holt kein Token und wiederholt nichts. Scheitert sie, steht das
//     einmal im Journal, und der nächste Versuch kommt in wachsendem Abstand.
//   - Kennt die API die Route nicht (älterer Stand), fragt der Dienst alle
//     zehn Minuten wieder nach.
package meldung

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ausgabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/quelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

const (
	// Version ist die einzige Version der Meldung, die dieser Dienst schickt.
	Version = 1
	// VerbundenInnerhalb: so alt darf der letzte WireGuard-Handshake einer
	// Box höchstens sein, damit sie als verbunden gilt. Eine Box mit Tunnel
	// erneuert ihn alle zwei Minuten; nach drei Minuten ohne neuen Handshake
	// nimmt WireGuard von ihr kein Paket mehr an.
	VerbundenInnerhalb = 3 * time.Minute
	// FristVorgabe gilt für den ganzen Aufruf: Handshakes lesen und senden.
	FristVorgabe = 5 * time.Second
	// PauseOhneRoute: so lange wartet der Dienst, wenn die API die Route
	// nicht kennt. Auch die längste Pause nach wiederholtem Scheitern.
	PauseOhneRoute = 10 * time.Minute
	// MaxRumpf: eine größere Meldung nimmt die API nicht an.
	MaxRumpf = 2 << 20
)

// Bericht ist der Rumpf der Meldung. Jedes Feld steht immer da; null ist eine
// Aussage ("nicht verbunden", "nicht gefragt", "nicht abgeholt").
type Bericht struct {
	Version           int       `json:"version"`
	GemeldetUm        time.Time `json:"gemeldetUm"`
	GestartetUm       time.Time `json:"gestartetUm"`
	Schluesselausgabe bool      `json:"schluesselausgabe"`
	Boxen             []Box     `json:"boxen"`
	Fenster           []Fenster `json:"fenster"`
}

// Box ist eine Box aus dem Soll-Stand, benannt nur über ihre id.
type Box struct {
	ID               string     `json:"id"`
	VerbundenSeit    *time.Time `json:"verbundenSeit"`
	ZuletztGefragtUm *time.Time `json:"zuletztGefragtUm"`
}

// Fenster ist ein Fenster aus dem Soll-Stand, das in der Kernel-Menge steht.
type Fenster struct {
	ID                   string     `json:"id"`
	SchluesselAbgeholtUm *time.Time `json:"schluesselAbgeholtUm"`
}

// Melder baut und schickt die Meldung und merkt sich dafür, seit wann eine
// Box verbunden ist.
type Melder struct {
	// Senden schickt den Rumpf (quelle.Melder.Melde).
	Senden func(ctx context.Context, rumpf []byte) error
	// Handshakes liest den letzten Handshake je öffentlichem Schlüssel
	// (system.WireGuard.Handshakes).
	Handshakes func(ctx context.Context) (map[string]time.Time, error)
	// Auskunft liefert den Stand der Schlüsselausgabe; nil, solange sie
	// abgeschaltet ist.
	Auskunft func() ausgabe.Auskunft
	Log      *slog.Logger
	Jetzt    func() time.Time
	// GestartetUm: seit wann dieser Lauf des Dienstes läuft.
	GestartetUm time.Time
	// Frist für einen Aufruf; 0: FristVorgabe.
	Frist time.Duration
	// Intervall des Abgleichs: die erste Pause nach einem gescheiterten Aufruf.
	Intervall time.Duration

	mu     sync.Mutex
	laeuft bool

	// Ab hier fasst nur der eine laufende Aufruf an.
	beobachtet time.Time            // letzte Lesung der Handshakes (Null-Zeit: noch keine)
	verbunden  map[string]time.Time // öffentlicher Schlüssel -> verbunden seit
	naechster  time.Time            // vorher wird nicht gesendet
	fehler     int                  // gescheiterte Aufrufe in Folge
	stand      string               // was zuletzt im Journal stand
}

// Anstossen startet einen Aufruf neben dem Abgleich und kehrt sofort zurück.
// bekannt ist false, solange der Dienst seit dem Start keinen gültigen
// Soll-Stand abgeholt hat. Läuft der vorige Aufruf noch, entfällt dieser
// (Rückgabe false).
func (m *Melder) Anstossen(ctx context.Context, lage dienst.Lage, bekannt bool) bool {
	m.mu.Lock()
	if m.laeuft {
		m.mu.Unlock()
		return false
	}
	m.laeuft = true
	m.mu.Unlock()
	go func() {
		defer func() {
			// Ein Fehler in der Rückmeldung beendet nie den Dienst.
			if r := recover(); r != nil {
				m.Log.Error("Rückmeldung ans Portal abgebrochen", "grund", fmt.Sprint(r))
			}
			m.mu.Lock()
			m.laeuft = false
			m.mu.Unlock()
		}()
		m.Melde(ctx, lage, bekannt)
	}()
	return true
}

// Laeuft sagt, ob gerade ein Aufruf unterwegs ist.
func (m *Melder) Laeuft() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.laeuft
}

func (m *Melder) frist() time.Duration {
	if m.Frist > 0 {
		return m.Frist
	}
	return FristVorgabe
}

// Melde ist ein Aufruf: Handshakes lesen, Meldung bauen, senden - alles
// innerhalb der Frist. Nie zwei zugleich (Anstossen sorgt dafür).
func (m *Melder) Melde(ctx context.Context, lage dienst.Lage, bekannt bool) {
	ctx, abbruch := context.WithTimeout(ctx, m.frist())
	defer abbruch()
	hs, err := m.Handshakes(ctx)
	if err != nil {
		// Ohne Handshakes weiß der Dienst nicht, wer verbunden ist. Dann geht
		// keine Meldung hinaus: "unbekannt" ist besser als "nicht verbunden".
		m.melde(slog.LevelWarn, "Rückmeldung ans Portal entfällt: Handshakes nicht lesbar", "fehler", err)
		return
	}
	jetzt := m.Jetzt()
	m.beobachte(hs, jetzt)
	if !bekannt || jetzt.Before(m.naechster) {
		return
	}
	bericht := m.baue(lage, jetzt)
	rumpf, err := json.Marshal(bericht)
	if err != nil || len(rumpf) > MaxRumpf {
		m.melde(slog.LevelWarn, "Rückmeldung ans Portal entfällt: Meldung nicht darstellbar oder zu groß",
			"bytes", len(rumpf), "fehler", err)
		return
	}
	err = m.Senden(ctx, rumpf)
	var abgelehnt *quelle.MeldeFehler
	switch {
	case err == nil:
		m.fehler, m.naechster = 0, time.Time{}
		m.melde(slog.LevelInfo, "Rückmeldung ans Portal angenommen", "boxen", len(bericht.Boxen),
			"fenster", len(bericht.Fenster))
	case errors.Is(err, quelle.ErrKeinToken):
		// Der Abruf des Soll-Stands holt das Token; scheitert er, steht das
		// schon im Journal.
	case errors.As(err, &abgelehnt) && abgelehnt.RouteFehlt():
		m.fehler, m.naechster = 0, jetzt.Add(PauseOhneRoute)
		m.melde(slog.LevelInfo, "Rückmeldung: die API kennt die Route nicht (älterer Stand der API); "+
			"Soll-Stand, Firewall und Schlüsselausgabe sind davon nicht berührt",
			"antwort", abgelehnt.Status, "naechsterVersuchIn", PauseOhneRoute)
	default:
		m.fehler++
		pause := m.pause()
		m.naechster = jetzt.Add(pause)
		m.melde(slog.LevelWarn, "Rückmeldung ans Portal gescheitert; "+
			"Soll-Stand, Firewall und Schlüsselausgabe sind davon nicht berührt",
			"fehler", kurz(err), "naechsterVersuchIn", pause)
	}
}

// pause wächst mit jedem gescheiterten Aufruf in Folge: ein Intervall, zwei,
// vier … höchstens PauseOhneRoute.
func (m *Melder) pause() time.Duration {
	p := m.Intervall
	if p <= 0 {
		p = 30 * time.Second
	}
	for i := 1; i < m.fehler && p < PauseOhneRoute; i++ {
		p *= 2
	}
	return min(p, PauseOhneRoute)
}

// melde schreibt eine Lage ins Journal - einmal, bis sie sich ändert. Was
// alle 30 s gleich ausgeht, soll das Journal nicht füllen.
func (m *Melder) melde(stufe slog.Level, text string, felder ...any) {
	stand := text
	for i := 0; i+1 < len(felder); i += 2 {
		// Zahlen, die sich laufend ändern, machen keine neue Lage.
		if k, _ := felder[i].(string); k == "fehler" || k == "antwort" {
			stand += fmt.Sprint(" ", felder[i+1])
		}
	}
	if stand == m.stand {
		return
	}
	m.stand = stand
	m.Log.Log(context.Background(), stufe, text, felder...)
}

// kurz nimmt einem Fehler, was sich von Aufruf zu Aufruf ändert, ohne etwas
// zu bedeuten (der Absender-Port in einer Netzmeldung).
func kurz(err error) string {
	var abgelehnt *quelle.MeldeFehler
	if errors.As(err, &abgelehnt) {
		return abgelehnt.Error()
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "Frist überschritten"
	case errors.Is(err, context.Canceled):
		return "abgebrochen"
	}
	var netz interface{ Timeout() bool }
	if errors.As(err, &netz) && netz.Timeout() {
		return "Frist überschritten"
	}
	return "keine Verbindung zur API"
}

// beobachte führt mit, seit wann jeder Peer verbunden ist.
//
//   - Kein Handshake innerhalb von VerbundenInnerhalb: nicht verbunden.
//   - Bei der ersten Lesung nach dem Start schon verbunden: seit GestartetUm,
//     also "mindestens seit dem Start" - wie lange davor, weiß dieser Lauf
//     nicht.
//   - Später (wieder) verbunden: seit dem Handshake, den diese Lesung zeigt.
//
// Lag die vorige Lesung länger zurück als VerbundenInnerhalb, kann eine
// Unterbrechung dazwischen unbemerkt geblieben sein: Dann gilt für jeden
// Peer nur noch sein letzter Handshake.
func (m *Melder) beobachte(hs map[string]time.Time, jetzt time.Time) {
	erste := m.beobachtet.IsZero()
	luecke := !erste && jetzt.Sub(m.beobachtet) > VerbundenInnerhalb
	m.beobachtet = jetzt
	neu := make(map[string]time.Time, len(hs))
	for key, zuletzt := range hs {
		if zuletzt.IsZero() || jetzt.Sub(zuletzt) > VerbundenInnerhalb {
			continue
		}
		seit, schon := m.verbunden[key]
		switch {
		case erste:
			seit = m.GestartetUm
		case !schon || luecke:
			seit = zuletzt
		}
		neu[key] = seit
	}
	m.verbunden = neu
}

// baue stellt die Meldung zusammen: Boxen in der Reihenfolge ihrer Adressen,
// Fenster nach ihrer id.
func (m *Melder) baue(lage dienst.Lage, jetzt time.Time) Bericht {
	b := Bericht{Version: Version, GemeldetUm: sekunde(jetzt), GestartetUm: sekunde(m.GestartetUm),
		Boxen: []Box{}, Fenster: []Fenster{}}
	var auskunft ausgabe.Auskunft
	if m.Auskunft != nil {
		auskunft = m.Auskunft()
		b.Schluesselausgabe = auskunft.Laeuft
	}
	// Keine Zeitangabe liegt nach gemeldetUm: Eine Box kann gefragt haben,
	// während diese Meldung entstand.
	zeiger := func(t time.Time) *time.Time {
		s := sekunde(t)
		if s.After(b.GemeldetUm) {
			s = b.GemeldetUm
		}
		return &s
	}
	techniker := map[netip.Addr]soll.PeerSoll{}
	for _, p := range lage.Peers {
		switch p.Art {
		case soll.ArtTechniker:
			techniker[p.Adresse] = p
		case soll.ArtBox:
			box := Box{ID: p.ID}
			if seit, verbunden := m.verbunden[p.PublicKey]; verbunden {
				box.VerbundenSeit = zeiger(seit)
			}
			if a := auskunft.Boxen[p.Adresse]; !a.LetzteAnfrage.IsZero() {
				box.ZuletztGefragtUm = zeiger(a.LetzteAnfrage)
			}
			b.Boxen = append(b.Boxen, box)
		}
	}
	for _, f := range lage.Fenster {
		fenster := Fenster{ID: f.ID}
		// Abgeholt ist nur der Schlüssel, der JETZT am Zugang steht: Ein im
		// offenen Fenster ersetzter gilt erst, wenn die Box den neuen hat.
		if t, da := techniker[f.Techniker]; da && t.SSH.Fingerabdruck != "" {
			if seit, hat := auskunft.Boxen[f.Box].Bestaetigt[t.ID][t.SSH.Fingerabdruck]; hat {
				fenster.SchluesselAbgeholtUm = zeiger(seit)
			}
		}
		b.Fenster = append(b.Fenster, fenster)
	}
	return b
}

// sekunde: Zeitangaben gehen in UTC und auf ganze Sekunden hinaus.
func sekunde(t time.Time) time.Time { return t.UTC().Truncate(time.Second) }
