// Package geraet erkennt, auf welchem Geraet die Box laeuft - Modell und
// Architektur (Geraete & Updates G8, Vertrag docs/contracts/v2/box-geraet.md).
//
// Die Box meldet das im Update-Block ihres Herzschlags (update.geraet), damit
// das Portal „Raspberry Pi", „PC" oder „Mango" zeigen kann statt nur die
// Software-Linie. Das Modell ist eine ANGABE des Geraets, nie eine Vermutung:
// ist keine Quelle lesbar oder nennt sie nur Platzhalter, bleibt es leer.
//
// Quellen, in dieser Reihenfolge (die erste mit Inhalt gewinnt):
//
//  1. /tmp/sysinfo/model - OpenWrt (Edge Light auf der Mango, auf dem Pi).
//  2. /proc/device-tree/model, /sys/firmware/devicetree/base/model - ARM-Boards.
//     Im Docker-Container ist /sys/firmware maskiert.
//  3. die Zeile „Model" in /proc/cpuinfo - Raspberry-Pi-Kerne, auch im
//     Container lesbar (die Docker-Box auf dem Pi).
//  4. DMI: /sys/class/dmi/id/sys_vendor und product_name - der PC; die
//     Platzhalter der Hersteller fallen weg.
//
// Die Architektur ist die des laufenden Programms (runtime.GOARCH): die
// Docker-Box zieht das Bild ihrer Architektur, Edge Light das Programm seiner.
package geraet

import (
	"bufio"
	"io/fs"
	"strings"
	"unicode/utf8"
)

// MaxModell ist die Laenge, auf die ein Modell hart gekuerzt wird (Zeichen).
const MaxModell = 80

// Erkannt ist, was die Box ueber ihr Geraet sagen kann.
type Erkannt struct {
	// Modell ist die Angabe des Geraets; "" = nicht lesbar.
	Modell string
	// Arch ist runtime.GOARCH des laufenden Programms.
	Arch string
}

// platzhalter sind Werte, die Hersteller in leere DMI-Felder schreiben.
var platzhalter = map[string]bool{
	"to be filled by o.e.m.": true,
	"default string":         true,
	"system product name":    true,
	"system manufacturer":    true,
	"system version":         true,
	"not applicable":         true,
	"not specified":          true,
	"none":                   true,
	"unknown":                true,
	"o.e.m.":                 true,
	"oem":                    true,
	"type1productconfigid":   true,
}

// Erkennen liest die Quellen aus fsys (in Betrieb os.DirFS("/"); Pfade ohne
// fuehrenden Schraegstrich) und nennt Modell und Architektur.
func Erkennen(fsys fs.FS, arch string) Erkannt {
	return Erkannt{Modell: modell(fsys), Arch: arch}
}

func modell(fsys fs.FS) string {
	for _, pfad := range []string{"tmp/sysinfo/model", "proc/device-tree/model",
		"sys/firmware/devicetree/base/model"} {
		if m := Normalisieren(lies(fsys, pfad)); m != "" {
			return m
		}
	}
	if m := Normalisieren(cpuinfoModell(lies(fsys, "proc/cpuinfo"))); m != "" {
		return m
	}
	hersteller := Normalisieren(lies(fsys, "sys/class/dmi/id/sys_vendor"))
	produkt := Normalisieren(lies(fsys, "sys/class/dmi/id/product_name"))
	switch {
	case produkt == "":
		return ""
	case hersteller == "" || strings.HasPrefix(strings.ToLower(produkt), strings.ToLower(hersteller)):
		return produkt
	default:
		return Normalisieren(hersteller + " " + produkt)
	}
}

// Normalisieren macht aus einer Rohangabe ein Modell: NUL-Bytes und Leerraum
// zusammengefasst, Platzhalter verworfen, hart auf MaxModell Zeichen gekuerzt.
func Normalisieren(roh string) string {
	s := strings.Join(strings.Fields(strings.ReplaceAll(roh, "\x00", " ")), " ")
	if s == "" || platzhalter[strings.ToLower(s)] {
		return ""
	}
	if utf8.RuneCountInString(s) > MaxModell {
		s = strings.TrimSpace(string([]rune(s)[:MaxModell]))
	}
	return s
}

// cpuinfoModell ist der Wert der Zeile „Model : …" (Raspberry-Pi-Kerne).
func cpuinfoModell(cpuinfo string) string {
	sc := bufio.NewScanner(strings.NewReader(cpuinfo))
	for sc.Scan() {
		schluessel, wert, ok := strings.Cut(sc.Text(), ":")
		if ok && strings.TrimSpace(schluessel) == "Model" {
			return wert
		}
	}
	return ""
}

func lies(fsys fs.FS, pfad string) string {
	raw, err := fs.ReadFile(fsys, pfad)
	if err != nil {
		return ""
	}
	return string(raw)
}
