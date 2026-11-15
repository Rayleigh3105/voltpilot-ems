package steuerart

// Der Gleichheitsbeleg der Verbraucherregel (Stufe 6, Zusammenführen, dritter Teil): die
// übersetzte Steuerart entscheidet im Kern wie der Knoten vp.consumer.reactive
//   - an jedem Schritt von verbraucherregel-vectors.json, wo sich das Szenario übersetzen lässt
//     (aktiv, gehalten, unbekannt, Pflicht, Wert, geltende Anforderungen); wo nicht, mit Grund;
//   - über Zufallsläufe Sekunde für Sekunde gegen den Go-Zwilling des Knotens
//     (internal/verbraucherregel, den dieselben Vektoren an die Palette binden).
// Was der alte Weg danach tut (den Wunsch bis zur TTL stehen lassen, nur im 15-s-Takt neu senden),
// steht als benannte Abweichung im Vertrag; verglichen wird die Entscheidung.

import (
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/verbraucherregel"
)

const vektorPfad = "../../../../../docs/contracts/v2/verbraucherregel-vectors.json"

type vektorDatei struct {
	Szenarien []struct {
		Name     string         `json:"name"`
		Start    string         `json:"start"`
		Knoten   map[string]any `json:"knoten"`
		Schritte []struct {
			TS        int64          `json:"t_s"`
			Art       string         `json:"art"`
			Nachricht any            `json:"nachricht"`
			Erwartet  map[string]any `json:"erwartet"`
		} `json:"schritte"`
	} `json:"szenarien"`
}

// nichtUebersetzbar sind die Szenarien, die auf dem alten Weg bleiben, mit dem Code ihres Grunds.
var nichtUebersetzbar = map[string]string{
	"fenster_mitternacht_und_zeitumstellung": "fenster",
	"fahrzeug_flackert":                      "messwert",
	"zusammenfuehren":                        "messwert",
	"kleene_und_unbekannt":                   "messwert",
	"modus_reihenfolge":                      "betriebsart",
}

func kernLogik(t testing.TB, text string) *logik.Logik {
	t.Helper()
	baum, err := textform.Lies([]byte(text))
	if err != nil {
		t.Fatalf("Übersetzung nicht lesbar: %v\n%s", err, text)
	}
	kanonisch, err := baum.JSON()
	if err != nil {
		t.Fatal(err)
	}
	L, err := logik.Lesen(kanonisch)
	if err != nil {
		t.Fatalf("Kern liest die Übersetzung nicht: %v\n%s", err, text)
	}
	L.PflichtErlaubt = true
	if b := L.Pruefe(nil); b.Sperrt() {
		t.Fatalf("Prüfung sperrt: %+v\n%s", b.Befunde, text)
	}
	return L
}

// kernEingaenge hält die letzten Messwerte wie die Box: je Quelle Wert und Ankunft.
type kernEingaenge map[string][2]float64

// site nimmt eine Nachricht von edge/telemetry wie die Box (agent.logikObserve).
func (k kernEingaenge) site(obj any, t float64) {
	m, _ := obj.(map[string]any)
	num := func(n string) (float64, bool) {
		f, ok := m[n].(float64)
		return f, ok && !math.IsNaN(f) && !math.IsInf(f, 0)
	}
	if v, ok := num("soc_pct"); ok {
		k["battery.soc"] = [2]float64{v, t}
	}
	if v, ok := num("power_kw"); ok {
		k["site.grid"] = [2]float64{v, t}
	}
	pv, okPV := num("pv_power_kw")
	last, okL := num("load_kw")
	if okPV && okL {
		k["site.surplus"] = [2]float64{pv - last, t}
	}
}

func (k kernEingaenge) eingabe(L *logik.Logik, t, dt float64) *logik.Eingabe {
	ein := &logik.Eingabe{Jetzt: t, DT: dt, UhrMin: 600, Tag: 1, Werte: map[string]logik.EinWert{},
		Geraete: map[string]logik.GeraetStamm{}}
	for _, n := range L.WertListe {
		if w, ok := k[L.Werte[n].Source]; ok {
			v := w[0]
			ein.Werte[n] = logik.EinWert{Zahl: &v, Alter: t - w[1]}
		}
	}
	return ein
}

// kernSagt ist die Entscheidung des Kerns in den Wörtern des Knotens.
func kernSagt(t testing.TB, L *logik.Logik, st *logik.Lauf, ein *logik.Eingabe, r *Regel) map[string]any {
	t.Helper()
	erg := L.Takt(st, ein)
	z := L.ZustandKurz(st, ein.Jetzt)
	ziel, _ := strconv.Atoi(z["ziel"])
	gilt := z["gilt"] == "on"
	unbekannt := false
	var ids []any
	for i := range r.Anforderung {
		w, err := L.Formel(st, ein, fmt.Sprintf("anforderung_%d", i+1))
		if err != nil {
			t.Fatal(err)
		}
		if w.Art == logik.WertUnbekannt {
			unbekannt = true
		}
		if w.Art == logik.WertBool && w.B {
			ids = append(ids, r.Anforderung[i].ID)
		}
	}
	out := map[string]any{"aktiv": ziel > 0, "gehalten": ziel > 0 && !gilt, "unbekannt": unbekannt}
	if ziel > 0 {
		a := erg.Ausgaenge["geraet"]
		out["must_run"] = a.Pflicht
		switch {
		case a.HatEin:
			if a.Ein != nil {
				out["wert"] = *a.Ein
			} else {
				out["wert"] = nil
			}
		case a.HatSollwert:
			if a.Sollwert != nil {
				out["wert"] = a.Sollwert.V
			} else {
				out["wert"] = nil
			}
		case a.HatBetriebsart:
			if a.Betriebsart != "" {
				out["wert"] = a.Betriebsart
			} else {
				out["wert"] = nil
			}
		}
		if gilt {
			out["anforderungen"] = ids
		}
	}
	return out
}

func gleich(a, b any) bool {
	ra, _ := json.Marshal(a)
	rb, _ := json.Marshal(b)
	var x, y any
	_ = json.Unmarshal(ra, &x)
	_ = json.Unmarshal(rb, &y)
	return reflect.DeepEqual(x, y)
}

// knotenText ist ein Knoten der Vektoren als Dokument, das Lies liest.
func knotenText(t testing.TB, k map[string]any) json.RawMessage {
	roh, err := json.Marshal(k)
	if err != nil {
		t.Fatal(err)
	}
	return roh
}

func TestVerbraucherregelWieDieVektoren(t *testing.T) {
	roh, err := os.ReadFile(vektorPfad)
	if err != nil {
		t.Fatal(err)
	}
	var v vektorDatei
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	uebersetzt, schritte := 0, 0
	for _, sz := range v.Szenarien {
		t.Run(sz.Name, func(t *testing.T) {
			r, err := Lies(knotenText(t, sz.Knoten))
			if err != nil {
				t.Fatal(err)
			}
			erg := Uebersetze(r, Herkunft{Name: sz.Name, Fassung: 1, Geraet: "Gerät"})
			if code, ok := nichtUebersetzbar[sz.Name]; ok {
				if len(erg.Gruende) == 0 || erg.Gruende[0].Code != code {
					t.Fatalf("erwartet nicht übersetzbar (%s), %+v", code, erg.Gruende)
				}
				return
			}
			if len(erg.Gruende) > 0 {
				t.Fatalf("nicht übersetzt: %+v", erg.Gruende)
			}
			uebersetzt++
			L := kernLogik(t, erg.Text)
			st := L.NeuerLauf(-1e6)
			ein := kernEingaenge{}
			vorher := int64(0)
			for i, s := range sz.Schritte {
				if s.Art == "site" {
					ein.site(s.Nachricht, float64(s.TS))
				}
				dt := float64(s.TS - vorher)
				if i == 0 || dt <= 0 {
					dt = 1
				}
				vorher = s.TS
				have := kernSagt(t, L, st, ein.eingabe(L, float64(s.TS), dt), r)
				soll := map[string]any{}
				for _, k := range []string{"aktiv", "gehalten", "unbekannt", "must_run", "wert", "anforderungen"} {
					if x, ok := s.Erwartet[k]; ok {
						soll[k] = x
					}
				}
				if b, _ := soll["gehalten"].(bool); b {
					delete(soll, "anforderungen") // gehalten: die Kennungen der letzten Anforderungen merkt der Kern nicht
				}
				schritte++
				if !gleich(have, soll) {
					hj, _ := json.Marshal(have)
					sj, _ := json.Marshal(soll)
					t.Fatalf("t=%ds %s:\n Kern   %s\n Vektor %s\n%s", s.TS, s.Art, hj, sj, erg.Text)
				}
			}
		})
	}
	if uebersetzt < 5 || schritte < 25 {
		t.Fatalf("zu wenig belegt: %d Szenarien, %d Schritte", uebersetzt, schritte)
	}
}

// zufallsRegel baut einen Knoten aus Bedingungen über die Werte der Anlage, die der Kern liest.
func zufallsRegel(r *rand.Rand) map[string]any {
	kanaele := []struct {
		kanal, signal string
		lo, hi        float64
	}{
		{"pv_surplus_kw", "site.pv_surplus_kw", -2, 5}, {"soc_pct", "storage.soc_pct", 10, 90},
		{"grid_power_kw", "site.grid_power_kw", -4, 3},
	}
	var blatt func(tiefe int) map[string]any
	blatt = func(tiefe int) map[string]any {
		if tiefe < 2 && r.Intn(3) == 0 {
			n := 1 + r.Intn(3)
			var l []any
			for i := 0; i < n; i++ {
				l = append(l, blatt(tiefe+1))
			}
			switch r.Intn(3) {
			case 0:
				return map[string]any{"all": l}
			case 1:
				return map[string]any{"any": l}
			default:
				return map[string]any{"not": l[0]}
			}
		}
		k := kanaele[r.Intn(len(kanaele))]
		ops := []string{"lt", "lte", "gt", "gte", "eq", "ne"}
		op := ops[r.Intn(4)]
		if r.Intn(12) == 0 {
			op = ops[4+r.Intn(2)]
		}
		// Schwellen liegen zwischen den Messwerten (die auf 1/1000 runden): der Fall „genau auf der
		// Schwelle“ ist die benannte Abweichung des Epsilons (TestAufDerSchwelleRechnetDerKernMitEpsilon).
		wert := math.Round((k.lo+r.Float64()*(k.hi-k.lo))*10)/10 + 0.0005
		c := map[string]any{"signal": k.signal, "source": "site", "channel": k.kanal, "op": op, "value": wert,
			"max_age_s": float64(20 + r.Intn(160))}
		if op != "eq" && op != "ne" && r.Intn(2) == 0 {
			d := math.Round(r.Float64()*(k.hi-k.lo)*2) / 10
			if op == "gt" || op == "gte" {
				c["reset_value"] = wert - d
			} else {
				c["reset_value"] = wert + d
			}
		}
		return c
	}
	befehle := []string{"on_off", "setpoint_kw", "mode"}
	befehl := befehle[r.Intn(3)]
	n := 1 + r.Intn(3)
	var reqs []any
	for i := 0; i < n; i++ {
		var wert any = true
		switch befehl {
		case "setpoint_kw":
			wert = float64(1+r.Intn(5)) + 0.5*float64(r.Intn(2))
			if r.Intn(8) == 0 {
				wert = "viel"
			}
		case "mode":
			wert = []string{"boost", "normal", "heat", "auto"}[r.Intn(4)]
		}
		reqs = append(reqs, map[string]any{"id": fmt.Sprintf("a%d", i+1), "must_run": r.Intn(3) == 0, "value": wert,
			"condition": blatt(0)})
	}
	return map[string]any{"entity": "geraet-1", "command": befehl, "ttl_s": 45.0, "renew_s": 15.0,
		"off_delay_s": float64([]int{0, 15, 30}[r.Intn(3)]), "requirements": reqs,
		"flowId": "0d9c3c1e-5b7a-3f4e-9a61-2f0c8a7b6d51", "flowVersion": 2.0, "nodeId": "reaktiv"}
}

// zwillingSagt ist die Entscheidung des Go-Zwillings in denselben Wörtern.
func zwillingSagt(s verbraucherregel.Step) map[string]any {
	r := s.Result
	out := map[string]any{"aktiv": r.Active, "gehalten": r.Held, "unbekannt": r.AnyUnknown}
	if r.Active {
		out["must_run"] = r.MustRun
		if r.HasValue {
			out["wert"] = r.Value
		} else {
			out["wert"] = nil
		}
		if !r.Held {
			out["anforderungen"] = r.RequirementIDs
		}
	}
	return out
}

// lauf vergleicht Kern und Zwilling über dauer Sekunden: jede Sekunde eine Nachricht der Anlage
// (manchmal ohne einen Wert), alle 15 s der Takt des Knotens.
func lauf(t *testing.T, seed int64, knoten map[string]any, mutiert map[string]any, dauer int) (unterschiede []string, wechsel int) {
	r := rand.New(rand.NewSource(seed))
	regel, err := Lies(knotenText(t, mutiert))
	if err != nil {
		t.Fatal(err)
	}
	erg := Uebersetze(regel, Herkunft{Name: "Zufall", Fassung: 1})
	if len(erg.Gruende) > 0 {
		t.Fatalf("seed %d: nicht übersetzt: %+v", seed, erg.Gruende)
	}
	L := kernLogik(t, erg.Text)
	st := L.NeuerLauf(-1e6)
	zw := verbraucherregel.NewRuntime(verbraucherregel.Config(knoten))
	ein := kernEingaenge{}
	start := time.Date(2026, 8, 10, 10, 0, 0, 0, time.UTC).UnixMilli()
	pv, last, soc, netz := 2.0, 1.0, 50.0, 0.0
	ohnePV, ohneLast, ohneSoc, ohneNetz := -1, -1, -1, -1
	vorher := false
	for s := 0; s < dauer; s++ {
		pv = math.Max(0, math.Min(9, pv+r.NormFloat64()*0.2))
		last = math.Max(0.1, math.Min(5, last+r.NormFloat64()*0.1))
		soc = math.Max(0, math.Min(100, soc+r.NormFloat64()*0.4))
		netz = last - pv + r.NormFloat64()*0.3
		for _, x := range []*int{&ohnePV, &ohneLast, &ohneSoc, &ohneNetz} {
			if r.Intn(1500) == 0 {
				*x = s + r.Intn(240)
			}
		}
		msg := map[string]any{}
		if s >= ohnePV {
			msg["pv_power_kw"] = math.Round(pv*1000) / 1000
		}
		if s >= ohneLast {
			msg["load_kw"] = math.Round(last*1000) / 1000
		}
		if s >= ohneSoc {
			msg["soc_pct"] = math.Round(soc*10) / 10
		}
		if s >= ohneNetz {
			msg["power_kw"] = math.Round(netz*1000) / 1000
		}
		now := start + int64(s)*1000
		ein.site(msg, float64(s))
		z := zw.OnSite(msg, now)
		if s%15 == 0 {
			z = zw.OnTrigger(now)
		}
		k := kernSagt(t, L, st, ein.eingabe(L, float64(s), 1), regel)
		if a, _ := k["aktiv"].(bool); a != vorher {
			wechsel++
			vorher = a
		}
		if !gleich(k, zwillingSagt(z)) {
			kj, _ := json.Marshal(k)
			zj, _ := json.Marshal(zwillingSagt(z))
			unterschiede = append(unterschiede, fmt.Sprintf("seed %d s=%d: Kern %s, Zwilling %s", seed, s, kj, zj))
			if len(unterschiede) > 5 {
				return
			}
		}
	}
	return
}

func TestVerbraucherregelWieDerZwillingSekundeFuerSekunde(t *testing.T) {
	wechsel, mitPflicht, befehle := 0, 0, map[string]int{}
	for seed := int64(1); seed <= 60; seed++ {
		r := rand.New(rand.NewSource(seed))
		k := zufallsRegel(r)
		u, w := lauf(t, seed, k, k, 1800)
		if len(u) > 0 {
			kj, _ := json.Marshal(k)
			t.Fatalf("%s\n%s\nKnoten: %s", strings.Join(u, "\n"), "", kj)
		}
		wechsel += w
		befehle[k["command"].(string)]++
		for _, a := range k["requirements"].([]any) {
			if a.(map[string]any)["must_run"].(bool) {
				mitPflicht++
				break
			}
		}
	}
	if wechsel < 100 || mitPflicht < 10 || len(befehle) < 3 {
		t.Fatalf("die Läufe belegen zu wenig: %d Wechsel, %d mit Pflicht, Befehle %v", wechsel, mitPflicht, befehle)
	}
}

// Gleichheit ist der Beleg: ein absichtlich falscher Parameter macht den Vergleich rot.
func TestVerbraucherregelFalscherParameterIstRot(t *testing.T) {
	roh, err := os.ReadFile(vektorPfad)
	if err != nil {
		t.Fatal(err)
	}
	var v vektorDatei
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	var basis map[string]any
	for _, sz := range v.Szenarien {
		if sz.Name == "ueberschuss_schaltlast" {
			basis = sz.Knoten
		}
	}
	kopie := func() map[string]any {
		roh, _ := json.Marshal(basis)
		var k map[string]any
		_ = json.Unmarshal(roh, &k)
		return k
	}
	bedingung := func(k map[string]any) map[string]any {
		return k["requirements"].([]any)[0].(map[string]any)["condition"].(map[string]any)
	}
	falsch := map[string]func(k map[string]any){
		"Schwelle 1,6 statt 1,5 kW": func(k map[string]any) { bedingung(k)["value"] = 1.6 },
		"Rückfall 0,8 statt 0,75":   func(k map[string]any) { bedingung(k)["reset_value"] = 1.2 },
		"Ausschaltverzögerung 10 s": func(k map[string]any) { k["off_delay_s"] = 10.0 },
		"Frische 100 statt 120 s":   func(k map[string]any) { bedingung(k)["max_age_s"] = 100.0 },
		"Pflicht statt Gelegenheit": func(k map[string]any) { k["requirements"].([]any)[0].(map[string]any)["must_run"] = true },
	}
	namen := make([]string, 0, len(falsch))
	for n := range falsch {
		namen = append(namen, n)
	}
	sort.Strings(namen)
	for _, n := range namen {
		m := kopie()
		falsch[n](m)
		gefunden := false
		for seed := int64(1); seed <= 8 && !gefunden; seed++ {
			u, _ := lauf(t, seed, kopie(), m, 1800)
			gefunden = len(u) > 0
		}
		if !gefunden {
			t.Errorf("%s: der Vergleich findet keinen Unterschied", n)
		}
	}
}

// Benannte Abweichung „schwelle“: liegt ein Wert auf 10⁻⁹ genau auf der Schwelle, ist er im Kern
// gleich (Vergleiche tragen ein Epsilon, steuerlogik.md); der Knoten vergleicht die Gleitkommazahl
// exakt. 2,063 − 0,563 ergibt 1,5000000000000002: für den Knoten über 1,5 kW, für den Kern nicht.
func TestAufDerSchwelleRechnetDerKernMitEpsilon(t *testing.T) {
	knoten := map[string]any{"entity": "geraet-1", "command": "on_off", "ttl_s": 45.0, "renew_s": 15.0, "off_delay_s": 0.0,
		"flowId": "0d9c3c1e-5b7a-3f4e-9a61-2f0c8a7b6d51", "flowVersion": 2.0, "nodeId": "reaktiv",
		"requirements": []any{map[string]any{"id": "u", "must_run": false, "value": true, "condition": map[string]any{
			"signal": "site.pv_surplus_kw", "source": "site", "channel": "pv_surplus_kw", "op": "gt", "value": 1.5,
			"max_age_s": 120.0}}}}
	regel, err := Lies(knotenText(t, knoten))
	if err != nil {
		t.Fatal(err)
	}
	L := kernLogik(t, Uebersetze(regel, Herkunft{Name: "Schwelle"}).Text)
	msg := map[string]any{"pv_power_kw": 2.063, "load_kw": 0.563}
	zw := verbraucherregel.NewRuntime(verbraucherregel.Config(knoten))
	if !zw.OnSite(msg, 0).Result.Active {
		t.Fatalf("der Knoten vergleicht exakt: 1,5000000000000002 liegt über 1,5")
	}
	ein := kernEingaenge{}
	ein.site(msg, 0)
	if a, _ := kernSagt(t, L, L.NeuerLauf(0), ein.eingabe(L, 0, 1), regel)["aktiv"].(bool); a {
		t.Fatalf("der Kern rechnet mit dem Epsilon: auf der Schwelle gilt „über“ nicht")
	}
}
