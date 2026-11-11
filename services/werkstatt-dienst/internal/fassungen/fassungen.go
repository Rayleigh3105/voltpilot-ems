// Package fassungen legt die Dateien einer Freigabe bereit (WI-9 A: feste
// Fassungen mit Prüfsummen): das OpenWrt-Abbild, das Edge-Light-Programm für
// die Bauart der Box und den Skriptstand aus demselben Release-Tag.
//
// Ablage nach Prüfsumme im Datenverzeichnis (<daten>/fassungen/<sha256>): Was
// einmal geladen und geprüft ist, wird nicht noch einmal geladen. Eine Datei
// mit falscher Prüfsumme wird nie benutzt. Der Betreiber kann die Ablage auch
// von Hand füllen (kubectl cp), wenn der Pod nicht ins Internet darf.
//
// Release-Anhänge einer Edge-Light-Fassung unter edge_light.quelle:
//
//	vp-edge-light-linux-<bauart>   das Programm (wie edge-light/dist/)
//	edge-light-openwrt.tar.gz      edge-light/openwrt/ als openwrt/… (install.sh,
//	                               service-tunnel.sh, files/)
package fassungen

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Namen der Release-Anhänge.
const (
	SkripteDatei    = "edge-light-openwrt.tar.gz"
	ProgrammPraefix = "vp-edge-light-linux-"
)

// Grenzen für das Laden.
const (
	MaxAbbild   = 32 << 20
	MaxProgramm = 64 << 20
	MaxSkripte  = 4 << 20
)

// Datei ist eine Datei der Freigabe.
type Datei struct {
	Name   string // für Belege
	URL    string
	Sha256 string
	Max    int64
}

// Dateien gibt die Dateien einer Freigabe für eine Bauart zurück.
func Dateien(f freigabe.Freigabe, bauart string) (abbild, programm, skripte Datei) {
	abbild = Datei{Name: f.OpenWrt.Datei, URL: verbinde(f.OpenWrt.Quelle, f.OpenWrt.Datei), Sha256: f.OpenWrt.Sha256, Max: MaxAbbild}
	programm = Datei{Name: ProgrammPraefix + bauart, URL: verbinde(f.EdgeLight.Quelle, ProgrammPraefix+bauart), Sha256: f.EdgeLight.ProgrammSha256, Max: MaxProgramm}
	skripte = Datei{Name: SkripteDatei, URL: verbinde(f.EdgeLight.Quelle, SkripteDatei), Sha256: f.EdgeLight.SkripteSha256, Max: MaxSkripte}
	return
}

func verbinde(basis, name string) string {
	if !strings.HasSuffix(basis, "/") {
		basis += "/"
	}
	return basis + url.PathEscape(name)
}

// Ablage ist der Zwischenspeicher.
type Ablage struct {
	Dir       string
	Token     geheim.Geheim // Lese-Token für die Release-Anhänge (privates Repo), nur an TokenHost
	TokenHost string
	Client    *http.Client
}

// Ergebnis sagt, woher eine Datei kam.
type Ergebnis struct {
	Pfad    string
	Geladen bool // false: aus dem Zwischenspeicher
	Groesse int64
}

// Hole gibt den Pfad einer geprüften Datei zurück und lädt sie, wenn nötig.
func (a *Ablage) Hole(ctx context.Context, d Datei) (Ergebnis, error) {
	if len(d.Sha256) != 64 {
		return Ergebnis{}, fmt.Errorf("%s: keine Prüfsumme", d.Name)
	}
	if err := os.MkdirAll(a.Dir, 0o700); err != nil {
		return Ergebnis{}, err
	}
	ziel := filepath.Join(a.Dir, d.Sha256)
	if summe, n, err := summeVon(ziel); err == nil {
		if summe == d.Sha256 {
			return Ergebnis{Pfad: ziel, Groesse: n}, nil
		}
		_ = os.Remove(ziel) // falscher Inhalt unter dem Namen: weg damit
	}
	u, err := url.Parse(d.URL)
	if err != nil || u.Scheme != "https" {
		return Ergebnis{}, fmt.Errorf("%s: nur https (%s)", d.Name, d.URL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.URL, nil)
	if err != nil {
		return Ergebnis{}, err
	}
	if !a.Token.Leer() && a.TokenHost != "" && u.Host == a.TokenHost {
		req.Header.Set("Authorization", "token "+a.Token.Offenbaren())
	}
	cl := a.Client
	if cl == nil {
		cl = &http.Client{Timeout: 5 * time.Minute}
	}
	resp, err := cl.Do(req)
	if err != nil {
		return Ergebnis{}, fmt.Errorf("%s laden: %s", d.Name, geheim.Schwaerze(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Ergebnis{}, fmt.Errorf("%s laden: HTTP %d von %s", d.Name, resp.StatusCode, d.URL)
	}
	tmp, err := os.CreateTemp(a.Dir, ".laden-*")
	if err != nil {
		return Ergebnis{}, err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, d.Max+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Ergebnis{}, fmt.Errorf("%s laden: %v", d.Name, err)
	}
	if n > d.Max {
		return Ergebnis{}, fmt.Errorf("%s ist größer als %d MiB", d.Name, d.Max>>20)
	}
	if ist := hex.EncodeToString(h.Sum(nil)); ist != d.Sha256 {
		return Ergebnis{}, fmt.Errorf("%s hat die Prüfsumme %s, die Freigabe nennt %s: nicht benutzt", d.Name, ist, d.Sha256)
	}
	if err := os.Rename(tmp.Name(), ziel); err != nil {
		return Ergebnis{}, err
	}
	return Ergebnis{Pfad: ziel, Geladen: true, Groesse: n}, nil
}

func summeVon(p string) (string, int64, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}

// Summe gibt die Prüfsumme einer Datei zurück.
func Summe(p string) (string, error) { s, _, err := summeVon(p); return s, err }

// Auspacken packt den Skriptstand nach dir aus (dir/openwrt/…). Nur
// gewöhnliche Dateien und Verzeichnisse unter openwrt/, keine Pfade nach
// außen, keine Verweise.
func Auspacken(tarGz, dir string) error {
	f, err := os.Open(tarGz)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("Skriptstand: %v", err)
	}
	tr := tar.NewReader(gz)
	gesamt := int64(0)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("Skriptstand: %v", err)
		}
		name := path.Clean(strings.TrimPrefix(h.Name, "./"))
		if name == "." {
			continue
		}
		if path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") || !(name == "openwrt" || strings.HasPrefix(name, "openwrt/")) {
			return fmt.Errorf("Skriptstand: %q liegt nicht unter openwrt/", h.Name)
		}
		ziel := filepath.Join(dir, filepath.FromSlash(name))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(ziel, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			gesamt += h.Size
			if gesamt > 16<<20 {
				return errors.New("Skriptstand: ausgepackt größer als 16 MiB")
			}
			if err := os.MkdirAll(filepath.Dir(ziel), 0o755); err != nil {
				return err
			}
			modus := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				modus = 0o755
			}
			out, err := os.OpenFile(ziel, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, modus)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, io.LimitReader(tr, h.Size))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("Skriptstand: %q ist keine gewöhnliche Datei", h.Name)
		}
	}
	for _, p := range []string{"openwrt/install.sh", "openwrt/service-tunnel.sh"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			return fmt.Errorf("Skriptstand ohne %s", p)
		}
	}
	return nil
}
