package layer1

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
)

// pikoSim is a classic KOSTAL PIKO's `/api/dxs.json`: it answers every
// requested dxsId it knows about, in dxsId order (never by request
// position - the same discipline the decoder itself enforces).
type pikoSim struct {
	mu     sync.Mutex
	values map[int]any
	silent bool
	status int // HTTP status to answer with (0 -> 200)
	srv    *httptest.Server
}

func startPikoSim(t *testing.T) *pikoSim {
	t.Helper()
	p := &pikoSim{values: map[int]any{
		67109120: 1234.5, // AC power
		16780544: "PIKO 20", 16777728: "12345678", 16779267: "06.53", 16779265: "06.17",
		16780032: 3.0, // Einspeisen (MPP)
	}}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.mu.Lock()
		silent, status, values := p.silent, p.status, p.values
		p.mu.Unlock()
		if silent {
			time.Sleep(2 * time.Second)
			return
		}
		if r.URL.Path != "/api/dxs.json" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		var entries []map[string]any
		for _, raw := range r.URL.Query()["dxsEntries"] {
			id, err := strconv.Atoi(raw)
			if err != nil {
				continue
			}
			if v, ok := values[id]; ok {
				entries = append(entries, map[string]any{"dxsId": id, "value": v})
			}
		}
		body, _ := json.Marshal(map[string]any{
			"dxsEntries": entries,
			"session":    map[string]any{"sessionId": 0, "roleId": 0},
			"status":     map[string]any{"code": 0},
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *pikoSim) hostPort() (string, string) {
	h, port, _ := net.SplitHostPort(strings.TrimPrefix(p.srv.URL, "http://"))
	return h, port
}

func pikoDxsSel(host string, port any) map[string]any {
	return map[string]any{"brand": "kostal", "model": "piko-20", "family": "kostal_piko", "communication": "kostal_dxs",
		"connection": map[string]any{"ip": host, "port": port}}
}

func fastKostalDxs() Options {
	return Options{Poll: time.Hour, FirstPoll: time.Hour, LinkTimeout: 600 * time.Millisecond, KostalDxsTimeout: 400 * time.Millisecond}
}

func TestKostalDxsSelectionDrivesTheReadOntoTheBus(t *testing.T) {
	p := startPikoSim(t)
	r := newRig(t, fastKostalDxs())
	host, port := p.hostPort()
	raw, _ := json.Marshal(pikoDxsSel(host, port))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	msg := decodeJSON(t, r.wait(localbus.TopicTelemetry, 1, 5*time.Second)[0])
	if msg["pv_power_kw"] != 1.235 || len(msg) != 2 {
		t.Fatalf("PIKO-Messwert (Web-API): nur pv_power_kw + ts: %v", msg)
	}
}

func TestKostalDxsNightOrDeadWebserverPublishesNothing(t *testing.T) {
	p := startPikoSim(t)
	p.mu.Lock()
	delete(p.values, 67109120) // night: no AC id in the response
	p.mu.Unlock()
	r := newRig(t, fastKostalDxs())
	host, port := p.hostPort()
	raw, _ := json.Marshal(pikoDxsSel(host, port))
	if err := r.bus.Publish(localbus.TopicInverterConfig, raw, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(900 * time.Millisecond)
	if r.count(localbus.TopicTelemetry) != 0 {
		t.Fatal("ohne AC-Leistung darf nichts erscheinen (abwesend, nie 0)")
	}
}

func TestKostalDxsConnectionTestClassifiesHonestly(t *testing.T) {
	p := startPikoSim(t)
	r := newRig(t, fastKostalDxs())
	host, port := p.hostPort()

	ok := testRead(t, r, "ok", pikoDxsSel(host, port))
	if rd, _ := ok["reading"].(map[string]any); ok["ok"] != true || rd["pv_kw"] != 1.235 || len(rd) != 1 {
		t.Fatalf("gesunder PIKO: %v", ok)
	}
	if msg, _ := ok["message"].(string); !strings.Contains(msg, "PIKO 20") || !strings.Contains(msg, "06.53") {
		t.Errorf("Typ/UI-Fassung muessen in der Meldung stehen: %v", ok)
	}

	p.mu.Lock()
	p.status = 404
	p.mu.Unlock()
	if res := testRead(t, r, "404", pikoDxsSel(host, port)); res["error_code"] != "invalid_response" {
		t.Errorf("HTTP 404 (UI < 06, nur index.fhtml): %v", res)
	}
	p.mu.Lock()
	p.status = 0
	p.silent = true
	p.mu.Unlock()
	if res := testRead(t, r, "silent", pikoDxsSel(host, port)); res["error_code"] != "no_answer" {
		t.Errorf("stiller Webserver (Zeitgrenze ueberschritten): %v", res)
	}
	dead := freeAddr(t)
	dh, dp, _ := net.SplitHostPort(dead)
	if res := testRead(t, r, "dead", pikoDxsSel(dh, dp)); res["error_code"] != "unreachable" {
		t.Errorf("Webserver nicht erreichbar: %v", res)
	}
	if res := testRead(t, r, "noip", pikoDxsSel("", 80)); res["error_code"] != "invalid_request" || res["message"] != "keine IP-Adresse" {
		t.Errorf("ohne IP: %v", res)
	}
}
