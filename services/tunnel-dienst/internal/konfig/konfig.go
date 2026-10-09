// Package konfig liest die Konfiguration aus der Umgebung (systemd
// EnvironmentFile=/etc/vp-tunnel-dienst/tunnel-dienst.env). Das
// Client-Secret kommt aus einer Datei, bevorzugt über systemd LoadCredential.
package konfig

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Konfig ist alles, was der Dienst wissen muss.
type Konfig struct {
	APIURL       string
	TokenURL     string
	ClientID     string
	ClientSecret string

	Schnittstelle string
	Tabelle       string
	BoxNetz       netip.Prefix
	TechnikerNetz netip.Prefix
	Ports         []int

	Intervall    time.Duration
	MaxFenster   time.Duration
	MaxEntfernen int
	Zustand      string // Verzeichnis für letzter-soll.json und status.json

	VerbindungenProtokollieren bool

	// SchluesselPort: TCP-Port der Schlüsselausgabe auf der Server-Adresse im
	// Techniker-Netz. 0 heißt abgeschaltet: kein Schalter, keine Regel in der
	// Firewall-Basis.
	SchluesselPort int
}

// Umgebung liest Variablen; in Tests ersetzbar.
type Umgebung func(string) string

// Lies liest die Konfiguration. ohneAPI: für Befehle, die die API nicht
// brauchen (basis, status).
func Lies(env Umgebung, ohneAPI bool) (Konfig, error) {
	k := Konfig{
		APIURL:        env("VP_TUNNEL_API_URL"),
		TokenURL:      env("VP_TUNNEL_TOKEN_URL"),
		ClientID:      wert(env, "VP_TUNNEL_CLIENT_ID", "voltpilot-tunnel-dienst"),
		Schnittstelle: wert(env, "VP_TUNNEL_SCHNITTSTELLE", "wg-wartung"),
		Tabelle:       wert(env, "VP_TUNNEL_NFT_TABELLE", "voltpilot_wartung"),
		Zustand:       wert(env, "VP_TUNNEL_ZUSTAND", wert(env, "STATE_DIRECTORY", "/var/lib/vp-tunnel-dienst")),
	}
	var fehler []string
	add := func(err error) {
		if err != nil {
			fehler = append(fehler, err.Error())
		}
	}
	var err error
	k.BoxNetz, err = netz(env, "VP_TUNNEL_BOX_NETZ", "10.10.16.0/20")
	add(err)
	k.TechnikerNetz, err = netz(env, "VP_TUNNEL_TECHNIKER_NETZ", "10.10.32.0/24")
	add(err)
	if err == nil && k.BoxNetz.IsValid() && k.BoxNetz.Overlaps(k.TechnikerNetz) {
		fehler = append(fehler, "VP_TUNNEL_BOX_NETZ und VP_TUNNEL_TECHNIKER_NETZ überschneiden sich")
	}
	k.Ports, err = ports(wert(env, "VP_TUNNEL_PORTS", "2222,8484"))
	add(err)
	k.Intervall, err = dauer(env, "VP_TUNNEL_INTERVALL", "30s", 5*time.Second, time.Hour)
	add(err)
	k.MaxFenster, err = dauer(env, "VP_TUNNEL_MAX_FENSTER", "24h", time.Minute, 7*24*time.Hour)
	add(err)
	k.MaxEntfernen, err = zahl(env, "VP_TUNNEL_MAX_ENTFERNEN", "10")
	add(err)
	k.VerbindungenProtokollieren = wert(env, "VP_TUNNEL_VERBINDUNGEN_PROTOKOLLIEREN", "ja") != "nein"
	k.SchluesselPort, err = schluesselPort(wert(env, "VP_TUNNEL_SCHLUESSEL_PORT", ""))
	add(err)
	if !gueltigerName(k.Schnittstelle) || len(k.Schnittstelle) > 15 || !gueltigerName(k.Tabelle) {
		fehler = append(fehler, "VP_TUNNEL_SCHNITTSTELLE (höchstens 15 Zeichen)/VP_TUNNEL_NFT_TABELLE: nur Buchstaben, Ziffern, - und _")
	}
	if !ohneAPI {
		if k.APIURL == "" || k.TokenURL == "" {
			fehler = append(fehler, "VP_TUNNEL_API_URL und VP_TUNNEL_TOKEN_URL sind Pflicht")
		}
		secret, err := clientSecret(env)
		add(err)
		k.ClientSecret = secret
	}
	if len(fehler) > 0 {
		return Konfig{}, errors.New("Konfiguration: " + strings.Join(fehler, "; "))
	}
	return k, nil
}

func wert(env Umgebung, name, vorgabe string) string {
	if v := strings.TrimSpace(env(name)); v != "" {
		return v
	}
	return vorgabe
}

func netz(env Umgebung, name, vorgabe string) (netip.Prefix, error) {
	p, err := netip.ParsePrefix(wert(env, name, vorgabe))
	if err != nil || !p.Addr().Is4() || p != p.Masked() || p.Bits() < 8 || p.Bits() > 30 {
		return netip.Prefix{}, fmt.Errorf("%s: kein IPv4-Netz in CIDR-Schreibweise (/8 bis /30)", name)
	}
	return p, nil
}

func ports(text string) ([]int, error) {
	var liste []int
	for _, t := range strings.Split(text, ",") {
		p, err := strconv.Atoi(strings.TrimSpace(t))
		if err != nil || p < 1 || p > 65535 {
			return nil, fmt.Errorf("VP_TUNNEL_PORTS: %q ist kein Port", t)
		}
		liste = append(liste, p)
	}
	return liste, nil
}

// schluesselPort: leer heißt abgeschaltet. Unter 1024 bräuchte der Schalter
// ein Recht, das er gerade nicht haben soll.
func schluesselPort(text string) (int, error) {
	if text == "" {
		return 0, nil
	}
	p, err := strconv.Atoi(text)
	if err != nil || p < 1024 || p > 65535 {
		return 0, errors.New("VP_TUNNEL_SCHLUESSEL_PORT: Port zwischen 1024 und 65535 erwartet (leer: Schlüsselausgabe aus)")
	}
	return p, nil
}

func dauer(env Umgebung, name, vorgabe string, min, max time.Duration) (time.Duration, error) {
	d, err := time.ParseDuration(wert(env, name, vorgabe))
	if err != nil || d < min || d > max {
		return 0, fmt.Errorf("%s: Dauer zwischen %s und %s erwartet", name, min, max)
	}
	return d, nil
}

func zahl(env Umgebung, name, vorgabe string) (int, error) {
	n, err := strconv.Atoi(wert(env, name, vorgabe))
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s: nichtnegative Zahl erwartet", name)
	}
	return n, nil
}

func gueltigerName(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

// clientSecret: VP_TUNNEL_CLIENT_SECRET_FILE, sonst die systemd-Credential
// "client-secret". Nie aus einer Umgebungsvariablen direkt: die stünde in
// /proc/<pid>/environ und in jedem `systemctl show`.
func clientSecret(env Umgebung) (string, error) {
	pfad := env("VP_TUNNEL_CLIENT_SECRET_FILE")
	if pfad == "" {
		if dir := env("CREDENTIALS_DIRECTORY"); dir != "" {
			pfad = filepath.Join(dir, "client-secret")
		}
	}
	if pfad == "" {
		return "", errors.New("Client-Secret fehlt: VP_TUNNEL_CLIENT_SECRET_FILE oder systemd LoadCredential=client-secret:…")
	}
	daten, err := os.ReadFile(pfad)
	if err != nil {
		return "", fmt.Errorf("Client-Secret lesen: %w", err)
	}
	s := strings.TrimSpace(string(daten))
	if s == "" {
		return "", errors.New("Client-Secret-Datei ist leer")
	}
	return s, nil
}
