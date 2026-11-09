// Package gehaeuse baut die Druckdatei des Gehäuses je Box (Konzept Schritt 19,
// Paket P10): Referenz in Klarschrift und QR-Code mit dem Direktlink liegen im
// Unterteil (Entscheid 8, kein Aufkleber). Gebaut und geprüft wird mit dem
// Gehäuse-Programm (edge-light/gehaeuse/glinet-gl-mt300n-v2,
// `bauen.sh --referenz`), im Cluster in seinem Bau-Image als Kubernetes-Job.
//
// Ein Auftrag je Referenz, einer zur Zeit (das Programm baut und slict nie
// parallel). Der Lauf an der Box wartet nicht darauf: Er bestellt den Auftrag
// nach der Übergabe, die nächste Mango kann schon am Kabel stecken. Fertig ist
// ein Auftrag nur mit dem Beleg des Programms: Rückgabewert 0 und ein
// Prüfbericht ohne Fehler. Die Dateien liegen in der Ablage und kommen über die
// Werkstatt-Anzeige zum Drucker; den Druck startet ein Mensch (WI-11 A).
package gehaeuse

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/referenz"
)

// Zustand eines Auftrags.
type Zustand string

const (
	Wartet Zustand = "wartet"
	Baut   Zustand = "baut"
	Fertig Zustand = "fertig"
	Fehler Zustand = "fehler"
)

// Datei ist eine abgelegte Datei eines Auftrags.
type Datei struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	Sha256 string `json:"sha256"`
}

// Auftrag ist das Gehäuse einer Box.
type Auftrag struct {
	Referenz    string    `json:"referenz"`
	Lauf        string    `json:"lauf,omitempty"` // der Lauf, der ihn bestellt hat
	Zustand     Zustand   `json:"zustand"`
	Bestellt    time.Time `json:"bestellt"`
	Beginn      time.Time `json:"beginn,omitzero"`
	Ende        time.Time `json:"ende,omitzero"`
	Grund       string    `json:"grund,omitempty"`
	Beleg       string    `json:"beleg,omitempty"` // aus dem Prüfbericht
	Job         string    `json:"job,omitempty"`   // Name des Kubernetes-Jobs
	Dateien     []Datei   `json:"dateien,omitempty"`
	Hochgeladen bool      `json:"hochgeladen,omitempty"` // die Box-Druckdatei liegt im Portal
}

// Bauer baut das Gehäuse einer Referenz. Danach liegt die Ausgabe des
// Programms unter ziel: kennung/<ref>/… (wie aus/ des Programms) und
// ausgabe.log. nil heißt Rückgabewert 0; ob der Bericht ohne Fehler ist, prüft
// die Werkstatt selbst. job meldet den Namen des Jobs, sobald er feststeht.
type Bauer interface {
	Baue(ctx context.Context, ref, ziel string, job func(string)) error
}

// Hochlader lädt die fertige Box-Druckdatei zur API hoch (vp-mango-3mf-pro-box):
// die Werkstatt-Box-Seite im Portal bietet danach genau SIE zum Download an.
// Dazu der Abgleich Portal ↔ Ablage (GehaeuseOffen): welche abgenommenen
// Boxen im Portal noch keine Druckdatei haben, auch eine, deren Werkstatt-Lauf
// sie nie bestellt hat (zu alt für diese Funktion - vp-mango-3mf-pro-box kam
// erst später). nil: kein Portal (Datei-Freigabe V1a), die Druckdatei bleibt
// nur in der internen Ablage, kein Abgleich.
type Hochlader interface {
	GehaeuseHochladen(ctx context.Context, edgeRef, name string, daten []byte, sha256 string) error
	// GehaeuseOffen gibt die Edge-Refs abgenommener Boxen ohne Druckdatei im Portal.
	GehaeuseOffen(ctx context.Context) ([]string, error)
}

// Name der Ausgabe des Programms je Auftrag (stdout und stderr).
const Ausgabe = "ausgabe.log"

// Der Satz, mit dem das Programm einen Bericht ohne Fehler beginnt
// (gehaeuse/__main__.py, referenz()).
const ohneFehler = "Keine verletzte Regel"

var fehlerZeile = regexp.MustCompile(`(?m)^- \*\*Fehler:\*\* (.+)$`)

// Werkstatt hält die Aufträge, ihre Ablage und die Schlange.
type Werkstatt struct {
	ablage    string
	bauer     Bauer
	hochlader Hochlader
	frist     time.Duration
	takt      time.Duration
	log       *slog.Logger
	jetzt     func() time.Time

	mu        sync.Mutex
	auftraege map[string]*Auftrag
	schlange  []string
	wecken    chan struct{}
}

// Neu liest die Ablage. Was vor einem Neustart wartete oder baute, kommt
// wieder in die Schlange (ein Bau ist wiederholbar und baut gleich). h: nil
// ohne Portal (Datei-Freigabe V1a) - die Druckdatei bleibt dann nur lokal, kein
// Hochladen und kein Abgleich. takt: wie oft Laufe das Hochladen und den
// Abgleich mit dem Portal wiederholt, solange die Schlange leer ist (Vorgabe:
// derselbe Takt wie der Rest des Dienstes, VP_WERKSTATT_TAKT).
func Neu(ablage string, b Bauer, h Hochlader, frist, takt time.Duration, log *slog.Logger) (*Werkstatt, error) {
	if err := os.MkdirAll(ablage, 0o750); err != nil {
		return nil, fmt.Errorf("Ablage der Gehäuse: %w", err)
	}
	w := &Werkstatt{ablage: ablage, bauer: b, hochlader: h, frist: frist, takt: takt, log: log, jetzt: time.Now,
		auftraege: map[string]*Auftrag{}, wecken: make(chan struct{}, 1)}
	eintraege, err := os.ReadDir(ablage)
	if err != nil {
		return nil, err
	}
	var offen []*Auftrag
	for _, e := range eintraege {
		if !e.IsDir() || !referenz.Gueltig(e.Name()) {
			continue
		}
		roh, err := os.ReadFile(filepath.Join(ablage, e.Name(), "auftrag.json"))
		if err != nil {
			continue
		}
		var a Auftrag
		if json.Unmarshal(roh, &a) != nil || a.Referenz != e.Name() {
			log.Warn("Gehäuse: Auftrag in der Ablage unlesbar, übergangen", "referenz", e.Name())
			continue
		}
		w.auftraege[a.Referenz] = &a
		if a.Zustand == Wartet || a.Zustand == Baut {
			offen = append(offen, &a)
		}
	}
	sort.Slice(offen, func(i, j int) bool { return offen[i].Bestellt.Before(offen[j].Bestellt) })
	for _, a := range offen {
		if a.Zustand == Baut {
			log.Info("Gehäuse: Bau war beim Neustart nicht zu Ende, neu eingereiht", "referenz", a.Referenz, "job", a.Job)
		}
		a.Zustand, a.Beginn, a.Job = Wartet, time.Time{}, ""
		_ = w.speichere(a)
		w.schlange = append(w.schlange, a.Referenz)
	}
	return w, nil
}

// Bestelle reiht das Gehäuse einer Referenz ein. Ist es schon bestellt oder
// fertig, bleibt es dabei; neu baut ein fertiges oder gescheitertes noch
// einmal (Nachdruck, nach einem behobenen Fehler).
func (w *Werkstatt) Bestelle(ref, lauf string, neu bool) (Auftrag, error) {
	if !referenz.Gueltig(ref) {
		return Auftrag{}, fmt.Errorf("keine gültige Referenz: %q", ref)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if a, ok := w.auftraege[ref]; ok {
		if a.Zustand == Wartet || a.Zustand == Baut || (a.Zustand == Fertig && !neu) {
			return *a, nil
		}
	}
	a := &Auftrag{Referenz: ref, Lauf: lauf, Zustand: Wartet, Bestellt: w.jetzt().UTC()}
	if err := os.RemoveAll(w.ordner(ref)); err != nil {
		return Auftrag{}, err
	}
	if err := w.speichere(a); err != nil {
		return Auftrag{}, err
	}
	w.auftraege[ref] = a
	w.schlange = append(w.schlange, ref)
	select {
	case w.wecken <- struct{}{}:
	default:
	}
	w.log.Info("Gehäuse bestellt", "referenz", ref, "lauf", lauf)
	return *a, nil
}

// Laufe arbeitet die Schlange ab, einen Auftrag zur Zeit, bis ctx endet.
// Vor der Schlange und danach, solange sie leer ist, im Takt (w.takt): holt
// es Uploads nach, die beim letzten Anlauf scheiterten (Fehlschlag blockiert
// den Werkstatt-Lauf nicht - nachholen im Takt genügt), und reiht Boxen ein,
// die abgenommen sind, aber im Portal noch keine Druckdatei und noch keinen
// Auftrag haben (Abgleich Portal ↔ Ablage): auch eine Box, deren Lauf die
// Bestellung nie ausgelöst hat (zu alt für diese Funktion).
func (w *Werkstatt) Laufe(ctx context.Context) {
	w.hochladenNachholen(ctx)
	w.abgleich(ctx)
	takt := w.takt
	if takt <= 0 {
		takt = 10 * time.Second
	}
	tick := time.NewTicker(takt)
	defer tick.Stop()
	for {
		ref, ok := w.naechster()
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-w.wecken:
				continue
			case <-tick.C:
				w.hochladenNachholen(ctx)
				w.abgleich(ctx)
				continue
			}
		}
		w.baue(ctx, ref)
		if ctx.Err() != nil {
			return
		}
	}
}

// abgleich fragt das Portal, welche abgenommenen Boxen noch keine Druckdatei
// haben, und reiht jede ein, die die Werkstatt noch GAR NICHT kennt (kein
// Auftrag in der Ablage): eine Box mit einem laufenden Auftrag (wartet, baut)
// braucht keinen zweiten, und eine mit Fehler wartet bewusst auf „Erneut
// erstellen“ aus dem Portal statt auf einen endlosen automatischen Nachbau.
// Ein Fehlschlag ist nur eine Warnung; der nächste Takt versucht es wieder.
func (w *Werkstatt) abgleich(ctx context.Context) {
	if w.hochlader == nil {
		return
	}
	refs, err := w.hochlader.GehaeuseOffen(ctx)
	if err != nil {
		w.log.Warn("Gehäuse: Abgleich mit dem Portal gescheitert, nächster Takt versucht es wieder", "fehler", err)
		return
	}
	for _, ref := range refs {
		if ctx.Err() != nil {
			return
		}
		w.mu.Lock()
		_, bekannt := w.auftraege[ref]
		w.mu.Unlock()
		if bekannt {
			continue
		}
		if _, err := w.Bestelle(ref, "", false); err != nil {
			w.log.Warn("Gehäuse: automatisch eingereiht gescheitert", "referenz", ref, "fehler", err)
		}
	}
}

func (w *Werkstatt) naechster() (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.schlange) == 0 {
		return "", false
	}
	ref := w.schlange[0]
	w.schlange = w.schlange[1:]
	return ref, true
}

func (w *Werkstatt) baue(ctx context.Context, ref string) {
	w.aendere(ref, func(a *Auftrag) { a.Zustand, a.Beginn = Baut, w.jetzt().UTC() })
	w.log.Info("Gehäuse: Bau beginnt", "referenz", ref)
	bau := filepath.Join(w.ordner(ref), "bau")
	_ = os.RemoveAll(bau)
	if err := os.MkdirAll(bau, 0o770); err != nil {
		w.ende(ref, Fehler, "Ablage: "+err.Error(), "", nil)
		return
	}
	bctx, cancel := context.WithTimeout(ctx, w.frist)
	err := w.bauer.Baue(bctx, ref, bau, func(job string) { w.aendere(ref, func(a *Auftrag) { a.Job = job }) })
	cancel()
	if ctx.Err() != nil {
		// Der Dienst endet: Der Auftrag bleibt „baut“ und kommt beim Start wieder in die Schlange.
		return
	}
	if errors.Is(bctx.Err(), context.DeadlineExceeded) && err != nil {
		err = fmt.Errorf("nicht in %s fertig: %w", w.frist, err)
	}
	zustand, grund, beleg, dateien := w.sammle(ref, bau, err)
	// Erst aufräumen, dann das Ende melden: Wer „fertig“ liest, findet den
	// Bauordner nicht mehr vor.
	_ = os.RemoveAll(bau)
	w.ende(ref, zustand, grund, beleg, dateien)
	if zustand == Fertig {
		w.hochladenVersuch(ctx, ref)
	}
}

// hochladenVersuch lädt die Box-Druckdatei (gehaeuse-<ref>.3mf) zur API hoch,
// wenn ein Portal eingerichtet ist. Ein Fehlschlag ist nur eine Warnung: der
// Lauf an der Box wartet nicht darauf, und der nächste Anlauf des Dienstes
// holt ihn nach (hochladenNachholen).
func (w *Werkstatt) hochladenVersuch(ctx context.Context, ref string) {
	if w.hochlader == nil {
		return
	}
	name := "gehaeuse-" + ref + ".3mf"
	var sha string
	w.mu.Lock()
	if a, ok := w.auftraege[ref]; ok {
		for _, d := range a.Dateien {
			if d.Name == name {
				sha = d.Sha256
			}
		}
	}
	w.mu.Unlock()
	if sha == "" {
		w.log.Warn("Gehäuse: Druckdatei nicht abgelegt, kein Hochladen", "referenz", ref, "datei", name)
		return
	}
	daten, err := os.ReadFile(filepath.Join(w.ordner(ref), name))
	if err != nil {
		w.log.Warn("Gehäuse: Druckdatei nicht lesbar, kein Hochladen", "referenz", ref, "fehler", err)
		return
	}
	if err := w.hochlader.GehaeuseHochladen(ctx, ref, name, daten, sha); err != nil {
		w.log.Warn("Gehäuse: Hochladen zur API gescheitert, nächster Anlauf holt es nach",
			"referenz", ref, "fehler", err)
		return
	}
	w.aendere(ref, func(a *Auftrag) { a.Hochgeladen = true })
	w.log.Info("Gehäuse: Box-Druckdatei im Portal", "referenz", ref)
}

// hochladenNachholen versucht jeden fertigen, noch nicht hochgeladenen
// Auftrag genau einmal (Start des Dienstes, aus Laufe).
func (w *Werkstatt) hochladenNachholen(ctx context.Context) {
	if w.hochlader == nil {
		return
	}
	w.mu.Lock()
	var offen []string
	for ref, a := range w.auftraege {
		if a.Zustand == Fertig && !a.Hochgeladen {
			offen = append(offen, ref)
		}
	}
	w.mu.Unlock()
	sort.Strings(offen)
	for _, ref := range offen {
		if ctx.Err() != nil {
			return
		}
		w.hochladenVersuch(ctx, ref)
	}
}

// sammle legt ab, was der Bau ergeben hat. Druckdateien nur bei einem Bau
// ohne Fehler; sonst nur Bericht und Ausgabe für die Suche nach dem Grund.
func (w *Werkstatt) sammle(ref, bau string, baufehler error) (Zustand, string, string, []Datei) {
	quelle := filepath.Join(bau, "kennung", ref)
	bericht, _ := os.ReadFile(filepath.Join(quelle, "pruefung.md"))
	var fehler []string
	for _, m := range fehlerZeile.FindAllStringSubmatch(string(bericht), -1) {
		fehler = append(fehler, m[1])
	}
	gut := baufehler == nil && len(fehler) == 0 && strings.Contains(string(bericht), ohneFehler)
	if gut {
		if _, err := os.Stat(filepath.Join(quelle, "gehaeuse-"+ref+".3mf")); err != nil {
			gut = false
			fehler = append(fehler, "gehaeuse-"+ref+".3mf fehlt")
		}
	}
	var dateien []Datei
	nimm := func(von, name string) {
		d, err := lege(von, filepath.Join(w.ordner(ref), name))
		if err != nil {
			w.log.Warn("Gehäuse: Datei nicht abgelegt", "referenz", ref, "datei", name, "fehler", err)
			return
		}
		dateien = append(dateien, d)
	}
	if gut {
		eintraege, _ := os.ReadDir(quelle)
		for _, e := range eintraege {
			if e.Type().IsRegular() && Druckbar(ref, e.Name()) {
				nimm(filepath.Join(quelle, e.Name()), e.Name())
			}
		}
		return Fertig, "", "pruefung.md: " + ohneFehler + "; der QR-Code ist aus dem G-Code lesbar", dateien
	}
	if len(bericht) > 0 {
		nimm(filepath.Join(quelle, "pruefung.md"), "pruefung.md")
	}
	if _, err := os.Stat(filepath.Join(bau, Ausgabe)); err == nil {
		nimm(filepath.Join(bau, Ausgabe), Ausgabe)
	}
	var grund []string
	if baufehler != nil {
		grund = append(grund, baufehler.Error())
	}
	grund = append(grund, fehler...)
	if len(bericht) == 0 {
		grund = append(grund, "kein Prüfbericht")
	}
	return Fehler, strings.Join(grund, "; "), "", dateien
}

// Druckbar sagt, welche Dateien eines fertigen Baus abgelegt werden: die zwei
// Druckdateien, der Bericht und die Bilder. Das geslicte 3MF des Slicers nicht
// (es ist nur zur Prüfung, an keinem Drucker eingestellt).
func Druckbar(ref, name string) bool {
	switch name {
	case "gehaeuse-" + ref + ".3mf", "unterteil-" + ref + ".3mf", "pruefung.md":
		return true
	}
	return bild.MatchString(name)
}

var bild = regexp.MustCompile(`^[a-z0-9-]+\.png$`)

// Abrufbar sagt, ob eine Datei über die Anzeige ausgeliefert werden darf.
func Abrufbar(ref, name string) bool {
	return Druckbar(ref, name) || name == Ausgabe
}

func lege(von, nach string) (Datei, error) {
	if err := os.Rename(von, nach); err != nil {
		return Datei{}, err
	}
	f, err := os.Open(nach)
	if err != nil {
		return Datei{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return Datei{}, err
	}
	return Datei{Name: filepath.Base(nach), Bytes: n, Sha256: hex.EncodeToString(h.Sum(nil))}, nil
}

func (w *Werkstatt) ende(ref string, z Zustand, grund, beleg string, dateien []Datei) {
	w.aendere(ref, func(a *Auftrag) {
		a.Zustand, a.Ende, a.Grund, a.Beleg, a.Dateien = z, w.jetzt().UTC(), grund, beleg, dateien
	})
	if z == Fertig {
		w.log.Info("Gehäuse fertig", "referenz", ref, "beleg", beleg)
	} else {
		w.log.Warn("Gehäuse gescheitert", "referenz", ref, "grund", grund)
	}
}

func (w *Werkstatt) aendere(ref string, f func(*Auftrag)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	a, ok := w.auftraege[ref]
	if !ok {
		return
	}
	f(a)
	if err := w.speichere(a); err != nil {
		w.log.Error("Gehäuse: Auftrag nicht gespeichert", "referenz", ref, "fehler", err)
	}
}

func (w *Werkstatt) speichere(a *Auftrag) error {
	dir := w.ordner(a.Referenz)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	roh, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, ".auftrag.json.neu")
	if err := os.WriteFile(tmp, append(roh, '\n'), 0o640); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "auftrag.json"))
}

func (w *Werkstatt) ordner(ref string) string { return filepath.Join(w.ablage, ref) }

// Auftraege gibt alle Aufträge, die neuesten zuerst.
func (w *Werkstatt) Auftraege() []Auftrag {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := make([]Auftrag, 0, len(w.auftraege))
	for _, a := range w.auftraege {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bestellt.After(out[j].Bestellt) })
	return out
}

// Offene gibt die Aufträge, die im Portal noch nicht als Druckdatei stehen
// (wartet, baut, fehler, oder fertig ohne hochgeladen zu sein), älteste
// Bestellung zuerst - für die Ansicht des Dienstes (Werkstatt-Box-Seite im
// Portal, additiv): ein fertiger und hochgeladener Auftrag zeigt sich dort
// schon über seine Druckdatei, er braucht keinen zweiten Platz in der Ansicht.
func (w *Werkstatt) Offene() []Auftrag {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []Auftrag
	for _, a := range w.auftraege {
		if a.Zustand != Fertig || !a.Hochgeladen {
			out = append(out, *a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bestellt.Before(out[j].Bestellt) })
	return out
}

// Datei gibt den Pfad einer abgelegten Datei, wenn es sie gibt und sie
// abgerufen werden darf.
func (w *Werkstatt) Datei(ref, name string) (string, bool) {
	if !referenz.Gueltig(ref) || !Abrufbar(ref, name) {
		return "", false
	}
	w.mu.Lock()
	a, ok := w.auftraege[ref]
	var abgelegt bool
	if ok {
		for _, d := range a.Dateien {
			abgelegt = abgelegt || d.Name == name
		}
	}
	w.mu.Unlock()
	if !abgelegt {
		return "", false
	}
	return filepath.Join(w.ordner(ref), name), true
}

// Wartend zählt die Aufträge, die warten oder bauen (Metrik).
func (w *Werkstatt) Wartend() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := 0
	for _, a := range w.auftraege {
		if a.Zustand == Wartet || a.Zustand == Baut {
			n++
		}
	}
	return n
}
