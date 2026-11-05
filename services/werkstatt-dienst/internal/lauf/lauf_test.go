package lauf_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/logs"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/metriken"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

func laeufer(t *testing.T) (*lauf.Laeufer, *protokoll.Ablage, *metriken.Register) {
	t.Helper()
	a, err := protokoll.NeueAblage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reg := metriken.Neu()
	return lauf.NeuerLaeufer(a, logs.Neu(io.Discard, "text", nil), reg), a, reg
}

func belegt(name string, reihe *[]string) lauf.Schritt {
	return lauf.Schritt{Kennung: name, Titel: name, Tun: func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
		*reihe = append(*reihe, name)
		return protokoll.Beleg{}.Mit("ausgabe", name+" ok"), nil
	}}
}

func arten(t *testing.T, a *protokoll.Ablage, l *lauf.Lauf) string {
	t.Helper()
	es, err := a.Lies(l.Kennung())
	if err != nil {
		t.Fatal(err)
	}
	var s []string
	for _, e := range es {
		x := e.Art
		if e.Schritt != "" {
			x += ":" + e.Schritt
		}
		if e.Zustand != "" {
			x += "=" + e.Zustand
		}
		s = append(s, x)
	}
	return strings.Join(s, " ")
}

func neuerLauf() *lauf.Lauf {
	return lauf.Neu(time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC), "2026-11-mango-1", "mango")
}

func TestSchritteNacheinanderMitBelegen(t *testing.T) {
	r, a, reg := laeufer(t)
	var reihe []string
	l := neuerLauf()
	z := r.Fahre(context.Background(), l, nil, []lauf.Schritt{belegt("erkennen", &reihe), belegt("openwrt", &reihe), belegt("passwort", &reihe)})
	if z != lauf.Fertig {
		t.Fatalf("Zustand %s", z)
	}
	if strings.Join(reihe, ",") != "erkennen,openwrt,passwort" {
		t.Fatalf("Reihenfolge %v", reihe)
	}
	want := "lauf_begonnen schritt_begonnen:erkennen schritt_belegt:erkennen schritt_begonnen:openwrt schritt_belegt:openwrt schritt_begonnen:passwort schritt_belegt:passwort lauf_beendet=fertig"
	if got := arten(t, a, l); got != want {
		t.Fatalf("Protokoll\n got %s\nwant %s", got, want)
	}
	s := l.Stand()
	if s.Zustand != lauf.Fertig || len(s.Erledigt) != 3 || s.Ende.IsZero() {
		t.Fatalf("Stand %+v", s)
	}
	// E3 A: je erledigtem Schritt Dauer und eine Belegzeile, in der Reihenfolge.
	if len(s.Belege) != 3 || s.Belege[0].Schritt != "erkennen" || s.Belege[2].Schritt != "passwort" || s.Belege[1].Zeile == "" {
		t.Fatalf("Belege %+v", s.Belege)
	}
	if !s.SchrittSeit.IsZero() || s.SchrittFristS != 0 || s.NochmalMoeglich {
		t.Fatalf("fertig mit Schritt-Zeit oder Nochmal: %+v", s)
	}
	var m bytes.Buffer
	_ = reg.Schreibe(&m)
	for _, w := range []string{`vp_werkstatt_laeufe_total{ergebnis="fertig"} 1`, `vp_werkstatt_laeufe_total{ergebnis="angehalten"} 0`, `vp_werkstatt_schritt_letzte_dauer_seconds{schritt="openwrt"}`, "vp_werkstatt_lauf_aktiv 0"} {
		if !strings.Contains(m.String(), w) {
			t.Errorf("Metriken ohne %q:\n%s", w, m.String())
		}
	}
	if !strings.HasPrefix(l.Kennung(), "2026-11-02-090000-") || !protokoll.GueltigeKennung(l.Kennung()) {
		t.Fatalf("Kennung %q", l.Kennung())
	}
}

func TestOhneBelegHaeltDerLaufAn(t *testing.T) {
	r, a, _ := laeufer(t)
	var reihe []string
	leer := lauf.Schritt{Kennung: "openwrt", Tun: func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
		return protokoll.Beleg{}.Mit("ausgabe", "   "), nil
	}}
	l := neuerLauf()
	z := r.Fahre(context.Background(), l, nil, []lauf.Schritt{belegt("erkennen", &reihe), leer, belegt("passwort", &reihe)})
	if z != lauf.Angehalten {
		t.Fatalf("Zustand %s", z)
	}
	if strings.Join(reihe, ",") != "erkennen" {
		t.Fatalf("nach dem Schritt ohne Beleg lief noch etwas: %v", reihe)
	}
	if s := l.Stand(); s.Schritt != "openwrt" || !strings.Contains(s.Grund, "ohne Beleg") {
		t.Fatalf("Stand %+v", s)
	}
	if got := arten(t, a, l); !strings.HasSuffix(got, "schritt_gescheitert:openwrt lauf_beendet:openwrt=angehalten") {
		t.Fatalf("Protokoll %s", got)
	}
}

func TestFehlerHandgriffPanikUndFrist(t *testing.T) {
	faelle := []struct {
		name             string
		tun              func(context.Context, *lauf.Kontext) (protokoll.Beleg, error)
		frist            time.Duration
		grund, handgriff string
	}{
		{"fehler", func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
			return nil, errors.New("sha256 auf der Box weicht ab")
		}, 0, "sha256 auf der Box weicht ab", ""},
		{"handgriff", func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
			return nil, lauf.Handgriff{Was: "Reset-Knopf halten und Strom stecken", Grund: "Die Werksfirmware nimmt das Abbild nicht an"}
		}, 0, "Die Werksfirmware nimmt das Abbild nicht an", "Reset-Knopf halten und Strom stecken"},
		{"panik", func(context.Context, *lauf.Kontext) (protokoll.Beleg, error) {
			var m map[string]int
			m["x"]++
			return nil, nil
		}, 0, "Fehler im Dienst", ""},
		{"frist", func(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		}, 20 * time.Millisecond, "Frist von 20ms überschritten", ""},
	}
	for _, f := range faelle {
		t.Run(f.name, func(t *testing.T) {
			r, _, _ := laeufer(t)
			l := neuerLauf()
			z := r.Fahre(context.Background(), l, nil, []lauf.Schritt{{Kennung: "x", Frist: f.frist, Tun: f.tun}})
			s := l.Stand()
			if z != lauf.Angehalten || !strings.Contains(s.Grund, f.grund) || s.Handgriff != f.handgriff {
				t.Fatalf("Zustand %s, Stand %+v", z, s)
			}
		})
	}
}

func TestDienstEndeHaeltAn(t *testing.T) {
	r, _, _ := laeufer(t)
	ctx, cancel := context.WithCancel(context.Background())
	l := neuerLauf()
	z := r.Fahre(ctx, l, nil, []lauf.Schritt{{Kennung: "openwrt", Tun: func(ctx context.Context, _ *lauf.Kontext) (protokoll.Beleg, error) {
		cancel()
		<-ctx.Done()
		return nil, ctx.Err()
	}}})
	if z != lauf.Angehalten || !strings.Contains(l.Stand().Grund, "Dienst wurde beendet") {
		t.Fatalf("Zustand %s, Stand %+v", z, l.Stand())
	}
}

func TestWartenUndEingabe(t *testing.T) {
	r, a, _ := laeufer(t)
	l := neuerLauf()
	fertig := make(chan lauf.Zustand)
	go func() {
		fertig <- r.Fahre(context.Background(), l, nil, []lauf.Schritt{{Kennung: "tunnel", Tun: func(ctx context.Context, k *lauf.Kontext) (protokoll.Beleg, error) {
			adr, err := k.Warte(ctx, "tunnel_adresse", "Tunnel-Schlüssel im Portal hinterlegen, dann die Adresse eintragen")
			if err != nil {
				return nil, err
			}
			return protokoll.Beleg{}.Mit("adresse", adr), nil
		}}})
	}()
	if err := l.Gib(context.Background(), "falsch", "x"); err == nil {
		t.Fatal("Eingabe ohne Warten angenommen")
	}
	for i := 0; l.Stand().Zustand != lauf.Wartet; i++ {
		if i > 200 {
			t.Fatal("Lauf wartet nicht")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if s := l.Stand(); s.WartetAuf != "tunnel_adresse" || s.Hinweis == "" {
		t.Fatalf("Stand %+v", s)
	}
	if err := l.Gib(context.Background(), "andere", "x"); err == nil {
		t.Fatal("Eingabe für etwas anderes angenommen")
	}
	if err := l.Gib(context.Background(), "tunnel_adresse", "10.10.16.5"); err != nil {
		t.Fatal(err)
	}
	if z := <-fertig; z != lauf.Fertig {
		t.Fatalf("Zustand %s", z)
	}
	if got := arten(t, a, l); got != "lauf_begonnen schritt_begonnen:tunnel wartet:tunnel eingabe:tunnel schritt_belegt:tunnel lauf_beendet=fertig" {
		t.Fatalf("Protokoll %s", got)
	}
}

// Ein Lauf ohne erledigten Schritt meldet erledigt als leere Liste, nie als
// null: das Portal liest eine Liste (werkstatt-ansicht-v1); null brachte am
// 04.11.2026 die Werkbank-Bildschirme in die Fehlergrenze.
func TestStandErledigtIstNieNull(t *testing.T) {
	l := lauf.Neu(time.Date(2026, 11, 4, 10, 28, 8, 0, time.UTC), "2026-11-mango-1", "mango")
	b, err := json.Marshal(l.Stand())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"erledigt":[]`) {
		t.Fatalf("erledigt nicht als leere Liste: %s", b)
	}
}
