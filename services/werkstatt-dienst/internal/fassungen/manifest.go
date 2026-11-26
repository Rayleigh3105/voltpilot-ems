package fassungen

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Das signierte Manifest einer Edge-Light-Fassung (Konzept
// vp-edge-light-update, K5): der Release-Lauf haengt release.json und
// release.json.sig an dasselbe Release wie Programm und Skripte, sobald er
// signiert (docs/ota-signing.md). Die Freigabe pinnt sie nicht - sie entstehen
// nach ihr. Gebunden wird das Manifest deshalb an das, was die Freigabe pinnt:
// es muss GENAU diese Fassung und GENAU dieses Programm beschreiben.
//
// PruefeManifest prueft nur diese Bindung (Struktur und Zugehoerigkeit zur
// Freigabe), keine Kryptographie. Die Signaturkette selbst - eingebackene
// Wurzel, Vertrauens-Set, Release-Schluessel - prueft [Ablage.PruefeSignatur]
// in signatur.go, VOR diesem Aufruf und auf den rohen Bytes: beim Einrichten
// genauso wie die Box es bei einem spaeteren Update tut, nicht erst sie
// selbst danach.
const (
	ManifestDatei = "release.json"
	SignaturDatei = "release.json.sig"
	MaxManifest   = 64 << 10
)

// ErrNichtSigniert: das Release traegt (noch) kein Manifest - eine Fassung der
// Stufe 1. Kein Fehler des Laufs, aber die Box wird nicht update-bereit.
var ErrNichtSigniert = errors.New("das Release traegt kein signiertes Manifest")

// Stand ist, was die Werkstatt aus dem Manifest braucht. PaketeSha256 und
// PaketeGroesse sind Prüfsumme und Größe des Paket-Anhangs
// (edge-light-pakete.tar.gz, Direktvermarktung Stufe 5) aus dem signierten
// Manifest - leer bei einer Fassung ohne Anhang (vor Stufe 5) und beim
// PFC200 (die Firmware bringt ihr OpenVPN mit).
type Stand struct {
	Release       string
	ReleaseSeq    int64
	StateSchema   int
	SigniertVon   string
	PaketeSha256  string
	PaketeGroesse int64
}

type manifestForm struct {
	Release     string `json:"release"`
	ReleaseSeq  int64  `json:"release_seq"`
	StateSchema int    `json:"state_schema"`
	Compat      struct {
		Backends []string `json:"backends"`
	} `json:"compat"`
	Artifacts []struct {
		Type   string `json:"type"`
		Arch   string `json:"arch"`
		SHA256 string `json:"sha256"`
	} `json:"artifacts"`
	SigningKeyID string `json:"signing_key_id"`
	// Was nur die Werkstatt braucht (additive Felder des Manifests, kein
	// Bestandteil des Updates): der Skriptstand und, bei Edge Industrie, das
	// Tunnel-Programm und (optional, auch bei Edge Industrie) die
	// Bootapplikation des Basisprojekts.
	Skripte       *beilage `json:"skripte"`
	Pakete        *beilage `json:"pakete"`
	Wartung       *beilage `json:"wartung"`
	Grundprogramm *beilage `json:"grundprogramm"`
}

type beilage struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// PruefeManifest prueft, dass das Manifest genau die Fassung der Freigabe und
// genau ihr Programm fuer die Bauart beschreibt, und dass die Signaturdatei
// dazu gehoert.
func PruefeManifest(manifest, signatur []byte, fassung, bauart, programmSha string) (Stand, error) {
	return PruefeManifestFuer(manifest, signatur, fassung, bauart, programmSha, "light")
}

// BackendsPFC200 sind die Update-Linien, die ein Manifest für den PFC200
// nennen darf: Edge Industrie (eigene Release-Linie edge-industrie-JJJJ.MM.N).
var BackendsPFC200 = []string{"industrie"}

// PruefeManifestPFC200 bindet das Manifest einer Edge-Industrie-Fassung an die
// Freigabe für den PFC200: genau diese Fassung, genau dieses Programm für
// linux/arm, und dazu genau dieser Skriptstand und genau dieses Tunnel-Programm.
// Das Tunnel-Programm läuft auf dem Gerät als root und öffnet den Fernzugang;
// seine Prüfsumme und die der Skripte nimmt der Dienst darum nicht allein aus
// der Freigabe, sondern verlangt sie im signierten Manifest. Eine Fassung,
// deren Manifest sie nicht nennt, richtet er nicht ein.
//
// grundprogrammSha ist, anders als skripteSha und wartungSha, oft leer: Die
// Bootapplikation des Basisprojekts ist auch bei Edge Industrie optional
// (die Freigabe trägt sie nur, wenn die Fassung sie signiert mitführt). Leer
// bindet nichts; der Schritt grundprogramm erkennt das Fehlen selbst.
func PruefeManifestPFC200(manifest, signatur []byte, fassung, programmSha, skripteSha, wartungSha, grundprogrammSha string) (Stand, error) {
	st, err := PruefeManifestFuer(manifest, signatur, fassung, "arm", programmSha, BackendsPFC200...)
	if err != nil {
		return Stand{}, err
	}
	var m manifestForm
	if err := json.Unmarshal(manifest, &m); err != nil {
		return Stand{}, fmt.Errorf("release.json ist kein gueltiges JSON: %w", err)
	}
	for _, b := range []struct {
		was, name, soll string
		ist             *beilage
	}{
		{"den Skriptstand", IndustrieSkripteDatei, skripteSha, m.Skripte},
		{"das Tunnel-Programm", WartungProgramm, wartungSha, m.Wartung},
	} {
		switch {
		case b.ist == nil:
			return Stand{}, fmt.Errorf("release.json nennt %s nicht (%s): Die Werkstatt richtet nur mit einer Fassung ein, die ihn signiert mitfuehrt", b.was, b.name)
		case b.ist.Name != b.name:
			return Stand{}, fmt.Errorf("release.json nennt fuer %s die Datei %q statt %s", b.was, b.ist.Name, b.name)
		case b.ist.SHA256 != b.soll:
			return Stand{}, fmt.Errorf("release.json beschreibt %s mit einer anderen Pruefsumme (%s) als die Freigabe (%s)", b.was, orKein(b.ist.SHA256), b.soll)
		}
	}
	if grundprogrammSha != "" {
		switch {
		case m.Grundprogramm == nil:
			return Stand{}, fmt.Errorf("release.json nennt die Bootapplikation nicht (%s), die Freigabe aber eine Pruefsumme dafuer", GrundprogrammDatei)
		case m.Grundprogramm.Name != GrundprogrammDatei:
			return Stand{}, fmt.Errorf("release.json nennt fuer die Bootapplikation die Datei %q statt %s", m.Grundprogramm.Name, GrundprogrammDatei)
		case m.Grundprogramm.SHA256 != grundprogrammSha:
			return Stand{}, fmt.Errorf("release.json beschreibt die Bootapplikation mit einer anderen Pruefsumme (%s) als die Freigabe (%s)", orKein(m.Grundprogramm.SHA256), grundprogrammSha)
		}
	}
	return st, nil
}

// PruefeManifestFuer ist PruefeManifest für ein Manifest, das genau eine der
// genannten Update-Linien trägt.
func PruefeManifestFuer(manifest, signatur []byte, fassung, bauart, programmSha string, backends ...string) (Stand, error) {
	var m manifestForm
	if err := json.Unmarshal(manifest, &m); err != nil {
		return Stand{}, fmt.Errorf("release.json ist kein gueltiges JSON: %w", err)
	}
	if m.Release != fassung {
		return Stand{}, fmt.Errorf("release.json nennt %q, die Freigabe %s", m.Release, fassung)
	}
	if m.ReleaseSeq < 1 {
		return Stand{}, errors.New("release.json traegt keine release_seq")
	}
	if len(m.Compat.Backends) != 1 || !slices.Contains(backends, m.Compat.Backends[0]) {
		if len(backends) == 1 && backends[0] == "light" {
			return Stand{}, fmt.Errorf("release.json gilt nicht fuer Edge Light (Backends %v)", m.Compat.Backends)
		}
		return Stand{}, fmt.Errorf("release.json gilt nicht fuer diese Box (Backends %v, erwartet eines von %v)", m.Compat.Backends, backends)
	}
	plattform := "linux/" + bauart
	gefunden := ""
	for _, a := range m.Artifacts {
		if a.Type == "binary" && a.Arch == plattform {
			gefunden = a.SHA256
		}
	}
	if gefunden != programmSha {
		return Stand{}, fmt.Errorf("release.json beschreibt fuer %s ein anderes Programm (%s) als die Freigabe (%s)",
			plattform, orKein(gefunden), programmSha)
	}
	var sig struct {
		KeyID  string `json:"key_id"`
		Domain string `json:"domain"`
	}
	if err := json.Unmarshal(signatur, &sig); err != nil || sig.Domain != "release" || sig.KeyID == "" ||
		sig.KeyID != m.SigningKeyID {
		return Stand{}, errors.New("release.json.sig gehoert nicht zu release.json")
	}
	st := Stand{Release: m.Release, ReleaseSeq: m.ReleaseSeq, StateSchema: m.StateSchema, SigniertVon: sig.KeyID}
	// Der Paket-Anhang der Direktvermarktung (Stufe 5), nur Edge Light. Eine
	// Fassung ohne das Feld bleibt gueltig (vor Stufe 5); traegt sie es, muss
	// es vollstaendig sein - eine halbe Angabe pinnt nichts.
	if strings.HasPrefix(m.Release, "edge-light-") && m.Pakete != nil {
		switch {
		case m.Pakete.Name != PaketeDatei:
			return Stand{}, fmt.Errorf("release.json nennt fuer den Paket-Anhang die Datei %q statt %s", m.Pakete.Name, PaketeDatei)
		case len(m.Pakete.SHA256) != 64 || strings.Trim(m.Pakete.SHA256, "0123456789abcdef") != "":
			return Stand{}, errors.New("release.json: pakete.sha256 muss 64 Zeichen 0-9a-f haben")
		case m.Pakete.Size <= 0:
			return Stand{}, errors.New("release.json: pakete.size muss groesser als 0 sein")
		}
		st.PaketeSha256, st.PaketeGroesse = m.Pakete.SHA256, m.Pakete.Size
	}
	return st, nil
}

func orKein(s string) string {
	if s == "" {
		return "keins"
	}
	return s
}

// HoleManifest liefert release.json und release.json.sig der Fassung - aus
// dem Zwischenspeicher (<Dir>/manifest/<fassung>.json(.sig)) oder, beim ersten
// Mal, von der Quelle der Fassung (dann abgelegt). HTTP 404 =
// [ErrNichtSigniert]. Gebunden wird das Manifest erst durch [PruefeManifest].
func (a *Ablage) HoleManifest(ctx context.Context, quelle, fassung string) (manifest, signatur []byte, err error) {
	dir := filepath.Join(a.Dir, "manifest")
	pfad := filepath.Join(dir, fassung+".json")
	if m, err1 := os.ReadFile(pfad); err1 == nil {
		if s, err2 := os.ReadFile(pfad + ".sig"); err2 == nil {
			return m, s, nil
		}
	}
	if manifest, err = a.holeOffen(ctx, quelle, ManifestDatei, true); err != nil {
		return nil, nil, err
	}
	if signatur, err = a.holeOffen(ctx, quelle, SignaturDatei, true); err != nil {
		return nil, nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err == nil {
		_ = os.WriteFile(pfad, manifest, 0o600)
		_ = os.WriteFile(pfad+".sig", signatur, 0o600)
	}
	return manifest, signatur, nil
}

// HoleVertrauensSet laedt trust-set.json und .sig offen aus dem Portal. Das Set
// ist oeffentlich und wird auf der Box gegen ihre eingebackene Wurzel geprueft;
// ein http-Portal (Probe) ist deshalb erlaubt.
func (a *Ablage) HoleVertrauensSet(ctx context.Context, portal string) (set, signatur []byte, err error) {
	quelle := strings.TrimRight(portal, "/") + "/api/v1/edge/trust-set/"
	if set, err = a.holeOffen(ctx, quelle, "trust-set.json", false); err != nil {
		return nil, nil, err
	}
	if signatur, err = a.holeOffen(ctx, quelle, "trust-set.json.sig", false); err != nil {
		return nil, nil, err
	}
	return set, signatur, nil
}

func (a *Ablage) holeOffen(ctx context.Context, quelle, name string, nurHTTPS bool) ([]byte, error) {
	adresse := verbinde(quelle, name)
	u, err := url.Parse(adresse)
	if err != nil || (u.Scheme != "https" && (nurHTTPS || u.Scheme != "http")) {
		return nil, fmt.Errorf("%s: keine erlaubte Adresse (%s)", name, adresse)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, adresse, nil)
	if err != nil {
		return nil, err
	}
	if !a.Token.Leer() && a.TokenHost != "" && u.Host == a.TokenHost {
		req.Header.Set("Authorization", "token "+a.Token.Offenbaren())
	}
	cl := a.Client
	if cl == nil {
		cl = &http.Client{Timeout: time.Minute}
	}
	resp, err := cl.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s laden: %s", name, geheim.Schwaerze(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNichtSigniert
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s laden: HTTP %d von %s", name, resp.StatusCode, adresse)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxManifest+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > MaxManifest {
		return nil, fmt.Errorf("%s ist zu gross", name)
	}
	return raw, nil
}
