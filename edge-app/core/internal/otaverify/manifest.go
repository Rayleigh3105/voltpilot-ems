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
// Backend nicht in compat.backends steht, wendet nicht an statt zu raten -
// der Punkt des runtime-agnostischen Schnitts (§5). Das Backend ist zugleich
// die BOX-ART: compose ist die Docker-Box, light ist Edge Light.
const (
	BackendCompose = "compose"
	BackendQuadlet = "quadlet"
	BackendMender  = "mender"
	// BackendLight ist Edge Light: ein einzelnes Programm je Architektur statt
	// Container (Plan Edge Light Stufe 2, §2.2). Ein Edge-Light-Release hat ein
	// EIGENES Manifest - nur dieses Backend, nur [ArtifactBinary].
	BackendLight = "light"
)

// Artefakt-Typen. Jeder Typ hat seine eigenen Pflichtfelder und seine eigene
// Pruefung; ein Apply-Backend wendet nur die Typen an, die es versteht
// ([Manifest.NotApplicableReason]).
const (
	// ArtifactOCIImage ist ein digest-gepinntes Container-Image (Docker-Box).
	ArtifactOCIImage = "oci-image"
	// ArtifactBinary ist ein einzelnes Programm fuer EINE Architektur
	// (Edge Light). Es wird gepackt ausgeliefert; sha256/size gelten fuer die
	// rohe Datei, gz_sha256/gz_size fuer die gepackte - damit laesst sich die
	// Lieferung schon VOR dem Entpacken und vor jedem Neustart pruefen.
	ArtifactBinary = "binary"
)

// LightReleasePrefix leitet jeden Release-Namen der Edge-Light-Linie ein
// (Entscheid E7: edge-light-JJJJ.MM.N, eigene Kadenz).
const LightReleasePrefix = "edge-light-"

// appliedTypes sagt, welche Artefakt-Typen ein Apply-Backend ANWENDET. Ein
// Backend, das hier fehlt (quadlet, mender), hat auf diesem Stand keine
// Anwendung - ein Geraet damit wendet also nichts an, statt zu raten.
var appliedTypes = map[string]string{
	BackendCompose: ArtifactOCIImage,
	BackendLight:   ArtifactBinary,
}

var (
	// releaseRe traegt beide Linien: Docker-Box edge-JJJJ.MM.N und Edge Light
	// edge-light-JJJJ.MM.N. Die Docker-Box muss den Namen eines Edge-Light-
	// Release LESEN koennen, sonst lehnte sie es als „Form kaputt" ab, statt
	// es als „nicht fuer mich" zurueckzustellen.
	releaseRe   = regexp.MustCompile(`^edge(-light)?-\d{4}\.\d{2}\.\d+$`)
	commitRe    = regexp.MustCompile(`^[0-9a-f]{7,64}$`)
	keyIDRe     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	artNameRe   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	digestRefRe = regexp.MustCompile(`^[^\s@]+@sha256:[0-9a-f]{64}$`)
	// tokenRe ist die Form eines Typ- oder Backend-Namens - auch eines, den
	// dieser Stand (noch) nicht kennt.
	tokenRe  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	archRe   = regexp.MustCompile(`^[a-z0-9]+/[a-z0-9]+(/[a-z0-9]+)?$`)
	sha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// IsReleaseName sagt, ob ein Name dem Release-Schema folgt (edge-JJJJ.MM.N
// oder edge-light-JJJJ.MM.N). Der Umschlag der Zuweisung prueft mit genau
// dieser Regel - zwei Kopien liefen auseinander.
func IsReleaseName(name string) bool { return releaseRe.MatchString(name) }

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
//
// Welche Felder Pflicht sind, haengt am Typ: oci-image traegt [Artifact.Ref],
// binary traegt Arch, SHA256, Size, GzSHA256 und GzSize. Alle typ-eigenen
// Felder sind omitempty, damit ein oci-image-Manifest byte-gleich bleibt.
type Artifact struct {
	Type string `json:"type"`
	Name string `json:"name"`
	// Ref ist die voll digest-gepinnte OCI-Referenz (nur oci-image).
	Ref string `json:"ref,omitempty"`
	// Arch ist die Zielplattform eines Programms, GOOS/GOARCH wie
	// "linux/mipsle" (nur binary). Je Architektur ein Eintrag.
	Arch string `json:"arch,omitempty"`
	// SHA256/Size beschreiben die ROHE Programmdatei (nur binary).
	SHA256 string `json:"sha256,omitempty"`
	Size   int64  `json:"size,omitempty"`
	// GzSHA256/GzSize beschreiben die GEPACKTE Lieferung (nur binary).
	GzSHA256 string `json:"gz_sha256,omitempty"`
	GzSize   int64  `json:"gz_size,omitempty"`
}

// KnownArtifactType sagt, ob dieser Stand den Artefakt-Typ kennt.
func KnownArtifactType(t string) bool {
	return t == ArtifactOCIImage || t == ArtifactBinary
}

// KnownBackend sagt, ob dieser Stand das Backend kennt.
func KnownBackend(b string) bool {
	switch b {
	case BackendCompose, BackendQuadlet, BackendMender, BackendLight:
		return true
	}
	return false
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

// NotApplicableReason sagt auf Deutsch, warum dieses Release auf einem Geraet
// mit dem genannten Apply-Backend NICHT anwendbar ist - leer, wenn es
// anwendbar ist.
//
// Zwei Gruende, beide nach gueltiger Signatur KEIN Vorfall, sondern „nicht
// fuer mich" (deferred):
//
//   - das Backend steht nicht in compat.backends - das Release ist fuer eine
//     andere Box-Art bestimmt (etwa Edge Light statt Docker-Box);
//   - ein Bestandteil hat einen Typ, den dieses Backend nicht anwendet - ein
//     unbekannter Typ eines neueren Stands oder der Typ einer anderen Box-Art.
//     Angewandt wird dann NICHTS davon: ein halb angewandtes Release waere
//     ein Stand, den nie jemand signiert hat.
func (m *Manifest) NotApplicableReason(backend string) string {
	if !m.SupportsBackend(backend) {
		return fmt.Sprintf("Release %s ist nicht fuer das Apply-Backend '%s' dieses Geraets bestimmt "+
			"(gilt fuer: %s) - es gehoert zu einer anderen Box-Art.",
			m.Release, backend, strings.Join(m.Compat.Backends, ", "))
	}
	want, ok := appliedTypes[backend]
	if !ok {
		return fmt.Sprintf("Fuer das Apply-Backend '%s' kennt dieser Stand keine Anwendung - "+
			"Release %s wird nicht angewandt.", backend, m.Release)
	}
	for _, a := range m.Artifacts {
		if a.Type == want {
			continue
		}
		if !KnownArtifactType(a.Type) {
			return fmt.Sprintf("Release %s traegt den Bestandteil '%s' vom Typ '%s', den dieser Stand "+
				"nicht kennt - es wird nichts davon angewandt.", m.Release, a.Name, a.Type)
		}
		return fmt.Sprintf("Release %s traegt den Bestandteil '%s' vom Typ '%s', den das Apply-Backend "+
			"'%s' nicht anwendet - es wird nichts davon angewandt.", m.Release, a.Name, a.Type, backend)
	}
	return ""
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

// ParseManifest liest ein Manifest und prueft seine STRUKTUR - so, wie ein
// GERAET sie braucht.
//
// Aufrufer-Pflicht: erst [VerifyBytes]/[Verify], dann parsen. Diese Funktion
// trifft keinerlei Vertrauensentscheidung - sie sagt nur, ob das Dokument die
// Form hat, die der Kontrakt vorschreibt.
//
// **Tolerant gegenueber Unbekanntem, streng beim Bekannten.** Ein Artefakt-Typ
// oder ein Backend, das dieser Stand nicht kennt, ist KEIN Formfehler: das
// Manifest traegt unsere Signatur, stammt also von einem neueren Stand oder
// einer anderen Box-Art. Ob es HIER anwendbar ist, entscheidet danach
// [Manifest.NotApplicableReason] (deferred mit Grund). Die Felder eines
// BEKANNTEN Typs werden dagegen voll geprueft - ein oci-image mit Tag statt
// Digest oder ein binary ohne Pruefsumme ist kaputt, gleich auf welcher Box.
//
// Was die Werkzeuge ERZEUGEN duerfen, ist strenger: [ParseManifestStrict].
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
		return fmt.Errorf("release '%s' folgt nicht dem Schema edge-JJJJ.MM.N oder edge-light-JJJJ.MM.N", m.Release)
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
		if !tokenRe.MatchString(a.Type) {
			return fmt.Errorf("artifacts[%d]: Typ '%s' ist kein gueltiger Typ-Name", i, a.Type)
		}
		if !artNameRe.MatchString(a.Name) {
			return fmt.Errorf("artifacts[%d]: ungueltiger Name '%s'", i, a.Name)
		}
		// Die Identitaet eines Bestandteils haengt am Typ: ein Image ist einmal
		// da, ein Programm einmal JE ARCHITEKTUR.
		key := a.Type + "\x00" + a.Name + "\x00" + a.Arch
		if seen[key] {
			if a.Arch != "" {
				return fmt.Errorf("artifacts: '%s' fuer %s kommt doppelt vor", a.Name, a.Arch)
			}
			return fmt.Errorf("artifacts: '%s' kommt doppelt vor", a.Name)
		}
		seen[key] = true
		if err := a.validate(i); err != nil {
			return err
		}
	}
	if len(m.Compat.Backends) == 0 {
		return errors.New("compat.backends ist leer - ein Release muss sagen, fuer welches Apply-Backend es gilt")
	}
	for _, b := range m.Compat.Backends {
		// Ein unbekanntes Backend ist kein Formfehler (siehe ParseManifest),
		// ein leerer oder krummer Eintrag schon.
		if !tokenRe.MatchString(b) {
			return fmt.Errorf("compat.backends: '%s' ist kein gueltiger Backend-Name", b)
		}
	}
	if m.ValidUntil != "" {
		if _, err := parseTime(m.ValidUntil); err != nil {
			return fmt.Errorf("valid_until '%s' ist kein RFC-3339-Zeitpunkt", m.ValidUntil)
		}
	}
	return nil
}

// validate prueft die Felder EINES Bestandteils je Typ. Ein unbekannter Typ
// wird nicht geprueft - dieser Stand kennt seine Felder nicht; ob er hier
// anwendbar ist, sagt [Manifest.NotApplicableReason].
func (a Artifact) validate(i int) error {
	switch a.Type {
	case ArtifactOCIImage:
		if !digestRefRe.MatchString(a.Ref) {
			// Ein Tag waere kein Pin. Genau hier haengt die Integritaet des
			// Releases: der Digest nagelt die Bytes fest.
			return fmt.Errorf("artifacts[%d] (%s): ref muss voll digest-gepinnt sein (…@sha256:…), ist '%s'",
				i, a.Name, a.Ref)
		}
	case ArtifactBinary:
		// Ohne Pruefsumme und Groesse waere ein Programm genau so ungepinnt
		// wie ein Image mit Tag.
		if !archRe.MatchString(a.Arch) {
			return fmt.Errorf("artifacts[%d] (%s): arch muss eine Plattform wie linux/mipsle sein, ist '%s'",
				i, a.Name, a.Arch)
		}
		if !sha256Re.MatchString(a.SHA256) {
			return fmt.Errorf("artifacts[%d] (%s, %s): sha256 muss 64 Hex-Zeichen haben", i, a.Name, a.Arch)
		}
		if a.Size < 1 {
			return fmt.Errorf("artifacts[%d] (%s, %s): size muss >= 1 sein", i, a.Name, a.Arch)
		}
		if !sha256Re.MatchString(a.GzSHA256) {
			return fmt.Errorf("artifacts[%d] (%s, %s): gz_sha256 muss 64 Hex-Zeichen haben", i, a.Name, a.Arch)
		}
		if a.GzSize < 1 {
			return fmt.Errorf("artifacts[%d] (%s, %s): gz_size muss >= 1 sein", i, a.Name, a.Arch)
		}
	}
	return nil
}

// ParseManifestStrict liest ein Manifest so streng, wie die Werkzeuge es
// ERZEUGEN duerfen - die Gegenprobe von `vp-ota manifest`.
//
// Zusaetzlich zu [ParseManifest] gilt:
//
//   - jeder Artefakt-Typ und jedes Backend ist diesem Stand bekannt;
//   - jeder Bestandteil traegt nur die Felder seines Typs;
//   - EIN MANIFEST JE BOX-ART: ein Edge-Light-Release heisst edge-light-…,
//     gilt nur fuer das Backend light und traegt nur binary-Artefakte; ein
//     Release jeder anderen Box-Art traegt weder das eine noch das andere.
//
// Streng senden, tolerant annehmen: ein Geraet liest mit [ParseManifest],
// damit ein neuerer oder fremder Stand dort „nicht fuer mich" heisst und
// nicht „kaputt".
func ParseManifestStrict(raw []byte) (*Manifest, error) {
	m, err := ParseManifest(raw)
	if err != nil {
		return nil, err
	}
	if err := m.checkProduced(); err != nil {
		return nil, err
	}
	return m, nil
}

func (m *Manifest) checkProduced() error {
	light := strings.HasPrefix(m.Release, LightReleasePrefix)
	for _, b := range m.Compat.Backends {
		if !KnownBackend(b) {
			return fmt.Errorf("compat.backends: unbekanntes Backend '%s'", b)
		}
		if (b == BackendLight) != light {
			if light {
				return fmt.Errorf("Edge-Light-Release %s gilt nur fuer das Backend '%s', nicht fuer '%s'",
					m.Release, BackendLight, b)
			}
			return fmt.Errorf("das Backend '%s' gehoert zu Edge Light - das Release muss %sJJJJ.MM.N heissen, nicht '%s'",
				BackendLight, LightReleasePrefix, m.Release)
		}
	}
	for i, a := range m.Artifacts {
		if !KnownArtifactType(a.Type) {
			return fmt.Errorf("artifacts[%d]: unbekannter Typ '%s'", i, a.Type)
		}
		if (a.Type == ArtifactBinary) != light {
			if light {
				return fmt.Errorf("artifacts[%d] (%s): ein Edge-Light-Release traegt nur Artefakte vom Typ '%s'",
					i, a.Name, ArtifactBinary)
			}
			return fmt.Errorf("artifacts[%d] (%s): Artefakte vom Typ '%s' gehoeren in ein Edge-Light-Release (%sJJJJ.MM.N)",
				i, a.Name, ArtifactBinary, LightReleasePrefix)
		}
		switch a.Type {
		case ArtifactOCIImage:
			if a.Arch != "" || a.SHA256 != "" || a.Size != 0 || a.GzSHA256 != "" || a.GzSize != 0 {
				return fmt.Errorf("artifacts[%d] (%s): ein oci-image traegt nur type, name und ref", i, a.Name)
			}
		case ArtifactBinary:
			if a.Ref != "" {
				return fmt.Errorf("artifacts[%d] (%s): ein binary traegt kein ref", i, a.Name)
			}
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
