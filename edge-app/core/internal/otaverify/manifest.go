// Package otaverify verifies OTA release manifests. It VERIFIES AND REPORTS -
// there is deliberately NO apply path anywhere in this package, and none in the
// whole of OTA Stufe 1 „Vertrauen" (scout vp-ota-rollout-h4 §9).
//
// # Was hier signiert wird, und warum abgetrennt
//
// Die Signatur geht ueber die EXAKTEN ROHEN BYTES der Manifest-Datei. Deshalb
// hat das Manifest bewusst KEIN eingebettetes signature-Feld: ein solches Feld
// muesste zum Pruefen entfernt und der Rest neu serialisiert werden, und genau
// diese Re-Serialisierung ist die Luecke (Schluesselreihenfolge, Unicode-
// Escapes, Zahlenformat, doppelte Schluessel). Die Signatur liegt daneben in
// release.json.sig; die zu pruefenden Bytes werden NIE durch einen Parser
// geschickt, bevor die Signatur stimmt.
//
// Die Reihenfolge in [Verify] ist deshalb bindend und nicht bloss Stil:
// Bytes pruefen -> DANN parsen -> DANN Politik anwenden. Ein manipuliertes,
// syntaktisch einwandfreies Manifest scheitert an Schritt 1 und erreicht den
// Parser nie.
//
// # Ed25519, ohne Algorithmus-Agilitaet
//
// Ed25519 aus der Go-Standardbibliothek: kein einziger neuer Modul-Abhaengiger
// auf dem Geraet (der Core traegt heute nur paho + mochi), deterministisch,
// 32-Byte-Schluessel, 64-Byte-Signaturen und keine ASN.1-/Parameter-Flaeche,
// aus der bei RSA/ECDSA wiederholt Umgehungen entstanden sind. minisign ist
// darunter dasselbe Ed25519; cosign brachte einen ganzen Abhaengigkeitsbaum.
//
// Der Algorithmus ist FEST: [AlgEd25519] ist der einzige akzeptierte Wert.
// Ein Verifizierer, der den Algorithmus aus dem Dokument uebernimmt, laesst
// sich auf einen schwaecheren herunterhandeln - die klassische JWT-alg-Luecke.
//
// Kontrakt: docs/contracts/ota-release-manifest.schema.json +
// docs/contracts/ota-signature.schema.json. Zeremonie: docs/ota-signing.md.
package otaverify

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// AlgEd25519 ist der EINZIGE akzeptierte Signaturalgorithmus (siehe Paketdoku).
const AlgEd25519 = "ed25519"

// ManifestSchemaVersion ist die aktuelle Manifest-Formatversion.
//
// Verglichen wird nur die MAJOR-Stelle: unbekannte FELDER innerhalb von 1.x
// werden akzeptiert (ein Manifest traegt immer unsere Signatur, ein neues Feld
// stammt also per Konstruktion von uns), eine fremde MAJOR wird ABGELEHNT
// statt geraten. Das Schema beschreibt umgekehrt, was die Werkzeuge erzeugen,
// und ist dort additionalProperties:false - streng senden, tolerant annehmen.
const ManifestSchemaVersion = "1.0"

// Backends, fuer die ein Release bestimmt sein kann. Ein Geraet, dessen
// Backend nicht in compat.backends steht, lehnt ab statt zu raten - der Punkt
// des runtime-agnostischen Schnitts (§5).
const (
	BackendCompose = "compose"
	BackendQuadlet = "quadlet"
	BackendMender  = "mender"
)

// ArtifactOCIImage ist der heute einzige Artefakt-Typ.
const ArtifactOCIImage = "oci-image"

var (
	releaseRe   = regexp.MustCompile(`^edge-\d{4}\.\d{2}\.\d+$`)
	commitRe    = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	keyIDRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	artNameRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	digestRefRe = regexp.MustCompile(`^[^\s@]+@sha256:[0-9a-f]{64}$`)
)

// Manifest ist der Soll-Stand EINES Releases (§5).
//
// Invariant ueber jeden Runtime-Wechsel: alle Felder ausser [Manifest.Artifacts].
// Nur der Inhalt von Artifacts ist backend-spezifisch; ein Mender- oder
// quadlet-Backend tauscht ausschliesslich diese Liste.
type Manifest struct {
	SchemaVersion  string     `json:"schema_version"`
	Release        string     `json:"release"`
	ReleaseSeq     int64      `json:"release_seq"`
	TargetCommit   string     `json:"target_commit"`
	Artifacts      []Artifact `json:"artifacts"`
	MinFromSeq     int64      `json:"min_from_seq"`
	AllowDowngrade bool       `json:"allow_downgrade"`
	ValidUntil     string     `json:"valid_until,omitempty"`
	StateSchema    int        `json:"state_schema"`
	Compat         Compat     `json:"compat"`
	SigningKeyID   string     `json:"signing_key_id"`
	Notes          string     `json:"notes,omitempty"`
	// Urgent ist der EIL-Pfad der Stufe 3 (Vorentwurf §3, Befund C1): der
	// „nicht mitten im Schreiben"-Interlock verschiebt einen Tausch, solange
	// ein von neutral abweichender Sollwert ausgefuehrt wird. Auf einer Anlage
	// im Dauer-Arbitragebetrieb hiesse das „nie" - fuer einen Sicherheits-
	// Patch die falsche Antwort.
	//
	// Ein eiliges Release verschiebt deshalb nicht, sondern stellt die Anlage
	// ZUERST bewusst neutral und tauscht in diesem selbst geschaffenen
	// Fenster. Genau weil das eine Anweisung an eine laufende Kundenanlage
	// ist, wohnt sie im SIGNIERTEN Manifest und nicht im unsignierten
	// Umschlag: nur der Owner darf ein Release fuer eilig erklaeren.
	//
	// Absent = false = der gewoehnliche, geduldige Weg (additiv,
	// schema_version bleibt 1.0; ein aelterer Stand ignoriert das Feld und
	// verschiebt weiter - die sichere Richtung).
	Urgent bool `json:"urgent,omitempty"`
}

// Artifact ist EIN Bestandteil des Releases, typisiert.
type Artifact struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Ref  string `json:"ref"`
}

// Compat traegt die Vertraeglichkeits-Bindungen.
type Compat struct {
	Backends         []string `json:"backends"`
	InverterFamilies []string `json:"inverter_families,omitempty"`
}

// SupportsBackend sagt, ob dieses Release fuer das genannte Backend bestimmt ist.
func (m *Manifest) SupportsBackend(backend string) bool {
	for _, b := range m.Compat.Backends {
		if b == backend {
			return true
		}
	}
	return false
}

// IsRunning sagt, ob die uebergebene Build-Stempelung dieses Release IST.
//
// edge-images stempelt bei Tag-Builds `<tag>-<kurzsha>` (edge-images.yaml
// „Compute version stamp"), also zaehlt sowohl die nackte Gleichheit als auch
// das Tag mit angehaengter SHA. Ein Bestandsbau traegt eine nackte SHA und
// gehoert damit zu KEINEM Release - das ist die ehrliche Antwort, nicht ein
// geratenes „ist wohl aktuell".
func (m *Manifest) IsRunning(stamped string) bool {
	return ReleaseIsRunning(m.Release, stamped)
}

// ReleaseIsRunning ist [Manifest.IsRunning] ohne Manifest - fuer die Stellen,
// die nur einen NAMEN gegen die Build-Stempelung halten (der Nachweis, dass ein
// beaufsichtigt angewandtes Release wirklich hier laeuft, bevor es als eigener
// Stand aufgezeichnet wird). Eine zweite Kopie dieser Regel waere genau die
// Sorte Drift, die „ist aktuell" irgendwann verschieden beantwortet.
func ReleaseIsRunning(release, stamped string) bool {
	stamped = strings.TrimSpace(stamped)
	if stamped == "" || release == "" {
		return false
	}
	return stamped == release || strings.HasPrefix(stamped, release+"-")
}

// ParseManifest liest ein Manifest und prueft seine STRUKTUR.
//
// Aufrufer-Pflicht: erst [VerifyBytes]/[Verify], dann parsen. Diese Funktion
// trifft keinerlei Vertrauensentscheidung - sie sagt nur, ob das Dokument die
// Form hat, die der Kontrakt vorschreibt.
func ParseManifest(raw []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("Manifest ist kein gueltiges JSON: %w", err)
	}
	if err := m.validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

func (m *Manifest) validate() error {
	if err := checkMajor(m.SchemaVersion, ManifestSchemaVersion); err != nil {
		return err
	}
	if !releaseRe.MatchString(m.Release) {
		return fmt.Errorf("release '%s' folgt nicht dem Schema edge-JJJJ.MM.N", m.Release)
	}
	if m.ReleaseSeq < 1 {
		return errors.New("release_seq muss >= 1 sein - sie ist die Ordnung der Releases")
	}
	if !commitRe.MatchString(m.TargetCommit) {
		return fmt.Errorf("target_commit '%s' ist kein Commit-Hash", m.TargetCommit)
	}
	if m.MinFromSeq < 0 {
		return errors.New("min_from_seq darf nicht negativ sein")
	}
	if m.MinFromSeq > m.ReleaseSeq {
		// Ein Boden ueber dem eigenen Stand koennte von keinem Geraet je
		// erfuellt werden - das ist ein Tippfehler beim Erzeugen, kein Zustand.
		return fmt.Errorf("min_from_seq (%d) liegt ueber release_seq (%d) - dieses Release waere fuer kein Geraet erreichbar",
			m.MinFromSeq, m.ReleaseSeq)
	}
	if m.StateSchema < 1 {
		return errors.New("state_schema muss >= 1 sein")
	}
	if !keyIDRe.MatchString(m.SigningKeyID) {
		return fmt.Errorf("signing_key_id '%s' ist keine gueltige Schluessel-Kennung", m.SigningKeyID)
	}
	if len(m.Artifacts) == 0 {
		return errors.New("artifacts ist leer - ein Release ohne Artefakt beschreibt nichts")
	}
	seen := map[string]bool{}
	for i, a := range m.Artifacts {
		if a.Type != ArtifactOCIImage {
			return fmt.Errorf("artifacts[%d]: unbekannter Typ '%s'", i, a.Type)
		}
		if !artNameRe.MatchString(a.Name) {
			return fmt.Errorf("artifacts[%d]: ungueltiger Name '%s'", i, a.Name)
		}
		if seen[a.Name] {
			return fmt.Errorf("artifacts: '%s' kommt doppelt vor", a.Name)
		}
		seen[a.Name] = true
		if !digestRefRe.MatchString(a.Ref) {
			// Ein Tag waere kein Pin. Genau hier haengt die Integritaet des
			// Releases: der Digest nagelt die Bytes fest.
			return fmt.Errorf("artifacts[%d] (%s): ref muss voll digest-gepinnt sein (…@sha256:…), ist '%s'",
				i, a.Name, a.Ref)
		}
	}
	if len(m.Compat.Backends) == 0 {
		return errors.New("compat.backends ist leer - ein Release muss sagen, fuer welches Apply-Backend es gilt")
	}
	for _, b := range m.Compat.Backends {
		switch b {
		case BackendCompose, BackendQuadlet, BackendMender:
		default:
			return fmt.Errorf("compat.backends: unbekanntes Backend '%s'", b)
		}
	}
	if m.ValidUntil != "" {
		if _, err := parseTime(m.ValidUntil); err != nil {
			return fmt.Errorf("valid_until '%s' ist kein RFC-3339-Zeitpunkt", m.ValidUntil)
		}
	}
	return nil
}

// checkMajor vergleicht nur die MAJOR-Stelle (siehe [ManifestSchemaVersion]).
func checkMajor(got, want string) error {
	if got == "" {
		return errors.New("schema_version fehlt")
	}
	gm, _, _ := strings.Cut(got, ".")
	wm, _, _ := strings.Cut(want, ".")
	if gm != wm {
		return fmt.Errorf("schema_version '%s' wird von diesem Stand nicht unterstuetzt (erwartet %s.x)", got, wm)
	}
	return nil
}
