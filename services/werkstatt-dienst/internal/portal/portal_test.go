package portal

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type festesToken string

func (f festesToken) Token(context.Context) (string, error) { return string(f), nil }

// Die Attrappe antwortet wie WerkstattDienstController (Felder wie in openapi.yaml).
func attrappe(t *testing.T, gesehen map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		body, _ := io.ReadAll(r.Body)
		gesehen[r.Method+" "+r.URL.Path] = string(body)
		switch r.Method + " " + r.URL.Path {
		case "POST /api/v1/werkstatt-dienst/codes":
			if !strings.Contains(string(body), "edge-k7m2xq3") {
				w.WriteHeader(409)
				_, _ = w.Write([]byte(`{"message":"Die Werkstatt ist nicht freigegeben."}`))
				return
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"code":"wk-abcdefghijklmnopqrstuvwxyz","edgeRef":"edge-k7m2xq3","freigabe":"2026-11-mango-1","gueltigBis":"2026-11-02T10:30:00Z","tausch":false}`))
		case "POST /api/v1/werkstatt-dienst/fenster/f-1/schliessen":
			_, _ = w.Write([]byte(`{"id":"f-1"}`))
		case "POST /api/v1/werkstatt-dienst/fenster/f-2/schliessen":
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"message":"Das Fenster ist nicht mehr offen."}`))
		case "POST /api/v1/werkstatt-dienst/fenster/f-3/schliessen":
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"message":"Kein Probe-Fenster einer Einlösung."}`))
		case "POST /api/v1/werkstatt-dienst/abnahmen/edge-k7m2xq3":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"id":"a-1","edgeRef":"edge-k7m2xq3","freigabeId":"f","einloesungId":"e","lanNetz":"10.213.0.1/24","tunnelAdresse":"10.10.16.7","erfasstAm":"2026-11-02T10:40:00Z"}`))
		case "GET /api/v1/werkstatt-dienst/einloesungen/edge-k7m2xq3":
			_, _ = w.Write([]byte(`{"edgeRef":"edge-k7m2xq3","festgehalten":null,"einloesungen":[],"abgenommen":false,"gekoppelt":true}`))
		case "GET /api/v1/werkstatt-dienst/einloesungen/edge-alt2345":
			_, _ = w.Write([]byte(`{"edgeRef":"edge-alt2345","festgehalten":null,"einloesungen":[]}`))
		case "PUT /api/v1/werkstatt-dienst/gehaeuse/edge-k7m2xq3":
			if r.URL.Query().Get("sha256") == "falsch" {
				w.WriteHeader(422)
				_, _ = w.Write([]byte(`{"message":"Die Prüfsumme passt nicht zu den Bytes."}`))
				return
			}
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"edgeRef":"edge-k7m2xq3","name":"gehaeuse-edge-k7m2xq3.3mf","sha256":"x","bytes":3,"hochgeladenAm":"2026-11-06T10:00:00Z"}`))
		default:
			w.WriteHeader(409)
			_, _ = w.Write([]byte(`{"message":"Die Werkstatt ist nicht freigegeben."}`))
		}
	}))
}

func TestClient(t *testing.T) {
	gesehen := map[string]string{}
	srv := attrappe(t, gesehen)
	defer srv.Close()
	c := Client{URL: srv.URL + "/", Token: festesToken("tok")}
	ctx := context.Background()

	code, err := c.CodeHolen(ctx, "edge-k7m2xq3", false)
	if err != nil {
		t.Fatal(err)
	}
	defer code.Code.Vergessen()
	if code.Code.Offenbaren() != "wk-abcdefghijklmnopqrstuvwxyz" || code.Freigabe != "2026-11-mango-1" || !code.GueltigBis.Equal(time.Date(2026, 11, 2, 10, 30, 0, 0, time.UTC)) {
		t.Fatalf("%+v", code)
	}
	var req map[string]any
	_ = json.Unmarshal([]byte(gesehen["POST /api/v1/werkstatt-dienst/codes"]), &req)
	if req["edgeRef"] != "edge-k7m2xq3" || req["tausch"] != false {
		t.Fatalf("Anfrage %v", req)
	}
	if zu, err := c.FensterSchliessen(ctx, "f-1"); err != nil || zu {
		t.Fatalf("f-1: %v %v", zu, err)
	}
	if zu, err := c.FensterSchliessen(ctx, "f-2"); err != nil || !zu {
		t.Fatalf("f-2 (409 = schon zu): %v %v", zu, err)
	}
	var ab Abgelehnt
	if _, err := c.FensterSchliessen(ctx, "f-3"); !errors.As(err, &ab) || ab.Status != 404 {
		t.Fatalf("f-3: %v", err)
	}
	an, err := c.AbnahmeSchreiben(ctx, "edge-k7m2xq3", Abnahme{Fassung: "edge-light-2026.11.1", HostSchluessel: "SHA256:x",
		LanNetz: "10.213.0.1/24", Belege: map[string]string{"neustart": "ok"}, PasswortAge: "-----BEGIN AGE ENCRYPTED FILE-----"})
	if err != nil || an.ID != "a-1" || an.EinloesungID != "e" {
		t.Fatalf("%+v %v", an, err)
	}
	var abn map[string]any
	_ = json.Unmarshal([]byte(gesehen["POST /api/v1/werkstatt-dienst/abnahmen/edge-k7m2xq3"]), &abn)
	for _, f := range []string{"fassung", "hostSchluessel", "lanNetz", "belege", "passwortAge"} {
		if _, ok := abn[f]; !ok {
			t.Errorf("Abnahme ohne %s: %v", f, abn)
		}
	}
	// Abgelehnt: der Satz der API, und der Code steht in keinem Fehler.
	_, err = Client{URL: srv.URL, Token: festesToken("tok")}.CodeHolen(ctx, "edge-anders1", false)
	if !errors.As(err, &ab) || ab.Status != 409 || !strings.Contains(err.Error(), "nicht freigegeben") {
		t.Fatalf("%v", err)
	}
	if _, err := (Client{URL: srv.URL, Token: festesToken("falsch")}).CodeHolen(ctx, "edge-k7m2xq3", false); !errors.As(err, &ab) || ab.Status != 401 {
		t.Fatalf("falsches Token: %v", err)
	}
}

// Der Stand einer Referenz: abgenommen und gekoppelt; eine API ohne die Felder
// ist ein Fehler, kein „nein“.
func TestBoxStandLesen(t *testing.T) {
	srv := attrappe(t, map[string]string{})
	defer srv.Close()
	c := Client{URL: srv.URL, Token: festesToken("tok")}
	st, err := c.BoxStandLesen(context.Background(), "edge-k7m2xq3")
	if err != nil || st.Abgenommen || !st.Gekoppelt {
		t.Fatalf("%+v %v", st, err)
	}
	if _, err := c.BoxStandLesen(context.Background(), "edge-alt2345"); err == nil || !strings.Contains(err.Error(), "nicht, ob") {
		t.Fatalf("alte API ohne Felder: %v", err)
	}
}

// Die Box-Druckdatei hochladen (vp-mango-3mf-pro-box): Name und Prüfsumme
// gehen als Query mit, die Bytes im Körper als application/octet-stream.
func TestGehaeuseHochladen(t *testing.T) {
	gesehen := map[string]string{}
	srv := attrappe(t, gesehen)
	defer srv.Close()
	c := Client{URL: srv.URL, Token: festesToken("tok")}
	daten := []byte("PK\x03\x04 gehaeuse")
	if err := c.GehaeuseHochladen(context.Background(), "edge-k7m2xq3", "gehaeuse-edge-k7m2xq3.3mf", daten, "ok"); err != nil {
		t.Fatal(err)
	}
	if gesehen["PUT /api/v1/werkstatt-dienst/gehaeuse/edge-k7m2xq3"] != string(daten) {
		t.Fatalf("Körper nicht die rohen Bytes: %q", gesehen["PUT /api/v1/werkstatt-dienst/gehaeuse/edge-k7m2xq3"])
	}
	var ab Abgelehnt
	err := c.GehaeuseHochladen(context.Background(), "edge-k7m2xq3", "gehaeuse-edge-k7m2xq3.3mf", daten, "falsch")
	if !errors.As(err, &ab) || ab.Status != 422 {
		t.Fatalf("falsche Prüfsumme: %v", err)
	}
}

// Die Meldung der Ansicht holt die Aufträge des Portals ab (E1 A der
// Lauf-Seite). Eine API vor den Aufträgen antwortet 204: keine Aufträge, kein
// Fehler. Jede andere Antwort bleibt ein Fehler.
func TestAnsichtMeldenHoltAuftraege(t *testing.T) {
	ctx := context.Background()
	for _, f := range []struct {
		status int
		body   string
		will   int
		fehler bool
	}{
		{http.StatusOK, `{"auftraege":[{"id":"a1","art":"nochmal","lauf":"2026-11-05-114050-9ef8"}]}`, 1, false},
		{http.StatusNoContent, ``, 0, false},
		{http.StatusUnprocessableEntity, `{"message":"Ansicht ungültig"}`, 0, true},
	} {
		var pfad string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pfad = r.Method + " " + r.URL.RequestURI()
			w.WriteHeader(f.status)
			_, _ = w.Write([]byte(f.body))
		}))
		a, err := Client{URL: srv.URL, Token: festesToken("tok")}.AnsichtMelden(ctx, map[string]string{"schema": "x"})
		srv.Close()
		if (err != nil) != f.fehler || len(a) != f.will || pfad != "PUT /api/v1/werkstatt-dienst/ansicht?auftraege=1" {
			t.Fatalf("%d: %v %+v %s", f.status, err, a, pfad)
		}
		if f.will == 1 && (a[0].Art != "nochmal" || a[0].Lauf != "2026-11-05-114050-9ef8") {
			t.Fatalf("%+v", a)
		}
	}
}
