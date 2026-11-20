// vp-wartung-gegenstelle ist ein Prüfwerkzeug: ein Wartungsserver im Kleinen,
// gegen den das Tunnel-Programm vp-wartung in einer Probe läuft
// (edge-industrie/test/wartung-probe.sh). Es kommt auf kein Gerät und ersetzt
// nicht den Tunnel-Dienst (services/tunnel-dienst).
//
// Wie der echte Server: WireGuard auf einem UDP-Port, die Server-Adresse im
// Techniker-Netz (10.10.32.1), darauf die Schlüsselausgabe nach
// docs/contracts/fernwartung-schluessel-v1.md. Von derselben Adresse aus
// meldet sich das Werkzeug auch als Techniker an der Box an. Gesteuert wird es
// über HTTP auf einer Adresse des eigenen Rechners:
//
//	/pub                                   öffentlicher WireGuard-Schlüssel des Servers
//	/box?pub=<schlüssel>&adresse=<ip>      die Box als Gegenüber eintragen; mit &endpunkt=<ip:port> meldet sich
//	                                       die Gegenstelle zuerst (wenn eine Firewall des Rechners
//	                                       eingehende Pakete verwirft)
//	/schluessel?name=<n>                   SSH-Schlüssel <n> (RSA): aus -schluessel-ordner, sonst neu erzeugt; nennt die öffentliche Zeile
//	/fenster?rest=<s>&zugang=<z>:<n>,…     die Liste der Schlüsselausgabe setzen (ohne zugang: leer)
//	/ausgabe?status=<code>                 die Schlüsselausgabe antwortet mit diesem Status (200: wieder Listen)
//	/gefragt                               wie oft die Box gefragt hat und ihr letztes "stand"
//	/handshake                             ja oder nein
//	/ssh?schluessel=<n>&befehl=<b>         als root anmelden, Befehl ausführen (&terminal=1: mit Terminal);
//	                                       mit POST ist der Rumpf die Standardeingabe und der Kopf X-Befehl
//	                                       (Base64) der Befehl: so spricht ein ssh-Ersatz für wartung.sh
//	/halte?schluessel=<n>&name=<s>         eine Sitzung öffnen, die offen bleibt; /haelt?name=<s>: ja oder nein
//	/web?pfad=<p>                          die Web-App der Box im Tunnel abrufen (Port 8484)
//	/tcp?port=<p>                          offen oder zu: ein TCP-Aufbau zur Box im Tunnel
//
// Dasselbe Programm fragt auch die Steuerung einer laufenden Gegenstelle
// (Adresse aus VP_GEGENSTELLE, Vorgabe 127.0.0.1:9000):
//
//	vp-wartung-gegenstelle frage '<pfad>?<angaben>'      gibt die Antwort aus
//	vp-wartung-gegenstelle ssh <schlüssel> '<befehl>'    wie "ssh root@box <befehl>" durch den Tunnel:
//	                                                     Standardeingabe hin, Ausgabe und Ausgang zurück
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/ssh"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type gegenstelle struct {
	dev  *device.Device
	netz *netstack.Net
	pub  string

	mu        sync.Mutex
	box       netip.Addr
	schluessl map[string]ssh.Signer
	ordner    string   // private SSH-Schlüssel der Probe (OpenSSH-Format), je Name eine Datei
	zeilen    []string // "<zugang> ssh-rsa <base64>"
	rest      int
	status    int
	geweckt   chan struct{}
	fragen    int
	stand     string
	gehalten  map[string]*ssh.Client
}

// frage ruft die Steuerung einer laufenden Gegenstelle.
func frage(methode, pfad string, kopf map[string]string, rumpf io.Reader) (string, error) {
	adresse := os.Getenv("VP_GEGENSTELLE")
	if adresse == "" {
		adresse = "127.0.0.1:9000"
	}
	req, err := http.NewRequest(methode, "http://"+adresse+pfad, rumpf)
	if err != nil {
		return "", err
	}
	for k, v := range kopf {
		req.Header.Set(k, v)
	}
	antwort, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer antwort.Body.Close()
	b, err := io.ReadAll(antwort.Body)
	if err != nil {
		return "", err
	}
	if antwort.StatusCode != http.StatusOK {
		return "", errors.New(strings.TrimSpace(string(b)))
	}
	return string(b), nil
}

// alsKunde bedient die Aufrufe "frage" und "ssh"; zurück kommt der Ausgang.
func alsKunde(args []string) int {
	switch {
	case len(args) == 2 && args[0] == "frage":
		t, err := frage(http.MethodGet, "/"+strings.TrimPrefix(args[1], "/"), nil, nil)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Print(t)
		return 0
	case len(args) == 3 && args[0] == "ssh":
		t, err := frage(http.MethodPost, "/ssh?schluessel="+args[1],
			map[string]string{"X-Befehl": base64.StdEncoding.EncodeToString([]byte(args[2]))}, os.Stdin)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 255
		}
		kopf, ausgabe, _ := strings.Cut(t, "\n---\n")
		for _, z := range strings.Split(kopf, "\n") {
			if v, ok := strings.CutPrefix(z, "ausgang="); ok {
				fmt.Print(strings.TrimSuffix(ausgabe, "\n"))
				n, _ := strconv.Atoi(v)
				return n
			}
		}
		fmt.Fprintln(os.Stderr, kopf)
		return 255
	}
	fmt.Fprintln(os.Stderr, "Aufruf: vp-wartung-gegenstelle [schalter] | frage <pfad> | ssh <schlüssel> <befehl>")
	return 2
}

func main() {
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		os.Exit(alsKunde(os.Args[1:]))
	}
	port := flag.Int("port", 51820, "UDP-Port des Wartungsservers")
	steuerung := flag.String("steuerung", "127.0.0.1:9000", "Adresse der Steuerung (HTTP)")
	adresse := flag.String("server-adresse", "10.10.32.1", "Server-Adresse im Techniker-Netz")
	sPort := flag.Int("schluessel-port", 8022, "Port der Schlüsselausgabe")
	ordner := flag.String("schluessel-ordner", "", "Ordner mit privaten SSH-Schlüsseln der Probe (je Name eine Datei)")
	flag.Parse()
	server, err := netip.ParseAddr(*adresse)
	if err != nil {
		log.Fatal(err)
	}
	roh := make([]byte, 32)
	if _, err := rand.Read(roh); err != nil {
		log.Fatal(err)
	}
	roh[0] &= 248
	roh[31] = (roh[31] & 127) | 64
	pub, err := curve25519.X25519(roh, curve25519.Basepoint)
	if err != nil {
		log.Fatal(err)
	}
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{server}, nil, 1280)
	if err != nil {
		log.Fatal(err)
	}
	g := &gegenstelle{
		netz: tnet, pub: base64.StdEncoding.EncodeToString(pub), status: http.StatusOK, ordner: *ordner,
		schluessl: map[string]ssh.Signer{}, gehalten: map[string]*ssh.Client{}, geweckt: make(chan struct{}),
	}
	g.dev = device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wireguard: "))
	if err := g.dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n", hex.EncodeToString(roh), *port)); err != nil {
		log.Fatal(err)
	}
	if err := g.dev.Up(); err != nil {
		log.Fatal(err)
	}
	ln, err := tnet.ListenTCPAddrPort(netip.AddrPortFrom(server, uint16(*sPort)))
	if err != nil {
		log.Fatal(err)
	}
	go func() { log.Fatal(http.Serve(ln, http.HandlerFunc(g.schluesselausgabe))) }()

	mux := http.NewServeMux()
	text := func(pfad string, f func(r *http.Request) (string, error)) {
		mux.HandleFunc(pfad, func(w http.ResponseWriter, r *http.Request) {
			t, err := f(r)
			if err != nil {
				http.Error(w, "FEHLER: "+err.Error(), http.StatusBadRequest)
				return
			}
			_, _ = io.WriteString(w, t+"\n")
		})
	}
	text("/pub", func(*http.Request) (string, error) { return g.pub, nil })
	text("/box", g.setzeBox)
	text("/schluessel", g.neuerSchluessel)
	text("/fenster", g.setzeFenster)
	text("/ausgabe", g.setzeStatus)
	text("/gefragt", g.gefragt)
	text("/handshake", g.handshake)
	text("/ssh", g.ssh)
	text("/halte", g.halte)
	text("/haelt", g.haelt)
	text("/web", g.web)
	text("/tcp", g.tcp)
	log.Printf("Gegenstelle: WireGuard auf UDP %d, Schlüsselausgabe %s:%d im Tunnel, Steuerung %s", *port, server, *sPort, *steuerung)
	log.Fatal(http.ListenAndServe(*steuerung, mux))
}

func (g *gegenstelle) setzeBox(r *http.Request) (string, error) {
	roh, err := base64.StdEncoding.DecodeString(r.URL.Query().Get("pub"))
	if err != nil || len(roh) != 32 {
		return "", errors.New("pub ist kein WireGuard-Schlüssel")
	}
	a, err := netip.ParseAddr(r.URL.Query().Get("adresse"))
	if err != nil {
		return "", errors.New("adresse fehlt")
	}
	cfg := fmt.Sprintf("replace_peers=true\npublic_key=%s\nallowed_ip=%s/32\n", hex.EncodeToString(roh), a)
	if ep := r.URL.Query().Get("endpunkt"); ep != "" {
		if _, err := netip.ParseAddrPort(ep); err != nil {
			return "", errors.New("endpunkt als ip:port")
		}
		cfg += "endpoint=" + ep + "\npersistent_keepalive_interval=5\n"
	}
	if err := g.dev.IpcSet(cfg); err != nil {
		return "", err
	}
	g.mu.Lock()
	g.box = a
	g.mu.Unlock()
	return "ok", nil
}

func (g *gegenstelle) signer(name string, anlegen bool) (ssh.Signer, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if s, ok := g.schluessl[name]; ok {
		return s, nil
	}
	if !anlegen || name == "" || strings.ContainsAny(name, "/.") {
		return nil, fmt.Errorf("Schlüssel %q gibt es nicht", name)
	}
	var s ssh.Signer
	if daten, err := os.ReadFile(filepath.Join(g.ordner, name)); g.ordner != "" && err == nil {
		if s, err = ssh.ParsePrivateKey(daten); err != nil {
			return nil, err
		}
	} else {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			return nil, err
		}
		if s, err = ssh.NewSignerFromKey(k); err != nil {
			return nil, err
		}
	}
	g.schluessl[name] = s
	return s, nil
}

func (g *gegenstelle) neuerSchluessel(r *http.Request) (string, error) {
	s, err := g.signer(r.URL.Query().Get("name"), true)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.PublicKey()))), nil
}

func (g *gegenstelle) wecke() {
	close(g.geweckt)
	g.geweckt = make(chan struct{})
}

func (g *gegenstelle) setzeFenster(r *http.Request) (string, error) {
	rest, _ := strconv.Atoi(r.URL.Query().Get("rest"))
	var zeilen []string
	for _, paar := range strings.Split(r.URL.Query().Get("zugang"), ",") {
		if paar == "" {
			continue
		}
		zugang, name, ok := strings.Cut(paar, ":")
		if !ok {
			return "", errors.New("zugang als <zugang>:<schlüssel>")
		}
		s, err := g.signer(name, false)
		if err != nil {
			return "", err
		}
		zeilen = append(zeilen, zugang+" ssh-rsa "+base64.StdEncoding.EncodeToString(s.PublicKey().Marshal()))
	}
	if len(zeilen) > 0 && rest < 1 {
		return "", errors.New("rest fehlt")
	}
	g.mu.Lock()
	g.zeilen, g.rest = zeilen, rest
	g.wecke()
	g.mu.Unlock()
	return "ok", nil
}

func (g *gegenstelle) setzeStatus(r *http.Request) (string, error) {
	code, err := strconv.Atoi(r.URL.Query().Get("status"))
	if err != nil {
		return "", errors.New("status fehlt")
	}
	g.mu.Lock()
	g.status = code
	g.wecke()
	g.mu.Unlock()
	return "ok", nil
}

func (g *gegenstelle) gefragt(*http.Request) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return fmt.Sprintf("fragen=%d\nstand=%s", g.fragen, g.stand), nil
}

// antwort baut die Antwort aus dem Stand (unter der Sperre). Der Prüfwert
// hängt nur an der Liste, nicht an der Restlaufzeit.
func (g *gegenstelle) antwort() (text, pruefwert string) {
	h := fnv.New64a()
	for _, z := range g.zeilen {
		_, _ = io.WriteString(h, z+"\n")
	}
	pruefwert = fmt.Sprintf("%016x", h.Sum64())
	var b strings.Builder
	b.WriteString("vp-wartung-schluessel 1 " + pruefwert + "\n")
	for _, z := range g.zeilen {
		fmt.Fprintf(&b, "schluessel %d %s\n", g.rest, z)
	}
	fmt.Fprintf(&b, "ende %d\n", len(g.zeilen))
	return b.String(), pruefwert
}

func (g *gegenstelle) schluesselausgabe(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/schluessel" {
		http.NotFound(w, r)
		return
	}
	warte, _ := strconv.Atoi(r.URL.Query().Get("warte"))
	g.mu.Lock()
	g.fragen++
	g.stand = r.URL.Query().Get("stand")
	_, pruefwert := g.antwort()
	geweckt := g.geweckt
	g.mu.Unlock()
	if g.stand == pruefwert && warte > 0 {
		select {
		case <-geweckt:
		case <-time.After(time.Duration(warte) * time.Second):
		case <-r.Context().Done():
			return
		}
	}
	g.mu.Lock()
	t, _ := g.antwort()
	status := g.status
	g.mu.Unlock()
	if status != http.StatusOK {
		http.Error(w, "keine Liste", status)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, t)
}

func (g *gegenstelle) boxAdresse() (netip.Addr, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.box.IsValid() {
		return g.box, errors.New("erst /box")
	}
	return g.box, nil
}

func (g *gegenstelle) handshake(*http.Request) (string, error) {
	s, err := g.dev.IpcGet()
	if err != nil {
		return "", err
	}
	for _, z := range strings.Split(s, "\n") {
		if v, ok := strings.CutPrefix(z, "last_handshake_time_sec="); ok && v != "0" {
			return "ja", nil
		}
	}
	return "nein", nil
}

// anmelden: als root mit dem Schlüssel name; zurück kommt auch, welchen
// Host-Schlüssel die Box gezeigt hat.
func (g *gegenstelle) anmelden(name string) (*ssh.Client, string, error) {
	s, err := g.signer(name, false)
	if err != nil {
		return nil, "", err
	}
	box, err := g.boxAdresse()
	if err != nil {
		return nil, "", err
	}
	ctx, ende := context.WithTimeout(context.Background(), 15*time.Second)
	defer ende()
	c, err := g.netz.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(box, 2222))
	if err != nil {
		return nil, "", err
	}
	host := ""
	sc, chans, reqs, err := ssh.NewClientConn(c, box.String(), &ssh.ClientConfig{
		User: "root", Auth: []ssh.AuthMethod{ssh.PublicKeys(s)}, Timeout: 15 * time.Second,
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			host = k.Type() + " " + ssh.FingerprintSHA256(k)
			return nil
		},
	})
	if err != nil {
		_ = c.Close()
		return nil, host, err
	}
	return ssh.NewClient(sc, chans, reqs), host, nil
}

func (g *gegenstelle) ssh(r *http.Request) (string, error) {
	cl, host, err := g.anmelden(r.URL.Query().Get("schluessel"))
	if err != nil {
		return "host=" + host + "\nabgewiesen=" + err.Error(), nil
	}
	defer cl.Close()
	s, err := cl.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	// Ausgabe und Fehlerausgabe in einen Puffer: zwei Schreiber, also mit Sperre.
	var aus ausgabe
	s.Stdout, s.Stderr = &aus, &aus
	befehl := r.URL.Query().Get("befehl")
	if r.Method == http.MethodPost {
		roh, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Befehl"))
		if err != nil {
			return "", errors.New("X-Befehl ist kein Base64")
		}
		befehl = string(roh)
		// Wie ssh: Endet der Befehl, endet der Aufruf, auch wenn die Eingabe
		// noch offen ist.
		ein, err := s.StdinPipe()
		if err != nil {
			return "", err
		}
		go func() {
			_, _ = io.Copy(ein, r.Body)
			_ = ein.Close()
		}()
	}
	if r.URL.Query().Get("terminal") != "" {
		if err := s.RequestPty("xterm", 24, 80, ssh.TerminalModes{}); err != nil {
			return "", fmt.Errorf("Terminal: %v", err)
		}
	}
	ausgang := 0
	if err := s.Run(befehl); err != nil {
		var ee *ssh.ExitError
		if !errors.As(err, &ee) {
			return "host=" + host + "\nabgerissen=" + err.Error() + "\n---\n" + aus.String(), nil
		}
		ausgang = ee.ExitStatus()
	}
	return fmt.Sprintf("host=%s\nausgang=%d\n---\n%s", host, ausgang, aus.String()), nil
}

// ausgabe sammelt, was ein Befehl schreibt.
type ausgabe struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (a *ausgabe) Write(p []byte) (int, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.b.Write(p)
}

func (a *ausgabe) String() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.b.String()
}

func (g *gegenstelle) halte(r *http.Request) (string, error) {
	name := r.URL.Query().Get("name")
	cl, _, err := g.anmelden(r.URL.Query().Get("schluessel"))
	if err != nil {
		return "abgewiesen=" + err.Error(), nil
	}
	s, err := cl.NewSession()
	if err != nil {
		return "", err
	}
	if _, err := s.StdinPipe(); err != nil {
		return "", err
	}
	befehl := r.URL.Query().Get("befehl")
	if befehl == "" {
		befehl = "cat"
	}
	if err := s.Start(befehl); err != nil {
		return "", err
	}
	g.mu.Lock()
	g.gehalten[name] = cl
	g.mu.Unlock()
	go func() {
		_ = cl.Wait()
		g.mu.Lock()
		if g.gehalten[name] == cl {
			delete(g.gehalten, name)
		}
		g.mu.Unlock()
	}()
	return "ok", nil
}

func (g *gegenstelle) haelt(r *http.Request) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.gehalten[r.URL.Query().Get("name")]; ok {
		return "ja", nil
	}
	return "nein", nil
}

func (g *gegenstelle) web(r *http.Request) (string, error) {
	box, err := g.boxAdresse()
	if err != nil {
		return "", err
	}
	cl := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return g.netz.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(box, 8484))
		},
	}}
	antwort, err := cl.Get("http://" + box.String() + ":8484" + r.URL.Query().Get("pfad"))
	if err != nil {
		return "zu=" + err.Error(), nil
	}
	defer antwort.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(antwort.Body, 1<<20))
	return fmt.Sprintf("status=%d\n---\n%s", antwort.StatusCode, b), nil
}

func (g *gegenstelle) tcp(r *http.Request) (string, error) {
	box, err := g.boxAdresse()
	if err != nil {
		return "", err
	}
	port, err := strconv.ParseUint(r.URL.Query().Get("port"), 10, 16)
	if err != nil {
		return "", errors.New("port fehlt")
	}
	ctx, ende := context.WithTimeout(context.Background(), 4*time.Second)
	defer ende()
	c, err := g.netz.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(box, uint16(port)))
	if err != nil {
		return "zu=" + err.Error(), nil
	}
	_ = c.Close()
	return "offen", nil
}
