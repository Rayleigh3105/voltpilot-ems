package pfc200

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/passwort"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// ---- erkennen ------------------------------------------------------------------

// befehlErkennen liest, was das Gerät über sich sagt. Er ändert nichts.
const befehlErkennen = `T=` + Werkzeuge + `
echo "artikel=$($T/get_coupler_details order-number 2>/dev/null)"
echo "bezeichnung=$($T/get_typelabel_value -n SYSDESC 2>/dev/null | sed 's/^SYSDESC=//')"
echo "seriennummer=$($T/get_typelabel_value -n UII 2>/dev/null | sed 's/^UII=//')"
echo "firmware=$(sed -n 's/^FIRMWARE=//p' /etc/REVISIONS 2>/dev/null)"
echo "schalter=$($T/get_run_stop_switch_value 2>/dev/null)"
echo "docker_install=$($T/get_docker_config install-status 2>/dev/null)"
echo "docker_aktiv=$($T/get_docker_config activation-status 2>/dev/null)"
echo "docker_laeuft=$(if pidof dockerd >/dev/null 2>&1; then echo ja; else echo nein; fi)"
for u in root admin user; do echo "werk_$u=$($T/get_user_info --is-default-pwd-linux $u 2>/dev/null)"; done
echo "edge=$(if [ -e /etc/init.d/vp-edge-industrie ] || [ -e /etc/init.d/vp-edge-light ]; then echo ja; else echo nein; fi)"
echo "wartung=$(if [ -e /etc/init.d/vp-wartung ]; then echo ja; else echo nein; fi)"
echo "reste=$(if [ -e /home/voltpilot ]; then echo ja; else echo nein; fi)"
echo "schluessel=$(grep -c . /root/.ssh/authorized_keys 2>/dev/null)"
echo "ssh_passwort=$($T/get_ssh_config password-request-state 2>/dev/null)"
echo "firewall=$($T/firewall firewall --is-enabled 2>/dev/null)"
echo "bruecken=$($T/network_config --bridge-config --get -f json 2>/dev/null)"
echo "buchsen=$($T/network_config --interface-status --get -f json 2>/dev/null)"
echo "uhr=$(date -u +%s)"
echo "dropbear=$(dropbear -V 2>&1 | head -n 1)"`

// buchse ist eine Netzbuchse laut network_config --interface-status.
type buchse struct {
	Device string `json:"device"`
	Link   string `json:"link"`
}

// kabelIn liest aus dem Stand der Buchsen, wo ein Kabel steckt ("X2", "X1",
// "X1 und X2", "keiner"); Fehler, wenn die Ausgabe nicht die erwartete Form hat.
func kabelIn(roh string) (string, error) {
	var b []buchse
	if err := json.Unmarshal([]byte(strings.TrimSpace(roh)), &b); err != nil {
		return "", fmt.Errorf("Stand der Netzbuchsen nicht lesbar (%q)", kurz(roh, 60))
	}
	oben := map[string]bool{}
	bekannt := map[string]bool{}
	for _, x := range b {
		bekannt[x.Device] = true
		if x.Link == "up" {
			oben[x.Device] = true
		}
	}
	if !bekannt["X1"] || !bekannt["X2"] {
		return "", fmt.Errorf("das Gerät nennt nicht die Buchsen X1 und X2 (%q)", kurz(roh, 60))
	}
	switch {
	case oben["X1"] && oben["X2"]:
		return "X1 und X2", nil
	case oben["X2"]:
		return "X2", nil
	case oben["X1"]:
		return "X1", nil
	}
	return "keiner", nil
}

// lies führt einen lesenden Befehl aus und meldet sich neu an, wenn die
// Verbindung dabei weg ist (jemand steckt gerade das Kabel um).
func (l *Lauf) lies(ctx context.Context, befehl string) (string, error) {
	if l.v == nil {
		if err := l.neuVerbinden(ctx, l.ziel, l.k.Zeiten.Verbinden); err != nil {
			return "", err
		}
	}
	vctx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Verbinden)
	defer cancel()
	erg, err := l.v.Fuehre(vctx, befehl, nil)
	if err != nil {
		l.v.Schliesse()
		l.v = nil
		return "", err
	}
	return strings.TrimSpace(erg.Aus), nil
}

func (l *Lauf) erkennen(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	// Ein Notfall-Schlüssel, den das Gerät nicht annähme, hält hier an: Am
	// Ende des Laufs stünde sonst ein Gerät ohne brauchbaren Notfall-Zugang.
	if l.notfallFehler != nil {
		return protokoll.Beleg{}.Mit("notfall_schluessel", l.notfallFehler.Error()),
			lauf.Handgriff{Was: zurSeite, Fall: faelle.PFCNotfallSchluessel, Grund: l.notfallFehler.Error() + ". Am Gerät ist nichts geändert."}
	}
	s, err := l.k.Werkbank.Status(ctx)
	if err != nil {
		return nil, err
	}
	adresse, mac, err := Einzeln(s)
	if err != nil {
		return nil, err
	}
	if adresse != FesteAdresse {
		return nil, fmt.Errorf("das Gerät antwortet unter %s, nicht unter %s (feste Adresse des PFC200)", adresse, FesteAdresse)
	}
	l.mac = mac
	b := protokoll.Beleg{}.Mit("mac", mac).Mit("adresse", adresse.String())
	if !IstWago(mac) {
		return b, lauf.Handgriff{Was: zurSeite, Fall: faelle.PFCFalschesGeraet, Grund: fmt.Sprintf("Unter %s antwortet kein Gerät von WAGO (MAC %s).", adresse, mac)}
	}
	ziel := netip.AddrPortFrom(FesteAdresse, 22)
	v, err := l.verbinde(ctx, ziel, l.anmeldung(), 2*l.k.Zeiten.Verbinden)
	var ab box.Abgewiesen
	if errors.As(err, &ab) {
		// Das Werkspasswort gilt nicht mehr: Jemand hat das Gerät eingerichtet.
		// Zurücksetzen lässt der Dienst nur, was nachweislich diese Werkstatt
		// begonnen und nicht fertig gemacht hat.
		b = b.Mit("werkspasswort", "abgewiesen").Mit("host_schluessel", orKeins(ab.Host))
		sp, nein, fall := l.k.HalbEigene(ctx, mac, ab.Host, l.kennung)
		if nein == "" {
			return b.Mit("lauf_vorher", sp.Lauf).Mit("referenz_vorher", sp.Ref).Mit("zuruecksetzen", "ja"),
				lauf.Handgriff{Was: Werksreset, Fall: faelle.PFCPasswort, Grund: halbGrund(sp)}
		}
		return b.Mit("zuruecksetzen", "nein - "+nein), lauf.Handgriff{Was: zurSeite, Fall: fall,
			Grund: "Der PFC200 nimmt das Werkspasswort nicht an: Er ist schon eingerichtet. Der Dienst fasst eingerichtete Geräte nicht an (" + nein + ")."}
	}
	if err != nil {
		return b, err
	}
	l.v, l.ziel = v, ziel
	w, err := l.werte(ctx, befehlErkennen)
	if err != nil {
		return b, err
	}
	uhr := "nicht lesbar"
	if sek, err := strconv.ParseInt(w["uhr"], 10, 64); err == nil {
		uhr = time.Unix(sek, 0).UTC().Format(time.RFC3339)
	}
	l.firmware, l.seriennummer = w["firmware"], w["seriennummer"]
	b = b.Mit("modell", "WAGO "+w["artikel"]).Mit("bezeichnung", w["bezeichnung"]).Mit("firmware", w["firmware"]).Mit("seriennummer", w["seriennummer"]).
		Mit("host_schluessel", v.HostArt()+" "+v.HostFingerabdruck()).Mit("dropbear", w["dropbear"]).
		Mit("docker", w["docker_install"]+", "+w["docker_aktiv"]+", Dienst läuft: "+w["docker_laeuft"]).
		Mit("bruecken", w["bruecken"]).Mit("firewall", w["firewall"]).Mit("uhr_vorher", uhr).
		Mit("vorhandene_schluessel", orNull(w["schluessel"])+" (der Lauf lässt nur den Notfall-Schlüssel stehen)")
	h := lauf.Handgriff{Was: zurSeite}
	switch {
	case w["artikel"] != Artikel:
		h.Fall, h.Grund = faelle.PFCFalschesGeraet, fmt.Sprintf("Das Gerät ist kein PFC200 %s (Bestellnummer %q).", Artikel, w["artikel"])
	case w["edge"] == "ja" || w["wartung"] == "ja":
		h.Fall, h.Grund = faelle.PFCSchonEingerichtet, "Auf dem Gerät liegt schon ein Dienst von VoltPilot: kein Werkszustand."
	case w["werk_root"] != "1" || w["werk_admin"] != "1" || w["werk_user"] != "1":
		h.Fall, h.Grund = faelle.PasswortFremd, fmt.Sprintf("Nicht alle Passwörter sind die ab Werk (root %s, admin %s, user %s; 1 heißt ab Werk): Jemand hat das Gerät eingerichtet.",
			orKeins(w["werk_root"]), orKeins(w["werk_admin"]), orKeins(w["werk_user"]))
	case w["ssh_passwort"] != "enabled":
		h.Fall, h.Grund = faelle.NichtNachweisbar, fmt.Sprintf("Die Anmeldung mit Passwort ist %q, ab Werk ist sie an.", w["ssh_passwort"])
	case w["docker_aktiv"] == "active" || w["docker_laeuft"] == "ja":
		h.Was, h.Fall, h.Grund = dockerAus, faelle.PFCDockerAn, "Auf dem Gerät läuft Docker ("+w["docker_install"]+", "+w["docker_aktiv"]+"). Der Dienst beendet keine fremden Container; mit Docker stimmen Weiterleitung und Firewall des Geräts nicht."
	}
	if h.Grund != "" {
		return b, h
	}
	b = b.Mit("werkspasswoerter", "root, admin, user ab Werk")
	if w["reste"] == "ja" {
		// Werkszustand, aber /home/voltpilot ist da: Reste eines früheren
		// Laufs, die ein Werksreset stehen ließ (die Datenpartition übersteht
		// ihn). Der Schritt programm räumt sie weg, sonst trüge das Gerät die
		// alte Referenz und den alten Geräteschlüssel weiter.
		l.reste = true
		b = b.Mit("reste", "/home/voltpilot von einem früheren Lauf vorhanden (Werkszustand sonst belegt); wird vor dem Einspielen entfernt")
	}
	l.host, l.hostArt = v.HostFingerabdruck(), v.HostArt()
	l.belege["host_schluessel"] = "Netz-Weg: " + l.host + " (Schritt erkennen und neustart)"

	// Das Kabel der Werkbank gehört in X2: Der Schritt netze trennt die
	// Buchsen, und nur X2 bekommt die Adresse, unter der der Dienst weitermacht.
	kabel, err := kabelIn(w["buchsen"])
	if err != nil {
		return b, lauf.Handgriff{Was: zurSeite, Fall: faelle.NichtNachweisbar, Grund: err.Error() + ": Der Dienst kann nicht sagen, in welcher Buchse das Kabel steckt. Am Gerät ist nichts geändert."}
	}
	if kabel != "X2" {
		k.Log.Info("Kabel nicht in X2, der Lauf wartet", "kabel", kabel)
		err := k.WarteBis(ctx, "kabel_x2", faelle.PFCKabelX1, kabelInX2+" (Kabel jetzt: "+kabel+")", l.k.Zeiten.Takt, func(ctx context.Context) (bool, error) {
			roh, err := l.lies(ctx, Werkzeuge+"/network_config --interface-status --get -f json")
			if err != nil {
				return false, nil // beim Umstecken ist das Gerät kurz weg
			}
			kabel, err = kabelIn(roh)
			return err == nil && kabel == "X2", nil
		})
		if err != nil {
			return b.Mit("kabel", kabel), fmt.Errorf("das Kabel steckt nicht in der Buchse X2 (%s): %w", kabel, err)
		}
	}
	b = b.Mit("kabel", "X2")

	// Der Betriebsartenschalter steht nach dem Handgriff „feste Adresse“ oft
	// noch auf STOP. Ausgeliefert wird mit RUN.
	schalter := w["schalter"]
	if schalter != "run" {
		k.Log.Info("Betriebsartenschalter nicht auf RUN, der Lauf wartet", "schalter", schalter)
		err := k.WarteBis(ctx, "schalter_run", faelle.PFCSchalterStop, schalterAufRun, l.k.Zeiten.Takt, func(ctx context.Context) (bool, error) {
			aus, err := l.lies(ctx, Werkzeuge+"/get_run_stop_switch_value")
			if err != nil {
				return false, nil
			}
			schalter = aus
			return schalter == "run", nil
		})
		if err != nil {
			return b.Mit("schalter", schalter), fmt.Errorf("der Betriebsartenschalter steht nicht auf RUN (%s): %w", orKeins(schalter), err)
		}
	}
	return b.Mit("schalter", "run"), nil
}

func orNull(s string) string {
	if s == "" {
		return "0"
	}
	return s
}

// halbGrund ist der Grund für den Werksreset an einem eigenen Gerät.
func halbGrund(sp protokoll.Spur) string {
	g := "Diesen PFC200 hat der Lauf " + sp.Lauf + " begonnen und nicht fertig gemacht (dieselbe MAC, derselbe Host-Schlüssel"
	if sp.Ref != "" {
		g += "; " + sp.Ref + " ist im Portal nicht abgenommen und nicht gekoppelt"
	}
	return g + "). Seinen Zugang hat der Dienst nicht mehr; zurückgesetzt richtet er ihn neu ein. Ein alter Eintrag im Register bleibt als Verlauf stehen."
}

// erkennenHalbImLan: das Gerät unter der Adresse des Anlagennetzes, dessen MAC
// laut Protokoll ein unfertiger Lauf dieser Werkstatt kennt. Nur der
// SSH-Handshake (für den Host-Schlüssel), keine Anmeldung, keine Änderung.
func (l *Lauf) erkennenHalbImLan(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	s, err := l.k.Werkbank.Status(ctx)
	if err != nil {
		return nil, err
	}
	adresse, mac, err := Einzeln(s)
	if err != nil {
		return nil, err
	}
	if adresse != l.k.LanNetz.Addr() {
		return nil, fmt.Errorf("das Gerät antwortet unter %s, nicht unter %s (Anlagennetz)", adresse, l.k.LanNetz.Addr())
	}
	l.mac = mac
	b := protokoll.Beleg{}.Mit("mac", mac).Mit("adresse", adresse.String())
	// Ein Passwort, das es nicht gibt: Der Lauf will nur den Host-Schlüssel sehen.
	v, err := l.verbinde(ctx, l.zielLan(), []ssh.AuthMethod{ssh.Password("")}, 2*l.k.Zeiten.Verbinden)
	var ab box.Abgewiesen
	switch {
	case errors.As(err, &ab):
		b = b.Mit("ssh", "Anmeldung ohne Zugang abgewiesen").Mit("host_schluessel", orKeins(ab.Host))
	case err != nil:
		return b, err
	default:
		host := v.HostFingerabdruck()
		v.Schliesse()
		return b.Mit("host_schluessel", host), lauf.Handgriff{Was: zurSeite, Fall: faelle.NichtNachweisbar,
			Grund: "Das Gerät im Anlagennetz nimmt root ohne Passwort an: Das ist kein Stand, den ein Lauf dieser Werkstatt hinterlässt."}
	}
	sp, nein, fall := l.k.HalbEigene(ctx, mac, ab.Host, l.kennung)
	b = b.Mit("lauf_vorher", orKeins(sp.Lauf)).Mit("referenz_vorher", orKeins(sp.Ref))
	if nein != "" {
		return b.Mit("zuruecksetzen", "nein - "+nein), lauf.Handgriff{Was: zurSeite, Fall: fall,
			Grund: "Im Anlagennetz steht ein eingerichteter PFC200; der Dienst lässt ihn nicht zurücksetzen: " + nein + "."}
	}
	return b.Mit("zuruecksetzen", "ja"), lauf.Handgriff{Was: Werksreset, Fall: faelle.PFCPasswort, Grund: halbGrund(sp)}
}

// ---- Fassungen ---------------------------------------------------------------------

// fassungenHolen legt Programm, Skriptstand und Tunnel-Programm der Freigabe
// bereit und prüft das signierte Manifest, bevor irgendetwas auf das Gerät geht.
func (l *Lauf) fassungenHolen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	programm, skripte, tunnel := fassungen.DateienPFC200(l.freigabe)
	b := protokoll.Beleg{}.Mit("freigabe", l.freigabe.Kennung)
	for _, d := range []fassungen.Datei{programm, skripte, tunnel} {
		erg, err := l.k.Fassungen.Hole(ctx, d)
		if err != nil {
			return b, err
		}
		herkunft := "aus dem Zwischenspeicher"
		if erg.Geladen {
			herkunft = "geladen von " + d.URL
		}
		b = b.Mit(d.Name, fmt.Sprintf("sha256 %s, %d Bytes, %s", d.Sha256, erg.Groesse, herkunft))
		switch d.Name {
		case programm.Name:
			l.pfadProgramm = erg.Pfad
		case skripte.Name:
			l.pfadSkripte = erg.Pfad
		case tunnel.Name:
			l.pfadWartung = erg.Pfad
		}
	}
	return l.manifestHolen(ctx, b)
}

// manifestHolen lädt das signierte Manifest der Fassung und bindet es an die
// Freigabe: genau diese Fassung, genau dieses Programm für linux/arm, genau
// dieser Skriptstand, genau dieses Tunnel-Programm. Anders als bei der Mango
// gibt es für den PFC200 keinen Lauf mit einer nicht signierten Fassung: Das
// Tunnel-Programm läuft als root und öffnet den Fernzugang, und ein Gerät,
// das ohne Abnahme bliebe, käme nur mit einem Werksreset zurück. Fehlt das
// Manifest, widerspricht es der Freigabe oder stimmt seine Signaturkette
// nicht, hält der Schritt an; das Gerät ist dann noch unverändert.
func (l *Lauf) manifestHolen(ctx context.Context, b protokoll.Beleg) (protokoll.Beleg, error) {
	f := l.freigabe.EdgeIndustrie
	m, sig, err := l.k.Fassungen.HoleManifest(ctx, f.Quelle, f.Fassung)
	if errors.Is(err, fassungen.ErrNichtSigniert) {
		return b.Mit("manifest", "keins"), fmt.Errorf("die Fassung %s ist nicht signiert (kein release.json am Release): Die Werkstatt richtet einen PFC200 nur mit einer signierten Fassung ein", f.Fassung)
	}
	if err != nil {
		return b.Mit("manifest", "keins"), fmt.Errorf("das Manifest der Fassung %s ist nicht erreichbar: %w", f.Fassung, err)
	}
	trustSet, trustSetSig, err := l.k.Fassungen.HoleVertrauensSet(ctx, l.k.portalURL())
	if err != nil {
		return b, fmt.Errorf("Vertrauens-Set für die Signaturprüfung nicht erreichbar: %w", err)
	}
	if _, err := l.k.Fassungen.PruefeSignatur(trustSet, trustSetSig, m, sig); err != nil {
		return b, fmt.Errorf("Signatur des Release-Manifests nicht gültig: %w", err)
	}
	st, err := fassungen.PruefeManifestPFC200(m, sig, f.Fassung, f.ProgrammSha256, f.SkripteSha256, f.WartungSha256)
	if err != nil {
		return b, err
	}
	pfad := filepath.Join(l.dir, fassungen.ManifestDatei)
	if err := os.WriteFile(pfad, m, 0o644); err != nil {
		return b, err
	}
	l.pfadManifest, l.stand = pfad, &st
	return b.Mit("manifest", fmt.Sprintf("signiert (%s), Stand %d, Datenformat %d", st.SigniertVon, st.ReleaseSeq, st.StateSchema)), nil
}

// ---- befristetes Werkstatt-Internet, Uhr --------------------------------------------

// dnsListe liest die Ausgabe von get_dns_server all: [ "9.9.9.9", "1.1.1.1" ].
func dnsListe(roh string) ([]string, error) {
	var l []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(roh)), &l); err != nil {
		return nil, fmt.Errorf("Liste der DNS-Server nicht lesbar (%q)", kurz(roh, 60))
	}
	return l, nil
}

// befehlInternet prüft den Weg des Geräts ins Internet: Name, Weg, Uhr und
// Zertifikat in einem (curl prüft das Zertifikat des Portals; mit der Uhr ab
// Werk gälte es als noch nicht gültig).
func (l *Lauf) befehlInternet() string {
	adresse := shellWort(l.k.portalURL() + "/api/v1/edge/trust-set/trust-set.json")
	return `echo "weg=$(ip -4 route show default 2>/dev/null | head -n 1)"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 20 -o /dev/null ` + adresse + ` 2>/tmp/vp-werkstatt-internet.err; then echo internet=ja; else echo internet=nein; fi
else
  if wget -q -T 20 -O /dev/null ` + adresse + ` 2>/tmp/vp-werkstatt-internet.err; then echo internet=ja; else echo internet=nein; fi
fi
echo "grund=$(head -n 1 /tmp/vp-werkstatt-internet.err 2>/dev/null)"
rm -f /tmp/vp-werkstatt-internet.err`
}

// uhrStellen stellt die Uhr des Geräts nach der des Dienstes, wenn sie mehr
// als eine halbe Minute danebenliegt, und gibt den Stand vorher und nachher
// zurück (Sekunden Abstand zur Uhr des Dienstes).
func (l *Lauf) uhrStellen(ctx context.Context) (vorher, nachher time.Duration, err error) {
	abstand := func() (time.Duration, error) {
		erg, err := l.fuehre(ctx, "date -u +%s", "")
		if err != nil {
			return 0, err
		}
		sek, err := strconv.ParseInt(strings.TrimSpace(erg.Aus), 10, 64)
		if err != nil {
			return 0, fmt.Errorf("Uhr des Geräts nicht lesbar (%q)", kurz(erg.Aus, 40))
		}
		return time.Unix(sek, 0).Sub(l.k.jetzt()), nil
	}
	if vorher, err = abstand(); err != nil {
		return 0, 0, err
	}
	if vorher.Abs() <= 30*time.Second {
		return vorher, vorher, nil
	}
	jetzt := l.k.jetzt().UTC()
	if _, err = l.fuehre(ctx, Werkzeuge+"/config_clock type=utc time="+jetzt.Format("15:04:05")+" date="+jetzt.Format("02.01.2006"), ""); err != nil {
		return vorher, 0, fmt.Errorf("Uhr stellen: %w", err)
	}
	if nachher, err = abstand(); err != nil {
		return vorher, 0, err
	}
	if nachher.Abs() > time.Minute {
		return vorher, nachher, fmt.Errorf("die Uhr des Geräts liegt nach dem Stellen %s neben der des Dienstes", nachher.Round(time.Second))
	}
	return vorher, nachher, nil
}

func (l *Lauf) internetAn(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}
	// Weg über die Brücke, befristet: Der Schritt internet_weg nimmt ihn zurück.
	if _, err := l.fuehre(ctx, Werkzeuge+"/config_default_gateway number=1 state=enabled value="+BrueckeFest.String(), ""); err != nil {
		return b, err
	}
	erg, err := l.fuehre(ctx, Werkzeuge+"/get_dns_server all", "")
	if err != nil {
		return b, err
	}
	da, err := dnsListe(erg.Aus)
	if err != nil {
		return b, err
	}
	for _, d := range l.k.DNS {
		vorhanden := false
		for _, x := range da {
			vorhanden = vorhanden || x == d.String()
		}
		if vorhanden {
			continue
		}
		if _, err := l.fuehre(ctx, Werkzeuge+"/edit_dns_server add=add dns-server-name="+d.String(), ""); err != nil {
			return b, err
		}
		l.dnsGesetzt = append(l.dnsGesetzt, d.String())
	}
	b = b.Mit("dns", strings.Join(l.dnsGesetzt, ", ")+" (befristet, am Ende entfernt)")

	// Die Uhr vor jeder TLS-Verbindung: Ab Werk steht sie in der Vergangenheit.
	vorher, nachher, err := l.uhrStellen(ctx)
	if err != nil {
		return b, err
	}
	b = b.Mit("uhr", fmt.Sprintf("gestellt nach der Uhr des Dienstes: vorher %s daneben, jetzt %s", vorher.Round(time.Second), nachher.Round(time.Second)))

	var w map[string]string
	err = l.warteAuf(ctx, l.k.Zeiten.Netz, func() error {
		var err error
		if w, err = l.werte(ctx, l.befehlInternet()); err != nil {
			return err
		}
		if !strings.Contains(w["weg"], "via "+BrueckeFest.String()) || w["internet"] != "ja" {
			return fmt.Errorf("Standardweg %q, Internet %s (%s)", w["weg"], w["internet"], w["grund"])
		}
		return nil
	})
	if err != nil {
		return b.Mit("standardweg", w["weg"]).Mit("internet", w["internet"]), fmt.Errorf("kein Internet über die Brücke: %w", err)
	}
	b = b.Mit("standardweg", w["weg"]).Mit("internet", l.k.portalURL()+" erreichbar über die Brücke, Zertifikat geprüft (befristet, am Ende entfernt)")

	// Zeitabgleich ein: Er bleibt nach dem Lauf an, sonst scheitern beim
	// Kunden TLS und der Wartungstunnel an einer falschen Uhr.
	if len(l.k.Zeitserver) > 0 {
		arg := "state=enabled update-time=3600"
		for i, z := range l.k.Zeitserver {
			if i >= 4 {
				break
			}
			arg += fmt.Sprintf(" time-server-%d=%s", i+1, z)
		}
		if _, err := l.fuehre(ctx, Werkzeuge+"/config_sntp "+arg, ""); err != nil {
			return b, fmt.Errorf("Zeitabgleich einschalten: %w", err)
		}
		w, err := l.werte(ctx, `echo "state=$(`+Werkzeuge+`/get_ntp_config state 2>/dev/null)"
if `+Werkzeuge+`/config_sntp update >/dev/null 2>&1; then echo abgleich=gelungen; else echo abgleich=nicht-gelungen; fi`)
		if err != nil {
			return b, err
		}
		if w["state"] != "enabled" {
			return b, fmt.Errorf("der Zeitabgleich ist nach dem Einschalten %q", w["state"])
		}
		b = b.Mit("zeitabgleich", "ein ("+strings.Join(l.k.Zeitserver, ", ")+"), erster Abgleich "+strings.ReplaceAll(w["abgleich"], "-", " "))
	}
	return b, nil
}

// ---- Zugänge -----------------------------------------------------------------------

// benutzer sind die drei Konten des PFC200, mit ihren Werkspasswörtern.
var benutzer = []struct{ name, werk string }{{"root", werkRoot}, {"admin", werkAdmin}, {"user", werkUser}}

const schluesselDatei = "/root/.ssh/authorized_keys"

// schreibeSchluessel ersetzt die dauerhaften Schlüssel des Geräts durch die
// gegebenen Zeilen (erst daneben schreiben, dann tauschen).
func (l *Lauf) schreibeSchluessel(ctx context.Context, zeilen ...string) error {
	_, err := l.fuehre(ctx, "umask 077 && mkdir -p /root/.ssh && cat > "+schluesselDatei+".neu && chmod 600 "+schluesselDatei+".neu && mv -f "+schluesselDatei+".neu "+schluesselDatei+" && sync",
		strings.Join(zeilen, "\n")+"\n")
	return err
}

// dauerhafteSchluessel liest die Fingerabdrücke der dauerhaften Schlüssel.
func (l *Lauf) dauerhafteSchluessel(ctx context.Context) ([]string, error) {
	erg, err := l.fuehre(ctx, "cat "+schluesselDatei+" 2>/dev/null || true", "")
	if err != nil {
		return nil, err
	}
	var fps []string
	sc := bufio.NewScanner(strings.NewReader(erg.Aus))
	for sc.Scan() {
		z := strings.TrimSpace(sc.Text())
		if z == "" || strings.HasPrefix(z, "#") {
			continue
		}
		pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(z))
		if err != nil {
			fps = append(fps, "unlesbar")
			continue
		}
		fps = append(fps, ssh.FingerprintSHA256(pk))
	}
	sort.Strings(fps)
	return fps, nil
}

// anmeldenAls versucht eine Anmeldung mit Passwort und sagt, ob das Gerät sie
// annimmt. Fehler heißt: keine Antwort (weder ja noch nein).
func (l *Lauf) anmeldenAls(ctx context.Context, name, pw string) (bool, error) {
	v, err := box.VerbindeAls(ctx, l.k.Werkbank, l.ziel, name, []ssh.AuthMethod{ssh.Password(pw)}, box.GenauDieser(l.host), l.k.Zeiten.Verbinden)
	if err == nil {
		v.Schliesse()
		return true, nil
	}
	if errors.As(err, new(box.Abgewiesen)) {
		return false, nil
	}
	return false, err
}

// zugaengeSetzen: der Lauf-Schlüssel als zweiter Weg hinein, dann drei
// Zufallspasswörter (erst verschlüsselt, dann gesetzt), dann die Anmeldung mit
// Passwort aus. Auf das Gerät geht nie ein Passwort, nur sein Hash.
func (l *Lauf) zugaengeSetzen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}
	// 1. Der Schlüssel dieses Laufs neben dem, was schon da ist. Erst wenn die
	// Anmeldung mit ihm gelingt, ändert sich ein Passwort.
	erg, err := l.fuehre(ctx, "cat "+schluesselDatei+" 2>/dev/null || true", "")
	if err != nil {
		return b, err
	}
	var zeilen []string
	for _, z := range strings.Split(erg.Aus, "\n") {
		if z = strings.TrimSpace(z); z != "" {
			zeilen = append(zeilen, z)
		}
	}
	if err := l.schreibeSchluessel(ctx, append(zeilen, l.laufZeile)...); err != nil {
		return b, err
	}
	l.mitSchluessel = true
	if err := l.neuVerbinden(ctx, l.ziel, l.k.Zeiten.Verbinden); err != nil {
		l.mitSchluessel = false
		return b, fmt.Errorf("Anmeldung mit dem Schlüssel dieses Laufs: %w (kein Passwort geändert)", err)
	}
	b = b.Mit("lauf_schluessel", ssh.FingerprintSHA256(l.laufSchluessel.PublicKey())+" (nur für diesen Lauf, am Ende entfernt), Anmeldung gelungen")

	// 2. Drei Passwörter: erst verschlüsseln, dann setzen. Ohne Ablage gäbe es
	// ein Gerät mit Passwörtern, die niemand kennt.
	var zugaenge []passwort.Zugang
	var hashes []string
	for _, u := range benutzer {
		pw, err := passwort.Neu()
		if err != nil {
			return b, err
		}
		l.passwoerter = append(l.passwoerter, pw)
		h, err := passwort.ShadowHash(pw)
		if err != nil {
			return b, err
		}
		zugaenge = append(zugaenge, passwort.Zugang{Benutzer: u.name, Passwort: pw})
		hashes = append(hashes, h)
	}
	text, err := passwort.VerschluessleZugaenge(zugaenge, l.k.Empfaenger)
	if err != nil {
		return b, fmt.Errorf("Passwörter verschlüsseln: %v", err)
	}
	// Ab hier steht der verschlüsselte Text in jedem Beleg, auch dem eines
	// gescheiterten Schritts: Ein gesetztes Passwort geht nie verloren.
	b = b.Mit("passwort_age", text)
	l.passwortAge = text
	for i, u := range benutzer {
		if _, err := l.fuehre(ctx, Werkzeuge+"/config_linux_user user="+u.name+" hash="+shellWort(hashes[i]), ""); err != nil {
			return b, fmt.Errorf("Passwort von %s setzen: %w", u.name, err)
		}
	}

	// 3. Belege: Das Gerät selbst sagt „nicht mehr ab Werk“, das Werkspasswort
	// wird an SSH abgewiesen, das neue angenommen.
	w, err := l.werte(ctx, `for u in root admin user; do echo "werk_$u=$(`+Werkzeuge+`/get_user_info --is-default-pwd-linux $u 2>/dev/null)"; done`)
	if err != nil {
		return b, err
	}
	b = b.Mit("werk_laut_geraet", fmt.Sprintf("root %s, admin %s, user %s (0 heißt: nicht mehr ab Werk)", w["werk_root"], w["werk_admin"], w["werk_user"]))
	if w["werk_root"] != "0" || w["werk_admin"] != "0" || w["werk_user"] != "0" {
		return b, errors.New("das Gerät meldet für mindestens einen Benutzer weiter das Werkspasswort")
	}
	for i, u := range benutzer {
		ja, err := l.anmeldenAls(ctx, u.name, u.werk)
		if err != nil {
			return b, fmt.Errorf("Probe mit dem Werkspasswort von %s: %w", u.name, err)
		}
		if ja {
			return b, fmt.Errorf("das Gerät nimmt das Werkspasswort von %s weiter an", u.name)
		}
		ja, err = l.anmeldenAls(ctx, u.name, zugaenge[i].Passwort.Offenbaren())
		if err != nil {
			return b, fmt.Errorf("Probe mit dem neuen Passwort von %s: %w", u.name, err)
		}
		if !ja {
			return b, fmt.Errorf("das Gerät nimmt das neue Passwort von %s nicht an", u.name)
		}
	}
	b = b.Mit("werkspasswort", "abgewiesen an SSH (root, admin, user)").Mit("neues_passwort", "angenommen an SSH (root, admin, user)")

	// 4. Anmeldung mit Passwort aus. Das Werkzeug startet den SSH-Dienst neu
	// und beendet damit jede Sitzung, auch diese: darum losgelöst.
	if _, err := l.losgeloest(ctx, "ssh", Werkzeuge+"/config_ssh password-request-state=disabled", l.k.Zeiten.SSHDienst); err != nil {
		return b, fmt.Errorf("Anmeldung mit Passwort ausschalten: %w", err)
	}
	erg, err = l.fuehre(ctx, Werkzeuge+"/get_ssh_config password-request-state", "")
	if err != nil {
		return b, err
	}
	if s := strings.TrimSpace(erg.Aus); s != "disabled" {
		return b, fmt.Errorf("die Anmeldung mit Passwort ist nach dem Ausschalten %q", s)
	}
	ja, err := l.anmeldenAls(ctx, "root", zugaenge[0].Passwort.Offenbaren())
	if err != nil {
		return b, fmt.Errorf("Probe nach dem Ausschalten der Anmeldung mit Passwort: %w", err)
	}
	if ja {
		return b, errors.New("das Gerät nimmt root mit Passwort weiter an")
	}
	b = b.Mit("passwort_anmeldung", "aus (root mit dem neuen Passwort abgewiesen, Anmeldung nur mit Schlüssel)")
	l.belege["zugaenge"] = "Schritt zugaenge: drei Zufallspasswörter (root, admin, user; je 20 Zeichen), verschlüsselt für den age-Schlüssel Box-Passwörter im Beleg passwort_age; " +
		"jedes Werkspasswort an SSH abgewiesen; Anmeldung mit Passwort aus"
	return b, nil
}

// ---- Notfall-Schlüssel -----------------------------------------------------------------

// notfallSchluessel: Dauerhaft bleibt nur der Notfall-Schlüssel; bis zum Ende
// des Laufs steht daneben der Lauf-Schlüssel (ohne ihn käme der Dienst nicht
// mehr hinein). Was vorher auf dem Gerät stand, ist damit weg.
func (l *Lauf) notfallSchluessel(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	if err := l.schreibeSchluessel(ctx, strings.TrimSpace(l.k.Notfall), l.laufZeile); err != nil {
		return nil, err
	}
	fps, err := l.dauerhafteSchluessel(ctx)
	if err != nil {
		return nil, err
	}
	laufFP := ssh.FingerprintSHA256(l.laufSchluessel.PublicKey())
	soll := []string{l.notfallFP, laufFP}
	sort.Strings(soll)
	b := protokoll.Beleg{}.Mit("zeilen", "1").Mit("fingerabdruck", l.notfallFP).Mit("lauf_schluessel", laufFP+" (bis zum Schritt internet_weg)")
	if strings.Join(fps, ",") != strings.Join(soll, ",") {
		return b, fmt.Errorf("dauerhafte Schlüssel auf dem Gerät: %s, erwartet der Notfall-Schlüssel %s und der Lauf-Schlüssel", strings.Join(fps, ", "), l.notfallFP)
	}
	return b, nil
}
