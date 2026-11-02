package attrappe

import (
	"bufio"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// Mango spielt eine GL-MT300N-V2 am Werkstatt-Anschluss nach: ab Werk unter
// 192.168.8.1 (GL-Firmware, root ohne Passwort), nach "sysupgrade -n" frisches
// OpenWrt unter 192.168.1.1 mit neuem Host-Schlüssel, nach dem Umstellen des
// LAN und "reboot" unter der neuen Adresse. Sie versteht genau die Befehle,
// die der Dienst und die Attrappen-Skripte (SkripteTarGz) schicken.
//
// Hinter der Brücken-Attrappe: Bruecke.AntwortenFunc = m.Antworten,
// Bruecke.ZielFunc = m.Ziel.
type Mango struct {
	MAC                     string
	Board                   string // /tmp/sysinfo/board_name
	GL                      string // /etc/glversion ("" = keine GL-Firmware)
	RootPasswortAbWerk      bool   // ab Werk schon ein Passwort (eingerichtet)
	SysupgradeTestScheitert bool
	AbbildVerfaelschen      bool // speichert das Abbild falsch (Prüfsumme auf der Box weicht ab)
	OpenWrt                 string
	Ref, Version            string
	WgPub                   string
	Neustartdauer           time.Duration
	Zweite                  bool // ein zweites Gerät mit eigener MAC unter derselben Adresse
	// Anmelden antwortet auf werkstatt-anmelden (P7): Code von der
	// Standardeingabe, Tunnel- und Host-Schlüssel aus den Argumenten; nil =
	// Befehl unbekannt (wie eine Box ohne den Befehl).
	Anmelden func(code, wireguard, host string) (aus string, rc int)

	mu           sync.Mutex
	phase        string // werk | openwrt
	adresse      string
	offline      bool
	passwort     string
	hostWerk     ssh.Signer
	hostOW       ssh.Signer
	dateien      map[string][]byte
	gateway      string
	dns          []string
	lan          string
	edge, laeuft bool
	tunnel       string
	befehle      []string
	logbuch      []string
	sshLn, glLn  net.Listener
	conns        map[*ssh.ServerConn]bool
}

// NeueMango startet die Attrappe ab Werk. ow: true heißt, sie kommt schon mit
// frischem OpenWrt unter 192.168.1.1.
func NeueMango(t testing.TB, ow bool) *Mango {
	t.Helper()
	m := &Mango{MAC: "94:83:c4:12:34:56", Board: "glinet,gl-mt300n-v2", GL: "4.3.25", OpenWrt: "25.12.5",
		Ref: "edge-k7m2xq3", Version: "edge-light-2026.11.1", WgPub: "c2Vydm9wdWJ2b3JiaWxkZXJ3aXJlZ3VhcmRrZXk0NDE=",
		Neustartdauer: 150 * time.Millisecond, phase: "werk", adresse: "192.168.8.1",
		dateien: map[string][]byte{}, conns: map[*ssh.ServerConn]bool{}}
	if ow {
		m.phase, m.adresse = "openwrt", "192.168.1.1"
	}
	m.hostWerk = rsaSchluessel(t)
	m.hostOW = rsaSchluessel(t)
	var err error
	if m.sshLn, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	if m.glLn, err = net.Listen("tcp", "127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.sshLn.Close(); _ = m.glLn.Close() })
	go m.annehmen()
	go func() {
		_ = http.Serve(m.glLn, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"code":0,"model":"mt300n-v2","version":"` + m.GL + `","init":false}`))
		}))
	}()
	return m
}

// Dropbear der Mango kennt nur RSA.
func rsaSchluessel(t testing.TB) ssh.Signer {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// Antworten wie vp-werkbank-status sie meldet.
func (m *Mango) Antworten() []map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.offline {
		return []map[string]any{}
	}
	macs := []string{m.MAC}
	if m.Zweite {
		macs = append(macs, "94:83:c4:ab:cd:ef")
	}
	return []map[string]any{{"adresse": m.adresse, "macs": macs}}
}

// Ziel ordnet eine Werkstatt-Adresse dem Lauscher zu, solange die Mango dort steht.
func (m *Mango) Ziel(ziel string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.offline {
		return "", false
	}
	switch ziel {
	case m.adresse + ":22":
		return m.sshLn.Addr().String(), true
	case m.adresse + ":80":
		if m.phase == "werk" {
			return m.glLn.Addr().String(), true
		}
	}
	return "", false
}

// Passwort gibt das Root-Passwort zurück (Test: wo darf es nicht stehen).
func (m *Mango) Passwort() string { m.mu.Lock(); defer m.mu.Unlock(); return m.passwort }

// Befehle gibt die Befehle zurück, die die Mango ausgeführt hat.
func (m *Mango) Befehle() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.befehle...)
}

// Datei gibt eine Datei der Mango zurück.
func (m *Mango) Datei(p string) string { m.mu.Lock(); defer m.mu.Unlock(); return string(m.dateien[p]) }

// Stand: Phase, Adresse, Gateway, Tunnel.
func (m *Mango) Stand() (phase, adresse, gateway, tunnel string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.phase, m.adresse, m.gateway, m.tunnel
}

func (m *Mango) annehmen() {
	for {
		c, err := m.sshLn.Accept()
		if err != nil {
			return
		}
		m.mu.Lock()
		host := m.hostWerk
		if m.phase == "openwrt" {
			host = m.hostOW
		}
		m.mu.Unlock()
		cfg := &ssh.ServerConfig{PasswordCallback: func(cm ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			m.mu.Lock()
			defer m.mu.Unlock()
			soll := m.passwort
			if m.phase == "werk" && m.RootPasswortAbWerk {
				soll = "gl-schon-eingerichtet"
			}
			if cm.User() == "root" && string(pw) == soll {
				return nil, nil
			}
			return nil, fmt.Errorf("abgewiesen")
		}}
		cfg.AddHostKey(host)
		go m.verbindung(c, cfg)
	}
}

func (m *Mango) verbindung(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		_ = c.Close()
		return
	}
	m.mu.Lock()
	m.conns[sc] = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); delete(m.conns, sc); m.mu.Unlock(); _ = sc.Close() }()
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
				code, abreissen := m.exec(ch, a.Befehl)
				if abreissen {
					m.neustart(sc)
					return
				}
				_, _ = ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{uint32(code)}))
				return
			}
		}()
	}
}

// neustart trennt alle Verbindungen, nimmt die Mango vom Netz und bringt
// sie nach Neustartdauer im neuen Zustand zurück.
func (m *Mango) neustart(sc *ssh.ServerConn) {
	m.mu.Lock()
	m.offline = true
	for c := range m.conns {
		_ = c.Close()
	}
	d := m.Neustartdauer
	m.mu.Unlock()
	go func() {
		time.Sleep(d)
		m.mu.Lock()
		defer m.mu.Unlock()
		switch {
		case m.phase == "werk":
			m.phase, m.adresse, m.passwort = "openwrt", "192.168.1.1", ""
		case m.lan != "":
			m.adresse = strings.SplitN(m.lan, "/", 2)[0]
		}
		if m.edge {
			m.laeuft = true // vp-edge-light startet mit der Box
		}
		m.offline = false
	}()
}

var (
	gwMuster  = regexp.MustCompile(`uci set network\.lan\.gateway='([0-9.]+)'`)
	dnsMuster = regexp.MustCompile(`uci add_list network\.lan\.dns='([0-9.]+)'`)
	lanMuster = regexp.MustCompile(`uci add_list network\.lan\.ipaddr='([0-9./]+)'`)
)

// argument liest --name 'wert' aus einem Befehl.
func argument(b, name string) string {
	m := regexp.MustCompile(regexp.QuoteMeta(name) + ` '([^']*)'`).FindStringSubmatch(b)
	if m == nil {
		return ""
	}
	return m[1]
}

// exec führt einen Befehl aus; abreissen heißt: die Verbindung endet ohne Ergebnis.
func (m *Mango) exec(ch ssh.Channel, b string) (code int, abreissen bool) {
	m.mu.Lock()
	m.befehle = append(m.befehle, b)
	phase := m.phase
	m.mu.Unlock()
	aus := func(f string, a ...any) { fmt.Fprintf(ch, f, a...) }
	switch {
	case strings.Contains(b, "tmp_frei_kb="): // befehlWerk
		m.mu.Lock()
		pw := "leer"
		if m.RootPasswortAbWerk {
			pw = "gesetzt"
		}
		aus("board=%s\nmodell=GL-MT300N-V2\ngl=%s\nbasis=22.03.4\nrootpw=%s\ntmp_frei_kb=61000\nedge=nein\n", m.Board, m.GL, pw)
		m.mu.Unlock()
	case strings.Contains(b, "DISTRIB_TARGET"): // befehlOpenWrt
		m.mu.Lock()
		pw := "leer"
		if m.passwort != "" {
			pw = "gesetzt"
		}
		edge := "nein"
		if m.edge {
			edge = "ja"
		}
		aus("release=%s\ntarget=ramips/mt76x8\nboard=%s\ngl=nein\nrootpw=%s\nedge=%s\ndropbear=Dropbear v2025.89\n", m.OpenWrt, m.Board, pw, edge)
		m.mu.Unlock()
	case strings.HasPrefix(b, "cat > /tmp/vp-openwrt.bin"):
		d, _ := io.ReadAll(ch)
		m.mu.Lock()
		if m.AbbildVerfaelschen && len(d) > 0 {
			d[0] ^= 0xff
		}
		m.dateien["/tmp/vp-openwrt.bin"] = d
		m.mu.Unlock()
	case strings.HasPrefix(b, "sha256sum /tmp/vp-openwrt.bin"):
		s := sha256.Sum256([]byte(m.Datei("/tmp/vp-openwrt.bin")))
		aus("%x  /tmp/vp-openwrt.bin\n", s)
	case strings.HasPrefix(b, "sysupgrade -T"):
		if m.SysupgradeTestScheitert {
			fmt.Fprintln(ch.Stderr(), "Image check failed.")
			return 1, false
		}
	case strings.HasPrefix(b, "sysupgrade -n") && phase == "werk":
		aus("Commencing upgrade. Closing all shell sessions.\n")
		return 0, true
	case strings.Contains(b, "network.lan.ipaddr=") && strings.Contains(b, "reboot"): // LAN umstellen
		m.mu.Lock()
		if x := lanMuster.FindStringSubmatch(b); x != nil {
			m.lan = x[1]
		}
		if x := gwMuster.FindStringSubmatch(b); x != nil {
			m.gateway = x[1]
		}
		m.mu.Unlock()
		go func() { time.Sleep(20 * time.Millisecond); m.neustart(nil) }()
	case strings.Contains(b, "uci commit network"): // Werkstatt-Internet an oder aus
		m.mu.Lock()
		m.gateway, m.dns = "", nil
		if x := gwMuster.FindStringSubmatch(b); x != nil {
			m.gateway = x[1]
		}
		for _, x := range dnsMuster.FindAllStringSubmatch(b, -1) {
			m.dns = append(m.dns, x[1])
		}
		m.mu.Unlock()
	case strings.Contains(b, "wget -q -O /dev/null"): // Internet prüfen
		m.mu.Lock()
		inet := "nein"
		if m.gateway != "" && len(m.dns) > 0 {
			inet = "ja"
		}
		aus("weg=%s\ninternet=%s\n", m.weg(), inet)
		m.mu.Unlock()
	case strings.Contains(b, "gateway=$(uci -q get network.lan.gateway"):
		m.mu.Lock()
		gw, dns := m.gateway, strings.Join(m.dns, " ")
		if gw == "" {
			gw = "keiner"
		}
		if dns == "" {
			dns = "keiner"
		}
		aus("gateway=%s\ndns=%s\nweg=%s\n", gw, dns, m.weg())
		m.mu.Unlock()
	case b == "passwd root":
		d, _ := io.ReadAll(ch)
		z := strings.Split(string(d), "\n")
		if len(z) < 2 || z[0] != z[1] || z[0] == "" {
			fmt.Fprintln(ch.Stderr(), "passwd: password for root is unchanged")
			return 1, false
		}
		m.mu.Lock()
		m.passwort = z[0]
		m.mu.Unlock()
		aus("Changing password for root\nNew password:\nRetype password:\npasswd: password for root changed by root\n")
	case strings.HasPrefix(b, "umask 077 && cat > /etc/dropbear/authorized_keys"):
		d, _ := io.ReadAll(ch)
		m.mu.Lock()
		m.dateien["/etc/dropbear/authorized_keys"] = d
		m.mu.Unlock()
	case b == "cat /etc/dropbear/authorized_keys":
		aus("%s", m.Datei("/etc/dropbear/authorized_keys"))
	case b == "vp-attrappe install":
		_, _ = io.Copy(io.Discard, ch)
		m.mu.Lock()
		m.edge = true
		m.mu.Unlock()
		aus("installiert\n")
	case b == "/etc/init.d/vp-edge-light restart":
		m.mu.Lock()
		m.laeuft = m.edge
		m.mu.Unlock()
	case strings.HasPrefix(b, "wget -q -O - http://127.0.0.1:8484/health"):
		m.mu.Lock()
		defer m.mu.Unlock()
		if !m.laeuft {
			return 1, false
		}
		j, _ := json.Marshal(map[string]any{"status": "UP", "ref": m.Ref, "version": m.Version})
		aus("%s\n", j)
	case b == "vp-attrappe key":
		aus("oeffentlicher Schluessel des Geraets:\n%s\nBox-Referenz: %s\n", m.WgPub, m.Ref)
	case strings.HasPrefix(b, "vp-attrappe tunnel "):
		m.mu.Lock()
		m.tunnel = strings.TrimPrefix(b, "vp-attrappe tunnel ")
		m.mu.Unlock()
		aus("eingerichtet: wg_wartung %s, Firewall-Zone service (SSH 2222, Ping), Dropbear 2222 nur Schluessel, Waechter\nWartungsserver: antwortet\n", strings.TrimPrefix(b, "vp-attrappe tunnel "))
	case b == "vp-attrappe status":
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.tunnel == "" || m.gateway == "" {
			aus("kein WireGuard aktiv\n")
			return 0, false
		}
		n := strings.Count(strings.TrimSpace(string(m.dateien["/etc/dropbear/authorized_keys"])), "\n") + 1
		aus("interface: wg_wartung\n  latest handshake: 7 seconds ago\n--- SSH 2222 ausserhalb der Tunnel: abgewiesen (nur aus wg_wartung, bisher 0 Pakete abgewiesen)\n--- Fenster-Schluessel: Abholer laeuft, Server 10.10.32.1:8022 ueber wg_wartung\n  letzte gueltige Antwort des Wartungsservers: vor 4 s\n  dauerhaft aus /etc/dropbear/authorized_keys: %d Schluessel (gelten im Tunnel weiter)\n", n)
	case strings.Contains(b, " werkstatt-anmelden ") && m.Anmelden != nil:
		zeile, _ := bufio.NewReader(io.LimitReader(ch, 256)).ReadString('\n')
		wg, host := argument(b, "--wireguard"), argument(b, "--host-schluessel")
		ausgabe, rc := m.Anmelden(strings.TrimSpace(zeile), wg, host)
		if rc == 0 {
			aus("%s\n", ausgabe)
		} else {
			fmt.Fprintln(ch.Stderr(), ausgabe)
		}
		return rc, false
	case strings.HasPrefix(b, "logread"):
		m.mu.Lock()
		for _, z := range m.logbuch {
			aus("%s\n", z)
		}
		m.mu.Unlock()
	case strings.Contains(b, "/etc/vp-edge-light/ref"):
		m.mu.Lock()
		aus("ref=%s\nlan=%s\nstart=S60vp-wartung S95vp-edge-light \n", m.Ref, m.lan)
		m.mu.Unlock()
	default:
		fmt.Fprintln(ch.Stderr(), "Attrappe kennt den Befehl nicht:", b)
		return 127, false
	}
	return 0, false
}

func (m *Mango) weg() string {
	if m.gateway == "" {
		return ""
	}
	return "default via " + m.gateway + " dev br-lan"
}

// Abziehen nimmt die Mango vom Werkstatt-Anschluss, Einstecken bringt sie zurück.
// Protokolliere schreibt eine Zeile in das Log der Box (logread).
func (m *Mango) Protokolliere(z string) { m.mu.Lock(); m.logbuch = append(m.logbuch, z); m.mu.Unlock() }

func (m *Mango) Abziehen()   { m.mu.Lock(); m.offline = true; m.mu.Unlock() }
func (m *Mango) Einstecken() { m.mu.Lock(); m.offline = false; m.mu.Unlock() }

// SetzeAdresse stellt die Mango unter eine andere Adresse (eingerichtete Box).
func (m *Mango) SetzeAdresse(a string) { m.mu.Lock(); m.adresse = a; m.mu.Unlock() }
