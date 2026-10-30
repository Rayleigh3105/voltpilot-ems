package suche

import (
	"regexp"
	"strconv"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// What the box already reads is reported from its configuration and never
// connected again (contract §3 "Ein-Client-Geräte"): a Solarman logger serves
// one client, and a second connection would cut off the box's own reader.

// bekanntPaar maps the communication of a configured device to its catalog
// pair and default port; ok=false for a way the catalog does not know.
func bekanntPaar(b Bekannt) (erk, art string, ok bool) {
	switch b.Communication {
	case "solarman_v5":
		return "solarman", "wechselrichter", true
	case "shelly_http":
		return "shelly", "schaltaktor", true
	case "goe_http_api":
		return "goe", "wallbox", true
	case "fronius_solar_api":
		return "fronius_solar_api", "wechselrichter", true
	case "fronius_sunspec", "sunspec_tcp":
		return "sunspec", "wechselrichter", true
	case "kaco_http":
		return "kaco_aiswei", "wechselrichter", true
	case "kostal_modbus":
		return "kostal", "wechselrichter", true
	case "huawei_modbus":
		return "huawei", "wechselrichter", true
	case "ebyte_modbus_tcp":
		return "ebyte", "io_modul", true
	case "modbus_tcp":
		if b.Rolle == "plant-controller" {
			return "wago", "sps", true
		}
		return "modbus_offen", "modbus_geraet", true
	}
	return "", "", false
}

func standardPort(communication string) int {
	switch communication {
	case "solarman_v5":
		return solarmanv5.DefaultPort
	case "shelly_http", "goe_http_api", "fronius_solar_api":
		return 80
	case "kaco_http":
		return 8484
	case "kostal_modbus":
		return 1502
	}
	return 502
}

var familieMuster = regexp.MustCompile(`^[a-z0-9][a-z0-9_]{0,31}$`)

// bekanntFund is the find of a configured device (liest_box_schon).
func bekanntFund(b Bekannt) (geraetesuche.Fund, bool) {
	erk, art, ok := bekanntPaar(b)
	if !ok {
		return geraetesuche.Fund{}, false
	}
	row, _ := geraetesuche.KatalogPaar(erk, art)
	port := b.Port
	if port <= 0 || port > 65535 {
		port = standardPort(b.Communication)
	}
	f := geraetesuche.Fund{Erkenner: erk, Art: art, Hersteller: hersteller(b.Hersteller),
		Erkennung: geraetesuche.ErkennungSicher, Merkmale: []string{"laufender_leser"}, LiestBoxSchon: true,
		Verbindung: geraetesuche.Verbindung{Communication: row.Communication, IP: b.IP, Port: port}}
	if erk == "modbus_offen" {
		f.Erkennung = geraetesuche.ErkennungUnbekannt
	}
	if b.UnitID > 0 && b.UnitID <= 255 {
		u := b.UnitID
		f.Verbindung.UnitID = &u
	}
	schl := b.IP + ":" + strconv.Itoa(port)
	if erk == "solarman" {
		s, err := solarmanv5.NormLoggerSerial(b.Serial)
		if err != nil || s == 0 {
			return geraetesuche.Fund{}, false
		}
		f.Verbindung.Serial = &s
		schl = strconv.FormatUint(uint64(s), 10)
		if f.Verbindung.UnitID == nil {
			u := 1
			f.Verbindung.UnitID = &u
		}
		if familieMuster.MatchString(b.Familie) {
			f.Familie = b.Familie
		}
	}
	f.Schluessel = erk + ":" + schl
	return f, true
}
