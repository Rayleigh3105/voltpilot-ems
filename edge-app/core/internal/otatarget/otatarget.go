// Package otatarget carries the CLOUD-ASSIGNED update target of this device:
// the retained envelope on ems/{t}/{s}/{d}/v2/update
// (docs/contracts/mqtt-ota-target.schema.json, OTA Stufe 2 „Verteilen").
//
// It is pure: parse, store, describe. It verifies nothing (that is
// [otaverify], which owns the whole trust decision) and it applies nothing -
// in this stage the box NEVER updates itself. The strongest thing that happens
// here is that a verified assignment ends up on disk and is described to the
// supervised `update.sh --from-target` run and to the heartbeat.
//
// # Warum der Umschlag base64 traegt und nicht ein eingebettetes Objekt
//
// Die Signatur geht ueber die EXAKTEN Bytes der release.json. Ein JSON-Objekt
// im Umschlag muesste zum Pruefen neu serialisiert werden - genau die
// Mehrdeutigkeit (Schluesselreihenfolge, Leerraum, Zahlenformat), aus der
// Signatur-Umgehungen entstehen. Base64 ist byteweise verlustfrei, also
// erreichen den Verifizierer dieselben Bytes, die der Owner unterschrieben hat.
//
// # Warum der Umschlag KEINE Autoritaet ist
//
// release/release_seq/channel im Umschlag sind Routing und Diagnose. Der
// Umschlag ist UNSIGNIERT; jede Entscheidung (welches Release, welche Ordnung,
// welche Artefakte, Boden, Backend) wird ausschliesslich aus dem VERIFIZIERTEN
// Manifest gelesen. Widersprechen sich beide, gewinnt das Manifest.
package otatarget

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// SchemaVersion ist die Formatversion des Umschlags.
const SchemaVersion = "1.0"

// EnvelopeType ist der einzige akzeptierte Typ.
const EnvelopeType = "update_target"

// MaxEnvelopeBytes begrenzt, was ein Umschlag ueberhaupt sein darf. Ein
// Manifest ist wenige Kilobyte gross; die Grenze verhindert, dass eine
// fehlgeleitete retained Nachricht den Speicher des Geraets fuellt.
const MaxEnvelopeBytes = 64 * 1024

var (
	releaseRe = regexp.MustCompile(`^edge-\d{4}\.\d{2}\.\d+$`)
	uuidRe    = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
)

// Channels des Rollouts (reine Diagnose auf dem Geraet).
const (
	ChannelCanary = "canary"
	ChannelStable = "stable"
)

// Envelope ist die geparste Zuweisung.
//
// Manifest/Signature sind die DEKODIERTEN Rohbytes - genau das, was
// [otaverify.Verify] erwartet.
type Envelope struct {
	TenantID   string
	SiteID     string
	DeviceID   string
	Release    string
	ReleaseSeq int64
	Channel    string
	RolloutID  string
	AssignedAt string
	Manifest   []byte
	Signature  []byte
}

type wireEnvelope struct {
	SchemaVersion string `json:"schema_version"`
	Type          string `json:"type"`
	TenantID      string `json:"tenant_id"`
	SiteID        string `json:"site_id"`
	DeviceID      string `json:"device_id"`
	Release       string `json:"release"`
	ReleaseSeq    int64  `json:"release_seq"`
	Channel       string `json:"channel,omitempty"`
	RolloutID     string `json:"rollout_id,omitempty"`
	AssignedAt    string `json:"assigned_at,omitempty"`
	ManifestB64   string `json:"manifest_b64"`
	SignatureB64  string `json:"signature_b64"`
}

// ParseEnvelope liest eine Zuweisung und prueft ihre FORM.
//
// Es findet hier keine Vertrauensentscheidung statt: eine wohlgeformte
// Zuweisung kann immer noch ein gefaelschtes Manifest tragen. Genau dafuer
// steht danach [otaverify.Verify] mit der eingebackenen Wurzel.
func ParseEnvelope(raw []byte) (*Envelope, error) {
	if len(raw) == 0 {
		return nil, errors.New("leere Zuweisung")
	}
	if len(raw) > MaxEnvelopeBytes {
		return nil, fmt.Errorf("Zuweisung ist zu gross (%d Bytes, erlaubt sind %d)",
			len(raw), MaxEnvelopeBytes)
	}
	var w wireEnvelope
	if err := json.Unmarshal(raw, &w); err != nil {
		return nil, fmt.Errorf("Zuweisung ist kein gueltiges JSON: %w", err)
	}
	if w.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("schema_version '%s' wird von diesem Stand nicht unterstuetzt",
			w.SchemaVersion)
	}
	if w.Type != EnvelopeType {
		return nil, fmt.Errorf("unerwarteter Typ '%s'", w.Type)
	}
	for name, v := range map[string]string{
		"tenant_id": w.TenantID, "site_id": w.SiteID, "device_id": w.DeviceID,
	} {
		if !uuidRe.MatchString(v) {
			return nil, fmt.Errorf("%s ist keine UUID", name)
		}
	}
	if !releaseRe.MatchString(w.Release) {
		return nil, fmt.Errorf("release '%s' folgt nicht dem Schema edge-JJJJ.MM.N", w.Release)
	}
	if w.ReleaseSeq < 1 {
		return nil, errors.New("release_seq muss >= 1 sein")
	}
	if w.Channel != "" && w.Channel != ChannelCanary && w.Channel != ChannelStable {
		return nil, fmt.Errorf("unbekannter Kanal '%s'", w.Channel)
	}
	if w.RolloutID != "" && !uuidRe.MatchString(w.RolloutID) {
		return nil, errors.New("rollout_id ist keine UUID")
	}
	// Beides oder nichts: Bytes ohne Signatur waeren ein Release, das sich
	// signiert NENNT; eine Signatur ohne die Bytes ist wertlos. Dieselbe
	// Alles-oder-nichts-Regel wie im Register (edge_release_signed_pair).
	if strings.TrimSpace(w.ManifestB64) == "" || strings.TrimSpace(w.SignatureB64) == "" {
		return nil, errors.New("Manifest und Signatur gehoeren zusammen - es kam nur eines von beiden")
	}
	manifest, err := base64.StdEncoding.DecodeString(w.ManifestB64)
	if err != nil {
		return nil, fmt.Errorf("manifest_b64 ist kein gueltiges Base64: %w", err)
	}
	signature, err := base64.StdEncoding.DecodeString(w.SignatureB64)
	if err != nil {
		return nil, fmt.Errorf("signature_b64 ist kein gueltiges Base64: %w", err)
	}
	return &Envelope{
		TenantID: w.TenantID, SiteID: w.SiteID, DeviceID: w.DeviceID,
		Release: w.Release, ReleaseSeq: w.ReleaseSeq, Channel: w.Channel,
		RolloutID: w.RolloutID, AssignedAt: w.AssignedAt,
		Manifest: manifest, Signature: signature,
	}, nil
}

// MatchesIdentity sagt, ob die Zuweisung fuer GENAU dieses Geraet gilt.
//
// Der Broker laesst ein Geraet ohnehin nur sein eigenes Topic abonnieren, aber
// die Identitaet wird - wie bei Telemetrie, purge_data und dem Entity-Push -
// noch einmal gegen die Nutzlast geprueft: eine Zuweisung, die jemand anderen
// meint, wird verworfen statt angewandt.
func (e *Envelope) MatchesIdentity(tenantID, siteID, deviceID string) bool {
	return strings.EqualFold(e.TenantID, tenantID) &&
		strings.EqualFold(e.SiteID, siteID) &&
		strings.EqualFold(e.DeviceID, deviceID)
}

// Store haelt die zuletzt empfangene Zuweisung durabel.
//
// Gespeichert werden die ROHEN Bytes des Umschlags in EINER Datei. Das ist
// nicht Bequemlichkeit, sondern die Integritaets-Entscheidung: ein Umschlag,
// den wir zerlegen und neu zusammensetzen, koennte die Manifest-Bytes
// veraendern. Ein Schreibvorgang, eine Datei, ein Rename - es gibt keinen
// halb geschriebenen Zustand.
type Store struct {
	dir string
}

// NewStore liegt unter <data_dir>/ota/ neben dem beaufsichtigten Ablagepfad
// der Stufe 1.
func NewStore(dataDir string) *Store {
	return &Store{dir: filepath.Join(dataDir, "ota")}
}

// Path ist der Ablageort der Zuweisung.
func (s *Store) Path() string { return filepath.Join(s.dir, "target.json") }

// Save legt die ROHEN Umschlag-Bytes atomar ab (tmp + rename).
func (s *Store) Save(raw []byte) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	tmp := s.Path() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path())
}

// Load liefert die abgelegten Rohbytes; os.IsNotExist wenn keine Zuweisung da ist.
func (s *Store) Load() ([]byte, error) {
	return os.ReadFile(s.Path())
}

// Clear nimmt die Zuweisung zurueck (leere retained Nachricht / Unclaim).
func (s *Store) Clear() error {
	err := os.Remove(s.Path())
	if err != nil && os.IsNotExist(err) {
		return nil
	}
	return err
}

// View ist die Beschreibung der Zuweisung fuer die lokalen Oberflaechen und
// fuer `update.sh --from-target`.
//
// EHRLICHKEIT: Images werden NUR gefuellt, wenn die Kette geprueft ist
// (Verdict == "ok"). Ein Digest aus einem ungeprueften Manifest waere genau
// das, was die Signatur verhindern soll - und `update.sh` wuerde ihn anwenden.
type View struct {
	HasTarget bool `json:"has_target"`
	// Verdict ist das Urteil des Verifizierers: ok | deferred | rejected.
	// Leer, solange nichts geprueft wurde.
	Verdict string `json:"verdict,omitempty"`
	// Reason ist der deutsche Grund - bei jedem Nicht-ok Pflicht.
	Reason string `json:"reason,omitempty"`
	// Release/ReleaseSeq stammen aus dem VERIFIZIERTEN Manifest, sobald es
	// eines gibt; sonst aus dem (unsignierten) Umschlag, klar markiert durch
	// Verdict != "ok".
	Release    string `json:"release,omitempty"`
	ReleaseSeq int64  `json:"release_seq,omitempty"`
	Channel    string `json:"channel,omitempty"`
	RolloutID  string `json:"rollout_id,omitempty"`
	AssignedAt string `json:"assigned_at,omitempty"`
	// Running sagt, ob dieses Geraet den zugewiesenen Stand BEREITS faehrt.
	Running bool `json:"running"`
	// Images sind die digest-gepinnten Artefakt-Referenzen, nach Name
	// (core, nodered). Nur bei Verdict == "ok" gefuellt.
	Images map[string]string `json:"images,omitempty"`
	// AppliedRelease/AppliedSeq sind der zuletzt beaufsichtigt ANGEWANDTE
	// Stand dieses Geraets (<data>/ota/current.json), falls bekannt.
	AppliedRelease string `json:"applied_release,omitempty"`
	AppliedSeq     int64  `json:"applied_seq,omitempty"`
}
