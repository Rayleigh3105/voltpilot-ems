package otaapply

// Die EINE Stelle, an der Kern UND Sidecar ein Manifest pruefen lassen.
//
// Beide rufen [VerifyManifest] - mit ihren je eigenen Wurzeln, ihrem je
// eigenen Boden und in ihrem je eigenen Prozess. „Unabhaengig verifizieren"
// heisst genau das: zwei Prozesse fragen dieselbe Frage getrennt. Es heisst
// NICHT, die Frage zweimal verschieden zu formulieren - eine zweite Kopie des
// Aufrufs waere die Sorte Drift, bei der ein Geraet irgendwann zwei Meinungen
// ueber dasselbe Release hat.

import (
	"os"
	"path/filepath"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otatarget"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

// Die Dateien der beaufsichtigten Ablage (Stufe 1) und der Widerrufs-Anker.
const (
	FileTrustSet = "trust-set.json"
	FileRelease  = "release.json"
	SigSuffix    = ".sig"
)

// Current ist der lokal aufgezeichnete eigene Release-Stand - der
// uhrunabhaengige Anti-Rollback-Boden.
type Current struct {
	Release    string `json:"release"`
	ReleaseSeq int64  `json:"release_seq"`
	// StateSchema ist die /data-Zustandsversion des zuletzt AUTONOM
	// angewandten Releases - der Eingang des state_schema-Gates beim naechsten
	// Update. 0 = nicht bekannt (jeder beaufsichtigt angewandte Stand), und
	// [Decide] behandelt 0 ausdruecklich als „nicht bewertbar" statt als
	// „Version 0" - eine erfundene Version waere hier genauso teuer wie eine
	// erfundene Sequenznummer.
	StateSchema int `json:"state_schema,omitempty"`
}

// ReadCurrent liest den Boden. Ein unlesbarer oder unsinniger Eintrag wird
// VERWORFEN, nicht geraten: „unbekannt" ist eine ehrliche Antwort, eine
// erfundene Sequenznummer waere eine, die den Boden aushebelt.
func ReadCurrent(dataDir string) *Current {
	c, err := ReadJSON[Current](dataDir, FileCurrent)
	if err != nil || c == nil || c.ReleaseSeq < 1 {
		return nil
	}
	return c
}

// CurrentSeq liefert den Boden als Zeiger fuer [otaverify.Input].
func CurrentSeq(dataDir string) *int64 {
	c := ReadCurrent(dataDir)
	if c == nil {
		return nil
	}
	seq := c.ReleaseSeq
	return &seq
}

// VerifyManifest prueft EIN Manifest gegen die uebergebene Wurzel.
//
// Das Trust-Set kommt IMMER von der Platte und NIE aus dem Downlink: es ist
// der Widerrufs-Anker, und ihn ueber denselben Kanal zu verteilen waere eine
// Kreisabhaengigkeit. Fehlt es, lehnt der Verifizierer fail-closed ab und
// nennt das als Grund.
func VerifyManifest(dataDir string, roots *otaverify.KeySet, manifest, sig []byte,
	runningVersion string, currentSeq *int64, now time.Time) otaverify.Verdict {
	dir := Dir(dataDir)
	return otaverify.Verify(otaverify.Input{
		Roots:          roots,
		TrustSet:       readOrNil(dir, FileTrustSet),
		TrustSetSig:    readOrNil(dir, FileTrustSet+SigSuffix),
		Manifest:       manifest,
		ManifestSig:    sig,
		Backend:        BackendCompose,
		RunningVersion: runningVersion,
		CurrentSeq:     currentSeq,
		// Die Geraetezeit wird BEWUSST uebergeben, obwohl sie nicht
		// vertrauenswuerdig ist: sie wirkt nur beim Schluessel-Ablauf, wo ein
		// Irrtum ins Ablehnen faellt (die sichere Richtung), und bei
		// valid_until, das ohnehin nur berichtet wird.
		Now: now,
	})
}

// LoadTarget liest die abgelegte Cloud-Zuweisung.
//
// [ErrAbsent] = es gibt keine - im Protokoll ein NORMALER Zustand.
func LoadTarget(dataDir string) (*otatarget.Envelope, error) {
	raw, err := otatarget.NewStore(dataDir).Load()
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrAbsent
		}
		return nil, err
	}
	return otatarget.ParseEnvelope(raw)
}

// UpdaterComponent ist der Name, unter dem der Sidecar SELBST in einem Release
// stehen wuerde.
//
// Er wird von [TargetRefs] ausgelassen - die Sperre gegen die
// Selbstaktualisierung (Vorentwurf §3 „who updates the updater"). Ein Prozess,
// der sich mitten in einer Orchestrierung selbst ersetzt, verliert genau den
// Zustand, mit dem er den Vorgang zu Ende fahren muesste. Der Sidecar wird
// deshalb selten und BEAUFSICHTIGT ueber den bestehenden Weg aktualisiert
// (`update.sh` bzw. ein `docker compose up -d updater` von Hand). Das ist
// ausgesprochen, nicht versteckt - und hier eine Sperre, nicht nur ein Satz.
const UpdaterComponent = "updater"

// TargetRefs zieht die digest-gepinnten Referenzen je Komponente aus einem
// GEPRUEFTEN Manifest - ohne den Sidecar selbst (siehe [UpdaterComponent]).
func TargetRefs(m *otaverify.Manifest) map[string]string {
	out := map[string]string{}
	if m == nil {
		return out
	}
	for _, a := range m.Artifacts {
		if a.Name == UpdaterComponent {
			continue
		}
		out[a.Name] = a.Ref
	}
	return out
}

// ReleaseNamesUpdater sagt, ob ein Release den Sidecar selbst nennt - damit
// die Auslassung LAUT ist und nicht stillschweigend.
func ReleaseNamesUpdater(m *otaverify.Manifest) bool {
	if m == nil {
		return false
	}
	for _, a := range m.Artifacts {
		if a.Name == UpdaterComponent {
			return true
		}
	}
	return false
}

func readOrNil(dir, name string) []byte {
	raw, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return nil
	}
	return raw
}
