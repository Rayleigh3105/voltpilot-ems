package suche

import (
	"context"
	"encoding/xml"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// Network gear (router, access point) is shown, never adopted: only maker,
// model and address leave the box (contract §6 "Datenschutz"). The words come
// from fixed patterns - a page title or a device description can carry a name
// a person chose, and only the matched model text is kept.

// netztechnik reads, in this order, the SSDP device description (Edge Light),
// the page title of port 80, and the vendor list of the radio module.
func (l *Lauf) netztechnik(ctx context.Context, g *geraet) (geraetesuche.Fund, bool) {
	b := g.budget()
	gateway := l.istGateway(g.ip)
	if g.hinweis.ssdp != "" {
		if f, ok := ssdpBeschreibung(ctx, g, b, gateway); ok {
			return f, true
		}
	}
	if g.offen[80] {
		if f, ok := seitentitel(ctx, g, b, gateway); ok {
			return f, true
		}
	}
	if g.hinweis.funkmodul == "avm" || (gateway && g.hinweis.funkmodul != "" && g.hinweis.funkmodul != "espressif") {
		art := "zugangspunkt"
		if gateway {
			art = "router"
		}
		return geraetesuche.Fund{Schluessel: "netztechnik:" + adresse(g, 80), Erkenner: "netztechnik", Art: art,
			Hersteller: g.hinweis.funkmodul, Erkennung: geraetesuche.ErkennungWahrscheinlich,
			Merkmale:   []string{"funkmodul_" + strings.ReplaceAll(g.hinweis.funkmodul, "-", "_")},
			Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: 80}}, true
	}
	return geraetesuche.Fund{}, false
}

func (l *Lauf) istGateway(ip netip.Addr) bool {
	for _, w := range l.wahl {
		if w.gateway.IsValid() && w.gateway == ip {
			return true
		}
	}
	return false
}

// ssdpBeschreibung reads the device description an SSDP answer pointed to -
// only on the answering device itself, only plain HTTP.
func ssdpBeschreibung(ctx context.Context, g *geraet, b *budget, gateway bool) (geraetesuche.Fund, bool) {
	u, err := url.Parse(g.hinweis.ssdp)
	if err != nil || u.Scheme != "http" {
		return geraetesuche.Fund{}, false
	}
	host, portText, err := net.SplitHostPort(u.Host)
	if err != nil {
		host, portText = u.Host, "80"
	}
	port, err := strconv.Atoi(portText)
	if ip, ok := ipVon(host); !ok || ip != g.ip || err != nil || port < 1 || port > 65535 {
		return geraetesuche.Fund{}, false
	}
	pfad := u.EscapedPath()
	if pfad == "" {
		pfad = "/"
	}
	if u.RawQuery != "" {
		pfad += "?" + u.RawQuery
	}
	a, err := b.get(ctx, port, pfad)
	if err != nil || a.status != 200 {
		return geraetesuche.Fund{}, false
	}
	var doc struct {
		Device struct {
			DeviceType   string `xml:"deviceType"`
			Manufacturer string `xml:"manufacturer"`
			ModelName    string `xml:"modelName"`
		} `xml:"device"`
	}
	if xml.Unmarshal(a.body, &doc) != nil {
		return geraetesuche.Fund{}, false
	}
	d := doc.Device
	art := ""
	modell := strings.ToUpper(d.ModelName)
	switch {
	case strings.Contains(modell, "FRITZ!REPEATER"), strings.Contains(modell, "FRITZ!POWERLINE"),
		strings.Contains(modell, "FRITZ!WLAN"), strings.Contains(d.DeviceType, "WLANAccessPoint"):
		art = "zugangspunkt"
	case strings.Contains(modell, "FRITZ!BOX"), strings.Contains(d.DeviceType, "InternetGatewayDevice"), gateway:
		art = "router"
	default:
		return geraetesuche.Fund{}, false
	}
	merkmal := "ssdp_beschreibung"
	if strings.Contains(strings.ToLower(u.Path), "fboxdesc") {
		merkmal = "ssdp_fboxdesc"
	}
	return geraetesuche.Fund{Schluessel: "netztechnik:" + adresse(g, port), Erkenner: "netztechnik", Art: art,
		Hersteller: hersteller(d.Manufacturer), Modell: sauber(d.ModelName),
		Erkennung: geraetesuche.ErkennungWahrscheinlich, Merkmale: []string{merkmal},
		Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: port}}, true
}

// titelMuster are the page titles of network gear. modell is the MATCHED text
// only ("" = keep no model): a title may carry more.
var titelMuster = []struct {
	re         *regexp.Regexp
	art        string // "" = router when it is the gateway, else access point
	hersteller string
	modell     bool
}{
	{regexp.MustCompile(`FRITZ!Box(?: [0-9]{4}[A-Za-z0-9 ]{0,12})?`), "router", "avm", true},
	{regexp.MustCompile(`FRITZ!Repeater(?: [0-9A-Za-z ]{1,16})?`), "zugangspunkt", "avm", true},
	{regexp.MustCompile(`FRITZ!Powerline(?: [0-9A-Za-z ]{1,16})?`), "zugangspunkt", "avm", true},
	{regexp.MustCompile(`Speedport(?: [A-Za-z0-9]{1,12}){0,2}`), "router", "telekom", true},
	{regexp.MustCompile(`Vodafone Station`), "router", "vodafone", true},
	{regexp.MustCompile(`EasyBox(?: [0-9]{3})?`), "router", "vodafone", true},
	{regexp.MustCompile(`GL\.iNet`), "router", "gl-inet", false},
	{regexp.MustCompile(`OpenWrt|LuCI`), "router", "openwrt", false},
	{regexp.MustCompile(`UniFi`), "zugangspunkt", "ubiquiti", false},
	{regexp.MustCompile(`(?i)tp-?link|Omada`), "", "tp-link", false},
}

var titelRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)

// seitentitel reads the title of the start page (one GET on "/").
func seitentitel(ctx context.Context, g *geraet, b *budget, gateway bool) (geraetesuche.Fund, bool) {
	a, err := b.get(ctx, 80, "/")
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	t := titelRe.FindSubmatch(a.body)
	if t == nil {
		return geraetesuche.Fund{}, false
	}
	titel := strings.TrimSpace(string(t[1]))
	for _, m := range titelMuster {
		treffer := m.re.FindString(titel)
		if treffer == "" {
			continue
		}
		art := m.art
		if art == "" {
			art = "zugangspunkt"
			if gateway {
				art = "router"
			}
		}
		f := geraetesuche.Fund{Schluessel: "netztechnik:" + adresse(g, 80), Erkenner: "netztechnik", Art: art,
			Hersteller: m.hersteller, Erkennung: geraetesuche.ErkennungWahrscheinlich,
			Merkmale:   []string{"seitentitel"},
			Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: 80}}
		if m.modell {
			f.Modell = sauber(treffer)
		}
		return f, true
	}
	return geraetesuche.Fund{}, false
}

// ---------------------------------------------------------------- weitere

// weitereArt sorts an address that answered but is no find. Edge Light knows
// two hints: a randomised (locally administered) MAC is what phones and
// tablets use in a Wi-Fi today, and the mDNS services a device announces. The
// words are counts only - never a find (DP-3 A).
func weitereArt(g *geraet) string {
	switch {
	case g.hinweis.mdns["telefon"]:
		return "telefon_tablet"
	case g.hinweis.mdns["rechner"]:
		return "rechner"
	case len(g.mac) == 6 && g.mac[0]&0x02 != 0:
		return "telefon_tablet"
	}
	return "unbekannt"
}

// ---------------------------------------------------------------- vendor list

// funkmodulListe is the built-in vendor list of radio modules (Edge Light):
// the first three bytes of a MAC (OUI) to a maker. It never goes to a service;
// a hit is a hint (a merkmal), never an identity. General knowledge (IEEE OUI
// register), checked on real hardware in package 5.
var funkmodulListe = map[[3]byte]string{
	// Espressif (ESP8266/ESP32: Shelly, go-e, OpenDTU, many loggers)
	{0x24, 0x0A, 0xC4}: "espressif", {0x30, 0xAE, 0xA4}: "espressif", {0x84, 0xF3, 0xEB}: "espressif",
	{0xA4, 0xCF, 0x12}: "espressif", {0xBC, 0xDD, 0xC2}: "espressif", {0xEC, 0xFA, 0xBC}: "espressif",
	{0x24, 0x62, 0xAB}: "espressif", {0x3C, 0x71, 0xBF}: "espressif", {0x8C, 0xAA, 0xB5}: "espressif",
	{0x5C, 0xCF, 0x7F}: "espressif", {0x18, 0xFE, 0x34}: "espressif", {0x60, 0x01, 0x94}: "espressif",
	{0x68, 0xC6, 0x3A}: "espressif", {0x2C, 0x3A, 0xE8}: "espressif", {0xDC, 0x4F, 0x22}: "espressif",
	{0xC8, 0xC9, 0xA3}: "espressif", {0x48, 0x3F, 0xDA}: "espressif", {0xE8, 0xDB, 0x84}: "espressif",
	{0x34, 0x94, 0x54}: "espressif", {0x08, 0x3A, 0xF2}: "espressif", {0x7C, 0x9E, 0xBD}: "espressif",
	{0x40, 0xF5, 0x20}: "espressif", {0xCC, 0x50, 0xE3}: "espressif", {0x98, 0xCD, 0xAC}: "espressif",
	{0xC4, 0x5B, 0xBE}: "espressif", {0xA8, 0x48, 0xFA}: "espressif", {0x94, 0xB9, 0x7E}: "espressif",
	{0xE0, 0x98, 0x06}: "espressif", {0x84, 0xCC, 0xA8}: "espressif", {0x4C, 0xEB, 0xD6}: "espressif",
	// High-Flying (Hi-flying electronics: the Wi-Fi module of Solarman loggers)
	{0xAC, 0xCF, 0x23}: "high-flying", {0x98, 0xD8, 0x63}: "high-flying",
	// AVM (FRITZ!Box, FRITZ!Repeater)
	{0x00, 0x04, 0x0E}: "avm", {0x3C, 0xA6, 0x2F}: "avm", {0xC8, 0x0E, 0x14}: "avm", {0x2C, 0x91, 0xAB}: "avm",
	{0x38, 0x10, 0xD5}: "avm", {0x44, 0x4E, 0x6D}: "avm", {0x5C, 0x49, 0x79}: "avm", {0x7C, 0xFF, 0x4D}: "avm",
	{0x98, 0x9B, 0xCB}: "avm", {0xBC, 0x05, 0x43}: "avm", {0xC0, 0x25, 0x06}: "avm", {0xCC, 0xCE, 0x1E}: "avm",
	{0xDC, 0x39, 0x6F}: "avm", {0xE0, 0x28, 0x6D}: "avm", {0xE8, 0xDF, 0x70}: "avm", {0xF0, 0xB0, 0x14}: "avm",
}

// Funkmodul names the maker of a MAC's radio module ("" = not in the list or
// a randomised address).
func Funkmodul(mac net.HardwareAddr) string {
	if len(mac) != 6 || mac[0]&0x02 != 0 {
		return ""
	}
	return funkmodulListe[[3]byte{mac[0], mac[1], mac[2]}]
}
