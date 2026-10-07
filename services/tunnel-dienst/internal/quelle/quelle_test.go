package quelle

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNurHttpsAusserLocalhost(t *testing.T) {
	for _, u := range []string{"http://portal.voltpilot.de", "ftp://x", "nur-text"} {
		if _, err := Neu(u, "https://kc/token", "id", "geheim", time.Second); err == nil {
			t.Errorf("%s: erwartet abgelehnt", u)
		}
	}
	for _, u := range []string{"https://portal.voltpilot.de", "http://127.0.0.1:8080", "http://localhost:1"} {
		if _, err := Neu(u, u+"/token", "id", "geheim", time.Second); err != nil {
			t.Errorf("%s: %v", u, err)
		}
	}
	if _, err := Neu("https://a", "https://a/t", "id", "", time.Second); err == nil {
		t.Error("ohne Secret erwartet abgelehnt")
	}
}

// attrappe ist eine API mit Keycloak-Tokenroute.
func attrappe(t *testing.T, sollStatus *atomic.Int32, tokens *atomic.Int32) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "voltpilot-tunnel-dienst" ||
			r.Form.Get("client_secret") != "geheim" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		n := tokens.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok` + string(rune('0'+n)) + `","expires_in":300}`))
	})
	mux.HandleFunc("GET "+SollPfad, func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer tok") {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if s := sollStatus.Load(); s != 200 {
			w.WriteHeader(int(s))
			return
		}
		_, _ = w.Write([]byte(`{"version":1}`))
	})
	return httptest.NewServer(mux)
}

func TestHoltTokenEinmalUndDenSollStand(t *testing.T) {
	var status, tokens atomic.Int32
	status.Store(200)
	srv := attrappe(t, &status, &tokens)
	defer srv.Close()
	a, err := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		daten, err := a.Hole(context.Background())
		if err != nil || string(daten) != `{"version":1}` {
			t.Fatalf("%s %v", daten, err)
		}
	}
	if tokens.Load() != 1 {
		t.Fatalf("Token %d-mal geholt, erwartet einmal", tokens.Load())
	}
}

func TestBei401WirdDasTokenEinmalErneuert(t *testing.T) {
	var status, tokens atomic.Int32
	status.Store(401)
	srv := attrappe(t, &status, &tokens)
	defer srv.Close()
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if _, err := a.Hole(context.Background()); err == nil {
		t.Fatal("401 auch mit frischem Token muss ein Fehler sein")
	}
	if tokens.Load() != 2 {
		t.Fatalf("Token %d-mal geholt, erwartet zweimal", tokens.Load())
	}
}

func TestFehlerDerApiSindFehler(t *testing.T) {
	var status, tokens atomic.Int32
	status.Store(503)
	srv := attrappe(t, &status, &tokens)
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if _, err := a.Hole(context.Background()); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("%v", err)
	}
	falsch, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "falsch", 5*time.Second)
	if _, err := falsch.Hole(context.Background()); err == nil {
		t.Fatal("falsches Secret muss ein Fehler sein")
	}
	srv.Close()
	if _, err := a.Hole(context.Background()); err == nil {
		t.Fatal("unerreichbare API muss ein Fehler sein")
	}
}
