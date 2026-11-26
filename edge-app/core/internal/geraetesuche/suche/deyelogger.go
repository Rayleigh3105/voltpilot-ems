package suche

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/deyedecode"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
)

// deyeModbusTCP is the communication of a Deye read over the Modbus TCP of
// its logger stick: port 502, unit 1, the Deye register map as over Solarman.
const deyeModbusTCP = "deye_modbus_tcp"

// erkenneDeyeLogger: a newer Deye logger stick (field 25.11.2026: module
// DYDA_WiBLE, Wi-Fi module by MXCHIP) does not offer Solarman V5 on 8899. Its
// Modbus TCP on 502 is off from the factory; switched on in the stick's web
// page, it answers plain Modbus TCP frames for the inverter behind it (unit
// 1; unit 0 stays silent). The find is the inverter over that way:
//
//   - 502 open and the Deye type read (FC 3 on 0x0000-0x0007, unit 1, like
//     the Solarman recogniser): sicher, with family, voltage class and serial.
//   - 502 open, no Deye type (no answer, a type outside the source's lists):
//     wahrscheinlich - adopting asks for confirmation.
//   - 502 closed: wahrscheinlich, hindernis lokale_api_aus - Modbus TCP is
//     off in the stick (the portal says how to switch it on, or RS485 at the
//     box instead).
//
// The stick is recognised first, only from what it serves BEFORE any login:
// the start page (GET /) loads its scripts - a language file, aes.js, rsa.js
// and utils.js - and utils.js (GET /js/utils.js, a file the login page itself
// loads) keeps its session key as PCS_LOCAL_WEB next to encryptUrl. Never a
// login, never a CGI of the stick (require.cgi, change_user.cgi), never a
// POST, never a write. The Modbus read on 502 follows only on such a page: a
// small number at 0x0000 of some other Modbus device proves no Deye. The
// MXCHIP radio module (Edge Light) adds a merkmal (mitFunkmodul), never the
// find: MXCHIP builds modules for many makers.
//
// Only when the search tried 8899 and 502 on this device and 8899 is not
// open: a stick that answers Solarman V5 is the solarman find (its chain runs
// first); an open 8899 that did not answer stays as before. It is the last of
// port 80, so every Modbus recogniser of 502 had its turn, and it wins over
// modbus_offen, which runs only after the port chains.
func erkenneDeyeLogger(ctx context.Context, g *geraet, port int, _ *modbus) (geraetesuche.Fund, bool) {
	l := g.lauf
	if !slices.Contains(l.geprueft, 8899) || !slices.Contains(l.geprueft, 502) || g.offen[8899] {
		return geraetesuche.Fund{}, false
	}
	b := g.budget()
	a, err := b.get(ctx, port, "/")
	if err != nil || a.status != 200 || !deyeLoggerSeite(a.body) {
		return geraetesuche.Fund{}, false
	}
	u, err := b.get(ctx, port, "/js/utils.js")
	if err != nil || u.status != 200 || !bytes.Contains(u.body, []byte("PCS_LOCAL_WEB")) ||
		!bytes.Contains(u.body, []byte("encryptUrl")) {
		return geraetesuche.Fund{}, false
	}
	unit := 1
	f := geraetesuche.Fund{Schluessel: "deye_logger:" + adresse(g, 502), Erkenner: "deye_logger",
		Art: "wechselrichter", Hersteller: "deye", Erkennung: geraetesuche.ErkennungWahrscheinlich,
		Merkmale: []string{"deye_logger_seite", "deye_logger_pcs_local_web", "solarman_port_zu"},
		Verbindung: geraetesuche.Verbindung{Communication: deyeModbusTCP, IP: g.ip.String(), Port: 502,
			UnitID: &unit}}
	if !g.offen[502] {
		f.Hindernis = "lokale_api_aus"
		f.Merkmale = append(f.Merkmale, "modbus_port_zu")
		return f, true
	}
	mb := g.modbus(502)
	regs, err := mb.lies(ctx, b, byte(unit), 0x0000, 8)
	mb.schliesse()
	if err != nil || !deyeTyp(&f, regs) {
		f.Merkmale = append(f.Merkmale, "modbus_port_offen")
		return f, true
	}
	// The inverter answered through the stick: that is the self-report.
	f.Erkennung = geraetesuche.ErkennungSicher
	f.Schluessel = schluessel("deye_logger", f.Seriennummer, g, 502)
	return f, true
}

// deyeTyp names the Deye of the registers 0x0000-0x0007 in f: the type code
// (0x0000) gives the voltage class and the family, 0x0003-0x0007 the serial.
// false = no register block, or a type code outside the source's lists.
func deyeTyp(f *geraetesuche.Fund, regs []uint16) bool {
	if len(regs) < 8 {
		return false
	}
	klasse, mitKlasse := deyedecode.Spannungsklasse(regs[0])
	familie, mitFamilie := deyedecode.FamilieAusTyp(regs[0])
	if !mitKlasse && !mitFamilie {
		return false
	}
	f.Hersteller, f.Spannung, f.Familie = "deye", klasse, familie
	f.Merkmale = append(f.Merkmale, fmt.Sprintf("deye_typ_0x%04x", regs[0]))
	if sn := seriennr(regText(regs[3:8])); sn != "" {
		f.Seriennummer = sn
		f.Merkmale = append(f.Merkmale, "deye_seriennummer_0x0003")
	}
	return true
}

// deyeLoggerSkript is a script the start page of the stick loads (path
// relative or absolute, any language file).
var deyeLoggerSkript = regexp.MustCompile(`(?i)<script[^>]*\ssrc\s*=\s*["']?/?js/(lan_[a-z]{2}|aes|rsa|utils)\.js["'\s>]`)

// deyeLoggerSeite: the page loads all four kinds of script - a language
// file, aes.js, rsa.js and utils.js.
func deyeLoggerSeite(body []byte) bool {
	gesehen := map[string]bool{}
	for _, m := range deyeLoggerSkript.FindAllSubmatch(body, -1) {
		name := strings.ToLower(string(m[1]))
		if strings.HasPrefix(name, "lan_") {
			name = "lan"
		}
		gesehen[name] = true
	}
	return len(gesehen) == 4
}
