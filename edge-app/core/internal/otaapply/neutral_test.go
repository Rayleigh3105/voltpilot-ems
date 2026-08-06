package otaapply

// Die Betreiber-Tabelle (VP_OTA_NEUTRAL_VERIFIED), der geraete-lokal
// GEMESSENE Nachweis (ota/neutral-verified.json, geschrieben vom gefuehrten
// Neutral-Zeit-Test auf `:8484`) und ihr VORRANG: die Umgebungsvariable
// gewinnt immer, der Nachweis oeffnet das Tor nur in ihrer Abwesenheit.

import (
	"strings"
	"testing"
	"time"
)

func TestParseNeutralTableRejectsUnlesbareEintraegeStattSieZuVerwerfen(t *testing.T) {
	if _, err := ParseNeutralTable("hybrid_3p:90,sunspec:45"); err != nil {
		t.Fatalf("ein sauberer Eintrag muss lesbar sein: %v", err)
	}
	cases := []string{
		"hybrid_3p",       // kein "familie:sekunden"
		"hybrid_3p:abc",   // keine Zahl
		"hybrid_3p:0",     // nicht positiv
		"hybrid_3p:-5",    // negativ
		":90",             // leere Familie
		"hybrid_3p:99999", // > eine Stunde
	}
	for _, c := range cases {
		if _, err := ParseNeutralTable(c); err == nil {
			t.Fatalf("%q muss ABGELEHNT werden, nicht still verworfen", c)
		}
	}
}

func TestForOhneEintragIstUnverifiziert(t *testing.T) {
	tbl, err := ParseNeutralTable("hybrid_3p:90")
	if err != nil {
		t.Fatal(err)
	}
	n := tbl.For("sunspec")
	if n.Verified {
		t.Fatal("eine nicht eingetragene Familie darf nie als verifiziert gelten")
	}
	if n.T != DefaultNeutralT {
		t.Fatalf("T = %v, want DefaultNeutralT", n.T)
	}
	if got := tbl.For("hybrid_3p"); !got.Verified || got.T != 90*time.Second {
		t.Fatalf("die eingetragene Familie muss verifiziert mit ihrer Zahl zurueckkommen: %+v", got)
	}
}

// Der Kern der Aufgabe: ein gemessener, belegter Nachweis oeffnet das Tor
// GENAU DANN, wenn die Betreiber-Tabelle schweigt.
func TestForWithMeasuredOeffnetDasTorNurOhneTabelleneintrag(t *testing.T) {
	empty, err := ParseNeutralTable("")
	if err != nil {
		t.Fatal(err)
	}
	measured := map[string]NeutralRecord{
		"hybrid_3p": {Family: "hybrid_3p", Seconds: 42, MeasuredAt: "2026-08-06T12:00:00Z"},
	}
	got := empty.ForWithMeasured("hybrid_3p", measured)
	if !got.Verified {
		t.Fatalf("ein gemessener Nachweis muss ohne Tabelleneintrag verifizieren: %+v", got)
	}
	if got.T != 42*time.Second {
		t.Fatalf("T = %v, want 42s", got.T)
	}
	if !strings.Contains(got.Note, "gemessen") {
		t.Fatalf("die Notiz muss die Herkunft (Messung) nennen: %q", got.Note)
	}

	// Eine ANDERE Familie ohne Nachweis bleibt unveraendert unverifiziert.
	if got := empty.ForWithMeasured("sunspec", measured); got.Verified {
		t.Fatalf("ohne Tabelle UND ohne Nachweis darf nichts verifiziert sein: %+v", got)
	}
}

// Der Vorrang ist EINSEITIG: ein Tabelleneintrag gewinnt IMMER - auch wenn er
// KLEINER ist als der gemessene Wert. Der Betreiber hat bereits die
// konservative, wiederholte Pruefstands-Messung gemacht; das Paket darf sie
// nie durch eine eigene Zahl ueberstimmen.
func TestForWithMeasuredDieUmgebungsvariableGewinntImmerAuchWennKleiner(t *testing.T) {
	tbl, err := ParseNeutralTable("hybrid_3p:20")
	if err != nil {
		t.Fatal(err)
	}
	measured := map[string]NeutralRecord{
		"hybrid_3p": {Family: "hybrid_3p", Seconds: 999, MeasuredAt: "2026-08-06T12:00:00Z"},
	}
	got := tbl.ForWithMeasured("hybrid_3p", measured)
	if got.T != 20*time.Second {
		t.Fatalf("die Betreiber-Tabelle muss gewinnen, auch mit einem kleineren Wert: T=%v", got.T)
	}
	if strings.Contains(got.Note, "gemessen") {
		t.Fatalf("die Notiz darf bei einem Tabellensieg nicht die Messung nennen: %q", got.Note)
	}
}

// Ein Nachweis mit Seconds<=0 (kann per Konstruktion nicht ueber
// SaveNeutralRecord entstehen, aber die Aufloesung muss trotzdem defensiv
// sein) oeffnet das Tor NICHT.
func TestForWithMeasuredIgnoriertEinenLeerenOderUngueltigenNachweis(t *testing.T) {
	empty, err := ParseNeutralTable("")
	if err != nil {
		t.Fatal(err)
	}
	if got := empty.ForWithMeasured("hybrid_3p", map[string]NeutralRecord{
		"hybrid_3p": {Family: "hybrid_3p", Seconds: 0},
	}); got.Verified {
		t.Fatalf("Seconds<=0 darf niemals verifizieren: %+v", got)
	}
	if got := empty.ForWithMeasured("hybrid_3p", nil); got.Verified {
		t.Fatalf("keine Tabelle ohne Nachweis: %+v", got)
	}
}

// Gross-/Kleinschreibung und Leerraum duerfen den Abgleich nicht stoeren -
// die Familie kommt vom Kern (sig.InverterFamily) und die aufgeloeste Zahl
// aus der Datei; beide muessen zusammenfinden.
func TestForWithMeasuredNormalisiertDieFamilie(t *testing.T) {
	empty, err := ParseNeutralTable("")
	if err != nil {
		t.Fatal(err)
	}
	measured := map[string]NeutralRecord{
		"hybrid_3p": {Family: "hybrid_3p", Seconds: 30},
	}
	if got := empty.ForWithMeasured("  Hybrid_3P  ", measured); !got.Verified {
		t.Fatalf("Gross-/Kleinschreibung und Leerraum muessen normalisiert werden: %+v", got)
	}
}

func TestSaveAndLoadNeutralEvidenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if recs := LoadNeutralEvidence(dir); recs != nil {
		t.Fatalf("ohne Datei muss die Tabelle leer sein, nicht ein erfundener Beleg: %+v", recs)
	}
	if err := SaveNeutralRecord(dir, NeutralRecord{
		Family: "Hybrid_3P", Seconds: 55, MeasuredAt: "2026-08-06T12:00:00Z", TestKw: 0.5, SettleSamples: 3,
	}); err != nil {
		t.Fatalf("save: %v", err)
	}
	recs := LoadNeutralEvidence(dir)
	if recs == nil {
		t.Fatal("ein gespeicherter Nachweis muss ladbar sein")
	}
	rec, ok := recs["hybrid_3p"]
	if !ok {
		t.Fatalf("die Familie muss normalisiert (klein) gespeichert sein: %+v", recs)
	}
	if rec.Seconds != 55 {
		t.Fatalf("Seconds = %d, want 55", rec.Seconds)
	}

	// Ein zweiter Nachweis fuer eine ANDERE Familie ergaenzt, ueberschreibt
	// den ersten nicht.
	if err := SaveNeutralRecord(dir, NeutralRecord{Family: "sunspec", Seconds: 12, MeasuredAt: "x"}); err != nil {
		t.Fatal(err)
	}
	recs = LoadNeutralEvidence(dir)
	if len(recs) != 2 {
		t.Fatalf("beide Familien muessen erhalten bleiben: %+v", recs)
	}

	// Ein neuer Nachweis DERSELBEN Familie ERSETZT den alten (ein neuer
	// First-Light-Test auf demselben Modell ist die aktuelle Wahrheit).
	if err := SaveNeutralRecord(dir, NeutralRecord{Family: "hybrid_3p", Seconds: 61, MeasuredAt: "y"}); err != nil {
		t.Fatal(err)
	}
	recs = LoadNeutralEvidence(dir)
	if recs["hybrid_3p"].Seconds != 61 {
		t.Fatalf("der neue Nachweis muss den alten ersetzen: %+v", recs["hybrid_3p"])
	}
}

// SaveNeutralRecord fasst NIE einen Nicht-Erfolg an: ohne Familie oder ohne
// eine gemessene Sekundenzahl wird ABGELEHNT statt eine leere/erfundene Zeile
// zu schreiben.
func TestSaveNeutralRecordRefusesEmptyOrZeroEvidence(t *testing.T) {
	dir := t.TempDir()
	if err := SaveNeutralRecord(dir, NeutralRecord{Family: "", Seconds: 10}); err == nil {
		t.Fatal("ohne Familie muss abgelehnt werden")
	}
	if err := SaveNeutralRecord(dir, NeutralRecord{Family: "hybrid_3p", Seconds: 0}); err == nil {
		t.Fatal("ohne gemessene Sekunden muss abgelehnt werden")
	}
	if err := SaveNeutralRecord(dir, NeutralRecord{Family: "hybrid_3p", Seconds: -1}); err == nil {
		t.Fatal("eine negative Sekundenzahl muss abgelehnt werden")
	}
	if recs := LoadNeutralEvidence(dir); recs != nil {
		t.Fatalf("keine der abgelehnten Aufrufe darf etwas geschrieben haben: %+v", recs)
	}
}

// Eine zu alte/fremde Schema-Version wird verworfen wie eine unlesbare Datei -
// niemals stillschweigend als gueltiger Nachweis interpretiert.
func TestLoadNeutralEvidenceIgnoresAWrongSchemaVersion(t *testing.T) {
	dir := t.TempDir()
	if err := WriteJSON(dir, FileNeutralEvidence, NeutralEvidenceFile{
		Version: neutralEvidenceVersion + 1,
		Records: map[string]NeutralRecord{"hybrid_3p": {Family: "hybrid_3p", Seconds: 99}},
	}); err != nil {
		t.Fatal(err)
	}
	if recs := LoadNeutralEvidence(dir); recs != nil {
		t.Fatalf("eine fremde Schema-Version muss verworfen werden: %+v", recs)
	}
}
