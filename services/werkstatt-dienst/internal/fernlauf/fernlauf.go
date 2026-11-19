// Package fernlauf spielt einer Edge-Light-Box ohne Kundenkonto die neueste
// Fassung durch den Wartungstunnel auf (Konzept vp-update-vor-zuordnung, S1,
// entschieden 18.11.2026: E1 = A, E2 = A): auf Auftrag aus dem Portal, als
// Techniker-Zugang „Werkstatt-Dienst“ im Fenster, das die API für diesen
// Auftrag geöffnet hat.
//
// Der Ablauf ist fest (docs/contracts/werkstatt-fernlauf-v1.md): anmelden,
// Stand lesen, Fassung laden und ihre Signatur gegen die eingebackene Wurzel
// prüfen, sichern, install.sh wie in der Werkstatt (Schritt programm) samt
// Land DE und relayd (Schritt einrichtung_wlan), Neustart, Prüfungen. Die
// Box probt hier nicht: install.sh legt die Fassung als bestätigte ab; statt
// der Probe prüft der Dienst, was die Werkstatt prüft (Referenz, Fassung,
// Update-bereit), dazu „meldet sich mit der neuen Fassung“ und den Tunnel.
// Scheitert ab dem Aufspielen etwas, spielt er die Sicherung zurück.
//
// Was er nie tut: OpenWrt, Passwort, Notfall-Schlüssel, Tunnel, LAN oder die
// Identität der Box anfassen. Die Sicherung lässt die Identität aus, vom
// Funkmodul nimmt sie nur das Land (nie ein WLAN-Kennwort), und kein
// Schlüssel und kein Passwort steht in Log oder Beleg. Ein Fernlauf zur Zeit;
// die Werkbank läuft daneben.
package fernlauf

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// Schritte in ihrer Reihenfolge (Vektor docs/contracts/werkstatt-fernlauf.json).
var Schritte = []string{"anmelden", "bestand", "fassungen", "sichern", "aufspielen", "neustart", "meldet_sich", "tunnel", "zurueck", "fenster_zu"}

// Ergebnisse eines Fernlaufs (Vektor).
var Ergebnisse = []string{"fertig", "zurueck", "unveraendert", "offen"}

// SSHPort ist Dropbear im Tunnel.
const SSHPort = 2222

// Gesichert wird, was install.sh und der Schritt einrichtung_wlan ändern -
// nie die Identität (/etc/vp-edge-light/identity, ref), nie Tunnel, Dropbear,
// Netz oder Passwort. Vom Funkmodul nur das Land (eigene Angabe, siehe
// befehlBestandSichern), damit kein WLAN-Kennwort die Box verlässt.
var Gesichert = []string{
	"usr/libexec/vp-edge-light/boot.sh",
	"usr/libexec/vp-edge-light/wlan-anschluss.sh",
	"usr/libexec/vp-edge-light/einrichtung-wlan.sh",
	"etc/init.d/vp-edge-light",
	"etc/hotplug.d/iface/91-vp-einrichtung",
	"etc/config/vp-edge-light",
	"etc/config/firewall",
	"etc/config/system",
	"etc/crontabs/root",
	"etc/vp-edge-light/ota",
	"usr/share/vp-edge-light",
}

// Verzeichnisse unter Gesichert: Was nach dem Aufspielen darin liegt und nicht
// in der Sicherung stand, entfernt die Rücknahme.
var gesicherteVerzeichnisse = []string{"etc/vp-edge-light/ota", "usr/share/vp-edge-light"}

// nie: kein Eintrag der Sicherung darf hier beginnen.
var nie = []string{"etc/vp-edge-light/identity", "etc/vp-edge-light/ref", "etc/dropbear", "etc/wireguard", "etc/shadow", "etc/config/wireless", "etc/config/network", "etc/config/dropbear"}

// Portal ist, was ein Fernlauf vom Dienst-Baum der API braucht (portal.Client).
type Portal interface {
	FernlaufBeginnen(ctx context.Context, id string) (portal.FernlaufAuftrag, error)
	FernlaufSchritt(ctx context.Context, id, schritt, zustand, zeile string) error
	FernlaufMeldungLesen(ctx context.Context, id string) (portal.FernlaufMeldung, error)
	FernlaufErgebnisMelden(ctx context.Context, id string, e portal.FernlaufErgebnis) error
	FernlaufFensterSchliessen(ctx context.Context, id string) (schonZu bool, err error)
}

// Zeiten des Fernlaufs; in Tests kürzer.
type Zeiten struct {
	Takt       time.Duration // Abstand beim Warten
	Versuch    time.Duration // je Anmeldeversuch
	Anmelden   time.Duration // bis die Box den Schlüssel des Fensters abgeholt hat (§4.2: wie die Probe)
	Programm   time.Duration // bis /health nach dem Neustart die Fassung nennt
	MeldetSich time.Duration // bis die Plattform die neue Fassung hört (§4.2: 3 min)
	Reserve    time.Duration // so viel Fenster muss vor dem Sichern noch übrig sein
}

// VorgabeZeiten für die echte Box.
var VorgabeZeiten = Zeiten{Takt: 3 * time.Second, Versuch: 20 * time.Second, Anmelden: 3 * time.Minute, Programm: 2 * time.Minute, MeldetSich: 3 * time.Minute, Reserve: 12 * time.Minute}

// Konfig gilt für alle Fernläufe des Dienstes.
type Konfig struct {
	// Zugang und SSH sind der Techniker-Zugang „Werkstatt-Dienst“ (wie die Probe).
	Zugang wartung.Zugang
	SSH    ssh.Signer
	// Oeffne baut den Tunnel; nil = wartung.Oeffne (Tests setzen eine Attrappe).
	Oeffne    func(wartung.Zugang, wartung.Server) (wartung.Weg, error)
	Fassungen *fassungen.Ablage
	PortalURL string // Vertrauens-Set (/api/v1/edge/trust-set/…)
	Bauart    string
	Arbeit    string
	Portal    Portal
	Ablage    *protokoll.Ablage
	Zeiten    Zeiten
	Log       *slog.Logger
}

// Ansicht ist, was die Ansicht des Dienstes zum Fernlauf meldet
// (werkstatt-ansicht-v1, additiv): ob er Fernläufe kann, und der laufende.
type Ansicht struct {
	Bereit  bool     `json:"bereit"`
	Grund   string   `json:"grund,omitempty"`
	Aktiv   *Aktiv   `json:"aktiv,omitempty"`
	Wartend int      `json:"wartend"`
	Letzter *Letzter `json:"letzter,omitempty"`
}

// Aktiv ist der laufende Fernlauf.
type Aktiv struct {
	Auftrag string    `json:"auftrag"`
	Box     string    `json:"box"`
	Schritt string    `json:"schritt"`
	Seit    time.Time `json:"seit"`
}

// Letzter ist das Ergebnis des letzten Fernlaufs dieses Prozesses.
type Letzter struct {
	Auftrag  string    `json:"auftrag"`
	Box      string    `json:"box"`
	Ergebnis string    `json:"ergebnis"`
	Ende     time.Time `json:"ende"`
}

// Dienst nimmt Aufträge an und fährt sie nacheinander.
type Dienst struct {
	k     Konfig
	grund string

	mu      sync.Mutex
	gesehen map[string]bool // Aufträge, die schon in der Schlange stehen oder liefen
	warten  []string
	aktiv   *Aktiv
	letzter *Letzter
	arbeit  bool
}

// Neu legt den Fernlauf-Teil des Dienstes an. Ohne Techniker-Zugang oder ohne
// API kann er nichts; die Ansicht nennt dann den Grund.
func Neu(k Konfig) *Dienst {
	if k.Zeiten == (Zeiten{}) {
		k.Zeiten = VorgabeZeiten
	}
	if k.Log == nil {
		k.Log = slog.Default()
	}
	d := &Dienst{k: k, gesehen: map[string]bool{}}
	switch {
	case k.Portal == nil:
		d.grund = "ohne Portal-API (VP_WERKSTATT_API_URL)"
	case k.SSH == nil || !k.Zugang.Adresse.IsValid():
		d.grund = "kein Techniker-Zugang (VP_WERKSTATT_TECHNIKER_ADRESSE, techniker-wireguard, techniker-ssh)"
	case k.PortalURL == "":
		d.grund = "kein Portal für das Vertrauens-Set (VP_WERKSTATT_PORTAL_URL)"
	case k.Fassungen == nil || k.Ablage == nil:
		d.grund = "ohne Ablage für Fassungen und Protokolle"
	}
	return d
}

// Ansicht gibt den Stand für die Ansicht des Dienstes.
func (d *Dienst) Ansicht() Ansicht {
	d.mu.Lock()
	defer d.mu.Unlock()
	a := Ansicht{Bereit: d.grund == "", Grund: d.grund, Wartend: len(d.warten)}
	if d.aktiv != nil {
		c := *d.aktiv
		a.Aktiv = &c
	}
	if d.letzter != nil {
		c := *d.letzter
		a.Letzter = &c
	}
	return a
}

// Annehmen reiht einen Auftrag des Portals ein (sofort zurück; gefahren wird
// er nacheinander mit den übrigen). Einen schon gesehenen Auftrag reiht es
// nicht noch einmal ein: Das Portal nennt ihn in jeder Antwort, bis er
// angenommen ist.
func (d *Dienst) Annehmen(ctx context.Context, id string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.grund != "" {
		if !d.gesehen[id] {
			d.k.Log.Warn("Fernlauf nicht angenommen", "auftrag", id, "grund", d.grund)
			d.gesehen[id] = true
		}
		return
	}
	if d.gesehen[id] {
		return
	}
	d.gesehen[id] = true
	d.warten = append(d.warten, id)
	if !d.arbeit {
		d.arbeit = true
		go d.arbeite(ctx)
	}
}

func (d *Dienst) arbeite(ctx context.Context) {
	for {
		d.mu.Lock()
		if len(d.warten) == 0 || ctx.Err() != nil {
			d.arbeit = false
			d.mu.Unlock()
			return
		}
		id := d.warten[0]
		d.warten = d.warten[1:]
		d.mu.Unlock()
		d.Fahre(ctx, id)
	}
}

// SchliesseOffene beendet Fernläufe, die ein früherer Prozess nicht zu Ende
// brachte: im Protokoll, und im Portal als „offen“ mit geschlossenem Fenster.
// Was die Box jetzt fährt, zeigt ihr nächster Programmstart.
func (d *Dienst) SchliesseOffene(ctx context.Context) {
	if d.k.Ablage == nil {
		return
	}
	offen, err := d.k.Ablage.Offene()
	if err != nil {
		d.k.Log.Error("offene Fernläufe nicht lesbar", "fehler", err)
		return
	}
	for _, k := range offen {
		grund := "Der Werkstatt-Dienst wurde während des Fernlaufs neu gestartet; was die Box jetzt fährt, zeigt ihr nächster Programmstart."
		auftrag := ""
		if es, err := d.k.Ablage.Lies(k); err == nil && len(es) > 0 {
			auftrag = es[0].Angaben["auftrag"]
		}
		_ = d.k.Ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBeendet, Zustand: "offen", Grund: grund})
		if auftrag == "" || d.k.Portal == nil {
			continue
		}
		pctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		_, _ = d.k.Portal.FernlaufFensterSchliessen(pctx, auftrag)
		err := d.k.Portal.FernlaufErgebnisMelden(pctx, auftrag, portal.FernlaufErgebnis{Ergebnis: "offen", Grund: grund, Belege: map[string]string{}})
		cancel()
		d.k.Log.Warn("Fernlauf durch Neustart des Dienstes unterbrochen", "request_id", k, "auftrag", auftrag, "gemeldet", err == nil)
	}
}

// ---- ein Fernlauf ------------------------------------------------------------

// Fahre führt einen Auftrag aus, vom Annehmen bis zum Ergebnis.
func (d *Dienst) Fahre(ctx context.Context, id string) {
	log := d.k.Log.With("auftrag", id)
	a, err := d.k.Portal.FernlaufBeginnen(ctx, id)
	if err != nil {
		log.Warn("Fernlauf nicht angenommen", "fehler", geheim.Schwaerze(err.Error()))
		return
	}
	jetzt := time.Now().UTC()
	kurzID := strings.ReplaceAll(id, "-", "")
	if len(kurzID) > 8 {
		kurzID = kurzID[:8]
	}
	kennung := jetzt.Format("2006-01-02-150405") + "-fl-" + strings.ToLower(kurzID)
	l := &laufZustand{k: d.k, a: a, id: id, kennung: kennung, log: log.With("request_id", kennung, "box", a.EdgeRef), belege: map[string]string{}}
	defer l.schliesse()
	d.setze(&Aktiv{Auftrag: id, Box: a.EdgeRef, Schritt: "anmelden", Seit: jetzt})
	l.melde = func(s string) { d.setze(&Aktiv{Auftrag: id, Box: a.EdgeRef, Schritt: s, Seit: time.Now().UTC()}) }

	ergebnis := l.fahre(ctx)

	d.mu.Lock()
	d.aktiv = nil
	d.letzter = &Letzter{Auftrag: id, Box: a.EdgeRef, Ergebnis: ergebnis, Ende: time.Now().UTC()}
	d.mu.Unlock()
}

func (d *Dienst) setze(a *Aktiv) {
	d.mu.Lock()
	d.aktiv = a
	d.mu.Unlock()
}

type schritt struct {
	kennung string
	frist   time.Duration
	tun     func(ctx context.Context) (protokoll.Beleg, string, error)
}

// laufZustand ist ein Fernlauf; nichts davon ist geheim außer dem, was die
// Box nie verlässt.
type laufZustand struct {
	k       Konfig
	a       portal.FernlaufAuftrag
	id      string
	kennung string
	log     *slog.Logger
	melde   func(schritt string)

	dir  string
	weg  wartung.Weg
	v    *box.Verbindung
	ziel netip.AddrPort
	dr   *durchreiche.Server

	vorher       string // Fassung laut /health vor dem Lauf
	seq          *int64 // Stand laut current.json vor dem Lauf
	csrZuletzt   time.Time
	pfadProgramm string
	pfadSkripte  string
	pfadManifest string
	dirVertrauen string
	stand        fassungen.Stand

	sicherung    string          // Datei mit der Sicherung (tar.gz)
	inSicherung  map[string]bool // Einträge der Sicherung (ohne „/“ am Ende)
	fehlten      []string        // Pfade aus Gesichert, die es vorher nicht gab
	otaLink      bool            // /etc/vp-edge-light/ota war ein Verweis (Stufe 1)
	rcVorher     []string        // /etc/rc.d/*vp-edge-light vorher
	landVorher   string          // wireless.radio0.country vorher ("" = keins, "-" = kein Funkmodul)
	tunnelVorher map[string]bool // was am Tunnel vor dem Lauf fehlte
	aufgespielt  bool
	nachher      string
	belege       map[string]string
}

func (l *laufZustand) schritte() []schritt {
	z := l.k.Zeiten
	return []schritt{
		{"anmelden", z.Anmelden + time.Minute, l.anmelden},
		{"bestand", 2 * time.Minute, l.bestand},
		{"fassungen", 10 * time.Minute, l.fassungen},
		{"sichern", 8 * time.Minute, l.sichern},
		{"aufspielen", 10 * time.Minute, l.aufspielen},
		{"neustart", z.Programm + time.Minute, l.neustart},
		{"meldet_sich", z.MeldetSich + time.Minute, l.meldetSich},
		{"tunnel", 3 * time.Minute, l.tunnel},
	}
}

// fahre gibt das Ergebnis zurück (fertig, zurueck, unveraendert, offen).
func (l *laufZustand) fahre(ctx context.Context) string {
	// Ohne Fenster kommt der Dienst nicht an die Box: alles endet vor seinem Ende.
	lctx, cancel := context.WithDeadline(ctx, l.a.FensterEnde.Add(-30*time.Second))
	defer cancel()
	_ = l.k.Ablage.Schreibe(protokoll.Eintrag{Lauf: l.kennung, Art: protokoll.LaufBegonnen, Angaben: map[string]string{
		"auftrag": l.id, "box": l.a.EdgeRef, "vorher": l.a.FassungVorher, "ziel": l.a.Ziel.Fassung,
		"akteur": l.a.AkteurName, "fenster": l.a.FensterID, "fenster_ende": l.a.FensterEnde.UTC().Format(time.RFC3339)}})
	l.log.Info("Fernlauf begonnen", "vorher", l.a.FassungVorher, "ziel", l.a.Ziel.Fassung)

	ergebnis, grund, letzter := "fertig", "", ""
	for _, s := range l.schritte() {
		letzter = s.kennung
		if err := l.schritt(lctx, s); err != nil {
			grund = err.Error()
			ergebnis = "unveraendert"
			if l.aufgespielt {
				// Die Rücknahme läuft auch, wenn der Lauf an seiner Frist endete:
				// begrenzt nur durch das Fenster.
				rctx, rcancel := context.WithDeadline(context.WithoutCancel(ctx), l.a.FensterEnde.Add(-10*time.Second))
				if rerr := l.schritt(rctx, schritt{"zurueck", 10 * time.Minute, l.zurueck}); rerr != nil {
					ergebnis, grund = "offen", grund+"; Rücknahme gescheitert: "+rerr.Error()
				} else {
					ergebnis = "zurueck"
				}
				rcancel()
			}
			break
		}
	}
	if ergebnis == "fertig" {
		l.nachher = l.a.Ziel.Fassung
	} else if ergebnis == "zurueck" || ergebnis == "unveraendert" {
		l.nachher = l.vorher
	}

	fctx, fcancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	_ = l.schritt(fctx, schritt{"fenster_zu", 30 * time.Second, l.fensterZu})
	err := l.k.Portal.FernlaufErgebnisMelden(fctx, l.id, portal.FernlaufErgebnis{Ergebnis: ergebnis, Grund: grund, Schritt: letzter,
		FassungVorher: l.vorher, FassungNachher: l.nachher, Belege: l.belege})
	fcancel()
	if err != nil {
		l.log.Error("Ergebnis des Fernlaufs nicht gemeldet", "fehler", geheim.Schwaerze(err.Error()))
	}
	_ = l.k.Ablage.Schreibe(protokoll.Eintrag{Lauf: l.kennung, Art: protokoll.LaufBeendet, Schritt: letzter, Zustand: ergebnis, Grund: grund})
	if ergebnis == "fertig" {
		l.log.Info("Fernlauf fertig", "nachher", l.nachher)
	} else {
		l.log.Warn("Fernlauf beendet", "ergebnis", ergebnis, "schritt", letzter, "grund", geheim.Schwaerze(grund))
	}
	return ergebnis
}

// schritt führt einen Schritt aus, schreibt ihn ins Protokoll und meldet ihn
// dem Portal. Eine Meldung, die nicht ankommt, hält nichts an.
func (l *laufZustand) schritt(ctx context.Context, s schritt) error {
	if l.melde != nil {
		l.melde(s.kennung)
	}
	beginn := time.Now()
	_ = l.k.Ablage.Schreibe(protokoll.Eintrag{Zeit: beginn.UTC(), Lauf: l.kennung, Art: protokoll.SchrittBegonnen, Schritt: s.kennung})
	l.portalSchritt(ctx, s.kennung, "laeuft", "")
	sctx, cancel := context.WithTimeout(ctx, s.frist)
	b, zeile, err := tue(sctx, s)
	cancel()
	dauer := time.Since(beginn).Seconds()
	if err != nil {
		if ctx.Err() != nil && !errors.Is(err, context.DeadlineExceeded) {
			err = fmt.Errorf("%w (Fenster endet)", err)
		}
		grund := geheim.Schwaerze(err.Error())
		_ = l.k.Ablage.Schreibe(protokoll.Eintrag{Lauf: l.kennung, Art: protokoll.SchrittGescheitert, Schritt: s.kennung, Grund: grund, Beleg: b, DauerSek: dauer})
		l.portalSchritt(ctx, s.kennung, "gescheitert", kurz(grund, 900))
		l.log.Warn("Fernlauf: Schritt gescheitert", "schritt", s.kennung, "grund", grund)
		return errors.New(grund)
	}
	_ = l.k.Ablage.Schreibe(protokoll.Eintrag{Lauf: l.kennung, Art: protokoll.SchrittBelegt, Schritt: s.kennung, Beleg: b, DauerSek: dauer})
	zeile = geheim.Schwaerze(zeile)
	l.belege[s.kennung] = zeile
	l.portalSchritt(ctx, s.kennung, "belegt", kurz(zeile, 900))
	l.log.Info("Fernlauf: Schritt belegt", "schritt", s.kennung, "dauer_s", fmt.Sprintf("%.1f", dauer))
	return nil
}

func (l *laufZustand) portalSchritt(ctx context.Context, schritt, zustand, zeile string) {
	pctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := l.k.Portal.FernlaufSchritt(pctx, l.id, schritt, zustand, zeile); err != nil {
		l.log.Warn("Fernlauf: Schritt nicht ans Portal gemeldet", "schritt", schritt, "fehler", geheim.Schwaerze(err.Error()))
	}
}

// tue ruft den Schritt auf; eine Panik beendet den Schritt statt den Dienst.
func tue(ctx context.Context, s schritt) (b protokoll.Beleg, zeile string, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("Fehler im Dienst (%v)", p)
		}
	}()
	return s.tun(ctx)
}

func (l *laufZustand) schliesse() {
	if l.dr != nil {
		l.dr.Schliesse()
	}
	l.v.Schliesse()
	if l.weg != nil {
		l.weg.Schliesse()
	}
	if l.dir != "" {
		_ = os.RemoveAll(l.dir)
	}
}

func (l *laufZustand) arbeitsDir() (string, error) {
	if l.dir == "" {
		// Kurz: die Unix-Socket der Durchreiche liegt darin (Grenze ~100 Zeichen).
		l.dir = filepath.Join(l.k.Arbeit, "fl-"+l.kennung[len(l.kennung)-8:])
		if err := os.MkdirAll(l.dir, 0o700); err != nil {
			return "", err
		}
	}
	return l.dir, nil
}

// ---- anmelden ----------------------------------------------------------------

func (l *laufZustand) anmelden(ctx context.Context) (protokoll.Beleg, string, error) {
	if l.a.HostSchluessel == "" {
		return nil, "", errors.New("kein Host-Schlüssel der Box aus der Werkstatt bekannt")
	}
	adresse, err := tunnelAdresse(l.a.TunnelAdresse)
	if err != nil {
		return nil, "", err
	}
	netz, err := netip.ParsePrefix(l.a.Server.BoxNetz)
	if err != nil {
		return nil, "", fmt.Errorf("Box-Netz %q: %v", l.a.Server.BoxNetz, err)
	}
	l.ziel = netip.AddrPortFrom(adresse, SSHPort)
	b := protokoll.Beleg{}.Mit("ziel", l.ziel.String()).Mit("techniker_schluessel", ssh.FingerprintSHA256(l.k.SSH.PublicKey())).
		Mit("host_schluessel_werkstatt", l.a.HostSchluessel)
	if err := l.verbinde(ctx, wartung.Server{PublicKey: l.a.Server.PublicKey, Endpunkt: l.a.Server.Endpunkt, BoxNetz: netz}, &b); err != nil {
		return b, "", err
	}
	return b, "Angemeldet als Techniker-Zugang " + ssh.FingerprintSHA256(l.k.SSH.PublicKey()) + "; Host-Schlüssel wie in der Werkstatt (" + l.a.HostSchluessel + ")", nil
}

// verbinde baut den Tunnel (falls nötig) und meldet sich an, mit Versuchen im
// Takt, bis die Box den Schlüssel des Fensters abgeholt hat. Ein anderer
// Host-Schlüssel beendet sofort: Das ist dann nicht die Box der Werkstatt.
func (l *laufZustand) verbinde(ctx context.Context, s wartung.Server, b *protokoll.Beleg) error {
	if l.weg == nil {
		oeffne := l.k.Oeffne
		if oeffne == nil {
			oeffne = func(z wartung.Zugang, s wartung.Server) (wartung.Weg, error) { return wartung.Oeffne(z, s) }
		}
		w, err := oeffne(l.k.Zugang, s)
		if err != nil {
			return fmt.Errorf("Wartungstunnel: %w", err)
		}
		l.weg = w
	}
	beginn := time.Now()
	ende := beginn.Add(l.k.Zeiten.Anmelden)
	var letzter error
	for n := 1; ; n++ {
		v, err := box.VerbindeMitSchluessel(ctx, l.weg, l.ziel, l.k.SSH, box.GenauDieser(l.a.HostSchluessel), l.k.Zeiten.Versuch)
		if err == nil {
			l.v = v
			if b != nil {
				*b = b.Mit("anmeldung", fmt.Sprintf("gelungen nach %d Versuchen in %s", n, time.Since(beginn).Round(time.Second))).
					Mit("host_schluessel", v.HostArt()+" "+v.HostFingerabdruck())
			}
			return nil
		}
		if strings.Contains(err.Error(), "Host-Schlüssel der Box ist") {
			return err
		}
		letzter = err
		if time.Now().After(ende) {
			return fmt.Errorf("Anmeldung durch den Tunnel an %s nach %d Versuchen nicht gelungen: %v", l.ziel, n, letzter)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Anmeldung durch den Tunnel an %s nach %d Versuchen nicht gelungen: %v", l.ziel, n, letzter)
		case <-time.After(l.k.Zeiten.Takt):
		}
	}
}

func tunnelAdresse(s string) (netip.Addr, error) {
	s = strings.TrimSpace(s)
	if p, err := netip.ParsePrefix(s); err == nil {
		return p.Addr(), nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil || !a.Is4() {
		return netip.Addr{}, fmt.Errorf("Tunnel-Adresse %q", s)
	}
	return a, nil
}

// ---- bestand -----------------------------------------------------------------

const befehlBestand = `echo "ref=$(cat /etc/vp-edge-light/ref 2>/dev/null)"
echo "zertifikat=$([ -s /etc/vp-edge-light/identity/device.crt ] && echo ja || echo nein)"
echo "current=$(tr -d '\n' < /etc/vp-edge-light/ota/current.json 2>/dev/null)"
echo "flash_frei_kb=$(df -k /usr/share/vp-edge-light 2>/dev/null | awk 'NR==2 {print $4}')"
echo "ram_frei_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null)"
echo "board=$(cat /tmp/sysinfo/board_name 2>/dev/null)"`

// ErrInzwischenVerbunden: Auf der Box liegt ein Zertifikat; ihre Updates
// kommen über das erste Verbinden, der Fernlauf ändert nichts.
var ErrInzwischenVerbunden = errors.New("Inzwischen verbunden: Auf der Box liegt ein Zertifikat, das Update läuft über das erste Verbinden.")

func (l *laufZustand) bestand(ctx context.Context) (protokoll.Beleg, string, error) {
	w, _, err := l.v.Werte(ctx, befehlBestand)
	if err != nil {
		return nil, "", err
	}
	b := protokoll.Beleg{}.Mit("referenz", w["ref"]).Mit("zertifikat", w["zertifikat"]).Mit("current", w["current"]).
		Mit("flash_frei_kb", w["flash_frei_kb"]).Mit("ram_frei_kb", w["ram_frei_kb"]).Mit("board", w["board"])
	if w["ref"] != l.a.EdgeRef {
		return b, "", fmt.Errorf("die Box nennt die Referenz %q, der Auftrag %s", w["ref"], l.a.EdgeRef)
	}
	if w["zertifikat"] == "ja" {
		return b, "", ErrInzwischenVerbunden
	}
	erg, err := l.v.Fuehre(ctx, mango.BefehlHealth, nil)
	if err != nil {
		return b, "", err
	}
	h, ok := mango.LiesHealth(erg.Aus)
	if !ok || h.Version == "" {
		return b, "", errors.New("/health der Box nennt keine Fassung (läuft das Programm?)")
	}
	l.vorher = h.Version
	b = b.Mit("health", "ref "+h.Ref+", version "+h.Version)
	var cur struct {
		Release    string `json:"release"`
		ReleaseSeq *int64 `json:"release_seq"`
	}
	if w["current"] != "" && json.Unmarshal([]byte(w["current"]), &cur) == nil && cur.ReleaseSeq != nil {
		l.seq = cur.ReleaseSeq
	}
	if h.Version == l.a.Ziel.Fassung {
		return b, "", fmt.Errorf("die Box läuft schon %s", h.Version)
	}
	if l.seq != nil && *l.seq >= l.a.Ziel.ReleaseSeq {
		return b, "", fmt.Errorf("die Box hat Stand %d, die Fassung %s nur %d: nur aufwärts", *l.seq, l.a.Ziel.Fassung, l.a.Ziel.ReleaseSeq)
	}
	if m, err := l.k.Portal.FernlaufMeldungLesen(ctx, l.id); err == nil {
		l.csrZuletzt = m.CsrUpdatedAt
	}
	stand := "unbekannt (keine current.json)"
	if l.seq != nil {
		stand = strconv.FormatInt(*l.seq, 10)
	}
	return b, fmt.Sprintf("Läuft %s, Stand %s, kein Zertifikat, Flash frei %s kB", h.Version, stand, w["flash_frei_kb"]), nil
}

// ---- fassungen ---------------------------------------------------------------

func (l *laufZustand) fassungen(ctx context.Context) (protokoll.Beleg, string, error) {
	z := l.a.Ziel
	f := freigabe.Freigabe{EdgeLight: freigabe.Programm{Fassung: z.Fassung, Quelle: z.Quelle, ProgrammSha256: z.ProgrammSha256, SkripteSha256: z.SkripteSha256}}
	_, programm, skripte := fassungen.Dateien(f, l.k.Bauart)
	b := protokoll.Beleg{}.Mit("fassung", z.Fassung)
	for _, d := range []fassungen.Datei{programm, skripte} {
		erg, err := l.k.Fassungen.Hole(ctx, d)
		if err != nil {
			return b, "", err
		}
		b = b.Mit(d.Name, fmt.Sprintf("sha256 %s, %d Bytes", d.Sha256, erg.Groesse))
		if d.Name == programm.Name {
			l.pfadProgramm = erg.Pfad
		} else {
			l.pfadSkripte = erg.Pfad
		}
	}
	m, msig, err := l.k.Fassungen.HoleManifest(ctx, z.Quelle, z.Fassung)
	if err != nil {
		return b, "", fmt.Errorf("signiertes Manifest der Fassung: %w", err)
	}
	set, setSig, err := l.k.Fassungen.HoleVertrauensSet(ctx, l.k.PortalURL)
	if err != nil {
		return b, "", fmt.Errorf("Vertrauens-Set: %w", err)
	}
	// Dieselbe Prüfung wie im Werkstatt-Schritt fassungen (N3) und auf der Box
	// bei einem Update: eingebackene Wurzel, root-signiertes Vertrauens-Set,
	// Release-Schlüssel, Manifest - auf den rohen Bytes, vor jedem Parsen.
	signiertVon, err := l.k.Fassungen.PruefeSignatur(set, setSig, m, msig)
	b = b.Mit("signatur", orKein(signiertVon))
	if err != nil {
		return b, "", fmt.Errorf("Fassung nicht echt: %w", err)
	}
	// Erst jetzt gelesen: Stand, Boden und Skriptstand des signierten Manifests.
	var vm struct {
		Release    string `json:"release"`
		ReleaseSeq int64  `json:"release_seq"`
		MinFromSeq int64  `json:"min_from_seq"`
		Skripte    *struct {
			SHA256 string `json:"sha256"`
		} `json:"skripte"`
	}
	if err := json.Unmarshal(m, &vm); err != nil {
		return b, "", fmt.Errorf("release.json: %v", err)
	}
	switch {
	case vm.Release != z.Fassung || vm.ReleaseSeq != z.ReleaseSeq:
		return b, "", fmt.Errorf("das signierte Manifest nennt %s Stand %d, der Auftrag %s Stand %d", vm.Release, vm.ReleaseSeq, z.Fassung, z.ReleaseSeq)
	case vm.Skripte == nil || vm.Skripte.SHA256 != z.SkripteSha256:
		return b, "", errors.New("das signierte Manifest trägt nicht den Skriptstand des Auftrags")
	case l.seq != nil && *l.seq >= vm.ReleaseSeq:
		return b, "", fmt.Errorf("die Box hat Stand %d, die Fassung %d: nur aufwärts", *l.seq, vm.ReleaseSeq)
	case l.seq != nil && *l.seq < vm.MinFromSeq:
		return b, "", fmt.Errorf("die Fassung setzt mindestens Stand %d voraus, die Box hat %d", vm.MinFromSeq, *l.seq)
	}
	st, err := fassungen.PruefeManifest(m, msig, z.Fassung, l.k.Bauart, z.ProgrammSha256)
	if err != nil {
		return b, "", err
	}
	l.stand = st
	dir, err := l.arbeitsDir()
	if err != nil {
		return b, "", err
	}
	l.pfadManifest = filepath.Join(dir, fassungen.ManifestDatei)
	l.dirVertrauen = filepath.Join(dir, "trust-set")
	if err := os.MkdirAll(l.dirVertrauen, 0o755); err != nil {
		return b, "", err
	}
	// install.sh bekommt genau die Bytes, die eben geprüft wurden.
	for p, inhalt := range map[string][]byte{l.pfadManifest: m, filepath.Join(l.dirVertrauen, "trust-set.json"): set, filepath.Join(l.dirVertrauen, "trust-set.json.sig"): setSig} {
		if err := os.WriteFile(p, inhalt, 0o644); err != nil {
			return b, "", err
		}
	}
	return b, fmt.Sprintf("%s Stand %d, signiert von %s, Kette gegen die eingebackene Wurzel geprüft; Programm und Skriptstand nach sha256", z.Fassung, vm.ReleaseSeq, signiertVon), nil
}

// ---- sichern -----------------------------------------------------------------

func (l *laufZustand) sichern(ctx context.Context) (protokoll.Beleg, string, error) {
	if rest := time.Until(l.a.FensterEnde); rest < l.k.Zeiten.Reserve {
		return nil, "", fmt.Errorf("im Fenster bleiben nur %s, für Aufspielen und Rücknahme braucht es %s", rest.Round(time.Second), l.k.Zeiten.Reserve)
	}
	// Wie der Tunnel jetzt steht: Danach darf nichts fehlen, was jetzt da ist.
	status, err := l.tunnelStatus(ctx)
	if err != nil {
		return nil, "", err
	}
	l.tunnelVorher = map[string]bool{}
	for _, f := range mango.TunnelLuecken(status) {
		l.tunnelVorher[f] = true
	}
	var befehl strings.Builder
	for _, p := range Gesichert {
		fmt.Fprintf(&befehl, "if [ -e /%[1]s ] || [ -L /%[1]s ]; then echo da=%[1]s; else echo fehlt=%[1]s; fi\n", p)
	}
	befehl.WriteString("[ -L /etc/vp-edge-light/ota ] && echo ota=verweis\n")
	befehl.WriteString("for f in /etc/rc.d/*vp-edge-light; do [ -L \"$f\" ] && echo rc=${f#/}; done; true\n")
	befehl.WriteString("if uci -q get wireless.radio0 >/dev/null 2>&1; then echo land=$(uci -q get wireless.radio0.country); else echo land=-; fi\n")
	erg, err := l.v.Fuehre(ctx, befehl.String(), nil)
	if err != nil {
		return nil, "", err
	}
	var da []string
	l.fehlten, l.rcVorher, l.otaLink = nil, nil, false
	for _, z := range strings.Split(erg.Aus, "\n") {
		k, w, _ := strings.Cut(strings.TrimSpace(z), "=")
		switch k {
		case "da":
			da = append(da, w)
		case "fehlt":
			l.fehlten = append(l.fehlten, w)
		case "rc":
			l.rcVorher = append(l.rcVorher, w)
			da = append(da, w)
		case "ota":
			l.otaLink = true
		case "land":
			l.landVorher = w
		}
	}
	if len(da) == 0 {
		return nil, "", errors.New("auf der Box liegt nichts von Edge Light")
	}
	r, err := l.v.Fuehre(ctx, "tar -czf - -C / "+strings.Join(da, " "), nil)
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung: %w", err)
	}
	if r.Code != 0 {
		return nil, "", fmt.Errorf("Sicherung: tar endete mit %d: %s", r.Code, kurz(strings.TrimSpace(r.Fehl), 200))
	}
	daten := []byte(r.Aus)
	eintraege, err := tarEintraege(daten)
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung unlesbar: %w", err)
	}
	for e := range eintraege {
		for _, n := range nie {
			if e == n || strings.HasPrefix(e, n+"/") {
				return nil, "", fmt.Errorf("die Sicherung enthielte %s: abgebrochen", e)
			}
		}
	}
	for _, p := range da {
		if !eintraege[p] {
			return nil, "", fmt.Errorf("die Sicherung enthält %s nicht", p)
		}
	}
	dir, err := l.arbeitsDir()
	if err != nil {
		return nil, "", err
	}
	l.sicherung = filepath.Join(dir, "sicherung.tar.gz")
	if err := os.WriteFile(l.sicherung, daten, 0o600); err != nil {
		return nil, "", err
	}
	l.inSicherung = eintraege
	sum := sha256.Sum256(daten)
	summe := hex.EncodeToString(sum[:])
	land := l.landVorher
	if land == "" {
		land = "keins"
	} else if land == "-" {
		land = "kein Funkmodul"
	}
	b := protokoll.Beleg{}.Mit("sicherung", fmt.Sprintf("sha256 %s, %d Bytes, %d Einträge", summe, len(daten), len(eintraege))).
		Mit("pfade", strings.Join(da, " ")).Mit("fehlten", strings.Join(l.fehlten, " ")).Mit("land_vorher", land).
		Mit("tunnel_vorher", strings.Join(sortiert(l.tunnelVorher), ", "))
	l.belege["sicherung_sha256"] = summe
	return b, fmt.Sprintf("Gesichert: %d Pfade, %d Bytes, sha256 %s (ohne Identität)", len(da), len(daten), kurz(summe, 16)), nil
}

func sortiert(m map[string]bool) []string {
	var s []string
	for k := range m {
		s = append(s, k)
	}
	sort.Strings(s)
	return s
}

// tarEintraege liest die Namen einer tar.gz-Sicherung (ohne „./“ und „/“ am Ende).
func tarEintraege(daten []byte) (map[string]bool, error) {
	gz, err := gzip.NewReader(bytes.NewReader(daten))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	out := map[string]bool{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		n := strings.TrimSuffix(strings.TrimPrefix(h.Name, "./"), "/")
		if n != "" {
			out[n] = true
		}
	}
}

// ---- aufspielen --------------------------------------------------------------

func (l *laufZustand) skripte() (*durchreiche.Server, string, error) {
	dir, err := l.arbeitsDir()
	if err != nil {
		return nil, "", err
	}
	basis := filepath.Join(dir, "edge-light")
	if l.dr == nil {
		if err := fassungen.Auspacken(l.pfadSkripte, basis); err != nil {
			return nil, "", err
		}
		if err := os.MkdirAll(filepath.Join(basis, "dist"), 0o755); err != nil {
			return nil, "", err
		}
		inhalt, err := os.ReadFile(l.pfadProgramm)
		if err != nil {
			return nil, "", err
		}
		if err := os.WriteFile(filepath.Join(basis, "dist", fassungen.ProgrammPraefix+l.k.Bauart), inhalt, 0o755); err != nil {
			return nil, "", err
		}
		dr, err := durchreiche.Starte(filepath.Join(dir, "d"), func() *ssh.Client {
			if l.v == nil {
				return nil
			}
			return l.v.Client()
		}, l.log)
		if err != nil {
			return nil, "", err
		}
		l.dr = dr
	}
	return l.dr, filepath.Join(basis, "openwrt"), nil
}

func (l *laufZustand) skript(ctx context.Context, name string, args []string, env ...string) (durchreiche.Lauf, error) {
	dr, dir, err := l.skripte()
	if err != nil {
		return durchreiche.Lauf{}, err
	}
	return dr.FuehreSkript(ctx, filepath.Join(dir, name), append([]string{"root@" + l.ziel.Addr().String()}, args...), env)
}

func (l *laufZustand) tunnelStatus(ctx context.Context) (string, error) {
	r, err := l.skript(ctx, "service-tunnel.sh", []string{"status"})
	if err != nil {
		return "", err
	}
	if r.Code != 0 {
		return "", fmt.Errorf("service-tunnel.sh status endete mit %d", r.Code)
	}
	return r.Ausgabe, nil
}

func (l *laufZustand) aufspielen(ctx context.Context) (protokoll.Beleg, string, error) {
	// Ab hier nimmt jeder Fehler die Sicherung zurück.
	l.aufgespielt = true
	r, err := l.skript(ctx, "install.sh", nil, mango.InstallUmgebung(l.k.Bauart, l.pfadManifest, l.dirVertrauen, l.k.PortalURL)...)
	if err != nil {
		return nil, "", err
	}
	b := protokoll.Beleg{}.Mit("install", zeilenMit(r.Ausgabe, "Fassung", "Pruefsumme", "Firewall", "FEHLER", "fertig"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "Pruefsumme auf dem Geraet bestaetigt") {
		return b, "", fmt.Errorf("install.sh endete mit %d: %s", r.Code, letzteZeilen(r.Ausgabe, 4))
	}
	// Die Sitzung kann das Neuladen der Firewall in install.sh nicht überstehen
	// (an der echten Box noch zu belegen): dann einmal neu anmelden.
	if _, err := l.v.Fuehre(ctx, "true", nil); err != nil {
		l.v.Schliesse()
		l.v = nil
		if err := l.verbinde(ctx, wartung.Server{}, nil); err != nil {
			return b, "", fmt.Errorf("nach install.sh: %w", err)
		}
		b = b.Mit("sitzung", "nach install.sh neu angemeldet")
	} else {
		b = b.Mit("sitzung", "Sitzung im Tunnel blieb über install.sh hinweg stehen")
	}
	wb, land, err := mango.EinrichtungsWlanVorbereiten(ctx, l.v)
	b = append(b, wb...)
	if err != nil {
		return b, "", err
	}
	return b, "install.sh: Prüfsumme auf der Box bestätigt; Land " + land + ", Paket relayd", nil
}

// ---- neustart ----------------------------------------------------------------

func (l *laufZustand) neustart(ctx context.Context) (protokoll.Beleg, string, error) {
	if m, err := l.k.Portal.FernlaufMeldungLesen(ctx, l.id); err == nil && m.CsrUpdatedAt.After(l.csrZuletzt) {
		l.csrZuletzt = m.CsrUpdatedAt
	}
	if r, err := l.v.Fuehre(ctx, "/etc/init.d/vp-edge-light restart", nil); err != nil || r.Code != 0 {
		return nil, "", fmt.Errorf("Neustart des Programms: %v %s", err, kurz(r.Text(), 200))
	}
	h, err := l.warteHealth(ctx, l.a.Ziel.Fassung)
	b := protokoll.Beleg{}.Mit("health", "ref "+h.Ref+", version "+h.Version)
	if err != nil {
		return b, "", err
	}
	if g := mango.UpdateBereit(h, &l.stand); g != "" {
		return b.Mit("update_bereit", "nein - "+g), "", fmt.Errorf("nicht update-bereit: %s", g)
	}
	return b.Mit("update_bereit", "ja"), fmt.Sprintf("/health: %s, Referenz %s, update-bereit (Stand %d)", h.Version, h.Ref, l.stand.ReleaseSeq), nil
}

// warteHealth wartet, bis /health die Referenz des Auftrags und die Fassung nennt.
func (l *laufZustand) warteHealth(ctx context.Context, fassung string) (mango.Health, error) {
	ctx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Programm)
	defer cancel()
	var h mango.Health
	var letzter error
	for {
		erg, err := l.v.Fuehre(ctx, mango.BefehlHealth, nil)
		switch {
		case err != nil:
			// Reißt die Frist genau während dieser Abfrage, meldet Fuehre nur noch
			// ctx.Err(): das ersetzt sonst den zuletzt bekannten, aussagekräftigen
			// Grund (z. B. die falsch gestartete Fassung) durch "context deadline
			// exceeded". Der alte Grund bleibt, solange es einen gibt.
			if letzter == nil || ctx.Err() == nil {
				letzter = err
			}
		default:
			var ok bool
			if h, ok = mango.LiesHealth(erg.Aus); !ok {
				letzter = errors.New("/health nennt noch keine Referenz")
			} else if h.Ref != l.a.EdgeRef {
				return h, fmt.Errorf("/health nennt die Referenz %q statt %s", h.Ref, l.a.EdgeRef)
			} else if h.Version != fassung {
				letzter = fmt.Errorf("/health nennt %q statt %s", h.Version, fassung)
			} else {
				return h, nil
			}
		}
		select {
		case <-ctx.Done():
			return h, fmt.Errorf("nach dem Neustart: %v", letzter)
		case <-time.After(l.k.Zeiten.Takt):
		}
		if errors.Is(letzter, box.Abgerissen) {
			return h, letzter
		}
	}
}

// ---- meldet_sich -------------------------------------------------------------

func (l *laufZustand) meldetSich(ctx context.Context) (protokoll.Beleg, string, error) {
	m, err := l.warteMeldung(ctx, l.a.Ziel.Fassung)
	b := protokoll.Beleg{}.Mit("device_info", m.DeviceInfo).Mit("csr_updated_at", zeit(m.CsrUpdatedAt)).Mit("zuletzt_abgefragt_am", zeit(m.ZuletztAbgefragtAm))
	if err != nil {
		return b, "", err
	}
	if m.Zertifikat {
		return b.Mit("zertifikat", "ja"), "Inzwischen verbunden: die Box hat ein Zertifikat", nil
	}
	return b, "Meldet sich mit " + l.a.Ziel.Fassung + " (Zertifikatsanfrage " + zeit(m.CsrUpdatedAt) + ", danach weiter gefragt)", nil
}

// warteMeldung wartet, bis die Plattform nach dem Neustart eine neue
// Zertifikatsanfrage mit dieser Fassung und danach weitere Abfragen hört.
func (l *laufZustand) warteMeldung(ctx context.Context, fassung string) (portal.FernlaufMeldung, error) {
	ende := time.Now().Add(l.k.Zeiten.MeldetSich)
	var m portal.FernlaufMeldung
	for {
		var err error
		m, err = l.k.Portal.FernlaufMeldungLesen(ctx, l.id)
		if err == nil {
			if m.Zertifikat {
				return m, nil
			}
			if m.CsrUpdatedAt.After(l.csrZuletzt) && m.DeviceInfo == "vp-edge-core "+fassung && m.ZuletztAbgefragtAm.After(m.CsrUpdatedAt) {
				l.csrZuletzt = m.CsrUpdatedAt
				return m, nil
			}
		}
		if time.Now().After(ende) {
			grund := "die Plattform hört keine neue Zertifikatsanfrage mit " + fassung
			if err != nil {
				grund += " (" + err.Error() + ")"
			} else if m.CsrUpdatedAt.After(l.csrZuletzt) {
				grund = fmt.Sprintf("die letzte Zertifikatsanfrage nennt %q, danach keine weitere Abfrage", m.DeviceInfo)
			}
			return m, fmt.Errorf("binnen %s: %s", l.k.Zeiten.MeldetSich, grund)
		}
		select {
		case <-ctx.Done():
			return m, ctx.Err()
		case <-time.After(l.k.Zeiten.Takt):
		}
	}
}

func zeit(t time.Time) string {
	if t.IsZero() {
		return "keine"
	}
	return t.UTC().Format(time.RFC3339)
}

// ---- tunnel ------------------------------------------------------------------

func (l *laufZustand) tunnel(ctx context.Context) (protokoll.Beleg, string, error) {
	status, err := l.tunnelStatus(ctx)
	if err != nil {
		return nil, "", err
	}
	b := mango.TunnelBeleg(status)
	var neu []string
	for _, f := range mango.TunnelLuecken(status) {
		if !l.tunnelVorher[f] {
			neu = append(neu, f)
		}
	}
	if len(neu) > 0 {
		return b, "", fmt.Errorf("am Tunnel fehlt jetzt, was vorher da war: %s", strings.Join(neu, ", "))
	}
	hs, _ := b.Wert("handshake")
	return b, "Tunnel wie vorher: " + orKein(hs), nil
}

func orKein(s string) string {
	if s == "" {
		return "kein Handshake-Wert"
	}
	return s
}

// ---- zurueck -----------------------------------------------------------------

// zurueck spielt die Sicherung ein: Programm anhalten, was install.sh neu
// anlegte entfernen, die Sicherung auspacken, Land zurück, Firewall und cron
// neu laden, Programm starten; dann muss /health die alte Fassung nennen und
// die Plattform sie wieder hören. Der Tunnel bleibt, wie er war.
func (l *laufZustand) zurueck(ctx context.Context) (protokoll.Beleg, string, error) {
	if l.sicherung == "" {
		return nil, "", errors.New("keine Sicherung")
	}
	if l.v == nil {
		if err := l.verbinde(ctx, wartung.Server{}, nil); err != nil {
			return nil, "", err
		}
	} else if _, err := l.v.Fuehre(ctx, "true", nil); err != nil {
		l.v.Schliesse()
		l.v = nil
		if err := l.verbinde(ctx, wartung.Server{}, nil); err != nil {
			return nil, "", err
		}
	}
	daten, err := os.ReadFile(l.sicherung)
	if err != nil {
		return nil, "", err
	}
	// Was in den gesicherten Verzeichnissen und unter /etc/rc.d jetzt liegt,
	// aber nicht in der Sicherung stand, kam mit dem Aufspielen.
	liste, err := l.v.Fuehre(ctx, "for d in "+strings.Join(gesicherteVerzeichnisse, " ")+"; do [ -d /$d ] && [ ! -L /$d ] && find /$d -mindepth 1; done; for f in /etc/rc.d/*vp-edge-light; do [ -L \"$f\" ] && echo $f; done; true", nil)
	if err != nil {
		return nil, "", err
	}
	var weg []string
	for _, p := range l.fehlten {
		weg = append(weg, "/"+p)
	}
	for _, z := range strings.Split(liste.Aus, "\n") {
		p := strings.TrimPrefix(strings.TrimSpace(z), "/")
		if p == "" || l.inSicherung[p] {
			continue
		}
		weg = append(weg, "/"+p)
	}
	var befehl strings.Builder
	befehl.WriteString("/etc/init.d/vp-edge-light stop >/dev/null 2>&1; ")
	if len(weg) > 0 {
		befehl.WriteString("rm -rf " + strings.Join(quoteAlle(weg), " ") + "; ")
	}
	if l.otaLink {
		befehl.WriteString("rm -rf /etc/vp-edge-light/ota; ")
	}
	befehl.WriteString("tar -xzf - -C / && sync")
	r, err := l.v.Fuehre(ctx, befehl.String(), bytes.NewReader(daten))
	if err != nil {
		return nil, "", fmt.Errorf("Sicherung einspielen: %w", err)
	}
	if r.Code != 0 {
		return nil, "", fmt.Errorf("Sicherung einspielen: endete mit %d: %s", r.Code, kurz(strings.TrimSpace(r.Fehl), 200))
	}
	land := "uci -q delete wireless.radio0.country; uci commit wireless"
	switch l.landVorher {
	case "-":
		land = "true"
	case "":
	default:
		land = "uci set wireless.radio0.country=" + shellWort(l.landVorher) + " && uci commit wireless"
	}
	if m, err := l.k.Portal.FernlaufMeldungLesen(ctx, l.id); err == nil && m.CsrUpdatedAt.After(l.csrZuletzt) {
		l.csrZuletzt = m.CsrUpdatedAt
	}
	r, err = l.v.Fuehre(ctx, "if uci -q get wireless.radio0 >/dev/null 2>&1; then "+land+"; fi; /etc/init.d/firewall reload >/dev/null 2>&1; /etc/init.d/cron restart >/dev/null 2>&1; /etc/init.d/vp-edge-light start", nil)
	if err != nil || r.Code != 0 {
		return nil, "", fmt.Errorf("nach dem Einspielen: %v %s", err, kurz(r.Text(), 200))
	}
	b := protokoll.Beleg{}.Mit("eingespielt", fmt.Sprintf("%d Bytes, entfernt: %s", len(daten), strings.Join(weg, " "))).Mit("land", l.landVorher)
	h, err := l.warteHealth(ctx, l.vorher)
	b = b.Mit("health", "ref "+h.Ref+", version "+h.Version)
	if err != nil {
		return b, "", err
	}
	m, err := l.warteMeldung(ctx, l.vorher)
	b = b.Mit("device_info", m.DeviceInfo)
	if err != nil {
		return b, "", err
	}
	return b, "Zurück auf " + l.vorher + ": /health nennt sie, die Plattform hört sie wieder", nil
}

// ---- fenster_zu --------------------------------------------------------------

func (l *laufZustand) fensterZu(ctx context.Context) (protokoll.Beleg, string, error) {
	schonZu, err := l.k.Portal.FernlaufFensterSchliessen(ctx, l.id)
	if err != nil {
		return nil, "", err
	}
	z := "geschlossen"
	if schonZu {
		z = "war schon zu"
	}
	return protokoll.Beleg{}.Mit("fenster", l.a.FensterID+": "+z), "Fenster " + z, nil
}

// ---- Hilfen ------------------------------------------------------------------

func kurz(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func letzteZeilen(s string, n int) string {
	z := strings.Split(strings.TrimSpace(s), "\n")
	if len(z) > n {
		z = z[len(z)-n:]
	}
	return strings.Join(z, " | ")
}

func zeilenMit(text string, stichwoerter ...string) string {
	var out []string
	for _, z := range strings.Split(text, "\n") {
		for _, s := range stichwoerter {
			if strings.Contains(z, s) {
				out = append(out, strings.TrimSpace(z))
				break
			}
		}
	}
	return strings.Join(out, "\n")
}

func shellWort(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func quoteAlle(s []string) []string {
	out := make([]string, len(s))
	for i, x := range s {
		out[i] = shellWort(x)
	}
	return out
}
