package attrappe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"strconv"
	"strings"
	"testing"
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

// Manifest baut ein signiertes Edge-Light-Manifest (release.json) wie der
// Release-Lauf und eine dazu passende Signaturdatei - die Signatur selbst ist
// eine Attrappe: die Werkstatt prueft nur die Zugehoerigkeit, die Box die
// Unterschrift.
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
