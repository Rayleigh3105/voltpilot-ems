package pfc200

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/box"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// ---- Netze und Firewall ------------------------------------------------------------
//
// Soll nach der Werkstatt (Konzept 4.6, Entscheid E5 A):
//
//	Buchse X1 = Brücke br0 = Kundennetz: Adresse per DHCP, Weg ins Internet.
//	  Von dort erreichbar: nur die Web-App der Box (8484) und OCPP (8887).
//	Buchse X2 = Brücke br1 = Anlagennetz: feste Adresse (Vorgabe 10.213.0.1/24).
//	  Von dort erreichbar: SSH, die Web-Oberfläche des Geräts (https), die
//	  Entwicklungsumgebung CODESYS (Dienst codesysr: 11740/TCP, 1740/UDP),
//	  dazu Web-App 8484 und OCPP 8887.
//	Zwischen den Buchsen leitet das Gerät nichts weiter.
//
// Die Firewall des Geräts führt die Brücken als br0 und br1; ihre Ausgaben in
// der alten Form nennen sie X1 und X2 (Befund am Gerät, Firmware 03.10.08).

const (
	bruecken    = `{"br0":["X1"],"br1":["X2"]}`
	brueckenAlt = `{"br0":["X1","X2"]}`
	kundenIf    = "br0" // Buchse X1
	anlagenIf   = "br1" // Buchse X2
	portWebApp  = 8484
	portOCPP    = 8887
	portModbus  = 502
	okNetze     = "/tmp/vp-werkstatt-netze.ok"
	okFirewall  = "/tmp/vp-werkstatt-firewall.ok"
)

// DiensteAnlagennetz sind die Dienste des Geräts, die am Anlagennetz (X2)
// offen bleiben. Am Kundennetz (X1) bleibt keiner offen.
var DiensteAnlagennetz = []string{"codesysr", "https", "ssh"}

// altName ist der Name einer Brücke in den Ausgaben der Firewall in der alten Form.
func altName(schnittstelle string) string {
	switch schnittstelle {
	case "br0":
		return "X1"
	case "br1":
		return "X2"
	}
	return schnittstelle
}

type ipEintrag struct {
	Ipaddr  string `json:"ipaddr"`
	Netmask string `json:"netmask"`
	Source  string `json:"source"`
}

// netzStand liest Brücken und Adressen des Geräts.
func (l *Lauf) netzStand(ctx context.Context) (brueckenIst string, ip map[string]ipEintrag, err error) {
	w, err := l.werte(ctx, `echo "bruecken=$(`+Werkzeuge+`/network_config --bridge-config --get -f json 2>/dev/null)"
echo "ip=$(`+Werkzeuge+`/network_config --ip-config --get -f json 2>/dev/null)"`)
	if err != nil {
		return "", nil, err
	}
	if err := json.Unmarshal([]byte(w["ip"]), &ip); err != nil {
		return "", nil, fmt.Errorf("Adressen des Geräts nicht lesbar (%q)", kurz(w["ip"], 80))
	}
	var b map[string][]string
	if err := json.Unmarshal([]byte(w["bruecken"]), &b); err != nil {
		return "", nil, fmt.Errorf("Brücken des Geräts nicht lesbar (%q)", kurz(w["bruecken"], 80))
	}
	var teile []string
	for _, name := range []string{"br0", "br1"} {
		p := append([]string{}, b[name]...)
		sort.Strings(p)
		teile = append(teile, name+"="+strings.Join(p, "+"))
	}
	return strings.Join(teile, " "), ip, nil
}

// netzeSoll prüft den Stand gegen das Soll und gibt die Belegzeilen zurück.
// Vor dem Neustart trägt die Brücke von X1 noch die vorübergehende feste
// Adresse (Quelle fixip); sie fällt mit dem Neustart weg. Danach muss dort
// DHCP stehen.
func (l *Lauf) netzeSoll(brueckenIst string, ip map[string]ipEintrag, nachNeustart bool) (kunde, anlage string, err error) {
	if brueckenIst != "br0=X1 br1=X2" {
		return "", "", fmt.Errorf("die Buchsen sind nicht getrennt (%s)", brueckenIst)
	}
	a := ip[anlagenIf]
	if a.Source != "static" || a.Ipaddr != l.k.LanNetz.Addr().String() || a.Netmask != "255.255.255.0" {
		return "", "", fmt.Errorf("Anlagennetz an X2: %s %s/%s, erwartet static %s/255.255.255.0", orKeins(a.Source), a.Ipaddr, a.Netmask, l.k.LanNetz.Addr())
	}
	k := ip[kundenIf]
	anlage = "Anlagennetz " + l.k.LanNetz.String()
	switch {
	case k.Source == "dhcp":
		return "Kundennetz, Adresse per DHCP", anlage, nil
	case k.Source == "fixip" && !nachNeustart:
		return "Kundennetz, bis zum Neustart noch die feste Adresse " + k.Ipaddr, anlage, nil
	}
	return "", "", fmt.Errorf("Kundennetz an X1: Quelle %q, erwartet dhcp", k.Source)
}

// befehlNetze trennt die Buchsen und stellt das Anlagennetz. Er läuft
// losgelöst von der Sitzung (sie endet mit dem Trennen) und nimmt alles
// zurück, wenn der Dienst die neue Adresse nicht innerhalb der Frist
// bestätigt: Dann steht das Gerät wieder mit beiden Buchsen unter der festen
// Adresse, und niemand muss an den Reset-Taster.
func (l *Lauf) befehlNetze(frist time.Duration) string {
	lan := l.k.LanNetz.Addr()
	b := lan.As4()
	b[3] = 255
	ip := fmt.Sprintf(`{"%s":{"source":"static","ipaddr":"%s","netmask":"255.255.255.0","bcast":"%s"}}`, anlagenIf, lan, netip.AddrFrom4(b))
	return `T=` + Werkzeuge + `
rm -f ` + okNetze + `
zurueck() {
  echo "ZURUECK: $1"
  $T/network_config --bridge-config --set '` + brueckenAlt + `'
  $T/network_config --fix-ip
  $T/config_default_gateway number=1 state=enabled value=` + BrueckeFest.String() + `
  exit 1
}
$T/network_config --bridge-config --set '` + bruecken + `' || { echo "FEHLER: Buchsen trennen"; exit 1; }
$T/network_config --ip-config --set '` + ip + `' || zurueck "Adresse des Anlagennetzes nicht gestellt"
$T/config_default_gateway number=1 state=enabled value=` + l.k.LanBruecke.String() + ` || zurueck "Standardweg nicht gestellt"
echo gestellt
i=0
while [ ! -e ` + okNetze + ` ] && [ "$i" -lt ` + strconv.Itoa(int(frist.Seconds())) + ` ]; do sleep 1; i=$((i + 1)); done
[ -e ` + okNetze + ` ] || zurueck "der Dienst hat die neue Adresse nicht bestaetigt"
echo bestaetigt`
}

// befehlFirewallEin schaltet die Firewall ein und wieder aus, wenn der Dienst
// nicht innerhalb der Frist mit einer NEUEN Anmeldung bestätigt, dass er noch
// hineinkommt. (Die laufende Sitzung sagt darüber nichts: Sie gilt der
// Firewall als bestehende Verbindung.)
func befehlFirewallEin(frist time.Duration) string {
	return `T=` + Werkzeuge + `
rm -f ` + okFirewall + `
$T/firewall firewall --enable || { echo "FEHLER: Firewall einschalten"; $T/firewall firewall --disable; exit 1; }
echo eingeschaltet
i=0
while [ ! -e ` + okFirewall + ` ] && [ "$i" -lt ` + strconv.Itoa(int(frist.Seconds())) + ` ]; do sleep 1; i=$((i + 1)); done
if [ ! -e ` + okFirewall + ` ]; then
  $T/firewall firewall --disable
  echo "ZURUECK: der Dienst hat die Anmeldung mit eingeschalteter Firewall nicht bestaetigt"
  exit 1
fi
echo bestaetigt`
}

// los ist der Anfang eines Befehls, der das Ende seiner Sitzung überlebt:
// SIGHUP gilt schon in der Shell der Sitzung als ignoriert, damit auch der
// Augenblick zwischen dem Abzweigen und dem Start von nohup gedeckt ist.
const los = "trap '' HUP\nnohup sh -c "

// starteLos startet einen Befehl losgelöst von der Sitzung; Ausgabe und
// Ausgang liegen danach unter /tmp/vp-werkstatt-<name>.aus und .rc.
func (l *Lauf) starteLos(ctx context.Context, name, befehl string) error {
	aus, rc := "/tmp/vp-werkstatt-"+name+".aus", "/tmp/vp-werkstatt-"+name+".rc"
	_, err := l.fuehre(ctx, "rm -f "+aus+" "+rc+"\n"+los+shellWort("( "+befehl+"\n) >"+aus+" 2>&1; echo $? >"+rc)+" >/dev/null 2>&1 </dev/null &", "")
	if errors.Is(err, box.Abgerissen) {
		return nil
	}
	return err
}

// ergebnisLos wartet auf das Ende eines losgelösten Befehls und gibt seine
// Ausgabe zurück; Fehler, wenn er nicht mit 0 endete.
func (l *Lauf) ergebnisLos(ctx context.Context, name string, frist time.Duration) (string, error) {
	aus, rc := "/tmp/vp-werkstatt-"+name+".aus", "/tmp/vp-werkstatt-"+name+".rc"
	var text, code string
	err := l.warteAuf(ctx, frist, func() error {
		roh, err := l.lies(ctx, "cat "+rc+" 2>/dev/null; echo ---; cat "+aus+" 2>/dev/null")
		if err != nil {
			return err
		}
		c, t, _ := strings.Cut(roh, "---")
		code, text = strings.TrimSpace(c), strings.TrimSpace(t)
		if code == "" {
			return errors.New("der Befehl auf dem Gerät ist noch nicht fertig")
		}
		return nil
	})
	if err != nil {
		return text, err
	}
	_, _ = l.fuehre(ctx, "rm -f "+aus+" "+rc, "")
	if code != "0" {
		return text, fmt.Errorf("auf dem Gerät endete %s mit %s: %s", name, code, letzte(text, 3))
	}
	return text, nil
}

// findeImLan wartet, bis das Gerät unter der Adresse des Anlagennetzes
// antwortet, und meldet sich dort an. Gibt die MAC zurück, die die Brücke dort
// sieht (nach dem Trennen der Buchsen eine andere als unter der festen Adresse).
func (l *Lauf) findeImLan(ctx context.Context, frist time.Duration) (string, error) {
	ziel := l.zielLan()
	mac := ""
	err := l.warteAuf(ctx, frist, func() error {
		s, err := l.k.Werkbank.Status(ctx)
		if err != nil {
			return err
		}
		adresse, m, err := Einzeln(s)
		if err != nil {
			return err
		}
		if adresse != ziel.Addr() {
			return fmt.Errorf("Gerät unter %s statt %s", adresse, ziel.Addr())
		}
		mac = m
		return l.neuVerbinden(ctx, ziel, l.k.Zeiten.Verbinden)
	})
	if err == nil {
		l.mac = mac
	}
	return mac, err
}

// fwRegel ist eine Regel des Benutzerfilters in der Ausgabe der Firewall.
type fwRegel struct {
	State   string `xml:"state,attr"`
	If      string `xml:"if,attr"`
	Proto   string `xml:"proto,attr"`
	DstPort string `xml:"dst_port,attr"`
	Policy  string `xml:"policy,attr"`
}

type fwXML struct {
	IPv4 struct {
		Forward struct {
			State string `xml:"state,attr"`
		} `xml:"forward"`
		Input struct {
			Filter struct {
				Regeln []fwRegel `xml:"rule"`
			} `xml:"filter"`
		} `xml:"input"`
	} `xml:"ipv4"`
}

// hat sagt, ob der Benutzerfilter den Port an der Schnittstelle zulässt.
func (f fwXML) hat(schnittstelle string, port int) bool {
	for _, r := range f.IPv4.Input.Filter.Regeln {
		if r.State == "on" && (r.If == schnittstelle || r.If == altName(schnittstelle)) && strings.HasPrefix(r.Proto, "tcp") &&
			r.DstPort == strconv.Itoa(port) && r.Policy == "accept" {
			return true
		}
	}
	return false
}

func (l *Lauf) firewallXML(ctx context.Context) (fwXML, error) {
	var f fwXML
	erg, err := l.fuehre(ctx, Werkzeuge+"/firewall iptables --get-xml", "")
	if err != nil {
		return f, err
	}
	if err := xml.Unmarshal([]byte(erg.Aus), &f); err != nil {
		return f, fmt.Errorf("Einstellungen der Firewall nicht lesbar: %v", err)
	}
	return f, nil
}

// fwDienste liest, welche Dienste an welcher Schnittstelle offen sind.
func (l *Lauf) fwDienste(ctx context.Context) (map[string][]string, []string, error) {
	erg, err := l.fuehre(ctx, Werkzeuge+"/firewall services --get-ifs-status json", "")
	if err != nil {
		return nil, nil, err
	}
	var roh struct {
		Interfaces map[string]struct {
			Services map[string]struct {
				State string `json:"state"`
			} `json:"services"`
		} `json:"interfaces"`
	}
	if err := json.Unmarshal([]byte(erg.Aus), &roh); err != nil {
		return nil, nil, fmt.Errorf("Dienste der Firewall nicht lesbar: %v", err)
	}
	offen := map[string][]string{}
	alle := map[string]bool{}
	for _, name := range []string{kundenIf, anlagenIf} {
		i, ok := roh.Interfaces[altName(name)]
		if !ok {
			i, ok = roh.Interfaces[name]
		}
		if !ok {
			return nil, nil, fmt.Errorf("die Firewall nennt die Schnittstelle %s (%s) nicht", name, altName(name))
		}
		offen[name] = []string{}
		for d, s := range i.Services {
			alle[d] = true
			if s.State == "on" {
				offen[name] = append(offen[name], d)
			}
		}
		sort.Strings(offen[name])
	}
	var liste []string
	for d := range alle {
		liste = append(liste, d)
	}
	sort.Strings(liste)
	return offen, liste, nil
}

func (l *Lauf) netzeStellen(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}
	z := l.k.Zeiten

	// 1. Buchsen trennen, Anlagennetz stellen: losgelöst, mit Rücknahme.
	if err := l.starteLos(ctx, "netze", l.befehlNetze(z.Netz+z.Verbinden)); err != nil {
		return b, err
	}
	l.v.Schliesse()
	l.v = nil
	mac, err := l.findeImLan(ctx, z.Netz)
	if err != nil {
		// Das Gerät stellt sich selbst zurück. Dort nachlesen, was es sagt.
		text := ""
		if rerr := l.warteAuf(ctx, z.Netz+2*z.Verbinden, func() error {
			return l.neuVerbinden(ctx, netip.AddrPortFrom(FesteAdresse, 22), z.Verbinden)
		}); rerr == nil {
			text, _ = l.lies(ctx, "cat /tmp/vp-werkstatt-netze.aus 2>/dev/null")
		}
		return b.Mit("zurueckgestellt", orKeins(letzte(text, 4))),
			fmt.Errorf("nach dem Trennen der Buchsen antwortet das Gerät nicht unter %s (%v); es hat die Netze zurückgestellt", l.k.LanNetz.Addr(), err)
	}
	b = b.Mit("mac", mac).Mit("adresse", l.k.LanNetz.Addr().String())
	if _, err := l.fuehre(ctx, "touch "+okNetze, ""); err != nil {
		return b, err
	}
	if _, err := l.ergebnisLos(ctx, "netze", z.Netz); err != nil {
		return b, err
	}
	ist, ip, err := l.netzStand(ctx)
	if err != nil {
		return b, err
	}
	kunde, anlage, err := l.netzeSoll(ist, ip, false)
	b = b.Mit("bruecken", ist).Mit("kundennetz", kunde).Mit("anlagennetz", anlage)
	if err != nil {
		return b, err
	}
	w, err := l.werte(ctx, `echo "weg=$(ip -4 route show default 2>/dev/null | head -n 1)"`)
	if err != nil {
		return b, err
	}
	b = b.Mit("weg_werkstatt", w["weg"]+" (über die Brücke, bis Schritt internet_weg)")
	if !strings.Contains(w["weg"], "via "+l.k.LanBruecke.String()) {
		return b, fmt.Errorf("Standardweg %q, erwartet über die Brücke %s", w["weg"], l.k.LanBruecke)
	}

	// 2. Firewall: erst die Einstellungen (sie ist dabei aus), dann einschalten.
	_, dienste, err := l.fwDienste(ctx)
	if err != nil {
		return b, err
	}
	for _, d := range DiensteAnlagennetz {
		if !enthaelt(dienste, d) {
			return b, fmt.Errorf("die Firewall des Geräts kennt den Dienst %s nicht (%s)", d, strings.Join(dienste, ", "))
		}
	}
	fx, err := l.firewallXML(ctx)
	if err != nil {
		return b, err
	}
	var s strings.Builder
	s.WriteString("T=" + Werkzeuge + "\n$T/firewall firewall --disable || exit 1\n")
	for _, d := range dienste {
		an := "off"
		if enthaelt(DiensteAnlagennetz, d) {
			an = "on"
		}
		s.WriteString("$T/firewall " + d + " --set-if off " + kundenIf + " || { echo 'FEHLER: " + d + " " + kundenIf + "'; exit 1; }\n")
		s.WriteString("$T/firewall " + d + " --set-if " + an + " " + anlagenIf + " || { echo 'FEHLER: " + d + " " + anlagenIf + "'; exit 1; }\n")
	}
	for _, i := range []string{kundenIf, anlagenIf} {
		for _, p := range []int{portWebApp, portOCPP} {
			if !fx.hat(i, p) {
				s.WriteString(fmt.Sprintf("$T/firewall iptables --add-filter on %s tcp - - - - - %d accept || { echo 'FEHLER: Filter %s %d'; exit 1; }\n", i, p, i, p))
			}
		}
	}
	s.WriteString("$T/firewall iptables --set-forward off || { echo 'FEHLER: Weiterleitung'; exit 1; }\necho eingestellt")
	if _, err := l.fuehre(ctx, s.String(), ""); err != nil {
		return b, fmt.Errorf("Firewall einstellen: %w", err)
	}
	if err := l.starteLos(ctx, "firewall", befehlFirewallEin(z.Firewall)); err != nil {
		return b, err
	}
	// Die Bestätigung kommt über eine NEUE Anmeldung: Nur sie zeigt, dass SSH
	// am Anlagennetz mit eingeschalteter Firewall offen ist.
	err = l.warteAuf(ctx, z.Firewall/2, func() error {
		if err := l.neuVerbinden(ctx, l.zielLan(), z.Verbinden); err != nil {
			return err
		}
		w, err := l.werte(ctx, `echo "an=$(`+Werkzeuge+`/firewall firewall --is-enabled 2>/dev/null)"`)
		if err != nil {
			return err
		}
		if w["an"] != "enabled" {
			return errors.New("die Firewall ist noch nicht eingeschaltet")
		}
		_, err = l.fuehre(ctx, "touch "+okFirewall, "")
		return err
	})
	if err != nil {
		// Das Gerät schaltet die Firewall selbst wieder aus; dann kommt der Dienst wieder hinein.
		_ = l.warteAuf(ctx, z.Firewall+2*z.Verbinden, func() error { return l.neuVerbinden(ctx, l.zielLan(), z.Verbinden) })
		return b.Mit("firewall", "wieder aus"), fmt.Errorf("mit eingeschalteter Firewall nimmt das Gerät am Anlagennetz keine neue Anmeldung an (%v); es hat sie wieder ausgeschaltet", err)
	}
	if _, err := l.ergebnisLos(ctx, "firewall", z.Netz); err != nil {
		return b, err
	}

	// 3. Belege aus dem, was das Gerät jetzt sagt.
	offen, _, err := l.fwDienste(ctx)
	if err != nil {
		return b, err
	}
	fx, err = l.firewallXML(ctx)
	if err != nil {
		return b, err
	}
	w, err = l.werte(ctx, `T=`+Werkzeuge+`
echo "an=$($T/firewall firewall --is-enabled 2>/dev/null)"
echo "weiter=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"
echo "docker=$($T/get_docker_config activation-status 2>/dev/null)"
echo "docker_laeuft=$(if pidof dockerd >/dev/null 2>&1; then echo ja; else echo nein; fi)"`)
	if err != nil {
		return b, err
	}
	b = b.Mit("firewall", w["an"]).Mit("dienste_x1", orKeins(strings.Join(offen[kundenIf], ", "))).Mit("dienste_x2", strings.Join(offen[anlagenIf], ", ")).
		Mit("weiterleitung", "Firewall "+fx.IPv4.Forward.State+", Kern "+w["weiter"]).Mit("docker", w["docker"]+", Dienst läuft: "+w["docker_laeuft"])
	var f []string
	if w["an"] != "enabled" {
		f = append(f, "Firewall "+orKeins(w["an"]))
	}
	if len(offen[kundenIf]) != 0 {
		f = append(f, "am Kundennetz offen: "+strings.Join(offen[kundenIf], ", "))
	}
	if strings.Join(offen[anlagenIf], ",") != strings.Join(DiensteAnlagennetz, ",") {
		f = append(f, "am Anlagennetz offen: "+strings.Join(offen[anlagenIf], ", ")+", Soll "+strings.Join(DiensteAnlagennetz, ", "))
	}
	for _, i := range []string{kundenIf, anlagenIf} {
		for _, p := range []int{portWebApp, portOCPP} {
			if !fx.hat(i, p) {
				f = append(f, fmt.Sprintf("Port %d an %s nicht zugelassen", p, altName(i)))
			}
		}
	}
	if fx.IPv4.Forward.State != "off" || w["weiter"] != "0" {
		f = append(f, "Weiterleitung zwischen den Buchsen nicht aus")
	}
	if w["docker"] == "active" || w["docker_laeuft"] == "ja" {
		f = append(f, "Docker läuft")
	}
	if len(f) > 0 {
		return b, errors.New("Firewall nicht im Soll: " + strings.Join(f, "; "))
	}
	b = b.Mit("zugelassen", fmt.Sprintf("Web-App %d und OCPP %d an X1 und X2", portWebApp, portOCPP))

	// Von außen, am Anlagennetz: Die Web-App antwortet, Modbus 502 der Steuerung nicht.
	lan := l.k.LanNetz.Addr()
	if c, err := l.dial(ctx, netip.AddrPortFrom(lan, portWebApp)); err != nil {
		return b, fmt.Errorf("die Web-App der Box ist am Anlagennetz nicht erreichbar: %w", err)
	} else {
		_ = c()
	}
	if c, err := l.dial(ctx, netip.AddrPortFrom(lan, portModbus)); err == nil {
		_ = c()
		return b.Mit("modbus_502_von_aussen", "erreichbar"), errors.New("Modbus 502 der Steuerung ist am Anlagennetz von außen erreichbar")
	} else if strings.Contains(err.Error(), "nicht erreichbar") && strings.HasPrefix(err.Error(), "Brücke ") {
		return b, err // die Brücke selbst ist weg: kein Urteil
	}
	b = b.Mit("von_aussen_x2", fmt.Sprintf("Web-App %d antwortet, Modbus %d nicht", portWebApp, portModbus))

	// 4. Start nur vom internen Speicher: Eine Speicherkarte mit System
	// übernimmt das Gerät sonst beim nächsten Start.
	if _, err := l.fuehre(ctx, Werkzeuge+"/config_boot_mode --force_internal_boot enabled", ""); err != nil {
		return b, fmt.Errorf("Start nur vom internen Speicher: %w", err)
	}
	erg, err := l.fuehre(ctx, Werkzeuge+"/get_boot_mode --force_internal_boot", "")
	if err != nil {
		return b, err
	}
	if s := strings.TrimSpace(erg.Aus); s != "enabled" {
		return b.Mit("start_intern", s), fmt.Errorf("Start nur vom internen Speicher ist nach dem Einschalten %q", s)
	}
	b = b.Mit("start_intern", "enabled")
	l.belege["netze"] = "Schritt netze und neustart: Buchsen getrennt (br0 = X1 Kundennetz per DHCP, br1 = X2 " + anlage + "), nach dem Neustart so wieder gelesen; Weiterleitung aus (Firewall und Kern)"
	l.belege["dienste_zu"] = "Schritt netze: Firewall ein; am Kundennetz X1 kein Dienst des Geräts offen, am Anlagennetz X2 nur " + strings.Join(DiensteAnlagennetz, ", ") +
		fmt.Sprintf("; dazu Web-App %d und OCPP %d; Modbus %d von außen nicht erreichbar; Docker aus; Start nur vom internen Speicher", portWebApp, portOCPP, portModbus)
	return b, nil
}

// dial öffnet eine Verbindung durch die Brücke und gibt ihr Schließen zurück.
func (l *Lauf) dial(ctx context.Context, ziel netip.AddrPort) (func() error, error) {
	dctx, cancel := context.WithTimeout(ctx, l.k.Zeiten.Verbinden)
	defer cancel()
	c, err := l.k.Werkbank.Dial(dctx, ziel)
	if err != nil {
		return nil, err
	}
	return c.Close, nil
}

func enthaelt(liste []string, s string) bool {
	for _, x := range liste {
		if x == s {
			return true
		}
	}
	return false
}

// ---- Neustart-Probe ---------------------------------------------------------------------

const vorNeustart = "/tmp/vp-werkstatt-vor-neustart"

// neustartProbe startet das Gerät neu und prüft, was danach von selbst wieder
// da ist. Die SPS fasst der Dienst dabei nicht an: Er lädt und startet kein
// Programm und prüft keines.
func (l *Lauf) neustartProbe(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
	beginn := time.Now()
	// /tmp liegt im Arbeitsspeicher: Die Marke ist nach einem echten Neustart weg.
	if _, err := l.fuehre(ctx, "touch "+vorNeustart+" && sync", ""); err != nil {
		return nil, err
	}
	if _, err := l.fuehre(ctx, los+"'sleep 1; reboot' >/dev/null 2>&1 </dev/null &", ""); err != nil && !errors.Is(err, box.Abgerissen) {
		return nil, err
	}
	l.v.Schliesse()
	l.v = nil
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(3 * l.k.Zeiten.Takt):
	}
	var mac string
	err := l.warteAuf(ctx, l.k.Zeiten.Neustart, func() error {
		var err error
		if mac, err = l.findeImLan(ctx, 0); err != nil {
			return err
		}
		w, err := l.werte(ctx, `echo "marke=$(if [ -e `+vorNeustart+` ]; then echo da; else echo weg; fi)"`)
		if err != nil {
			return err
		}
		if w["marke"] != "weg" {
			return errors.New("das Gerät hat noch nicht neu gestartet")
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("nach dem Neustart antwortet das Gerät nicht unter %s: %w", l.k.LanNetz.Addr(), err)
	}
	b := protokoll.Beleg{}.Mit("dauer_bis_antwort", time.Since(beginn).Round(time.Second).String()).Mit("mac", mac).
		Mit("host_schluessel", l.hostArt+" "+l.v.HostFingerabdruck()+" (derselbe wie vor dem Neustart)")
	var w map[string]string
	// Die Dienste starten nach dem SSH-Dienst: kurz Geduld.
	err = l.warteAuf(ctx, l.k.Zeiten.Programm, func() error {
		var err error
		w, err = l.werte(ctx, `T=`+Werkzeuge+`
echo "ref=$(cat `+geraetRef+` 2>/dev/null)"
echo "start=$(ls /etc/rc.d 2>/dev/null | grep vp- | tr '\n' ' ')"
echo "edge=$(if `+dienstEdge+` status >/dev/null 2>&1; then echo laeuft; else echo steht; fi)"
echo "wartung=$(if `+dienstWartung+` status >/dev/null 2>&1; then echo laeuft; else echo steht; fi)"
echo "schalter=$($T/get_run_stop_switch_value 2>/dev/null)"
echo "firewall=$($T/firewall firewall --is-enabled 2>/dev/null)"
echo "start_intern=$($T/get_boot_mode --force_internal_boot 2>/dev/null)"
echo "ssh_passwort=$($T/get_ssh_config password-request-state 2>/dev/null)"
echo "zeitabgleich=$($T/get_ntp_config state 2>/dev/null)"
echo "docker_laeuft=$(if pidof dockerd >/dev/null 2>&1; then echo ja; else echo nein; fi)"`)
		if err != nil {
			return err
		}
		if w["edge"] != "laeuft" || w["wartung"] != "laeuft" {
			return fmt.Errorf("Dienste nach dem Neustart: %s %s, Tunnel %s", Name, w["edge"], w["wartung"])
		}
		return nil
	})
	b = b.Mit("referenz", w["ref"]).Mit("startdienste", w["start"]).Mit("dienste", Name+" "+w["edge"]+", Tunnel "+w["wartung"]).
		Mit("firewall", w["firewall"]).Mit("start_intern", w["start_intern"]).Mit("passwort_anmeldung", w["ssh_passwort"]).Mit("zeitabgleich", w["zeitabgleich"])
	if err != nil {
		return b, err
	}
	switch {
	case w["ref"] != l.ref:
		return b, fmt.Errorf("Referenz nach dem Neustart %q, vorher %s", w["ref"], l.ref)
	case !strings.Contains(w["start"], "vp-edge-industrie") || !strings.Contains(w["start"], "vp-wartung"):
		return b, errors.New(Name + " oder der Tunnel starten nicht mit dem Gerät (" + w["start"] + ")")
	case w["firewall"] != "enabled":
		return b, fmt.Errorf("die Firewall ist nach dem Neustart %q", w["firewall"])
	case w["start_intern"] != "enabled":
		return b, fmt.Errorf("Start nur vom internen Speicher ist nach dem Neustart %q", w["start_intern"])
	case w["ssh_passwort"] != "disabled":
		return b, fmt.Errorf("die Anmeldung mit Passwort ist nach dem Neustart %q", w["ssh_passwort"])
	case w["docker_laeuft"] == "ja":
		return b, errors.New("nach dem Neustart läuft Docker")
	}
	ist, ip, err := l.netzStand(ctx)
	if err != nil {
		return b, err
	}
	kunde, anlage, err := l.netzeSoll(ist, ip, true)
	b = b.Mit("bruecken", ist).Mit("kundennetz", kunde).Mit("anlagennetz", anlage)
	if err != nil {
		return b, fmt.Errorf("Netze nach dem Neustart: %w", err)
	}
	fps, err := l.dauerhafteSchluessel(ctx)
	if err != nil {
		return b, err
	}
	b = b.Mit("dauerhafte_schluessel", fmt.Sprintf("%d (Notfall-Schlüssel %s und der Lauf-Schlüssel bis zum Schritt internet_weg)", len(fps), l.notfallFP))
	if len(fps) != 2 || !enthaelt(fps, l.notfallFP) {
		return b, fmt.Errorf("dauerhafte Schlüssel nach dem Neustart: %s", strings.Join(fps, ", "))
	}
	st, err := l.tunnelPruefen(ctx, 2)
	b = append(b, st...)
	if err != nil {
		return b, fmt.Errorf("Tunnel nach dem Neustart: %w", err)
	}
	// Ausgeliefert wird mit dem Schalter auf RUN: Auf STOP liefe beim Kunden kein Programm.
	schalter := w["schalter"]
	if schalter != "run" {
		err := k.WarteBis(ctx, "schalter_run", faelle.PFCSchalterStop, SchalterAufRun, l.k.Zeiten.Takt, func(ctx context.Context) (bool, error) {
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
	b = b.Mit("schalter", "run")
	l.belege["neustart"] = "Schritt neustart: Tunnel wieder oben (frischer Handshake), dieselbe Referenz, derselbe Host-Schlüssel, " + Name + " und Tunnel laufen, Netze und Firewall wie gestellt, Schalter auf RUN"
	return b, nil
}

// ---- Werkstatt-Internet und Lauf-Schlüssel entfernen ---------------------------------------

func (l *Lauf) internetWeg(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	var s strings.Builder
	s.WriteString("T=" + Werkzeuge + "\n$T/config_default_gateway number=1 state=disabled || exit 1\n")
	for _, d := range l.dnsGesetzt {
		s.WriteString("$T/edit_dns_server delete=delete dns-server-name=" + d + " || exit 1\n")
	}
	s.WriteString(`echo "gateway=$($T/get_default_gateway_config state 2>/dev/null)"
echo "dns=$($T/get_dns_server all 2>/dev/null)"
echo "weg=$(ip -4 route show default 2>/dev/null | head -n 1)"`)
	w, err := l.werte(ctx, s.String())
	if err != nil {
		return nil, err
	}
	b := protokoll.Beleg{}.Mit("gateway", w["gateway"]).Mit("dns", w["dns"]).Mit("standardweg", orKeins(w["weg"]))
	rest, err := dnsListe(w["dns"])
	if err != nil {
		return b, err
	}
	for _, d := range l.dnsGesetzt {
		if enthaelt(rest, d) {
			return b, fmt.Errorf("der DNS-Server %s der Werkstatt steht noch in den Einstellungen", d)
		}
	}
	if w["gateway"] != "disabled" || w["weg"] != "" {
		return b, errors.New("der Weg über die Brücke steht noch in den Einstellungen")
	}

	// Zuletzt der Lauf-Schlüssel: Danach kommt auch der Dienst nicht mehr hinein.
	if err := l.schreibeSchluessel(ctx, strings.TrimSpace(l.k.Notfall)); err != nil {
		return b, err
	}
	fps, err := l.dauerhafteSchluessel(ctx)
	if err != nil {
		return b, err
	}
	b = b.Mit("dauerhafte_schluessel", fmt.Sprintf("%d (%s)", len(fps), strings.Join(fps, ", ")))
	if len(fps) != 1 || fps[0] != l.notfallFP {
		return b, fmt.Errorf("dauerhafte Schlüssel auf dem Gerät: %d (%s), erwartet genau der Notfall-Schlüssel %s", len(fps), strings.Join(fps, ", "), l.notfallFP)
	}
	v, err := box.VerbindeMit(ctx, l.k.Werkbank, l.ziel, []ssh.AuthMethod{ssh.PublicKeys(l.laufSchluessel)}, box.GenauDieser(l.host), l.k.Zeiten.Verbinden)
	if err == nil {
		v.Schliesse()
		return b, errors.New("das Gerät nimmt den Lauf-Schlüssel weiter an")
	} else if !errors.As(err, new(box.Abgewiesen)) {
		return b, fmt.Errorf("Probe mit dem entfernten Lauf-Schlüssel: %w", err)
	}
	b = b.Mit("lauf_schluessel", "entfernt, neue Anmeldung damit abgewiesen")
	l.mitSchluessel = false
	l.belege["notfall_schluessel"] = "Schritt notfall und internet_weg: genau eine Zeile, Fingerabdruck " + l.notfallFP + "; der Schlüssel des Laufs ist entfernt und wird abgewiesen"
	return b.Mit("ergebnis", "beim Kunden geht das Gerät nur über die Buchse X1 ins Netz (Adresse per DHCP)"), nil
}

// ---- Übergabe ------------------------------------------------------------------------------

// Pruefungen der Werkstatt-Regel für den PFC200, in ihrer Reihenfolge. Ohne
// Prüfung der SPS (Programm, Koppelprobe) und ohne Prüfung der Firmware: Ihr
// Stand steht als Angabe an der Abnahme.
var Pruefungen = []string{"zugaenge", "notfall_schluessel", "tunnel_status", "anmeldeprobe", "host_schluessel", "fenster_zu", "netze", "dienste_zu", "neustart", "update_bereit"}

func (l *Lauf) uebergabe(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
	b := protokoll.Beleg{}.
		Mit("referenz", l.ref).
		Mit("fassung", l.version).
		Mit("host_schluessel", l.host).
		Mit("tunnel_adresse", l.tunnelAdresse).
		Mit("lan_netz", l.k.LanNetz.String()).
		Mit("geraet", "WAGO "+Artikel).
		Mit("firmware", l.firmware+" (nur Angabe: Der Dienst prüft und ändert die Firmware nicht)").
		Mit("seriennummer", l.seriennummer)
	if !l.probeAutomatisch {
		l.belege["host_schluessel"] += "; Tunnel-Weg: bei der Probe im Portal gelesen und verglichen (Schritt probe)"
	}
	if l.belege["update_bereit"] == "" {
		// Entscheid 5c als Prüfung: ohne Update-Bereitschaft keine Abnahme.
		grund := l.nichtBereit
		if grund == "" {
			grund = "nicht geprüft"
		}
		return b, fmt.Errorf("die Box ist nicht update-bereit (%s) - keine Abnahme (Entscheid 5c)", grund)
	}
	belege := map[string]string{}
	for _, p := range Pruefungen {
		if l.belege[p] == "" {
			return b, fmt.Errorf("für die Prüfung %s gibt es keinen Beleg - keine Abnahme", p)
		}
		b = b.Mit("pruefung_"+p, l.belege[p])
		belege[p] = l.belege[p]
	}
	if l.k.Portal != nil {
		// Die Abnahme mit den Belegen; die drei Passwörter nur verschlüsselt.
		an, err := l.k.Portal.AbnahmeSchreiben(ctx, l.ref, portal.Abnahme{Fassung: l.version, HostSchluessel: l.host,
			LanNetz: l.k.LanNetz.String(), Belege: belege, PasswortAge: l.passwortAge, Geraet: freigabe.PFC200,
			Angaben: map[string]string{"artikel": Artikel, "firmware": l.firmware, "seriennummer": l.seriennummer}})
		if err != nil {
			return b, fmt.Errorf("Abnahme im Portal: %w", err)
		}
		b = b.Mit("abnahme", an.ID+" (Freigabe "+an.FreigabeID+", Einlösung "+an.EinloesungID+")")
	}
	return b.Mit("zugaenge", HinweisZugaenge).Mit("codesys", HinweisCodesys).Mit("versand", HinweisVersand), nil
}
