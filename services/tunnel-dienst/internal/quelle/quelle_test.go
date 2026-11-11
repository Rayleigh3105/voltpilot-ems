package quelle

import (
	"context"
	"errors"
	"io"
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

// ── Rückmeldung ──────────────────────────────────────────────────────────────

// meldeAttrappe ist eine API mit Tokenroute, Soll-Stand und der Route der
// Rückmeldung; antwort bestimmt, was diese Route tut.
func meldeAttrappe(t *testing.T, tokens *atomic.Int32, antwort func(w http.ResponseWriter, r *http.Request)) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		tokens.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"tok1","expires_in":300}`))
	})
	mux.HandleFunc("GET "+SollPfad, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":1}`))
	})
	mux.HandleFunc(MeldePfad, antwort)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// Die Rückmeldung holt nie selbst ein Token: Ohne gelungenen Abruf des
// Soll-Stands geht nichts hinaus, auch nicht zum Keycloak.
func TestMeldeNimmtNurDasBereiteToken(t *testing.T) {
	var tokens, meldungen atomic.Int32
	srv := meldeAttrappe(t, &tokens, func(w http.ResponseWriter, r *http.Request) {
		meldungen.Add(1)
		w.WriteHeader(http.StatusNoContent)
	})
	a, err := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	m := a.Melder(2 * time.Second)
	if err := m.Melde(context.Background(), []byte(`{}`)); !errors.Is(err, ErrKeinToken) {
		t.Fatalf("ohne Token: %v", err)
	}
	if tokens.Load() != 0 || meldungen.Load() != 0 {
		t.Fatalf("ohne Token gingen %d Token-Anfragen und %d Meldungen hinaus", tokens.Load(), meldungen.Load())
	}
	if _, err := a.Hole(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := m.Melde(context.Background(), []byte(`{}`)); err != nil {
		t.Fatalf("mit bereitem Token: %v", err)
	}
	if tokens.Load() != 1 || meldungen.Load() != 1 {
		t.Fatalf("%d Token-Anfragen, %d Meldungen", tokens.Load(), meldungen.Load())
	}
	// Ein abgelaufenes Token wird nicht erneuert, die Meldung entfällt.
	a.jetzt = func() time.Time { return time.Now().Add(10 * time.Minute) }
	if err := m.Melde(context.Background(), []byte(`{}`)); !errors.Is(err, ErrKeinToken) {
		t.Fatalf("mit abgelaufenem Token: %v", err)
	}
	if tokens.Load() != 1 || meldungen.Load() != 1 {
		t.Fatalf("mit abgelaufenem Token: %d Token-Anfragen, %d Meldungen", tokens.Load(), meldungen.Load())
	}
}

func TestMeldeSchicktDenRumpfAlsPut(t *testing.T) {
	var tokens atomic.Int32
	var methode, auth, typ, rumpf atomic.Value
	srv := meldeAttrappe(t, &tokens, func(w http.ResponseWriter, r *http.Request) {
		daten, _ := io.ReadAll(r.Body)
		methode.Store(r.Method)
		auth.Store(r.Header.Get("Authorization"))
		typ.Store(r.Header.Get("Content-Type"))
		rumpf.Store(string(daten))
		w.WriteHeader(http.StatusNoContent)
	})
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if _, err := a.Hole(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.Melder(2*time.Second).Melde(context.Background(), []byte(`{"version":1}`)); err != nil {
		t.Fatal(err)
	}
	if methode.Load() != "PUT" || auth.Load() != "Bearer tok1" || typ.Load() != "application/json" ||
		rumpf.Load() != `{"version":1}` {
		t.Fatalf("%v %v %v %v", methode.Load(), auth.Load(), typ.Load(), rumpf.Load())
	}
}

// Was die API antwortet, kommt als Fehler mit Status an; 404, 405 und 501
// heißen: Diese API kennt die Rückmeldung nicht.
func TestMeldeFehlerTraegtDenStatus(t *testing.T) {
	var tokens atomic.Int32
	var status atomic.Int32
	srv := meldeAttrappe(t, &tokens, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(int(status.Load()))
		_, _ = w.Write([]byte("{\"message\":\"Die Meldung nennt eine Box,\\n die es nicht gibt.\"}\n" + strings.Repeat("x", 4000)))
	})
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if _, err := a.Hole(context.Background()); err != nil {
		t.Fatal(err)
	}
	m := a.Melder(2 * time.Second)
	for code, routeFehlt := range map[int]bool{404: true, 405: true, 501: true, 400: false, 401: false, 403: false,
		413: false, 422: false, 500: false, 503: false, 302: false} {
		status.Store(int32(code))
		err := m.Melde(context.Background(), []byte(`{}`))
		var f *MeldeFehler
		if !errors.As(err, &f) || f.Status != code || f.RouteFehlt() != routeFehlt {
			t.Errorf("HTTP %d: %v (Route fehlt: erwartet %v)", code, err, routeFehlt)
			continue
		}
		if len(f.Text) > 300 || strings.ContainsAny(f.Text, "\r\n") || !strings.HasPrefix(f.Text, `{"message":"Die Meldung nennt eine Box,`) {
			t.Errorf("HTTP %d: Text %q", code, f.Text)
		}
	}
}

// Das Token folgt keiner Umleitung an eine andere Adresse.
func TestMeldeFolgtKeinerUmleitung(t *testing.T) {
	var fremd atomic.Int32
	anderswo := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fremd.Add(1) }))
	defer anderswo.Close()
	var tokens atomic.Int32
	srv := meldeAttrappe(t, &tokens, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, anderswo.URL+"/sammeln", http.StatusTemporaryRedirect)
	})
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if _, err := a.Hole(context.Background()); err != nil {
		t.Fatal(err)
	}
	err := a.Melder(2*time.Second).Melde(context.Background(), []byte(`{}`))
	var f *MeldeFehler
	if !errors.As(err, &f) || f.Status != http.StatusTemporaryRedirect || fremd.Load() != 0 {
		t.Fatalf("%v, Anfragen an die fremde Adresse: %d", err, fremd.Load())
	}
}

// Eine Rückmeldung, auf die die API nie antwortet, endet mit ihrer eigenen
// Frist - und der Abruf des Soll-Stands läuft währenddessen ungestört.
func TestHaengendeRueckmeldungHaeltDenAbrufNichtAuf(t *testing.T) {
	var tokens atomic.Int32
	frei := make(chan struct{})
	srv := meldeAttrappe(t, &tokens, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-frei:
		case <-r.Context().Done():
		}
	})
	defer close(frei)
	a, _ := Neu(srv.URL, srv.URL+"/token", "voltpilot-tunnel-dienst", "geheim", 5*time.Second)
	if _, err := a.Hole(context.Background()); err != nil {
		t.Fatal(err)
	}
	fertig := make(chan error, 1)
	beginn := time.Now()
	go func() { fertig <- a.Melder(700*time.Millisecond).Melde(context.Background(), []byte(`{}`)) }()
	time.Sleep(100 * time.Millisecond)
	for i := 0; i < 3; i++ {
		t0 := time.Now()
		if _, err := a.Hole(context.Background()); err != nil {
			t.Fatalf("Abruf während der hängenden Rückmeldung: %v", err)
		}
		if d := time.Since(t0); d > 400*time.Millisecond {
			t.Fatalf("Abruf brauchte %s, während die Rückmeldung hing", d)
		}
	}
	select {
	case err := <-fertig:
		if err == nil {
			t.Fatal("die hängende Rückmeldung gilt als angenommen")
		}
		if d := time.Since(beginn); d < 500*time.Millisecond || d > 3*time.Second {
			t.Fatalf("Rückmeldung endete nach %s, Frist 700 ms", d)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("die Rückmeldung endet nicht mit ihrer Frist")
	}
}
