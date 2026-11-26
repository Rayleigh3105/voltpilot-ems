package steuerplan

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// huaweiGeraet is a SUN2000 + LUNA2000 behind the session: the window
// registers as the field device held them (25.11.2026), every call recorded.
type huaweiGeraet struct {
	regs     map[int]int
	ablauf   []string
	stumm    map[int]bool // reads fail
	stur     map[int]bool // writes are taken but not kept
	schreibe map[int]int
}

func neuesHuaweiGeraet() *huaweiGeraet {
	return &huaweiGeraet{regs: map[int]int{47086: 2, 47075: 7000, 47077: 3300},
		stumm: map[int]bool{}, stur: map[int]bool{}, schreibe: map[int]int{}}
}

func (g *huaweiGeraet) Lies(_ context.Context, addr, worte int) (int, error) {
	g.ablauf = append(g.ablauf, "lies "+itoa(addr)+"/"+itoa(worte))
	if g.stumm[addr] {
		return 0, errors.New("timeout")
	}
	return g.regs[addr], nil
}

func (g *huaweiGeraet) Schreibe(_ context.Context, addr, worte, wert int) error {
	g.ablauf = append(g.ablauf, "schreibe "+itoa(addr)+"/"+itoa(worte)+"="+itoa(wert))
	g.schreibe[addr]++
	if !g.stur[addr] {
		g.regs[addr] = wert
	}
	return nil
}

func (g *huaweiGeraet) geschrieben() []string {
	var out []string
	for _, a := range g.ablauf {
		if strings.HasPrefix(a, "schreibe") {
			out = append(out, a)
		}
	}
	return out
}

var huaweiJetzt = time.Date(2026, 11, 26, 11, 0, 0, 0, time.UTC)

func huaweiSollwert(kw float64, extra Obj) Obj {
	sp := Obj{"battery_setpoint_kw": kw, "control_enabled": true, "device_certified": true,
		"ts": isoMillis(huaweiJetzt.Add(-5 * time.Second))}
	for k, v := range extra {
		sp[k] = v
	}
	return sp
}

func huaweiAuswahl(conn Obj) Obj {
	c := Obj{"ip": "192.168.2.170", "port": 502.0, "unit_id": 1.0}
	for k, v := range conn {
		c[k] = v
	}
	return Obj{"schema_version": "1.0", "brand": "huawei", "model": "sun2000-m1", "family": "huawei_sun2000_luna",
		"communication": CommHuawei, "connection": c}
}

func planHuaweiTest(kw float64, extra Obj, frei, mitAusgang bool) HuaweiEntscheid {
	return HuaweiPlanen(HuaweiEingabe{Selection: huaweiAuswahl(nil), Setpoint: huaweiSollwert(kw, extra),
		Freigegeben: frei, MitAusgang: mitAusgang, Now: huaweiJetzt})
}

func zielAdressen(s []HuaweiSchritt) []int {
	out := make([]int, len(s))
	for i, x := range s {
		out[i] = x.Feld.Addr
	}
	return out
}

func TestHuaweiPlanenWaehltDieFolgeDesFensterpfads(t *testing.T) {
	for _, f := range []struct {
		name  string
		kw    float64
		extra Obj
		folge string
		grund string
	}{
		{"Laden: Entladen gesperrt", 1.2, nil, FolgeEntladenSperren, ""},
		{"Netzladen erlaubt, aber für Huawei gesperrt", 1.2, Obj{"grid_charge_allowed": true}, FolgeEntladenSperren, "sperrt nur das Entladen"},
		{"Halten: Entladen gesperrt", 0, nil, FolgeEntladenSperren, ""},
		{"Decken: Entladen frei", -0.8, nil, FolgeEntladenFrei, ""},
		{"Kalibrierung ohne Zertifikat", 0.5, Obj{"device_certified": false, "calibration": true}, FolgeEntladenSperren, ""},
	} {
		e := planHuaweiTest(f.kw, f.extra, true, false)
		if e.Folge != f.folge || e.Gesperrt || !equalInts(zielAdressen(e.Schritte), []int{47077}) ||
			(f.grund == "" && e.Grund != "") || !strings.Contains(e.Grund, f.grund) {
			t.Errorf("%s: %+v", f.name, e)
		}
		if s := e.Schritte[0]; (f.folge == FolgeEntladenFrei) != s.AusAusgang || (!s.AusAusgang && s.Wert != 0) {
			t.Errorf("%s: 47077 %+v", f.name, s)
		}
	}
	// The sign hatch turns the setpoint around.
	e := HuaweiPlanen(HuaweiEingabe{Selection: huaweiAuswahl(Obj{"invert_control_sign": true}),
		Setpoint: huaweiSollwert(1.0, nil), Freigegeben: true, Now: huaweiJetzt})
	if e.Folge != FolgeEntladenFrei {
		t.Errorf("Vorzeichenklappe: %+v", e)
	}
}

func TestHuaweiPlanenHaeltJedesTorUndGibtZurueck(t *testing.T) {
	for _, f := range []struct {
		name  string
		extra Obj
		frei  bool
		grund string
	}{
		{"keine Edge-Light-Freigabe", nil, false, "noch nicht freigegeben"},
		{"Not-Aus", Obj{"control_enabled": false}, true, "Not-Aus"},
		{"nicht zertifiziert", Obj{"device_certified": false}, true, "nicht zertifiziert"},
		{"Sollwert veraltet", Obj{"ts": isoMillis(huaweiJetzt.Add(-21 * time.Minute))}, true, "veraltet"},
	} {
		e := planHuaweiTest(1.0, f.extra, f.frei, false)
		if !e.Gesperrt || e.Folge != "" || len(e.Schritte) != 0 || !strings.Contains(e.Grund, f.grund) {
			t.Errorf("%s ohne Ausgang: %+v", f.name, e)
		}
		e = planHuaweiTest(1.0, f.extra, f.frei, true)
		if !e.Gesperrt || e.Folge != FolgeRueckgabe || !equalInts(zielAdressen(e.Schritte), []int{47077}) || !e.Schritte[0].AusAusgang {
			t.Errorf("%s mit Ausgang: Rückgabe erwartet: %+v", f.name, e)
		}
	}
	if e := planHuaweiTest(1.0, Obj{"device_certified": false}, true, false); e.Certified {
		t.Error("ohne Zertifizierung nicht zertifiziert")
	}
	if e := planHuaweiTest(1.0, nil, false, false); e.Certified {
		t.Error("ohne Freigabe nicht zertifiziert")
	}
}

func lauf(e HuaweiEntscheid, ausgang map[int]int, budget TouBudget, sichern func(map[int]int) error) HuaweiLauf {
	return HuaweiLauf{Entscheid: e, Family: "huawei_sun2000_luna", Setpoint: huaweiSollwert(1, nil), Ausgang: ausgang,
		Budget: budget, Limit: 20, Sichern: sichern, Now: huaweiJetzt}
}

// Only 47077 is written; 47075, 47086 and the grid-charge registers never.
func nurEntladegrenze(t *testing.T, g *huaweiGeraet) {
	t.Helper()
	for _, w := range g.geschrieben() {
		if !strings.HasPrefix(w, "schreibe 47077/2=") {
			t.Fatalf("nur die Entladegrenze darf geschrieben werden: %v", g.geschrieben())
		}
	}
}

func TestHuaweiAusfuehrenSichertSchreibtNurAbweichendesUndGibtZurueck(t *testing.T) {
	g := neuesHuaweiGeraet()
	var gesichert map[int]int
	sichern := func(a map[int]int) error {
		g.ablauf = append(g.ablauf, "sichern")
		gesichert = a
		return nil
	}
	ctx := context.Background()
	budget := TouBudget{Day: TouBudgetDay(huaweiJetzt)}

	// Halten: the mode is read first, the Ausgang (47077) stored before the write.
	res := HuaweiAusfuehren(ctx, lauf(planHuaweiTest(0, nil, true, false), nil, budget, sichern), g)
	if len(gesichert) != 1 || gesichert[47077] != 3300 {
		t.Fatalf("Ausgang: %v", gesichert)
	}
	if got := strings.Join(g.ablauf, ","); !strings.HasPrefix(got, "lies 47086/1,lies 47077/2,sichern,schreibe 47077/2=0") {
		t.Fatalf("Modus lesen, Ausgang sichern, dann schreiben (U32): %s", got)
	}
	if !res.Geschrieben || res.Budget.Changes != 1 || res.Ausgang[47077] != 3300 || Form(res.Payload, "")["verify"] != CycleHeld {
		t.Fatalf("Halten: %+v %v", res, Form(res.Payload, ""))
	}

	// Laden: the same 47077 = 0 - nothing written, nothing spent.
	g.ablauf = nil
	res = HuaweiAusfuehren(ctx, lauf(planHuaweiTest(1.5, nil, true, true), res.Ausgang, res.Budget, sichern), g)
	if len(g.geschrieben()) != 0 || res.Geschrieben || res.Budget.Changes != 1 || Form(res.Payload, "")["all_match"] != true {
		t.Fatalf("gleicher Wert: %v %+v", g.geschrieben(), res)
	}

	// Decken: discharging back to the device's own 3300 W.
	g.ablauf = nil
	res = HuaweiAusfuehren(ctx, lauf(planHuaweiTest(-1, nil, true, true), res.Ausgang, res.Budget, sichern), g)
	if got := g.geschrieben(); !equalStrings(got, []string{"schreibe 47077/2=3300"}) {
		t.Fatalf("Decken: %v", got)
	}

	// The handback after a Halten: 47077 back, the Ausgang cleared once held.
	res = HuaweiAusfuehren(ctx, lauf(planHuaweiTest(0, nil, true, true), res.Ausgang, res.Budget, sichern), g)
	g.ablauf = nil
	res = HuaweiAusfuehren(ctx, lauf(planHuaweiTest(1, Obj{"control_enabled": false}, true, true), res.Ausgang, res.Budget, sichern), g)
	f := Form(res.Payload, "")
	if g.regs[47077] != 3300 || g.regs[47075] != 7000 || g.regs[47086] != 2 || res.Ausgang != nil ||
		f["mode"] != "release" || f["verify"] != CycleHeld || f["blocked"] != true {
		t.Fatalf("Rückgabe: %v %+v %v", g.regs, res, f)
	}
	if strings.Contains(strings.Join(g.ablauf, ","), "sichern") || strings.Contains(strings.Join(g.ablauf, ","), "lies 47086") {
		t.Fatalf("die Rückgabe sichert nichts und braucht keinen Modus: %v", g.ablauf)
	}
	nurEntladegrenze(t, g)
}

// The lever was measured in mode 2 only: in another mode nothing is written,
// and what the box wrote before goes back.
func TestHuaweiAusfuehrenNurImEigenverbrauch(t *testing.T) {
	g := neuesHuaweiGeraet()
	g.regs[47086] = 5
	res := HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, false), nil,
		TouBudget{Day: TouBudgetDay(huaweiJetzt)}, nil), g)
	if len(g.geschrieben()) != 0 || res.Ausgang != nil || !strings.Contains(str(res.Payload["reason"]), "47086 = 5") {
		t.Fatalf("anderer Modus: %v %+v", g.geschrieben(), res)
	}
	g.regs[47077] = 0
	res = HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, true), map[int]int{47077: 3300},
		TouBudget{Day: TouBudgetDay(huaweiJetzt)}, nil), g)
	if g.regs[47077] != 3300 || res.Ausgang != nil || Form(res.Payload, "")["mode"] != "release" {
		t.Fatalf("anderer Modus mit Ausgang -> Rückgabe: %v %+v", g.regs, res)
	}
}

func TestHuaweiAusfuehrenSchreibtNieOhneGesicherteAusgangswerte(t *testing.T) {
	g := neuesHuaweiGeraet()
	budget := TouBudget{Day: TouBudgetDay(huaweiJetzt)}
	res := HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, false), nil, budget,
		func(map[int]int) error { return errors.New("Platte voll") }), g)
	if len(g.geschrieben()) != 0 || res.Ausgang != nil || !strings.Contains(res.Warnung, "nicht gesichert") {
		t.Fatalf("%v %+v", g.geschrieben(), res)
	}
	g = neuesHuaweiGeraet()
	g.stumm[47077] = true
	res = HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, false), nil, budget, nil), g)
	if len(g.geschrieben()) != 0 || res.Ausgang != nil || !strings.Contains(res.Warnung, "nicht lesbar") {
		t.Fatalf("unlesbarer Ausgang: %v %+v", g.geschrieben(), res)
	}
	g = neuesHuaweiGeraet()
	g.stumm[47086] = true
	res = HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, false), nil, budget, nil), g)
	if len(g.geschrieben()) != 0 || !strings.Contains(res.Warnung, "Arbeitsmodus nicht lesbar") {
		t.Fatalf("unlesbarer Modus: %v %+v", g.geschrieben(), res)
	}
	// A device that already holds the plan leaves nothing to give back.
	g = neuesHuaweiGeraet()
	g.regs[47077] = 0
	res = HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, false), nil, budget, nil), g)
	if len(g.geschrieben()) != 0 || res.Ausgang != nil {
		t.Fatalf("schon gehalten: %v %+v", g.geschrieben(), res)
	}
}

func TestHuaweiAusfuehrenMeldetAbweichungUndBehaeltDenAusgang(t *testing.T) {
	g := neuesHuaweiGeraet()
	g.stur[47077] = true
	ausgang := map[int]int{47077: 3300}
	res := HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, true), ausgang,
		TouBudget{Day: TouBudgetDay(huaweiJetzt)}, nil), g)
	f := Form(res.Payload, "")
	if f["verify"] != CycleMismatch || !equalAny(f["mismatch_roles"], "max_discharge_power") {
		t.Fatalf("%v", f)
	}
	// A handback that does not hold keeps the Ausgang for the next tick.
	g.regs[47077] = 0 // the box had blocked discharging; the register now refuses the way back
	res = HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, Obj{"control_enabled": false}, true, true), ausgang,
		res.Budget, nil), g)
	if res.Ausgang == nil {
		t.Fatal("nicht gehaltene Rückgabe muss den Ausgang behalten")
	}
}

func TestHuaweiTagesbudgetBehaeltDieRueckgabe(t *testing.T) {
	g := neuesHuaweiGeraet()
	ausgang := map[int]int{47077: 3300}
	g.regs[47077] = 0                                              // the box blocks discharging
	voll := TouBudget{Day: TouBudgetDay(huaweiJetzt), Changes: 19} // 19 + 2 > 20: no room for a change
	res := HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(-1, nil, true, true), ausgang, voll, nil), g)
	f := Form(res.Payload, "")
	if g.regs[47077] != 3300 || f["mode"] != "release" || !res.Budget.Held ||
		res.Budget.Changes != 20 || res.Ausgang != nil || !strings.Contains(str(f["reason"]), "Tagesbudget") {
		t.Fatalf("Budget erreicht -> Rückgabe: %v %+v %v", g.regs, res, f)
	}
	// Held for the day: the next change writes nothing, not even a new Ausgang.
	g.ablauf = nil
	res = HuaweiAusfuehren(context.Background(), lauf(planHuaweiTest(0, nil, true, false), nil, res.Budget, nil), g)
	if len(g.geschrieben()) != 0 || res.Ausgang != nil || Form(res.Payload, "")["blocked"] != true {
		t.Fatalf("gehalten: %v %+v", g.geschrieben(), res)
	}
}

func TestHuaweiAusgangDauerhaft(t *testing.T) {
	a := map[int]int{47077: 3300}
	o := HuaweiAusgangObj(a, "192.168.2.170", 502, 1, huaweiJetzt)
	back := HuaweiAusgangAus(o)
	if back[47077] != 3300 || len(back) != 1 || o["unit_id"] != 1.0 {
		t.Fatalf("%v %v", o, back)
	}
	delete(obj(o["regs"]), "47077")
	if HuaweiAusgangAus(o) != nil {
		t.Fatal("ein unvollständiger Ausgang ist keiner")
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalAny(v any, want ...string) bool {
	l, ok := v.([]any)
	if !ok || len(l) != len(want) {
		return false
	}
	for i := range l {
		if l[i] != want[i] {
			return false
		}
	}
	return true
}
