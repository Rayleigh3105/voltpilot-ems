package suche

// The admission and the one-shot discipline of the box (contract §2/§3): the
// refusals in the exact shape of the shared vectors, the deadline cases of
// `frist`, duplicate delivery, one search at a time, six per hour, cancel,
// time limit, progress every StandTakt with only the new finds, a result that
// waits for the link, and the open order on disk of the Docker box (reported
// "neustart" after a restart; Edge Light keeps nothing).

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/geraetesim"
)

const (
	vTenant = "11111111-1111-4111-8111-111111111111"
	vSite   = "22222222-2222-4222-8222-222222222222"
	vDevice = "33333333-3333-4333-8333-333333333333"
	vSuch   = "44444444-4444-4444-8444-444444444444"
)

type vektoren struct {
	Auftrag struct {
		Gueltig []struct {
			Name    string          `json:"name"`
			Payload json.RawMessage `json:"payload"`
		} `json:"gueltig"`
	} `json:"auftrag"`
	Frist []struct {
		Name         string    `json:"name"`
		AusgeloestAm time.Time `json:"ausgeloest_am"`
		GueltigBis   time.Time `json:"gueltig_bis"`
		Jetzt        time.Time `json:"jetzt"`
		Beginnt      bool      `json:"beginnt"`
	} `json:"frist"`
	Ergebnis struct {
		Gueltig []struct {
			Name    string          `json:"name"`
			Payload json.RawMessage `json:"payload"`
		} `json:"gueltig"`
	} `json:"ergebnis"`
}

func ladeVektoren(t *testing.T) vektoren {
	t.Helper()
	raw, err := os.ReadFile("../../../../../docs/contracts/v2/geraetesuche-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vektoren
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func (v vektoren) ergebnis(t *testing.T, name string) []byte {
	t.Helper()
	for _, e := range v.Ergebnis.Gueltig {
		if e.Name == name {
			var kompakt map[string]any
			_ = json.Unmarshal(e.Payload, &kompakt)
			raw, _ := json.Marshal(kompakt)
			return raw
		}
	}
	t.Fatalf("no vector %s", name)
	return nil
}

// kompakt is the JSON of a value with its keys in one order.
func kompakt(v any) []byte {
	raw, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	raw, _ = json.Marshal(m)
	return raw
}

// auftrag builds a start order of the vectors' identity.
func auftrag(such string, am time.Time) []byte {
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "tenant_id": vTenant, "site_id": vSite,
		"device_id": vDevice, "aktion": "starten", "such_id": such, "ausgeloest_am": am.Format(time.RFC3339),
		"gueltig_bis": am.Add(geraetesuche.Frist).Format(time.RFC3339)})
	return raw
}

func abbruch(such string, am time.Time) []byte {
	raw, _ := json.Marshal(map[string]any{"schema_version": "1.0", "tenant_id": vTenant, "site_id": vSite,
		"device_id": vDevice, "aktion": "abbrechen", "such_id": such, "ausgeloest_am": am.Format(time.RFC3339)})
	return raw
}

// postfach collects what a Leitung sends.
type postfach struct {
	mu         sync.Mutex
	staende    []geraetesuche.Stand
	ergebnisse []geraetesuche.Ergebnis
	offline    bool
}

func (p *postfach) stand(s geraetesuche.Stand) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.staende = append(p.staende, s)
	return nil
}

func (p *postfach) ergebnis(e geraetesuche.Ergebnis) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.offline {
		return net.ErrClosed
	}
	p.ergebnisse = append(p.ergebnisse, e)
	return nil
}

func (p *postfach) warteAuf(t *testing.T, n int) []geraetesuche.Ergebnis {
	t.Helper()
	ende := time.Now().Add(10 * time.Second)
	for time.Now().Before(ende) {
		p.mu.Lock()
		if len(p.ergebnisse) >= n {
			out := append([]geraetesuche.Ergebnis(nil), p.ergebnisse...)
			p.mu.Unlock()
			return out
		}
		p.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("waited for %d results", n)
	return nil
}

func (p *postfach) anzahl() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.ergebnisse)
}

// langsam: every connection hangs until its time limit - a search that runs.
func langsam(ctx context.Context, _ string) (net.Conn, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func schnell(context.Context, string) (net.Conn, error) { return nil, geraetesim.ErrNichtDa }

type leitungsTest struct {
	l     *Leitung
	p     *postfach
	jetzt time.Time
	mu    sync.Mutex
}

func neueTestLeitung(t *testing.T, u Umgebung, offen string, tune func(*LeitungOptionen)) *leitungsTest {
	t.Helper()
	lt := &leitungsTest{p: &postfach{}, jetzt: time.Date(2026, 11, 2, 9, 0, 1, 0, time.UTC)}
	if u.BoxArt == "" {
		u.BoxArt = geraetesuche.BoxArtDocker
	}
	u.Takt = Takt{JeSekunde: 100000, Zeitlimit: 200 * time.Millisecond, Nachlauf: time.Millisecond}
	o := LeitungOptionen{
		BoxArt:        u.BoxArt,
		Identitaet:    func() (string, string, string) { return vTenant, vSite, vDevice },
		Umgebung:      func() Umgebung { return u },
		Bekannt:       func() []Bekannt { return nil },
		SendeStand:    lt.p.stand,
		SendeErgebnis: lt.p.ergebnis,
		OffenPfad:     offen,
		StandTakt:     20 * time.Millisecond,
		Jetzt: func() time.Time {
			lt.mu.Lock()
			defer lt.mu.Unlock()
			return lt.jetzt
		},
	}
	if tune != nil {
		tune(&o)
	}
	lt.l = NeueLeitung(o)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	lt.l.Start(ctx)
	return lt
}

func (lt *leitungsTest) stelle(t time.Time) {
	lt.mu.Lock()
	lt.jetzt = t
	lt.mu.Unlock()
}

func TestAbgelehntGenauWieDieVektoren(t *testing.T) {
	v := ladeVektoren(t)
	am := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)

	// The Docker box without VP_LAN_HOST searches nothing (DP-2 A).
	ohne := neueTestLeitung(t, Umgebung{Dial: schnell}, "", nil)
	ohne.l.Nimm(auftrag(vSuch, am))
	raw := kompakt(ohne.p.warteAuf(t, 1)[0])
	if want := v.ergebnis(t, "abgelehnt_lan_host_fehlt"); string(raw) != string(want) {
		t.Fatalf("lan_host_fehlt:\n got %s\nwant %s", raw, want)
	}

	// One search per box: a second order is refused while the first runs.
	lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: langsam}, "", nil)
	lt.l.Nimm(auftrag("55555555-5555-4555-8555-555555555555", am))
	if !lt.l.Laeuft() {
		t.Fatal("search did not start")
	}
	lt.l.Nimm(auftrag(vSuch, am))
	raw = kompakt(lt.p.warteAuf(t, 1)[0])
	if want := v.ergebnis(t, "abgelehnt_laeuft_schon"); string(raw) != string(want) {
		t.Fatalf("laeuft_schon:\n got %s\nwant %s", raw, want)
	}
}

func TestFristWieDieVektoren(t *testing.T) {
	v := ladeVektoren(t)
	for _, f := range v.Frist {
		lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: langsam}, "", nil)
		lt.stelle(f.Jetzt)
		lt.l.Nimm(auftrag(vSuch, f.AusgeloestAm))
		if lt.l.Laeuft() != f.Beginnt {
			t.Fatalf("%s: started=%v, want %v", f.Name, lt.l.Laeuft(), f.Beginnt)
		}
		if !f.Beginnt {
			if e := lt.p.warteAuf(t, 1)[0]; e.Zustand != "abgelehnt" || e.Grund != "abgelaufen" {
				t.Fatalf("%s: %+v", f.Name, e)
			}
		}
	}
}

func TestDoppelzustellungUndFremdeBoxStartenNichts(t *testing.T) {
	lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: schnell}, "", nil)
	am := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	lt.l.Nimm(auftrag(vSuch, am))
	lt.p.warteAuf(t, 1)
	lt.l.Nimm(auftrag(vSuch, am)) // QoS 1 delivered twice
	fremd := []byte(`{"schema_version":"1.0","tenant_id":"` + vTenant + `","site_id":"` + vSite +
		`","device_id":"99999999-9999-4999-8999-999999999999","aktion":"starten","such_id":"66666666-6666-4666-8666-666666666666",` +
		`"ausgeloest_am":"2026-11-02T09:00:00Z","gueltig_bis":"2026-11-02T09:02:00Z"}`)
	lt.l.Nimm(fremd)
	time.Sleep(200 * time.Millisecond)
	if n := lt.p.anzahl(); n != 1 || lt.l.Laeuft() {
		t.Fatalf("%d results; a duplicate or another box's order was run", n)
	}
}

func TestHoechstensSechsJeStunde(t *testing.T) {
	lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: schnell}, "", nil)
	am := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	ids := []string{"1", "2", "3", "4", "5", "6", "7"}
	for i, id := range ids {
		such := "4444444" + id + "-4444-4444-8444-444444444444"
		such = such[len(such)-36:]
		lt.l.Nimm(auftrag(such, am))
		e := lt.p.warteAuf(t, i+1)[i]
		if i < geraetesuche.MaxJeStunde && e.Zustand != "fertig" {
			t.Fatalf("search %d: %+v", i+1, e)
		}
		if i == geraetesuche.MaxJeStunde && (e.Zustand != "abgelehnt" || e.Grund != "zu_oft") {
			t.Fatalf("the seventh search in an hour: %+v", e)
		}
	}
}

func TestAbbrechenUndZeitlimitBehaltenDieFunde(t *testing.T) {
	lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: langsam}, "", nil)
	am := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	lt.l.Nimm(auftrag(vSuch, am))
	lt.l.Nimm(abbruch("77777777-7777-4777-8777-777777777777", am)) // another search: nothing happens
	time.Sleep(100 * time.Millisecond)
	if !lt.l.Laeuft() {
		t.Fatal("a cancel of another search stopped this one")
	}
	lt.l.Nimm(abbruch(vSuch, am))
	e := lt.p.warteAuf(t, 1)[0]
	if e.Zustand != "abgebrochen" || e.Grund != "auf_wunsch" || e.Funde == nil || e.Pruefe(geraetesuche.BoxArtDocker) != nil {
		t.Fatalf("cancelled: %+v", e)
	}

	kurz := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: langsam}, "", func(o *LeitungOptionen) {
		o.MaxDauer = 300 * time.Millisecond
	})
	kurz.l.Nimm(auftrag(vSuch, am))
	if e := kurz.p.warteAuf(t, 1)[0]; e.Zustand != "abgebrochen" || e.Grund != "zeitlimit" {
		t.Fatalf("time limit: %+v", e)
	}
}

func TestZwischenstandSendetNurNeueFunde(t *testing.T) {
	n := neuesTestnetz()
	p := &geraetesim.Protokoll{}
	for _, ip := range []string{"10.77.0.50", "10.77.0.51", "10.77.0.52"} {
		n.http(t, ip+":80", geraetesim.ShellyGen1(p, "SHSW-1", 1, 0))
	}
	langsamerDial := func(ctx context.Context, addr string) (net.Conn, error) {
		time.Sleep(2 * time.Millisecond)
		return n.dial(ctx, addr)
	}
	lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: langsamerDial}, "", nil)
	lt.l.Nimm(auftrag(vSuch, time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)))
	e := lt.p.warteAuf(t, 1)[0]
	if e.Zustand != "fertig" || len(e.Funde) != 3 {
		t.Fatalf("result: %+v", e)
	}
	lt.p.mu.Lock()
	defer lt.p.mu.Unlock()
	if len(lt.p.staende) < 2 {
		t.Fatalf("%d progress messages", len(lt.p.staende))
	}
	gesehen := map[string]bool{}
	for i, s := range lt.p.staende {
		if s.Nr != i+1 || s.Pruefe(geraetesuche.BoxArtDocker) != nil || len(s.Netze) != 1 {
			t.Fatalf("progress %d: %+v", i, s)
		}
		for _, f := range s.Funde {
			if gesehen[f.Schluessel] {
				t.Fatalf("find %s sent twice", f.Schluessel)
			}
			gesehen[f.Schluessel] = true
		}
	}
}

func TestErgebnisWartetAufDieVerbindung(t *testing.T) {
	lt := neueTestLeitung(t, Umgebung{LANHost: "10.77.0.20", Dial: schnell}, "", nil)
	lt.p.mu.Lock()
	lt.p.offline = true
	lt.p.mu.Unlock()
	lt.l.Nimm(auftrag(vSuch, time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)))
	time.Sleep(300 * time.Millisecond)
	if lt.p.anzahl() != 0 {
		t.Fatal("sent while offline")
	}
	lt.p.mu.Lock()
	lt.p.offline = false
	lt.p.mu.Unlock()
	lt.l.Senden()
	lt.l.Senden()
	if e := lt.p.warteAuf(t, 1); len(e) != 1 || e[0].Zustand != "fertig" {
		t.Fatalf("results: %+v", e)
	}
}

func TestNeustartMeldetDenOffenenAuftragEinmal(t *testing.T) {
	pfad := filepath.Join(t.TempDir(), "geraetesuche-offen.json")
	ctx, halt := context.WithCancel(context.Background())
	p := &postfach{}
	o := LeitungOptionen{BoxArt: geraetesuche.BoxArtDocker,
		Identitaet: func() (string, string, string) { return vTenant, vSite, vDevice },
		Umgebung: func() Umgebung {
			return Umgebung{BoxArt: geraetesuche.BoxArtDocker, LANHost: "10.77.0.20", Dial: langsam,
				Takt: Takt{JeSekunde: 100000, Zeitlimit: 200 * time.Millisecond}}
		},
		Bekannt: func() []Bekannt { return nil }, SendeStand: p.stand, SendeErgebnis: p.ergebnis, OffenPfad: pfad,
		Jetzt: func() time.Time { return time.Date(2026, 11, 2, 9, 0, 1, 0, time.UTC) }}
	vorher := NeueLeitung(o)
	vorher.Start(ctx)
	vorher.Nimm(auftrag(vSuch, time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)))
	if _, err := os.Stat(pfad); err != nil {
		t.Fatalf("open order not on disk: %v", err)
	}
	halt() // the box stops mid-search
	time.Sleep(400 * time.Millisecond)
	if p.anzahl() != 0 {
		t.Fatal("a stopping box sent a result")
	}

	nachher := NeueLeitung(o)
	nctx, ncancel := context.WithCancel(context.Background())
	defer ncancel()
	nachher.Start(nctx)
	e := p.warteAuf(t, 1)[0]
	if e.SuchID != vSuch || e.Zustand != "abgebrochen" || e.Grund != "neustart" || len(e.Netze) != 1 ||
		e.Netze[0].Netz != "10.77.0.0/24" {
		t.Fatalf("after the restart: %+v", e)
	}
	if _, err := os.Stat(pfad); !os.IsNotExist(err) {
		t.Fatal("the open order outlived its report")
	}
	// A late redelivery of the same order is no new search.
	nachher.Nimm(auftrag(vSuch, time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)))
	time.Sleep(100 * time.Millisecond)
	if p.anzahl() != 1 || nachher.Laeuft() {
		t.Fatal("the reported order ran again")
	}
}
