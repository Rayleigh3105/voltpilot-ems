// Package pfc200 richtet einen WAGO PFC200 G2 (750-8212) am Werkstatt-Anschluss
// als Box „Edge Industrie“ ein: vom Werkszustand bis zur Abnahme. Jeder
// Schritt endet mit einem Beleg aus der echten Ausgabe des Geräts; die
// Schritte führt der Läufer aus (internal/lauf), neben dem Paket für die Mango
// (internal/mango).
//
// Der Dienst spricht mit dem Gerät nur durch die Werkbank-Brücke und nur unter
// zwei Adressen: 192.168.1.17 (die feste Adresse nach dem Handgriff am
// Reset-Taster) und der Adresse des Anlagennetzes (Vorgabe 10.213.0.1), auf
// die der Schritt netze die Buchse X2 stellt.
//
// Was der Dienst am Gerät ändert, ändert er mit den Werkzeugen der
// WAGO-Firmware (/etc/config-tools), so wie sie die Firmware selbst aufruft.
// Nie angefasst: die SPS-Laufzeit (CODESYS), ihre Einstellungen, ihr Programm
// und ihr Modbus-Server; die Firmware des Geräts; fremde Container. Der Stand
// der Firmware steht nur als Angabe im Beleg.
package pfc200

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
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
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/halb"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// Feste Angaben zum Gerät.
var (
	// FesteAdresse nimmt der PFC200 nach dem Handgriff am Reset-Taster an
	// (Betriebsartenschalter auf STOP, Reset länger als 8 s): vorübergehend,
	// bis zum nächsten Neustart.
	FesteAdresse = netip.MustParseAddr("192.168.1.17")
	// BrueckeFest ist die Brücke im Netz der festen Adresse: der Weg ins
	// Internet, bis das Anlagennetz steht.
	BrueckeFest = netip.MustParseAddr("192.168.1.2")
)

const (
	// Artikel ist die Bestellnummer, für die dieser Ablauf gilt.
	Artikel = "750-8212"
	// WagoMAC ist der Anfang jeder MAC-Adresse von WAGO.
	WagoMAC = "00:30:de"
	// Werkspasswörter laut Handbuch: root und admin „wago“, user „user“.
	werkRoot  = "wago"
	werkAdmin = "wago"
	werkUser  = "user"
	// Bauart des Programms: der PFC200 G2 ist ARMv7.
	Bauart = "arm"
	// Werkzeuge ist das Verzeichnis der Werkzeuge der WAGO-Firmware.
	Werkzeuge = "/etc/config-tools"
)

// IstWago sagt, ob eine MAC-Adresse zu einem Gerät von WAGO gehört.
func IstWago(mac string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(mac)), WagoMAC)
}

// Werkbank ist, was die Schritte von der Brücke brauchen.
type Werkbank interface {
	box.Weg
	Status(ctx context.Context) (werkbank.Status, error)
}

// Zeiten der Schritte; in Tests kürzer.
type Zeiten struct {
	Takt      time.Duration // Abstand beim Warten auf das Gerät
	Verbinden time.Duration // je Anmeldeversuch
	Neustart  time.Duration // bis das Gerät nach dem Neustart antwortet
	Netz      time.Duration // bis Internet bzw. die neue Adresse stehen
	Programm  time.Duration // bis /health die Referenz nennt
	Tunnel    time.Duration // bis Handshake und Abholer stehen
	Schalter  time.Duration // so lange wartet der Lauf auf den Betriebsartenschalter
	SSHDienst time.Duration // bis der SSH-Dienst nach seinem Neustart wieder annimmt
	// Firewall: Bestätigt der Dienst die eingeschaltete Firewall nicht in
	// dieser Zeit mit einer NEUEN Anmeldung, schaltet das Gerät sie selbst
	// wieder aus (der Lauf sperrt sich nicht aus).
	Firewall time.Duration
}

// VorgabeZeiten für das echte Gerät.
var VorgabeZeiten = Zeiten{Takt: 3 * time.Second, Verbinden: 20 * time.Second, Neustart: 8 * time.Minute, Netz: 2 * time.Minute,
	Programm: 3 * time.Minute, Tunnel: 3 * time.Minute, Schalter: 30 * time.Minute, SSHDienst: 90 * time.Second, Firewall: 3 * time.Minute}

// Konfig gilt für alle Läufe eines Dienstes.
type Konfig struct {
	Werkbank  Werkbank
	Fassungen *fassungen.Ablage
	Arbeit    string // Arbeitsverzeichnis der Läufe (/tmp)
	// LanNetz ist das Anlagennetz an der Buchse X2: die Adresse des Geräts
	// mit Länge /24 (wie das LAN der Mango, Entscheid E5 A).
	LanNetz    netip.Prefix
	LanBruecke netip.Addr   // die Brücke im Anlagennetz
	DNS        []netip.Addr // für das Werkstatt-Internet des Geräts
	// Zeitserver für den Zeitabgleich des Geräts (bleibt nach dem Lauf an).
	Zeitserver []string
	// Notfall ist der öffentliche Notfall-Schlüssel (authorized_keys-Zeile).
	// Der SSH-Dienst des PFC200 nimmt nur RSA und ECDSA.
	Notfall    string
	Empfaenger age.Recipient
	WartungPub string       // öffentlicher Schlüssel des Wartungsservers (Portal)
	WartungEP  string       // Name des Wartungsservers; leer: Vorgabe von wartung.sh
	BoxNetz    netip.Prefix // Tunnel-Adressen der Boxen
	// PortalURL ist das Portal: Dort lädt der Dienst das Vertrauens-Set, und
	// dorthin prüft das Gerät seinen Weg ins Internet. Leer: das Standard-Portal.
	PortalURL string
	// Portal ist der Dienst-Baum der API: Einmal-Code, Probe-Fenster der
	// Einlösung, Abnahme mit Belegen. nil: Tunnel-Adresse als Eingabe, Probe
	// und Abnahme im Portal von Hand.
	Portal Portal
	// Probe ist die Anmeldung des Dienstes über den Wartungstunnel als
	// Techniker-Zugang „Werkstatt-Dienst“. nil: die Probe bleibt ein Handgriff.
	Probe Probe
	// Spuren sind die Protokolle dieses Dienstes: Mit ihnen erkennt er ein
	// Gerät, das diese Werkstatt begonnen und nicht fertig gemacht hat.
	Spuren halb.Spuren
	Zeiten Zeiten
	// Jetzt ist die Uhr des Dienstes: Nach ihr stellt er die Uhr des Geräts
	// (ab Werk steht sie in der Vergangenheit). nil: time.Now.
	Jetzt func() time.Time
	Log   *slog.Logger
}

// Probe ist, was ein Lauf von der Probe über den Tunnel braucht (wartung.Probe).
type Probe interface {
	Anmelden(ctx context.Context, s wartung.Server, box netip.AddrPort) (wartung.Anmeldung, error)
	NachEnde(ctx context.Context, s wartung.Server, box netip.AddrPort) (string, error)
	Fingerabdruck() string
}

// Portal ist, was ein Lauf vom Dienst-Baum der API braucht (internal/portal).
type Portal interface {
	// CodeHolenFuer: Der Code gilt für das Gerät pfc200 (eigene Freigabe,
	// eigene Box-Art im Register).
	CodeHolenFuer(ctx context.Context, edgeRef string, tausch bool, geraet string) (portal.Code, error)
	FensterSchliessen(ctx context.Context, fensterID string) (schonZu bool, err error)
	AbnahmeSchreiben(ctx context.Context, edgeRef string, a portal.Abnahme) (portal.Angenommen, error)
	BoxStandLesen(ctx context.Context, edgeRef string) (portal.BoxStand, error)
}

// NotfallPruefen prüft den Notfall-Schlüssel für den PFC200: lesbar und von
// einer Art, die der SSH-Dienst des Geräts annimmt (RSA oder ECDSA). Gibt den
// Fingerabdruck zurück.
func NotfallPruefen(zeile string) (string, error) {
	pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(zeile))
	if err != nil {
		return "", fmt.Errorf("Notfall-Schlüssel: %v", err)
	}
	if !schluesselArtPasst(pk.Type()) {
		return "", fmt.Errorf("Notfall-Schlüssel der Art %s: der SSH-Dienst des PFC200 nimmt nur RSA und ECDSA", pk.Type())
	}
	return ssh.FingerprintSHA256(pk), nil
}

func schluesselArtPasst(art string) bool {
	return art == ssh.KeyAlgoRSA || strings.HasPrefix(art, "ecdsa-sha2-")
}

// HalbEigene prüft die Sicherheitslinie für den Werksreset (halb.Eigene).
func (k Konfig) HalbEigene(ctx context.Context, mac, host, ausser string) (sp protokoll.Spur, nein, fall string) {
	var ptl halb.Portal
	if k.Portal != nil {
		ptl = k.Portal
	}
	return halb.Eigene(ctx, k.Spuren, ptl, mac, host, ausser)
}

func (k Konfig) jetzt() time.Time {
	if k.Jetzt != nil {
		return k.Jetzt()
	}
	return time.Now()
}

// portalURL ist das Portal ohne Schrägstrich am Ende.
func (k Konfig) portalURL() string {
	if k.PortalURL == "" {
		return "https://portal.voltpilot.de"
	}
	return strings.TrimRight(k.PortalURL, "/")
}

// Einstieg: wo das Gerät steht, wenn sein Lauf beginnt.
type Einstieg string

const (
	// AbWerk: unter der festen Adresse 192.168.1.17.
	AbWerk Einstieg = "werk"
	// HalbImLan: ein Gerät unter der Adresse des Anlagennetzes, das laut
	// Protokoll ein Lauf dieser Werkstatt begonnen und nicht fertig gemacht
	// hat. Sein Lauf hat nur den Schritt erkennen: Er prüft, ob es wirklich
	// dieses Gerät ist, und nennt dann den Werksreset. Angemeldet wird nie.
	HalbImLan Einstieg = "lan"
)

// Lauf ist der Zustand eines Geräts während seines Laufs. Passwörter und der
// Lauf-Schlüssel leben nur hier, im Speicher.
type Lauf struct {
	k        Konfig
	freigabe freigabe.Freigabe
	kennung  string
	dir      string
	log      *slog.Logger

	mac          string
	v            *box.Verbindung
	ziel         netip.AddrPort
	host         string // Fingerabdruck des Host-Schlüssels: gilt für den ganzen Lauf
	hostArt      string
	firmware     string
	reste        bool // /home/voltpilot eines früheren Laufs liegt auf dem Gerät im Werkszustand
	seriennummer string

	// laufSchluessel ist der Schlüssel nur dieses Laufs. Mit ihm meldet sich
	// der Dienst an, sobald die Anmeldung mit Passwort aus ist; am Ende
	// entfernt der Lauf ihn vom Gerät.
	laufSchluessel ssh.Signer
	laufZeile      string // seine Zeile in authorized_keys
	mitSchluessel  bool   // der Schlüssel liegt auf dem Gerät: Anmeldung mit ihm
	passwoerter    []geheim.Geheim
	passwortAge    string // die drei Passwörter, nur verschlüsselt
	notfallFP      string
	notfallFehler  error

	ref, version             string
	tunnelPub, tunnelAdresse string
	probeFenster             string
	serverPub, serverEP      string
	probeAutomatisch         bool
	dnsGesetzt               []string // DNS-Server, die dieser Lauf eingetragen hat

	pfadProgramm, pfadSkripte, pfadWartung string
	pfadManifest                           string
	stand                                  *fassungen.Stand
	nichtBereit                            string
	dr                                     *durchreiche.Server
	belege                                 map[string]string // Prüfung → wo ihr Beleg steht
}

// NeuerLauf legt den Zustand für ein Gerät an.
func NeuerLauf(k Konfig, f freigabe.Freigabe, kennung string) (*Lauf, error) {
	if f.BoxArt != freigabe.PFC200 {
		return nil, fmt.Errorf("Freigabe %s gilt für %q, nicht für den PFC200", f.Kennung, f.BoxArt)
	}
	if k.Zeiten == (Zeiten{}) {
		k.Zeiten = VorgabeZeiten
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(k.Arbeit, "lauf-"+kennung)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	l := &Lauf{k: k, freigabe: f, kennung: kennung, dir: dir, log: k.Log.With("request_id", kennung), belege: map[string]string{},
		laufSchluessel: signer,
		laufZeile:      strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))) + " voltpilot-werkstatt-lauf-" + kennung}
	// Ein Notfall-Schlüssel, den das Gerät nicht annähme, hält den Lauf im
	// Schritt erkennen an, bevor sich am Gerät etwas ändert.
	l.notfallFP, l.notfallFehler = NotfallPruefen(k.Notfall)
	return l, nil
}

// Schliesse räumt auf: Verbindung, Durchreiche, Arbeitsverzeichnis; die
// Passwörter werden vergessen (sie stehen nur noch verschlüsselt im Protokoll).
func (l *Lauf) Schliesse() {
	if l.dr != nil {
		l.dr.Schliesse()
	}
	l.v.Schliesse()
	for _, p := range l.passwoerter {
		p.Vergessen()
	}
	_ = os.RemoveAll(l.dir)
}

// MAC des Geräts, sobald erkannt.
func (l *Lauf) MAC() string { return l.mac }

// Schritte gibt die Folge für einen Einstieg zurück. Es gibt keinen Schritt
// für die SPS: Programm und Koppelprobe kommen mit CODESYS, nicht aus der
// Werkstatt.
func (l *Lauf) Schritte(e Einstieg) []lauf.Schritt {
	z := l.k.Zeiten
	if e == HalbImLan {
		return []lauf.Schritt{{Kennung: "erkennen", Titel: titelErkennenHalb, Frist: time.Minute, Tun: l.erkennenHalbImLan}}
	}
	return []lauf.Schritt{
		{Kennung: "erkennen", Titel: titelErkennen, Frist: 2*z.Verbinden + z.Schalter + time.Minute, Tun: l.erkennen},
		{Kennung: "docker", Titel: titelDocker, Frist: z.Verbinden + 2*time.Minute, Tun: l.dockerAusschalten},
		{Kennung: "fassungen", Titel: titelFassungen, Frist: 15 * time.Minute, Tun: l.fassungenHolen},
		{Kennung: "internet", Titel: titelInternet, Frist: z.Netz + 3*time.Minute, Tun: l.internetAn},
		{Kennung: "zugaenge", Titel: titelZugaenge, Frist: z.SSHDienst + 4*time.Minute, Tun: l.zugaengeSetzen},
		{Kennung: "notfall", Titel: titelNotfall, Frist: 2 * time.Minute, Tun: l.notfallSchluessel},
		{Kennung: "programm", Titel: titelProgramm, Frist: z.Programm + 10*time.Minute, Tun: l.programmEinspielen},
		{Kennung: "tunnel_schluessel", Titel: titelTunnelSchluessel, Frist: 5 * time.Minute, Tun: l.tunnelSchluessel},
		l.adressSchritt(),
		{Kennung: "tunnel", Titel: titelTunnel, Frist: z.Tunnel + 10*time.Minute, Tun: l.tunnelEinrichten},
		{Kennung: "netze", Titel: titelNetze, Frist: 2*z.Netz + 2*z.Firewall + 5*time.Minute, Tun: l.netzeStellen},
		{Kennung: "neustart", Titel: titelNeustart, Frist: z.Neustart + z.Tunnel + z.Schalter + 5*time.Minute, Tun: l.neustartProbe},
		{Kennung: "probe", Titel: titelProbe, Frist: 12 * time.Hour, Tun: l.probeImPortal},
		{Kennung: "internet_weg", Titel: titelInternetWeg, Frist: z.Netz + 3*time.Minute, Tun: l.internetWeg},
		{Kennung: "uebergabe", Titel: titelUebergabe, Frist: time.Minute, Tun: l.uebergabe},
	}
}

// ---- Hilfen ------------------------------------------------------------------

// einzig ist das eine Gerät am Werkstatt-Anschluss.
type einzig struct {
	Adresse netip.Addr
	MAC     string
}

// Einzeln prüft, dass am Werkstatt-Anschluss genau ein Gerät mit genau einer
// MAC antwortet, und gibt Adresse und MAC zurück.
func Einzeln(s werkbank.Status) (netip.Addr, string, error) {
	var e []einzig
	macs := map[string]bool{}
	for _, x := range s.Antworten {
		a, err := netip.ParseAddr(x.Adresse)
		if err != nil {
			continue
		}
		for _, m := range x.MACs {
			e = append(e, einzig{Adresse: a, MAC: m})
			macs[m] = true
		}
	}
	switch {
	case len(e) == 0:
		return netip.Addr{}, "", errors.New("am Werkstatt-Anschluss antwortet kein Gerät")
	case len(macs) > 1 || len(e) > 1:
		var t []string
		for _, x := range e {
			t = append(t, x.MAC+" unter "+x.Adresse.String())
		}
		return netip.Addr{}, "", lauf.Handgriff{Was: "Nur einen PFC200 an das orange Kabel WERKSTATT stecken, alles andere abziehen.", Fall: faelle.ZweiGeraete,
			Grund: "Am Werkstatt-Anschluss antworten mehrere Geräte: " + strings.Join(t, ", ")}
	}
	return e[0].Adresse, e[0].MAC, nil
}

func (l *Lauf) zielLan() netip.AddrPort { return netip.AddrPortFrom(l.k.LanNetz.Addr(), 22) }

// anmeldung sind die Verfahren, mit denen sich der Lauf gerade anmeldet: bis
// der Lauf-Schlüssel auf dem Gerät liegt mit dem Werkspasswort von root, danach
// nur noch mit dem Schlüssel.
func (l *Lauf) anmeldung() []ssh.AuthMethod {
	if l.mitSchluessel {
		return []ssh.AuthMethod{ssh.PublicKeys(l.laufSchluessel)}
	}
	return []ssh.AuthMethod{ssh.Password(werkRoot)}
}

// verbinde meldet sich an ziel an, mit Wiederholung bis frist. Eine Abweisung
// und ein fremder Host-Schlüssel enden sofort.
func (l *Lauf) verbinde(ctx context.Context, ziel netip.AddrPort, auth []ssh.AuthMethod, frist time.Duration) (*box.Verbindung, error) {
	var regel box.HostRegel
	if l.host != "" {
		regel = box.GenauDieser(l.host)
	}
	ende := time.Now().Add(frist)
	for {
		v, err := box.VerbindeMit(ctx, l.k.Werkbank, ziel, auth, regel, l.k.Zeiten.Verbinden)
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

// neuVerbinden ersetzt die Verbindung (nach einem Neustart des SSH-Dienstes,
// des Netzes oder des Geräts).
func (l *Lauf) neuVerbinden(ctx context.Context, ziel netip.AddrPort, frist time.Duration) error {
	l.v.Schliesse()
	l.v = nil
	v, err := l.verbinde(ctx, ziel, l.anmeldung(), frist)
	if err != nil {
		return err
	}
	l.v, l.ziel = v, ziel
	return nil
}

// fuehre führt einen Befehl auf dem Gerät aus und verlangt Ausgang 0.
func (l *Lauf) fuehre(ctx context.Context, befehl string, ein string) (box.Ergebnis, error) {
	if l.v == nil {
		return box.Ergebnis{}, errors.New("keine Verbindung zum Gerät")
	}
	var erg box.Ergebnis
	var err error
	if ein != "" {
		erg, err = l.v.Fuehre(ctx, befehl, strings.NewReader(ein))
	} else {
		erg, err = l.v.Fuehre(ctx, befehl, nil)
	}
	if err != nil {
		return erg, err
	}
	if erg.Code != 0 {
		return erg, fmt.Errorf("auf dem Gerät: %q endete mit %d: %s", kurz(befehl, 70), erg.Code, letzte(geheim.Schwaerze(erg.Text()), 4))
	}
	return erg, nil
}

// werte führt einen Befehl aus, der Zeilen name=wert ausgibt.
func (l *Lauf) werte(ctx context.Context, befehl string) (map[string]string, error) {
	erg, err := l.fuehre(ctx, befehl, "")
	if err != nil {
		return nil, err
	}
	m := map[string]string{}
	for _, z := range strings.Split(erg.Aus, "\n") {
		if k, w, ok := strings.Cut(strings.TrimSpace(z), "="); ok {
			m[k] = strings.TrimSpace(w)
		}
	}
	return m, nil
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

// losgeloest führt einen Befehl auf dem Gerät aus, der die eigene SSH-Sitzung
// beenden kann (der SSH-Dienst startet neu): Der Befehl läuft losgelöst von
// der Sitzung und legt Ausgabe und Ausgang unter /tmp ab. Danach meldet sich
// der Lauf neu an und liest das Ergebnis.
//
// Warum: Die Firmware beendet beim Neustart des SSH-Dienstes jede Sitzung
// (start-stop-daemon -K -x dropbear). Ein Befehl, der an der Sitzung hängt,
// kann mit ihr enden, bevor er den Dienst wieder gestartet hat; das Gerät
// hätte dann keinen SSH-Dienst mehr.
func (l *Lauf) losgeloest(ctx context.Context, name, befehl string, frist time.Duration) (string, error) {
	if err := l.starteLos(ctx, name, befehl); err != nil {
		return "", err
	}
	return l.ergebnisLos(ctx, name, frist)
}

func kurz(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
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

func orKeins(s string) string {
	if s == "" {
		return "keins"
	}
	return s
}

// shellWort setzt einen Wert in einfache Anführungszeichen.
func shellWort(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
