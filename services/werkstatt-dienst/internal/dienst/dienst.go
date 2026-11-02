// Package dienst ist die Schleife des Werkstatt-Dienstes: Im Takt hält er
// die Werkbank-Brücke bereit (einrichten, pflegen, Status lesen), liest die
// Freigabe und stellt beides für Anzeige und Metriken bereit.
//
// Steckt am Werkstatt-Anschluss genau eine Mango ab Werk (192.168.8.1) oder
// mit frischem OpenWrt (192.168.1.1) und läuft eine Freigabe, beginnt ihr
// Lauf (internal/mango). Eine Box, deren Lauf zu Ende ist (fertig oder
// angehalten), fasst der Dienst nicht noch einmal an, bis sie abgezogen war.
// Eine Box unter dem LAN-Netz ist eingerichtet und wird nie angefasst.
package dienst

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// EinrichtenPause: Nach einem gescheiterten Einrichten oder Pflegen versucht
// der Dienst es erst nach dieser Zeit wieder (Status liest er weiter im Takt).
const EinrichtenPause = 10 * time.Minute

// Ansicht ist der Stand für Anzeige und Metriken.
type Ansicht struct {
	Zeit     time.Time       `json:"zeit"`
	Werkbank WerkbankAnsicht `json:"werkbank"`
	Freigabe FreigabeAnsicht `json:"freigabe"`
	// Anschluss sagt in Alltagsworten, was am Werkstatt-Anschluss steckt.
	Anschluss string      `json:"anschluss,omitempty"`
	Lauf      *lauf.Stand `json:"lauf,omitempty"`
}

// WerkbankAnsicht ist der Stand der Brücke.
type WerkbankAnsicht struct {
	Adresse        string           `json:"adresse"`
	Bereit         bool             `json:"bereit"`
	Grund          string           `json:"grund,omitempty"`
	Fassung        string           `json:"fassung_soll"`
	HostSchluessel string           `json:"host_schluessel,omitempty"`
	Status         *werkbank.Status `json:"status,omitempty"`
	StatusZeit     time.Time        `json:"status_zeit,omitzero"`
	Einrichten     *Einrichten      `json:"einrichten,omitempty"`
}

// Einrichten ist das letzte Einrichten oder Pflegen der Brücke.
type Einrichten struct {
	Zeit    time.Time `json:"zeit"`
	Weg     string    `json:"weg"`
	Fassung string    `json:"fassung,omitempty"`
	Fehler  string    `json:"fehler,omitempty"`
	Ausgabe string    `json:"ausgabe,omitempty"`
}

// FreigabeAnsicht ist der Stand der Freigabe.
type FreigabeAnsicht struct {
	Laufend  bool               `json:"laufend"`
	Grund    string             `json:"grund,omitempty"`
	Freigabe *freigabe.Freigabe `json:"freigabe,omitempty"`
	Boxen    int                `json:"boxen"`
}

// Dienst ist der Werkstatt-Dienst.
type Dienst struct {
	Log       *slog.Logger
	Werkbank  *werkbank.Client
	Adresse   string
	Freigaben freigabe.Quelle
	Ablage    *protokoll.Ablage
	Laeufer   *lauf.Laeufer
	Takt      time.Duration
	Jetzt     func() time.Time
	// Mango: Konfiguration der Läufe an der Box; nil heißt: keine Läufe
	// (nur Brücke und Freigabe).
	Mango *mango.Konfig

	ctx      context.Context
	aktiv    *aktiverLauf
	letzter  *lauf.Lauf
	gesperrt map[string]bool // MACs, deren Lauf zu Ende ist, bis sie abgezogen waren

	mu                           sync.Mutex
	ansicht                      Ansicht
	pauseBis                     time.Time
	laeuft                       atomic.Bool
	beendet                      atomic.Bool
	letzterGrund, letzteFreigabe string

	mBereit, mAlter, mKabel, mGeraete, mFreigabe, mWartet metriken.Messwert
	mEinrichten                                           metriken.Zaehler
}

type aktiverLauf struct {
	l *lauf.Lauf
	m *mango.Lauf
}

// Neu legt den Dienst an und meldet seine Metriken an.
func Neu(d *Dienst, reg *metriken.Register) *Dienst {
	if d.Jetzt == nil {
		d.Jetzt = time.Now
	}
	d.mBereit = reg.Messwert("vp_werkstatt_werkbank_bereit", "1, wenn die Werkbank-Brücke eingerichtet ist und ihr Status passt.")
	d.mAlter = reg.Messwert("vp_werkstatt_werkbank_status_alter_seconds", "Sekunden seit dem letzten gelesenen Status der Brücke. Fehlt, solange keiner gelesen wurde.")
	d.mKabel = reg.Messwert("vp_werkstatt_werkbank_kabel", "1, wenn am Werkstatt-Anschluss ein Kabel steckt. Fehlt ohne Status.")
	d.mGeraete = reg.Messwert("vp_werkstatt_werkbank_geraete", "Geräte (MACs), die an den Box-Adressen des Werkstatt-Anschlusses antworten. Fehlt ohne Status.")
	d.mFreigabe = reg.Messwert("vp_werkstatt_freigabe_laufend", "1, solange eine Freigabe läuft.")
	d.mEinrichten = reg.Zaehler("vp_werkstatt_werkbank_einrichten_total", "Einrichten und Pflegen der Brücke nach Ergebnis.", "ergebnis")
	d.mEinrichten.Null("ok")
	d.mEinrichten.Null("fehler")
	d.mWartet = reg.Messwert("vp_werkstatt_lauf_wartet", "1, solange ein Lauf auf eine Eingabe des Betreibers wartet (Tunnel-Adresse aus dem Portal).")
	d.mBereit.Setze(0)
	d.mFreigabe.Setze(0)
	d.mWartet.Setze(0)
	d.gesperrt = map[string]bool{}
	d.ansicht.Werkbank.Adresse = d.Adresse
	d.letzterGrund, d.letzteFreigabe = "\x00", "\x00" // der erste Stand wird immer geloggt
	return d
}

// Bereit sagt, ob die Schleife läuft (Readiness).
func (d *Dienst) Bereit() bool { return d.laeuft.Load() && !d.beendet.Load() }

// Ansicht gibt eine Kopie des Stands.
func (d *Dienst) Ansicht() Ansicht {
	d.mu.Lock()
	defer d.mu.Unlock()
	a := d.ansicht
	switch {
	case d.aktiv != nil:
		s := d.aktiv.l.Stand()
		a.Lauf = &s
	case d.letzter != nil:
		s := d.letzter.Stand()
		a.Lauf = &s
	}
	return a
}

// Eingabe reicht eine Eingabe des Betreibers an den laufenden Lauf.
func (d *Dienst) Eingabe(ctx context.Context, name, wert string) error {
	d.mu.Lock()
	a := d.aktiv
	d.mu.Unlock()
	if a == nil {
		return errors.New("es läuft kein Lauf")
	}
	switch {
	case name == "tunnel_adresse" && d.Mango != nil:
		if _, err := mango.PruefeTunnelAdresse(wert, d.Mango.BoxNetz); err != nil {
			return err
		}
	case name == "probe":
		if err := mango.PruefeProbe(wert); err != nil {
			return err
		}
	}
	return a.l.Gib(ctx, name, wert)
}

// SchliesseOffene beendet im Protokoll die Läufe, die ein früherer Prozess
// nicht zu Ende bringen konnte.
func (d *Dienst) SchliesseOffene() {
	offen, err := d.Ablage.Offene()
	if err != nil {
		d.Log.Error("offene Läufe nicht lesbar", "fehler", err)
		return
	}
	for _, k := range offen {
		_ = d.Ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBeendet, Zustand: string(lauf.Angehalten),
			Grund: "Der Dienst wurde neu gestartet; dieser Lauf ist unterbrochen. Die Box abziehen und zur Seite legen: ihr Stand ist unbekannt (ein gesetztes Passwort steht verschlüsselt im Beleg passwort_age)."})
		d.Log.Warn("Lauf durch Neustart des Dienstes unterbrochen", "request_id", k)
	}
}

// Laufe führt die Schleife bis zum Ende von ctx.
func (d *Dienst) Laufe(ctx context.Context) {
	d.mu.Lock()
	d.ctx = ctx
	d.mu.Unlock()
	d.laeuft.Store(true)
	defer d.beendet.Store(true)
	t := time.NewTicker(d.Takt)
	defer t.Stop()
	for {
		d.Runde(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Runde ist ein Takt der Schleife.
func (d *Dienst) Runde(ctx context.Context) {
	jetzt := d.Jetzt()
	d.runeWerkbank(ctx, jetzt)
	d.runeFreigabe(jetzt)
	d.runeAnschluss(jetzt)
	d.mu.Lock()
	d.ansicht.Zeit = jetzt.UTC()
	wartet := d.aktiv != nil && d.aktiv.l.Stand().Zustand == lauf.Wartet
	d.mu.Unlock()
	d.mWartet.Wahr(wartet)
}

// runeAnschluss sieht nach, was am Werkstatt-Anschluss steckt, und beginnt
// gegebenenfalls einen Lauf.
func (d *Dienst) runeAnschluss(jetzt time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.Mango == nil || d.Laeufer == nil {
		return
	}
	if d.aktiv != nil {
		d.ansicht.Anschluss = "Ein Lauf arbeitet an der Box. Nicht abziehen."
		return
	}
	w := d.ansicht.Werkbank
	if !w.Bereit || w.Status == nil {
		d.ansicht.Anschluss = "Die Brücke ist nicht bereit."
		return
	}
	s := *w.Status
	da := map[string]bool{}
	for _, a := range s.Antworten {
		for _, m := range a.MACs {
			da[m] = true
		}
	}
	for m := range d.gesperrt {
		if !da[m] {
			delete(d.gesperrt, m) // abgezogen: beim nächsten Einstecken ist sie neu
		}
	}
	if !s.Werkstatt.Kabel {
		d.ansicht.Anschluss = "Kein Kabel am Werkstatt-Anschluss."
		return
	}
	if len(s.Antworten) == 0 {
		d.ansicht.Anschluss = "Am orangen Kabel steckt keine Box (oder sie startet noch)."
		return
	}
	e, err := mango.Einzeln(s)
	if err != nil {
		d.ansicht.Anschluss = geheim.Schwaerze(err.Error())
		return
	}
	if d.gesperrt[e.MAC] {
		d.ansicht.Anschluss = "Die Box " + e.MAC + " hatte schon ihren Lauf. Abziehen; dann die nächste Box einstecken."
		return
	}
	var einstieg mango.Einstieg
	switch e.Adresse {
	case mango.WerksAdresse:
		einstieg = mango.AbWerk
	case mango.OpenWrtAdresse:
		einstieg = mango.AbOpenWrt
	default:
		d.ansicht.Anschluss = "Unter " + e.Adresse.String() + " steckt eine eingerichtete Box. Der Dienst fasst sie nicht an: abziehen."
		return
	}
	f := d.ansicht.Freigabe
	if !f.Laufend || f.Freigabe == nil {
		d.ansicht.Anschluss = "Mango erkannt, aber die Werkstatt ist nicht freigegeben: " + f.Grund
		return
	}
	l := lauf.Neu(jetzt, f.Freigabe.Kennung, freigabe.Mango)
	ml, err := mango.NeuerLauf(*d.Mango, *f.Freigabe, l.Kennung())
	if err != nil {
		d.ansicht.Anschluss = "Lauf nicht begonnen: " + geheim.Schwaerze(err.Error())
		d.Log.Error("Lauf nicht begonnen", "fehler", err)
		return
	}
	fr := f.Freigabe
	angaben := map[string]string{
		"einstieg":   string(einstieg),
		"mac":        e.MAC,
		"adresse":    e.Adresse.String(),
		"openwrt":    fr.OpenWrt.Fassung + " " + fr.OpenWrt.Datei + " sha256 " + fr.OpenWrt.Sha256,
		"edge_light": fr.EdgeLight.Fassung + ", Programm sha256 " + fr.EdgeLight.ProgrammSha256 + ", Skripte sha256 " + fr.EdgeLight.SkripteSha256,
		"lan_netz":   d.Mango.LanNetz.String(),
		"bauart":     d.Mango.Bauart,
	}
	d.aktiv = &aktiverLauf{l: l, m: ml}
	d.gesperrt[e.MAC] = true
	d.ansicht.Anschluss = "Ein Lauf arbeitet an der Box. Nicht abziehen."
	ctx := d.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		d.Laeufer.Fahre(ctx, l, angaben, ml.Schritte(einstieg))
		mac := ml.MAC()
		ml.Schliesse()
		d.mu.Lock()
		d.aktiv, d.letzter = nil, l
		if mac != "" {
			d.gesperrt[mac] = true
		}
		d.mu.Unlock()
	}()
}

func (d *Dienst) runeWerkbank(ctx context.Context, jetzt time.Time) {
	paket, err := d.Werkbank.Paket()
	if err != nil {
		d.werkbankStand(jetzt, nil, "", err)
		return
	}
	s, err := d.Werkbank.Status(ctx)
	braucht := (err == nil && (s.Fassung != paket.Fassung || s.Pflegbar())) || werkbank.Abgewiesen(err)
	d.mu.Lock()
	pause := jetzt.Before(d.pauseBis)
	d.mu.Unlock()
	if braucht && !pause {
		var erg *werkbank.Ergebnis
		s, erg, err = d.Werkbank.Bereit(ctx)
		e := &Einrichten{Zeit: jetzt.UTC()}
		if erg != nil {
			e.Weg, e.Fassung, e.Ausgabe = erg.Weg, erg.Fassung, letzte(erg.Ausgabe, 40)
		}
		if err != nil && (erg == nil) {
			e.Weg = "gescheitert"
			e.Fehler = geheim.Schwaerze(err.Error())
			d.mEinrichten.Plus("fehler")
			d.mu.Lock()
			d.pauseBis = jetzt.Add(EinrichtenPause)
			d.mu.Unlock()
			d.Log.Error("Brücke einrichten gescheitert, nächster Versuch später", "fehler", err, "pause", EinrichtenPause.String())
		} else if erg != nil {
			d.mEinrichten.Plus("ok")
		}
		d.mu.Lock()
		d.ansicht.Werkbank.Einrichten = e
		d.mu.Unlock()
	} else if braucht && err == nil {
		err = errors.New("Brücke trägt eine andere Fassung oder ihre Firewall fehlt; neuer Versuch nach der Pause")
	}
	var status *werkbank.Status
	if err == nil || s.Schema != "" {
		status = &s
	}
	if err == nil {
		err = s.Pruefe(paket.Fassung)
	}
	d.werkbankStand(jetzt, status, paket.Fassung, err)
}

func (d *Dienst) werkbankStand(jetzt time.Time, s *werkbank.Status, fassung string, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	w := &d.ansicht.Werkbank
	w.Fassung = fassung
	w.HostSchluessel = d.Werkbank.HostSchluessel()
	if s != nil {
		w.Status = s
		w.StatusZeit = jetzt.UTC()
		d.mKabel.Wahr(s.Werkstatt.Kabel)
		n := 0
		for _, a := range s.Antworten {
			n += len(a.MACs)
		}
		d.mGeraete.Setze(float64(n))
	}
	if !w.StatusZeit.IsZero() {
		d.mAlter.Setze(jetzt.Sub(w.StatusZeit).Seconds())
	}
	w.Bereit = err == nil
	w.Grund = ""
	if err != nil {
		w.Grund = geheim.Schwaerze(err.Error())
	}
	d.mBereit.Wahr(w.Bereit)
	if w.Grund != d.letzterGrund {
		if w.Bereit {
			d.Log.Info("Brücke bereit", "fassung", fassung)
		} else {
			d.Log.Warn("Brücke nicht bereit", "grund", w.Grund)
		}
		d.letzterGrund = w.Grund
	}
}

func (d *Dienst) runeFreigabe(jetzt time.Time) {
	f, err := d.Freigaben.Aktuell()
	a := FreigabeAnsicht{}
	if err == nil {
		a.Freigabe = &f
		a.Boxen, err = d.Ablage.Begonnen(f.Kennung)
		if err == nil {
			err = f.Laufend(jetzt, a.Boxen)
		}
	}
	a.Laufend = err == nil
	if err != nil {
		a.Grund = geheim.Schwaerze(err.Error())
	}
	d.mFreigabe.Wahr(a.Laufend)
	d.mu.Lock()
	d.ansicht.Freigabe = a
	d.mu.Unlock()
	merk := a.Grund
	if a.Freigabe != nil {
		merk = a.Freigabe.Kennung + "|" + a.Grund
	}
	if merk != d.letzteFreigabe {
		var keine freigabe.Keine
		switch {
		case a.Laufend:
			d.Log.Info("Freigabe läuft", "freigabe", a.Freigabe.Kennung, "bis", a.Freigabe.GueltigBis.Format(time.RFC3339), "openwrt", a.Freigabe.OpenWrt.Fassung, "edge_light", a.Freigabe.EdgeLight.Fassung)
		case errors.As(err, &keine):
			d.Log.Info("Keine laufende Freigabe", "grund", a.Grund)
		default:
			d.Log.Error("Freigabe nicht lesbar", "fehler", err)
		}
		d.letzteFreigabe = merk
	}
}

func letzte(s string, n int) string {
	z := 0
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '\n' {
			z++
			if z == n {
				return s[i+1:]
			}
		}
	}
	return s
}
