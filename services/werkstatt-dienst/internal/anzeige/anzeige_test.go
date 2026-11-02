package anzeige_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/anzeige"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/attrappe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/dienst"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/freigabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/werkbank"
)

func aufbau(t *testing.T) (*dienst.Dienst, *protokoll.Ablage, *metriken.Register) {
	t.Helper()
	log := logs.Neu(io.Discard, "text", nil)
	wb, err := werkbank.Neu(werkbank.Konfig{
		Adresse: "127.0.0.1:1", Status: attrappe.Schluessel(t), Weiterleitung: attrappe.Schluessel(t), Pflege: attrappe.Schluessel(t),
		Netz: "wlan0", Werkstatt: "eth0", WerkstattAdressen: []netip.Prefix{netip.MustParsePrefix("192.168.8.2/24")},
		Ziele: []netip.AddrPort{netip.MustParseAddrPort("192.168.8.1:22")}, SSHQuellen: []netip.Prefix{netip.MustParsePrefix("192.168.178.241/32")},
		Zeitlimit: time.Second,
	}, log)
	if err != nil {
		t.Fatal(err)
	}
	ablage, _ := protokoll.NeueAblage(t.TempDir())
	reg := metriken.Neu()
	d := dienst.Neu(&dienst.Dienst{Log: log, Werkbank: wb, Adresse: "127.0.0.1:1", Freigaben: freigabe.Datei{Pfad: filepath.Join(t.TempDir(), "f.json")}, Ablage: ablage, Takt: time.Second}, reg)
	return d, ablage, reg
}

func hole(t *testing.T, h http.Handler, host, pfad string) (int, string, http.Header) {
	t.Helper()
	r := httptest.NewRequest("GET", pfad, nil)
	r.Host = host
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.String(), w.Header()
}

func TestBetrieb(t *testing.T) {
	d, _, reg := aufbau(t)
	h := anzeige.Betrieb(d, reg)
	if c, _, _ := hole(t, h, "x", "/health"); c != 200 {
		t.Fatal(c)
	}
	if c, _, _ := hole(t, h, "x", "/ready"); c != 503 {
		t.Fatalf("ready vor der Schleife: %d", c)
	}
	if c, b, _ := hole(t, h, "x", "/metrics"); c != 200 || !strings.Contains(b, "vp_werkstatt_werkbank_bereit 0") {
		t.Fatalf("%d %s", c, b)
	}
	if c, _, _ := hole(t, h, "x", "/"); c != 404 {
		t.Fatalf("Anzeige auf der Betriebsseite: %d", c)
	}
}

func TestWerkstattNurLokal(t *testing.T) {
	d, ablage, _ := aufbau(t)
	_ = ablage.Schreibe(protokoll.Eintrag{Lauf: "2026-11-02-090000-ab12", Art: protokoll.LaufBegonnen, Angaben: map[string]string{"freigabe": "f"}})
	_ = ablage.Schreibe(protokoll.Eintrag{Lauf: "2026-11-02-090000-ab12", Art: protokoll.LaufBeendet, Zustand: "angehalten", Schritt: "openwrt", Grund: "<script>x</script>"})
	h := anzeige.Werkstatt(d, ablage, logs.Neu(io.Discard, "text", nil))
	if c, _, _ := hole(t, h, "boese.example:8101", "/"); c != 403 {
		t.Fatalf("fremder Host: %d", c)
	}
	c, b, hdr := hole(t, h, "127.0.0.1:8101", "/")
	if c != 200 || !strings.Contains(b, "Brücke nicht bereit") || !strings.Contains(b, "Keine laufende Freigabe") || !strings.Contains(b, "2026-11-02-090000-ab12") {
		t.Fatalf("%d\n%s", c, b)
	}
	if strings.Contains(b, "<script>x") || !strings.Contains(hdr.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatal("nicht escaped oder ohne CSP")
	}
	if c, b, _ := hole(t, h, "localhost:8101", "/laeufe/2026-11-02-090000-ab12.json"); c != 200 || !strings.Contains(b, `"zustand": "angehalten"`) {
		t.Fatalf("%d %s", c, b)
	}
	if c, _, _ := hole(t, h, "[::1]:8101", "/laeufe/..%2Fx.json"); c != 404 {
		t.Fatalf("Pfad: %d", c)
	}
	if c, b, _ := hole(t, h, "localhost", "/zustand.json"); c != 200 || !strings.Contains(b, `"werkbank"`) {
		t.Fatalf("%d %s", c, b)
	}
}
