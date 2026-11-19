package attrappe

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// FeldBox spielt eine Edge-Light-Box ohne Kundenkonto nach, die im
// Wartungstunnel hängt (Fernlauf, internal/fernlauf): Dropbear auf 2222 nimmt
// nur den SSH-Schlüssel des Techniker-Zugangs an, und erst nach
// SchluesselNach Versuchen (die Box holt den Schlüssel des Fensters ab). Ihr
// Dateisystem ist eine Abbildung Pfad → Inhalt; sie versteht genau die Befehle
// des Fernlaufs und der Attrappen-Skripte (SkripteTarGz).
//
// Weg() ist der Tunnel dorthin (wartung.Weg).
type FeldBox struct {
	Ref     string
	Adresse netip.Addr // im Tunnel, z. B. 10.10.16.5
	// Fassungen: sha256 des Programms → Fassung, die es meldet.
	Fassungen map[string]string
	// SchluesselNach: so viele Anmeldeversuche weist sie ab (Schlüssel noch nicht abgeholt).
	SchluesselNach int
	// Zertifikat: auf der Box liegt eins (inzwischen verbunden).
	Zertifikat bool
	// StartetFalsch: das neue Programm meldet nach dem Neustart diese Fassung.
	StartetFalsch string
	// TunnelNachInstall: nach install.sh fehlt am Tunnel „SSH 2222 abgewiesen“.
	TunnelNachInstall bool

	mu       sync.Mutex
	host     ssh.Signer
	erlaubt  ssh.PublicKey
	versuche int
	dateien  map[string][]byte // ohne „/“ vorne; ein Verzeichnis ist implizit
	verweise map[string]string
	version  string // was /health meldet ("" = Programm steht)
	seq      int64
	land     string
	relayd   bool
	neustart time.Time // letzter Programmstart
	befehle  []string
	ln       net.Listener
}

// NeueFeldBox startet die Box mit installierter Fassung fassung (Stand seq) und
// erlaubt die Anmeldung mit techniker.
func NeueFeldBox(t testing.TB, ref, fassung string, seq int64, techniker ssh.PublicKey) *FeldBox {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	host, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	b := &FeldBox{Ref: ref, Adresse: netip.MustParseAddr("10.10.16.5"), Fassungen: map[string]string{}, host: host, erlaubt: techniker,
		version: fassung, seq: seq, neustart: time.Now(), verweise: map[string]string{}}
	alt := []byte("programm " + fassung)
	b.Fassungen[summeVon(alt)] = fassung
	b.dateien = map[string][]byte{
		"etc/vp-edge-light/ref":                                     []byte(ref + "\n"),
		"etc/vp-edge-light/identity/device.key":                     []byte("-----BEGIN EC PRIVATE KEY-----\nGEHEIM\n"),
		"usr/libexec/vp-edge-light/boot.sh":                         []byte("LOADER_STAND=0\n"),
		"usr/libexec/vp-edge-light/wlan-anschluss.sh":               []byte("# alt\n"),
		"etc/init.d/vp-edge-light":                                  []byte("# init alt\n"),
		"etc/config/vp-edge-light":                                  []byte("config main 'main'\n"),
		"etc/config/firewall":                                       []byte("config zone wan\n"),
		"etc/config/system":                                         []byte("config system\n"),
		"etc/config/wireless":                                       []byte("option key 'WLAN-KENNWORT-DES-KUNDEN'\n"),
		"etc/crontabs/root":                                         []byte("* * * * * vp-service-tunnel\n"),
		"etc/vp-edge-light/ota/trust-set.json":                      []byte(`{"alt":1}`),
		"etc/vp-edge-light/ota/current.json":                        []byte(fmt.Sprintf(`{"release":"%s","release_seq":%d,"state_schema":1}`, fassung, seq)),
		"usr/share/vp-edge-light/vp-edge-light-linux-mipsle.gz":     alt,
		"usr/share/vp-edge-light/vp-edge-light-linux-mipsle.sha256": []byte(summeVon(alt) + "\n"),
		"etc/rc.d/S95vp-edge-light":                                 []byte("->init"),
	}
	if b.ln, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.ln.Close() })
	go b.annehmen()
	return b
}

func summeVon(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

// HostFingerabdruck ist der Host-Schlüssel (wie in der Werkstatt-Abnahme).
func (b *FeldBox) HostFingerabdruck() string { return ssh.FingerprintSHA256(b.host.PublicKey()) }

// Datei gibt eine Datei der Box ("" = fehlt).
func (b *FeldBox) Datei(p string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.dateien[strings.TrimPrefix(p, "/")])
}

// Fassung ist, was /health meldet, und das Land am Funkmodul.
func (b *FeldBox) Fassung() (version, land string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.version, b.land
}

// Meldung ist, was die Plattform von der Box hört: deviceInfo und der letzte Programmstart.
func (b *FeldBox) Meldung() (deviceInfo string, start time.Time, zertifikat bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return "vp-edge-core " + b.version, b.neustart, b.Zertifikat
}

// Befehle, die die Box ausgeführt hat.
func (b *FeldBox) Befehle() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.befehle...)
}

// Weg ist der Tunnel zur Box: nur ihre Adresse, nur Port 2222.
func (b *FeldBox) Weg() *FeldWeg { return &FeldWeg{b: b} }

// FeldWeg ist ein Tunnel-Weg (wartung.Weg) zur FeldBox.
type FeldWeg struct {
	b  *FeldBox
	zu bool
}

func (w *FeldWeg) Dial(ctx context.Context, ziel netip.AddrPort) (net.Conn, error) {
	if w.zu {
		return nil, fmt.Errorf("Tunnel geschlossen")
	}
	if ziel != netip.AddrPortFrom(w.b.Adresse, 2222) {
		return nil, fmt.Errorf("%s: im Tunnel nicht erreichbar", ziel)
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", w.b.ln.Addr().String())
}

func (w *FeldWeg) Schliesse() { w.zu = true }

func (b *FeldBox) annehmen() {
	for {
		c, err := b.ln.Accept()
		if err != nil {
			return
		}
		cfg := &ssh.ServerConfig{PublicKeyCallback: func(cm ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			b.mu.Lock()
			defer b.mu.Unlock()
			if cm.User() != "root" || !bytes.Equal(k.Marshal(), b.erlaubt.Marshal()) {
				return nil, fmt.Errorf("abgewiesen")
			}
			b.versuche++
			if b.versuche <= b.SchluesselNach {
				return nil, fmt.Errorf("Schlüssel noch nicht abgeholt")
			}
			return nil, nil
		}}
		cfg.AddHostKey(b.host)
		go b.verbindung(c, cfg)
	}
}

func (b *FeldBox) verbindung(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		_ = c.Close()
		return
	}
	defer sc.Close()
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
				code := b.exec(ch, a.Befehl)
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
				return
			}
		}()
	}
}

var (
	pfadMuster = regexp.MustCompile(`echo da=(\S+);`)
	rmMuster   = regexp.MustCompile(`'(/[^']+)'`)
)

func (b *FeldBox) exec(ch ssh.Channel, befehl string) int {
	b.mu.Lock()
	b.befehle = append(b.befehle, befehl)
	b.mu.Unlock()
	aus := func(f string, a ...any) { fmt.Fprintf(ch, f, a...) }
	switch {
	case befehl == "true":
		return 0
	case strings.Contains(befehl, "echo \"zertifikat="): // bestand
		b.mu.Lock()
		defer b.mu.Unlock()
		z := "nein"
		if b.Zertifikat {
			z = "ja"
		}
		aus("ref=%s\nzertifikat=%s\ncurrent=%s\nflash_frei_kb=6200\nram_frei_kb=51000\nboard=glinet,gl-mt300n-v2\n",
			strings.TrimSpace(string(b.dateien["etc/vp-edge-light/ref"])), z, string(b.dateien["etc/vp-edge-light/ota/current.json"]))
		return 0
	case strings.HasPrefix(befehl, "wget -q -O - http://127.0.0.1:8484/health"):
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.version == "" {
			return 4
		}
		aus(`{"status":"ok","ref":"%s","version":"%s","ota_update":{"backend":"light","current_seq":%d,"trust":{"trust_set_key_ids":["rel-test"],"trust_set_signed_by":"root-test"}}}`,
			b.Ref, b.version, b.seq)
		return 0
	case strings.Contains(befehl, "echo da=") || strings.Contains(befehl, "echo fehlt="): // sichern: was gibt es
		b.mu.Lock()
		defer b.mu.Unlock()
		for _, z := range strings.Split(befehl, "\n") {
			m := pfadMuster.FindStringSubmatch(z)
			if m == nil {
				continue
			}
			if b.gibt(m[1]) {
				aus("da=%s\n", m[1])
			} else {
				aus("fehlt=%s\n", m[1])
			}
		}
		for p := range b.dateien {
			if strings.HasPrefix(p, "etc/rc.d/") && strings.HasSuffix(p, "vp-edge-light") {
				aus("rc=%s\n", p)
			}
		}
		aus("land=%s\n", b.land)
		return 0
	case strings.HasPrefix(befehl, "tar -czf - -C / "):
		b.mu.Lock()
		defer b.mu.Unlock()
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		var namen []string
		for _, p := range strings.Fields(strings.TrimPrefix(befehl, "tar -czf - -C / ")) {
			for q := range b.dateien {
				if q == p || strings.HasPrefix(q, p+"/") {
					namen = append(namen, q)
				}
			}
			if !b.istDatei(p) {
				namen = append(namen, p+"/")
			}
		}
		sort.Strings(namen)
		for _, n := range namen {
			if strings.HasSuffix(n, "/") {
				_ = tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeDir, Mode: 0o755})
				continue
			}
			_ = tw.WriteHeader(&tar.Header{Name: n, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(b.dateien[n]))})
			_, _ = tw.Write(b.dateien[n])
		}
		_ = tw.Close()
		_ = gz.Close()
		_, _ = ch.Write(buf.Bytes())
		return 0
	case befehl == "vp-attrappe status": // service-tunnel.sh status
		b.mu.Lock()
		kaputt := b.TunnelNachInstall && b.dateien["etc/hotplug.d/iface/91-vp-einrichtung"] != nil
		b.mu.Unlock()
		aus("  latest handshake: 7 seconds ago\n")
		if kaputt {
			aus("--- SSH 2222 ausserhalb der Tunnel: NICHT gesperrt (service-tunnel.sh erneut ausfuehren)\n")
		} else {
			aus("--- SSH 2222 ausserhalb der Tunnel: abgewiesen (nur aus wg_wartung, bisher 0 Pakete abgewiesen)\n")
		}
		aus("--- Fenster-Schluessel: Abholer laeuft, letzte gueltige Antwort des Wartungsservers: vor 4 s\n")
		aus("--- dauerhaft aus /etc/dropbear/authorized_keys: 1 Schluessel\n")
		return 0
	case befehl == "vp-attrappe install": // install.sh: Programm von der Standardeingabe
		prog, _ := io.ReadAll(ch)
		b.mu.Lock()
		defer b.mu.Unlock()
		f, ok := b.Fassungen[summeVon(prog)]
		if !ok {
			fmt.Fprintf(ch.Stderr(), "unbekanntes Programm\n")
			return 1
		}
		b.dateien["usr/share/vp-edge-light/vp-edge-light-linux-mipsle.gz"] = prog
		b.dateien["usr/share/vp-edge-light/vp-edge-light-linux-mipsle.sha256"] = []byte(summeVon(prog) + "\ngroesse 1 1\n")
		b.dateien["etc/vp-edge-light/ota/current.json"] = []byte(fmt.Sprintf(`{"release":"%s","release_seq":%d,"state_schema":1}`, f, b.seq+1))
		b.dateien["etc/vp-edge-light/ota/trust-set.json"] = []byte(`{"neu":1}`)
		b.dateien["usr/libexec/vp-edge-light/boot.sh"] = []byte("LOADER_STAND=2\n")
		b.dateien["usr/libexec/vp-edge-light/einrichtung-wlan.sh"] = []byte("# neu\n")
		b.dateien["etc/hotplug.d/iface/91-vp-einrichtung"] = []byte("# neu\n")
		b.dateien["etc/crontabs/root"] = []byte("* * * * * vp-service-tunnel\n* * * * * einrichtung-wlan.sh takt # vp-einrichtung-wlan\n")
		b.dateien["etc/config/firewall"] = []byte("config zone wan\nconfig rule 'vp_ocpp'\n")
		return 0
	case strings.Contains(befehl, "wireless.radio0.country=DE") && strings.Contains(befehl, "uci commit wireless"):
		b.mu.Lock()
		b.land, b.relayd = "DE", true
		b.mu.Unlock()
		return 0
	case strings.Contains(befehl, "echo land=$(uci -q get wireless.radio0.country)"):
		b.mu.Lock()
		defer b.mu.Unlock()
		r := "fehlt"
		if b.relayd {
			r = "da"
		}
		aus("land=%s\nrelayd=%s\n", b.land, r)
		return 0
	case befehl == "/etc/init.d/vp-edge-light restart":
		b.starte()
		return 0
	case strings.HasPrefix(befehl, "for d in "): // zurueck: was liegt jetzt da
		b.mu.Lock()
		defer b.mu.Unlock()
		var l []string
		for p := range b.dateien {
			if strings.HasPrefix(p, "etc/vp-edge-light/ota/") || strings.HasPrefix(p, "usr/share/vp-edge-light/") ||
				(strings.HasPrefix(p, "etc/rc.d/") && strings.HasSuffix(p, "vp-edge-light")) {
				l = append(l, "/"+p)
			}
		}
		sort.Strings(l)
		aus("%s\n", strings.Join(l, "\n"))
		return 0
	case strings.Contains(befehl, "tar -xzf - -C /"): // zurueck: einspielen
		daten, _ := io.ReadAll(ch)
		b.mu.Lock()
		defer b.mu.Unlock()
		b.version = ""
		if i := strings.Index(befehl, "rm -rf "); i >= 0 {
			for _, m := range rmMuster.FindAllStringSubmatch(befehl[i:strings.Index(befehl, "tar -xzf")], -1) {
				p := strings.TrimPrefix(m[1], "/")
				for q := range b.dateien {
					if q == p || strings.HasPrefix(q, p+"/") {
						delete(b.dateien, q)
					}
				}
			}
		}
		gz, err := gzip.NewReader(bytes.NewReader(daten))
		if err != nil {
			return 2
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err != nil {
				break
			}
			if h.Typeflag == tar.TypeReg {
				inhalt, _ := io.ReadAll(tr)
				b.dateien[h.Name] = inhalt
			}
		}
		return 0
	case strings.Contains(befehl, "/etc/init.d/firewall reload") && strings.Contains(befehl, "/etc/init.d/vp-edge-light start"):
		if strings.Contains(befehl, "uci -q delete wireless.radio0.country") {
			b.mu.Lock()
			b.land = ""
			b.mu.Unlock()
		}
		b.starte()
		return 0
	}
	fmt.Fprintf(ch.Stderr(), "attrappe: unbekannter Befehl %q\n", befehl)
	return 127
}

// starte startet das Programm aus dem Flash: Fassung und Stand nach seiner Prüfsumme.
func (b *FeldBox) starte() {
	b.mu.Lock()
	defer b.mu.Unlock()
	prog := b.dateien["usr/share/vp-edge-light/vp-edge-light-linux-mipsle.gz"]
	b.version = b.Fassungen[summeVon(prog)]
	var cur struct {
		Seq int64 `json:"release_seq"`
	}
	if s := string(b.dateien["etc/vp-edge-light/ota/current.json"]); s != "" {
		_, _ = fmt.Sscanf(s[strings.Index(s, `"release_seq":`)+len(`"release_seq":`):], "%d", &cur.Seq)
		b.seq = cur.Seq
	}
	if b.StartetFalsch != "" && strings.Contains(string(b.dateien["usr/libexec/vp-edge-light/boot.sh"]), "LOADER_STAND=2") {
		b.version = b.StartetFalsch
	}
	b.neustart = time.Now()
}

func (b *FeldBox) gibt(p string) bool {
	for q := range b.dateien {
		if q == p || strings.HasPrefix(q, p+"/") {
			return true
		}
	}
	return false
}

func (b *FeldBox) istDatei(p string) bool { _, ok := b.dateien[p]; return ok }

// ProgrammFuer gibt ein Programm, das sich als fassung meldet, und merkt es sich.
func (b *FeldBox) ProgrammFuer(fassung string) []byte {
	p := []byte("programm " + fassung)
	b.mu.Lock()
	b.Fassungen[summeVon(p)] = fassung
	b.mu.Unlock()
	return p
}
