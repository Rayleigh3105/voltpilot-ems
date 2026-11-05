// Package mango richtet eine GL.iNet Mango (GL-MT300N-V2) am
// Werkstatt-Anschluss ein: von der Werksfirmware zu OpenWrt (P3) und von
// frischem OpenWrt bis zur Neustart-Probe (P5). Jeder Schritt endet mit einem
// Beleg aus der echten Ausgabe der Box; die Schritte führt der Läufer aus
// (internal/lauf).
//
// Der Dienst spricht mit der Box nur durch die Werkbank-Brücke und nur unter
// ihren Werkstatt-Adressen: 192.168.8.1 (ab Werk), 192.168.1.1 (frisches
// OpenWrt) und dem LAN-Netz der Freigabe (Vorgabe 10.213.0.1).
//
// In V1a bleiben bei dir: die Tunnel-Adresse aus dem Portal eintragen
// (Tunnel-Schlüssel hinterlegen), die Probe im Fenster, Fenster schließen und
// die Abnahme im Portal - mit den Belegen dieses Laufs.
package mango

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"time"

	"filippo.io/age"
	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/gehaeuse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// Feste Adressen der Mango am Werkstatt-Anschluss.
var (
	WerksAdresse   = netip.MustParseAddr("192.168.8.1")
	OpenWrtAdresse = netip.MustParseAddr("192.168.1.1")
	// Die Brücke im OpenWrt-Netz: Weg ins Internet für die Werkstatt.
	BrueckeOpenWrt = netip.MustParseAddr("192.168.1.2")
)

// Boards, die als GL-MT300N-V2 gelten (/tmp/sysinfo/board_name).
var Boards = []string{"glinet,gl-mt300n-v2", "gl-mt300n-v2"}

// Werkbank ist, was die Schritte von der Brücke brauchen.
type Werkbank interface {
	box.Weg
	Status(ctx context.Context) (werkbank.Status, error)
}

// Zeiten der Schritte; in Tests kürzer.
type Zeiten struct {
	Takt       time.Duration // Abstand beim Warten auf die Box
	Verbinden  time.Duration // je Anmeldeversuch
	Sysupgrade time.Duration // bis frisches OpenWrt antwortet
	Neustart   time.Duration // bis die Box nach dem Neustart antwortet
	Netz       time.Duration // bis Internet bzw. Standardweg stimmen
	Programm   time.Duration // bis /health die Referenz nennt
	Tunnel     time.Duration // bis Handshake und Abholer stehen
}

// VorgabeZeiten für die echte Mango (PS-3 misst sie nach).
var VorgabeZeiten = Zeiten{Takt: 3 * time.Second, Verbinden: 20 * time.Second, Sysupgrade: 8 * time.Minute, Neustart: 5 * time.Minute, Netz: 90 * time.Second, Programm: 2 * time.Minute, Tunnel: 3 * time.Minute}

// Konfig gilt für alle Läufe eines Dienstes.
type Konfig struct {
	Werkbank   Werkbank
	Fassungen  *fassungen.Ablage
	Arbeit     string       // Arbeitsverzeichnis der Läufe (/tmp)
	LanNetz    netip.Prefix // Adresse der Box im LAN, /24 (Entscheid 6a)
	LanBruecke netip.Addr   // die Brücke im LAN-Netz
	DNS        []netip.Addr // für das Werkstatt-Internet der Box
	Notfall    string       // öffentlicher Notfall-Schlüssel (authorized_keys-Zeile)
	Empfaenger age.Recipient
	WartungPub string       // öffentlicher Schlüssel des Wartungsservers (Portal)
	WartungEP  string       // Endpunkt; leer: Vorgabe des Skripts (wartung.voltpilot.de)
	BoxNetz    netip.Prefix // Tunnel-Adressen der Boxen
	Bauart     string       // Edge Light: mipsle (Mango)
	// PortalURL ist das Portal, von dem install.sh das Vertrauens-Set offen
	// laedt (/api/v1/edge/trust-set/…); leer: Vorgabe des Skripts.
	PortalURL string
	// Portal ist der Dienst-Baum der API (V1): Einmal-Code, Probe-Fenster der
	// Einlösung, Abnahme mit Belegen. nil heißt V1a: Tunnel-Adresse als
	// Eingabe, Abnahme im Portal von Hand.
	Portal Portal
	// Probe ist die Anmeldung des Dienstes über den Wartungstunnel als
	// Techniker-Zugang „Werkstatt-Dienst“ (WI-5 A, internal/wartung). nil:
	// die Probe bleibt ein Handgriff im Portal.
	Probe Probe
	// Gehaeuse nimmt nach der Übergabe den Auftrag für die Druckdatei des
	// Gehäuses an (internal/gehaeuse, P10). nil: das Gehäuse baut der
	// Betreiber selbst (bauen.sh --referenz).
	Gehaeuse Gehaeuse
	// Spuren sind die Protokolle dieses Dienstes (protokoll.Ablage): Mit ihnen
	// erkennt er eine Box mit Passwort als eine, die diese Werkstatt begonnen
	// und nicht fertig gemacht hat (HalbEigene). nil: jede Box mit Passwort
	// ist fremd.
	Spuren Spuren
	Zeiten Zeiten
	Log    *slog.Logger
}

// Spuren sucht in den Protokollen des Dienstes (protokoll.Ablage).
type Spuren interface {
	SpurDerMAC(mac, ausser string) (protokoll.Spur, bool, error)
}

// Gehaeuse ist die Schlange der Druckdateien (gehaeuse.Werkstatt).
type Gehaeuse interface {
	Bestelle(ref, lauf string, neu bool) (gehaeuse.Auftrag, error)
}

// Probe ist, was ein Lauf von der Probe über den Tunnel braucht (wartung.Probe).
type Probe interface {
	Anmelden(ctx context.Context, s wartung.Server, box netip.AddrPort) (wartung.Anmeldung, error)
	NachEnde(ctx context.Context, s wartung.Server, box netip.AddrPort) (string, error)
	Fingerabdruck() string
}

// Portal ist, was ein Lauf vom Dienst-Baum der API braucht (internal/portal).
type Portal interface {
	CodeHolen(ctx context.Context, edgeRef string, tausch bool) (portal.Code, error)
	FensterSchliessen(ctx context.Context, fensterID string) (schonZu bool, err error)
	AbnahmeSchreiben(ctx context.Context, edgeRef string, a portal.Abnahme) (portal.Angenommen, error)
	BoxStandLesen(ctx context.Context, edgeRef string) (portal.BoxStand, error)
}

// NotfallFingerabdruck gibt den Fingerabdruck des Notfall-Schlüssels.
func (k Konfig) NotfallFingerabdruck() (string, error) {
	pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(k.Notfall))
	if err != nil {
		return "", fmt.Errorf("Notfall-Schlüssel: %v", err)
	}
	return ssh.FingerprintSHA256(pk), nil
}

// Einstieg: wo die Box steht, wenn ihr Lauf beginnt.
type Einstieg string

const (
	AbWerk    Einstieg = "werk"    // GL-Werksfirmware unter 192.168.8.1
	AbOpenWrt Einstieg = "openwrt" // frisches OpenWrt unter 192.168.1.1
	// HalbImLan: eine Box unter dem LAN-Netz, die laut Protokoll ein Lauf
	// dieser Werkstatt begonnen und nicht fertig gemacht hat. Ihr Lauf hat nur
	// den Schritt erkennen: Er prüft, ob sie es wirklich ist, und nennt dann
	// den Handgriff Zurücksetzen. Angemeldet wird nie.
	HalbImLan Einstieg = "lan"
)

// Lauf ist der Zustand einer Box während ihres Laufs. Das Passwort lebt nur
// hier, im Speicher.
type Lauf struct {
	k        Konfig
	freigabe freigabe.Freigabe
	kennung  string
	dir      string
	log      *slog.Logger

	mac                                   string
	v                                     *box.Verbindung
	ziel                                  netip.AddrPort
	pw                                    geheim.Geheim
	host                                  string // Fingerabdruck nach OpenWrt: gilt für den ganzen Lauf
	hostArt                               string
	ref                                   string
	version                               string
	tunnelPub, tunnelAdresse              string
	probeFenster                          string // Probe-Fenster der Einlösung (V1)
	serverPub, serverEP                   string // Wartungsserver aus der Einlösung
	probeAutomatisch                      bool   // die Probe lief über den Tunnel des Dienstes
	passwortAge                           string // das Root-Passwort, nur verschlüsselt
	notfallFP                             string
	pfadAbbild, pfadProgramm, pfadSkripte string
	dr                                    *durchreiche.Server
	tmpFrei                               int64
	belege                                map[string]string // Prüfung → wo ihr Beleg steht
	// Update-bereit (Konzept vp-edge-light-update, K5): das signierte
	// Manifest der Fassung (leer: Stufe 1) und, falls nicht update-bereit, warum.
	pfadManifest string
	stand        *fassungen.Stand
	nichtBereit  string
}

// NeuerLauf legt den Zustand für eine Box an.
func NeuerLauf(k Konfig, f freigabe.Freigabe, kennung string) (*Lauf, error) {
	if k.Zeiten == (Zeiten{}) {
		k.Zeiten = VorgabeZeiten
	}
	fp, err := k.NotfallFingerabdruck()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(k.Arbeit, "lauf-"+kennung)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Lauf{k: k, freigabe: f, kennung: kennung, dir: dir, log: k.Log.With("request_id", kennung), notfallFP: fp, belege: map[string]string{}}, nil
}

// Schliesse räumt auf: Verbindung, Durchreiche, Arbeitsverzeichnis; das
// Passwort wird vergessen (es steht nur noch verschlüsselt im Protokoll).
func (l *Lauf) Schliesse() {
	if l.dr != nil {
		l.dr.Schliesse()
	}
	l.v.Schliesse()
	l.pw.Vergessen()
	_ = os.RemoveAll(l.dir)
}

// MAC der Box, sobald erkannt.
func (l *Lauf) MAC() string { return l.mac }

// Schritte gibt die Folge für einen Einstieg zurück.
func (l *Lauf) Schritte(e Einstieg) []lauf.Schritt {
	var s []lauf.Schritt
	if e == HalbImLan {
		return []lauf.Schritt{{Kennung: "erkennen", Titel: "Halb eingerichtete Mango erkennen", Frist: time.Minute, Tun: l.erkennenHalbImLan}}
	}
	if e == AbWerk {
		s = append(s,
			lauf.Schritt{Kennung: "erkennen", Titel: "Mango erkennen", Frist: time.Minute, Tun: l.erkennenWerk},
			lauf.Schritt{Kennung: "fassungen", Titel: "Fassungen der Freigabe bereitlegen", Frist: 15 * time.Minute, Tun: l.fassungenHolen(true)},
			lauf.Schritt{Kennung: "openwrt", Titel: "OpenWrt aufspielen", Frist: 5 * time.Minute, Tun: l.openwrtAufspielen},
			lauf.Schritt{Kennung: "wiedererkennen", Titel: "Neustart in OpenWrt abwarten", Frist: l.k.Zeiten.Sysupgrade + time.Minute, Tun: l.wiedererkennen},
		)
	} else {
		s = append(s,
			lauf.Schritt{Kennung: "erkennen", Titel: "Mango mit OpenWrt erkennen", Frist: time.Minute, Tun: l.erkennenOpenWrt},
			lauf.Schritt{Kennung: "fassungen", Titel: "Fassungen der Freigabe bereitlegen", Frist: 15 * time.Minute, Tun: l.fassungenHolen(false)},
		)
	}
	return append(s,
		lauf.Schritt{Kennung: "internet", Titel: "Internet über die Brücke (befristet)", Frist: 3 * time.Minute, Tun: l.internetAn},
		lauf.Schritt{Kennung: "passwort", Titel: "Root-Passwort setzen", Frist: 2 * time.Minute, Tun: l.passwortSetzen},
		lauf.Schritt{Kennung: "notfall", Titel: "Notfall-Schlüssel", Frist: time.Minute, Tun: l.notfallSchluessel},
		lauf.Schritt{Kennung: "programm", Titel: "Edge Light einspielen", Frist: 10 * time.Minute, Tun: l.programmEinspielen},
		lauf.Schritt{Kennung: "tunnel_schluessel", Titel: "Tunnel-Schlüssel erzeugen", Frist: 5 * time.Minute, Tun: l.tunnelSchluessel},
		l.adressSchritt(),
		lauf.Schritt{Kennung: "tunnel", Titel: "Tunnel einrichten", Frist: 10 * time.Minute, Tun: l.tunnelEinrichten},
		lauf.Schritt{Kennung: "lan", Titel: "LAN umstellen und neu starten", Frist: time.Minute, Tun: l.lanUmstellen},
		lauf.Schritt{Kennung: "neustart", Titel: "Neustart-Probe", Frist: l.k.Zeiten.Neustart + 5*time.Minute, Tun: l.neustartProbe},
		lauf.Schritt{Kennung: "probe", Titel: "Probe im Fenster (im Portal)", Frist: 12 * time.Hour, Tun: l.probeImPortal},
		lauf.Schritt{Kennung: "internet_weg", Titel: "Werkstatt-Internet entfernen", Frist: 3 * time.Minute, Tun: l.internetWeg},
		lauf.Schritt{Kennung: "uebergabe", Titel: "Belege für die Abnahme", Frist: time.Minute, Tun: l.uebergabe},
	)
}

// ---- Hilfen ------------------------------------------------------------------

// Antworten an einer Adresse laut Status der Brücke.
func antworten(s werkbank.Status, a netip.Addr) []string {
	for _, x := range s.Antworten {
		if x.Adresse == a.String() {
			return x.MACs
		}
	}
	return nil
}

// Einzig ist das eine Gerät am Werkstatt-Anschluss.
type Einzig struct {
	Adresse netip.Addr
	MAC     string
}

// Einzeln prüft, dass genau ein Gerät mit genau einer MAC antwortet.
func Einzeln(s werkbank.Status) (Einzig, error) {
	var e []Einzig
	macs := map[string]bool{}
	for _, x := range s.Antworten {
		a, err := netip.ParseAddr(x.Adresse)
		if err != nil {
			continue
		}
		for _, m := range x.MACs {
			e = append(e, Einzig{Adresse: a, MAC: m})
			macs[m] = true
		}
	}
	switch {
	case len(e) == 0:
		return Einzig{}, errors.New("am Werkstatt-Anschluss antwortet kein Gerät")
	case len(macs) > 1 || len(e) > 1:
		var t []string
		for _, x := range e {
			t = append(t, x.MAC+" unter "+x.Adresse.String())
		}
		return Einzig{}, lauf.Handgriff{Was: "Nur eine Mango an das orange Kabel WERKSTATT stecken, die übrigen abziehen.", Fall: faelle.ZweiGeraete, Grund: "Am Werkstatt-Anschluss antworten mehrere Geräte: " + strings.Join(t, ", ")}
	}
	return e[0], nil
}

func (l *Lauf) zielLan() netip.AddrPort { return netip.AddrPortFrom(l.k.LanNetz.Addr(), 22) }

// verbinde meldet sich an der aktuellen Adresse an, mit Wiederholung bis frist.
func (l *Lauf) verbinde(ctx context.Context, ziel netip.AddrPort, pw geheim.Geheim, frist time.Duration) (*box.Verbindung, error) {
	var regel box.HostRegel
	if l.host != "" {
		regel = box.GenauDieser(l.host)
	}
	ende := time.Now().Add(frist)
	for {
		v, err := box.Verbinde(ctx, l.k.Werkbank, ziel, pw, regel, l.k.Zeiten.Verbinden)
		if err == nil {
			return v, nil
		}
		var ab box.Abgewiesen
		if errors.As(err, &ab) || strings.Contains(err.Error(), "Host-Schlüssel der Box ist") || time.Now().After(ende) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(l.k.Zeiten.Takt):
		}
	}
}

// neuVerbinden ersetzt die Verbindung (nach einem Neustart des Netzes).
func (l *Lauf) neuVerbinden(ctx context.Context, ziel netip.AddrPort, frist time.Duration) error {
	l.v.Schliesse()
	l.v = nil
	v, err := l.verbinde(ctx, ziel, l.pw, frist)
	if err != nil {
		return err
	}
	l.v, l.ziel = v, ziel
	return nil
}

// fuehre führt einen Befehl auf der Box aus und verlangt Ausgang 0.
func (l *Lauf) fuehre(ctx context.Context, befehl string, ein string) (box.Ergebnis, error) {
	var r *strings.Reader
	if ein != "" {
		r = strings.NewReader(ein)
	}
	var erg box.Ergebnis
	var err error
	if r != nil {
		erg, err = l.v.Fuehre(ctx, befehl, r)
	} else {
		erg, err = l.v.Fuehre(ctx, befehl, nil)
	}
	if err != nil {
		return erg, err
	}
	if erg.Code != 0 {
		return erg, fmt.Errorf("auf der Box: %q endete mit %d: %s", kurz(befehl, 60), erg.Code, letzte(erg.Text(), 4))
	}
	return erg, nil
}

// warteAuf ruft f im Takt, bis es nil liefert oder frist abläuft.
func (l *Lauf) warteAuf(ctx context.Context, frist time.Duration, f func() error) error {
	ende := time.Now().Add(frist)
	for {
		err := f()
		if err == nil {
			return nil
		}
		var h lauf.Handgriff
		if errors.As(err, &h) || time.Now().After(ende) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(l.k.Zeiten.Takt):
		}
	}
}

func kurz(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func letzte(s string, n int) string {
	z := strings.Split(strings.TrimSpace(s), "\n")
	if len(z) > n {
		z = z[len(z)-n:]
	}
	return strings.Join(z, " | ")
}

// zeilenMit gibt die Zeilen zurück, die eines der Stichwörter enthalten.
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

func boardPasst(b string) bool {
	b = strings.ToLower(strings.TrimSpace(b))
	for _, x := range Boards {
		if b == x {
			return true
		}
	}
	return false
}

// shellWort setzt einen Wert in einfache Anführungszeichen.
func shellWort(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
