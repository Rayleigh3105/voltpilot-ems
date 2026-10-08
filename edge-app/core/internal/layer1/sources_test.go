package layer1

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// fakeGoe answers /api/status like a go-e Charger (HTTP API v2).
type fakeGoe struct {
	srv *httptest.Server

	mu     sync.Mutex
	status int
	body   string
	delay  time.Duration
	hits   int
	query  string
}

func newFakeGoe(t *testing.T) *fakeGoe {
	t.Helper()
	g := &fakeGoe{status: 200, body: goeCharging}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		g.mu.Lock()
		status, body, delay := g.status, g.body, g.delay
		g.hits++
		g.query = req.URL.Path + "?" + req.URL.RawQuery
		g.mu.Unlock()
		if delay > 0 {
			time.Sleep(delay)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGoe) set(status int, body string) {
	g.mu.Lock()
	g.status, g.body = status, body
	g.mu.Unlock()
}

func (g *fakeGoe) hostPort() (string, string) {
	h, p, _ := net.SplitHostPort(g.srv.Listener.Addr().String())
	return h, p
}

const goeCharging = `{"car":2,"alw":true,"amp":16,"wh":5321.4,"nrg":[232.1,231.8,232.5,0,16,16.1,15.9,3680,3700,3660,0,11040,99.9,99.8,99.7,0]}`
const goeIdleZero = `{"alw":true,"amp":16,"car":1,"wh":23980.87648,"nrg":[232.5,233.4299927,234.6699982,1.24000001,0,0,0,0,0,0,0,0,0,0,0,0]}`

func sourcesConfig(entries ...map[string]any) []byte {
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "sources": entries})
	return raw
}

func goeSource(id, role, ip string, port any) map[string]any {
	return map[string]any{"id": id, "role": role, "brand": "go-e", "model": "goe_http_api", "family": "goe_http_api",
		"communication": "goe_http_api", "connection": map[string]any{"ip": ip, "port": port}, "interval_s": 5}
}

// collectSources records every edge/sources/+/telemetry message.
func (r *rig) collectSources() {
	r.t.Helper()
	if err := r.bus.Subscribe(sources.TopicWildcard, 950, func(topic string, p []byte) {
		r.mu.Lock()
		r.msgs[topic] = append(r.msgs[topic], append([]byte(nil), p...))
		r.mu.Unlock()
	}); err != nil {
		r.t.Fatal(err)
	}
}

func TestSourcesConfigIsPlannedLikeTheFlow(t *testing.T) {
	if _, _, _, ok := parseSourcesConfig(nil); !ok {
		t.Fatal("leere Nachricht = geloeschte Konfiguration, nicht unbrauchbar")
	}
	for name, bad := range map[string]string{
		"kein JSON":           `{`,
		"falsches Schema":     `{"schema_version":"2.0","sources":[]}`,
		"sources fehlt":       `{"schema_version":"1.0"}`,
		"blankes Array":       `[]`,
		"sources kein Array":  `{"schema_version":"1.0","sources":{}}`,
		"Schema-Version Zahl": `{"schema_version":1.0,"sources":[]}`,
	} {
		if _, _, _, ok := parseSourcesConfig([]byte(bad)); ok {
			t.Errorf("%s: muss als unbrauchbar verworfen werden (vp-sources-config)", name)
		}
	}

	plans, notes, entries, ok := parseSourcesConfig(sourcesConfig(
		goeSource("src-goe", "consumer", " 192.168.2.105 ", nil),
		goeSource("src-goe2", "consumer", "10.0.0.5", "8080"),
		map[string]any{"id": "src-fro", "role": "pv-generation", "communication": "fronius_solar_api", "family": "fronius_solar_api", "connection": map[string]any{"ip": "10.0.0.7"}},
		map[string]any{"id": "src-x", "role": "consumer", "communication": "zauberei", "family": "f", "connection": map[string]any{"ip": "10.0.0.8"}},
		map[string]any{"id": "src-rolle", "role": "speicher", "communication": "goe_http_api", "family": "goe_http_api", "connection": map[string]any{"ip": "10.0.0.9"}},
		map[string]any{"role": "consumer", "communication": "goe_http_api", "family": "goe_http_api", "connection": map[string]any{"ip": "10.0.0.10"}},
		map[string]any{"id": "src-noip", "role": "consumer", "communication": "goe_http_api", "family": "goe_http_api", "connection": map[string]any{"ip": "  "}},
	))
	if !ok || entries != 5 {
		t.Fatalf("ok=%v entries=%d (zwei Eintraege scheitern schon an der Struktur)", ok, entries)
	}
	if len(plans) != 2 {
		t.Fatalf("Leseplaene: %+v", plans)
	}
	if p := plans[0]; p.ID != "src-goe" || p.IP != "192.168.2.105" || p.Port != 80 ||
		p.URL != "http://192.168.2.105:80/api/status?filter=nrg,car,alw,amp,wh" || p.Addr != "192.168.2.105:80" {
		t.Errorf("go-e-Plan: %+v", p)
	}
	if p := plans[1]; p.Port != 8080 || p.URL != "http://10.0.0.5:8080/api/status?filter=nrg,car,alw,amp,wh" {
		t.Errorf("Port als Text: %+v", p)
	}
	all := ""
	for _, n := range notes {
		all += n.text + "\n"
	}
	for _, want := range []string{
		`Quelle src-fro (pv-generation): Edge Light liest die Anbindung "fronius_solar_api" als Energiequelle noch nicht`,
		`Quelle src-x NICHT VERDRAHTET: unbekannte Kommunikation "zauberei"`,
		`Quelle src-rolle NICHT VERDRAHTET: unbekannte Rolle "speicher"`,
		`Quelle verworfen - Eintrag #6: keine id`,
		`Quelle verworfen - src-noip: keine connection.ip`,
	} {
		if !strings.Contains(all, want) {
			t.Errorf("Hinweis fehlt: %s\n--- alle:\n%s", want, all)
		}
	}
}

func TestAGoeSourceIsReadOntoItsTopic(t *testing.T) {
	g := newFakeGoe(t)
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: 50 * time.Millisecond, SourcesPoll: 100 * time.Millisecond})
	r.collectSources()
	host, port := g.hostPort()
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(goeSource("src-goe", "consumer", host, port)), true); err != nil {
		t.Fatal(err)
	}
	topic := sources.TopicPrefix + "src-goe/telemetry"
	msg := decodeJSON(t, r.wait(topic, 1, 5*time.Second)[0])
	if msg["load_kw"] != 11.04 || len(msg) != 2 {
		t.Fatalf("Verbraucher-Messwert: %v", msg)
	}
	if ts, _ := msg["ts"].(string); len(ts) != len("2006-01-02T15:04:05.000Z") || !strings.HasSuffix(ts, "Z") {
		t.Errorf("ts wie Date.toISOString(): %v", msg["ts"])
	}
	g.mu.Lock()
	q := g.query
	g.mu.Unlock()
	if q != "/api/status?filter=nrg,car,alw,amp,wh" {
		t.Errorf("Anfrage: %s", q)
	}

	// A real 0 (no car / not charging) is a REAL value and is published.
	g.set(200, goeIdleZero)
	n := r.count(topic)
	got := decodeJSON(t, r.wait(topic, n+2, 5*time.Second)[n+1])
	if v, ok := got["load_kw"]; !ok || v != 0.0 {
		t.Fatalf("echte 0 muss veroeffentlicht werden: %v", got)
	}
	if r.count(localbus.TopicTelemetry) != 0 || r.count(localbus.TopicStatus) != 0 {
		t.Fatal("eine Energiequelle schreibt weder edge/telemetry noch edge/status")
	}
}

func TestAGoeWithoutAValuePublishesNothing(t *testing.T) {
	g := newFakeGoe(t)
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: 20 * time.Millisecond, SourcesPoll: 50 * time.Millisecond,
		HTTPTimeout: 300 * time.Millisecond})
	r.collectSources()
	host, port := g.hostPort()
	dead := freeAddr(t)
	deadHost, deadPort, _ := net.SplitHostPort(dead)
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(
		goeSource("src-goe", "consumer", host, port),
		goeSource("src-tot", "consumer", deadHost, deadPort),
		goeSource("src-pv", "pv-generation", host, port), // a go-e measures no PV: never published
	), true); err != nil {
		t.Fatal(err)
	}
	for _, body := range []struct {
		status int
		body   string
	}{{200, `{"car":2,"alw":true}`}, {404, `{"error":"x"}`}, {200, `<h1>kaputt</h1>`}, {200, `[1,2]`},
		{200, `{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,null,0,0,0,0]}`}} {
		g.set(body.status, body.body)
		g.mu.Lock()
		before := g.hits
		g.mu.Unlock()
		deadline := time.Now().Add(3 * time.Second)
		for {
			g.mu.Lock()
			h := g.hits
			g.mu.Unlock()
			if h >= before+4 { // both sources read twice with this answer
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("go-e wurde nicht gelesen (%d Abrufe)", h)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for topic, msgs := range r.msgs {
		if strings.HasPrefix(topic, sources.TopicPrefix) {
			t.Fatalf("ohne Ladewert darf nichts erscheinen, %s: %s", topic, msgs[0])
		}
	}
}

func goeSel(host string, port any) map[string]any {
	return map[string]any{"brand": "go-e", "model": "goe_http_api", "family": "goe_http_api", "communication": "goe_http_api",
		"connection": map[string]any{"ip": host, "port": port}}
}

func TestGoeConnectionTestClassifiesLikeTestReadJS(t *testing.T) {
	g := newFakeGoe(t)
	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour, SourcesFirstPoll: time.Hour, HTTPTimeout: 300 * time.Millisecond})
	host, port := g.hostPort()

	ok := testRead(t, r, "ok", goeSel(host, port))
	if ok["ok"] != true {
		t.Fatalf("gesunde go-e: %v", ok)
	}
	if rd, _ := ok["reading"].(map[string]any); len(rd) != 1 || rd["load_kw"] != 11.04 {
		t.Errorf("Messwert im Test: %v", ok["reading"])
	}
	if _, has := ok["finding"]; has {
		t.Error("eine go-e liefert nie einen Befund")
	}

	// A grid meter shows only Netzbezug - a go-e has none: ok, but empty.
	grid := testRead(t, r, "grid", func() map[string]any { s := goeSel(host, port); s["role"] = "grid-meter"; return s }())
	if grid["ok"] != true || len(grid["reading"].(map[string]any)) != 0 {
		t.Errorf("Rolle Netz-Zaehler: %v", grid)
	}

	for name, c := range map[string]struct {
		status int
		body   string
	}{
		"HTTP 404":       {404, `{}`},
		"kein JSON":      {200, `<h1>Not Found</h1>`},
		"kein Ladewert":  {200, `{"car":2}`},
		"kein Objekt":    {200, `[{"car":2}]`},
		"nrg[11] Text":   {200, `{"car":2,"nrg":[0,0,0,0,0,0,0,0,0,0,0,"11040",0,0,0,0]}`},
		"HTTP 500 leer":  {500, ``},
		"leere Antwort":  {200, ``},
		"zu kurzes nrg":  {200, `{"nrg":[1,2,3]}`},
		"Wahrheitswert":  {200, `true`},
		"nur Leerzeilen": {200, "\n\n"},
	} {
		g.set(c.status, c.body)
		if res := testRead(t, r, "bad-"+name, goeSel(host, port)); res["ok"] != false || res["error_code"] != "invalid_response" {
			t.Errorf("%s: %v", name, res)
		}
	}

	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if res := testRead(t, r, "dead", goeSel(dh, dp)); res["error_code"] != "unreachable" {
		t.Errorf("geschlossener Port: %v", res)
	}

	g.set(200, goeCharging)
	g.mu.Lock()
	g.delay = time.Second
	g.mu.Unlock()
	if res := testRead(t, r, "slow", goeSel(host, port)); res["error_code"] != "no_answer" {
		t.Errorf("Zeitueberschreitung: %v", res)
	}

	if res := testRead(t, r, "noip", goeSel("  ", 80)); res["error_code"] != "invalid_request" || res["message"] != "keine IP-Adresse" {
		t.Errorf("ohne IP: %v", res)
	}
}
