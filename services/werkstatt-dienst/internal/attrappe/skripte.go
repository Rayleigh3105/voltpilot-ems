package attrappe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
)

// Attrappen der Skripte install.sh und service-tunnel.sh: dieselbe Aufrufform
// wie die echten (Ziel als erstes Argument, ssh <ziel> <befehl>), aber mit
// Befehlen, die die Mango-Attrappe versteht. Die echten Skripte laufen in der
// Box-Probe gegen ein echtes OpenWrt (test/box-probe.sh).
const installSh = `#!/bin/sh
set -eu
ziel="$1"
bin="$(dirname "$0")/../dist/vp-edge-light-linux-${VP_LIGHT_ARCH:-mipsle}"
[ -f "$bin" ] || { echo "FEHLER: das Programm fehlt" >&2; exit 1; }
# Wie das echte install.sh: ohne Vertrauens-Set (Verzeichnis oder Portal) nichts.
if [ -n "${VP_TRUST_SET_DIR:-}" ]; then
  [ -s "$VP_TRUST_SET_DIR/trust-set.json" ] && [ -s "$VP_TRUST_SET_DIR/trust-set.json.sig" ] || { echo "FEHLER: Vertrauens-Set unvollstaendig" >&2; exit 1; }
  echo "--- Vertrauens-Set in den Flash"
fi
if [ -n "${VP_LIGHT_MANIFEST:-}" ]; then
  grep -q '"release_seq"' "$VP_LIGHT_MANIFEST" || { echo "FEHLER: Manifest unlesbar" >&2; exit 1; }
  echo "--- Stand vermerkt"
fi
ssh -i /dev/null "$ziel" 'vp-attrappe install' < "$bin"
echo "    0.1 MB gepackt, Pruefsumme auf dem Geraet bestaetigt"
`

const tunnelSh = `#!/bin/sh
set -eu
ziel="$1"
was="$2"
case "$was" in
  key) ssh "$ziel" 'vp-attrappe key' ;;
  status) ssh "$ziel" 'vp-attrappe status' ;;
  *)
    [ -n "${VP_SERVICE_PUBKEY:-}" ] || { echo "FEHLER: VP_SERVICE_PUBKEY fehlt" >&2; exit 1; }
    ssh "$ziel" "vp-attrappe tunnel $was"
    ;;
esac
`

// SkripteTarGz baut einen Skriptstand wie der Release-Anhang
// edge-light-openwrt.tar.gz, mit den Attrappen-Skripten.
func SkripteTarGz(t testing.TB) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct {
		name, inhalt string
	}{{"openwrt/install.sh", installSh}, {"openwrt/service-tunnel.sh", tunnelSh}, {"openwrt/files/etc/config/vp-edge-light", "config main 'main'\n"}} {
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.inhalt)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(f.inhalt))
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

// Manifest baut ein Edge-Light-Manifest (release.json) wie der Release-Lauf
// und eine dazu passende Signaturdatei - die Signatur selbst ist eine
// Attrappe (key_id "rel-2026-a", keine echten Bytes): brauchbar fuer
// [fassungen.PruefeManifest] direkt (reine Struktur-/Zugehoerigkeitspruefung),
// NICHT fuer einen Lauf durch den Schritt "fassungen" - der prueft seit N3
// zusaetzlich echt kryptographisch ([fassungen.Ablage.PruefeSignatur]) und
// braucht dafuer [NeueSignierteWurzel].
func Manifest(fassung string, seq int64, programmSha string) (manifest, signatur []byte) {
	manifest = []byte(`{
  "schema_version": "1.0",
  "release": "` + fassung + `",
  "release_seq": ` + strconv.FormatInt(seq, 10) + `,
  "target_commit": "3bf8c038a1b2",
  "artifacts": [
    {
      "type": "binary",
      "name": "vp-edge-light",
      "arch": "linux/mipsle",
      "sha256": "` + programmSha + `",
      "size": 1,
      "gz_sha256": "` + strings.Repeat("4", 64) + `",
      "gz_size": 1
    }
  ],
  "min_from_seq": 0,
  "allow_downgrade": false,
  "state_schema": 1,
  "compat": {
    "backends": [
      "light"
    ]
  },
  "signing_key_id": "rel-2026-a"
}
`)
	signatur = []byte(`{"schema_version":"1.0","alg":"ed25519","key_id":"rel-2026-a","domain":"release","signature":"AAAA"}` + "\n")
	return manifest, signatur
}

// SignierteWurzel ist eine Wegwerf-Vertrauenskette fuer Tests: eigene Root-
// und Release-Schluessel statt der echten (deren privater Schluessel nie im
// Repo steht). Sie signiert wie vp-ota sign - Kontext + Rohbytes, Ed25519 -
// damit [fassungen.Ablage.PruefeSignatur] mit der ueber das Feld Wurzel
// ausgetauschten Wurzel dieselbe echte Pruefung durchlaeuft wie in der
// Produktion.
type SignierteWurzel struct {
	Wurzel       *fassungen.KeySet
	TrustSet     []byte
	TrustSetSig  []byte
	ReleaseKeyID string
	releaseKey   ed25519.PrivateKey
}

// NeueSignierteWurzel erzeugt eine frische Wegwerf-Root- und
// Release-Schluesselkette mit einem root-signierten Vertrauens-Set, das
// genau den Release-Schluessel "rel-2026-a" zulaesst (derselbe key_id wie in
// [Manifest]).
func NeueSignierteWurzel(t testing.TB) SignierteWurzel {
	t.Helper()
	rootPub, rootPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	relPub, relPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const rootKeyID = "root-test-a"
	const relKeyID = "rel-2026-a"

	wurzel := &fassungen.KeySet{SchemaVersion: "1.0", Keys: []fassungen.PublicKey{
		{KeyID: rootKeyID, Alg: "ed25519", PublicKey: base64.StdEncoding.EncodeToString(rootPub)},
	}}
	trustSet, err := json.Marshal(fassungen.KeySet{SchemaVersion: "1.0", Keys: []fassungen.PublicKey{
		{KeyID: relKeyID, Alg: "ed25519", PublicKey: base64.StdEncoding.EncodeToString(relPub)},
	}})
	if err != nil {
		t.Fatal(err)
	}

	return SignierteWurzel{
		Wurzel:       wurzel,
		TrustSet:     trustSet,
		TrustSetSig:  signiere(t, rootPriv, rootKeyID, fassungen.DomainTrustSet, trustSet),
		ReleaseKeyID: relKeyID,
		releaseKey:   relPriv,
	}
}

// SigniereManifest signiert ein Release-Manifest mit dem Release-Schluessel
// dieser Wurzel - wie vp-ota sign.
func (w SignierteWurzel) SigniereManifest(t testing.TB, manifest []byte) []byte {
	t.Helper()
	return signiere(t, w.releaseKey, w.ReleaseKeyID, fassungen.DomainRelease, manifest)
}

func signiere(t testing.TB, priv ed25519.PrivateKey, keyID, domain string, doc []byte) []byte {
	t.Helper()
	input, err := fassungen.SigningInput(domain, doc)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, input)
	out, err := json.Marshal(struct {
		SchemaVersion string `json:"schema_version"`
		Alg           string `json:"alg"`
		KeyID         string `json:"key_id"`
		Domain        string `json:"domain"`
		Signature     string `json:"signature"`
	}{"1.0", "ed25519", keyID, domain, base64.StdEncoding.EncodeToString(sig)})
	if err != nil {
		t.Fatal(err)
	}
	return out
}
