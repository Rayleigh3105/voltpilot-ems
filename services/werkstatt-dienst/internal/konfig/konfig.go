// Package konfig liest die Konfiguration des Werkstatt-Dienstes aus der
// Umgebung (ConfigMap) und die Schlüssel aus einem Verzeichnis (Secret). Die
// Tabelle aller Variablen steht in README.md.
package konfig

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

// Feste Adressen am Werkstatt-Anschluss: so meldet sich eine Mango ab Werk
// (GL-Werksfirmware, 192.168.8.1) und nach dem Aufspielen (OpenWrt,
// 192.168.1.1). Die Brücke hat dort je die .2.
var (
	WerksNetz   = netip.MustParsePrefix("192.168.8.0/24")
	OpenWrtNetz = netip.MustParsePrefix("192.168.1.0/24")
)

// Namen der Schlüsseldateien im Geheimnis-Verzeichnis.
const (
	DateiStatus        = "werkbank-status"
	DateiWeiterleitung = "werkbank-weiterleitung"
	DateiPflege        = "werkbank-pflege"
	DateiEinrichten    = "werkbank-einrichten"
	DateiDownloadToken = "download-token"
	DateiClientSecret  = "keycloak-client-secret"
)

var wgSchluessel = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)

// Konfig ist alles, was der Dienst wissen muss.
type Konfig struct {
	Daten         string // Verzeichnis für Protokolle und den Host-Schlüssel der Brücke (PVC)
	FreigabeDatei string
	HTTP          string // Betrieb: /health, /ready, /metrics
	Anzeige       string // Werkstatt-Anzeige, nur Loopback (kubectl port-forward)
	Takt          time.Duration
	LogFormat     string
	LanNetz       netip.Prefix // das LAN, auf das eine Box gestellt wird (Box-Adresse mit Länge)
	LanBruecke    netip.Addr   // die Adresse der Brücke im LAN-Netz
	Steuerung     string       // Unix-Socket für Eingaben (kubectl exec … eingabe)
	Arbeit        string       // Arbeitsverzeichnis der Läufe (emptyDir)

	// Für die Läufe an der Box (P3/P5); Pflicht erst für "dienst".
	PasswortEmpfaenger string        // öffentlicher age-Schlüssel „Box-Passwörter“ (WI-6 A)
	WartungPub         string        // öffentlicher Schlüssel des Wartungsservers (Portal)
	WartungEndpunkt    string        // leer: Vorgabe von service-tunnel.sh
	BoxNetz            netip.Prefix  // Tunnel-Adressen der Boxen
	DNS                []netip.Addr  // für das Werkstatt-Internet der Box
	Bauart             string        // Edge Light: mipsle
	DownloadToken      geheim.Geheim // Lese-Token für die Release-Anhänge (optional)

	// Die Portal-API (V1): leer heißt, die Freigabe kommt aus der Datei.
	APIURL       string
	TokenURL     string
	ClientID     string
	ClientSecret geheim.Geheim

	Werkbank werkbank.Konfig
}

// Netze des Wartungsservers (wie VP_TUNNEL_TECHNIKER_NETZ im Tunnel-Dienst).
var TechnikerNetz = netip.MustParsePrefix("10.10.32.0/24")

// PruefeFuerDienst prüft, was erst die Läufe an der Box brauchen.
func (k Konfig) PruefeFuerDienst() error {
	var f []string
	if k.PasswortEmpfaenger == "" {
		f = append(f, "VP_WERKSTATT_PASSWORT_EMPFAENGER fehlt (öffentlicher age-Schlüssel „Box-Passwörter“, age1…)")
	}
	if k.WartungPub == "" {
		f = append(f, "VP_WARTUNG_PUBKEY fehlt (öffentlicher Schlüssel des Wartungsservers aus dem Portal)")
	}
	if len(f) > 0 {
		return fmt.Errorf("Konfiguration: %s", strings.Join(f, "; "))
	}
	return nil
}

// Umgebung liest Variablen; in Tests ersetzbar.
type Umgebung func(string) string

func wert(env Umgebung, name, vorgabe string) string {
	if v := strings.TrimSpace(env(name)); v != "" {
		return v
	}
	return vorgabe
}

// Lies liest die Konfiguration. mitSchluesseln=false: ohne die Schlüssel der
// Brücke (pruefe-konfig auf einem Rechner ohne Secret).
func Lies(env Umgebung, mitSchluesseln bool) (Konfig, error) {
	var fehler []string
	add := func(err error) {
		if err != nil {
			fehler = append(fehler, err.Error())
		}
	}
	k := Konfig{
		Daten:              wert(env, "VP_WERKSTATT_DATEN", "/var/lib/vp-werkstatt-dienst"),
		FreigabeDatei:      wert(env, "VP_WERKSTATT_FREIGABE", "/etc/vp-werkstatt/freigabe/freigabe.json"),
		HTTP:               wert(env, "VP_WERKSTATT_HTTP", ":8100"),
		Anzeige:            wert(env, "VP_WERKSTATT_ANZEIGE", "127.0.0.1:8101"),
		LogFormat:          env("VOLTPILOT_LOGGING_FORMAT"),
		Steuerung:          wert(env, "VP_WERKSTATT_STEUERUNG", "/tmp/vp-werkstatt-dienst.sock"),
		Arbeit:             wert(env, "VP_WERKSTATT_ARBEIT", "/tmp/vp-werkstatt"),
		PasswortEmpfaenger: strings.TrimSpace(env("VP_WERKSTATT_PASSWORT_EMPFAENGER")),
		WartungPub:         strings.TrimSpace(env("VP_WARTUNG_PUBKEY")),
		WartungEndpunkt:    strings.TrimSpace(env("VP_WARTUNG_ENDPUNKT")),
		Bauart:             wert(env, "VP_WERKSTATT_EDGE_BAUART", "mipsle"),
		APIURL:             strings.TrimSpace(env("VP_WERKSTATT_API_URL")),
		TokenURL:           strings.TrimSpace(env("VP_WERKSTATT_TOKEN_URL")),
		ClientID:           wert(env, "VP_WERKSTATT_CLIENT_ID", "voltpilot-werkstatt-dienst"),
	}
	for name, u := range map[string]string{"VP_WERKSTATT_API_URL": k.APIURL, "VP_WERKSTATT_TOKEN_URL": k.TokenURL} {
		if u != "" && !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			add(fmt.Errorf("%s %q: eine http(s)-Adresse", name, u))
		}
	}
	if k.APIURL != "" && k.TokenURL == "" {
		add(errors.New("VP_WERKSTATT_TOKEN_URL fehlt (mit VP_WERKSTATT_API_URL liest der Dienst die Freigabe aus der API)"))
	}
	var err error
	k.Takt, err = dauer(env, "VP_WERKSTATT_TAKT", "10s", 2*time.Second, 5*time.Minute)
	add(err)
	add(nurLoopback(k.Anzeige))
	if _, _, err := net.SplitHostPort(k.HTTP); err != nil {
		add(fmt.Errorf("VP_WERKSTATT_HTTP %q: %v", k.HTTP, err))
	}

	k.BoxNetz, err = netip.ParsePrefix(wert(env, "VP_WARTUNG_BOX_NETZ", "10.10.16.0/20"))
	if err != nil || !k.BoxNetz.Addr().Is4() {
		add(fmt.Errorf("VP_WARTUNG_BOX_NETZ: ein IPv4-Netz wie 10.10.16.0/20"))
	}
	k.BoxNetz = k.BoxNetz.Masked()
	k.LanNetz, err = lanNetz(wert(env, "VP_WERKSTATT_LAN_NETZ", "10.213.0.1/24"), k.BoxNetz)
	add(err)
	if k.LanNetz.IsValid() {
		k.LanBruecke = lanBrueckeAdresse(k.LanNetz)
	}
	for _, t := range strings.Split(wert(env, "VP_WERKSTATT_DNS", "9.9.9.9,1.1.1.1"), ",") {
		a, err := netip.ParseAddr(strings.TrimSpace(t))
		if err != nil || !a.Is4() || a.IsPrivate() || a.IsLoopback() {
			add(fmt.Errorf("VP_WERKSTATT_DNS: %q ist keine öffentliche IPv4-Adresse", t))
			continue
		}
		k.DNS = append(k.DNS, a)
	}
	switch k.Bauart {
	case "mipsle", "arm64", "amd64":
	default:
		add(fmt.Errorf("VP_WERKSTATT_EDGE_BAUART %q: mipsle, arm64 oder amd64", k.Bauart))
	}
	if k.PasswortEmpfaenger != "" && !strings.HasPrefix(k.PasswortEmpfaenger, "age1") {
		add(fmt.Errorf("VP_WERKSTATT_PASSWORT_EMPFAENGER: ein öffentlicher age-Schlüssel (age1…)"))
	}
	if k.WartungPub != "" && !wgSchluessel.MatchString(k.WartungPub) {
		add(fmt.Errorf("VP_WARTUNG_PUBKEY: ein WireGuard-Schlüssel (44 Zeichen)"))
	}
	if strings.ContainsAny(k.WartungEndpunkt, " '\"$`;") {
		add(fmt.Errorf("VP_WARTUNG_ENDPUNKT: nur ein Name oder eine Adresse"))
	}

	w := werkbank.Konfig{
		Adresse:            env("VP_WERKBANK_ADRESSE"),
		HostSchluessel:     env("VP_WERKBANK_HOSTSCHLUESSEL"),
		HostDatei:          filepath.Join(k.Daten, "werkbank-hostschluessel.pub"),
		EinrichtenBenutzer: wert(env, "VP_WERKBANK_EINRICHTEN_BENUTZER", "vpwerkstatt"),
		Netz:               wert(env, "VP_WERKBANK_NETZ", "wlan0"),
		Werkstatt:          wert(env, "VP_WERKBANK_ANSCHLUSS", "eth0"),
	}
	if strings.TrimSpace(w.Adresse) == "" {
		add(errors.New("VP_WERKBANK_ADRESSE fehlt (Adresse der Werkbank-Brücke im Netz, feste Adresse im Router)"))
	}
	if w.HostSchluessel != "" && !strings.HasPrefix(w.HostSchluessel, "SHA256:") {
		add(fmt.Errorf("VP_WERKBANK_HOSTSCHLUESSEL %q: Form SHA256:… (ssh-keygen -lf)", w.HostSchluessel))
	}
	w.SSHQuellen, err = netze(wert(env, "VP_WERKBANK_SSH_QUELLEN", "192.168.178.241/32,192.168.178.242/32,192.168.178.243/32"))
	add(err)
	if k.LanNetz.IsValid() {
		w.WerkstattAdressen, w.Ziele = werkstattNetz(k.LanNetz)
	}
	if mitSchluesseln {
		dir := wert(env, "VP_WERKSTATT_GEHEIM", "/etc/vp-werkstatt/geheim")
		w.Status, err = schluessel(filepath.Join(dir, DateiStatus), true)
		add(err)
		w.Weiterleitung, err = schluessel(filepath.Join(dir, DateiWeiterleitung), true)
		add(err)
		w.Pflege, err = schluessel(filepath.Join(dir, DateiPflege), true)
		add(err)
		w.Einrichten, err = schluessel(filepath.Join(dir, DateiEinrichten), false)
		add(err)
		if b, err := os.ReadFile(filepath.Join(dir, DateiDownloadToken)); err == nil && len(strings.TrimSpace(string(b))) > 0 {
			k.DownloadToken = geheim.Neu(strings.TrimSpace(string(b)))
		}
		if k.APIURL != "" {
			if b, err := os.ReadFile(filepath.Join(dir, DateiClientSecret)); err == nil && len(strings.TrimSpace(string(b))) > 0 {
				k.ClientSecret = geheim.Neu(strings.TrimSpace(string(b)))
			} else {
				add(fmt.Errorf("%s fehlt im Geheimnis-Verzeichnis (Client-Secret von %s)", DateiClientSecret, k.ClientID))
			}
		}
		if p := env("VP_WERKSTATT_NOTFALL_PUB"); p != "" {
			b, err := os.ReadFile(p)
			if err != nil {
				add(fmt.Errorf("VP_WERKSTATT_NOTFALL_PUB: %v", err))
			} else if _, _, _, _, err := ssh.ParseAuthorizedKey(b); err != nil {
				add(fmt.Errorf("VP_WERKSTATT_NOTFALL_PUB %s: kein öffentlicher Schlüssel: %v", p, err))
			} else {
				w.Notfall = strings.TrimSpace(string(b))
			}
		} else {
			add(errors.New("VP_WERKSTATT_NOTFALL_PUB fehlt (öffentlicher Notfall-Schlüssel)"))
		}
	}
	k.Werkbank = w
	if len(fehler) > 0 {
		return k, fmt.Errorf("Konfiguration: %s", strings.Join(fehler, "; "))
	}
	return k, nil
}

// werkstattNetz leitet aus dem LAN-Netz die Adressen der Brücke und die
// Ziele der Weiterleitung ab: Werks- und OpenWrt-Netz der Mango, dazu das
// LAN, auf das der Dienst die Box stellt (Ports 22 und 80 bzw. 22 und 8484).
// lanBrueckeAdresse: die Brücke nimmt im LAN-Netz die .2 (die .3, wenn die
// Box selbst die .2 ist).
func lanBrueckeAdresse(lan netip.Prefix) netip.Addr {
	b := lan.Addr().As4()
	if b[3] == 2 {
		b[3] = 3
	} else {
		b[3] = 2
	}
	return netip.AddrFrom4(b)
}

func werkstattNetz(lan netip.Prefix) ([]netip.Prefix, []netip.AddrPort) {
	box := lan.Addr()
	bruecke := lanBrueckeAdresse(lan)
	adressen := []netip.Prefix{
		netip.PrefixFrom(netip.MustParseAddr("192.168.8.2"), 24),
		netip.PrefixFrom(netip.MustParseAddr("192.168.1.2"), 24),
		netip.PrefixFrom(bruecke, 24),
	}
	werks, openwrt := netip.MustParseAddr("192.168.8.1"), netip.MustParseAddr("192.168.1.1")
	ziele := []netip.AddrPort{
		netip.AddrPortFrom(werks, 22), netip.AddrPortFrom(werks, 80),
		netip.AddrPortFrom(openwrt, 22), netip.AddrPortFrom(openwrt, 80),
		netip.AddrPortFrom(box, 22), netip.AddrPortFrom(box, 8484),
	}
	return adressen, ziele
}

// UeblicheNetze: Netze, die Heimrouter ab Werk verteilen (wie UEBLICH in
// LanNetz.java, Entscheid 6a).
var UeblicheNetze = []netip.Prefix{
	netip.MustParsePrefix("192.168.0.0/24"), netip.MustParsePrefix("192.168.1.0/24"),
	netip.MustParsePrefix("192.168.2.0/24"), netip.MustParsePrefix("192.168.8.0/24"),
	netip.MustParsePrefix("192.168.178.0/24"), netip.MustParsePrefix("10.0.0.0/24"),
}

// lanNetz prüft das LAN-Netz wie LanNetz.java (privat, Host-Adresse, kein
// übliches Heimnetz, nicht in den Netzen des Wartungsservers), dazu enger:
// genau /24, weil die Brücke dort eine Adresse braucht.
func lanNetz(s string, boxNetz netip.Prefix) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(s)
	if err != nil || !p.Addr().Is4() || p.Bits() != 24 || !p.Addr().IsPrivate() {
		return netip.Prefix{}, fmt.Errorf("VP_WERKSTATT_LAN_NETZ %q: Box-Adresse mit /24 in einem privaten Netz, etwa 10.213.0.1/24", s)
	}
	if p.Masked() == WerksNetz || p.Masked() == OpenWrtNetz {
		return netip.Prefix{}, fmt.Errorf("VP_WERKSTATT_LAN_NETZ %q: das Netz gehört schon der Mango ab Werk bzw. frisch nach OpenWrt", s)
	}
	if b := p.Addr().As4(); b[3] == 0 || b[3] == 255 {
		return netip.Prefix{}, fmt.Errorf("VP_WERKSTATT_LAN_NETZ %q: die Box-Adresse ist keine Host-Adresse", s)
	}
	for _, u := range UeblicheNetze {
		if u.Overlaps(p) {
			return netip.Prefix{}, fmt.Errorf("VP_WERKSTATT_LAN_NETZ %q: %s verteilen Heimrouter ab Werk (Entscheid 6a)", s, u)
		}
	}
	for _, w := range []netip.Prefix{boxNetz, TechnikerNetz} {
		if w.IsValid() && w.Overlaps(p) {
			return netip.Prefix{}, fmt.Errorf("VP_WERKSTATT_LAN_NETZ %q: überschneidet sich mit dem Netz %s des Wartungsservers", s, w)
		}
	}
	return p, nil
}

func netze(s string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, t := range strings.Split(s, ",") {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if !strings.Contains(t, "/") {
			t += "/32"
		}
		p, err := netip.ParsePrefix(t)
		if err != nil || !p.Addr().Is4() || p.Bits() < 16 {
			return nil, fmt.Errorf("VP_WERKBANK_SSH_QUELLEN: %q ist keine IPv4-Adresse oder kein Netz bis /16", t)
		}
		out = append(out, p.Masked())
	}
	if len(out) == 0 {
		return nil, errors.New("VP_WERKBANK_SSH_QUELLEN ist leer")
	}
	return out, nil
}

func nurLoopback(adr string) error {
	h, _, err := net.SplitHostPort(adr)
	if err != nil {
		return fmt.Errorf("VP_WERKSTATT_ANZEIGE %q: %v", adr, err)
	}
	a, err := netip.ParseAddr(h)
	if err != nil || !a.IsLoopback() {
		return fmt.Errorf("VP_WERKSTATT_ANZEIGE %q: nur eine Loopback-Adresse (die Anzeige hat keine Anmeldung, erreichbar nur über kubectl port-forward)", adr)
	}
	return nil
}

func dauer(env Umgebung, name, vorgabe string, min, max time.Duration) (time.Duration, error) {
	d, err := time.ParseDuration(wert(env, name, vorgabe))
	if err != nil || d < min || d > max {
		return 0, fmt.Errorf("%s: eine Dauer von %s bis %s", name, min, max)
	}
	return d, nil
}

// schluessel liest einen privaten Schlüssel. Sein Inhalt kommt in den
// Schwärzer: Er steht in keiner Log-Zeile, selbst wenn ihn etwas zitiert.
func schluessel(pfad string, pflicht bool) (ssh.Signer, error) {
	b, err := os.ReadFile(pfad)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && !pflicht {
			return nil, nil
		}
		return nil, fmt.Errorf("Schlüssel %s: %v", filepath.Base(pfad), err)
	}
	g := geheim.Neu(string(b))
	s, err := ssh.ParsePrivateKey([]byte(g.Offenbaren()))
	if err != nil {
		return nil, fmt.Errorf("Schlüssel %s ist kein privater SSH-Schlüssel ohne Passphrase", filepath.Base(pfad))
	}
	return s, nil
}
