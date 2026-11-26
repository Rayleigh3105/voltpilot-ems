// Package otapakete liest und prueft den Paket-Anhang eines Edge-Light-Release
// (edge-light-pakete.tar.gz, Manifest-Feld pakete; vp-direktvermarktung-konzept
// d2, E5/Stufe 5, PS-D10): die OpenWrt-Pakete des Direktvermarkter-Anschlusses.
//
// Wie otaverify gilt: erst die Bytes pruefen, dann parsen. Der Aufrufer haelt
// den ganzen Anhang gegen pakete.sha256 aus dem VERIFIZIERTEN Manifest; dieses
// Paket prueft danach den inneren Aufbau - die INHALT-Liste, und dass jede
// Paketdatei genau die dort gepinnte Pruefsumme traegt. Installiert wird nur,
// was in INHALT steht; fremde Eintraege, Pfade oder Verweise im Archiv sind
// ein Fehler, nie eine Ueberraschung im Dateisystem.
package otapakete

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
)

// MaxAnhang begrenzt den entpackten Anhang (die 7 Pakete von 25.12.5 messen
// zusammen ~0,4 MB; die Grenze laesst Luft fuer gehobene Pins).
const MaxAnhang = 16 << 20

// Eintrag ist eine Paketdatei laut INHALT.
type Eintrag struct {
	Datei  string // z. B. openvpn-mbedtls-2.7.8-r1.apk
	SHA256 string
}

// Paket ist der Paketname ohne .apk (z. B. openvpn-mbedtls-2.7.8-r1): genau
// die Form, in der apk list --installed ein installiertes Paket nennt.
func (e Eintrag) Paket() string { return strings.TrimSuffix(e.Datei, ".apk") }

// Name ist der Paketname ohne Fassung (openvpn-mbedtls-2.7.8-r1 ->
// openvpn-mbedtls): was apk add/del als Paket kennt. Die Fassung beginnt am
// ersten "-<ziffer>".
func (e Eintrag) Name() string {
	p := e.Paket()
	for i := 1; i+1 < len(p); i++ {
		if p[i] == '-' && p[i+1] >= '0' && p[i+1] <= '9' {
			return p[:i]
		}
	}
	return p
}

// Inhalt ist der geprueft gelesene Anhang.
type Inhalt struct {
	OpenWrt   string // Fassung des OpenWrt-Abbilds, zu dem die Pakete gehoeren
	Arch      string // z. B. mipsel_24kc - die apk-Architektur (apk --print-arch)
	Eintraege []Eintrag
	// Dateien sind die Bytes je Paketdatei, schon gegen INHALT geprueft.
	Dateien map[string][]byte
}

var (
	dateiRe  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._+-]*\.apk$`)
	sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Lies entpackt und prueft den Anhang. roh sind die Bytes von
// edge-light-pakete.tar.gz, NACHDEM der Aufrufer sie gegen pakete.sha256 aus
// dem verifizierten Manifest gehalten hat.
func Lies(roh []byte) (*Inhalt, error) {
	gz, err := gzip.NewReader(bytes.NewReader(roh))
	if err != nil {
		return nil, fmt.Errorf("der Paket-Anhang ist kein gzip: %w", err)
	}
	tr := tar.NewReader(gz)
	var inhaltRoh []byte
	dateien := map[string][]byte{}
	var gesamt int64
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("der Paket-Anhang ist kein tar: %w", err)
		}
		if h.Typeflag != tar.TypeReg {
			return nil, fmt.Errorf("der Paket-Anhang traegt %q, das keine gewoehnliche Datei ist", h.Name)
		}
		name, ok := strings.CutPrefix(h.Name, "pakete/")
		if !ok || strings.Contains(name, "/") || name == "" {
			return nil, fmt.Errorf("der Paket-Anhang traegt %q ausserhalb von pakete/", h.Name)
		}
		gesamt += h.Size
		if h.Size < 0 || gesamt > MaxAnhang {
			return nil, fmt.Errorf("der Paket-Anhang ist groesser als %d Bytes", MaxAnhang)
		}
		daten, err := io.ReadAll(io.LimitReader(tr, MaxAnhang+1))
		if err != nil {
			return nil, err
		}
		if name == "INHALT" {
			inhaltRoh = daten
			continue
		}
		if !dateiRe.MatchString(name) {
			return nil, fmt.Errorf("der Paket-Anhang traegt %q, das keine Paketdatei (.apk) ist", name)
		}
		dateien[name] = daten
	}
	if inhaltRoh == nil {
		return nil, errors.New("dem Paket-Anhang fehlt die INHALT-Liste")
	}
	in := &Inhalt{Dateien: dateien}
	for _, zeile := range strings.Split(strings.TrimSpace(string(inhaltRoh)), "\n") {
		zeile = strings.TrimSpace(zeile)
		switch {
		case zeile == "":
		case strings.HasPrefix(zeile, "openwrt "):
			in.OpenWrt = strings.TrimSpace(strings.TrimPrefix(zeile, "openwrt "))
		case strings.HasPrefix(zeile, "arch "):
			in.Arch = strings.TrimSpace(strings.TrimPrefix(zeile, "arch "))
		default:
			sha, datei, ok := strings.Cut(zeile, "  ")
			if !ok || !sha256Re.MatchString(sha) || !dateiRe.MatchString(datei) {
				return nil, fmt.Errorf("INHALT-Zeile %q hat nicht die Form '<sha256>  <datei>.apk'", zeile)
			}
			in.Eintraege = append(in.Eintraege, Eintrag{Datei: datei, SHA256: sha})
		}
	}
	if in.Arch == "" || len(in.Eintraege) == 0 {
		return nil, errors.New("INHALT nennt keine Architektur oder keine Pakete")
	}
	// Genau die Eintraege, genau die Dateien, genau die Pruefsummen.
	if len(dateien) != len(in.Eintraege) {
		return nil, fmt.Errorf("der Paket-Anhang traegt %d Dateien, INHALT nennt %d", len(dateien), len(in.Eintraege))
	}
	for _, e := range in.Eintraege {
		daten, ok := dateien[e.Datei]
		if !ok {
			return nil, fmt.Errorf("INHALT nennt %s, die Datei fehlt im Anhang", e.Datei)
		}
		h := sha256.Sum256(daten)
		if hex.EncodeToString(h[:]) != e.SHA256 {
			return nil, fmt.Errorf("%s hat nicht die Pruefsumme aus INHALT - nichts wird installiert", e.Datei)
		}
	}
	return in, nil
}
