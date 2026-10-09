package ausgabe

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/abgleich"
)

// Für den Test über das Netz: ein "Box-Netz", in dem 127.0.0.1 eine
// gewöhnliche Adresse ist (weder Netz- noch Server-Adresse).
var (
	boxNetzLokal = netip.MustParsePrefix("126.0.0.0/7")
	lokaleBox    = netip.MustParseAddr("127.0.0.1")
)

// verbunden stellt Stelle und Schalter her, wie sie im Betrieb über den
// Kanal reden - nur ohne zweiten Prozess.
func verbunden(t *testing.T) (*Stelle, *mengeErsatz, *Schalter, *sicher) {
	t.Helper()
	s, m, log := neueStelle(t)
	hier, dort := net.Pipe()
	ctx, abbruch := context.WithCancel(context.Background())
	fertig := make(chan struct{})
	go func() {
		defer close(fertig)
		_ = s.Bediene(ctx, hier)
	}()
	schalter := NeuerSchalter(dort, boxNetz, slog.New(slog.NewTextHandler(log, nil)))
	go func() { _ = schalter.anschluss.lies() }()
	t.Cleanup(func() {
		abbruch()
		hier.Close()
		dort.Close()
		<-fertig
	})
	return s, m, schalter, log
}

func anfrage(schalter *Schalter, absender, methode, ziel string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(methode, ziel, nil)
	r.RemoteAddr = absender
	w := httptest.NewRecorder()
	schalter.ServeHTTP(w, r)
	return w
}

func TestSchalterAntwortetNurBoxAdressen(t *testing.T) {
	s, m, schalter, log := verbunden(t)
	s.SetzeStand(gueltig(t, key1, key2))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour, paar(tech2, box2): time.Hour})

	w := anfrage(schalter, "10.10.16.2:40001", http.MethodGet, "/v1/schluessel?warte=0&stand=")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") ||
		w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
	_, zeilen := zerlege(t, w.Body.Bytes())
	if len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], " t1 "+key1) {
		t.Fatalf("box1: %q", zeilen)
	}
	// Die andere Box bekommt ihren Schlüssel, nicht den der ersten.
	_, zeilen = zerlege(t, anfrage(schalter, "10.10.16.3:40002", http.MethodGet, "/v1/schluessel").Body.Bytes())
	if len(zeilen) != 1 || !strings.HasSuffix(zeilen[0], " t2 "+key2) {
		t.Fatalf("box2: %q", zeilen)
	}

	// Ein Techniker, der Server selbst, eine fremde Adresse: abgewiesen, ohne Inhalt.
	for _, absender := range []string{"10.10.32.2:5000", "10.10.32.1:5000", "10.10.16.1:5000", "192.168.178.20:5000",
		"127.0.0.1:5000", "[fd00::2]:5000", "unsinn"} {
		w := anfrage(schalter, absender, http.MethodGet, "/v1/schluessel?warte=0&stand=")
		if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "ssh-rsa") || strings.Contains(w.Body.String(), Kopf) {
			t.Errorf("%s: %d %q", absender, w.Code, w.Body.String())
		}
	}
	if !strings.Contains(log.String(), "Anfrage abgewiesen, keine Box-Adresse") {
		t.Errorf("Abweisung steht nicht im Journal:\n%s", log.String())
	}
	// Eine Zeile, nicht eine je Anfrage.
	if n := strings.Count(log.String(), "Anfrage abgewiesen"); n != 1 {
		t.Errorf("%d Zeilen für sieben Abweisungen", n)
	}
}

func TestSchalterNimmtNurDieEineAnfrageAn(t *testing.T) {
	s, _, schalter, _ := verbunden(t)
	s.SetzeStand(gueltig(t, key1))
	for name, f := range map[string]struct {
		methode, ziel string
		code          int
	}{
		"anderer Pfad":         {http.MethodGet, "/v1/alles", http.StatusNotFound},
		"Wurzel":               {http.MethodGet, "/", http.StatusNotFound},
		"POST":                 {http.MethodPost, "/v1/schluessel", http.StatusMethodNotAllowed},
		"warte keine Zahl":     {http.MethodGet, "/v1/schluessel?warte=lange", http.StatusBadRequest},
		"warte negativ":        {http.MethodGet, "/v1/schluessel?warte=-1", http.StatusBadRequest},
		"warte riesig":         {http.MethodGet, "/v1/schluessel?warte=99999999999", http.StatusBadRequest},
		"stand kein Prüfwert":  {http.MethodGet, "/v1/schluessel?stand=../../etc", http.StatusBadRequest},
		"stand mit Leerraum":   {http.MethodGet, "/v1/schluessel?stand=ab%20cd", http.StatusBadRequest},
		"stand mit Zeilenende": {http.MethodGet, "/v1/schluessel?stand=ab%0Af%201%2010.10.16.3%200%20-", http.StatusBadRequest},
		"ohne Angaben":         {http.MethodGet, "/v1/schluessel", http.StatusOK},
		"warte über der Grenze wird gekürzt, die Liste ist neu": {http.MethodGet, "/v1/schluessel?warte=100000&stand=abc", http.StatusOK},
	} {
		if w := anfrage(schalter, "10.10.16.2:40001", f.methode, f.ziel); w.Code != f.code {
			t.Errorf("%s: %d statt %d (%q)", name, w.Code, f.code, w.Body.String())
		}
	}
}

func TestSchalterOhneStelle(t *testing.T) {
	hier, dort := net.Pipe()
	schalter := NeuerSchalter(dort, boxNetz, slog.New(slog.NewTextHandler(io.Discard, nil)))
	fertig := make(chan struct{})
	go func() { _ = schalter.anschluss.lies(); close(fertig) }()
	hier.Close()
	<-fertig
	w := anfrage(schalter, "10.10.16.2:40001", http.MethodGet, "/v1/schluessel")
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), Kopf) {
		t.Fatalf("%d %q", w.Code, w.Body.String())
	}
	dort.Close()
}

// Über einen echten Lauscher: die Antwort, die eine Box mit einer einzelnen
// HTTP/1.0-Anfrage bekommt, und die Grenze je Absender.
func TestSchalterUeberDasNetz(t *testing.T) {
	s, m, schalter, _ := verbunden(t)
	// Der Test kommt von 127.0.0.1; für ihn ist das die "Box".
	schalter.BoxNetz = boxNetzLokal
	s.BoxNetz = boxNetzLokal
	g := gueltig(t, key1)
	s.SetzeStand(g)
	lokal := &stand{techniker: s.stand.techniker, boxen: map[netip.Addr]string{lokaleBox: "edge-lokal"}}
	s.stand = lokal
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, lokaleBox): time.Hour})

	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	// Der Server mit seinen echten Zeitlimits, nur die Frist für die
	// Kopfzeilen ist für den Test kurz.
	alteFrist := kopfFrist
	kopfFrist = 300 * time.Millisecond
	ctx, abbruch := context.WithCancel(context.Background())
	fertig := make(chan struct{})
	go func() {
		defer close(fertig)
		server := schalter.server()
		go func() { <-ctx.Done(); _ = server.Close() }()
		_ = server.Serve(&begrenzt{Listener: l, proAbsender: map[netip.Addr]int{}})
	}()
	defer func() { abbruch(); <-fertig; kopfFrist = alteFrist }()

	frage := func(zeile string) (status string, text string) {
		c, err := net.DialTimeout("tcp4", l.Addr().String(), 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(5 * time.Second))
		fmt.Fprintf(c, "%s\r\n\r\n", zeile)
		leser := bufio.NewReader(c)
		status, _ = leser.ReadString('\n')
		for {
			kopf, err := leser.ReadString('\n')
			if err != nil || kopf == "\r\n" {
				break
			}
		}
		rest, _ := io.ReadAll(leser)
		return strings.TrimSpace(status), string(rest)
	}
	status, text := frage("GET /v1/schluessel?warte=0&stand= HTTP/1.0")
	if !strings.Contains(status, " 200 ") {
		t.Fatalf("%q %q", status, text)
	}
	if _, zeilen := zerlege(t, []byte(text)); len(zeilen) != 1 {
		t.Fatalf("%q", text)
	}

	// Eine offen gehaltene Anfrage überlebt die Frist für die Kopfzeilen um
	// ein Vielfaches und wird am Ende der Wartezeit beantwortet.
	pwOffen, _ := zerlege(t, []byte(text))
	beginn := time.Now()
	status, text = frage("GET /v1/schluessel?warte=2&stand=" + pwOffen + " HTTP/1.0")
	if d := time.Since(beginn); !strings.Contains(status, " 200 ") || d < 1800*time.Millisecond {
		t.Fatalf("offene Anfrage: %q nach %s (%q)", status, d, text)
	}
	if _, zeilen := zerlege(t, []byte(text)); len(zeilen) != 1 {
		t.Fatalf("%q", text)
	}
	// Wer nach dem Verbinden nichts schickt, wird nach der Frist getrennt.
	stumm, err := net.DialTimeout("tcp4", l.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = stumm.SetDeadline(time.Now().Add(3 * time.Second))
	beginn = time.Now()
	if rest, err := io.ReadAll(stumm); err != nil || time.Since(beginn) > 2*time.Second || strings.Contains(string(rest), "200") {
		t.Fatalf("stumme Verbindung: %q %v nach %s", rest, err, time.Since(beginn))
	}
	stumm.Close()

	// Eine Box, die nach der Anfrage ihre Schreibseite schließt, hat die
	// Verbindung aus Sicht des Servers beendet. Sie bekommt dann keine
	// Antwort - vor allem kein leeres "200 OK", das wie eine Antwort aussähe.
	pw, _ := zerlege(t, []byte(text))
	halb, err := net.DialTimeout("tcp4", l.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_ = halb.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(halb, "GET /v1/schluessel?warte=30&stand=%s HTTP/1.0\r\n\r\n", pw)
	time.Sleep(100 * time.Millisecond)
	_ = halb.(*net.TCPConn).CloseWrite()
	if antwort, _ := io.ReadAll(halb); len(antwort) != 0 {
		t.Fatalf("nach dem Schließen der Schreibseite: %q", antwort)
	}
	halb.Close()
	time.Sleep(100 * time.Millisecond)
	s.mu.Lock()
	wartend := len(s.wartende)
	s.mu.Unlock()
	if wartend != 0 {
		t.Fatalf("%d Anfragen bleiben offen, obwohl die Box weg ist", wartend)
	}

	// Mehr als maxJeAbsender Verbindungen zugleich: die überzähligen werden
	// geschlossen, bevor der Schalter ein Byte von ihnen liest.
	var offen []net.Conn
	defer func() {
		for _, c := range offen {
			c.Close()
		}
	}()
	for i := 0; i < maxJeAbsender; i++ {
		c, err := net.DialTimeout("tcp4", l.Addr().String(), 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		offen = append(offen, c)
	}
	time.Sleep(100 * time.Millisecond)
	zuviel, err := net.DialTimeout("tcp4", l.Addr().String(), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer zuviel.Close()
	_ = zuviel.SetDeadline(time.Now().Add(3 * time.Second))
	fmt.Fprintf(zuviel, "GET /v1/schluessel HTTP/1.0\r\n\r\n")
	if antwort, _ := io.ReadAll(zuviel); len(antwort) != 0 {
		t.Fatalf("die überzählige Verbindung bekommt eine Antwort: %q", antwort)
	}
	// Wird eine frei, geht es wieder.
	offen[0].Close()
	time.Sleep(200 * time.Millisecond)
	if status, _ := frage("GET /v1/schluessel HTTP/1.0"); !strings.Contains(status, " 200 ") {
		t.Fatalf("nach dem Freiwerden: %q", status)
	}
}

// Der Kanal: die Stelle nimmt vom Schalter nur die drei Zeilenformen an und
// beendet ihn beim ersten Verstoß.
func TestKanalNimmtNurDieFesteFormAn(t *testing.T) {
	for name, zeile := range map[string]string{
		"unbekannte Zeile":            "hallo\n",
		"leere Zeile":                 "\n",
		"f mit zu wenig Feldern":      "f 1 10.10.16.2 0\n",
		"f mit zu vielen Feldern":     "f 1 10.10.16.2 0 - mehr\n",
		"Adresse außerhalb":           "f 1 10.10.32.2 0 -\n",
		"keine Adresse":               "f 1 box 0 -\n",
		"Adresse nicht in Normalform": "f 1 010.10.16.2 0 -\n",
		"IPv6":                        "f 1 ::ffff:10.10.16.2 0 -\n",
		"Wartezeit negativ":           "f 1 10.10.16.2 -1 -\n",
		"Wartezeit über der Grenze":   "f 1 10.10.16.2 301 -\n",
		"Wartezeit mit Vorzeichen":    "f 1 10.10.16.2 +5 -\n",
		"Prüfwert mit Großbuchstaben": "f 1 10.10.16.2 0 ABCDEF\n",
		"Prüfwert zu lang":            "f 1 10.10.16.2 0 " + strings.Repeat("a", 33) + "\n",
		"Nummer keine Zahl":           "f eins 10.10.16.2 0 -\n",
		"x ohne Nummer":               "x\n",
		"bereit mit Zusatz":           "bereit ja\n",
		"Zeile zu lang":               "f 1 10.10.16.2 0 " + strings.Repeat("a", 200) + "\n",
		"doppelte Leerzeichen":        "f  1 10.10.16.2 0 -\n",
	} {
		s, _, _ := neueStelle(t)
		s.SetzeStand(gueltig(t, key1))
		hier, dort := net.Pipe()
		fehler := make(chan error, 1)
		go func() { fehler <- s.Bediene(context.Background(), hier) }()
		go func() { _, _ = io.WriteString(dort, zeile) }()
		select {
		case err := <-fehler:
			if err == nil {
				t.Errorf("%s: angenommen", name)
			}
		case <-time.After(3 * time.Second):
			t.Errorf("%s: der Kanal bleibt offen", name)
		}
		hier.Close()
		dort.Close()
	}
}

func TestKanalFrageAntwortUndAbbruch(t *testing.T) {
	s, m, _ := neueStelle(t)
	s.SetzeStand(gueltig(t, key1))
	m.setze(map[abgleich.Paar]time.Duration{paar(tech1, box1): time.Hour})
	hier, dort := net.Pipe()
	defer dort.Close()
	fertig := make(chan error, 1)
	go func() { fertig <- s.Bediene(context.Background(), hier) }()
	leser := bufio.NewReader(dort)

	fmt.Fprintf(dort, "bereit\n")
	fmt.Fprintf(dort, "f 7 10.10.16.2 0 -\n")
	kopf, _ := leser.ReadString('\n')
	var nr, code, laenge int
	if _, err := fmt.Sscanf(kopf, "a %d %d %d\n", &nr, &code, &laenge); err != nil || nr != 7 || code != http.StatusOK {
		t.Fatalf("%q %v", kopf, err)
	}
	text := make([]byte, laenge)
	if _, err := io.ReadFull(leser, text); err != nil {
		t.Fatal(err)
	}
	pw, zeilen := zerlege(t, text)
	if len(zeilen) != 1 {
		t.Fatalf("%q", text)
	}
	s.mu.Lock()
	laeuft := s.laeuft
	s.mu.Unlock()
	if !laeuft {
		t.Fatal("nach `bereit` gilt der Schalter als lauschend")
	}

	// Eine offene Frage, die der Schalter zurückzieht: keine Antwort.
	fmt.Fprintf(dort, "f 8 10.10.16.2 30 %s\n", pw)
	time.Sleep(100 * time.Millisecond)
	fmt.Fprintf(dort, "x 8\n")
	time.Sleep(100 * time.Millisecond)
	s.mu.Lock()
	offen := len(s.wartende)
	s.mu.Unlock()
	if offen != 0 {
		t.Fatalf("%d offene Anfragen nach dem Zurückziehen", offen)
	}
	// Endet der Kanal, endet das Bedienen ohne Fehler, und der Schalter gilt nicht mehr als lauschend.
	dort.Close()
	if err := <-fertig; err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	laeuft = s.laeuft
	s.mu.Unlock()
	if laeuft {
		t.Fatal("ohne Kanal lauscht niemand")
	}
}
