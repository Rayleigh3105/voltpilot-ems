package freigabe

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/apikonto"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
)

// So antwortet die API (WerkstattDienstController, Felder wie im
// WerkstattFreigabeApiTest geprüft): Instant mit Nachkommastellen, ohne
// beendet_am, solange die Freigabe läuft.
const apiAntwort = `{"schema":"vp-werkstatt-freigabe.v1","kennung":"2026-11-mango-1","box_art":"mango",
"erteilt_von":"admin","erteilt_am":"2026-11-02T10:00:00.123456Z","gueltig_bis":"2026-12-02T10:00:00.123456Z",
"obergrenze":20,"openwrt":{"fassung":"25.12.5","datei":"openwrt-25.12.5-ramips-mt76x8-glinet_gl-mt300n-v2-squashfs-sysupgrade.bin",
"sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","quelle":"https://downloads.openwrt.org/releases/25.12.5/targets/ramips/mt76x8/"},
"edge_light":{"fassung":"edge-light-2026.11.0","quelle":"https://git.tecmaxx.de/mamotec/voltpilot-ems/releases/download/edge-light-2026.11.0/",
"programm_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","skripte_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}`

func TestAPI(t *testing.T) {
	var tokens, abrufe atomic.Int32
	var laeuft atomic.Bool
	laeuft.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			_ = r.ParseForm()
			if r.PostForm.Get("grant_type") != "client_credentials" || r.PostForm.Get("client_secret") != "geheimes-secret-1" {
				w.WriteHeader(401)
				return
			}
			tokens.Add(1)
			_, _ = w.Write([]byte(`{"access_token":"tok-abc","expires_in":300}`))
		case "/api/v1/werkstatt-dienst/freigabe":
			abrufe.Add(1)
			if r.Header.Get("Authorization") != "Bearer tok-abc" || r.URL.Query().Get("boxArt") != "mango" {
				w.WriteHeader(403)
				return
			}
			if !laeuft.Load() {
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{"message":"Die Werkstatt ist für mango nicht freigegeben."}`))
				return
			}
			_, _ = w.Write([]byte(apiAntwort))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	sec := geheim.Neu("geheimes-secret-1")
	defer sec.Vergessen()
	a := API{URL: srv.URL + "/", Token: &apikonto.Konto{TokenURL: srv.URL + "/token", ClientID: "voltpilot-werkstatt-dienst", Secret: sec}}
	f, err := a.Aktuell()
	if err != nil {
		t.Fatal(err)
	}
	if f.Kennung != "2026-11-mango-1" || f.Laufend(time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC), 0) != nil {
		t.Fatalf("%+v", f)
	}
	if _, err := a.Aktuell(); err != nil {
		t.Fatal(err)
	}
	if tokens.Load() != 1 || abrufe.Load() != 2 {
		t.Fatalf("Token %d mal, Abrufe %d", tokens.Load(), abrufe.Load())
	}
	laeuft.Store(false)
	var k Keine
	if _, err := a.Aktuell(); !errors.As(err, &k) || !strings.Contains(err.Error(), "nicht freigegeben") {
		t.Fatalf("%v", err)
	}
	falsch := geheim.Neu("falsches-secret-2")
	defer falsch.Vergessen()
	b := API{URL: srv.URL, Token: &apikonto.Konto{TokenURL: srv.URL + "/token", ClientID: "x", Secret: falsch}}
	if _, err := b.Aktuell(); err == nil || errors.As(err, &k) || strings.Contains(err.Error(), "falsches-secret") {
		t.Fatalf("falsches Secret: %v", err)
	}
	_ = context.Background
}
