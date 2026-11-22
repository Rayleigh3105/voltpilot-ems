package attrappe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/fassungen"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/passwort"
)

// Die Werkzeuge der WAGO-Firmware als Attrappe (/etc/config-tools): Skripte,
// die sich verhalten, wie Hilfetexte und Skripte des Geräts es zeigen
// (750-8212, Firmware 03.10.08(22), nur gelesen). Sie halten ihren Zustand in
// Dateien im Sandkasten der Attrappe.
//
//go:embed pfc200/config-tools/*
var pfcWerkzeuge embed.FS

// PFCWerkzeuge gibt die Attrappen-Werkzeuge als Name → Inhalt.
func PFCWerkzeuge() map[string][]byte {
	out := map[string][]byte{}
	es, _ := pfcWerkzeuge.ReadDir("pfc200/config-tools")
	for _, e := range es {
		b, _ := pfcWerkzeuge.ReadFile("pfc200/config-tools/" + e.Name())
		out[e.Name()] = b
	}
	return out
}

// PFC200 spielt einen WAGO PFC200 750-8212 am Werkstatt-Anschluss nach: ab
// Werk, nach dem Handgriff „feste Adresse“ unter 192.168.1.17. Jeden Befehl
// des Dienstes führt ein echtes sh aus, in einem Sandkasten: Pfade unter
// /etc, /root, /home, /proc und /tmp/vp- liegen dort, die Werkzeuge der
// Firmware und ein paar Programme (date, curl, ip, pidof, reboot, …) sind
// Attrappen. So prüfen die Tests die Befehle so, wie eine Shell sie liest.
//
// Was die Attrappe vom Gerät nachspielt, weil es einen Lauf zu Fall bringen kann:
//
//   - Die Uhr steht ab Werk Jahre zurück; mit ihr scheitert jede TLS-Verbindung.
//   - Ändert config_ssh etwas, startet der SSH-Dienst neu, und JEDE Sitzung
//     endet; ein Befehl, der an der Sitzung hängt, endet mit ihr.
//   - Die feste Adresse 192.168.1.17 gilt nur bis zum Neustart. Danach
//     antwortet das Gerät nur noch unter einer Adresse, die ihm jemand
//     dauerhaft gegeben hat, an der Buchse mit dem Kabel.
//   - Mit eingeschalteter Firewall nimmt das Gerät nur an, was an der Buchse
//     mit dem Kabel offen ist; bestehende Verbindungen bleiben.
//   - Der SSH-Dienst nimmt nur RSA und ECDSA; nach dem Trennen der Buchsen
//     hat die Brücke von X2 eine andere MAC.
//
// Hinter der Brücken-Attrappe: Bruecke.AntwortenFunc = p.Antworten,
// Bruecke.ZielFunc = p.Ziel.
type PFC200 struct {
	Ref, Version, WgPub string
	Backend             string // Update-Linie in /health
	BestaetigterStand   int64
	OhneVertrauensSet   bool
	Neustartdauer       time.Duration
	// Anmelden antwortet auf werkstatt-anmelden: Code von der Standardeingabe,
	// Tunnel- und Host-Schlüssel aus den Argumenten.
	Anmelden func(code, wireguard, host string) (aus string, rc int)

	t       testing.TB
	w, z    string // Sandkasten und Zustand der Werkzeuge
	mu      sync.Mutex
	offline bool
	host    ssh.Signer
	sshLn   net.Listener
	webLn   net.Listener
	// conns: je SSH-Verbindung die Prozessgruppen ihrer laufenden Befehle.
	conns   map[*ssh.ServerConn][]int
	befehle []string
	ende    chan struct{}
}

// MACs des Geräts: unter der festen Adresse (Brücke br0) und im Anlagennetz (br1).
const (
	PFCMacWerk = "00:30:de:43:b8:7b"
	PFCMacX2   = "00:30:de:43:b8:7c"
)

// pfcProgramme sind die Programme des Geräts, die die Attrappe ersetzt.
var pfcProgramme = map[string]string{
	"date": `#!/bin/sh
# Die Uhr des Geraets: die des Rechners plus Versatz.
v=$(cat "$VP_PFC_WURZEL/var/lib/pfc-attrappe/uhr/versatz" 2>/dev/null || echo 0)
if [ "$*" = "-u +%s" ]; then echo $(( $(/bin/date -u +%s) + v )); else exec /bin/date "$@"; fi
`,
	"pidof": `#!/bin/sh
[ "$1" = dockerd ] && [ -e "$VP_PFC_WURZEL/var/lib/pfc-attrappe/docker/laeuft" ]
`,
	"dropbear": `#!/bin/sh
echo "Dropbear v2022.82" >&2
`,
	"chown": `#!/bin/sh
exit 0
`,
	"reboot": `#!/bin/sh
touch "$VP_PFC_WURZEL/var/lib/pfc-attrappe/neustart"
`,
	"netstat": `#!/bin/sh
echo "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN"
[ -e "$VP_PFC_WURZEL/var/lib/pfc-attrappe/edge.laeuft" ] && echo "tcp        0      0 :::8484                 :::*                    LISTEN"
exit 0
`,
	"ip": `#!/bin/sh
# ip -4 route show default
Z="$VP_PFC_WURZEL/var/lib/pfc-attrappe"
[ "$(cat "$Z/gw/1.state" 2>/dev/null)" = enabled ] && echo "default via $(cat "$Z/gw/1.value") dev br"
exit 0
`,
	"curl": `#!/bin/sh
# Der Weg ins Internet: nur mit Standardweg ueber die Bruecke, einem
# DNS-Server und einer Uhr, mit der das Zertifikat gilt.
Z="$VP_PFC_WURZEL/var/lib/pfc-attrappe"
[ "$(cat "$Z/internet" 2>/dev/null)" = nein ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
[ "$(cat "$Z/gw/1.state" 2>/dev/null)" = enabled ] || { echo "curl: (7) Couldn't connect to server" >&2; exit 7; }
grep -q . "$Z/dns" 2>/dev/null || { echo "curl: (6) Could not resolve host" >&2; exit 6; }
v=$(cat "$Z/uhr/versatz" 2>/dev/null || echo 0)
if [ "$v" -lt -3600 ] || [ "$v" -gt 3600 ]; then echo "curl: (60) SSL certificate problem: certificate is not yet valid" >&2; exit 60; fi
exit 0
`,
	"wget": `#!/bin/sh
# wget -q -O - http://127.0.0.1:8484/health
Z="$VP_PFC_WURZEL/var/lib/pfc-attrappe"
case "$*" in *127.0.0.1:8484/health*) [ -e "$Z/edge.laeuft" ] && cat "$Z/health.json" ;; *) exit 1 ;; esac
`,
	"su": `#!/bin/sh
# su -s /bin/sh <benutzer> -c <befehl>
[ "$1" = -s ] && [ "$4" = -c ] || exit 2
exec sh -c "$5"
`,
	// vp-attrappe: was die Attrappen-Skripte install.sh und wartung.sh auf
	// dem Geraet tun (die echten laufen in den Proben im Container).
	"vp-attrappe": `#!/bin/sh
W="$VP_PFC_WURZEL"
Z="$W/var/lib/pfc-attrappe"
dienst() { # dienst <name> <marke>
  mkdir -p "$W/etc/init.d" "$W/etc/rc.d"
  printf '#!/bin/sh\ncase "$1" in\n  start|restart) touch "%s" ;;\n  stop) rm -f "%s" ;;\n  status) [ -e "%s" ] ;;\nesac\n' "$Z/$2" "$Z/$2" "$Z/$2" >"$W/etc/init.d/$1"
  chmod 0755 "$W/etc/init.d/$1"
  ln -sf "../init.d/$1" "$W/etc/rc.d/S99_$1"
}
case "$1" in
  install)
    cat >"$Z/programm"
    mkdir -p "$W/home/voltpilot/daten" "$W/tmp/vp-edge-industrie"
    cat "$Z/ref" >"$W/home/voltpilot/daten/ref"
    printf '#!/bin/sh\n# werkstatt-anmelden: Anfrage ablegen, auf die Antwort der Attrappe warten\n[ "$1" = werkstatt-anmelden ] || exit 2\nZ="%s"\ncat >"$Z/anmelden.code"\necho "$*" >"$Z/anmelden.args"\ni=0\nwhile [ ! -e "$Z/anmelden.rc" ] && [ "$i" -lt 2400 ]; do sleep 0.05; i=$((i + 1)); done\ncat "$Z/anmelden.aus" 2>/dev/null\nrc=$(cat "$Z/anmelden.rc" 2>/dev/null || echo 9)\nrm -f "$Z/anmelden.rc" "$Z/anmelden.aus"\n[ "$rc" = 0 ] || echo "abgewiesen" >&2\nexit "$rc"\n' "$Z" >"$W/tmp/vp-edge-industrie/vp-edge-industrie"
    chmod 0755 "$W/tmp/vp-edge-industrie/vp-edge-industrie"
    dienst vp-edge-industrie edge.laeuft
    rm -f "$Z/edge.laeuft"
    ;;
  key)
    cat >"$Z/wartung-programm"
    mkdir -p "$W/home/voltpilot/wartung"
    printf '#!/bin/sh\nW="%s"\nZ="$W/var/lib/pfc-attrappe"\ncase "$1" in\n  schluessel) echo "oeffentlicher Schluessel des Geraets:"; cat "$Z/wgpub" ;;\n  ereignisse) cat "$Z/ereignisse" 2>/dev/null ;;\n  status)\n    if [ -e "$Z/tunnel.laeuft" ]; then echo laeuft=ja; else echo laeuft=nein; echo grund=steht; fi\n    echo "adresse=$(cat "$Z/tunnel.adresse" 2>/dev/null)"\n    echo "handshake_vor=$(cat "$Z/tunnel.handshake" 2>/dev/null || echo 4)"\n    echo ssh_2222=nur_im_tunnel\n    echo "antwort_vor=$(cat "$Z/tunnel.antwort" 2>/dev/null || echo 2)"\n    echo "dauerhaft=$(grep -c . "$W/root/.ssh/authorized_keys" 2>/dev/null)"\n    echo dauerhaft_mit_optionen=0\n    echo host_schluessel=ssh-rsa\n    ;;\nesac\n' "$W" >"$W/home/voltpilot/wartung/vp-wartung"
    chmod 0755 "$W/home/voltpilot/wartung/vp-wartung"
    "$W/home/voltpilot/wartung/vp-wartung" schluessel
    echo "Box-Referenz: $(cat "$W/home/voltpilot/daten/ref")"
    ;;
  tunnel)
    echo "$2" >"$Z/tunnel.adresse"
    dienst vp-wartung tunnel.laeuft
    touch "$Z/tunnel.laeuft"
    echo "eingerichtet: Tunnel $2, SSH 2222 und Web-App 8484 (netz) nur im Tunnel, Start beim Hochfahren /etc/rc.d/S99_vp-wartung"
    echo "  Wartungsserver:     antwortet - die Schluesselausgabe ist an"
    ;;
  *) exit 2 ;;
esac
`,
}

const pfcInstallSh = `#!/bin/sh
set -eu
ziel="$1"
bin="$(dirname "$0")/dist/vp-edge-industrie-linux-${VP_INDUSTRIE_ARCH:-arm}"
[ -f "$bin" ] || { echo "FEHLER: das Programm fehlt" >&2; exit 1; }
[ -s "${VP_TRUST_SET_DIR:?}/trust-set.json" ] && [ -s "$VP_TRUST_SET_DIR/trust-set.json.sig" ] || { echo "FEHLER: Vertrauens-Set unvollstaendig" >&2; exit 1; }
echo "--- Vertrauens-Set in den Flash"
if [ -n "${VP_INDUSTRIE_MANIFEST:-}" ]; then
  grep -q '"release_seq"' "$VP_INDUSTRIE_MANIFEST" || { echo "FEHLER: Manifest unlesbar" >&2; exit 1; }
  echo "--- Stand vermerkt"
fi
ssh -i /dev/null "$ziel" 'vp-attrappe install' < "$bin"
echo "    0.1 MB gepackt, Pruefsumme auf dem Geraet bestaetigt"
`

const pfcWartungSh = `#!/bin/sh
set -eu
ziel="$1"
was="$2"
bin="$(dirname "$0")/dist/vp-wartung-linux-${VP_INDUSTRIE_ARCH:-arm}"
[ -f "$bin" ] || { echo "FEHLER: das Programm fehlt" >&2; exit 1; }
case "$was" in
  key) ssh "$ziel" 'vp-attrappe key' < "$bin" ;;
  *)
    [ -n "${VP_SERVICE_PUBKEY:-}" ] || { echo "FEHLER: VP_SERVICE_PUBKEY fehlt" >&2; exit 1; }
    ssh "$ziel" "vp-attrappe tunnel $was"
    ;;
esac
`

// SkripteTarGzPFC200 baut einen Skriptstand wie der Release-Anhang
// edge-industrie-skripte.tar.gz, mit Attrappen-Skripten.
func SkripteTarGzPFC200(t testing.TB) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, d := range []struct{ name, inhalt string }{
		{"edge-industrie/install.sh", pfcInstallSh}, {"edge-industrie/wartung.sh", pfcWartungSh},
		{"edge-industrie/files/etc/init.d/vp-wartung", "#!/bin/sh\n"},
	} {
		if err := tw.WriteHeader(&tar.Header{Name: d.name, Mode: 0o755, Size: int64(len(d.inhalt)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(d.inhalt))
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

// ManifestPFC200 ist ein Manifest wie [Manifest], für linux/arm und die
// genannte Update-Linie, mit Skriptstand und Tunnel-Programm (leere
// Prüfsumme: das Feld fehlt, wie bei einer Fassung vor diesen Feldern).
func ManifestPFC200(fassung string, seq int64, programmSha, backend, skripteSha, wartungSha string) []byte {
	m, _ := Manifest(fassung, seq, programmSha)
	s := strings.Replace(string(m), `"linux/mipsle"`, `"linux/arm"`, 1)
	s = strings.Replace(s, `"light"`, `"`+backend+`"`, 1)
	zusatz := ""
	if skripteSha != "" {
		zusatz += `,
  "skripte": {"name": "` + fassungen.IndustrieSkripteDatei + `", "sha256": "` + skripteSha + `", "size": 1}`
	}
	if wartungSha != "" {
		zusatz += `,
  "wartung": {"name": "` + fassungen.WartungProgramm + `", "sha256": "` + wartungSha + `", "size": 1}`
	}
	s = strings.Replace(s, `"signing_key_id": "rel-2026-a"`, `"signing_key_id": "rel-2026-a"`+zusatz, 1)
	return []byte(s)
}

// NeuerPFC200 startet die Attrappe ab Werk unter der festen Adresse, mit dem
// Kabel in X2 und dem Betriebsartenschalter auf RUN.
func NeuerPFC200(t testing.TB) *PFC200 {
	t.Helper()
	w, err := os.MkdirTemp("/tmp", "vpp-") // kurz, und ohne Leerzeichen im Pfad
	if err != nil {
		t.Fatal(err)
	}
	p := &PFC200{Ref: "edge-k7m2xq3", Version: "edge-industrie-2026.11.1", WgPub: "c2Vydm9wdWJ2b3JiaWxkZXJ3aXJlZ3VhcmRrZXk0NDE=",
		Backend: "industrie", BestaetigterStand: 77, Neustartdauer: 150 * time.Millisecond,
		t: t, w: w, z: filepath.Join(w, "var/lib/pfc-attrappe"), conns: map[*ssh.ServerConn][]int{}, ende: make(chan struct{})}
	for name, inhalt := range PFCWerkzeuge() {
		p.schreibe(filepath.Join(w, "etc/config-tools", name), string(inhalt), 0o755)
	}
	for name, inhalt := range pfcProgramme {
		p.schreibe(filepath.Join(w, "bin", name), inhalt, 0o755)
	}
	p.schreibe(filepath.Join(w, "etc/REVISIONS"), "FIRMWARE=03.10.08(22)\n", 0o644)
	p.schreibe(filepath.Join(w, "proc/sys/net/ipv4/ip_forward"), "0\n", 0o644)
	// Ab Werk liegt kein Schlüssel auf dem Gerät; ein Test legt einen fremden dazu.
	p.schreibe(filepath.Join(w, "root/.ssh/authorized_keys"), "", 0o600)
	_ = os.MkdirAll(filepath.Join(w, "tmp"), 0o755)
	for u, pw := range map[string]string{"root": "wago", "admin": "wago", "user": "user"} {
		h, err := passwort.Sha512Crypt(pw, "werksalz")
		if err != nil {
			t.Fatal(err)
		}
		p.Setze("benutzer/"+u+".hash", h)
		p.Setze("benutzer/"+u+".werk", h)
	}
	p.Setze("netz/fest", "1")
	p.Setze("netz/kabel", "X2")
	p.Setze("schalter", "run")
	p.Setze("uhr/versatz", strconv.Itoa(-4*365*86400)) // die Uhr steht im Jahr 2022
	p.host = rsaSchluessel(t)
	if p.sshLn, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	if p.webLn, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		close(p.ende)
		_ = p.sshLn.Close()
		_ = p.webLn.Close()
		p.trenne()
		_ = os.RemoveAll(w)
	})
	go p.annehmen()
	go func() {
		_ = http.Serve(p.webLn, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("VoltPilot")) }))
	}()
	go p.waechter()
	return p
}

func (p *PFC200) schreibe(pfad, inhalt string, modus os.FileMode) {
	if err := os.MkdirAll(filepath.Dir(pfad), 0o755); err != nil {
		p.t.Fatal(err)
	}
	if err := os.WriteFile(pfad, []byte(inhalt), modus); err != nil {
		p.t.Fatal(err)
	}
}

// Setze schreibt eine Angabe in den Zustand der Werkzeuge (etwa "schalter",
// "netz/kabel", "docker/aktiv").
func (p *PFC200) Setze(name, wert string) { p.schreibe(filepath.Join(p.z, name), wert+"\n", 0o644) }

// Lies liest eine Angabe aus dem Zustand; "" wenn sie fehlt.
func (p *PFC200) Lies(name string) string {
	b, _ := os.ReadFile(filepath.Join(p.z, name))
	return strings.TrimSpace(string(b))
}

// Datei gibt eine Datei des Geräts zurück (Pfad wie auf dem Gerät).
func (p *PFC200) Datei(pfad string) string {
	b, _ := os.ReadFile(filepath.Join(p.w, pfad))
	return string(b)
}

// SchreibeDatei legt eine Datei auf das Gerät (Pfad wie auf dem Gerät).
func (p *PFC200) SchreibeDatei(pfad, inhalt string) {
	p.schreibe(filepath.Join(p.w, pfad), inhalt, 0o644)
}

// Aufrufe gibt die ändernden Aufrufe der Werkzeuge zurück, in ihrer Reihenfolge.
func (p *PFC200) Aufrufe() []string {
	return strings.Split(strings.TrimSpace(p.Lies("aufrufe")), "\n")
}

// Befehle gibt die Befehle zurück, die das Gerät über SSH bekommen hat.
func (p *PFC200) Befehle() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.befehle...)
}

// Protokolliere schreibt eine Zeile in die Ereignisliste des Tunnel-Programms.
func (p *PFC200) Protokolliere(z string) {
	f, err := os.OpenFile(filepath.Join(p.z, "ereignisse"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		_, _ = f.WriteString(z + "\n")
		_ = f.Close()
	}
}

func (p *PFC200) Abziehen()   { p.mu.Lock(); p.offline = true; p.mu.Unlock(); p.trenne() }
func (p *PFC200) Einstecken() { p.mu.Lock(); p.offline = false; p.mu.Unlock() }

// Host ist der Fingerabdruck des Host-Schlüssels.
func (p *PFC200) Host() string { return ssh.FingerprintSHA256(p.host.PublicKey()) }

// NimmtAn sagt, ob das Gerät das Passwort für den Benutzer annähme (ohne die
// Einstellung „Anmeldung mit Passwort“).
func (p *PFC200) NimmtAn(benutzer, pw string) bool {
	h := p.Lies("benutzer/" + benutzer + ".hash")
	t := strings.Split(h, "$")
	if len(t) != 4 {
		return false
	}
	ist, err := passwort.Sha512Crypt(pw, t[2])
	return err == nil && ist == h
}

// bruecke ist die Brücke, in der die Buchse mit dem Kabel steckt.
func (p *PFC200) bruecke() string {
	kabel := p.Lies("netz/kabel")
	b := p.Lies("netz/bruecken")
	if b == "" {
		return "br0"
	}
	var m map[string][]string
	if json.Unmarshal([]byte(b), &m) != nil {
		return ""
	}
	for name, ports := range m {
		for _, x := range ports {
			if x == kabel {
				return name
			}
		}
	}
	return ""
}

// adresse ist die Adresse, unter der das Gerät am Kabel antwortet ("" keine).
func (p *PFC200) adresse() (string, string) {
	b := p.bruecke()
	mac := PFCMacWerk
	if b == "br1" {
		mac = PFCMacX2
	}
	if b == "br0" && p.Lies("netz/fest") != "" {
		return "192.168.1.17", mac
	}
	if f := strings.Fields(p.Lies("netz/ip." + b)); len(f) == 3 && f[0] == "static" {
		return f[1], mac
	}
	return "", mac
}

// Antworten wie vp-werkbank-status sie meldet.
func (p *PFC200) Antworten() []map[string]any {
	p.mu.Lock()
	off := p.offline
	p.mu.Unlock()
	a, mac := p.adresse()
	if off || a == "" {
		return []map[string]any{}
	}
	return []map[string]any{{"adresse": a, "macs": []string{mac}}}
}

// offen sagt, ob die Firewall eine neue Verbindung zum Port annimmt.
func (p *PFC200) offen(port int) bool {
	if p.Lies("fw/an") != "enabled" {
		return true
	}
	b := p.bruecke()
	if port == 22 {
		s := p.Lies("fw/dienst/ssh/" + b)
		return s == "on" || s == "" // ab Werk an
	}
	for _, z := range strings.Split(p.Lies("fw/filter"), "\n") {
		if f := strings.Fields(z); len(f) == 10 && f[0] == "on" && f[1] == b && f[8] == strconv.Itoa(port) && f[9] == "accept" {
			return true
		}
	}
	return false
}

// Ziel ordnet eine Werkstatt-Adresse dem Lauscher zu, solange das Gerät dort steht.
func (p *PFC200) Ziel(ziel string) (string, bool) {
	p.mu.Lock()
	off := p.offline
	p.mu.Unlock()
	a, _ := p.adresse()
	if off || a == "" {
		return "", false
	}
	switch ziel {
	case a + ":22":
		if p.Lies("ssh/gestoppt") != "" {
			return "127.0.0.1:1", true // kein SSH-Dienst: Connection refused
		}
		if !p.offen(22) {
			return "", false
		}
		return p.sshLn.Addr().String(), true
	case a + ":8484":
		if !exists(filepath.Join(p.z, "edge.laeuft")) {
			return "127.0.0.1:1", true
		}
		if !p.offen(8484) {
			return "", false
		}
		return p.webLn.Addr().String(), true
	}
	return "", false // etwa Modbus 502: von außen zu
}

func exists(pfad string) bool { _, err := os.Stat(pfad); return err == nil }

func (p *PFC200) annehmen() {
	for {
		c, err := p.sshLn.Accept()
		if err != nil {
			return
		}
		cfg := &ssh.ServerConfig{
			PasswordCallback: func(cm ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
				if p.Lies("ssh/password-request-state") != "disabled" && p.NimmtAn(cm.User(), string(pw)) {
					return nil, nil
				}
				return nil, fmt.Errorf("abgewiesen")
			},
			PublicKeyCallback: func(cm ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
				// Wie der Dropbear des Geräts: nur RSA und ECDSA.
				if cm.User() != "root" || key.Type() == ssh.KeyAlgoED25519 {
					return nil, fmt.Errorf("abgewiesen")
				}
				for _, z := range strings.Split(p.Datei("/root/.ssh/authorized_keys"), "\n") {
					if k, _, _, _, err := ssh.ParseAuthorizedKey([]byte(z)); err == nil && bytes.Equal(k.Marshal(), key.Marshal()) {
						return nil, nil
					}
				}
				return nil, fmt.Errorf("abgewiesen")
			},
		}
		cfg.AddHostKey(p.host)
		go p.verbindung(c, cfg)
	}
}

func (p *PFC200) verbindung(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		_ = c.Close()
		return
	}
	p.mu.Lock()
	p.conns[sc] = nil
	p.mu.Unlock()
	defer func() {
		// Die Sitzung endet: Was an ihr hängt, bekommt SIGHUP. Was sich mit
		// nohup gelöst hat, läuft weiter.
		p.mu.Lock()
		gruppen := p.conns[sc]
		delete(p.conns, sc)
		p.mu.Unlock()
		for _, pgid := range gruppen {
			_ = syscall.Kill(-pgid, syscall.SIGHUP)
		}
		_ = sc.Close()
	}()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "nein")
			continue
		}
		ch, rs, err := nc.Accept()
		if err != nil {
			continue
		}
		go func() {
			defer ch.Close()
			for r := range rs {
				if r.Type != "exec" {
					_ = r.Reply(false, nil)
					continue
				}
				var a struct{ Befehl string }
				_ = ssh.Unmarshal(r.Payload, &a)
				_ = r.Reply(true, nil)
				code := p.exec(sc, ch, a.Befehl)
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
				return
			}
		}()
	}
}

// pfcPfadMuster: absolute Pfade des Geräts, die in den Sandkasten gehören.
var pfcPfadMuster = regexp.MustCompile(`(^|[\s"'=(<>;|&])/(etc|root|home|proc|tmp/vp-)`)

// exec führt einen Befehl mit einem echten sh im Sandkasten aus.
func (p *PFC200) exec(sc *ssh.ServerConn, ch ssh.Channel, befehl string) int {
	p.mu.Lock()
	p.befehle = append(p.befehle, befehl)
	p.mu.Unlock()
	p.schreibe(filepath.Join(p.z, "ref"), p.Ref+"\n", 0o644)
	p.schreibe(filepath.Join(p.z, "wgpub"), p.WgPub+"\n", 0o644)
	p.schreibe(filepath.Join(p.z, "health.json"), p.health(), 0o644)
	cmd := exec.Command("/bin/sh", "-c", pfcPfadMuster.ReplaceAllString(befehl, "${1}"+p.w+"/${2}"))
	cmd.Env = []string{"PATH=" + p.w + "/bin:/usr/bin:/bin:/usr/sbin:/sbin", "VP_PFC_WURZEL=" + p.w, "HOME=" + p.w + "/root"}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = ch, ch, ch.Stderr()
	cmd.WaitDelay = 2 * time.Second
	// Start und Eintrag unter der Sperre: Endet die Verbindung in diesem
	// Augenblick, ist der Befehl entweder noch nicht gestartet (dann startet
	// er nicht mehr) oder seine Prozessgruppe steht schon in der Liste.
	p.mu.Lock()
	if _, ok := p.conns[sc]; !ok {
		p.mu.Unlock()
		return 255
	}
	if err := cmd.Start(); err != nil {
		p.mu.Unlock()
		return 127
	}
	pgid := cmd.Process.Pid
	p.conns[sc] = append(p.conns[sc], pgid)
	p.mu.Unlock()
	err := cmd.Wait()
	// Der Befehl ist zu Ende: Seine Gruppe gehört nicht mehr zur Verbindung
	// (was sich mit nohup gelöst hat, soll ihr Ende ohnehin überleben).
	p.mu.Lock()
	if liste, ok := p.conns[sc]; ok {
		for i, g := range liste {
			if g == pgid {
				p.conns[sc] = append(liste[:i:i], liste[i+1:]...)
				break
			}
		}
	}
	p.mu.Unlock()
	if ee, ok := err.(*exec.ExitError); ok {
		if ee.ExitCode() < 0 {
			return 255
		}
		return ee.ExitCode()
	}
	if err != nil && cmd.ProcessState == nil {
		return 255
	}
	// Auch wenn das Warten auf die Ausgabe an WaitDelay endete: Es gilt der
	// Ausgang des Befehls.
	if cmd.ProcessState != nil && cmd.ProcessState.ExitCode() > 0 {
		return cmd.ProcessState.ExitCode()
	}
	return 0
}

func (p *PFC200) health() string {
	trust := `"trust":{"trust_set_key_ids":["rel-2026-a"],"trust_set_signed_by":"root-2026-a"}`
	if p.OhneVertrauensSet {
		trust = `"trust":{"trust_set_error":"kein Vertrauens-Set"}`
	}
	seq := "null"
	if p.BestaetigterStand > 0 {
		seq = strconv.FormatInt(p.BestaetigterStand, 10)
	}
	return `{"status":"ok","ref":"` + p.Ref + `","version":"` + p.Version + `","ota_update":{"backend":"` + p.Backend + `","current_seq":` + seq + `,` + trust + `}}` + "\n"
}

// trenne beendet alle SSH-Verbindungen.
func (p *PFC200) trenne() {
	p.mu.Lock()
	var alle []*ssh.ServerConn
	for c := range p.conns {
		alle = append(alle, c)
	}
	p.mu.Unlock()
	for _, c := range alle {
		_ = c.Close()
	}
}

// waechter spielt nach, was auf dem Gerät von selbst geschieht: der Neustart
// des SSH-Dienstes, der Neustart des Geräts, die Antwort auf werkstatt-anmelden.
func (p *PFC200) waechter() {
	sshWeg := false
	for {
		select {
		case <-p.ende:
			return
		case <-time.After(10 * time.Millisecond):
		}
		// config_ssh hat den SSH-Dienst gestoppt: Jede Sitzung endet.
		if gestoppt := exists(filepath.Join(p.z, "ssh/gestoppt")); gestoppt && !sshWeg {
			sshWeg = true
			p.trenne()
		} else if !gestoppt {
			sshWeg = false
		}
		if exists(filepath.Join(p.z, "anmelden.args")) && !exists(filepath.Join(p.z, "anmelden.rc")) {
			args := p.Lies("anmelden.args")
			code := p.Lies("anmelden.code")
			_ = os.Remove(filepath.Join(p.z, "anmelden.args"))
			_ = os.Remove(filepath.Join(p.z, "anmelden.code"))
			aus, rc := "", 9
			if p.Anmelden != nil {
				aus, rc = p.Anmelden(code, argumentOhne(args, "--wireguard"), argumentOhne(args, "--host-schluessel"))
			}
			p.schreibe(filepath.Join(p.z, "anmelden.aus"), aus, 0o644)
			p.schreibe(filepath.Join(p.z, "anmelden.rc"), strconv.Itoa(rc)+"\n", 0o644)
		}
		if exists(filepath.Join(p.z, "neustart")) {
			_ = os.Remove(filepath.Join(p.z, "neustart"))
			p.Abziehen()
			go func() {
				time.Sleep(p.Neustartdauer)
				// /tmp liegt im Arbeitsspeicher, die feste Adresse gilt nur bis hier.
				_ = os.RemoveAll(filepath.Join(p.w, "tmp"))
				_ = os.MkdirAll(filepath.Join(p.w, "tmp"), 0o755)
				_ = os.Remove(filepath.Join(p.z, "netz/fest"))
				_ = os.Remove(filepath.Join(p.z, "ssh/gestoppt"))
				// Was in /etc/rc.d steht, startet mit dem Gerät.
				for dienst, marke := range map[string]string{"vp-edge-industrie": "edge.laeuft", "vp-wartung": "tunnel.laeuft"} {
					_ = os.Remove(filepath.Join(p.z, marke))
					if _, err := os.Lstat(filepath.Join(p.w, "etc/rc.d/S99_"+dienst)); err == nil {
						p.Setze(marke, "1")
					}
				}
				p.Einstecken()
			}()
		}
	}
}

// argumentOhne liest "--name wert" aus einer Zeile mit Leerzeichen als Trenner.
func argumentOhne(zeile, name string) string {
	f := strings.Fields(zeile)
	for i, x := range f {
		if x == name && i+1 < len(f) {
			return f[i+1]
		}
	}
	return ""
}
