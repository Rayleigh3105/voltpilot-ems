package logik

import (
	"os"
	"testing"
)

// Die Sicherung friert einen Lauf ein und liest ihn zurück; Neustart danach
// wendet after_restart an (Vertrag: Stellwerte und Tageszähler bleiben,
// `off` setzt den Schalter zurück, `keep` behält ihn).
func TestSicherungRundreise(t *testing.T) {
	roh, err := os.ReadFile(dokumentePfad + "/steuerlogik/waermepumpe.logic.json")
	if err != nil {
		t.Fatalf("Dokument lesen: %v", err)
	}
	L, err := Lesen(roh)
	if err != nil {
		t.Fatalf("Lesen: %v", err)
	}
	jetzt := 1000000.0
	st := L.NeuerLauf(jetzt)
	// Ein verstellter Stellwert und ein paar Takte mit Sonnenstrom.
	st.Stell["ab_kw"] = zahlW(3, GroesseKW)
	netz := -4.0
	puffer := 42.0
	ein := &Eingabe{Jetzt: jetzt, UhrMin: 720, Tag: 100, Wochentag: 2, Werte: map[string]EinWert{
		"netz":   {Zahl: &netz},
		"puffer": {Zahl: &puffer},
	}, Geraete: map[string]GeraetStamm{}}
	for i := 0; i < 2000; i++ {
		ein.Jetzt = jetzt + float64(i)
		ein.UhrMin = 720 + float64(i)/60
		L.Takt(st, ein)
	}
	if !zustandAn(t, L, st, "empfehlung") {
		t.Fatalf("nach 2000 s Sonnenstrom sollte die Empfehlung an sein")
	}

	daten, err := L.SichereLauf(st)
	if err != nil {
		t.Fatalf("SichereLauf: %v", err)
	}
	neu, err := L.LadeLauf(daten, ein.Jetzt+10)
	if err != nil {
		t.Fatalf("LadeLauf: %v", err)
	}
	// Vor dem Neustart trägt der geladene Lauf den gesicherten Stand.
	if neu.Stell["ab_kw"].V != 3 {
		t.Errorf("Stellwert ab_kw: %v statt 3", neu.Stell["ab_kw"].V)
	}
	if !zustandAn(t, L, neu, "empfehlung") {
		t.Errorf("geladener Lauf: Empfehlung sollte den gesicherten Stand tragen")
	}
	// Neustart: `after_restart: off` der Empfehlung greift, der Stellwert bleibt.
	L.Neustart(neu, ein.Jetzt+10)
	if zustandAn(t, L, neu, "empfehlung") {
		t.Errorf("after_restart off: die Empfehlung muss nach dem Neustart aus sein")
	}
	if neu.Stell["ab_kw"].V != 3 {
		t.Errorf("Stellwerte bleiben bei einem Neustart erhalten")
	}
}

// Ein gesicherter Lauf einer anderen Schema-Version wird abgelehnt.
func TestSicherungFremdesSchema(t *testing.T) {
	roh, err := os.ReadFile(dokumentePfad + "/steuerlogik/waermepumpe.logic.json")
	if err != nil {
		t.Fatalf("Dokument lesen: %v", err)
	}
	L, err := Lesen(roh)
	if err != nil {
		t.Fatalf("Lesen: %v", err)
	}
	if _, err := L.LadeLauf([]byte(`{"schema_version":2}`), 1); err == nil {
		t.Fatalf("schema_version 2 muss abgelehnt werden")
	}
}

func zustandAn(t *testing.T, L *Logik, st *Lauf, kennung string) bool {
	t.Helper()
	l, ok := st.Z[kennung]
	if !ok {
		t.Fatalf("Zustand %s fehlt", kennung)
	}
	return l.an
}
