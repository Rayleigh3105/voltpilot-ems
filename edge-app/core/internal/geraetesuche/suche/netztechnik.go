package suche

import (
	"context"
	"encoding/hex"
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

// tplinkModellRe is the model a TP-Link login page names in a script variable
// - the TL-WR840N page has no <title> at all (VoltPilotGATE 30.10.2026). Only
// the model of the fixed pattern is kept, never the description beside it.
var tplinkModellRe = regexp.MustCompile(`modelName\s*=\s*"(TL-[A-Z0-9]{2,12}|Archer [A-Z0-9]{2,8}|Deco [A-Z0-9]{1,6})"`)

// seitentitel reads the title of the start page (one GET on "/"), and the
// model variable of a TP-Link page when no title names the device.
func seitentitel(ctx context.Context, g *geraet, b *budget, gateway bool) (geraetesuche.Fund, bool) {
	a, err := b.get(ctx, 80, "/")
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	art := func(fest string) string {
		switch {
		case fest != "":
			return fest
		case gateway:
			return "router"
		}
		return "zugangspunkt"
	}
	fund := func(art, hersteller, merkmal string) geraetesuche.Fund {
		return geraetesuche.Fund{Schluessel: "netztechnik:" + adresse(g, 80), Erkenner: "netztechnik", Art: art,
			Hersteller: hersteller, Erkennung: geraetesuche.ErkennungWahrscheinlich,
			Merkmale:   []string{merkmal},
			Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: 80}}
	}
	if t := titelRe.FindSubmatch(a.body); t != nil {
		titel := strings.TrimSpace(string(t[1]))
		for _, m := range titelMuster {
			treffer := m.re.FindString(titel)
			if treffer == "" {
				continue
			}
			f := fund(art(m.art), m.hersteller, "seitentitel")
			if m.modell {
				f.Modell = sauber(treffer)
			}
			return f, true
		}
	}
	if t := tplinkModellRe.FindSubmatch(a.body); t != nil {
		f := fund(art(""), "tp-link", "seitenmodell")
		f.Modell = sauber(string(t[1]))
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
	// High-Flying (Hi-flying electronics: the Wi-Fi module of Solarman loggers;
	// d4:27:87 is the logger on VoltPilotGATE 30.10.2026). All 11 MA-L blocks
	// of the IEEE register (oui.csv, read 30.10.2026).
	{0x00, 0xA6, 0x2B}: "high-flying", {0x28, 0x9C, 0x6E}: "high-flying", {0x34, 0xEA, 0xE7}: "high-flying", {0x40, 0x2A, 0x8F}: "high-flying",
	{0x74, 0xE9, 0xD8}: "high-flying", {0x98, 0xD8, 0x63}: "high-flying", {0xAC, 0xCF, 0x23}: "high-flying", {0xC4, 0xBB, 0x89}: "high-flying",
	{0xD4, 0x27, 0x87}: "high-flying", {0xE8, 0xFD, 0xF8}: "high-flying", {0xF0, 0xFE, 0x6B}: "high-flying",
	// AVM (FRITZ!Box, FRITZ!Repeater)
	{0x00, 0x04, 0x0E}: "avm", {0x3C, 0xA6, 0x2F}: "avm", {0xC8, 0x0E, 0x14}: "avm", {0x2C, 0x91, 0xAB}: "avm",
	{0x38, 0x10, 0xD5}: "avm", {0x44, 0x4E, 0x6D}: "avm", {0x5C, 0x49, 0x79}: "avm", {0x7C, 0xFF, 0x4D}: "avm",
	{0x98, 0x9B, 0xCB}: "avm", {0xBC, 0x05, 0x43}: "avm", {0xC0, 0x25, 0x06}: "avm", {0xCC, 0xCE, 0x1E}: "avm",
	{0xDC, 0x39, 0x6F}: "avm", {0xE0, 0x28, 0x6D}: "avm", {0xE8, 0xDF, 0x70}: "avm", {0xF0, 0xB0, 0x14}: "avm",
}

// tplinkOUIs are the MA-L blocks of TP-Link in the IEEE register (oui.csv,
// read 30.10.2026: "TP-LINK TECHNOLOGIES CO.,LTD." and "TP-Link Systems Inc",
// 269 blocks; dc:62:79 is the TL-WR840N on VoltPilotGATE). Plugs and cameras
// of the maker share them, so the hint alone makes network gear only of the
// gateway; an access point needs its page (seitentitel).
const tplinkOUIs = "" +
	"000AEB 001478 0019E0 001D0F 002127 0023CD 002586 002719 003192 005F67 040F66 04C845 04F9F8 081F71 " +
	"085700 0C4B54 0C722C 0C8063 0C8268 0CEF15 1027F5 105A95 10FEED 147590 148692 14CC20 14CF92 14D864 " +
	"14E6E4 14EBB6 186945 18A6F7 18D6C7 18F22C 1C3BF3 1C4419 1C61B4 1CFA68 202351 203626 206BE7 20DCE6 " +
	"20E15D 242FD0 245A5F 246968 282CB2 2887BA 289104 28EE52 2C79BE 306893 30B49E 30B5C2 30DE4B 30FC68 " +
	"3460F9 349672 34B126 34E894 34F716 388345 3C06A7 3C46D8 3C52A1 3C64CF 3C6A48 3C6AD2 3C7895 3C846A " +
	"40169F 403F8C 409595 40AE30 40ED00 446690 44B32D 480EEC 482254 485F08 487D2E 48C381 4C10D5 503DD1 " +
	"503EAA 5091E3 50BD5F 50C7BF 50D4F7 50FA84 547595 54A703 54AF97 54C80F 54D299 54E6FC 58044F 584120 " +
	"58D812 5C628B 5C63BF 5C899A 5CA64F 5CA6E6 5CE931 60156F 60292B 6032B1 603A7C 6083E7 60A3E3 60A4B7 " +
	"60E327 645601 6466B3 646E97 647002 687724 687FF0 68DDB7 68FF7B 6C4CBC 6C5AB0 6CB158 6CE873 704F57 " +
	"7405A5 743989 74DA88 74EA3A 74FECE 782051 7844FD 78605B 788CB5 78A106 78C05A 7C8BCA 7CB59B 7CC2C6 " +
	"7CF17E 803C04 808917 808F1D 80AE54 80EA07 8416F9 84B890 84D81B 882593 889986 8C210A 8C86DD 8C902D " +
	"8CA6DF 901F94 909A4A 90AE1B 90F652 940C6D 94D9B3 94EF50 98038E 98254A 984827 9897CC 98BA5F 98DAC4 " +
	"98DED0 9C216A 9C4782 9C5322 9CA2F4 9CA615 A0F3C1 A41A3A A42BB0 A8154D A82948 A829DC A842A1 A8574E " +
	"A86E84 AC15A2 AC84C6 ACA7F1 B01921 B0487A B04E26 B09575 B0958E B0A7B9 B0BE76 B45BD1 B4B024 B4C0C3 " +
	"B8F883 B8FBB3 BC071D BC4699 BCD177 BCD849 C006C3 C025E9 C03A55 C04A00 C06118 C0C9E3 C0E42D C46E1F " +
	"C47154 C4E984 CC08FB CC32E5 CC3429 CC68B6 CCBABD D02791 D03745 D05D01 D076E7 D0C7C0 D4016D D46E0E " +
	"D4D6DF D807B6 D80D17 D8150D D84489 D84732 D85D4C D8F12E DC0077 DC6279 DCFE18 E005C5 E0280A E0D362 " +
	"E443CF E4C32A E4D332 E4FAC4 E848B8 E894F6 E8DE27 EC086B EC172F EC26CA EC6073 EC750C EC888F ECB931 " +
	"F0090D F0A731 F0F336 F42A7D F46D2F F483CD F4848D F4EC38 F4F26D F4F50B F81A67 F86FB0 F88C21 F8C903 " +
	"F8CE21 F8D111 FCD733"

func init() {
	for _, o := range strings.Fields(tplinkOUIs) {
		b, err := hex.DecodeString(o)
		if err != nil || len(b) != 3 {
			panic("funkmodulListe: OUI " + o)
		}
		funkmodulListe[[3]byte{b[0], b[1], b[2]}] = "tp-link"
	}
}

// Funkmodul names the maker of a MAC's radio module ("" = not in the list or
// a randomised address).
func Funkmodul(mac net.HardwareAddr) string {
	if len(mac) != 6 || mac[0]&0x02 != 0 {
		return ""
	}
	return funkmodulListe[[3]byte{mac[0], mac[1], mac[2]}]
}
