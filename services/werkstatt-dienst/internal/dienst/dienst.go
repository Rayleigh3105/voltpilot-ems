// Package dienst ist die Schleife des Werkstatt-Dienstes: Im Takt hält er
// die Werkbank-Brücke bereit (einrichten, pflegen, Status lesen), liest die
// Freigabe und stellt beides für Anzeige und Metriken bereit.
//
// Steckt am Werkstatt-Anschluss genau eine Mango ab Werk (192.168.8.1) oder
// mit frischem OpenWrt (192.168.1.1) und läuft eine Freigabe, beginnt ihr
// Lauf (internal/mango), sobald sie fertig gestartet ist. Eine Box, deren
// Lauf zu Ende ist (fertig oder angehalten), fasst der Dienst nicht noch
// einmal an, bis ihre MAC einen Takt lang weg war. Eine Box unter dem
// LAN-Netz ist eingerichtet und wird nie angefasst; nur wenn ein unfertiger
// Lauf dieser Werkstatt ihre MAC kennt, prüft ein Lauf ohne Anmeldung, ob sie
// zurückgesetzt werden darf (mango.HalbImLan).
package dienst

import (
	"context"
	"errors"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
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

// AnsichtSchema ist das Schema der Ansicht, wie sie an die Portal-API geht
// (docs/contracts/werkstatt-ansicht-v1.md).
const AnsichtSchema = "vp-werkstatt-ansicht.v1"

// Ansicht ist der Stand für Anzeige, Metriken und die Werkstatt-Bildschirme
// im Portal.
type Ansicht struct {
	Schema   string          `json:"schema"`
	Zeit     time.Time       `json:"zeit"`
	Werkbank WerkbankAnsicht `json:"werkbank"`
	Freigabe FreigabeAnsicht `json:"freigabe"`
	// Anschluss sagt in Alltagsworten, was am Werkstatt-Anschluss steckt.
	Anschluss string `json:"anschluss,omitempty"`
	// AnschlussFall ist der Code dazu (internal/faelle), solange kein Lauf
	// arbeitet; AnschlussLoesung, was zu tun ist.
	AnschlussFall    string          `json:"anschluss_fall,omitempty"`
	AnschlussLoesung *faelle.Loesung `json:"anschluss_loesung,omitempty"`
	Lauf             *lauf.Stand     `json:"lauf,omitempty"`
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
	// Melder meldet die Ansicht jeden Takt an die Portal-API (V1, die
	// Werkstatt-Bildschirme); nil heißt: nur die eigene Anzeige.
	Melder       Melder
	melderFehler string

	ctx           context.Context
	aktiv         *aktiverLauf
	letzter       *lauf.Lauf
	gesperrt      map[string]bool // MACs, deren Lauf zu Ende ist, bis sie abgezogen waren
	kandidat      *kandidat       // die Box im letzten Takt, solange ihr Lauf noch nicht begann
	unterspannung bool            // die Brücke meldet Unterspannung (Takt)

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

// Melder nimmt die Ansicht entgegen (portal.Client).
type Melder interface {
	AnsichtMelden(ctx context.Context, ansicht any) error
}

// Ansicht gibt eine Kopie des Stands.
func (d *Dienst) Ansicht() Ansicht {
	d.mu.Lock()
	defer d.mu.Unlock()
	a := d.ansicht
	a.Schema = AnsichtSchema
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
		_ = d.Ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBeendet, Zustand: string(lauf.Angehalten), Angaben: map[string]string{"fall": faelle.DienstNeuGestartet},
			Grund: "Der Dienst wurde neu gestartet; dieser Lauf ist unterbrochen. Das Kabel kurz abziehen und wieder einstecken: Der Dienst erkennt, wie weit sie war (ohne Passwort beginnt ein neuer Lauf; mit einem Passwort dieser Werkstatt nennt er den Reset-Knopf)."})
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
	d.runeAnschluss(ctx, jetzt)
	d.mu.Lock()
	d.ansicht.Zeit = jetzt.UTC()
	wartet := d.aktiv != nil && d.aktiv.l.Stand().Zustand == lauf.Wartet
	d.mu.Unlock()
	d.mWartet.Wahr(wartet)
	d.melde(ctx)
}

// melde gibt die Ansicht an das Portal. Ein Fehler hält nichts an; geloggt
// wird nur der Wechsel, nicht jeder Takt.
func (d *Dienst) melde(ctx context.Context) {
	if d.Melder == nil {
		return
	}
	mctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	err := d.Melder.AnsichtMelden(mctx, d.Ansicht())
	text := ""
	if err != nil {
		text = geheim.Schwaerze(err.Error())
	}
	if text != d.melderFehler {
		if text == "" {
			d.Log.Info("Ansicht ans Portal: wieder gemeldet")
		} else {
			d.Log.Warn("Ansicht ans Portal nicht gemeldet", "fehler", text)
		}
		d.melderFehler = text
	}
}

// StartFrist: So lange wartet der Dienst nach dem ersten Erkennen einer Box
// darauf, dass sie SSH annimmt, bevor er ihren Lauf trotzdem beginnt (der
// nennt dann den Grund und den Handgriff).
const StartFrist = 5 * time.Minute

// kandidat ist die Box, die im letzten Takt am Anschluss stand.
type kandidat struct {
	mac     string
	adresse netip.Addr
	seit    time.Time
}

// runeAnschluss sieht nach, was am Werkstatt-Anschluss steckt, und beginnt
// gegebenenfalls einen Lauf. Eine Box gilt erst als da, wenn sie in zwei
// Takten hintereinander mit derselben MAC unter derselben Adresse antwortet
// und SSH annimmt: Beim Start zeigt jede OpenWrt-Firmware für ein paar
// Sekunden 192.168.1.1 (Preinit), und Dropbear kommt nach dem Netz (Läufe
// 113810-d74e, 115040-8287). Bis dahin beginnt kein Lauf und nichts wird gesperrt.
func (d *Dienst) runeAnschluss(ctx context.Context, jetzt time.Time) {
	d.mu.Lock()
	k, einstieg, ok := d.anschlussKandidat(jetzt)
	d.mu.Unlock()
	if !ok {
		return
	}
	// Nimmt die Box SSH an? Außerhalb der Sperre: Das kann dauern.
	pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := d.Mango.Werkbank.Dial(pctx, netip.AddrPortFrom(k.adresse, 22))
	cancel()
	if err == nil {
		_ = conn.Close()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.aktiv != nil || d.kandidat == nil || *d.kandidat != k {
		return
	}
	if err != nil && strings.HasPrefix(err.Error(), "Brücke ") && strings.Contains(err.Error(), "nicht erreichbar") {
		// Der Weg zur Brücke ist weg, nicht die Box (Lauf 114050-9ef8): kein
		// Lauf, und die Startfrist beginnt neu, sobald die Brücke wieder antwortet.
		d.kandidat.seit = jetzt
		d.amAnschluss(faelle.BrueckeNichtBereit, "Die Brücke antwortet gerade nicht ("+geheim.Schwaerze(err.Error())+"). Am Raspberry Pi Strom und WLAN prüfen.")
		return
	}
	if err != nil && jetzt.Sub(k.seit) < StartFrist {
		d.amAnschluss(faelle.Startet, "Mango erkannt unter "+k.adresse.String()+"; sie startet noch ("+geheim.Schwaerze(err.Error())+"). Nicht abziehen.")
		return
	}
	d.beginneLauf(jetzt, k, einstieg)
}

// anschlussKandidat entscheidet unter der Sperre, ob am Anschluss eine Box
// steht, deren Lauf beginnen darf (ok), und mit welchem Einstieg.
func (d *Dienst) anschlussKandidat(jetzt time.Time) (kandidat, mango.Einstieg, bool) {
	if d.Mango == nil || d.Laeufer == nil {
		return kandidat{}, "", false
	}
	d.unterspannung = d.ansicht.Werkbank.Status != nil && d.ansicht.Werkbank.Status.Unterspannung()
	if d.aktiv != nil {
		d.amAnschluss("", "Ein Lauf arbeitet an der Box. Nicht abziehen.")
		return kandidat{}, "", false
	}
	vorher := d.kandidat
	d.kandidat = nil
	w := d.ansicht.Werkbank
	if !w.Bereit || w.Status == nil {
		d.amAnschluss(faelle.BrueckeNichtBereit, "Die Brücke ist nicht bereit.")
		return kandidat{}, "", false
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
			delete(d.gesperrt, m) // abgezogen oder neu gestartet: dann ist sie neu
		}
	}
	if !s.Werkstatt.Kabel {
		d.amAnschluss(faelle.KeinKabel, "Kein Kabel am Werkstatt-Anschluss.")
		return kandidat{}, "", false
	}
	if len(s.Antworten) == 0 {
		d.amAnschluss(faelle.KeineBox, "Am orangen Kabel steckt keine Box (oder sie startet noch).")
		return kandidat{}, "", false
	}
	e, err := mango.Einzeln(s)
	if err != nil {
		d.amAnschluss(faelle.ZweiGeraete, geheim.Schwaerze(err.Error()))
		return kandidat{}, "", false
	}
	if d.gesperrt[e.MAC] {
		d.amAnschluss(faelle.Gesperrt, "Die Box "+e.MAC+" hatte schon ihren Lauf. Abziehen; dann die nächste Box einstecken.")
		return kandidat{}, "", false
	}
	var einstieg mango.Einstieg
	switch e.Adresse {
	case mango.WerksAdresse:
		einstieg = mango.AbWerk
	case mango.OpenWrtAdresse:
		einstieg = mango.AbOpenWrt
	default:
		// Unter dem LAN-Netz ist eine Box eingerichtet. Nur wenn ein Lauf
		// dieser Werkstatt ihr ein Passwort gesetzt und sie nicht übergeben
		// hat, prüft ein Lauf (ohne Anmeldung), ob sie zurückgesetzt werden darf.
		if e.Adresse != d.Mango.LanNetz.Addr() || d.Ablage == nil {
			d.amAnschluss(faelle.Eingerichtet, "Unter "+e.Adresse.String()+" steckt eine eingerichtete Box. Der Dienst fasst sie nicht an: abziehen.")
			return kandidat{}, "", false
		}
		sp, ok, err := d.Ablage.SpurDerMAC(e.MAC, "")
		if err != nil || !ok || sp.Fertig() {
			d.amAnschluss(faelle.Eingerichtet, "Unter "+e.Adresse.String()+" steckt eine eingerichtete Box. Der Dienst fasst sie nicht an: abziehen.")
			return kandidat{}, "", false
		}
		einstieg = mango.HalbImLan
	}
	f := d.ansicht.Freigabe
	if !f.Laufend || f.Freigabe == nil {
		d.amAnschluss(faelle.NichtFreigegeben, "Mango erkannt, aber die Werkstatt ist nicht freigegeben: "+f.Grund)
		return kandidat{}, "", false
	}
	k := kandidat{mac: e.MAC, adresse: e.Adresse, seit: jetzt}
	if vorher != nil && vorher.mac == k.mac && vorher.adresse == k.adresse {
		k.seit = vorher.seit
		d.kandidat = &k
		return k, einstieg, true
	}
	d.kandidat = &k
	d.amAnschluss(faelle.Startet, "Mango erkannt unter "+e.Adresse.String()+"; der Dienst wartet, bis sie fertig gestartet ist. Nicht abziehen.")
	return kandidat{}, "", false
}

// amAnschluss setzt Satz und Fall am Anschluss. Meldet die Brücke
// Unterspannung, während der Dienst auf eine Box wartet, ist das der Fall:
// Eine Mango am USB des Pi kann sie dann nicht hochbringen.
func (d *Dienst) amAnschluss(fall, text string) {
	if d.unterspannung && (fall == faelle.KeineBox || fall == faelle.Startet || fall == faelle.BrueckeNichtBereit) {
		fall = faelle.BrueckeUnterspannung
		text += " Die Brücke meldet Unterspannung: die Mango an ein eigenes USB-Netzteil."
	}
	d.ansicht.Anschluss, d.ansicht.AnschlussFall, d.ansicht.AnschlussLoesung = text, fall, faelle.Zu(fall)
}

// beginneLauf beginnt den Lauf einer Box (unter der Sperre).
func (d *Dienst) beginneLauf(jetzt time.Time, k kandidat, einstieg mango.Einstieg) {
	d.kandidat = nil
	f := d.ansicht.Freigabe
	l := lauf.Neu(jetzt, f.Freigabe.Kennung, freigabe.Mango)
	ml, err := mango.NeuerLauf(*d.Mango, *f.Freigabe, l.Kennung())
	if err != nil {
		d.amAnschluss(faelle.SchrittGescheitert, "Lauf nicht begonnen: "+geheim.Schwaerze(err.Error()))
		d.Log.Error("Lauf nicht begonnen", "fehler", err)
		return
	}
	fr := f.Freigabe
	angaben := map[string]string{
		"einstieg":   string(einstieg),
		"mac":        k.mac,
		"adresse":    k.adresse.String(),
		"openwrt":    fr.OpenWrt.Fassung + " " + fr.OpenWrt.Datei + " sha256 " + fr.OpenWrt.Sha256,
		"edge_light": fr.EdgeLight.Fassung + ", Programm sha256 " + fr.EdgeLight.ProgrammSha256 + ", Skripte sha256 " + fr.EdgeLight.SkripteSha256,
		"lan_netz":   d.Mango.LanNetz.String(),
		"bauart":     d.Mango.Bauart,
	}
	d.aktiv = &aktiverLauf{l: l, m: ml}
	d.gesperrt[k.mac] = true
	d.amAnschluss("", "Ein Lauf arbeitet an der Box. Nicht abziehen.")
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
