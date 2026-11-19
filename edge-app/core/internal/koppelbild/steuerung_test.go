package koppelbild

import (
	"testing"
	"time"
)

// spsQuittung builds an acknowledgement of controller id with one offer per
// entry of angebot (platz -> art, min, max) and the given kopf_urteil.
func spsQuittung(id uint32, herzschlag, angenommen uint16, kopfUrteil uint16, angebot map[int][3]int64, sitzung uint16) []uint16 {
	q := make([]uint16, QWoerter)
	q[0], q[1], q[2], q[3], q[4] = sigQ[0], sigQ[1], pruefW[0], pruefW[1], version
	q[6], q[7] = herzschlag, 0x0100
	setze32(q, 8, id)
	q[10], q[11], q[14], q[15] = kopfUrteil, sitzung, 0b011, angenommen
	for n := 1; n <= Plaetze; n++ {
		b := qPlatz + (n-1)*qPlatzLaenge
		if a, da := angebot[n]; da {
			q[5]++
			q[b], q[b+1], q[b+3] = uint16(a[0]), 1, 1
			setze32(q, b+4, uint32(int32(a[1])))
			setze32(q, b+6, uint32(int32(a[2])))
		} else {
			setze32(q, b+4, s32Max)
			setze32(q, b+6, s32Max)
		}
		setze32(q, b+10, s32Max)
	}
	q[qSiegel] = siegel(q, qSiegel)
	return q
}

func u32(v uint32) *uint32 { return &v }

func platz(t *testing.T, w []uint16, n int) (art uint16, grund uint16, wert int32, folge uint16) {
	t.Helper()
	b := wPlatz + (n-1)*wPlatzLaenge
	return w[b], w[b+1], int32(roh32(w, b+2)), w[b+4]
}

func TestTelegrammFolgeUndHerzschlag(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(u32(1042), 0x3A7C)
	angebot := map[int][3]int64{1: {1, 0, 265000}}
	s.Lies(spsQuittung(1042, 10, 0, 0, angebot, 0), jetzt)
	w := s.Telegramm(map[int]Wunsch{1: {Art: "limit_w", Wert: 159000, Grund: "markt"}}, true, []string{"cloud_verbunden"}, jetzt)
	if w == nil {
		t.Fatal("kein Telegramm")
	}
	if art, grund, wert, folge := platz(t, w, 1); art != 1 || grund != 1 || wert != 159000 || folge != 1 {
		t.Fatalf("Stellplatz 1: %d %d %d %d", art, grund, wert, folge)
	}
	if w[6] != 0x3A7C || w[7] != 0 || w[10] != FristS || w[11] != 0b101 {
		t.Fatalf("Kopf: %v", w[:16])
	}
	if Crc16(append(append([]uint16{}, w[:15]...), w[16:]...)) != w[15] {
		t.Fatal("Siegel")
	}
	// derselbe Wunsch: Folge bleibt, Herzschlag zählt
	s.Lies(spsQuittung(1042, 15, 1, 1, angebot, 0x3A7C), jetzt.Add(5*time.Second))
	w = s.Telegramm(map[int]Wunsch{1: {Art: "limit_w", Wert: 159000, Grund: "markt"}}, true, nil, jetzt.Add(5*time.Second))
	if _, _, _, folge := platz(t, w, 1); folge != 1 || w[7] != 1 {
		t.Fatalf("Folge %d, Herzschlag %d", folge, w[7])
	}
	// der Wunsch fällt weg: auch das zählt (Vertrag §3, K25)
	s.Lies(spsQuittung(1042, 20, 2, 1, angebot, 0x3A7C), jetzt.Add(10*time.Second))
	w = s.Telegramm(nil, true, nil, jetzt.Add(10*time.Second))
	if art, _, wert, folge := platz(t, w, 1); art != 0 || wert != s32Max || folge != 2 {
		t.Fatalf("ohne Wunsch: %d %d %d", art, wert, folge)
	}
}

func TestOhneFreigabeLebenszeichenOhneWunsch(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(u32(7), 9)
	s.Lies(spsQuittung(7, 1, 0, 0, map[int][3]int64{1: {1, 0, 1000}}, 0), jetzt)
	w := s.Telegramm(map[int]Wunsch{1: {Art: "limit_w", Wert: 500}}, false, nil, jetzt)
	if art, _, _, _ := platz(t, w, 1); art != 0 || w[11]&0b100 != 0 {
		t.Fatalf("Schalter der Box zu: Wunsch %d, e_bits %#x", art, w[11])
	}
}

func TestWunschNurAufPassendesAngebot(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(u32(7), 9)
	s.Lies(spsQuittung(7, 1, 0, 0, map[int][3]int64{1: {4, 0, 1}}, 0), jetzt)
	w := s.Telegramm(map[int]Wunsch{1: {Art: "limit_w", Wert: 500}, 2: {Art: "on_off", Wert: 1}}, true, nil, jetzt)
	if a1, _, _, _ := platz(t, w, 1); a1 != 0 {
		t.Fatal("limit_w auf einem on_off-Angebot")
	}
	if a2, _, _, _ := platz(t, w, 2); a2 != 0 {
		t.Fatal("Wunsch auf einem leeren Platz")
	}
}

func TestNichtSchreibenOhneSollOderLesung(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(nil, 9)
	if u := s.Lies(spsQuittung(7, 1, 0, 0, nil, 0), jetzt); u.Lage != LageOhneSoll {
		t.Fatalf("Lage %s", u.Lage)
	}
	if s.Telegramm(nil, true, nil, jetzt) != nil {
		t.Fatal("ohne Soll geschrieben")
	}
	s = Neu(u32(7), 9)
	q := spsQuittung(7, 1, 0, 0, nil, 0)
	q[30] ^= 1 // halb gelesen: Siegel falsch
	if u := s.Lies(q, jetzt); u.Lage != LageNichtLesbar || s.Telegramm(nil, true, nil, jetzt) != nil {
		t.Fatalf("nicht lesbar: %+v", u)
	}
	if u := s.Lies(nil, jetzt); u.Lage != LageKeineAntwort || s.Telegramm(nil, true, nil, jetzt) != nil {
		t.Fatalf("keine Antwort: %+v", u)
	}
	if u := s.Lies(spsQuittung(8, 1, 0, 0, nil, 0), jetzt); u.Lage != LageSteuerungFremd || s.Telegramm(nil, true, nil, jetzt) != nil {
		t.Fatalf("fremde Steuerung: %+v", u)
	}
}

func TestSchaltTestGehtVorUndLaeuftAb(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(u32(0), 0x1111)
	angebot := map[int][3]int64{8: {4, 0, 1}}
	s.Lies(spsQuittung(0, 1, 0, 0, angebot, 0), jetzt)
	s.SetzeTest(&Test{Platz: 8, Art: "on_off", Wert: 1, Bis: jetzt.Add(20 * time.Second)})
	w := s.Telegramm(map[int]Wunsch{8: {Art: "on_off", Wert: 0, Grund: "regel"}}, false, nil, jetzt)
	if art, grund, wert, _ := platz(t, w, 8); art != 4 || grund != 5 || wert != 1 || w[11]&0b1000 == 0 || w[10] != 20 {
		t.Fatalf("Test: %d %d %d e_bits %#x frist %d", art, grund, wert, w[11], w[10])
	}
	s.Lies(spsQuittung(0, 2, 1, 1, angebot, 0x1111), jetzt.Add(21*time.Second))
	w = s.Telegramm(nil, true, nil, jetzt.Add(21*time.Second))
	if art, _, _, _ := platz(t, w, 8); art != 0 || w[11]&0b1000 != 0 {
		t.Fatal("der Test ist nach seiner Zeit nicht vorbei")
	}
}

func TestFaellig(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(u32(1), 5)
	s.Lies(spsQuittung(1, 1, 0, 0, nil, 0), jetzt)
	if !s.Faellig(jetzt) {
		t.Fatal("das erste Telegramm ist fällig")
	}
	s.Telegramm(nil, true, nil, jetzt)
	if s.Faellig(jetzt.Add(4 * time.Second)) {
		t.Fatal("vor dem Takt fällig")
	}
	s.Geaendert()
	if s.Faellig(jetzt.Add(900*time.Millisecond)) || !s.Faellig(jetzt.Add(time.Second)) {
		t.Fatal("bei Änderung sofort, aber höchstens eins je Sekunde")
	}
}

func TestWuenscheAus(t *testing.T) {
	kw, pct, c := 159.0004, 40.05, 21.25
	on := true
	b := Befehl{LimitKw: &kw, LimitPct: &pct, SetpointC: &c, OnOff: &on, Mode: "3", Source: "plan-executor"}
	f := []Faehigkeit{{1, "limit_kw"}, {2, "limit_pct"}, {3, "setpoint_c"}, {4, "on_off"}, {5, "mode"}, {6, "setpoint_kw"}, {9, "limit_kw"}}
	got := WuenscheAus(b, f)
	soll := map[int]Wunsch{1: {"limit_w", 159000, "markt"}, 2: {"limit_pct", 401, "markt"}, 3: {"setpoint_c", 213, "markt"},
		4: {"on_off", 1, "markt"}, 5: {"mode", 3, "markt"}}
	if len(got) != len(soll) {
		t.Fatalf("%v", got)
	}
	for n, w := range soll {
		if got[n] != w {
			t.Fatalf("Stellplatz %d: %+v statt %+v", n, got[n], w)
		}
	}
	neg := -20.0
	if w := WuenscheAus(Befehl{SetpointKw: &neg, Source: "local-ui"}, []Faehigkeit{{2, "setpoint_kw"}})[2]; w != (Wunsch{"setpoint_w", -20000, "hand"}) {
		t.Fatalf("Speicher: %+v", w)
	}
	for kommando, art := range map[string]string{"limit_kw": "limit_w", "mode": "mode", "nix": ""} {
		if ArtFuer(kommando) != art || (art != "" && KommandoFuer(art) != kommando) {
			t.Fatalf("%s <-> %s", kommando, art)
		}
	}
}

func TestStand(t *testing.T) {
	jetzt := time.Unix(1_800_000_000, 0)
	s := Neu(u32(1042), 0x3A7C)
	s.Lies(spsQuittung(1042, 10, 0, 0, map[int][3]int64{1: {1, 0, 265000}}, 0), jetzt)
	s.Telegramm(map[int]Wunsch{1: {Art: "limit_w", Wert: 159000, Grund: "markt"}}, true, nil, jetzt)
	st := s.Stand()
	if st.Lage != LageBereit || *st.Bibliothek != "1.0" || len(st.Plaetze) != 1 || st.Plaetze[0].Wunsch.Wert != 159000 ||
		st.Plaetze[0].Angebot.Max != 265000 {
		t.Fatalf("%+v", st)
	}
}
