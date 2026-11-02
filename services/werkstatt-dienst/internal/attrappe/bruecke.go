// Package attrappe hat Attrappen für die Tests des Werkstatt-Dienstes. Keine
// spricht mit echter Hardware: alles läuft im Prozess auf 127.0.0.1.
//
// Bruecke ist ein SSH-Server, der sich wie die Werkbank-Brücke verhält:
//   - vor dem Einrichten kennt er nur den Benutzer des Imagers mit dem
//     Werkstatt-Schlüssel, der ein Paket hochladen und einrichten.sh mit sudo
//     starten kann;
//   - das Einrichten liest parameter.env und authorized_keys aus dem
//     hochgeladenen tar; danach gilt nur noch der Benutzer werkstatt mit genau
//     diesen Zeilen, und die Attrappe setzt ihre Optionen durch (command= als
//     erzwungener Befehl, restrict, port-forwarding, permitopen);
//   - der erzwungene Status-Befehl antwortet mit dem JSON von
//     vp-werkbank-status, der Pflege-Befehl spielt ein neues Paket ein.
package attrappe

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// Zeile ist eine Zeile aus authorized_keys des Benutzers werkstatt.
type Zeile struct {
	Schluessel ssh.PublicKey
	Optionen   []string
	Kommentar  string
}

func (z Zeile) option(name string) (string, bool) {
	for _, o := range z.Optionen {
		if o == name {
			return "", true
		}
		if strings.HasPrefix(o, name+"=") {
			return strings.Trim(strings.TrimPrefix(o, name+"="), `"`), true
		}
	}
	return "", false
}

func (z Zeile) permitopen() []string {
	var out []string
	for _, o := range z.Optionen {
		if strings.HasPrefix(o, "permitopen=") {
			out = append(out, strings.Trim(strings.TrimPrefix(o, "permitopen="), `"`))
		}
	}
	return out
}

// Bruecke ist die Attrappe.
type Bruecke struct {
	Adresse             string
	Host                ssh.Signer
	ImagerKey           ssh.PublicKey
	ImagerName          string
	Antworten           []map[string]any // für das Status-JSON
	Kabel               bool
	Ziele               map[string]string // permitopen-Ziel → lokale Adresse eines Lauschers
	EinrichtenScheitert bool
	// Statt Antworten und Ziele: eine Box, die ihre Adresse wechselt (Mango).
	AntwortenFunc func() []map[string]any
	ZielFunc      func(ziel string) (string, bool)

	mu                     sync.Mutex
	fassung                string
	zeilen                 []Zeile
	dateien                map[string][]byte
	befehle                []string // was ausgeführt wurde (zum Prüfen)
	eingerichtet, gepflegt int
	ln                     net.Listener
}

// NeueBruecke startet die Attrappe. imager ist der Werkstatt-Schlüssel des
// Imager-Benutzers.
func NeueBruecke(t testing.TB, imager ssh.PublicKey) *Bruecke {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	host, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	b := &Bruecke{Adresse: ln.Addr().String(), Host: host, ImagerKey: imager, ImagerName: "vpwerkstatt", Kabel: true, Ziele: map[string]string{}, dateien: map[string][]byte{}, ln: ln}
	t.Cleanup(func() { _ = ln.Close() })
	go b.annehmen()
	return b
}

// Fassung gibt die eingerichtete Fassung zurück (leer: nie eingerichtet).
func (b *Bruecke) Fassung() string { b.mu.Lock(); defer b.mu.Unlock(); return b.fassung }

// Zaehler: wie oft eingerichtet (Imager) und gepflegt (Pflege-Schlüssel).
func (b *Bruecke) Zaehler() (eingerichtet, gepflegt int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.eingerichtet, b.gepflegt
}

// Zeilen gibt die gelernten authorized_keys-Zeilen zurück.
func (b *Bruecke) Zeilen() []Zeile {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Zeile(nil), b.zeilen...)
}

// Befehle gibt die ausgeführten Befehle zurück.
func (b *Bruecke) Befehle() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.befehle...)
}

// SetzeFassung verstellt die Fassung (simuliert eine veraltete Brücke).
func (b *Bruecke) SetzeFassung(f string) { b.mu.Lock(); defer b.mu.Unlock(); b.fassung = f }

func (b *Bruecke) zeileFuer(key ssh.PublicKey) (Zeile, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, z := range b.zeilen {
		if bytes.Equal(z.Schluessel.Marshal(), key.Marshal()) {
			return z, true
		}
	}
	return Zeile{}, false
}

func (b *Bruecke) annehmen() {
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(m ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			b.mu.Lock()
			eingerichtet := b.fassung != ""
			b.mu.Unlock()
			switch m.User() {
			case b.ImagerName:
				// Nach dem Einrichten gilt AllowUsers werkstatt.
				if !eingerichtet && bytes.Equal(key.Marshal(), b.ImagerKey.Marshal()) {
					return &ssh.Permissions{Extensions: map[string]string{"rolle": "imager"}}, nil
				}
			case "werkstatt":
				if _, ok := b.zeileFuer(key); ok {
					return &ssh.Permissions{Extensions: map[string]string{"rolle": "werkstatt", "key": string(key.Marshal())}}, nil
				}
			}
			return nil, fmt.Errorf("abgewiesen")
		},
	}
	cfg.AddHostKey(b.Host)
	for {
		c, err := b.ln.Accept()
		if err != nil {
			return
		}
		go b.verbindung(c, cfg)
	}
}

func (b *Bruecke) verbindung(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		_ = c.Close()
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	var zeile Zeile
	if sc.Permissions.Extensions["rolle"] == "werkstatt" {
		pk, _ := ssh.ParsePublicKey([]byte(sc.Permissions.Extensions["key"]))
		zeile, _ = b.zeileFuer(pk)
	}
	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			ch, rs, err := nc.Accept()
			if err != nil {
				continue
			}
			go b.sitzung(ch, rs, sc.Permissions.Extensions["rolle"], zeile)
		case "direct-tcpip":
			b.weiterleiten(nc, sc.Permissions.Extensions["rolle"], zeile)
		default:
			_ = nc.Reject(ssh.UnknownChannelType, "nein")
		}
	}
}

func (b *Bruecke) weiterleiten(nc ssh.NewChannel, rolle string, z Zeile) {
	var p struct {
		Host     string
		Port     uint32
		OrigHost string
		OrigPort uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &p); err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "kaputt")
		return
	}
	ziel := net.JoinHostPort(p.Host, fmt.Sprint(p.Port))
	_, restrict := z.option("restrict")
	_, pf := z.option("port-forwarding")
	erlaubt := rolle == "werkstatt" && (!restrict || pf)
	if erlaubt {
		po := z.permitopen()
		erlaubt = len(po) == 0
		for _, o := range po {
			if o == ziel {
				erlaubt = true
			}
		}
	}
	if !erlaubt {
		_ = nc.Reject(ssh.Prohibited, "administratively prohibited: open failed")
		return
	}
	lokal, ok := b.Ziele[ziel]
	if b.ZielFunc != nil {
		lokal, ok = b.ZielFunc(ziel)
	}
	if !ok {
		_ = nc.Reject(ssh.ConnectionFailed, "connect failed: No route to host")
		return
	}
	conn, err := net.Dial("tcp", lokal)
	if err != nil {
		_ = nc.Reject(ssh.ConnectionFailed, "connect failed: Connection refused")
		return
	}
	ch, rs, err := nc.Accept()
	if err != nil {
		_ = conn.Close()
		return
	}
	go ssh.DiscardRequests(rs)
	go func() { _, _ = io.Copy(ch, conn); _ = ch.CloseWrite() }()
	go func() { _, _ = io.Copy(conn, ch); _ = conn.Close() }()
}

type ausfuehren struct{ Befehl string }

func (b *Bruecke) sitzung(ch ssh.Channel, reqs <-chan *ssh.Request, rolle string, z Zeile) {
	defer ch.Close()
	for r := range reqs {
		switch r.Type {
		case "exec":
			var a ausfuehren
			_ = ssh.Unmarshal(r.Payload, &a)
			_ = r.Reply(true, nil)
			code := b.exec(ch, rolle, z, a.Befehl)
			_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
			return
		case "shell", "pty-req":
			_ = r.Reply(false, nil)
		default:
			_ = r.Reply(false, nil)
		}
	}
}

var sha256Muster = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (b *Bruecke) exec(ch ssh.Channel, rolle string, z Zeile, befehl string) int {
	b.mu.Lock()
	b.befehle = append(b.befehle, rolle+": "+befehl)
	b.mu.Unlock()
	if rolle == "werkstatt" {
		erzwungen, ok := z.option("command")
		if !ok {
			fmt.Fprintln(ch.Stderr(), "Notfall-Shell gibt es in der Attrappe nicht")
			return 1
		}
		switch erzwungen {
		case "sudo -n /usr/local/sbin/vp-werkbank-status":
			_, _ = ch.Write(append(b.statusJSON(), '\n'))
			return 0
		case "/usr/local/bin/vp-werkbank-pflege":
			summe, ok := strings.CutPrefix(befehl, "einrichten ")
			if !ok || !sha256Muster.MatchString(summe) {
				fmt.Fprintln(ch.Stderr(), "FEHLER: der Pflege-Schlüssel kennt nur: einrichten <sha256>")
				return 2
			}
			tarDaten, _ := io.ReadAll(io.LimitReader(ch, 4<<20+1))
			ist := sha256.Sum256(tarDaten)
			if hex.EncodeToString(ist[:]) != summe {
				fmt.Fprintf(ch.Stderr(), "FEHLER: Paket hat die Prüfsumme %x, erwartet %s\n", ist, summe)
				return 3
			}
			if err := b.einrichten(tarDaten); err != nil {
				fmt.Fprintln(ch.Stderr(), "FEHLER:", err)
				return 1
			}
			b.mu.Lock()
			b.gepflegt++
			b.mu.Unlock()
			fmt.Fprintln(ch, "einrichten: gepflegt")
			return 0
		case "/bin/false":
			return 1
		}
		fmt.Fprintln(ch.Stderr(), "unbekannter erzwungener Befehl")
		return 1
	}
	// Imager-Benutzer: was der Dienst beim ersten Einrichten tut
	switch {
	case strings.HasPrefix(befehl, "umask 077 && cat > "):
		datei := strings.TrimPrefix(befehl, "umask 077 && cat > ")
		d, _ := io.ReadAll(ch)
		b.mu.Lock()
		b.dateien[datei] = d
		b.mu.Unlock()
		return 0
	case strings.HasPrefix(befehl, "sha256sum "):
		datei := strings.TrimPrefix(befehl, "sha256sum ")
		b.mu.Lock()
		d, ok := b.dateien[datei]
		b.mu.Unlock()
		if !ok {
			fmt.Fprintln(ch.Stderr(), "sha256sum: No such file")
			return 1
		}
		s := sha256.Sum256(d)
		fmt.Fprintf(ch, "%x  %s\n", s, datei)
		return 0
	case strings.HasPrefix(befehl, "sudo -n /bin/sh -c "):
		re := regexp.MustCompile(`tar -x -f (\S+) `)
		m := re.FindStringSubmatch(befehl)
		if m == nil {
			return 1
		}
		b.mu.Lock()
		d := b.dateien[m[1]]
		b.mu.Unlock()
		if b.EinrichtenScheitert {
			fmt.Fprintln(ch.Stderr(), "FEHLER: sshd -t: SSH-Konfiguration ungültig, nicht übernommen")
			return 1
		}
		if err := b.einrichten(d); err != nil {
			fmt.Fprintln(ch.Stderr(), "FEHLER:", err)
			return 1
		}
		b.mu.Lock()
		b.eingerichtet++
		b.mu.Unlock()
		fmt.Fprintln(ch, "einrichten: Fassung eingerichtet")
		return 0
	}
	fmt.Fprintln(ch.Stderr(), "Attrappe kennt den Befehl nicht:", befehl)
	return 127
}

func (b *Bruecke) einrichten(tarDaten []byte) error {
	tr := tar.NewReader(bytes.NewReader(tarDaten))
	var param, keys []byte
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		d, _ := io.ReadAll(tr)
		switch h.Name {
		case "parameter.env":
			param = d
		case "authorized_keys":
			keys = d
		}
	}
	fassung := ""
	for _, z := range strings.Split(string(param), "\n") {
		if v, ok := strings.CutPrefix(z, "FASSUNG="); ok {
			fassung = v
		}
	}
	if fassung == "" {
		return fmt.Errorf("parameter.env ohne FASSUNG")
	}
	var zeilen []Zeile
	rest := keys
	for len(bytes.TrimSpace(rest)) > 0 {
		pk, kommentar, opts, r, err := ssh.ParseAuthorizedKey(rest)
		if err != nil {
			return fmt.Errorf("authorized_keys: %w", err)
		}
		zeilen = append(zeilen, Zeile{Schluessel: pk, Optionen: opts, Kommentar: kommentar})
		rest = r
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.fassung, b.zeilen = fassung, zeilen
	return nil
}

func (b *Bruecke) statusJSON() []byte {
	var antworten []map[string]any
	if b.AntwortenFunc != nil {
		antworten = b.AntwortenFunc()
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.AntwortenFunc == nil {
		antworten = b.Antworten
	}
	if antworten == nil {
		antworten = []map[string]any{}
	}
	s := map[string]any{
		"schema":       "vp-werkbank-status.v1",
		"fassung":      b.fassung,
		"zeit":         "2026-11-02T09:00:00Z",
		"werkstatt":    map[string]any{"schnittstelle": "eth0", "kabel": b.Kabel, "adressen": []string{"192.168.8.2/24", "192.168.1.2/24", "10.213.0.2/24"}},
		"netz":         map[string]any{"schnittstelle": "wlan0", "oben": true, "adressen": []string{"192.0.2.50/24"}, "energiesparen": "aus"},
		"durchleitung": map[string]any{"ip_forward": true, "firewall": true},
		"antworten":    antworten,
	}
	out, _ := json.Marshal(s)
	return out
}

// Schluessel erzeugt einen Wegwerf-Schlüssel (ed25519).
func Schluessel(t testing.TB) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// SchluesselPEM erzeugt einen Wegwerf-Schlüssel als OpenSSH-PEM (für Dateien).
func SchluesselPEM(t testing.TB) ([]byte, ssh.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	blk, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	pk, _ := ssh.NewPublicKey(pub)
	var buf bytes.Buffer
	_ = pemEncode(&buf, blk.Type, blk.Bytes)
	return buf.Bytes(), pk
}
