package lauf

import (
	"strconv"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// SchrittBeleg ist ein erledigter Schritt in der Ansicht (Entscheid E3 A der
// Lauf-Seite): seine Dauer und eine Zeile aus seinem Beleg. Die Zeile kommt
// aus einer festen Liste je Schritt (zeilen) und nennt nur Angaben, die kein
// Geheimnis sind; Passwort, Code, Schlüssel und rohe Ausgaben stehen nie
// darin. Der ganze Beleg bleibt im Protokoll und an der Abnahme.
type SchrittBeleg struct {
	Schritt string  `json:"schritt"`
	DauerS  float64 `json:"dauer_s"`
	Zeile   string  `json:"zeile"`
}

// Vorher sagt, was auf der Box war, bevor der Lauf sie anfasste (aus dem
// Schritt erkennen). Ersetzt: die Box war eine halb eingerichtete dieser
// Werkstatt; ihre alte Referenz geht nach dem Reset nicht weiter.
type Vorher struct {
	System    string `json:"system"`
	EdgeLight string `json:"edge_light"`
	Ersetzt   bool   `json:"ersetzt,omitempty"`
}

// verboten: Steht das in einer Zeile, steht dort nur „belegt“. Dieselbe
// Liste weist die API an einer Ansicht ab (DienstAnsichtService.VERBOTEN);
// eine Zeile damit hielte sonst die ganze Ansicht auf.
var verboten = []string{"PRIVATE KEY", "AGE ENCRYPTED FILE", "AGE-SECRET-KEY", "-----BEGIN"}

// zeileMax: länger wird eine Zeile nie (eine Zeile auf dem Telefon, zwei am Rand).
const zeileMax = 140

// wert gibt eine Angabe gekürzt zurück, "" wenn sie fehlt oder "none" ist.
func wert(b protokoll.Beleg, name string) string {
	v, _ := b.Wert(name)
	v = strings.TrimSpace(v)
	if v == "" || v == "none" {
		return ""
	}
	if i := strings.IndexByte(v, '\n'); i >= 0 {
		v = v[:i]
	}
	if r := []rune(v); len(r) > 60 {
		v = string(r[:59]) + "…"
	}
	return v
}

// ja: die Angabe beginnt mit dem Wort (etwa "ja", "abgewiesen").
func ja(b protokoll.Beleg, name, wort string) bool {
	v, _ := b.Wert(name)
	return strings.HasPrefix(strings.TrimSpace(v), wort)
}

func teile(t ...string) string {
	var r []string
	for _, s := range t {
		if s != "" {
			r = append(r, s)
		}
	}
	return strings.Join(r, " · ")
}

func wenn(v, format string) string {
	if v == "" {
		return ""
	}
	return strings.ReplaceAll(format, "%", v)
}

// zeilen ist die feste Liste: je Schritt, welche Angaben in der Zeile stehen.
// Nur die hier genannten Namen werden gelesen; ein Schritt ohne Eintrag zeigt
// „belegt“. Nie gelesen: passwort_age, passwd, code, tunnel_schluessel,
// techniker_schluessel, abgewiesen, install, einrichten, box_log_*, sysupgrade.
var zeilen = map[string]func(protokoll.Beleg) string{
	"erkennen": func(b protokoll.Beleg) string {
		return teile(wert(b, "modell"), wenn(wert(b, "gl_firmware"), "GL-Firmware %"), wenn(wert(b, "openwrt"), "OpenWrt %"),
			wenn(wert(b, "root_passwort"), "root-Passwort: %"), wenn(wert(b, "referenz_vorher"), "war %"))
	},
	"fassungen": func(b protokoll.Beleg) string {
		m := ""
		if ja(b, "manifest", "signiert") {
			m = "Manifest signiert"
		}
		return teile(wenn(wert(b, "freigabe"), "Freigabe %"), "Prüfsummen = Freigabe", m)
	},
	"openwrt": func(b protokoll.Beleg) string {
		box, dienst := wert(b, "sha256_box"), wert(b, "sha256_dienst")
		if box != "" && box == dienst {
			return "Prüfsumme auf der Box = Freigabe · Test vor dem Aufspielen bestanden"
		}
		return "aufgespielt"
	},
	"wiedererkennen": func(b protokoll.Beleg) string {
		return teile(wenn(wert(b, "dauer_bis_openwrt"), "OpenWrt meldet sich nach %"), wenn(wert(b, "mac"), "MAC %"))
	},
	"internet": func(b protokoll.Beleg) string {
		if strings.Contains(wert(b, "internet"), "erreichbar") {
			return "downloads.openwrt.org erreichbar (befristet)"
		}
		return ""
	},
	"passwort": func(b protokoll.Beleg) string {
		if ja(b, "ohne_passwort", "abgewiesen") {
			return "gesetzt, nur verschlüsselt abgelegt · ohne Passwort abgewiesen"
		}
		return ""
	},
	"notfall": func(b protokoll.Beleg) string {
		if n := wert(b, "zeilen"); n != "" {
			return n + " Notfall-Schlüssel auf der Box"
		}
		return ""
	},
	"programm": func(b protokoll.Beleg) string {
		u := ""
		if ja(b, "update_bereit", "ja") {
			u = "update-bereit"
		}
		return teile(wenn(wert(b, "health"), "meldet sich: %"), u)
	},
	"tunnel_schluessel": func(b protokoll.Beleg) string {
		return wenn(wert(b, "referenz"), "erzeugt für %")
	},
	"einloesen": func(b protokoll.Beleg) string {
		g := ""
		if ja(b, "geraete_schluessel", "festgehalten") {
			g = "Geräteschlüssel festgehalten"
		}
		return teile(wenn(wert(b, "tunnel_adresse"), "Tunnel-Adresse %"), g)
	},
	"tunnel_adresse": func(b protokoll.Beleg) string {
		return wenn(wert(b, "tunnel_adresse"), "Tunnel-Adresse %")
	},
	"tunnel": func(b protokoll.Beleg) string {
		return "Wartungstunnel eingerichtet · SSH nur im Tunnel"
	},
	"lan": func(b protokoll.Beleg) string {
		return wenn(wert(b, "lan_netz"), "LAN-Netz % · Neustart angestoßen")
	},
	"neustart": func(b protokoll.Beleg) string {
		return teile(wenn(wert(b, "dauer_bis_antwort"), "wieder da nach %"), "Host-Schlüssel unverändert")
	},
	"probe": func(b protokoll.Beleg) string {
		if a := wert(b, "anmeldung"); a != "" {
			return "Anmeldung über den Tunnel " + a
		}
		if wert(b, "probe") != "" {
			return "vom Betreiber im Portal erledigt"
		}
		return ""
	},
	"internet_weg": func(b protokoll.Beleg) string {
		return wert(b, "ergebnis")
	},
	"uebergabe": func(b protokoll.Beleg) string {
		n := 0
		for _, a := range b {
			if strings.HasPrefix(a.Name, "pruefung_") {
				n++
			}
		}
		p := ""
		if n > 0 {
			p = strconv.Itoa(n) + " Prüfungen mit Beleg"
		}
		return teile(wenn(wert(b, "fassung"), "%"), p)
	},
}

// Zeile bildet die Belegzeile eines erledigten Schritts aus der festen Liste.
func Zeile(schritt string, b protokoll.Beleg) string {
	z := ""
	if f, ok := zeilen[schritt]; ok {
		z = f(b)
	}
	if z == "" {
		z = "belegt"
	}
	z = geheim.Schwaerze(z)
	for _, v := range verboten {
		if strings.Contains(z, v) {
			return "belegt"
		}
	}
	if r := []rune(z); len(r) > zeileMax {
		z = string(r[:zeileMax-1]) + "…"
	}
	return z
}

// vorherAus liest aus dem Beleg des Schritts erkennen (auch eines
// gescheiterten), was vorher auf der Box war; nil, wenn er nichts sagt.
func vorherAus(b protokoll.Beleg, fall string) *Vorher {
	edge := "kein VoltPilot"
	if fall == faelle.SchonEdgeLight {
		edge = "Edge Light, ohne Lauf dieser Werkstatt"
	}
	var v *Vorher
	switch gl, ow := wert(b, "gl_firmware"), wert(b, "openwrt"); {
	case gl != "":
		v = &Vorher{System: "GL-Firmware " + gl, EdgeLight: edge}
	case ow != "":
		v = &Vorher{System: "OpenWrt " + strings.Fields(ow)[0], EdgeLight: edge}
	case fall == faelle.GLPasswort:
		v = &Vorher{System: "GL-Firmware, Fassung unbekannt (Passwort)", EdgeLight: "unbekannt"}
	case wert(b, "lauf_vorher") != "":
		e := "halb eingerichtet (Lauf " + wert(b, "lauf_vorher") + ")"
		if r := wert(b, "referenz_vorher"); r != "" {
			e = r + ", halb eingerichtet (Lauf " + wert(b, "lauf_vorher") + ")"
		}
		v = &Vorher{System: "OpenWrt mit Passwort dieser Werkstatt", EdgeLight: e, Ersetzt: fall == faelle.HalbEigene}
	case fall == faelle.PasswortFremd || fall == faelle.NichtNachweisbar || fall == faelle.BoxInGebrauch:
		v = &Vorher{System: "OpenWrt mit Passwort", EdgeLight: "unbekannt"}
	default:
		return nil
	}
	v.System, v.EdgeLight = geheim.Schwaerze(v.System), geheim.Schwaerze(v.EdgeLight)
	return v
}
