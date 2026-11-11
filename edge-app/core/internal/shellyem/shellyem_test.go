package shellyem

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type vecCase struct {
	Name     string          `json:"name"`
	Status   json.RawMessage `json:"status"`
	Roh      *string         `json:"roh"`
	Kanal    int             `json:"kanal"`
	Erwartet struct {
		OK            bool       `json:"ok"`
		Fehler        string     `json:"fehler"`
		LeistungW     float64    `json:"leistung_w"`
		PowerKw       float64    `json:"power_kw"`
		PowerKwInv    float64    `json:"power_kw_invertiert"`
		PhasenW       []*float64 `json:"phasen_w"`
		BezugWh       *float64   `json:"bezug_wh"`
		EinspeisungWh *float64   `json:"einspeisung_wh"`
		Hinweise      []string   `json:"hinweise"`
	} `json:"erwartet"`
}

func loadVectors(t *testing.T) (doc struct {
	Communication string    `json:"communication"`
	Family        string    `json:"family"`
	StatusPath    string    `json:"status_path"`
	Cases         []vecCase `json:"cases"`
}) {
	t.Helper()
	raw, err := os.ReadFile("testdata/shelly-em-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 12 {
		t.Fatalf("zu wenige Faelle: %d", len(doc.Cases))
	}
	return doc
}

var fehlerArt = map[string]error{
	"kein_json":       ErrKeinJSON,
	"kein_dreiphasen": ErrKeinDreiphasen,
	"einzelkanaele":   ErrEinzelkanaele,
	"kein_messwert":   ErrKeinMesswert,
	"zaehlerfehler":   ErrZaehlerfehler,
}

func TestVectors(t *testing.T) {
	doc := loadVectors(t)
	if doc.Communication != Communication || doc.Family != Family || doc.StatusPath != StatusPath {
		t.Fatalf("Kennung weicht ab: %s %s %s", doc.Communication, doc.Family, doc.StatusPath)
	}
	schramm := 0
	for _, c := range doc.Cases {
		t.Run(c.Name, func(t *testing.T) {
			body := []byte(c.Status)
			if c.Roh != nil {
				body = []byte(*c.Roh)
			}
			m, err := Decode(body, c.Kanal)
			want := c.Erwartet
			if !want.OK {
				if !errors.Is(err, fehlerArt[want.Fehler]) || m != nil {
					t.Fatalf("erwartet %s, bekommen %v / %+v", want.Fehler, err, m)
				}
				if !Answered(err) {
					t.Fatalf("%v zaehlt nicht als Antwort des Geraets", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			if m.LeistungW != want.LeistungW || m.PowerKw(false) != want.PowerKw || m.PowerKw(true) != want.PowerKwInv {
				t.Fatalf("Leistung %v / %v / %v, erwartet %v / %v / %v", m.LeistungW, m.PowerKw(false), m.PowerKw(true),
					want.LeistungW, want.PowerKw, want.PowerKwInv)
			}
			for i, p := range m.Phasen {
				if !reflect.DeepEqual(p.LeistungW, want.PhasenW[i]) {
					t.Fatalf("Phase %d: %v, erwartet %v", i, p.LeistungW, want.PhasenW[i])
				}
			}
			if !reflect.DeepEqual(m.BezugWh, want.BezugWh) || !reflect.DeepEqual(m.EinspWh, want.EinspeisungWh) {
				t.Fatalf("Zaehlerstaende %v/%v, erwartet %v/%v", m.BezugWh, m.EinspWh, want.BezugWh, want.EinspeisungWh)
			}
			if !reflect.DeepEqual(m.Fehler, want.Hinweise) {
				t.Fatalf("Hinweise %v, erwartet %v", m.Fehler, want.Hinweise)
			}
		})
		if strings.HasPrefix(c.Name, "Schramm: ") {
			schramm++
		}
	}
	if schramm != 3 {
		t.Fatalf("Schramm-Faelle: %d", schramm)
	}
}

// The real grid meter: Bezug is positive (the proof of the sign, see the
// package comment) and its counters say the site exported more than it drew.
func TestSchrammGridMeterSign(t *testing.T) {
	doc := loadVectors(t)
	m, err := Decode(doc.Cases[0].Status, 0)
	if err != nil {
		t.Fatal(err)
	}
	if m.PowerKw(false) <= 0 || *m.EinspWh <= *m.BezugWh {
		t.Fatalf("Netzanschluss: %v kW, Bezug %v Wh, Einspeisung %v Wh", m.PowerKw(false), *m.BezugWh, *m.EinspWh)
	}
}

func TestGet(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.Method+" "+r.URL.RequestURI())
		mu.Unlock()
		switch r.Header.Get("X-Fall") {
		case "401":
			w.WriteHeader(http.StatusUnauthorized)
		case "500":
			w.WriteHeader(http.StatusInternalServerError)
		case "404":
			w.WriteHeader(http.StatusNotFound)
		case "gross":
			_, _ = w.Write([]byte(strings.Repeat(" ", MaxBody+10)))
		case "langsam":
			time.Sleep(300 * time.Millisecond)
			_, _ = w.Write([]byte(`{}`))
		default:
			_, _ = w.Write([]byte(`{"em:0":{"total_act_power":12.5}}`))
		}
	}))
	defer srv.Close()
	client := &http.Client{Timeout: 100 * time.Millisecond, Transport: &http.Transport{DisableKeepAlives: true}}
	get := func(fall string) ([]byte, error) {
		c := *client
		c.Transport = roundTripper{base: client.Transport, fall: fall}
		return Get(context.Background(), &c, srv.URL+StatusPath)
	}
	if b, err := get(""); err != nil || !strings.Contains(string(b), "total_act_power") {
		t.Fatalf("ok: %v %s", err, b)
	}
	if _, err := get("401"); !errors.Is(err, ErrGeschuetzt) {
		t.Fatalf("401: %v", err)
	}
	if _, err := get("500"); !errors.Is(err, ErrHTTPStatus) {
		t.Fatalf("500: %v", err)
	}
	if _, err := get("404"); !errors.Is(err, ErrKeineRPC) || !Answered(err) {
		t.Fatalf("404 (Gen1): %v", err)
	}
	if _, err := get("gross"); !errors.Is(err, ErrZuGross) {
		t.Fatalf("gross: %v", err)
	}
	if _, err := get("langsam"); err == nil || Answered(err) {
		t.Fatalf("langsam: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, p := range paths {
		if p != "GET /rpc/Shelly.GetStatus" {
			t.Fatalf("nur die Status-Abfrage ist erlaubt, nicht %q", p)
		}
	}
	if URL("192.168.1.146", 80) != "http://192.168.1.146:80/rpc/Shelly.GetStatus" {
		t.Fatalf("URL %s", URL("192.168.1.146", 80))
	}
}

type roundTripper struct {
	base http.RoundTripper
	fall string
}

func (r roundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req.Header.Set("X-Fall", r.fall)
	return r.base.RoundTrip(req)
}
