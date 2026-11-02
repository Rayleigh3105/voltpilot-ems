package attrappe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
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
[ -f "$bin" ] || { echo "FEHLER: ohne base_url braucht es die lokale Kopie" >&2; exit 1; }
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
