// Package dienst ist die Schleife des Werkstatt-Dienstes: Im Takt hält er
// die Werkbank-Brücke bereit (einrichten, pflegen, Status lesen), liest die
// Freigabe und stellt beides für Anzeige und Metriken bereit.
//
// Erkennen einer Box am Werkstatt-Anschluss und ihr Lauf kommen mit den
// Paketen P3 und P5 dazu; die Schleife hat dafür schon den Läufer.
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
	Lauf     *lauf.Stand     `json:"lauf,omitempty"`
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

	mu                           sync.Mutex
	ansicht                      Ansicht
	pauseBis                     time.Time
	laeuft                       atomic.Bool
	beendet                      atomic.Bool
	letzterGrund, letzteFreigabe string

	mBereit, mAlter, mKabel, mGeraete, mFreigabe, mEinrichtenFehler metriken.Messwert
	mEinrichten                                                     metriken.Zaehler
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
	d.mBereit.Setze(0)
	d.mFreigabe.Setze(0)
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
	if d.Laeufer != nil && a.Lauf != nil {
		s := *a.Lauf
		a.Lauf = &s
	}
	return a
}

// Laufe führt die Schleife bis zum Ende von ctx.
func (d *Dienst) Laufe(ctx context.Context) {
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
	d.mu.Lock()
	d.ansicht.Zeit = jetzt.UTC()
	d.mu.Unlock()
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
