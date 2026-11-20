// Package bestand hält, wessen SSH-Schlüssel sich gerade im Wartungstunnel
// anmelden darf: die Fenster-Schlüssel aus der letzten gültigen Antwort der
// Schlüsselausgabe und die dauerhaften Schlüssel der Box.
//
// Regeln (docs/fernwartung.md, „Die Box-Seite“):
//   - Fenster-Schlüssel liegen nur im Speicher dieses Prozesses. Ein Neustart
//     des Programms oder der Box löscht jeden.
//   - Jeder hat eine Frist in LAUFZEIT (monotone Uhr), nicht in Uhrzeit: eine
//     falsche oder springende Uhr verlängert nichts.
//   - Eine gültige Antwort ist die ganze Liste: Was sie nicht mehr nennt, ist
//     sofort gestrichen.
//   - Die dauerhaften Schlüssel stehen in der Schlüsseldatei von root
//     (/root/.ssh/authorized_keys); sie wird nur gelesen, bei jeder Anmeldung
//     neu. Eine Zeile mit Optionen vor dem Schlüssel gilt im Tunnel nicht:
//     Dieser Server könnte die Optionen nicht durchsetzen.
//   - Ein dauerhafter Schlüssel geht vor: Ist derselbe Schlüssel zugleich
//     Fenster-Schlüssel, gilt die Anmeldung als dauerhaft.
package bestand

import (
	"bufio"
	"bytes"
	"os"
	"sort"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/vertrag"
)

// Art eines Schlüssels.
type Art string

const (
	Dauerhaft Art = "dauerhaft"
	Fenster   Art = "fenster"
)

// Urteil sagt, als was ein Schlüssel gilt.
type Urteil struct {
	Art           Art
	Zugang        string // nur Fenster
	Fingerabdruck string // SHA256:…, wie ssh-keygen -lf und das Portal ihn zeigen
}

type fensterSchluessel struct {
	blob   []byte
	fp     string
	zugang string
	frist  time.Time
}

// Bestand ist der Stand der Box. Der Nullwert gilt nicht: Neu.
type Bestand struct {
	dauerDatei string
	jetzt      func() time.Time

	mu      sync.Mutex
	fenster []fensterSchluessel
}

// Neu legt einen leeren Bestand an. jetzt nil: time.Now (mit monotoner Uhr).
func Neu(dauerDatei string, jetzt func() time.Time) *Bestand {
	if jetzt == nil {
		jetzt = time.Now
	}
	return &Bestand{dauerDatei: dauerDatei, jetzt: jetzt}
}

// Uebernimm macht eine geprüfte Antwort zum neuen Stand: die ganze Liste, mit
// der Restlaufzeit aus dieser Antwort (sie kann kürzer geworden sein). Zurück
// kommt, ob sich die Zugänge geändert haben.
func (b *Bestand) Uebernimm(l vertrag.Liste) bool {
	jetzt := b.jetzt()
	neu := make([]fensterSchluessel, 0, len(l.Eintraege))
	for _, e := range l.Eintraege {
		neu = append(neu, fensterSchluessel{
			blob:   e.Key.Marshal(),
			fp:     ssh.FingerprintSHA256(e.Key),
			zugang: e.Zugang,
			frist:  jetzt.Add(time.Duration(e.Rest) * time.Second),
		})
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	anders := !gleicheZugaenge(b.fenster, neu)
	b.fenster = neu
	return anders
}

// Verfalle streicht, was seine Frist erreicht hat. Zurück kommt, ob etwas
// gestrichen wurde.
func (b *Bestand) Verfalle() bool {
	jetzt := b.jetzt()
	b.mu.Lock()
	defer b.mu.Unlock()
	rest := b.fenster[:0]
	for _, f := range b.fenster {
		if f.frist.After(jetzt) {
			rest = append(rest, f)
		}
	}
	weg := len(rest) != len(b.fenster)
	b.fenster = rest
	return weg
}

// Pruefe sagt, ob sich key jetzt anmelden darf. Die Frist prüft die Anmeldung
// selbst, unabhängig davon, ob schon jemand Verfallenes gestrichen hat.
func (b *Bestand) Pruefe(key ssh.PublicKey) (Urteil, bool) {
	blob := key.Marshal()
	fp := ssh.FingerprintSHA256(key)
	dauer, _, _ := b.liesDauerhaft()
	for _, d := range dauer {
		if bytes.Equal(d, blob) {
			return Urteil{Art: Dauerhaft, Fingerabdruck: fp}, true
		}
	}
	jetzt := b.jetzt()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, f := range b.fenster {
		if f.frist.After(jetzt) && bytes.Equal(f.blob, blob) {
			return Urteil{Art: Fenster, Zugang: f.zugang, Fingerabdruck: fp}, true
		}
	}
	return Urteil{}, false
}

// FensterGilt sagt, ob der Fenster-Schlüssel mit diesem Fingerabdruck jetzt
// noch gilt. Eine Sitzung, die mit ihm begann, endet sonst.
func (b *Bestand) FensterGilt(fingerabdruck string) bool {
	jetzt := b.jetzt()
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, f := range b.fenster {
		if f.fp == fingerabdruck && f.frist.After(jetzt) {
			return true
		}
	}
	return false
}

// FensterStand ist ein gültiger Fenster-Schlüssel, ohne den Schlüssel.
type FensterStand struct {
	Zugang string
	Rest   time.Duration
}

// Fenster gibt die gültigen Fenster-Schlüssel, geordnet nach Zugang.
func (b *Bestand) Fenster() []FensterStand {
	jetzt := b.jetzt()
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []FensterStand
	for _, f := range b.fenster {
		if f.frist.After(jetzt) {
			out = append(out, FensterStand{Zugang: f.zugang, Rest: f.frist.Sub(jetzt)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Zugang < out[j].Zugang })
	return out
}

// NaechsteFrist gibt die Zeit bis zur nächsten Frist; ok false ohne gültigen
// Fenster-Schlüssel.
func (b *Bestand) NaechsteFrist() (time.Duration, bool) {
	var min time.Duration
	ok := false
	for _, f := range b.Fenster() {
		if !ok || f.Rest < min {
			min, ok = f.Rest, true
		}
	}
	return min, ok
}

// Dauerhaft zählt die dauerhaften Schlüssel, die im Tunnel gelten, und die
// Zeilen mit Optionen, die dort nicht gelten.
func (b *Bestand) Dauerhaft() (gelten, mitOptionen int, err error) {
	d, o, err := b.liesDauerhaft()
	return len(d), o, err
}

// DauerDatei ist der Pfad der Schlüsseldatei.
func (b *Bestand) DauerDatei() string { return b.dauerDatei }

func (b *Bestand) liesDauerhaft() (blobs [][]byte, mitOptionen int, err error) {
	if b.dauerDatei == "" {
		return nil, 0, nil
	}
	daten, err := os.ReadFile(b.dauerDatei)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, 0, err
	}
	sc := bufio.NewScanner(bytes.NewReader(daten))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		z := bytes.TrimSpace(sc.Bytes())
		if len(z) == 0 || z[0] == '#' {
			continue
		}
		key, _, optionen, _, perr := ssh.ParseAuthorizedKey(z)
		if perr != nil {
			continue
		}
		if len(optionen) > 0 {
			mitOptionen++
			continue
		}
		blobs = append(blobs, key.Marshal())
	}
	return blobs, mitOptionen, sc.Err()
}

func gleicheZugaenge(a, b []fensterSchluessel) bool {
	if len(a) != len(b) {
		return false
	}
	paar := func(l []fensterSchluessel) []string {
		out := make([]string, 0, len(l))
		for _, f := range l {
			out = append(out, f.zugang+" "+f.fp)
		}
		sort.Strings(out)
		return out
	}
	x, y := paar(a), paar(b)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}
