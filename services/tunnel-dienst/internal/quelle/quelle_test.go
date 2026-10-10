package quelle

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
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

// Lehnt der Token-Endpunkt die Anmeldung ab, ist das ein eigener Fehler -
// getrennt von jedem anderen Fehler des Token-Endpunkts, der API und einer
// unerreichbaren Gegenstelle.
func TestAbgelehnteAnmeldungIstEinEigenerFehler(t *testing.T) {
	var tokenStatus atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(int(tokenStatus.Load()))
	})
	srv := httptest.NewServer(mux)
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "falsch", 5*time.Second)

	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		tokenStatus.Store(int32(status))
		_, err := a.Hole(context.Background())
		if !errors.Is(err, ErrAnmeldungAbgelehnt) {
			t.Errorf("HTTP %d am Token-Endpunkt: %v, erwartet ErrAnmeldungAbgelehnt", status, err)
			continue
		}
		if !strings.Contains(err.Error(), "Anmeldung abgelehnt: Client oder Secret prüfen") ||
			!strings.Contains(err.Error(), strconv.Itoa(status)) {
			t.Errorf("HTTP %d: Wortlaut %q", status, err)
		}
	}

	for _, status := range []int{http.StatusBadRequest, http.StatusInternalServerError, http.StatusServiceUnavailable} {
		tokenStatus.Store(int32(status))
		if _, err := a.Hole(context.Background()); err == nil || errors.Is(err, ErrAnmeldungAbgelehnt) {
			t.Errorf("HTTP %d am Token-Endpunkt ist keine abgelehnte Anmeldung: %v", status, err)
		}
	}
	srv.Close()
	if _, err := a.Hole(context.Background()); err == nil || errors.Is(err, ErrAnmeldungAbgelehnt) {
		t.Errorf("unerreichbar ist keine abgelehnte Anmeldung: %v", err)
	}
}

// Ein 401 oder 403 der API selbst (Token gültig, Rolle fehlt) ist ebenfalls
// keine abgelehnte Anmeldung: Client und Secret stimmen dann.
func TestFehlerDerApiSindKeineAbgelehnteAnmeldung(t *testing.T) {
	for _, status := range []int32{401, 403} {
		var sollStatus, tokens atomic.Int32
		sollStatus.Store(status)
		srv := attrappe(t, &sollStatus, &tokens)
		a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
		if _, err := a.Hole(context.Background()); err == nil || errors.Is(err, ErrAnmeldungAbgelehnt) {
			t.Errorf("Soll-Stand HTTP %d: %v", status, err)
		}
		srv.Close()
	}
}
