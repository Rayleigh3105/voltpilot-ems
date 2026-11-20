package pfc200

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/durchreiche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/referenz"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/wartung"
)

// Pfade auf dem Gerät (edge-industrie/install.sh und wartung.sh legen sie an).
const (
	geraetHeim     = "/home/voltpilot"
	geraetKonfig   = "/home/voltpilot/konfig"
	geraetRef      = "/home/voltpilot/daten/ref"
	dienstEdge     = "/etc/init.d/vp-edge-industrie"
	dienstWartung  = "/etc/init.d/vp-wartung"
	tunnelProgramm = "/home/voltpilot/wartung/vp-wartung"
)

// ---- Edge Industrie ---------------------------------------------------------------

// skripte packt den Skriptstand der Freigabe aus, legt Programm und
// Tunnel-Programm daneben (dort suchen install.sh und wartung.sh sie) und
// startet die Durchreiche: Die Skripte rufen „ssh <ziel> <befehl>“, und der
// Befehl läuft über die Verbindung dieses Laufs.
func (l *Lauf) skripte() (*durchreiche.Server, string, error) {
	basis := filepath.Join(l.dir, "s")
	wurzel := filepath.Join(basis, fassungen.IndustrieWurzel)
	if l.dr == nil {
		if err := fassungen.AuspackenPFC200(l.pfadSkripte, basis); err != nil {
			return nil, "", err
		}
		dist := filepath.Join(wurzel, "dist")
		if err := os.MkdirAll(dist, 0o755); err != nil {
			return nil, "", err
		}
		for name, pfad := range map[string]string{fassungen.IndustrieProgramm: l.pfadProgramm, fassungen.WartungProgramm: l.pfadWartung} {
			inhalt, err := os.ReadFile(pfad)
			if err != nil {
				return nil, "", err
			}
			if err := os.WriteFile(filepath.Join(dist, name), inhalt, 0o755); err != nil {
				return nil, "", err
			}
		}
		dr, err := durchreiche.Starte(filepath.Join(l.dir, "d"), func() *ssh.Client {
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
	return l.dr, wurzel, nil
}

// skript führt ein Skript des Release-Stands gegen das Gerät aus.
func (l *Lauf) skript(ctx context.Context, name string, args []string, env ...string) (durchreiche.Lauf, error) {
	dr, dir, err := l.skripte()
	if err != nil {
		return durchreiche.Lauf{}, err
	}
	env = append([]string{"VP_INDUSTRIE_ARCH=" + Bauart}, env...)
	return dr.FuehreSkript(ctx, filepath.Join(dir, name), append([]string{"root@" + l.ziel.Addr().String()}, args...), env)
}

// vertrauensSet lädt trust-set.json und .sig offen aus dem Portal in das
// Verzeichnis des Laufs (das Bild des Dienstes hat kein curl; install.sh legt
// die Dateien auf das Gerät, das Programm prüft sie gegen seine Wurzel).
func (l *Lauf) vertrauensSet(ctx context.Context) (string, error) {
	set, sig, err := l.k.Fassungen.HoleVertrauensSet(ctx, l.k.portalURL())
	if errors.Is(err, fassungen.ErrNichtSigniert) {
		return "", errors.New("das Portal " + l.k.portalURL() + " liefert kein Vertrauens-Set")
	}
	if err != nil {
		return "", err
	}
	dir := filepath.Join(l.dir, "trust-set")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "trust-set.json"), set, 0o644); err != nil {
		return "", err
	}
	return dir, os.WriteFile(filepath.Join(dir, "trust-set.json.sig"), sig, 0o644)
}

func (l *Lauf) programmEinspielen(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	f := l.freigabe.EdgeIndustrie
	if summe, err := fassungen.Summe(l.pfadProgramm); err != nil || summe != f.ProgrammSha256 {
		return nil, errors.New("Programm im Zwischenspeicher hat nicht die Prüfsumme der Freigabe")
	}
	dir, err := l.vertrauensSet(ctx)
	if err != nil {
		return nil, err
	}
	env := []string{"VP_TRUST_SET_DIR=" + dir, "VP_PORTAL_URL=" + l.k.portalURL()}
	if l.pfadManifest != "" {
		env = append(env, "VP_INDUSTRIE_MANIFEST="+l.pfadManifest)
	}
	b := protokoll.Beleg{}
	if l.reste {
		// Nur auf einem Gerät im Werkszustand (Schritt erkennen), und nur
		// dieser eine feste Ort: Daten, Fassung und Tunnel eines früheren Laufs.
		if _, err := l.fuehre(ctx, "rm -rf "+geraetHeim+" && sync", ""); err != nil {
			return b, fmt.Errorf("Reste eines früheren Laufs entfernen: %w", err)
		}
		b = b.Mit("reste", geraetHeim+" entfernt: Die Box bekommt eine neue Referenz und einen neuen Geräteschlüssel")
		l.reste = false
	}
	r, err := l.skript(ctx, "install.sh", nil, env...)
	if err != nil {
		return b, err
	}
	b = b.Mit("install", zeilenMit(r.Ausgabe, "Pruefsumme", "FEHLER", "fehlt:", "fertig"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "Pruefsumme auf dem Geraet bestaetigt") {
		return b, fmt.Errorf("install.sh endete mit %d: %s", r.Code, letzte(r.Ausgabe, 4))
	}
	// Das Portal des Dienstes gilt auch für das Gerät (in der Probe ein anderes
	// als das der Vorgabe).
	if l.k.PortalURL != "" {
		if _, err := l.fuehre(ctx, konfigSetzen("portal_url", l.k.portalURL()), ""); err != nil {
			return b, err
		}
	}
	if _, err := l.fuehre(ctx, dienstEdge+" restart >/dev/null 2>&1 </dev/null", ""); err != nil {
		return b, err
	}
	var h mango.Health
	err = l.warteAuf(ctx, l.k.Zeiten.Programm, func() error {
		erg, err := l.v.Fuehre(ctx, mango.BefehlHealth, nil)
		if err != nil {
			return err
		}
		var ok bool
		if h, ok = mango.LiesHealth(erg.Aus); !ok {
			return errors.New("/health nennt noch keine Referenz")
		}
		return nil
	})
	if err != nil {
		return b, err
	}
	b = b.Mit("health", fmt.Sprintf("ref %s, version %s", h.Ref, h.Version))
	if !referenz.Gueltig(h.Ref) {
		return b, fmt.Errorf("Referenz %q hat kein gültiges Prüfzeichen", h.Ref)
	}
	if h.Version != f.Fassung {
		return b, fmt.Errorf("%s meldet %q, die Freigabe nennt %s", Name, h.Version, f.Fassung)
	}
	l.ref, l.version = h.Ref, h.Version
	if k != nil && k.Lauf != nil {
		k.Box(h.Ref)
	}
	b = b.Mit("referenz", h.Ref+" (Prüfzeichen gültig)")
	if l.nichtBereit == "" {
		l.nichtBereit = mango.UpdateBereitFuer(h, l.stand, fassungen.BackendsPFC200...)
	}
	if l.nichtBereit != "" {
		delete(l.belege, "update_bereit")
		return b.Mit("update_bereit", "nein - "+l.nichtBereit), nil
	}
	l.belege["update_bereit"] = fmt.Sprintf("Schritt programm: Update-Linie %s, Vertrauens-Set geprüft (Schlüssel %s, signiert von %s), bestätigte Fassung %s Stand %d aus dem signierten Manifest",
		h.Update.Backend, strings.Join(h.Update.Trust.TrustSetKeyIDs, ", "), h.Update.Trust.TrustSetSignedBy, h.Version, l.stand.ReleaseSeq)
	return b.Mit("update_bereit", "ja"), nil
}

// konfigSetzen setzt eine Angabe in den Einstellungen der Box
// (/home/voltpilot/konfig, Zeilen „name = wert“; die Datei gehört root).
func konfigSetzen(name, wert string) string {
	zeile := shellWort(name + " = " + wert)
	return `K=` + geraetKonfig + `
{ grep -v '^[[:space:]]*` + name + `[[:space:]]*=' "$K"; echo ` + zeile + `; } > "$K.neu" && chown root:root "$K.neu" && chmod 0644 "$K.neu" && mv -f "$K.neu" "$K" && sync`
}

// ---- Tunnel -----------------------------------------------------------------------

var pubMuster = regexp.MustCompile(`^[A-Za-z0-9+/]{43}=$`)

func (l *Lauf) tunnelSchluessel(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	if summe, err := fassungen.Summe(l.pfadWartung); err != nil || summe != l.freigabe.EdgeIndustrie.WartungSha256 {
		return nil, errors.New("Tunnel-Programm im Zwischenspeicher hat nicht die Prüfsumme der Freigabe")
	}
	r, err := l.skript(ctx, "wartung.sh", []string{"key"})
	if err != nil {
		return nil, err
	}
	if r.Code != 0 {
		return nil, fmt.Errorf("wartung.sh key endete mit %d: %s", r.Code, letzte(r.Ausgabe, 4))
	}
	z := strings.Split(r.Ausgabe, "\n")
	pub, ref := "", ""
	for i, s := range z {
		if strings.HasPrefix(s, "oeffentlicher Schluessel des Geraets:") && i+1 < len(z) {
			pub = strings.TrimSpace(z[i+1])
		}
		if v, ok := strings.CutPrefix(s, "Box-Referenz: "); ok {
			ref = strings.TrimSpace(v)
		}
	}
	b := protokoll.Beleg{}.Mit("tunnel_schluessel", pub).Mit("referenz", ref)
	if !pubMuster.MatchString(pub) {
		return b, fmt.Errorf("kein öffentlicher WireGuard-Schlüssel in der Ausgabe: %s", letzte(r.Ausgabe, 4))
	}
	if ref != l.ref {
		return b, fmt.Errorf("Box-Referenz %q, /health nannte %s", ref, l.ref)
	}
	l.tunnelPub = pub
	return b, nil
}

// adressSchritt: mit der API löst die Box selbst einen Einmal-Code ein und
// bekommt dabei ihre Adresse; ohne sie trägt der Betreiber die Adresse aus dem
// Portal ein.
func (l *Lauf) adressSchritt() lauf.Schritt {
	if l.k.Portal != nil {
		return lauf.Schritt{Kennung: "einloesen", Titel: titelEinloesen, Frist: 5 * time.Minute, Tun: l.einloesen}
	}
	return lauf.Schritt{Kennung: "tunnel_adresse", Titel: titelTunnelAdresse, Frist: 12 * time.Hour, Tun: l.tunnelAdresseHolen}
}

// Rückgabewerte von werkstatt-anmelden (edge-app/core/internal/werkstatt).
const (
	anmeldenAbgewiesen   = 3
	anmeldenUnerreichbar = 4
)

// anmeldenBefehl ruft werkstatt-anmelden des Programms auf, als der Benutzer
// der Box (ihm gehört das Datenverzeichnis mit dem Geräteschlüssel) und mit
// den Pfaden aus ihren Einstellungen, wie der Loader. Der Code kommt über die
// Standardeingabe und steht nie im Befehl.
func anmeldenBefehl(wgPub, host string) string {
	return `K=` + geraetKonfig + `
kw() { w="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$K" 2>/dev/null | sed 's/[[:space:]]*$//' | tail -n 1)"; echo "${w:-$2}"; }
D="$(kw data_dir /home/voltpilot/daten)"
R="$(kw ram_dir /tmp/vp-edge-industrie)"
P="$(kw programm_dir "$R")"
U="$(kw portal_url https://portal.voltpilot.de)"
B="$(kw benutzer voltpilot)"
exec su -s /bin/sh "$B" -c "exec '$P/vp-edge-industrie' werkstatt-anmelden --daten '$D' --portal '$U' --wireguard '` + wgPub + `' --host-schluessel '` + host + `'"`
}

// einloesung ist der Teil der Antwort, den der Lauf braucht
// (docs/contracts/werkstatt-einloesen-v1.md, Antwort).
type einloesung struct {
	Schema         string `json:"schema"`
	EdgeRef        string `json:"edgeRef"`
	TunnelErgebnis string `json:"tunnelErgebnis"`
	Tunnel         struct {
		Adresse         string `json:"adresse"`
		ServerPublicKey string `json:"serverPublicKey"`
		ServerEndpunkt  string `json:"serverEndpunkt"`
		ServerPort      int    `json:"serverPort"`
	} `json:"tunnel"`
	Probe struct {
		FensterID     string    `json:"fensterId"`
		TechnikerName string    `json:"technikerName"`
		Ende          time.Time `json:"ende"`
	} `json:"probe"`
	GeraeteSchluessel struct {
		Sha256 string `json:"sha256"`
	} `json:"geraeteSchluessel"`
}

// einloesen: Code holen (nur in der laufenden Freigabe), die Box löst ihn mit
// ihrem Geräteschlüssel selbst ein. Die API hält dabei den Geräteschlüssel
// fest, hinterlegt den Tunnel-Schlüssel und öffnet das Probe-Fenster. Der
// Code steht in keinem Beleg und keinem Log.
func (l *Lauf) einloesen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	if !pubMuster.MatchString(l.tunnelPub) || l.host == "" {
		return nil, errors.New("Tunnel-Schlüssel oder Host-Schlüssel fehlen (Schritte tunnel_schluessel, erkennen)")
	}
	c, err := l.k.Portal.CodeHolen(ctx, l.ref, false)
	if err != nil {
		return nil, fmt.Errorf("Einmal-Code: %w", err)
	}
	defer c.Code.Vergessen()
	b := protokoll.Beleg{}.Mit("code", "für "+c.EdgeRef+" ausgegeben, gilt bis "+c.GueltigBis.UTC().Format(time.RFC3339)+" (steht in keinem Beleg)").
		Mit("freigabe", c.Freigabe)
	erg, err := l.v.Fuehre(ctx, anmeldenBefehl(l.tunnelPub, l.host), strings.NewReader(c.Code.Offenbaren()+"\n"))
	if err != nil {
		return b, err
	}
	switch erg.Code {
	case 0:
	case anmeldenAbgewiesen:
		return b.Mit("abgewiesen", geheim.Schwaerze(letzte(erg.Fehl, 4))), fmt.Errorf("das Portal hat die Einlösung abgewiesen: %s", geheim.Schwaerze(letzte(erg.Fehl, 2)))
	case anmeldenUnerreichbar:
		return b, fmt.Errorf("die Box erreicht das Portal nicht: %s", geheim.Schwaerze(letzte(erg.Fehl, 2)))
	default:
		return b, fmt.Errorf("werkstatt-anmelden endete mit %d: %s", erg.Code, geheim.Schwaerze(letzte(erg.Text(), 4)))
	}
	var e einloesung
	if err := json.Unmarshal([]byte(strings.TrimSpace(erg.Aus)), &e); err != nil {
		return b, fmt.Errorf("Antwort von werkstatt-anmelden ist kein JSON: %v", err)
	}
	if e.Schema != "vp-werkstatt-einloesung.v1" || e.EdgeRef != l.ref {
		return b, fmt.Errorf("Antwort passt nicht zur Box (Schema %q, Kennung %q)", e.Schema, e.EdgeRef)
	}
	a, err := mango.PruefeTunnelAdresse(e.Tunnel.Adresse, l.k.BoxNetz)
	if err != nil {
		return b, fmt.Errorf("Adresse aus der Einlösung: %w", err)
	}
	if e.Tunnel.ServerPublicKey != "" && l.k.WartungPub != "" && e.Tunnel.ServerPublicKey != l.k.WartungPub {
		return b, errors.New("das Portal nennt einen anderen Schlüssel des Wartungsservers als die Konfiguration des Dienstes")
	}
	if e.Probe.FensterID == "" {
		return b, errors.New("die Einlösung nennt kein Probe-Fenster")
	}
	l.tunnelAdresse = a.String()
	l.probeFenster = e.Probe.FensterID
	l.serverPub, l.serverEP = l.k.WartungPub, l.k.WartungEP
	if e.Tunnel.ServerPublicKey != "" {
		l.serverPub = e.Tunnel.ServerPublicKey
	}
	if e.Tunnel.ServerEndpunkt != "" && e.Tunnel.ServerPort > 0 {
		l.serverEP = net.JoinHostPort(e.Tunnel.ServerEndpunkt, strconv.Itoa(e.Tunnel.ServerPort))
	}
	return b.Mit("tunnel_ergebnis", e.TunnelErgebnis).
		Mit("tunnel_adresse", a.String()).
		Mit("probe_fenster", e.Probe.FensterID+" für "+e.Probe.TechnikerName+" bis "+e.Probe.Ende.UTC().Format(time.RFC3339)).
		Mit("geraete_schluessel", "festgehalten, sha256 "+e.GeraeteSchluessel.Sha256), nil
}

func (l *Lauf) tunnelAdresseHolen(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	for {
		w, err := k.Warte(ctx, "tunnel_adresse", HinweisTunnel(l.ref, l.tunnelPub))
		if err != nil {
			return nil, err
		}
		a, err := mango.PruefeTunnelAdresse(w, l.k.BoxNetz)
		if err != nil {
			k.Log.Warn("Eingabe abgelehnt", "grund", err)
			continue
		}
		l.tunnelAdresse = a.String()
		return protokoll.Beleg{}.Mit("tunnel_adresse", a.String()).Mit("herkunft", "Portal, Tunnel-Schlüssel hinterlegt (eingetragen vom Betreiber)"), nil
	}
}

// tunnelStand liest „vp-wartung status werte“ und prüft: Das Programm läuft
// mit der Adresse der Box, der Handshake ist frisch, SSH 2222 gibt es nur im
// Tunnel, der Wartungsserver gibt Schlüssel aus, und dauerhaft gelten genau
// so viele Schlüssel wie erwartet (im Lauf zwei: Notfall und Lauf; am Ende einer).
func (l *Lauf) tunnelStand(ctx context.Context, dauerhaft int) (protokoll.Beleg, error) {
	w, err := l.werte(ctx, tunnelProgramm+` status werte 2>&1
echo "lauscht_2222=$(netstat -ltn 2>/dev/null | grep -c ':2222 ')"`)
	if err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("laeuft", w["laeuft"]).Mit("adresse", w["adresse"]).Mit("handshake", "vor "+w["handshake_vor"]+" s").
		Mit("ssh_2222", w["ssh_2222"]+", an den Netzbuchsen lauscht Port 2222: "+orNull(w["lauscht_2222"])+" mal").
		Mit("abholer", "letzte gültige Antwort des Wartungsservers vor "+w["antwort_vor"]+" s").
		Mit("dauerhaft", w["dauerhaft"]+" Schlüssel, mit Optionen "+orNull(w["dauerhaft_mit_optionen"])).
		Mit("host_schluessel_tunnel", w["host_schluessel"])
	var f []string
	hs, errH := strconv.Atoi(w["handshake_vor"])
	an, errA := strconv.Atoi(w["antwort_vor"])
	switch {
	case w["laeuft"] != "ja":
		f = append(f, "das Tunnel-Programm läuft nicht ("+orKeins(w["grund"])+")")
	case w["adresse"] != l.tunnelAdresse:
		f = append(f, "Tunnel-Adresse "+orKeins(w["adresse"])+" statt "+l.tunnelAdresse)
	}
	if errH != nil || hs < 0 || hs > 180 {
		f = append(f, "kein frischer Handshake")
	}
	if w["ssh_2222"] != "nur_im_tunnel" || orNull(w["lauscht_2222"]) != "0" {
		f = append(f, "SSH 2222 nicht nur im Tunnel")
	}
	if errA != nil || an < 0 {
		f = append(f, "keine gültige Antwort des Wartungsservers")
	}
	if w["dauerhaft"] != strconv.Itoa(dauerhaft) || orNull(w["dauerhaft_mit_optionen"]) != "0" {
		f = append(f, fmt.Sprintf("nicht genau %d dauerhafte Schlüssel", dauerhaft))
	}
	if len(f) > 0 {
		return b, errors.New(strings.Join(f, ", "))
	}
	return b, nil
}

func (l *Lauf) tunnelPruefen(ctx context.Context, dauerhaft int) (protokoll.Beleg, error) {
	var b protokoll.Beleg
	err := l.warteAuf(ctx, l.k.Zeiten.Tunnel, func() error {
		var err error
		b, err = l.tunnelStand(ctx, dauerhaft)
		return err
	})
	return b, err
}

func (l *Lauf) tunnelEinrichten(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	env := []string{"VP_SERVICE_PUBKEY=" + l.k.WartungPub}
	if l.k.WartungEP != "" {
		env = append(env, "VP_SERVICE_ENDPOINT="+l.k.WartungEP)
	}
	r, err := l.skript(ctx, "wartung.sh", []string{l.tunnelAdresse}, env...)
	if err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("einrichten", zeilenMit(r.Ausgabe, "eingerichtet:", "Wartungsserver:", "FEHLER"))
	if r.Code != 0 || !strings.Contains(r.Ausgabe, "eingerichtet: Tunnel "+l.tunnelAdresse) {
		return b, fmt.Errorf("wartung.sh endete mit %d: %s", r.Code, letzte(r.Ausgabe, 4))
	}
	st, err := l.tunnelPruefen(ctx, 2)
	b = append(b, st...)
	if err != nil {
		return b, fmt.Errorf("Tunnel steht nicht: %w", err)
	}
	l.belege["tunnel_status"] = "Schritt tunnel: Handshake, Port 2222 nur im Tunnel (lauscht an keiner Netzbuchse), Abholer läuft mit gültiger Antwort"
	return b, nil
}

// ---- Probe im Fenster ------------------------------------------------------------------

func (l *Lauf) probeImPortal(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	if l.k.Portal != nil && l.k.Probe != nil && l.probeFenster != "" {
		return l.probeUeberTunnel(ctx)
	}
	for {
		w, err := k.Warte(ctx, "probe", HinweisProbe(l.ref, l.host))
		if err != nil {
			return nil, err
		}
		if err := mango.PruefeProbe(w); err != nil {
			k.Log.Warn("Eingabe abgelehnt", "grund", err)
			continue
		}
		l.belege["anmeldeprobe"] = "Handgriff im Portal: Anmeldung über Portal und Tunnel im Fenster, vom Betreiber im Schritt probe bestätigt"
		l.belege["fenster_zu"] = "Handgriff im Portal: Fenster geschlossen, neuer Versuch abgewiesen, vom Betreiber im Schritt probe bestätigt"
		b := protokoll.Beleg{}.Mit("probe", "vom Betreiber im Portal erledigt: angemeldet, Host-Schlüssel gelesen, Fenster geschlossen, neuer Versuch abgewiesen").
			Mit("host_schluessel_netz", l.host)
		if l.k.Portal != nil && l.probeFenster != "" {
			// Das Probe-Fenster der Einlösung gehört dem Dienst; zu muss es vor der Abnahme sein.
			schonZu, err := l.k.Portal.FensterSchliessen(ctx, l.probeFenster)
			if err != nil {
				return b, fmt.Errorf("Probe-Fenster der Einlösung schließen: %w", err)
			}
			zustand := "geschlossen"
			if schonZu {
				zustand = "war schon zu"
			}
			b = b.Mit("probe_fenster", l.probeFenster+": "+zustand)
		}
		return b, nil
	}
}

// ereignisse liest die Ereignisliste des Tunnel-Programms (Anmeldungen und
// ihr Ende; nie ein Schlüssel).
func (l *Lauf) ereignisse(ctx context.Context) string {
	erg, err := l.v.Fuehre(ctx, tunnelProgramm+" ereignisse 2>/dev/null | tail -n 80", nil)
	if err != nil {
		return ""
	}
	return erg.Aus
}

// probeUeberTunnel ist die Probe durch den Dienst selbst: als Techniker-Zugang
// durch den Tunnel anmelden, den Host-Schlüssel dort lesen und mit dem aus dem
// Netz vergleichen, das Probe-Fenster der Einlösung schließen, der neue
// Versuch endet mit „Connection timed out“, und die Ereignisliste der Box
// nennt Anmeldung und Ende.
func (l *Lauf) probeUeberTunnel(ctx context.Context) (protokoll.Beleg, error) {
	a, err := netip.ParseAddr(l.tunnelAdresse)
	if err != nil {
		return nil, fmt.Errorf("Tunnel-Adresse %q: %v", l.tunnelAdresse, err)
	}
	if l.serverPub == "" || l.serverEP == "" {
		return nil, errors.New("Schlüssel oder Endpunkt des Wartungsservers fehlen (Einlösung, Konfiguration)")
	}
	s := wartung.Server{PublicKey: l.serverPub, Endpunkt: l.serverEP, BoxNetz: l.k.BoxNetz}
	ziel := netip.AddrPortFrom(a, 2222)
	fp := l.k.Probe.Fingerabdruck()
	b := protokoll.Beleg{}.Mit("techniker_schluessel", fp).Mit("ziel", ziel.String())

	actx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Tunnel)
	an, err := l.k.Probe.Anmelden(actx, s, ziel)
	cancel()
	if err != nil {
		return b, fmt.Errorf("Probe über den Tunnel: %w", err)
	}
	b = b.Mit("anmeldung", fmt.Sprintf("gelungen nach %d Versuchen in %s", an.Versuche, an.Dauer.Round(time.Second))).
		Mit("host_schluessel_tunnel", an.HostSchluessel).Mit("host_schluessel_netz", l.host)
	if an.HostSchluessel != l.host {
		return b, fmt.Errorf("Host-Schlüssel durch den Tunnel %s, im Netz %s: zwei verschiedene Geräte?", an.HostSchluessel, l.host)
	}
	anmeldung := ""
	for _, z := range strings.Split(l.ereignisse(ctx), "\n") {
		if strings.Contains(z, fp) {
			anmeldung = strings.TrimSpace(z)
		}
	}
	if anmeldung == "" {
		return b, fmt.Errorf("die Ereignisliste der Box nennt die Anmeldung mit %s nicht", fp)
	}
	b = b.Mit("box_log_anmeldung", anmeldung)

	schonZu, err := l.k.Portal.FensterSchliessen(ctx, l.probeFenster)
	if err != nil {
		return b, fmt.Errorf("Probe-Fenster schließen: %w", err)
	}
	zu := "geschlossen"
	if schonZu {
		zu = "war schon zu"
	}
	b = b.Mit("probe_fenster", l.probeFenster+": "+zu)
	nctx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Tunnel)
	nach, err := l.k.Probe.NachEnde(nctx, s, ziel)
	cancel()
	if err != nil {
		return b, fmt.Errorf("neuer Versuch nach dem Ende: %w", err)
	}
	b = b.Mit("neuer_versuch", nach)
	var ende string
	_ = l.warteAuf(ctx, l.k.Zeiten.Tunnel, func() error {
		for _, z := range strings.Split(l.ereignisse(ctx), "\n") {
			if strings.Contains(z, "Sitzung beendet") || strings.Contains(z, "Fenster-Schluessel jetzt: keine") {
				ende = strings.TrimSpace(z)
			}
		}
		if ende == "" {
			return errors.New("die Ereignisliste der Box nennt das Ende noch nicht")
		}
		return nil
	})
	if ende == "" {
		return b, errors.New("die Ereignisliste der Box nennt weder „Sitzung beendet“ noch „Fenster-Schluessel jetzt: keine“")
	}
	b = b.Mit("box_log_ende", ende)
	l.belege["anmeldeprobe"] = "Schritt probe: Anmeldung über Portal und Tunnel als Techniker-Zugang " + fp + " im Probe-Fenster der Einlösung; Ereignisliste der Box: " + anmeldung
	l.belege["fenster_zu"] = "Schritt probe: Fenster " + l.probeFenster + " geschlossen, neuer Versuch: " + nach + "; Ereignisliste der Box: " + ende
	l.belege["host_schluessel"] += "; Tunnel-Weg: " + an.HostSchluessel + " (gleich)"
	l.probeAutomatisch = true
	return b, nil
}
