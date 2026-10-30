package suche

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// Step 4, geraete_erkennen: each open port has a FIXED chain of read-only
// recognisers (catalog erkennungskatalog of the vectors). They run one after
// the other over one device; the first find ends the device: one device, one
// find. Each recogniser sends at most AnfragenJeErkenner requests.

type erkenner struct {
	name    string
	erkenne func(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool)
}

type portKette struct {
	port     int
	modbus   bool
	erkenner []erkenner
}

// kette is the order of ports and recognisers. A Solarman logger answers on
// 8899 first; Modbus before HTTP, because on an inverter the web server is
// only its surface; KACO's stick on 8484 (the box's own 8484 is never a
// target: its own address is out).
var kette = []portKette{
	{port: 8899, erkenner: []erkenner{{"solarman", erkenneSolarman}}},
	{port: 502, modbus: true, erkenner: []erkenner{{"sunspec", erkenneSunSpec}, {"sma", erkenneSMA},
		{"huawei", erkenneHuawei}, {"ebyte", erkenneEbyte}, {"victron", erkenneVictron}, {"wago", erkenneWago}}},
	{port: 1502, modbus: true, erkenner: []erkenner{{"kostal", erkenneKostal}, {"sunspec", erkenneSunSpec}}},
	{port: 8484, erkenner: []erkenner{{"kaco_aiswei", erkenneKaco}}},
	{port: 80, erkenner: []erkenner{{"shelly", erkenneShelly}, {"goe", erkenneGoe},
		{"fronius_solar_api", erkenneFronius}, {"opendtu_ahoy", erkenneOpenDTU}}},
}

// erkenne runs the chains of one device; true = it became a find.
func (l *Lauf) erkenne(ctx context.Context, g *geraet) bool {
	// An SMA energy meter announced itself on Speedwire (Edge Light).
	if g.hinweis.speedwire != 0 && l.erkenner["sma"] {
		sn := strconv.FormatUint(uint64(g.hinweis.speedwire), 10)
		return l.melde(geraetesuche.Fund{Schluessel: "sma:" + sn, Erkenner: "sma", Art: "zaehler", Hersteller: "sma",
			Seriennummer: sn, Erkennung: geraetesuche.ErkennungSicher, Merkmale: []string{"speedwire_multicast"},
			Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: 9522}})
	}
	modbusPort := 0
	for _, k := range kette {
		if !g.offen[k.port] {
			continue
		}
		if k.modbus && modbusPort == 0 {
			modbusPort = k.port
		}
		var mb *modbus
		if k.modbus {
			mb = g.modbus(k.port)
		}
		for _, e := range k.erkenner {
			if !l.erkenner[e.name] || ctx.Err() != nil {
				continue
			}
			if f, ok := e.erkenne(ctx, g, k.port, mb); ok {
				if mb != nil {
					mb.schliesse()
				}
				f.Merkmale = mitFunkmodul(f.Merkmale, g)
				return l.melde(f)
			}
		}
		if mb != nil {
			mb.schliesse()
		}
	}
	if ctx.Err() != nil {
		return false
	}
	// A go-e that named itself by mDNS but does not answer its local API v2.
	if g.hinweis.mdns["goe"] && l.erkenner["goe"] {
		return l.melde(geraetesuche.Fund{Schluessel: "goe:" + adresse(g, 80), Erkenner: "goe", Art: "wallbox",
			Hersteller: "go-e", Erkennung: geraetesuche.ErkennungWahrscheinlich, Hindernis: "lokale_api_aus",
			Merkmale:   []string{"mdns_goe"},
			Verbindung: geraetesuche.Verbindung{Communication: "goe_http_api", IP: g.ip.String(), Port: 80}})
	}
	if l.erkenner["netztechnik"] {
		if f, ok := l.netztechnik(ctx, g); ok {
			return l.melde(f)
		}
	}
	if modbusPort != 0 && l.erkenner["modbus_offen"] {
		return l.melde(geraetesuche.Fund{Schluessel: "modbus_offen:" + adresse(g, modbusPort), Erkenner: "modbus_offen",
			Art: "modbus_geraet", Erkennung: geraetesuche.ErkennungUnbekannt, Merkmale: []string{"modbus_port_offen"},
			Verbindung: geraetesuche.Verbindung{Communication: "modbus_tcp", IP: g.ip.String(), Port: modbusPort}})
	}
	return false
}

func adresse(g *geraet, port int) string { return g.ip.String() + ":" + strconv.Itoa(port) }

func mitFunkmodul(m []string, g *geraet) []string {
	if g.hinweis.funkmodul == "" || len(m) >= geraetesuche.MaxMerkmale {
		return m
	}
	return append(m, "funkmodul_"+strings.ReplaceAll(g.hinweis.funkmodul, "-", "_"))
}

// ---------------------------------------------------------------- HTTP recognisers

// geschuetzt: 401/403 ends a recogniser - no login is ever tried.
func geschuetzt(a antwort) bool { return a.status == 401 || a.status == 403 }

func jsonObjekt(a antwort) (map[string]json.RawMessage, bool) {
	if a.status != 200 {
		return nil, false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(a.body, &m) != nil || m == nil {
		return nil, false
	}
	return m, true
}

// text reads a JSON string or number as text.
func text(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n json.Number
	if json.Unmarshal(raw, &n) == nil {
		return n.String()
	}
	return ""
}

// erkenneShelly: GET /shelly answers without a login on every generation
// (model, generation, firmware, auth_en); Gen2+ names its switches in
// Shelly.GetStatus. A Shelly names its identity only as a MAC: no
// seriennummer, the address is the key (DP-3 A).
func erkenneShelly(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	a, err := b.get(ctx, port, "/shelly")
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	m, ok := jsonObjekt(a)
	if !ok {
		return geraetesuche.Fund{}, false
	}
	var gen int
	_ = json.Unmarshal(m["gen"], &gen)
	modell, typ := text(m["model"]), text(m["type"])
	f := geraetesuche.Fund{Schluessel: "shelly:" + adresse(g, port), Erkenner: "shelly", Art: "schaltaktor",
		Hersteller: "shelly", Erkennung: geraetesuche.ErkennungSicher,
		Verbindung: geraetesuche.Verbindung{Communication: "shelly_http", IP: g.ip.String(), Port: port}}
	auth := wahr(m["auth_en"]) || wahr(m["auth"])
	switch {
	case gen >= 2 && modell != "":
		f.Modell, f.Firmware = sauber(modell), sauber(text(m["ver"]))
		f.Merkmale = []string{"shelly_gen2_antwort"}
		zaehler := shellyZaehlerModell(modell)
		if !auth {
			if st, err := b.folge(ctx, port, "/rpc/Shelly.GetStatus"); err == nil {
				if s, ok := jsonObjekt(st); ok {
					schalter, em := 0, false
					for k := range s {
						switch {
						case strings.HasPrefix(k, "switch:"):
							schalter++
						case strings.HasPrefix(k, "em:"), strings.HasPrefix(k, "em1:"):
							em = true
						}
					}
					zaehler = zaehler || (em && schalter == 0)
					if !zaehler && schalter > 0 && schalter <= 16 {
						f.Kanaele = schalter
					}
					f.Merkmale = append(f.Merkmale, "shelly_status")
				}
			}
		}
		if zaehler {
			f.Art, f.Kanaele = "zaehler", 0
		}
	case typ != "" && m["gen"] == nil:
		f.Modell, f.Firmware = sauber(typ), sauber(text(m["fw"]))
		f.Merkmale = []string{"shelly_gen1_antwort"}
		var aus, em int
		_ = json.Unmarshal(m["num_outputs"], &aus)
		_ = json.Unmarshal(m["num_emeters"], &em)
		if em > 0 || strings.HasPrefix(strings.ToUpper(typ), "SHEM") {
			f.Art = "zaehler"
		} else if aus > 0 && aus <= 16 {
			f.Kanaele = aus
		}
	default:
		return geraetesuche.Fund{}, false
	}
	if g.hinweis.mdns["shelly"] {
		f.Merkmale = append(f.Merkmale, "mdns_shelly")
	}
	if auth {
		f.Merkmale = append(f.Merkmale, "auth_en")
		if f.Art == "schaltaktor" {
			f.Hindernis = "geschuetzt"
		}
	}
	if f.Art == "zaehler" {
		// The driver knows relays only: a meter has no reading way yet.
		f.Verbindung.Communication = ""
	}
	return f, true
}

// shellyZaehlerModell: the Gen2+ energy meters (Pro 3EM, Pro EM, 3EM Gen3, EM
// Gen3) - their model ids carry EM.
func shellyZaehlerModell(modell string) bool {
	m := strings.ToUpper(modell)
	return strings.HasPrefix(m, "SPEM-") || strings.HasPrefix(m, "S3EM-") || strings.HasPrefix(m, "S3PM-")
}

func wahr(raw json.RawMessage) bool {
	var b bool
	return json.Unmarshal(raw, &b) == nil && b
}

// erkenneGoe: the local API v2 names the serial (sse), the type and the
// firmware. Without the local API v2 the charger is only a mDNS hint.
func erkenneGoe(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	a, err := b.get(ctx, port, "/api/status?filter=sse,typ,fwv")
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	m, ok := jsonObjekt(a)
	if !ok {
		return geraetesuche.Fund{}, false
	}
	sse := seriennr(text(m["sse"]))
	if sse == "" {
		return geraetesuche.Fund{}, false
	}
	f := geraetesuche.Fund{Schluessel: schluessel("goe", sse, g, port), Erkenner: "goe", Art: "wallbox",
		Hersteller: "go-e", Modell: sauber(text(m["typ"])), Seriennummer: sse, Firmware: sauber(text(m["fwv"])),
		Erkennung: geraetesuche.ErkennungSicher, Merkmale: []string{"goe_api_v2_sse"},
		Verbindung: geraetesuche.Verbindung{Communication: "goe_http_api", IP: g.ip.String(), Port: port}}
	if g.hinweis.mdns["goe"] {
		f.Merkmale = append(f.Merkmale, "mdns_goe")
	}
	return f, true
}

// erkenneFronius: the Solar API names its version, then the inverters behind
// the Datamanager. One short session each (the Datamanager is practically a
// one-session device).
func erkenneFronius(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	a, err := b.get(ctx, port, "/solar_api/GetAPIVersion.cgi")
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	m, ok := jsonObjekt(a)
	if !ok || m["APIVersion"] == nil {
		return geraetesuche.Fund{}, false
	}
	f := geraetesuche.Fund{Erkenner: "fronius_solar_api", Art: "wechselrichter", Hersteller: "fronius",
		Erkennung: geraetesuche.ErkennungSicher, Merkmale: []string{"solar_api_version"},
		Verbindung: geraetesuche.Verbindung{Communication: "fronius_solar_api", IP: g.ip.String(), Port: port}}
	if info, err := b.get(ctx, port, "/solar_api/v1/GetInverterInfo.cgi"); err == nil && info.status == 200 {
		var doc struct {
			Body struct {
				Data map[string]struct {
					UniqueID json.RawMessage `json:"UniqueID"`
				} `json:"Data"`
			} `json:"Body"`
		}
		if json.Unmarshal(info.body, &doc) == nil && len(doc.Body.Data) > 0 {
			ids := make([]string, 0, len(doc.Body.Data))
			for id := range doc.Body.Data {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			f.Seriennummer = seriennr(text(doc.Body.Data[ids[0]].UniqueID))
			f.Merkmale = append(f.Merkmale, "solar_api_inverter_info")
		}
	}
	f.Schluessel = schluessel("fronius_solar_api", f.Seriennummer, g, port)
	return f, true
}

// erkenneOpenDTU: OpenDTU answers /api/system/status, AhoyDTU /api/system.
// Recognised only - no VoltPilot reader.
func erkenneOpenDTU(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	f := geraetesuche.Fund{Schluessel: "opendtu_ahoy:" + adresse(g, port), Erkenner: "opendtu_ahoy", Art: "dtu",
		Erkennung: geraetesuche.ErkennungSicher, Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: port}}
	if a, err := b.get(ctx, port, "/api/system/status"); err == nil {
		if m, ok := jsonObjekt(a); ok && m["git_hash"] != nil && (m["pioenv"] != nil || m["sdkversion"] != nil) {
			f.Hersteller, f.Firmware, f.Merkmale = "opendtu", sauber(text(m["git_hash"])), []string{"opendtu_system_status"}
			return f, true
		}
		if geschuetzt(a) {
			return geraetesuche.Fund{}, false
		}
	}
	if a, err := b.get(ctx, port, "/api/system"); err == nil {
		if m, ok := jsonObjekt(a); ok && m["version"] != nil && (m["build"] != nil || m["esp_type"] != nil) {
			f.Hersteller, f.Firmware, f.Merkmale = "ahoydtu", sauber(text(m["version"])), []string{"ahoy_api_system"}
			return f, true
		}
	}
	return geraetesuche.Fund{}, false
}

// erkenneKaco: the KACO/AISWEI stick lists its inverters on 8484. Only HTTP is
// read - the stick is never switched into its Modbus mode (that would cut off
// the cloud and the app).
func erkenneKaco(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	a, err := b.get(ctx, port, "/getdev.cgi?device=2")
	if err != nil || a.status != 200 {
		return geraetesuche.Fund{}, false
	}
	var doc struct {
		Inv []struct {
			ISN json.RawMessage `json:"isn"`
		} `json:"inv"`
	}
	if json.Unmarshal(a.body, &doc) != nil || len(doc.Inv) == 0 {
		return geraetesuche.Fund{}, false
	}
	sn := seriennr(text(doc.Inv[0].ISN))
	if sn == "" {
		return geraetesuche.Fund{}, false
	}
	return geraetesuche.Fund{Schluessel: schluessel("kaco_aiswei", sn, g, port), Erkenner: "kaco_aiswei",
		Art: "wechselrichter", Hersteller: "kaco", Seriennummer: sn, Erkennung: geraetesuche.ErkennungSicher,
		Merkmale:   []string{"kaco_getdev_device_2"},
		Verbindung: geraetesuche.Verbindung{Communication: "kaco_http", IP: g.ip.String(), Port: port}}, true
}

// ---------------------------------------------------------------- Modbus recognisers

const (
	sunsHi = 0x5375 // "Su"
	sunsLo = 0x6E53 // "nS"
)

// sunspecKopf is the Common Model 1 of a SunSpec device.
type sunspecKopf struct {
	hersteller, modell, version, seriennummer string
}

// sunspec looks for "SunS" at basis on unit and reads Common Model 1. One
// read of 70 registers carries both; a device that refuses the long read is
// asked for the two marker words, then for the model.
func sunspec(ctx context.Context, mb *modbus, b *budget, unit byte, basis uint16) (sunspecKopf, bool) {
	regs, err := mb.lies(ctx, b, unit, basis, 70)
	if err != nil {
		var ausnahme *modbusAusnahme
		if !errors.As(err, &ausnahme) {
			return sunspecKopf{}, false
		}
		kurz, err := mb.lies(ctx, b, unit, basis, 2)
		if err != nil || kurz[0] != sunsHi || kurz[1] != sunsLo {
			return sunspecKopf{}, false
		}
		modell, err := mb.lies(ctx, b, unit, basis+2, 68)
		if err != nil {
			return sunspecKopf{}, false
		}
		regs = append(kurz, modell...)
	}
	if regs[0] != sunsHi || regs[1] != sunsLo || regs[2] != 1 || (regs[3] != 65 && regs[3] != 66) {
		return sunspecKopf{}, false
	}
	return sunspecKopf{hersteller: regText(regs[4:20]), modell: regText(regs[20:36]),
		version: regText(regs[44:52]), seriennummer: regText(regs[52:68])}, true
}

func sunspecFund(erk string, k sunspecKopf, g *geraet, port int, unit int, merkmal string) geraetesuche.Fund {
	sn := seriennr(k.seriennummer)
	f := geraetesuche.Fund{Schluessel: schluessel(erk, sn, g, port), Erkenner: erk, Art: "wechselrichter",
		Hersteller: hersteller(k.hersteller), Modell: sauber(k.modell), Seriennummer: sn,
		Firmware: sauber(k.version), Erkennung: geraetesuche.ErkennungSicher,
		Merkmale:   []string{merkmal, "sunspec_common_model_1"},
		Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: port, UnitID: &unit}}
	if row, ok := geraetesuche.KatalogPaar(erk, "wechselrichter"); ok {
		f.Verbindung.Communication = row.Communication
	}
	return f
}

// erkenneSunSpec: unit 1, "SunS" at 40000, 50000 or 0. A SunSpec device of SMA
// or KOSTAL is theirs (their own recognisers name it); the generic SunSpec
// find is everything else (Fronius, KACO, SolarEdge, ...).
func erkenneSunSpec(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	for _, basis := range []uint16{40000, 50000, 0} {
		k, ok := sunspec(ctx, mb, b, 1, basis)
		if !ok {
			if b.rest <= 0 {
				break
			}
			continue
		}
		erk := "sunspec"
		switch h := strings.ToLower(k.hersteller); {
		case strings.Contains(h, "sma"):
			erk = "sma"
		case strings.Contains(h, "kostal"):
			erk = "kostal"
		}
		if !g.lauf.erkenner[erk] {
			return geraetesuche.Fund{}, false
		}
		return sunspecFund(erk, k, g, port, 1, fmt.Sprintf("sunspec_%d", basis)), true
	}
	return geraetesuche.Fund{}, false
}

// erkenneKostal: KOSTAL PLENTICORE answers SunSpec on 1502, unit 71.
func erkenneKostal(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	k, ok := sunspec(ctx, mb, b, 71, 40000)
	if !ok || !strings.Contains(strings.ToLower(k.hersteller), "kostal") {
		return geraetesuche.Fund{}, false
	}
	return sunspecFund("kostal", k, g, port, 71, "kostal_unit_71"), true
}

// erkenneSMA: SunSpec on unit 126, else the SMA profile on unit 3 (device
// class, type, serial 30057). Recognised only.
func erkenneSMA(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	if k, ok := sunspec(ctx, mb, b, 126, 40000); ok && strings.Contains(strings.ToLower(k.hersteller), "sma") {
		f := sunspecFund("sma", k, g, port, 126, "sma_sunspec_unit_126")
		f.Verbindung.Communication = ""
		return f, true
	}
	regs, err := mb.lies(ctx, b, 3, 30051, 8)
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	sn := uint32(regs[6])<<16 | uint32(regs[7])
	if sn == 0 || sn == 0xFFFFFFFF || regs[0] == 0xFFFF {
		return geraetesuche.Fund{}, false
	}
	nr := strconv.FormatUint(uint64(sn), 10)
	unit := 3
	return geraetesuche.Fund{Schluessel: "sma:" + nr, Erkenner: "sma", Art: "wechselrichter", Hersteller: "sma",
		Seriennummer: nr, Erkennung: geraetesuche.ErkennungSicher,
		Merkmale:   []string{"sma_modbus_unit_3", "sma_seriennummer_30057"},
		Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: port, UnitID: &unit}}, true
}

// erkenneHuawei: SUN2000 names its model from 30000 and its serial from 30015;
// unit 1 behind the Smart Dongle, unit 0 directly.
func erkenneHuawei(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	for _, unit := range []int{1, 0} {
		regs, err := mb.lies(ctx, b, byte(unit), 30000, 25)
		if err != nil {
			continue
		}
		modell := regText(regs[0:15])
		if !strings.HasPrefix(strings.ToUpper(modell), "SUN2000") {
			return geraetesuche.Fund{}, false
		}
		sn := seriennr(regText(regs[15:25]))
		u := unit
		return geraetesuche.Fund{Schluessel: schluessel("huawei", sn, g, port), Erkenner: "huawei",
			Art: "wechselrichter", Hersteller: "huawei", Modell: sauber(modell), Seriennummer: sn,
			Erkennung: geraetesuche.ErkennungSicher, Merkmale: []string{"huawei_modell_30000", "huawei_seriennummer_30015"},
			Verbindung: geraetesuche.Verbindung{Communication: "huawei_modbus", IP: g.ip.String(), Port: port, UnitID: &u}}, true
	}
	return geraetesuche.Fund{}, false
}

// erkenneEbyte: the M31 host names its model (and with it its relay count).
// Its identity is the MAC (0x7534) - never read here, it does not leave the box.
func erkenneEbyte(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	regs, err := mb.lies(ctx, b, 1, 0x0C20, 12)
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	modell := regText(regs)
	if !strings.HasPrefix(strings.ToUpper(modell), "M31-") {
		return geraetesuche.Fund{}, false
	}
	unit := 1
	f := geraetesuche.Fund{Schluessel: "ebyte:" + adresse(g, port), Erkenner: "ebyte", Art: "io_modul",
		Hersteller: "ebyte", Modell: sauber(modell), Erkennung: geraetesuche.ErkennungSicher,
		Merkmale:   []string{"ebyte_modell_0x0c20"},
		Verbindung: geraetesuche.Verbindung{Communication: "ebyte_modbus_tcp", IP: g.ip.String(), Port: port, UnitID: &unit}}
	if mod, ok := ebyteModul(modell); ok && mod > 0 && mod <= 16 {
		f.Kanaele = mod
	}
	return f, true
}

// erkenneVictron: a GX device answers on unit 100 and names its serial at 800.
// Recognised only.
func erkenneVictron(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	regs, err := mb.lies(ctx, b, 100, 800, 6)
	if err != nil {
		return geraetesuche.Fund{}, false
	}
	sn := seriennr(regText(regs))
	if len(sn) < 6 {
		return geraetesuche.Fund{}, false
	}
	unit := 100
	return geraetesuche.Fund{Schluessel: "victron:" + sn, Erkenner: "victron", Art: "wechselrichter",
		Hersteller: "victron", Seriennummer: sn, Erkennung: geraetesuche.ErkennungWahrscheinlich,
		Merkmale:   []string{"victron_unit_100", "victron_seriennummer_800"},
		Verbindung: geraetesuche.Verbindung{IP: g.ip.String(), Port: port, UnitID: &unit}}, true
}

// erkenneWago: the VoltPilot register image of a WAGO controller starts with
// its signature, "VPRB" (energy cards) or "VPEZ" (Erzeuger image), at the base
// address 0 of its program.
func erkenneWago(ctx context.Context, g *geraet, port int, mb *modbus) (geraetesuche.Fund, bool) {
	b := g.budget()
	regs, err := mb.lies(ctx, b, 1, 0, 2)
	if err != nil || regs[0] != 0x5650 {
		return geraetesuche.Fund{}, false
	}
	var merkmal, modell string
	switch regs[1] {
	case 0x5242:
		merkmal, modell = "signatur_vprb", "VoltPilot-Registerbild"
	case 0x455A:
		merkmal, modell = "signatur_vpez", "VoltPilot-Erzeugerbild"
	default:
		return geraetesuche.Fund{}, false
	}
	unit := 1
	return geraetesuche.Fund{Schluessel: "wago:" + adresse(g, port), Erkenner: "wago", Art: "sps", Hersteller: "wago",
		Modell: modell, Erkennung: geraetesuche.ErkennungSicher, Merkmale: []string{merkmal},
		Verbindung: geraetesuche.Verbindung{Communication: "modbus_tcp", IP: g.ip.String(), Port: port, UnitID: &unit}}, true
}

// ---------------------------------------------------------------- words

// regText turns register words into ASCII, cut at the first NUL.
func regText(regs []uint16) string {
	b := make([]byte, 0, 2*len(regs))
	for _, r := range regs {
		b = append(b, byte(r>>8), byte(r))
	}
	if i := strings.IndexByte(string(b), 0); i >= 0 {
		b = b[:i]
	}
	return strings.TrimSpace(string(b))
}

var seriennrMuster = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$`)
var schluesselTeil = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,96}$`)

// seriennr keeps a serial only in the contract's form ("" otherwise).
func seriennr(s string) string {
	s = strings.TrimSpace(s)
	if !seriennrMuster.MatchString(s) {
		return ""
	}
	return s
}

// schluessel is <erkenner>:<serial>, or <erkenner>:<ip:port> without one.
func schluessel(erk, sn string, g *geraet, port int) string {
	if sn != "" && schluesselTeil.MatchString(sn) {
		return erk + ":" + sn
	}
	return erk + ":" + adresse(g, port)
}

// sauber makes a device text fit the contract: no control characters, at
// most 64 characters.
func sauber(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, strings.TrimSpace(s))
	if r := []rune(s); len(r) > 64 {
		s = strings.TrimSpace(string(r[:64]))
	}
	return s
}

var herstellerBekannt = []struct{ teil, wort string }{
	{"fronius", "fronius"}, {"sma", "sma"}, {"kostal", "kostal"}, {"kaco", "kaco"}, {"solaredge", "solaredge"},
	{"huawei", "huawei"}, {"victron", "victron"}, {"sungrow", "sungrow"}, {"goodwe", "goodwe"}, {"sofar", "sofar"},
	{"avm", "avm"}, {"tp-link", "tp-link"}, {"tplink", "tp-link"}, {"ubiquiti", "ubiquiti"}, {"netgear", "netgear"},
	{"zyxel", "zyxel"}, {"asus", "asus"}, {"linksys", "linksys"}, {"gl.inet", "gl-inet"}, {"gl-inet", "gl-inet"},
}

var nichtHersteller = regexp.MustCompile(`[^a-z0-9_-]+`)

// hersteller turns a manufacturer text into the contract's word.
func hersteller(s string) string {
	h := strings.ToLower(strings.TrimSpace(s))
	for _, b := range herstellerBekannt {
		if strings.Contains(h, b.teil) {
			return b.wort
		}
	}
	if f := strings.Fields(h); len(f) > 0 {
		h = f[0]
	}
	h = strings.Trim(nichtHersteller.ReplaceAllString(h, "-"), "-_")
	if len(h) > 64 {
		h = h[:64]
	}
	if h == "" || !(h[0] >= 'a' && h[0] <= 'z' || h[0] >= '0' && h[0] <= '9') {
		return ""
	}
	return h
}

func ipVon(s string) (netip.Addr, bool) {
	a, err := netip.ParseAddr(s)
	return a, err == nil && a.Is4()
}
