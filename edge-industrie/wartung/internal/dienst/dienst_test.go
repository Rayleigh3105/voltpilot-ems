package dienst

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/ssh"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/ereignisse"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/konfig"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-industrie/wartung/internal/stand"
)

// Der Aufbau des Tests: ein echter WireGuard-Tunnel über die Schleife des
// Rechners. Die Gegenstelle ist der Wartungsserver im selben Prozess (wie
// vp-tunnel-dienst: Server-Adresse im Techniker-Netz, Schlüsselausgabe auf
// 8022); von seiner Adresse aus meldet sich der Test auch als Techniker an.
// Das Tunnel-Programm der Box läuft so, wie es auf dem Gerät läuft.
var (
	boxAdresse    = netip.MustParseAddr("10.10.16.7")
	serverAdresse = netip.MustParseAddr("10.10.32.1")
)

type aufbau struct {
	t      *testing.T
	d      *Dienst
	dev    *device.Device
	netz   *netstack.Net
	ordner string
	k      konfig.Konfig

	mu      sync.Mutex
	zeilen  []string // schluessel-Zeilen der Ausgabe, ohne Restlaufzeit
	rest    int
	status  int
	geweckt chan struct{}
	fragen  int
}

func wgPaar(t *testing.T) (priv, pub string) {
	t.Helper()
	roh := make([]byte, 32)
	if _, err := rand.Read(roh); err != nil {
		t.Fatal(err)
	}
	roh[0] &= 248
	roh[31] = (roh[31] & 127) | 64
	p, err := curve25519.X25519(roh, curve25519.Basepoint)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(roh), base64.StdEncoding.EncodeToString(p)
}

func hexVon(t *testing.T, b64 string) string {
	t.Helper()
	roh, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(roh)
}

// Schlüssel der Techniker: einmal erzeugt, jeder Aufruf gibt den nächsten
// (RSA zu erzeugen ist das Langsamste am Test).
var (
	vorratMu sync.Mutex
	vorrat   []ssh.Signer
	vergeben = map[*testing.T]int{}
)

func rsaSigner(t *testing.T) ssh.Signer {
	t.Helper()
	vorratMu.Lock()
	defer vorratMu.Unlock()
	n := vergeben[t]
	vergeben[t] = n + 1
	for len(vorrat) <= n {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		s, err := ssh.NewSignerFromKey(k)
		if err != nil {
			t.Fatal(err)
		}
		vorrat = append(vorrat, s)
	}
	return vorrat[n]
}

func b64(s ssh.Signer) string { return base64.StdEncoding.EncodeToString(s.PublicKey().Marshal()) }

type einstellung func(*konfig.Konfig, *Optionen)

func neuerAufbau(t *testing.T, anders ...einstellung) *aufbau {
	t.Helper()
	a := &aufbau{t: t, ordner: t.TempDir(), status: http.StatusOK, geweckt: make(chan struct{})}
	boxPriv, boxPub := wgPaar(t)
	srvPriv, srvPub := wgPaar(t)

	// Die Gegenstelle: Wartungsserver mit Schlüsselausgabe.
	frei, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	port := frei.LocalAddr().(*net.UDPAddr).Port
	_ = frei.Close()
	tdev, tnet, err := netstack.CreateNetTUN([]netip.Addr{serverAdresse}, nil, 1280)
	if err != nil {
		t.Fatal(err)
	}
	a.netz = tnet
	a.dev = device.NewDevice(tdev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	if err := a.dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=%s/32\n",
		hexVon(t, srvPriv), port, hexVon(t, boxPub), boxAdresse)); err != nil {
		t.Fatal(err)
	}
	if err := a.dev.Up(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.dev.Close)
	ln, err := tnet.ListenTCPAddrPort(netip.AddrPortFrom(serverAdresse, 8022))
	if err != nil {
		t.Fatal(err)
	}
	ausgabe := &http.Server{Handler: http.HandlerFunc(a.schluesselausgabe)}
	go func() { _ = ausgabe.Serve(ln) }()
	t.Cleanup(func() { _ = ausgabe.Close() })

	// Die Box.
	if err := os.WriteFile(filepath.Join(a.ordner, "wg.key"), []byte(boxPriv+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.k = konfig.Vorgaben()
	a.k.Adresse = boxAdresse
	a.k.Endpunkt = fmt.Sprintf("127.0.0.1:%d", port)
	a.k.ServerPub = srvPub
	a.k.WGSchluessel = filepath.Join(a.ordner, "wg.key")
	a.k.Hostkeys = []string{"../hostkey/testdata/dropbear_ecdsa_host_key", "../hostkey/testdata/dropbear_rsa_host_key", filepath.Join(a.ordner, "gibt-es-nicht")}
	a.k.Dauerhaft = filepath.Join(a.ordner, "authorized_keys")
	a.k.Ereignisse = filepath.Join(a.ordner, "ereignisse")
	a.k.Stand = filepath.Join(a.ordner, "stand")
	a.k.Web = false
	opt := Optionen{
		Fassung: "test", Shell: "/bin/sh", Heim: a.ordner,
		Takt: 50 * time.Millisecond, Warte: 2 * time.Second, Vorlauf: time.Second, Pause: 200 * time.Millisecond,
	}
	if testing.Verbose() {
		opt.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	for _, f := range anders {
		f(&a.k, &opt)
	}
	a.d, err = Starte(a.k, opt)
	if err != nil {
		t.Fatal(err)
	}
	ctx, ende := context.WithCancel(context.Background())
	fertig := make(chan struct{})
	go func() { _ = a.d.Laufe(ctx); close(fertig) }()
	t.Cleanup(func() {
		ende()
		select {
		case <-fertig:
		case <-time.After(10 * time.Second):
			t.Error("der Dienst endet nicht")
		}
	})
	return a
}

// schluesselausgabe verhält sich wie die des Tunnel-Dienstes: Nennt die Box
// den Prüfwert der Liste, die gerade gilt, bleibt die Anfrage offen, bis sich
// die Liste ändert oder warte um ist.
func (a *aufbau) schluesselausgabe(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/schluessel" {
		http.NotFound(w, r)
		return
	}
	var warte int
	_, _ = fmt.Sscanf(r.URL.Query().Get("warte"), "%d", &warte)
	a.mu.Lock()
	a.fragen++
	_, pruefwert := a.antwort()
	geweckt := a.geweckt
	a.mu.Unlock()
	if r.URL.Query().Get("stand") == pruefwert && warte > 0 {
		select {
		case <-geweckt:
		case <-time.After(time.Duration(warte) * time.Second):
		case <-r.Context().Done():
			return
		}
	}
	a.mu.Lock()
	text, _ := a.antwort()
	status := a.status
	a.mu.Unlock()
	if status != http.StatusOK {
		http.Error(w, "kein frischer Stand", status)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	_, _ = io.WriteString(w, text)
}

// antwort baut die Antwort aus dem Stand (unter der Sperre).
func (a *aufbau) antwort() (text, pruefwert string) {
	summe := 0
	for _, z := range a.zeilen {
		for _, c := range z {
			summe = summe*31 + int(c)
		}
	}
	pruefwert = fmt.Sprintf("%016x", uint64(summe))
	text = "vp-wartung-schluessel 1 " + pruefwert + "\n"
	for _, z := range a.zeilen {
		text += fmt.Sprintf("schluessel %d %s\n", a.rest, z)
	}
	return text + fmt.Sprintf("ende %d\n", len(a.zeilen)), pruefwert
}

// fenster setzt die Liste der Ausgabe: je Zugang ein Schlüssel, mit Restlaufzeit.
func (a *aufbau) fenster(rest int, paare ...string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.zeilen = nil
	for i := 0; i+1 < len(paare); i += 2 {
		a.zeilen = append(a.zeilen, paare[i]+" ssh-rsa "+paare[i+1])
	}
	a.rest = rest
	close(a.geweckt)
	a.geweckt = make(chan struct{})
}

func (a *aufbau) setzeStatus(code int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.status = code
	close(a.geweckt)
	a.geweckt = make(chan struct{})
}

// anmelden meldet sich als Techniker durch den Tunnel an der Box an.
func (a *aufbau) anmelden(s ssh.Signer) (*ssh.Client, string, error) {
	ctx, ende := context.WithTimeout(context.Background(), 10*time.Second)
	defer ende()
	c, err := a.netz.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(boxAdresse, PortSSH))
	if err != nil {
		return nil, "", err
	}
	host := ""
	sc, chans, reqs, err := ssh.NewClientConn(c, "box", &ssh.ClientConfig{
		User: "root", Auth: []ssh.AuthMethod{ssh.PublicKeys(s)}, Timeout: 10 * time.Second,
		HostKeyCallback: func(_ string, _ net.Addr, k ssh.PublicKey) error {
			host = k.Type() + " " + ssh.FingerprintSHA256(k)
			return nil
		},
	})
	if err != nil {
		_ = c.Close()
		return nil, host, err
	}
	cl := ssh.NewClient(sc, chans, reqs)
	a.t.Cleanup(func() { _ = cl.Close() })
	return cl, host, nil
}

// bis wartet, bis f wahr ist.
func (a *aufbau) bis(was string, f func() bool) {
	a.t.Helper()
	ende := time.Now().Add(15 * time.Second)
	for !f() {
		if time.Now().After(ende) {
			a.t.Fatalf("nicht eingetreten: %s\nEreignisse:\n%s", was, strings.Join(a.ereignisse(), "\n"))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (a *aufbau) ereignisse() []string {
	z, _ := ereignisse.Lies(a.k.Ereignisse, 0)
	return z
}

func (a *aufbau) ereignisMit(teile ...string) bool {
	for _, z := range a.ereignisse() {
		alle := true
		for _, t := range teile {
			alle = alle && strings.Contains(z, t)
		}
		if alle {
			return true
		}
	}
	return false
}

// haengend öffnet eine Sitzung, die auf ihre Eingabe wartet, und gibt einen
// Kanal, der schließt, sobald die Verbindung endet.
func haengend(t *testing.T, cl *ssh.Client) <-chan struct{} {
	t.Helper()
	s, err := cl.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	if err := s.Start("cat"); err != nil {
		t.Fatal(err)
	}
	zu := make(chan struct{})
	go func() { _ = cl.Wait(); close(zu) }()
	return zu
}

func geschlossen(c <-chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

func TestAnmeldungNurImFensterUndEndeMitDemSchluessel(t *testing.T) {
	a := neuerAufbau(t)
	anna := rsaSigner(t)

	// Kein Fenster: der Schlüssel des Technikers gilt nicht.
	a.bis("erste Antwort der Schlüsselausgabe", func() bool { _, ok, _ := a.d.abholer.Stand(); return ok })
	if _, _, err := a.anmelden(anna); err == nil || !strings.Contains(err.Error(), "unable to authenticate") {
		t.Fatalf("Anmeldung ohne Fenster: %v", err)
	}

	// Fenster offen: Die Box holt den Schlüssel ab, die Anmeldung gelingt.
	a.fenster(3600, "anna", b64(anna))
	a.bis("Fenster-Schlüssel abgeholt", func() bool { return a.ereignisMit("Fenster-Schluessel jetzt: anna") })
	cl, host, err := a.anmelden(anna)
	if err != nil {
		t.Fatalf("Anmeldung im Fenster: %v", err)
	}
	// Der Server zeigt einen Host-Schlüssel des Geräts, keinen eigenen.
	if !strings.Contains(strings.Join(a.d.HostSchluessel(), "\n"), host) || len(a.d.HostSchluessel()) != 2 {
		t.Fatalf("Host-Schlüssel %q, das Gerät hat %v", host, a.d.HostSchluessel())
	}
	// Ein Befehl mit Standardeingabe (so spricht die Durchreiche des
	// Werkstatt-Dienstes), Ausgabe, Fehlerausgabe und Ausgang kommen an.
	s, err := cl.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	var aus, fehl bytes.Buffer
	s.Stdin, s.Stdout, s.Stderr = strings.NewReader("eingabe\n"), &aus, &fehl
	err = s.Run(`echo "art=$VP_WARTUNG_SITZUNG nutzer=$USER"; echo "$SSH_CONNECTION"; cat; echo fehler >&2; exit 7`)
	var ee *ssh.ExitError
	if !asExit(err, &ee) || ee.ExitStatus() != 7 {
		t.Fatalf("Ausgang: %v", err)
	}
	if !strings.HasPrefix(aus.String(), "art=fenster nutzer=root\n"+serverAdresse.String()+" ") ||
		!strings.Contains(aus.String(), " "+boxAdresse.String()+" 2222\neingabe\n") || fehl.String() != "fehler\n" {
		t.Fatalf("Ausgabe %q, Fehlerausgabe %q", aus.String(), fehl.String())
	}
	if !a.ereignisMit("Anmeldung: Schluessel "+ssh.FingerprintSHA256(anna.PublicKey()), "Fenster-Schluessel, Zugang anna", "von "+serverAdresse.String()+":") {
		t.Fatalf("Anmeldung steht nicht in der Ereignisliste:\n%s", strings.Join(a.ereignisse(), "\n"))
	}

	// Fenster geschlossen: Mit dem Schlüssel endet die Sitzung, die mit ihm begann.
	zu := haengend(t, cl)
	if geschlossen(zu) {
		t.Fatal("die Sitzung endet schon vor dem Schließen des Fensters")
	}
	a.fenster(0)
	a.bis("Sitzung endet mit dem Schlüssel", func() bool { return geschlossen(zu) })
	a.bis("Ende in der Ereignisliste", func() bool {
		return a.ereignisMit("Sitzung beendet (Fenster-Schluessel, Zugang anna", "ihr Fenster-Schluessel ist gestrichen") &&
			a.ereignisMit("Fenster-Schluessel jetzt: keine")
	})
	if _, _, err := a.anmelden(anna); err == nil {
		t.Fatal("neue Anmeldung nach dem Ende des Fensters gelingt")
	}
	// Nie ein Schlüssel in der Ereignisliste.
	if roh, _ := os.ReadFile(a.k.Ereignisse); bytes.Contains(roh, []byte("AAAA")) {
		t.Fatalf("ein Schlüssel steht in der Ereignisliste:\n%s", roh)
	}
}

func asExit(err error, ziel **ssh.ExitError) bool {
	e, ok := err.(*ssh.ExitError)
	if ok {
		*ziel = e
	}
	return ok
}

// Ohne Server verfällt der Schlüssel zu seiner Frist, und seine Sitzung endet:
// Die Box führt die Frist selbst.
func TestFristOhneServer(t *testing.T) {
	a := neuerAufbau(t)
	anna := rsaSigner(t)
	// Sechs Sekunden: genug für die Anmeldung auch auf einem beladenen Rechner.
	const restlaufzeit = 6
	a.fenster(restlaufzeit, "anna", b64(anna))
	a.bis("Fenster-Schlüssel abgeholt", func() bool { return a.ereignisMit("Fenster-Schluessel jetzt: anna") })
	abgeholt := time.Now()
	// Ab jetzt gibt der Server keine Liste mehr aus, auch keine leere.
	a.setzeStatus(http.StatusServiceUnavailable)
	cl, _, err := a.anmelden(anna)
	if err != nil {
		t.Fatalf("Anmeldung im Fenster: %v", err)
	}
	zu := haengend(t, cl)
	a.bis("Sitzung endet zur Frist", func() bool { return geschlossen(zu) })
	if d := time.Since(abgeholt); d < (restlaufzeit-1)*time.Second || d > (restlaufzeit+4)*time.Second {
		t.Fatalf("Sitzung endete %s nach dem Abholen, die Frist war %d s", d, restlaufzeit)
	}
	if _, _, err := a.anmelden(anna); err == nil {
		t.Fatal("Anmeldung nach der Frist gelingt")
	}
	a.bis("Grund im Stand", func() bool { _, _, g := a.d.abholer.Stand(); return strings.Contains(g, "503") })
	if !a.ereignisMit("Fenster-Schluessel jetzt: keine") {
		t.Fatal("das Verfallen steht nicht in der Ereignisliste")
	}
}

// Ein im offenen Fenster ersetzter Schlüssel: Die Sitzung des bisherigen
// endet, obwohl das Fenster offen bleibt; die eines zweiten Technikers und
// die mit einem dauerhaften Schlüssel bleiben.
func TestErsetzterSchluesselUndDauerhafter(t *testing.T) {
	a := neuerAufbau(t)
	alt, neu, bert, notfall := rsaSigner(t), rsaSigner(t), rsaSigner(t), rsaSigner(t)
	if err := os.WriteFile(a.k.Dauerhaft, ssh.MarshalAuthorizedKey(notfall.PublicKey()), 0o600); err != nil {
		t.Fatal(err)
	}
	// Der dauerhafte Schlüssel gilt ohne Fenster.
	clNotfall, _, err := a.anmelden(notfall)
	if err != nil {
		t.Fatalf("dauerhafter Schlüssel: %v", err)
	}
	zuNotfall := haengend(t, clNotfall)

	a.fenster(3600, "anna", b64(alt), "bert", b64(bert))
	a.bis("Fenster-Schlüssel abgeholt", func() bool { return a.ereignisMit("Fenster-Schluessel jetzt: anna bert") })
	clAlt, _, err := a.anmelden(alt)
	if err != nil {
		t.Fatal(err)
	}
	clBert, _, err := a.anmelden(bert)
	if err != nil {
		t.Fatal(err)
	}
	zuAlt, zuBert := haengend(t, clAlt), haengend(t, clBert)
	if d, f := a.d.ssh.Sitzungen(); d != 1 || f != 2 {
		t.Fatalf("Sitzungen: dauerhaft %d, Fenster %d", d, f)
	}

	a.fenster(3600, "anna", b64(neu), "bert", b64(bert))
	a.bis("Sitzung des ersetzten Schlüssels endet", func() bool { return geschlossen(zuAlt) })
	if _, _, err := a.anmelden(alt); err == nil {
		t.Fatal("der ersetzte Schlüssel meldet sich neu an")
	}
	if _, _, err := a.anmelden(neu); err != nil {
		t.Fatalf("der neue Schlüssel: %v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if geschlossen(zuBert) || geschlossen(zuNotfall) {
		t.Fatal("eine Sitzung mit gültigem Schlüssel wurde beendet")
	}
	// Alle Fenster zu: die dauerhafte Sitzung bleibt, die übrigen enden.
	a.fenster(0)
	a.bis("Sitzung des zweiten Technikers endet", func() bool { return geschlossen(zuBert) })
	time.Sleep(300 * time.Millisecond)
	if geschlossen(zuNotfall) {
		t.Fatal("die Sitzung mit dauerhaftem Schlüssel wurde beendet")
	}
	s, err := clNotfall.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if aus, err := s.Output("echo $VP_WARTUNG_SITZUNG"); err != nil || string(aus) != "dauerhaft\n" {
		t.Fatalf("dauerhafte Sitzung: %q %v", aus, err)
	}
	if !a.ereignisMit("Anmeldung: Schluessel "+ssh.FingerprintSHA256(notfall.PublicKey()), "dauerhafter Schluessel") {
		t.Fatal("Anmeldung mit dauerhaftem Schlüssel steht nicht in der Ereignisliste")
	}
}

// Die Web-App der Box im Tunnel, und eine Weiterleitung (ssh -L).
func TestWebAppUndWeiterleitung(t *testing.T) {
	web, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "web-app der box") })}
	go func() { _ = srv.Serve(web) }()
	t.Cleanup(func() { _ = srv.Close() })
	a := neuerAufbau(t, func(k *konfig.Konfig, _ *Optionen) { k.Web, k.WebZiel = true, web.Addr().String() })

	lies := func(dial func(ctx context.Context, netz, adr string) (net.Conn, error), url string) string {
		t.Helper()
		cl := &http.Client{Transport: &http.Transport{DialContext: dial, DisableKeepAlives: true}, Timeout: 10 * time.Second}
		r, err := cl.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		return string(b)
	}
	// Durch den Tunnel, ohne Anmeldung: http://<Box-Adresse>:8484
	ueberTunnel := func(ctx context.Context, _, _ string) (net.Conn, error) {
		return a.netz.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(boxAdresse, PortWeb))
	}
	if got := lies(ueberTunnel, "http://box/"); got != "web-app der box" {
		t.Fatalf("Web-App im Tunnel: %q", got)
	}
	// Mit Anmeldung: ssh -L 8484:127.0.0.1:8484
	notfall := rsaSigner(t)
	if err := os.WriteFile(a.k.Dauerhaft, ssh.MarshalAuthorizedKey(notfall.PublicKey()), 0o600); err != nil {
		t.Fatal(err)
	}
	cl, _, err := a.anmelden(notfall)
	if err != nil {
		t.Fatal(err)
	}
	ueberSSH := func(_ context.Context, _, _ string) (net.Conn, error) { return cl.Dial("tcp", web.Addr().String()) }
	if got := lies(ueberSSH, "http://box/"); got != "web-app der box" {
		t.Fatalf("Web-App über die Weiterleitung: %q", got)
	}
	// Ein Ziel, an dem niemand lauscht, wird abgewiesen, die Verbindung bleibt.
	if _, err := cl.Dial("tcp", "127.0.0.1:1"); err == nil {
		t.Fatal("Weiterleitung ins Leere gelingt")
	}
	if s, err := cl.NewSession(); err != nil {
		t.Fatal(err)
	} else if aus, err := s.Output("echo da"); err != nil || string(aus) != "da\n" {
		t.Fatalf("%q %v", aus, err)
	}
}

// Ohne die Einstellung web lauscht im Tunnel nichts auf 8484.
func TestWebAppZu(t *testing.T) {
	a := neuerAufbau(t)
	a.bis("Tunnel steht", func() bool { _, ok, _ := a.d.abholer.Stand(); return ok })
	ctx, ende := context.WithTimeout(context.Background(), 3*time.Second)
	defer ende()
	if c, err := a.netz.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(boxAdresse, PortWeb)); err == nil {
		_ = c.Close()
		t.Fatal("8484 ist im Tunnel offen, obwohl web = zu")
	}
}

// Antwortet die Gegenseite nicht mehr (der Wartungsserver hat den Weg
// getrennt), endet die Sitzung nach drei Lebenszeichen ohne Antwort.
func TestLebenszeichen(t *testing.T) {
	a := neuerAufbau(t, func(_ *konfig.Konfig, o *Optionen) { o.Lebenszeichen = 300 * time.Millisecond })
	notfall := rsaSigner(t)
	if err := os.WriteFile(a.k.Dauerhaft, ssh.MarshalAuthorizedKey(notfall.PublicKey()), 0o600); err != nil {
		t.Fatal(err)
	}
	cl, _, err := a.anmelden(notfall)
	if err != nil {
		t.Fatal(err)
	}
	haengend(t, cl)
	// Solange die Gegenseite antwortet, bleibt die Sitzung.
	time.Sleep(2 * time.Second)
	if d, _ := a.d.ssh.Sitzungen(); d != 1 {
		t.Fatal("die Sitzung endet, obwohl die Gegenseite antwortet")
	}
	// Der Weg ist weg: Es kommt nichts mehr an, auch kein Ende.
	if err := a.dev.Down(); err != nil {
		t.Fatal(err)
	}
	a.bis("Sitzung endet ohne Lebenszeichen", func() bool { d, _ := a.d.ssh.Sitzungen(); return d == 0 })
	a.bis("Grund in der Ereignisliste", func() bool { return a.ereignisMit("Sitzung beendet (dauerhafter Schluessel", "Lebenszeichen") })
}

// Der Stand für "status": was gilt, ohne einen Schlüssel; weg mit dem Dienst.
func TestStandDatei(t *testing.T) {
	a := neuerAufbau(t)
	anna := rsaSigner(t)
	a.fenster(3600, "anna", b64(anna))
	a.bis("Stand nennt das Fenster", func() bool {
		s, err := stand.Lies(a.k.Stand)
		return err == nil && len(s.Fenster) == 1 && s.Handshake >= 0 && s.Antwort >= 0
	})
	s, err := stand.Lies(a.k.Stand)
	if err != nil {
		t.Fatal(err)
	}
	if s.Fenster[0].Zugang != "anna" || s.Fenster[0].Rest < 3590 || s.Fenster[0].Rest > 3600 {
		t.Fatalf("Fenster im Stand: %+v", s.Fenster)
	}
	if s.Adresse != boxAdresse.String() || s.PID != os.Getpid() || s.Fassung != "test" || len(s.Hostkeys) != 2 ||
		s.Server != "10.10.32.1:8022" || s.Web != "zu" || s.EndpunktIP != a.k.Endpunkt || s.Laufzeit <= 0 {
		t.Fatalf("Stand: %+v", s)
	}
	roh, _ := os.ReadFile(a.k.Stand)
	if bytes.Contains(roh, []byte("AAAA")) {
		t.Fatalf("ein Schlüssel steht im Stand: %s", roh)
	}
	if st, _ := os.Stat(a.k.Stand); st.Mode().Perm() != 0o600 {
		t.Fatalf("Rechte des Stands: %v", st.Mode().Perm())
	}
}

// Ohne Schlüssel der Box, mit einem für andere lesbaren Schlüssel oder ohne
// Host-Schlüssel des Geräts startet das Programm nicht.
func TestStartetNichtOhneSchluessel(t *testing.T) {
	dir := t.TempDir()
	_, pub := wgPaar(t)
	priv, _ := wgPaar(t)
	k := konfig.Vorgaben()
	k.Adresse, k.ServerPub = boxAdresse, pub
	k.WGSchluessel = filepath.Join(dir, "wg.key")
	k.Hostkeys = []string{"../hostkey/testdata/dropbear_rsa_host_key"}
	k.Stand, k.Ereignisse, k.Dauerhaft = filepath.Join(dir, "stand"), filepath.Join(dir, "e"), filepath.Join(dir, "a")
	if _, err := Starte(k, Optionen{}); err == nil || !strings.Contains(err.Error(), "vp-wartung schluessel") {
		t.Fatalf("ohne Schlüssel der Box: %v", err)
	}
	if err := os.WriteFile(k.WGSchluessel, []byte(priv+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Starte(k, Optionen{}); err == nil || !strings.Contains(err.Error(), "für andere lesbar") {
		t.Fatalf("lesbarer Schlüssel: %v", err)
	}
	if err := os.Chmod(k.WGSchluessel, 0o600); err != nil {
		t.Fatal(err)
	}
	k.Hostkeys = []string{filepath.Join(dir, "fehlt")}
	if _, err := Starte(k, Optionen{}); err == nil || !strings.Contains(err.Error(), "kein Host-Schlüssel") {
		t.Fatalf("ohne Host-Schlüssel: %v", err)
	}
	// Die Meldung nennt den privaten Schlüssel nie.
	k.Hostkeys = []string{"../hostkey/testdata/dropbear_rsa_host_key"}
	k.ServerPub = "kein-schluessel"
	if _, err := Starte(k, Optionen{}); err == nil || strings.Contains(err.Error(), priv) {
		t.Fatalf("falscher Server-Schlüssel: %v", err)
	}
}

// Eine Shell am Terminal, und endet die Verbindung, legt das Terminal auf:
// Was darin läuft, bekommt SIGHUP (nur unter Linux, wie auf der Box).
func TestTerminal(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("ein Terminal gibt es nur unter Linux")
	}
	a := neuerAufbau(t)
	notfall := rsaSigner(t)
	if err := os.WriteFile(a.k.Dauerhaft, ssh.MarshalAuthorizedKey(notfall.PublicKey()), 0o600); err != nil {
		t.Fatal(err)
	}
	cl, _, err := a.anmelden(notfall)
	if err != nil {
		t.Fatal(err)
	}
	s, err := cl.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RequestPty("xterm", 40, 120, ssh.TerminalModes{}); err != nil {
		t.Fatalf("Terminal: %v", err)
	}
	ein, _ := s.StdinPipe()
	var aus sicher
	s.Stdout = &aus
	if err := s.Shell(); err != nil {
		t.Fatal(err)
	}
	// Im Terminal läuft danach ein Programm, das von selbst nicht endet und
	// seine Eingabe nie liest: Nur SIGHUP beendet es.
	pidDatei := filepath.Join(a.ordner, "pid")
	fmt.Fprintf(ein, "tty; stty size; echo term=$TERM; echo $$ > %s; exec sleep 300\n", pidDatei)
	a.bis("Ausgabe der Shell", func() bool {
		t := aus.String()
		return strings.Contains(t, "/dev/pts/") && strings.Contains(t, "40 120") && strings.Contains(t, "term=xterm")
	})
	var pid string
	a.bis("das Programm im Terminal läuft", func() bool {
		b, _ := os.ReadFile(pidDatei)
		pid = strings.TrimSpace(string(b))
		if pid == "" {
			return false
		}
		// Unter Emulation (ARMv7-Test auf einem anderen Rechner) steht der
		// Emulator vor dem Programm in der Befehlszeile.
		zeile, _ := os.ReadFile("/proc/" + pid + "/cmdline")
		return strings.Contains(string(zeile), "sleep")
	})
	// Die Verbindung endet: Das Terminal legt auf, das Programm bekommt SIGHUP.
	_ = cl.Close()
	a.bis("SIGHUP beendet das Programm im Terminal", func() bool {
		_, err := os.Stat("/proc/" + pid)
		return os.IsNotExist(err)
	})
}

type sicher struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *sicher) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *sicher) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// Ping im Tunnel beantwortet die Box, wie die Mango (Regel Allow-Service-Ping).
func TestPing(t *testing.T) {
	a := neuerAufbau(t)
	pc, err := a.netz.DialPingAddr(serverAdresse, boxAdresse)
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	// ICMP Echo Request: Typ 8, Kennung 0x5650, Folge 1, mit Prüfsumme.
	frage := []byte{8, 0, 0, 0, 0x56, 0x50, 0, 1, 'v', 'p'}
	var summe uint32
	for i := 0; i < len(frage); i += 2 {
		summe += uint32(frage[i])<<8 | uint32(frage[i+1])
	}
	summe = ^(summe&0xffff + summe>>16) & 0xffff
	frage[2], frage[3] = byte(summe>>8), byte(summe)
	_ = pc.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := pc.Write(frage); err != nil {
		t.Fatal(err)
	}
	antwort := make([]byte, 64)
	n, err := pc.Read(antwort)
	if err != nil {
		t.Fatalf("keine Antwort auf Ping: %v", err)
	}
	if n < 10 || antwort[0] != 0 || !bytes.Equal(antwort[8:n], []byte("vp")) {
		t.Fatalf("Antwort auf Ping: % x", antwort[:n])
	}
}
