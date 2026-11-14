package web

// Tests der Einrichtungsseite (einrichtung.go): Kennung mit Sperre, Sitzung,
// die Skript-Aufrufe (verbinden im Hintergrund, Passwort nur auf stdin) und
// die Schranke, die dem Einrichtungs-WLAN nur die Einrichtungsseite zeigt.
// Das Ende-zu-Ende gegen das echte Netz-Skript auf echtem OpenWrt liegt im
// Labor (edge-light/test/wlan-anschluss-probe.sh, Lauf einrichtung-weg).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

const testKennung = "edge-wrk7abg"

// testEinrichtung baut eine Einrichtung mit vorhandenem (leerem) Skript und
// stellbarer Uhr.
func testEinrichtung(t *testing.T) (*Einrichtung, *time.Time) {
	t.Helper()
	skript := filepath.Join(t.TempDir(), "wlan-anschluss.sh")
	if err := os.WriteFile(skript, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	e := NewEinrichtung(testKennung, skript, "10.213.1.1")
	now := time.Now()
	e.jetzt = func() time.Time { return now }
	return e, &now
}

func einrichtungServer(t *testing.T, e *Einrichtung) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(Handler(state.New("edge-wrk7abg", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{},
		&fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}, e))
	t.Cleanup(srv.Close)
	return srv
}

func postJSON(t *testing.T, client *http.Client, url, body string) (*http.Response, map[string]any) {
	t.Helper()
	resp, err := client.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp, m
}

// anmelden liefert einen Client mit gueltiger Sitzung.
func anmelden(t *testing.T, srv *httptest.Server) *http.Client {
	t.Helper()
	client := srv.Client()
	resp, m := postJSON(t, client, srv.URL+"/api/einrichtung/anmeldung",
		fmt.Sprintf(`{"kennung":%q}`, "EDGE-WRK7ABG"))
	if resp.StatusCode != 200 || m["angemeldet"] != true {
		t.Fatalf("Anmeldung: Status %d, Antwort %v", resp.StatusCode, m)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == "vp_einricht" {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("Anmeldung ohne Sitzungs-Cookie")
	}
	return &http.Client{Transport: cookieTransport{cookie: cookie, basis: http.DefaultTransport}}
}

type cookieTransport struct {
	cookie *http.Cookie
	basis  http.RoundTripper
}

func (c cookieTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r.AddCookie(c.cookie)
	return c.basis.RoundTrip(r)
}

func TestEinrichtungKennungNormalisieren(t *testing.T) {
	for eingabe, soll := range map[string]string{
		"EDGE-WRK7ABG":   "edgewrk7abg",
		"edge-wrk7abg":   "edgewrk7abg",
		" edge wrk7abg ": "edgewrk7abg",
		"edge_wrk7abg":   "edgewrk7abg",
	} {
		if ist := kennungNormalisieren(eingabe); ist != soll {
			t.Errorf("kennungNormalisieren(%q) = %q, soll %q", eingabe, ist, soll)
		}
	}
}

// Jede Schreibweise der richtigen Kennung meldet an; eine falsche nicht, und
// die Antwort verraet die Kennung nicht.
func TestEinrichtungAnmeldung(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)

	resp, m := postJSON(t, srv.Client(), srv.URL+"/api/einrichtung/anmeldung", `{"kennung":"EDGE-FALSCH1"}`)
	if resp.StatusCode != 403 {
		t.Fatalf("falsche Kennung: Status %d, soll 403", resp.StatusCode)
	}
	if s, _ := json.Marshal(m); strings.Contains(strings.ToLower(string(s)), "wrk7abg") {
		t.Fatalf("die Antwort nennt die Kennung der Box: %s", s)
	}
	if m["versuche_frei"] != float64(4) {
		t.Fatalf("versuche_frei = %v, soll 4", m["versuche_frei"])
	}
	anmelden(t, srv) // "EDGE-WRK7ABG" in Grossschreibung
}

// Fuenf Fehlversuche, dann fuenf Minuten Pause - auch fuer die richtige
// Kennung; nach der Pause geht es wieder.
func TestEinrichtungAnmeldungSperrtNachFuenfVersuchen(t *testing.T) {
	e, now := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	client := srv.Client()

	for i := 0; i < 4; i++ {
		resp, _ := postJSON(t, client, srv.URL+"/api/einrichtung/anmeldung", `{"kennung":"edge-falsch1"}`)
		if resp.StatusCode != 403 {
			t.Fatalf("Versuch %d: Status %d, soll 403", i+1, resp.StatusCode)
		}
	}
	resp, m := postJSON(t, client, srv.URL+"/api/einrichtung/anmeldung", `{"kennung":"edge-falsch1"}`)
	if resp.StatusCode != 429 || m["gesperrt_s"] == nil {
		t.Fatalf("fuenfter Versuch: Status %d, Antwort %v - soll 429 mit gesperrt_s", resp.StatusCode, m)
	}
	resp, _ = postJSON(t, client, srv.URL+"/api/einrichtung/anmeldung", fmt.Sprintf(`{"kennung":%q}`, testKennung))
	if resp.StatusCode != 429 {
		t.Fatalf("waehrend der Pause: Status %d, soll 429 auch fuer die richtige Kennung", resp.StatusCode)
	}
	var st map[string]any
	g, err := client.Get(srv.URL + "/api/einrichtung/anmeldung")
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewDecoder(g.Body).Decode(&st)
	g.Body.Close()
	if st["gesperrt_s"] == nil || st["gesperrt_s"].(float64) <= 0 {
		t.Fatalf("Anmeldestand nennt die Sperre nicht: %v", st)
	}

	*now = now.Add(einrichtungPause + time.Second)
	anmelden(t, srv)
}

// Ohne Sitzung gibt es keinen Skript-Aufruf, aus keinem Netz.
func TestEinrichtungSkriptaufrufeVerlangenDieKennung(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	e.ausfuehren = func(context.Context, string, ...string) (string, int, error) {
		t.Fatal("Skript-Aufruf ohne Anmeldung")
		return "", 0, nil
	}
	for _, f := range []func() (*http.Response, error){
		func() (*http.Response, error) { return srv.Client().Get(srv.URL + "/api/einrichtung/netze") },
		func() (*http.Response, error) { return srv.Client().Get(srv.URL + "/api/einrichtung/status") },
		func() (*http.Response, error) {
			return srv.Client().Post(srv.URL+"/api/einrichtung/verbinden", "application/json", strings.NewReader(`{"ssid":"x"}`))
		},
		func() (*http.Response, error) {
			return srv.Client().Post(srv.URL+"/api/einrichtung/kabel", "application/json", strings.NewReader(`{}`))
		},
	} {
		resp, err := f()
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("ohne Anmeldung: Status %d, soll 401", resp.StatusCode)
		}
	}
}

func TestEinrichtungNetzeAusDerScanAusgabe(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	e.ausfuehren = func(_ context.Context, _ string, arg ...string) (string, int, error) {
		if len(arg) != 1 || arg[0] != "scan" {
			t.Fatalf("unerwarteter Aufruf %v", arg)
		}
		return "signal=-42 kanal=6 verschluesselung=psk2 ssid=Kunde WLAN 5\n" +
			"signal=-55 kanal=11 verschluesselung=sae ssid=Gastnetz\n" +
			"signal=-70 kanal=1 verschluesselung=nicht_unterstuetzt ssid=Firma\n", 0, nil
	}
	client := anmelden(t, srv)
	resp, err := client.Get(srv.URL + "/api/einrichtung/netze")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m struct {
		Netze []map[string]any `json:"netze"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	if len(m.Netze) != 3 {
		t.Fatalf("Netze: %d, soll 3", len(m.Netze))
	}
	if m.Netze[0]["ssid"] != "Kunde WLAN 5" || m.Netze[0]["geeignet"] != true {
		t.Fatalf("erstes Netz falsch: %v (der Name traegt Leerzeichen)", m.Netze[0])
	}
	if h, _ := m.Netze[1]["hinweis"].(string); !strings.Contains(h, "Gäste-WLAN") {
		t.Fatalf("Gastnetz ohne Hinweis: %v", m.Netze[1])
	}
	if m.Netze[2]["geeignet"] != false {
		t.Fatalf("nicht_unterstuetzt bleibt waehlbar: %v", m.Netze[2])
	}
}

// verbinden laeuft im Hintergrund weiter, auch wenn das Handy das
// Einrichtungs-WLAN waehrend der Pruefung verliert; ein zweiter Start wird
// abgewiesen, und das Passwort geht NUR ueber stdin.
func TestEinrichtungVerbindenLaeuftImHintergrund(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	weiter := make(chan struct{})
	var mu sync.Mutex
	var stdinGesehen string
	e.ausfuehren = func(_ context.Context, stdin string, arg ...string) (string, int, error) {
		mu.Lock()
		stdinGesehen = stdin
		mu.Unlock()
		if len(arg) != 2 || arg[0] != "verbinden" || arg[1] != "Kunde-WLAN" {
			t.Errorf("unerwarteter Aufruf %v", arg)
		}
		for _, a := range arg {
			if strings.Contains(a, "geheim") {
				t.Errorf("Passwort in den Argumenten: %v", arg)
			}
		}
		<-weiter
		return "ergebnis=verbunden\nsignal=-48\nschwelle=-70\nurteil=reicht\nwlan_adresse=192.168.178.119\n", 0, nil
	}
	client := anmelden(t, srv)

	resp, _ := postJSON(t, client, srv.URL+"/api/einrichtung/verbinden", `{"ssid":"Kunde-WLAN","passwort":"geheim123"}`)
	if resp.StatusCode != 202 {
		t.Fatalf("Start: Status %d, soll 202", resp.StatusCode)
	}
	resp, _ = postJSON(t, client, srv.URL+"/api/einrichtung/verbinden", `{"ssid":"Kunde-WLAN","passwort":"geheim123"}`)
	if resp.StatusCode != 409 {
		t.Fatalf("zweiter Start: Status %d, soll 409", resp.StatusCode)
	}
	g, err := client.Get(srv.URL + "/api/einrichtung/verbinden")
	if err != nil {
		t.Fatal(err)
	}
	var lauf map[string]any
	_ = json.NewDecoder(g.Body).Decode(&lauf)
	g.Body.Close()
	if lauf["laeuft"] != true {
		t.Fatalf("laeuft = %v, soll true", lauf["laeuft"])
	}
	close(weiter)
	var fertig map[string]any
	for i := 0; i < 100; i++ {
		g, err = client.Get(srv.URL + "/api/einrichtung/verbinden")
		if err != nil {
			t.Fatal(err)
		}
		fertig = nil
		_ = json.NewDecoder(g.Body).Decode(&fertig)
		g.Body.Close()
		if fertig["laeuft"] == false {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if fertig["laeuft"] != false || fertig["rc"] != float64(0) {
		t.Fatalf("Ergebnis: %v", fertig)
	}
	felder := fertig["felder"].(map[string]any)
	if felder["urteil"] != "reicht" || felder["signal"] != "-48" {
		t.Fatalf("Felder: %v", felder)
	}
	mu.Lock()
	defer mu.Unlock()
	if stdinGesehen != "geheim123\n" {
		t.Fatalf("stdin = %q, soll das Passwort mit Zeilenende sein", stdinGesehen)
	}
}

// Einmal gegen ein echtes Skript: stdin kommt an, die Argumente tragen das
// Passwort nicht, die Ausgabe wird gelesen.
func TestEinrichtungVerbindenRuftDasSkript(t *testing.T) {
	dir := t.TempDir()
	skript := filepath.Join(dir, "wlan-anschluss.sh")
	mitschrift := filepath.Join(dir, "mitschrift")
	inhalt := "#!/bin/sh\nIFS= read -r pass\nprintf '%s|%s\\n' \"$*\" \"$pass\" > " + mitschrift + "\necho ergebnis=verbunden\necho urteil=reicht\nexit 0\n"
	if err := os.WriteFile(skript, []byte(inhalt), 0o755); err != nil {
		t.Fatal(err)
	}
	e := NewEinrichtung(testKennung, skript, "")
	srv := einrichtungServer(t, e)
	client := anmelden(t, srv)
	resp, _ := postJSON(t, client, srv.URL+"/api/einrichtung/verbinden", `{"ssid":"Kunde-WLAN","passwort":"geheim123"}`)
	if resp.StatusCode != 202 {
		t.Fatalf("Start: Status %d", resp.StatusCode)
	}
	var fertig map[string]any
	for i := 0; i < 200; i++ {
		g, err := client.Get(srv.URL + "/api/einrichtung/verbinden")
		if err != nil {
			t.Fatal(err)
		}
		fertig = nil
		_ = json.NewDecoder(g.Body).Decode(&fertig)
		g.Body.Close()
		if fertig["laeuft"] == false {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if fertig["laeuft"] != false || fertig["rc"] != float64(0) {
		t.Fatalf("Ergebnis: %v", fertig)
	}
	roh, err := os.ReadFile(mitschrift)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(roh)); got != "verbinden Kunde-WLAN|geheim123" {
		t.Fatalf("Skript sah %q", got)
	}
}

func TestEinrichtungKabelReichtDieRueckgabeDurch(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	e.ausfuehren = func(_ context.Context, _ string, arg ...string) (string, int, error) {
		if len(arg) != 1 || arg[0] != "kabel" {
			t.Fatalf("unerwarteter Aufruf %v (ohne_kabel darf nur auf Wunsch dazukommen)", arg)
		}
		return "ergebnis=kein_kabel\nmeldung=an WAN kommt keine Verbindung an; erst das Kabel stecken (oder --ohne-kabel)\n", 7, nil
	}
	client := anmelden(t, srv)
	resp, m := postJSON(t, client, srv.URL+"/api/einrichtung/kabel", `{}`)
	if resp.StatusCode != 200 || m["rc"] != float64(7) {
		t.Fatalf("Status %d, Antwort %v - soll 200 mit rc=7", resp.StatusCode, m)
	}
	felder := m["felder"].(map[string]any)
	if !strings.Contains(felder["meldung"].(string), "Kabel") {
		t.Fatalf("Meldung fehlt: %v", felder)
	}
}

// Ohne das Netz-Skript (Docker-Box) sagt die Seite das, statt ins Leere zu
// laufen; die Kennung selbst funktioniert weiter.
func TestEinrichtungOhneSkriptNichtVerfuegbar(t *testing.T) {
	e := NewEinrichtung(testKennung, filepath.Join(t.TempDir(), "gibt-es-nicht.sh"), "")
	srv := einrichtungServer(t, e)
	g, err := srv.Client().Get(srv.URL + "/api/einrichtung/anmeldung")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.NewDecoder(g.Body).Decode(&m)
	g.Body.Close()
	if m["verfuegbar"] != false {
		t.Fatalf("verfuegbar = %v, soll false", m["verfuegbar"])
	}
	client := anmelden(t, srv)
	resp, err := client.Get(srv.URL + "/api/einrichtung/netze")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("netze ohne Skript: Status %d, soll 404", resp.StatusCode)
	}
}

// Aendernde Aufrufe nur als JSON: ein Formular-POST einer fremden Seite im
// selben Browser traegt den Inhaltstyp nicht und bleibt draussen.
func TestEinrichtungVerlangtJSON(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	resp, err := srv.Client().Post(srv.URL+"/api/einrichtung/anmeldung",
		"application/x-www-form-urlencoded", strings.NewReader("kennung=edge-wrk7abg"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 415 {
		t.Fatalf("Formular-POST: Status %d, soll 415", resp.StatusCode)
	}
}

// Die Schranke: unter der Einrichtungs-Adresse gibt es nur die
// Einrichtungsseite und ihre API; jede andere GET-Anfrage (auch die
// Anmelde-Erkennung eines Handys mit fremdem Host) landet auf der Seite.
// Unter jeder anderen Adresse bleibt die Web-App, wie sie ist.
func TestEinrichtungSchranke(t *testing.T) {
	e, _ := testEinrichtung(t)
	h := Handler(state.New("edge-wrk7abg", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{},
		&fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}, e)
	geschrankt := e.Schranke(h, h)

	anfrage := func(adresse, methode, pfad string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(methode, pfad, nil)
		if adresse != "" {
			lokal := &net.TCPAddr{IP: net.ParseIP(adresse), Port: 8484}
			r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, net.Addr(lokal)))
		}
		w := httptest.NewRecorder()
		geschrankt.ServeHTTP(w, r)
		return w
	}

	// Im Einrichtungs-WLAN: nur die Seite und ihre API.
	if w := anfrage("10.213.1.1", "GET", "/einrichtung.html"); w.Code != 200 {
		t.Fatalf("einrichtung.html: %d", w.Code)
	}
	if w := anfrage("10.213.1.1", "GET", "/api/einrichtung/anmeldung"); w.Code != 200 {
		t.Fatalf("anmeldung: %d", w.Code)
	}
	for _, pfad := range []string{"/api/state", "/einrichten.html", "/index.html", "/", "/health", "/hotspot-detect.html"} {
		w := anfrage("10.213.1.1", "GET", pfad)
		if w.Code != 302 || w.Header().Get("Location") != "/einrichtung.html" {
			t.Fatalf("GET %s im Einrichtungs-WLAN: %d %s, soll 302 auf die Seite", pfad, w.Code, w.Header().Get("Location"))
		}
	}
	if w := anfrage("10.213.1.1", "POST", "/api/inverter"); w.Code != 403 {
		t.Fatalf("POST /api/inverter im Einrichtungs-WLAN: %d, soll 403", w.Code)
	}

	// Am Kabel der Box (jede andere Adresse): alles wie heute.
	if w := anfrage("10.213.0.1", "GET", "/api/state"); w.Code != 200 {
		t.Fatalf("api/state am Kabel: %d", w.Code)
	}
	if w := anfrage("", "GET", "/api/state"); w.Code != 200 {
		t.Fatalf("api/state ohne lokale Adresse: %d", w.Code)
	}
}

// Die Seite der Box zeigt die Kennung vor der Eingabe nirgends - auch nicht
// in den offenen Antworten der Einrichtungs-API.
func TestEinrichtungNenntDieKennungNicht(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	for _, pfad := range []string{"/einrichtung.html", "/einrichtung.js", "/api/einrichtung/anmeldung"} {
		resp, err := srv.Client().Get(srv.URL + pfad)
		if err != nil {
			t.Fatal(err)
		}
		roh, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(strings.ToLower(string(roh)), "wrk7abg") {
			t.Fatalf("%s nennt die Kennung", pfad)
		}
	}
}

// Die Seite traegt die Bildschirme des Konzepts (0.1, 2W' bis 6W”).
func TestEinrichtungSeiteTraegtDieSchritte(t *testing.T) {
	e, _ := testEinrichtung(t)
	srv := einrichtungServer(t, e)
	resp, err := srv.Client().Get(srv.URL + "/einrichtung.html")
	if err != nil {
		t.Fatal(err)
	}
	roh, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	seite := string(roh)
	for _, soll := range []string{
		`id="sAnmeldung"`, `id="sWeg"`, `id="sPasswort"`, `id="sPruefen"`, `id="sErgebnis"`, `id="sFertig"`,
		"Diese Box einrichten", "Internet für Ihre Box", "Empfang prüfen", "2,4-GHz-Band",
		"-70 reicht", "einrichtung.js",
	} {
		if !strings.Contains(seite, soll) {
			t.Fatalf("einrichtung.html ohne %q", soll)
		}
	}
}
