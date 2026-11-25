package direktvermarkter

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Ablage is the box's access store (vp-direktvermarktung-konzept d2 §5.7
// "Zustellung" / §8 "Ablage"): the delivered key material and the retained
// profile document, on disk so the tunnel can start with the system (§5.4
// "Neustart und Update") and a box that boots offline keeps its state.
//
// Per box kind the directory is:
//
//	Mango (Edge Light)      /etc/vp-edge-light/vermarkter   (root only)
//	PFC200 (Edge Industrie) /home/voltpilot/vermarkter      (the root copy the
//	                        firmware OpenVPN needs is Stage 4's root helper
//	                        vp-vermarkter, never this process)
//	Docker box              <DataDir>/vermarkter
//
// Every file is 0600 in a 0700 directory, written to a temp name and renamed.
// NOTHING in here is ever logged - the only loggable identifier is the
// fingerprint.
type Ablage struct {
	Dir string
}

const (
	ablageProfil      = "profil.json"
	ablageMeta        = "zugang-meta.json"
	ablageZertifikat  = "zertifikat.pem"
	ablageSchluessel  = "schluessel.pem"
	ablageCA          = "ca.pem"
	ablageTLS         = "tls-schluessel.pem"
	ablageGegenstelle = "gegenstelle.json"
	// AblageEreignisse is the event list beside the access (§5.4 "Nachweis");
	// written by Ereignisliste, named here so everything under Dir is listed
	// in one place.
	AblageEreignisse = "ereignisse"
)

// ZugangMeta is what the box remembers ABOUT the access - never the material
// itself. Its presence is the commit marker: it is written last on store and
// removed first on delete, so a torn write always reads as "no access".
type ZugangMeta struct {
	Fingerabdruck string `json:"fingerabdruck"`
	Partner       string `json:"partner"`
	GueltigBis    string `json:"gueltig_bis,omitempty"`
	GespeichertAm string `json:"gespeichert_am"`
}

func (a Ablage) path(name string) string { return filepath.Join(a.Dir, name) }

func (a Ablage) ensureDir() error {
	return os.MkdirAll(a.Dir, 0o700)
}

func (a Ablage) writeFile(name string, data []byte) error {
	path := a.path(name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// SpeichereProfil persists the raw retained profile document (the same bytes
// the cloud published), so a box that boots offline serves the partner with
// the profile it legitimately had - the controlcert pattern.
func (a Ablage) SpeichereProfil(raw []byte) error {
	if err := a.ensureDir(); err != nil {
		return err
	}
	return a.writeFile(ablageProfil, raw)
}

// LadeProfil returns the persisted profile document bytes; ok=false when none
// is stored.
func (a Ablage) LadeProfil() ([]byte, bool) {
	raw, err := os.ReadFile(a.path(ablageProfil))
	if err != nil || len(raw) == 0 {
		return nil, false
	}
	return raw, true
}

// LoescheProfil removes the persisted profile document.
func (a Ablage) LoescheProfil() error {
	if err := os.Remove(a.path(ablageProfil)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// SpeichereZugang stores the delivered access: key material and endpoint
// first, the meta (commit marker) last. A crash in between reads as "no
// access" and the box simply asks again.
func (a Ablage) SpeichereZugang(z *ZugangAntwort, now time.Time) error {
	if err := a.ensureDir(); err != nil {
		return err
	}
	files := map[string]string{
		ablageZertifikat: z.Dateien.ZertifikatPEM,
		ablageSchluessel: z.Dateien.SchluesselPEM,
		ablageCA:         z.Dateien.CAPEM,
	}
	for name, content := range files {
		if err := a.writeFile(name, []byte(content)); err != nil {
			return fmt.Errorf("zugang %s: %w", name, err)
		}
	}
	if strings.TrimSpace(z.Dateien.TLSSchluesselPEM) != "" {
		if err := a.writeFile(ablageTLS, []byte(z.Dateien.TLSSchluesselPEM)); err != nil {
			return fmt.Errorf("zugang %s: %w", ablageTLS, err)
		}
	} else if err := os.Remove(a.path(ablageTLS)); err != nil && !os.IsNotExist(err) {
		return err
	}
	gegenstelle, err := json.Marshal(z.Gegenstelle)
	if err != nil {
		return err
	}
	if err := a.writeFile(ablageGegenstelle, gegenstelle); err != nil {
		return fmt.Errorf("zugang %s: %w", ablageGegenstelle, err)
	}
	meta, err := json.Marshal(ZugangMeta{Fingerabdruck: z.ZugangFingerabdruck, Partner: z.Partner,
		GueltigBis: z.GueltigBis, GespeichertAm: now.UTC().Format(time.RFC3339)})
	if err != nil {
		return err
	}
	return a.writeFile(ablageMeta, meta)
}

// Zugang returns the stored access meta; ok=false when the box holds none.
func (a Ablage) Zugang() (ZugangMeta, bool) {
	raw, err := os.ReadFile(a.path(ablageMeta))
	if err != nil {
		return ZugangMeta{}, false
	}
	var m ZugangMeta
	if json.Unmarshal(raw, &m) != nil || strings.TrimSpace(m.Fingerabdruck) == "" {
		return ZugangMeta{}, false
	}
	return m, true
}

// LoescheZugang removes the stored access: the meta (commit marker) FIRST, so
// any failure midway still reads as "no access", then the material. Used on
// withdrawal and on a box swap - the old box deletes and acknowledges before
// the new one receives (§5.7, PS-D22).
func (a Ablage) LoescheZugang() error {
	for _, name := range []string{ablageMeta, ablageZertifikat, ablageSchluessel, ablageTLS, ablageGegenstelle, ablageCA} {
		if err := os.Remove(a.path(name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
