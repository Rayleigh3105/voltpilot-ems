// Package freigabe liest die Freigabe der Werkstatt: das Okay des Betreibers,
// dass der Dienst Boxen einrichten darf, und was er aufspielt (WI-4 A, WI-9 A).
//
// Eine Freigabe sagt zwei Dinge: welche Fassungen aufgespielt werden
// (OpenWrt-Abbild, Edge-Light-Programm, Skriptstand, je mit Prüfsumme) und bis
// wann. Sie gilt für jede Box, die in dieser Zeit eingesteckt wird, eine nach
// der anderen; die Obergrenze ist nur ein Schutz. Ohne laufende Freigabe
// richtet der Dienst keine Box ein.
//
// Im ersten Schnitt (V1a) ist die Freigabe eine Datei aus einer ConfigMap,
// die der Betreiber anlegt („Werkstatt freigeben“) und löscht oder mit
// beendet_am versieht („Freigabe beenden“), siehe docs/runbook.md. Mit V1
// kommt sie aus der API; der Dienst liest sie dann über dieselbe Schnittstelle
// Quelle.
package freigabe

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// Schema der Datei.
const Schema = "vp-werkstatt-freigabe.v1"

// BoxArt, für die eine Freigabe gilt: das Gerät an der Werkbank. Die Mango
// (Edge Light) und der WAGO PFC200 (Edge Industrie) haben je ihre eigene
// Freigabe, weil Ablauf und Fassungen je Gerät verschieden sind.
const (
	Mango  = "mango"
	PFC200 = "pfc200"
	Pi     = "pi"
)

// MaxDauer begrenzt, wie lange eine Freigabe laufen darf.
const MaxDauer = 92 * 24 * time.Hour

// Freigabe ist eine Freigabe der Werkstatt.
type Freigabe struct {
	Schema     string     `json:"schema"`
	Kennung    string     `json:"kennung"`
	BoxArt     string     `json:"box_art"`
	ErteiltVon string     `json:"erteilt_von"`
	ErteiltAm  time.Time  `json:"erteilt_am"`
	GueltigBis time.Time  `json:"gueltig_bis"`
	BeendetAm  *time.Time `json:"beendet_am,omitempty"`
	Obergrenze int        `json:"obergrenze"`
	// Mango: OpenWrt-Abbild und Edge-Light-Fassung. Bei einer Freigabe für
	// den PFC200 fehlen beide.
	OpenWrt   Abbild   `json:"openwrt,omitzero"`
	EdgeLight Programm `json:"edge_light,omitzero"`
	// PFC200: die Edge-Industrie-Fassung. Bei einer Freigabe für die Mango
	// fehlt sie.
	EdgeIndustrie Industrie `json:"edge_industrie,omitzero"`
	// Kein LAN-Netz: Auf welches Netz eine Box kommt, ist Konfiguration des
	// Dienstes (VP_WERKSTATT_LAN_NETZ), weil die Brücke darin eine Adresse
	// braucht. Eine Freigabe mit lan_netz scheitert am unbekannten Feld.
}

// Abbild ist das OpenWrt-Abbild der Freigabe.
type Abbild struct {
	Fassung string `json:"fassung"`
	Datei   string `json:"datei"`
	Sha256  string `json:"sha256"`
	Quelle  string `json:"quelle"`
}

// Programm ist die Edge-Light-Fassung der Freigabe: das Programm (mipsle)
// und der Skriptstand (install.sh, service-tunnel.sh und ihre Dateien) aus
// demselben Release-Tag.
type Programm struct {
	Fassung        string `json:"fassung"`
	Quelle         string `json:"quelle"`
	ProgrammSha256 string `json:"programm_sha256"`
	SkripteSha256  string `json:"skripte_sha256"`
}

// Industrie ist die Edge-Industrie-Fassung der Freigabe für den PFC200: das
// Programm (linux/arm), der Skriptstand (install.sh, wartung.sh und ihre
// Dateien) und das Tunnel-Programm vp-wartung aus demselben Release-Tag. Ein
// OpenWrt-Abbild gibt es nicht: Die Firmware des PFC200 fasst der Dienst nicht
// an.
type Industrie struct {
	Fassung        string `json:"fassung"`
	Quelle         string `json:"quelle"`
	ProgrammSha256 string `json:"programm_sha256"`
	SkripteSha256  string `json:"skripte_sha256"`
	WartungSha256  string `json:"wartung_sha256"`
}

var (
	kennungMuster       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,40}$`)
	sha256Muster        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	dateiMuster         = regexp.MustCompile(`^[A-Za-z0-9._-]+-sysupgrade\.bin$`)
	openwrtMuster       = regexp.MustCompile(`^[0-9]{2}\.[0-9]{2}\.[0-9]+$`)
	edgeLightMuster     = regexp.MustCompile(`^edge-light-[0-9]{4}\.[0-9]{2}\.[0-9]+$`)
	edgeIndustrieMuster = regexp.MustCompile(`^edge-industrie-[0-9]{4}\.[0-9]{2}\.[0-9]+$`)
)

// Lies prüft eine Freigabe aus JSON. Unbekannte Felder sind ein Fehler: ein
// Tippfehler im Feldnamen soll keine Vorgabe stillschweigend gelten lassen.
func Lies(daten []byte) (Freigabe, error) {
	var f Freigabe
	dec := json.NewDecoder(bytes.NewReader(daten))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return Freigabe{}, fmt.Errorf("Freigabe ist kein gültiges JSON: %w", err)
	}
	if dec.More() {
		return Freigabe{}, errors.New("Freigabe: nach dem Objekt folgt noch etwas")
	}
	if err := f.pruefe(); err != nil {
		return Freigabe{}, err
	}
	return f, nil
}

func (f Freigabe) pruefe() error {
	var fehler []string
	add := func(format string, a ...any) { fehler = append(fehler, fmt.Sprintf(format, a...)) }
	if f.Schema != Schema {
		add("schema muss %q sein, nicht %q", Schema, f.Schema)
	}
	if !kennungMuster.MatchString(f.Kennung) {
		add("kennung %q: 3 bis 41 Zeichen aus a-z, 0-9 und -", f.Kennung)
	}
	switch f.BoxArt {
	case Mango, PFC200:
	case Pi:
		add("box_art pi: der Raspberry Pi kommt erst mit V2")
	default:
		add("box_art %q: erlaubt sind %q und %q", f.BoxArt, Mango, PFC200)
	}
	if strings.TrimSpace(f.ErteiltVon) == "" {
		add("erteilt_von fehlt")
	}
	if f.ErteiltAm.IsZero() || f.GueltigBis.IsZero() {
		add("erteilt_am und gueltig_bis sind Pflicht")
	} else {
		if !f.GueltigBis.After(f.ErteiltAm) {
			add("gueltig_bis liegt nicht nach erteilt_am")
		}
		if f.GueltigBis.Sub(f.ErteiltAm) > MaxDauer {
			add("eine Freigabe läuft höchstens %d Tage", int(MaxDauer.Hours()/24))
		}
	}
	if f.Obergrenze < 1 || f.Obergrenze > 200 {
		add("obergrenze %d: 1 bis 200", f.Obergrenze)
	}
	if f.BoxArt == PFC200 {
		f.pruefePFC200(add)
	} else {
		f.pruefeMango(add)
	}
	if f.BeendetAm != nil && f.BeendetAm.Before(f.ErteiltAm) {
		add("beendet_am liegt vor erteilt_am")
	}
	if len(fehler) > 0 {
		return fmt.Errorf("Freigabe ungültig: %s", strings.Join(fehler, "; "))
	}
	return nil
}

// pruefeMango: OpenWrt-Abbild und Edge-Light-Fassung, keine Edge-Industrie-Fassung.
func (f Freigabe) pruefeMango(add func(string, ...any)) {
	if !openwrtMuster.MatchString(f.OpenWrt.Fassung) {
		add("openwrt.fassung %q: Form 25.12.5", f.OpenWrt.Fassung)
	}
	if !dateiMuster.MatchString(f.OpenWrt.Datei) {
		add("openwrt.datei %q: ein sysupgrade-Abbild (…-sysupgrade.bin)", f.OpenWrt.Datei)
	} else if f.OpenWrt.Fassung != "" && !strings.Contains(f.OpenWrt.Datei, "-"+f.OpenWrt.Fassung+"-") {
		add("openwrt.datei %q passt nicht zur Fassung %s", f.OpenWrt.Datei, f.OpenWrt.Fassung)
	}
	if !sha256Muster.MatchString(f.OpenWrt.Sha256) {
		add("openwrt.sha256: 64 Zeichen 0-9a-f")
	}
	if err := httpsQuelle(f.OpenWrt.Quelle); err != nil {
		add("openwrt.quelle: %v", err)
	}
	if !edgeLightMuster.MatchString(f.EdgeLight.Fassung) {
		add("edge_light.fassung %q: Form edge-light-JJJJ.MM.N", f.EdgeLight.Fassung)
	}
	if err := httpsQuelle(f.EdgeLight.Quelle); err != nil {
		add("edge_light.quelle: %v", err)
	}
	if !sha256Muster.MatchString(f.EdgeLight.ProgrammSha256) {
		add("edge_light.programm_sha256: 64 Zeichen 0-9a-f")
	}
	if !sha256Muster.MatchString(f.EdgeLight.SkripteSha256) {
		add("edge_light.skripte_sha256: 64 Zeichen 0-9a-f")
	}
	if f.EdgeIndustrie != (Industrie{}) {
		add("edge_industrie gehört nur in eine Freigabe für den PFC200")
	}
}

// pruefePFC200: die Edge-Industrie-Fassung, kein OpenWrt und kein Edge Light.
func (f Freigabe) pruefePFC200(add func(string, ...any)) {
	if f.OpenWrt != (Abbild{}) || f.EdgeLight != (Programm{}) {
		add("openwrt und edge_light gehören nur in eine Freigabe für die Mango")
	}
	i := f.EdgeIndustrie
	if !edgeIndustrieMuster.MatchString(i.Fassung) {
		add("edge_industrie.fassung %q: Form edge-industrie-JJJJ.MM.N", i.Fassung)
	}
	if err := httpsQuelle(i.Quelle); err != nil {
		add("edge_industrie.quelle: %v", err)
	}
	if !sha256Muster.MatchString(i.ProgrammSha256) {
		add("edge_industrie.programm_sha256: 64 Zeichen 0-9a-f")
	}
	if !sha256Muster.MatchString(i.SkripteSha256) {
		add("edge_industrie.skripte_sha256: 64 Zeichen 0-9a-f")
	}
	if !sha256Muster.MatchString(i.WartungSha256) {
		add("edge_industrie.wartung_sha256: 64 Zeichen 0-9a-f")
	}
}

func httpsQuelle(s string) error {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return fmt.Errorf("%q ist keine https-Adresse", s)
	}
	return nil
}

// Keine heißt: Es läuft keine Freigabe. Grund nennt, warum.
type Keine struct{ Grund string }

func (k Keine) Error() string { return k.Grund }

// Laufend prüft, ob die Freigabe jetzt gilt; boxen ist die Zahl der Läufe,
// die unter ihr schon begonnen haben.
func (f Freigabe) Laufend(jetzt time.Time, boxen int) error {
	switch {
	case f.BeendetAm != nil && !jetzt.Before(*f.BeendetAm):
		return Keine{fmt.Sprintf("Freigabe %s ist beendet (%s)", f.Kennung, f.BeendetAm.Format(time.RFC3339))}
	case jetzt.Before(f.ErteiltAm):
		return Keine{fmt.Sprintf("Freigabe %s gilt erst ab %s", f.Kennung, f.ErteiltAm.Format(time.RFC3339))}
	case !jetzt.Before(f.GueltigBis):
		return Keine{fmt.Sprintf("Freigabe %s ist abgelaufen (%s)", f.Kennung, f.GueltigBis.Format(time.RFC3339))}
	case boxen >= f.Obergrenze:
		return Keine{fmt.Sprintf("Freigabe %s: Obergrenze von %d Boxen erreicht", f.Kennung, f.Obergrenze)}
	}
	return nil
}

// Quelle liefert die aktuelle Freigabe. Gibt es keine, ist der Fehler Keine.
type Quelle interface {
	Aktuell() (Freigabe, error)
}

// Datei liest die Freigabe bei jedem Aufruf neu aus einer Datei (ConfigMap).
type Datei struct{ Pfad string }

// Aktuell liest die Datei. Fehlt sie, läuft keine Freigabe.
func (d Datei) Aktuell() (Freigabe, error) {
	b, err := os.ReadFile(d.Pfad)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Freigabe{}, Keine{"Die Werkstatt ist nicht freigegeben (keine Freigabe-Datei)."}
		}
		return Freigabe{}, fmt.Errorf("Freigabe lesen: %w", err)
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return Freigabe{}, Keine{"Die Werkstatt ist nicht freigegeben (Freigabe-Datei leer)."}
	}
	return Lies(b)
}
