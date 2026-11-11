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
	"strings"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// Das signierte Manifest einer Edge-Light-Fassung (Konzept
// vp-edge-light-update, K5): der Release-Lauf haengt release.json und
// release.json.sig an dasselbe Release wie Programm und Skripte, sobald er
// signiert (docs/ota-signing.md). Die Freigabe pinnt sie nicht - sie entstehen
// nach ihr. Gebunden wird das Manifest deshalb an das, was die Freigabe pinnt:
// es muss GENAU diese Fassung und GENAU dieses Programm beschreiben. Die
// Signatur prueft die Box selbst gegen ihre eingebackene Wurzel.
const (
	ManifestDatei = "release.json"
	SignaturDatei = "release.json.sig"
	MaxManifest   = 64 << 10
)

// ErrNichtSigniert: das Release traegt (noch) kein Manifest - eine Fassung der
// Stufe 1. Kein Fehler des Laufs, aber die Box wird nicht update-bereit.
var ErrNichtSigniert = errors.New("das Release traegt kein signiertes Manifest")

// Stand ist, was die Werkstatt aus dem Manifest braucht.
type Stand struct {
	Release     string
	ReleaseSeq  int64
	StateSchema int
	SigniertVon string
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
}

// PruefeManifest prueft, dass das Manifest genau die Fassung der Freigabe und
// genau ihr Programm fuer die Bauart beschreibt, und dass die Signaturdatei
// dazu gehoert.
func PruefeManifest(manifest, signatur []byte, fassung, bauart, programmSha string) (Stand, error) {
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
	if len(m.Compat.Backends) != 1 || m.Compat.Backends[0] != "light" {
		return Stand{}, fmt.Errorf("release.json gilt nicht fuer Edge Light (Backends %v)", m.Compat.Backends)
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
	return Stand{Release: m.Release, ReleaseSeq: m.ReleaseSeq, StateSchema: m.StateSchema, SigniertVon: sig.KeyID}, nil
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
