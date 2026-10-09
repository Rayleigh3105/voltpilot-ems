package ausgabe

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ablage"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/soll"
)

// Menge liest die offenen Fenster aus dem Kernel (system.Nft).
type Menge interface {
	Fenster(ctx context.Context) (map[abgleich.Paar]time.Duration, error)
}

// Antwort an eine Box. Code 0 heißt: die Anfrage wurde abgebrochen, es geht
// nichts hinaus.
type Antwort struct {
	Code int
	Text []byte
}

const (
	// frischeVorgabe: so alt darf die Lesung der Kernel-Menge höchstens sein,
	// auf der eine Antwort beruht. Jede Antwort neu zu lesen hieße ein
	// nft-Aufruf je Box; eine gemeinsame Lesung für alle, die gleichzeitig
	// fragen, genügt.
	frischeVorgabe = 2 * time.Second
	// restSprung: ändert sich das Ende eines Fensters um mehr als das, während
	// eine Anfrage offen ist, wird sie beantwortet, auch wenn die Liste
	// dieselbe ist. Die Box führt die Frist selbst und soll kein Fenster
	// überdauern, das neu gesetzt wurde. Der Dienst setzt ein Element erst ab
	// 10 s Abweichung neu (dienst.Toleranz); zwei Lesungen desselben Elements
	// liegen höchstens eine Sekunde auseinander.
	restSprung = 5 * time.Second
	// maxBoxen: mehr Boxen merkt sich die Stelle nicht (Schutz des Speichers).
	maxBoxen = 65536

	zustandsDatei = "schluessel.json"
)

// Stelle entscheidet, welche Schlüssel eine Box bekommt. Sie läuft im Dienst
// selbst und ist die einzige Seite, die Kernel-Menge und Soll-Stand liest.
type Stelle struct {
	Menge   Menge
	BoxNetz netip.Prefix
	Log     *slog.Logger
	// Jetzt ist die Uhr für Zeitangaben in Log und schluessel.json.
	Jetzt func() time.Time
	// Zustand: Verzeichnis für schluessel.json (leer: nichts ablegen).
	Zustand string
	// Adresse, auf der der Schalter lauscht - nur für die Anzeige.
	Adresse string
	// Frische überschreibt frischeVorgabe; negativ: jede Antwort liest neu.
	Frische time.Duration

	leseMu sync.Mutex // hält die Lesung der Kernel-Menge einzeln

	mu         sync.Mutex
	stand      *stand
	wecker     chan struct{}
	bild       *bild
	fassung    uint64
	wartende   map[netip.Addr]*wartender
	boxen      map[netip.Addr]*boxStand
	seit       time.Time
	laeuft     bool
	leseFehler time.Time
}

type zugang struct {
	id      string
	kennung string
	ssh     soll.SSHSchluessel
}

// stand ist der letzte gültige, frisch abgeholte Soll-Stand - nur das, was
// die Ausgabe braucht.
type stand struct {
	techniker map[netip.Addr]zugang
	boxen     map[netip.Addr]string
}

// bild ist eine Lesung der Kernel-Menge mit dem Zeitpunkt, zu dem jedes
// Element abläuft.
type bild struct {
	gelesen time.Time
	bis     map[abgleich.Paar]time.Time
	err     error
}

type wartender struct{ abgeloest chan struct{} }

type boxStand struct {
	letzteAnfrage time.Time
	anfragen      int
	ausgegeben    map[string]Ausgegeben
}

// posten ist ein Eintrag der Antwort mit dem, was das Journal dazu nennt.
type posten struct {
	Eintrag
	techniker     string
	fingerabdruck string
	bis           time.Time
}

// SetzeStand übernimmt einen frisch abgeholten, geprüften Soll-Stand. Ab
// jetzt nennt keine Antwort mehr einen SSH-Schlüssel, der darin ersetzt oder
// entfernt ist. Aus dem Zwischenstand auf der Platte kommt nie ein Stand:
// ohne frischen Abruf gibt es keine Liste.
func (s *Stelle) SetzeStand(g soll.Gueltig) {
	neu := &stand{techniker: map[netip.Addr]zugang{}, boxen: map[netip.Addr]string{}}
	for _, p := range g.Peers {
		switch p.Art {
		case soll.ArtBox:
			neu.boxen[p.Adresse] = p.Kennung
		case soll.ArtTechniker:
			if p.SSH.Zeile != "" && !ZugangGueltig(p.ID) {
				s.Log.Warn("SSH-Schlüssel wird nicht ausgegeben: die id des Zugangs passt nicht in eine Antwort",
					"kennung", p.Kennung)
				continue
			}
			neu.techniker[p.Adresse] = zugang{id: p.ID, kennung: p.Kennung, ssh: p.SSH}
		}
	}
	s.mu.Lock()
	s.stand = neu
	s.mu.Unlock()
}

// Geaendert meldet, dass sich Stand oder Kernel-Menge geändert haben können
// (nach jedem Lauf des Dienstes): wartende Anfragen rechnen neu und antworten
// sofort, wenn ihre Liste jetzt eine andere ist.
func (s *Stelle) Geaendert() {
	s.mu.Lock()
	s.bild = nil
	s.fassung++
	if s.wecker != nil {
		close(s.wecker)
	}
	s.wecker = make(chan struct{})
	s.mu.Unlock()
}

// SetzeLaeuft hält fest, ob der Schalter gerade lauscht (für `status`).
func (s *Stelle) SetzeLaeuft(laeuft bool) {
	s.mu.Lock()
	s.laeuft = laeuft
	s.mu.Unlock()
	s.Sichere()
}

func (s *Stelle) frische() time.Duration {
	if s.Frische != 0 {
		return s.Frische
	}
	return frischeVorgabe
}

// lies liefert eine Lesung der Kernel-Menge, die höchstens frische() alt ist.
// Wer gleichzeitig fragt, teilt sich eine Lesung.
func (s *Stelle) lies() *bild {
	s.leseMu.Lock()
	defer s.leseMu.Unlock()
	s.mu.Lock()
	b, fassung := s.bild, s.fassung
	s.mu.Unlock()
	if b != nil && time.Since(b.gelesen) < s.frische() {
		return b
	}
	ctx, abbruch := context.WithTimeout(context.Background(), 10*time.Second)
	defer abbruch()
	fenster, err := s.Menge.Fenster(ctx)
	b = &bild{gelesen: time.Now(), bis: map[abgleich.Paar]time.Time{}, err: err}
	for p, rest := range fenster {
		b.bis[p] = b.gelesen.Add(rest)
	}
	s.mu.Lock()
	// Hat sich währenddessen etwas geändert, gilt die Lesung nur für diese
	// eine Antwort; die nächste liest neu.
	if s.fassung == fassung {
		s.bild = b
	}
	s.mu.Unlock()
	return b
}

// liste stellt die Antwort für eine Box zusammen: die Paare der Kernel-Menge
// mit dieser Box, dazu der SSH-Schlüssel des Technikers aus dem Stand.
// naechste ist die Zeit, bis der erste Eintrag wegfällt (0: keiner).
func (s *Stelle) liste(st *stand, box netip.Addr, b *bild) (liste []posten, naechste time.Duration) {
	jetzt := time.Now()
	for paar, bis := range b.bis {
		if paar.Box != box {
			continue
		}
		rest := bis.Sub(jetzt)
		if rest < time.Second {
			continue
		}
		t, ok := st.techniker[paar.Techniker]
		if !ok || t.ssh.Zeile == "" {
			continue
		}
		liste = append(liste, posten{
			Eintrag:   Eintrag{Sekunden: int(rest / time.Second), Zugang: t.id, Schluessel: t.ssh.Zeile},
			techniker: t.kennung, fingerabdruck: t.ssh.Fingerabdruck, bis: bis,
		})
	}
	sort.Slice(liste, func(i, j int) bool { return liste[i].Zugang < liste[j].Zugang })
	if len(liste) > MaxJeBox {
		s.Log.Warn("Mehr offene Fenster zu einer Box, als eine Antwort Schlüssel nennt - die übrigen fehlen",
			"box", box, "fenster", len(liste), "genannt", MaxJeBox)
		liste = liste[:MaxJeBox]
	}
	for _, p := range liste {
		// Unter einer Sekunde Restlaufzeit fällt der Eintrag weg.
		if d := p.bis.Sub(jetzt) - time.Second + 20*time.Millisecond; naechste == 0 || d < naechste {
			naechste = d
		}
	}
	return liste, naechste
}

// Frage beantwortet die Anfrage einer Box. kennt ist der Prüfwert, den die
// Box schon hat: solange die Liste denselben trägt, bleibt die Anfrage bis zu
// warte lang offen. Vorher endet sie, wenn die Liste eine andere wird, ein
// Eintrag abläuft oder das Ende eines Fensters neu gesetzt wird.
//
// Je Box ist nur eine Anfrage offen; eine neuere löst die ältere ab (eine
// Box, die neu gestartet ist, wartet nicht auf ihre alte Verbindung).
func (s *Stelle) Frage(ctx context.Context, box netip.Addr, warte time.Duration, kennt string) Antwort {
	if !soll.IstHost(s.BoxNetz, box) {
		return Antwort{http.StatusForbidden, []byte("keine Box-Adresse\n")}
	}
	if warte > MaxWarte {
		warte = MaxWarte
	}
	ich := &wartender{abgeloest: make(chan struct{})}
	s.mu.Lock()
	if s.wecker == nil {
		s.wecker = make(chan struct{})
	}
	if s.wartende == nil {
		s.wartende = map[netip.Addr]*wartender{}
	}
	if alt := s.wartende[box]; alt != nil {
		close(alt.abgeloest)
	}
	s.wartende[box] = ich
	if bs := s.box(box); bs != nil {
		bs.letzteAnfrage = s.Jetzt()
		bs.anfragen++
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.wartende[box] == ich {
			delete(s.wartende, box)
		}
		s.mu.Unlock()
	}()

	ende := time.Now().Add(warte)
	var zuerst map[string]time.Time // Zugang -> Ende des Fensters bei der ersten Lesung
	for {
		s.mu.Lock()
		wecker, st := s.wecker, s.stand
		s.mu.Unlock()
		if st == nil {
			// Kein frischer Stand seit dem Start: keine Liste, auch keine
			// leere. Eine leere hieße "niemand darf", und das weiß der
			// Dienst nicht. Die Box behält, was sie hat, bis zur Frist.
			return Antwort{http.StatusServiceUnavailable, []byte("kein gültiger Soll-Stand\n")}
		}
		b := s.lies()
		if b.err != nil {
			s.meldeLeseFehler(b.err)
			return Antwort{http.StatusServiceUnavailable, []byte("Fenster nicht lesbar\n")}
		}
		liste, naechste := s.liste(st, box, b)
		eintraege := make([]Eintrag, len(liste))
		for i, p := range liste {
			eintraege[i] = p.Eintrag
		}
		rest := time.Until(ende)
		gesprungen := false
		if zuerst == nil {
			zuerst = map[string]time.Time{}
			for _, p := range liste {
				zuerst[p.Zugang] = p.bis
			}
		} else {
			for _, p := range liste {
				if d := p.bis.Sub(zuerst[p.Zugang]); d > restSprung || d < -restSprung {
					gesprungen = true
				}
			}
		}
		if kennt == "" || kennt != Pruefwert(eintraege) || rest <= 0 || gesprungen {
			s.gibAus(box, st, liste)
			return Antwort{http.StatusOK, Text(eintraege)}
		}
		if naechste > 0 && naechste < rest {
			rest = naechste
		}
		t := time.NewTimer(rest)
		select {
		case <-ctx.Done():
			t.Stop()
			return Antwort{}
		case <-ich.abgeloest:
			t.Stop()
			return Antwort{http.StatusTooManyRequests, []byte("von einer neueren Anfrage derselben Box abgelöst\n")}
		case <-wecker:
			t.Stop()
		case <-t.C:
		}
	}
}

// box liefert den Merkzettel einer Box (mit gehaltenem mu); nil, wenn schon
// zu viele vermerkt sind.
func (s *Stelle) box(a netip.Addr) *boxStand {
	if s.boxen == nil {
		s.boxen = map[netip.Addr]*boxStand{}
		s.seit = s.Jetzt()
	}
	bs := s.boxen[a]
	if bs == nil {
		if len(s.boxen) >= maxBoxen {
			return nil
		}
		bs = &boxStand{ausgegeben: map[string]Ausgegeben{}}
		s.boxen[a] = bs
	}
	return bs
}

func (s *Stelle) meldeLeseFehler(err error) {
	s.mu.Lock()
	melden := time.Since(s.leseFehler) > 30*time.Second
	if melden {
		s.leseFehler = time.Now()
	}
	s.mu.Unlock()
	if melden {
		s.Log.Warn("Schlüsselausgabe: Fenster nicht lesbar - keine Liste", "fehler", err)
	}
}

// gibAus hält fest, was eine Box jetzt bekommt, und schreibt ins Journal, was
// sich gegenüber ihrer letzten Antwort geändert hat: welcher Schlüssel neu
// genannt wird und welcher nicht mehr. Eine unveränderte Antwort steht nicht
// im Journal; wann die Box zuletzt gefragt hat, zeigt `status`.
func (s *Stelle) gibAus(box netip.Addr, st *stand, liste []posten) {
	jetzt := s.Jetzt()
	s.mu.Lock()
	bs := s.box(box)
	if bs == nil {
		s.mu.Unlock()
		return
	}
	neu := map[string]Ausgegeben{}
	var dazu, weg []Ausgegeben
	var sekunden []int
	for _, p := range liste {
		k := p.Zugang + " " + p.fingerabdruck
		a, schon := bs.ausgegeben[k]
		if !schon {
			a = Ausgegeben{Zugang: p.Zugang, Techniker: p.techniker, Fingerabdruck: p.fingerabdruck, Seit: jetzt}
			dazu = append(dazu, a)
			sekunden = append(sekunden, p.Sekunden)
		}
		a.Bis = jetzt.Add(time.Duration(p.Sekunden) * time.Second)
		neu[k] = a
	}
	for k, a := range bs.ausgegeben {
		if _, bleibt := neu[k]; !bleibt {
			weg = append(weg, a)
		}
	}
	bs.ausgegeben = neu
	s.mu.Unlock()

	sort.Slice(weg, func(i, j int) bool { return weg[i].Zugang < weg[j].Zugang })
	kennung := st.boxen[box]
	for _, a := range weg {
		s.Log.Info("Schlüssel nicht mehr ausgegeben", "box", box, "kennung", kennung, "techniker", a.Techniker,
			"zugang", a.Zugang, "fingerabdruck", a.Fingerabdruck)
	}
	for i, a := range dazu {
		s.Log.Info("Schlüssel ausgegeben", "box", box, "kennung", kennung, "techniker", a.Techniker,
			"zugang", a.Zugang, "fingerabdruck", a.Fingerabdruck, "sekunden", sekunden[i])
	}
	if len(dazu)+len(weg) > 0 {
		s.Sichere()
	}
}

// Ausgegeben ist ein Schlüssel, den die letzte Antwort an eine Box genannt hat.
type Ausgegeben struct {
	Zugang        string    `json:"zugang"`
	Techniker     string    `json:"techniker"`
	Fingerabdruck string    `json:"fingerabdruck"`
	Seit          time.Time `json:"seit"`
	Bis           time.Time `json:"bis"`
}

// BoxZustand ist, was `status` zu einer Box zeigt.
type BoxZustand struct {
	LetzteAnfrage time.Time    `json:"letzteAnfrage"`
	Anfragen      int          `json:"anfragen"`
	Ausgegeben    []Ausgegeben `json:"ausgegeben,omitempty"`
}

// Zustand ist der Inhalt von schluessel.json - für `vp-tunnel-dienst status`.
// Er beginnt mit jedem Start des Dienstes neu.
type Zustand struct {
	Seit        time.Time             `json:"seit"`
	Geschrieben time.Time             `json:"geschrieben"`
	Adresse     string                `json:"adresse"`
	Laeuft      bool                  `json:"laeuft"`
	Boxen       map[string]BoxZustand `json:"boxen"`
}

// Sichere schreibt schluessel.json. Der Dienst ruft es nach jedem Lauf auf;
// die Angabe "zuletzt gefragt" in `status` ist deshalb bis zu ein
// Abrufintervall alt.
func (s *Stelle) Sichere() {
	jetzt := s.Jetzt()
	s.mu.Lock()
	if s.seit.IsZero() {
		s.seit = jetzt
	}
	z := Zustand{Seit: s.seit, Geschrieben: jetzt, Adresse: s.Adresse, Laeuft: s.laeuft, Boxen: map[string]BoxZustand{}}
	for a, bs := range s.boxen {
		bz := BoxZustand{LetzteAnfrage: bs.letzteAnfrage, Anfragen: bs.anfragen}
		for _, x := range bs.ausgegeben {
			bz.Ausgegeben = append(bz.Ausgegeben, x)
		}
		sort.Slice(bz.Ausgegeben, func(i, j int) bool { return bz.Ausgegeben[i].Zugang < bz.Ausgegeben[j].Zugang })
		z.Boxen[a.String()] = bz
	}
	s.mu.Unlock()
	daten, _ := json.MarshalIndent(z, "", "  ")
	if err := ablage.Schreibe(s.Zustand, zustandsDatei, append(daten, '\n')); err != nil {
		s.Log.Warn("schluessel.json nicht geschrieben", "fehler", err)
	}
}

// LiesZustand liefert schluessel.json.
func LiesZustand(verzeichnis string) (Zustand, error) {
	var z Zustand
	daten, err := os.ReadFile(filepath.Join(verzeichnis, zustandsDatei))
	if err != nil {
		return z, err
	}
	return z, json.Unmarshal(daten, &z)
}
