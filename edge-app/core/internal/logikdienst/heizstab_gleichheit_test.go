package logikdienst

// Der Gleichheitsbeleg des Heizstab-Reglers (Stufe 6, Zusammenführen, dritter Teil): der Baustein,
// gefüllt aus dem Parameterblock, entscheidet im Kern wie der Regler der Box (internal/heizstab):
//   - an jedem Schritt der 16 Szenarien von heizstab-regler-vectors.json: Stufe, Wechsel, Code (über
//     den Titel der Lage), der Satz des Reglers und „höher ab“;
//   - über lange Zufallsläufe Sekunde für Sekunde gegen hz.Step selbst, mit wechselnden
//     Parametern, Speicher, fehlenden Messwerten und gesenkter höchster Stufe.
// Ein absichtlich falscher Parameter macht den Vergleich rot (TestHeizstabFalscherParameterIstRot).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"os"
	"strings"
	"testing"
	"time"

	hz "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/heizstab"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logik/textform"
)

const (
	heizstabVektorPfad   = "../../../../docs/contracts/v2/heizstab-regler-vectors.json"
	heizstabBausteinPfad = "../../../../docs/contracts/v2/steuerlogik/zusammenfuehren/heizstab-regler.block.yaml"
)

// heizstabCode ordnet den Titel der Lage dem Code des Reglers zu (die Titel des Bausteins).
var heizstabCode = map[string]string{
	"Messwerte fehlen":        hz.CodeBlind,
	"Höchste Stufe gesenkt":   hz.CodeCap,
	"Kein Überschuss":         hz.CodeNoSurplus,
	"Heizt mit Überschuss":    hz.CodeSurplus,
	"Mindestlaufzeit":         hz.CodeMinRun,
	"Schaltgrenze erreicht":   hz.CodeSwitchBudget,
	"Haltezeit":               hz.CodeHold,
	"Mindestpause":            hz.CodeMinPause,
	"Überschuss wird geprüft": hz.CodeWaitUp,
}

type hzVektoren struct {
	Basis     time.Time  `json:"basis"`
	Stages    []hz.Stage `json:"stages_pro3"`
	Scenarios []struct {
		Name   string          `json:"name"`
		Params json.RawMessage `json:"params"`
		State  *struct {
			Stufe       int       `json:"stufe"`
			Seit        *float64  `json:"seit"`
			ZuletztEin  *float64  `json:"zuletzt_ein"`
			ZuletztAus  *float64  `json:"zuletzt_aus"`
			Schaltungen []float64 `json:"schaltungen"`
		} `json:"state"`
		Steps []struct {
			T       float64  `json:"t"`
			Grid    *float64 `json:"grid"`
			GridAge float64  `json:"grid_age"`
			Batt    *float64 `json:"batt"`
			Rod     *float64 `json:"rod"`
			Expect  struct {
				Stufe   int      `json:"stufe"`
				Code    string   `json:"code"`
				Changed bool     `json:"changed"`
				NextUp  *float64 `json:"next_up"`
			} `json:"expect"`
		} `json:"steps"`
	} `json:"scenarios"`
}

func liesHzVektoren(t *testing.T) hzVektoren {
	t.Helper()
	roh, err := os.ReadFile(heizstabVektorPfad)
	if err != nil {
		t.Fatal(err)
	}
	var v hzVektoren
	if err := json.Unmarshal(roh, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Scenarios) != 16 {
		t.Fatalf("erwartet 16 Szenarien, %d", len(v.Scenarios))
	}
	return v
}

func hzStufen(stages []hz.Stage) []HeizstabStufe {
	out := make([]HeizstabStufe, len(stages))
	for i, s := range stages {
		out[i] = HeizstabStufe{Ausgaenge: s.Outputs, Kw: s.Kw}
	}
	return out
}

func hzLogik(t testing.TB, text []byte) *logik.Logik {
	t.Helper()
	baum, err := textform.Lies(text)
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
	if b := L.Pruefe(nil); b.Sperrt() {
		t.Fatalf("Prüfung sperrt: %+v", b.Befunde)
	}
	return L
}

// nie ist „noch nie“: ein Zeitpunkt lange vor jedem Szenario (der Regler kennt das als Nullzeit).
const nie = -1e9

// hzStart ist der Lauf des Kerns mit dem Zustand des Reglers (Sicherung, ohne Neustart).
func hzStart(t testing.TB, L *logik.Logik, st hz.State, basis time.Time) *logik.Lauf {
	t.Helper()
	sek := func(x time.Time) float64 {
		if x.IsZero() {
			return nie
		}
		return x.Sub(basis).Seconds()
	}
	wechsel := []map[string]any{}
	for _, s := range st.Switches {
		wechsel = append(wechsel, map[string]any{"t": sek(s), "um": 1})
	}
	seitLaeuft := sek(st.LastOff)
	if st.Stage > 0 {
		seitLaeuft = sek(st.LastOn)
	}
	z := map[string]any{
		"stufe":  map[string]any{"art": "counter", "wert": st.Stage, "seit": sek(st.Since), "zuletzt": "vorher", "wechsel": wechsel},
		"laeuft": map[string]any{"art": "boolean", "an": st.Stage > 0, "seit": seitLaeuft},
		"blind":  map[string]any{"art": "boolean", "seit": nie},
		"hoeher": map[string]any{"art": "boolean", "seit": nie},
		"bezug":  map[string]any{"art": "boolean", "seit": nie},
	}
	roh, _ := json.Marshal(map[string]any{"schema_version": 1, "stellwerte": map[string]any{}, "zustaende": z,
		"geraete": map[string]any{}, "meldungen": []any{}, "tag": 0, "tag_gilt": false, "gestartet": nie})
	lauf, err := L.LadeLauf(roh, 0)
	if err != nil {
		t.Fatal(err)
	}
	return lauf
}

// hzEingang ist ein Takt des Reglers als Eingabe des Kerns.
func hzEingang(jetzt, dt float64, in hz.Inputs, basis time.Time) *logik.Eingabe {
	ein := &logik.Eingabe{Jetzt: jetzt, DT: dt, UhrMin: 720, Tag: 1, Werte: map[string]logik.EinWert{},
		Geraete: map[string]logik.GeraetStamm{}}
	if in.GridKw != nil {
		v := *in.GridKw
		ein.Werte["netz"] = logik.EinWert{Zahl: &v, Alter: in.Now.Sub(in.GridAt).Seconds()}
	}
	if in.BatteryKw != nil {
		v := *in.BatteryKw
		ein.Werte["speicher"] = logik.EinWert{Zahl: &v, Alter: in.Now.Sub(in.BatteryAt).Seconds()}
	}
	if in.RodKw != nil {
		v := *in.RodKw
		ein.Werte["stab"] = logik.EinWert{Zahl: &v}
	}
	return ein
}

// hzKern ist, was der Kern in einem Takt entscheidet, in den Wörtern des Reglers.
type hzKern struct {
	stufe   int
	code    string
	satz    string
	hoeher  float64 // Sekunden ab jetzt, 0 = keine Angabe
	gewech  bool
	vorherS int
}

func hzTakt(t testing.TB, L *logik.Logik, st *logik.Lauf, ein *logik.Eingabe, vorher int) hzKern {
	t.Helper()
	erg := L.Takt(st, ein)
	a := erg.Ausgaenge["heizstab"]
	h, err := L.Formel(st, ein, "hoeher_in")
	if err != nil {
		t.Fatalf("hoeher_in: %v", err)
	}
	k := hzKern{stufe: a.Stufe, code: heizstabCode[erg.Lage.Titel], satz: erg.Lage.Satz, vorherS: vorher}
	if h.Art == logik.WertZahl {
		k.hoeher = h.V
	}
	k.gewech = a.Stufe != vorher
	if k.code == "" {
		t.Fatalf("Lage ohne Code: %+v", erg.Lage)
	}
	return k
}

// satzGleich: der Satz der Lage beginnt mit dem Satz des Reglers (danach steht „höher ab“).
func satzGleich(kern, regler string) bool {
	k := strings.Map(func(r rune) rune {
		if r == ' ' || r == ' ' {
			return ' '
		}
		return r
	}, kern)
	return strings.HasPrefix(k, regler)
}

// hzStufeIndex: die Stufe des Kerns (Ausgänge) als Index der Stufen des Reglers.
func hzStufeIndex(stages []hz.Stage, ausgaenge int) int {
	if ausgaenge == 0 {
		return 0
	}
	for i, s := range stages {
		if s.Outputs == ausgaenge {
			return i + 1
		}
	}
	return -1
}

// hzUnterschiede vergleicht an jedem Schritt der Vektoren; textFuer baut den Text aus dem Block.
func hzUnterschiede(t testing.TB, textFuer func(p hz.Params, stufen []HeizstabStufe) []byte) []string {
	v := liesHzVektoren(t.(*testing.T))
	var aus []string
	at := func(s float64) time.Time { return v.Basis.Add(time.Duration(s * float64(time.Second))) }
	opt := func(s *float64) time.Time {
		if s == nil {
			return time.Time{}
		}
		return at(*s)
	}
	for _, sc := range v.Scenarios {
		p, ok, err := hz.ParseParams(sc.Params)
		if err != nil || !ok {
			t.Fatalf("%s: Block %v %v", sc.Name, ok, err)
		}
		var st hz.State
		if sc.State != nil {
			st = hz.State{Stage: sc.State.Stufe, Since: opt(sc.State.Seit), LastOn: opt(sc.State.ZuletztEin),
				LastOff: opt(sc.State.ZuletztAus)}
			for _, s := range sc.State.Schaltungen {
				st.Switches = append(st.Switches, at(s))
			}
		}
		L := hzLogik(t, textFuer(p, hzStufen(v.Stages)))
		lauf := hzStart(t, L, st, v.Basis)
		regler := st
		vorher, vorT := 0, 0.0
		if st.Stage > 0 {
			vorher = v.Stages[st.Stage-1].Outputs
		}
		for i, step := range sc.Steps {
			now := at(step.T)
			in := hz.Inputs{Now: now, GridKw: step.Grid, GridAt: now.Add(-time.Duration(step.GridAge * float64(time.Second))),
				BatteryKw: step.Batt, BatteryAt: now, RodKw: step.Rod}
			d := hz.Step(p, v.Stages, &regler, in)
			dt := step.T - vorT
			if i == 0 || dt <= 0 {
				dt = 1
			}
			k := hzTakt(t, L, lauf, hzEingang(step.T, dt, in, v.Basis), vorher)
			vorher, vorT = k.stufe, step.T
			e := step.Expect
			wo := fmt.Sprintf("%s t=%v", sc.Name, step.T)
			if hzStufeIndex(v.Stages, k.stufe) != e.Stufe || k.code != e.Code || k.gewech != e.Changed {
				aus = append(aus, fmt.Sprintf("%s: Kern Stufe %d %s Wechsel %v, Vektor %d %s %v", wo,
					hzStufeIndex(v.Stages, k.stufe), k.code, k.gewech, e.Stufe, e.Code, e.Changed))
				continue
			}
			if e.NextUp != nil && math.Abs(step.T+k.hoeher-*e.NextUp) > 1e-6 {
				aus = append(aus, fmt.Sprintf("%s: höher ab %v, Vektor %v", wo, step.T+k.hoeher, *e.NextUp))
			}
			// Der Regler selbst an derselben Stelle: Satz und „höher ab“ (auch wo der Vektor sie nicht nennt).
			if !satzGleich(k.satz, d.Reason) {
				aus = append(aus, fmt.Sprintf("%s: Satz %q, Regler %q", wo, k.satz, d.Reason))
			}
			if !d.NextUpAt.IsZero() && math.Abs(now.Add(time.Duration(k.hoeher*float64(time.Second))).Sub(d.NextUpAt).Seconds()) > 1e-6 {
				aus = append(aus, fmt.Sprintf("%s: höher ab %v, Regler %v", wo, k.hoeher, d.NextUpAt.Sub(now)))
			}
		}
	}
	return aus
}

func bausteinText(p hz.Params, stufen []HeizstabStufe) []byte {
	text, err := HeizstabText(p, stufen, "e-heizstab", "Heizstab", "Heizstab-Regler")
	if err != nil {
		panic(err)
	}
	return text
}

func TestHeizstabGleichheitVektoren(t *testing.T) {
	if u := hzUnterschiede(t, bausteinText); len(u) > 0 {
		t.Fatalf("%d Unterschiede:\n%s", len(u), strings.Join(u, "\n"))
	}
}

// hzLauf ist ein langer Zufallslauf, Sekunde für Sekunde, Regler gegen Kern. Gibt die
// Unterschiede und die Zahl der Stufenwechsel zurück.
func hzLauf(t *testing.T, seed int64, p hz.Params, textFuer func(p hz.Params, stufen []HeizstabStufe) []byte,
	stages []hz.Stage, dauer int) ([]string, int) {
	r := rand.New(rand.NewSource(seed))
	basis := time.Date(2026, 6, 1, 6, 0, 0, 0, time.UTC)
	L := hzLogik(t, textFuer(p, hzStufen(stages)))
	var regler hz.State
	lauf := hzStart(t, L, regler, basis)
	kwVon := func(stufe int) float64 {
		if stufe == 0 {
			return 0
		}
		return stages[stufe-1].Kw
	}
	pv, last, batt := 1.0, 0.6, 0.0
	gridAt := basis
	var aus []string
	vorher, wechsel := 0, 0
	blindBis, battWeg := -1, -1
	for s := 0; s < dauer; s++ {
		now := basis.Add(time.Duration(s) * time.Second)
		// Sonne und Haus wandern; Wolken springen; der Speicher lädt oder entlädt.
		pv = math.Max(0, pv+r.NormFloat64()*0.08)
		if r.Intn(400) == 0 {
			pv = math.Max(0, pv+r.Float64()*8-4)
		}
		pv = math.Min(pv, 10)
		last = math.Max(0.2, math.Min(4, last+r.NormFloat64()*0.05))
		if r.Intn(900) == 0 {
			batt = r.Float64()*6 - 3
		}
		if r.Intn(1800) == 0 {
			blindBis = s + 20 + r.Intn(120) // die Netzmessung bleibt aus
		}
		if r.Intn(2400) == 0 {
			battWeg = s + r.Intn(300)
		}
		stabKw := kwVon(regler.Stage)
		grid := last + stabKw + batt - pv
		if s >= blindBis {
			gridAt = now
		}
		g := math.Round(grid*1000) / 1000
		in := hz.Inputs{Now: now, GridKw: &g, GridAt: gridAt, RodKw: &stabKw}
		if s < battWeg {
			in.BatteryKw = nil
		} else {
			b := batt
			in.BatteryKw, in.BatteryAt = &b, now
		}
		if r.Intn(5000) == 0 {
			in.RodKw = nil // die Rücklesung fehlt einen Takt
		}
		d := hz.Step(p, stages, &regler, in)
		k := hzTakt(t, L, lauf, hzEingang(float64(s), 1, in, basis), vorher)
		if k.gewech {
			wechsel++
		}
		vorher = k.stufe
		wo := fmt.Sprintf("seed %d s=%d", seed, s)
		idx := hzStufeIndex(stages, k.stufe)
		if idx != d.Stage || k.code != d.Code || k.gewech != d.Changed || !satzGleich(k.satz, d.Reason) {
			aus = append(aus, fmt.Sprintf("%s: Kern %d %s %v %q, Regler %d %s %v %q", wo, idx, k.code, k.gewech, k.satz,
				d.Stage, d.Code, d.Changed, d.Reason))
		} else if !d.NextUpAt.IsZero() && math.Abs(float64(s)+k.hoeher-d.NextUpAt.Sub(basis).Seconds()) > 1e-6 {
			aus = append(aus, fmt.Sprintf("%s: höher ab +%v, Regler +%v", wo, k.hoeher, d.NextUpAt.Sub(now).Seconds()))
		}
		if len(aus) > 20 {
			break
		}
	}
	return aus, wechsel
}

func TestHeizstabGleichheitSekundeFuerSekunde(t *testing.T) {
	v := liesHzVektoren(t)
	reserve := 0.35
	faelle := []struct {
		p      hz.Params
		stages []hz.Stage
	}{
		{hz.Params{Mode: hz.ModeSurplus}, v.Stages},
		{hz.Params{Mode: hz.ModeSurplus, Order: hz.RodFirst, ReserveKw: &reserve}, v.Stages},
		{hz.Params{Mode: hz.ModeSurplus, MaxOutputs: 2, SwitchesPerHour: 4, HoldS: 30, MinRunS: 90, MinPauseS: 45}, v.Stages},
		{hz.Params{Mode: hz.ModeSurplus, SwitchesPerHour: 3, HoldS: 200}, []hz.Stage{{Outputs: 1, Kw: 1.5}, {Outputs: 3, Kw: 4.5}}},
		{hz.Params{Mode: hz.ModeSurplus, MinRunS: 600, Order: hz.RodFirst}, []hz.Stage{{Outputs: 3, Kw: 3.9}}},
	}
	for i, f := range faelle {
		for seed := int64(1); seed <= 2; seed++ {
			u, wechsel := hzLauf(t, seed*10+int64(i), f.p, bausteinText, f.stages, 5*3600)
			if len(u) > 0 {
				t.Errorf("Fall %d, seed %d: %d Unterschiede:\n%s", i, seed, len(u), strings.Join(u, "\n"))
			}
			if wechsel < 10 {
				t.Errorf("Fall %d, seed %d: nur %d Stufenwechsel - der Lauf belegt zu wenig", i, seed, wechsel)
			}
		}
	}
}

// Gleichheit ist der Beleg: ein absichtlich falscher Parameter macht den Vergleich rot.
func TestHeizstabFalscherParameterIstRot(t *testing.T) {
	v := liesHzVektoren(t)
	falsch := map[string]func(p hz.Params) hz.Params{
		"Reserve 0,3 statt 0,2 kW": func(p hz.Params) hz.Params {
			r := 0.3
			if p.ReserveKw == nil {
				p.ReserveKw = &r
			}
			return p
		},
		"Haltezeit 100 statt 120 s": func(p hz.Params) hz.Params {
			if p.HoldS == 0 {
				p.HoldS = 100
			}
			return p
		},
		"Mindestpause 280 statt 300 s": func(p hz.Params) hz.Params {
			if p.MinPauseS == 0 {
				p.MinPauseS = 280
			}
			return p
		},
		"Vorrang vertauscht": func(p hz.Params) hz.Params {
			if p.Order == hz.RodFirst {
				p.Order = hz.StorageFirst
			} else {
				p.Order = hz.RodFirst
			}
			return p
		},
	}
	for name, f := range falsch {
		text := func(p hz.Params, stufen []HeizstabStufe) []byte { return bausteinText(f(p), stufen) }
		u := hzUnterschiede(t, text)
		if len(u) == 0 {
			lauf, _ := hzLauf(t, 7, hz.Params{Mode: hz.ModeSurplus}, text, v.Stages, 4*3600)
			u = lauf
		}
		if len(u) == 0 {
			t.Errorf("%s: der Vergleich findet keinen Unterschied", name)
		}
	}
}

// Der Baustein des Vertrags IST die Übersetzung: die Kopie im Dienst ist byte-gleich, und der Text für
// drei Stufen je 2 kW mit den Vorgaben des Blocks ist genau seine Logik (ohne die Kopfzeilen).
func TestHeizstabBausteinIstDieUebersetzung(t *testing.T) {
	vertrag, err := os.ReadFile(heizstabBausteinPfad)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(vertrag, heizstabBaustein) {
		t.Fatalf("heizstab-regler.block.yaml im Dienst weicht vom Vertrag ab: neu kopieren")
	}
	b, err := LiesBaustein(heizstabBaustein)
	if err != nil {
		t.Fatal(err)
	}
	text, err := HeizstabText(hz.Params{Mode: hz.ModeSurplus},
		[]HeizstabStufe{{1, 2}, {2, 4}, {3, 6}}, "geraet-heizstab", "Heizstab", "Heizstab-Regler")
	if err != nil {
		t.Fatal(err)
	}
	ohneKopf := string(text)
	for strings.HasPrefix(ohneKopf, "#") {
		ohneKopf = ohneKopf[strings.Index(ohneKopf, "\n")+1:]
	}
	if ohneKopf != string(b.logikText) {
		t.Fatalf("Übersetzung und Baustein weichen ab:\n%s", ohneKopf)
	}
}
