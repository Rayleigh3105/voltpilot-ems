package chargingcfg

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const (
	tenant = "00000000-0000-0000-0000-000000000001"
	site   = "00000000-0000-0000-0000-000000000002"
	device = "00000000-0000-0000-0000-000000000003"
)

func doc(extra string) []byte {
	return []byte(`{"schema_version":"1.0","tenant_id":"` + tenant + `","site_id":"` + site +
		`","device_id":"` + device + `"` + extra + `,"published_at":"2026-08-20T11:24:00Z"}`)
}

// Die PATCH-Semantik ist der ganze Vertrag: abwesend heisst "das Portal sagt
// dazu nichts", eine leere Liste ist dagegen eine AUSSAGE.
func TestAbsentMeansKeepAndAnEmptyListIsAStatement(t *testing.T) {
	only, err := Parse(doc(`,"grid_limit_kw":277`))
	if err != nil {
		t.Fatal(err)
	}
	if only.GridLimitKw == nil || *only.GridLimitKw != 277 {
		t.Fatalf("grid limit = %v", only.GridLimitKw)
	}
	if only.Priorities != nil {
		t.Fatal("eine abwesende Vorrang-Liste darf keine leere werden - die Box behaelt ihre Wahl")
	}

	cleared, err := Parse(doc(`,"priority_charge_point_ids":[]`))
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Priorities == nil || len(cleared.Priorities) != 0 {
		t.Fatalf("eine leere Liste ist eine Aussage: %v", cleared.Priorities)
	}
	if cleared.GridLimitKw != nil {
		t.Fatal("eine abwesende Grenze darf die gepflegte nicht loeschen")
	}
}

// Eine 0 ist keine Grenze, sondern ein Tippfehler: ohne Grenze ist das Budget
// 0 und es laedt nichts - das darf nie aus einem Dokument entstehen.
func TestAnImplausibleLimitIsRejectedNotApplied(t *testing.T) {
	for _, bad := range []string{`,"grid_limit_kw":0`, `,"grid_limit_kw":-5`,
		`,"grid_limit_kw":250000`} {
		if _, err := Parse(doc(bad)); err == nil {
			t.Fatalf("%s muss abgelehnt werden", bad)
		}
	}
}

// Ein Dokument, das wir nicht verstehen, darf keine Einstellung werden.
func TestAnUnknownSchemaVersionIsDiscarded(t *testing.T) {
	raw := []byte(`{"schema_version":"2.0","tenant_id":"` + tenant + `","site_id":"` + site +
		`","device_id":"` + device + `","grid_limit_kw":10,"published_at":"2026-08-20T11:24:00Z"}`)
	if _, err := Parse(raw); err == nil {
		t.Fatal("eine fremde Vertragsversion muss fail-closed verworfen werden")
	}
	if _, err := Parse([]byte("kein json")); err == nil {
		t.Fatal("unlesbare Bytes werden verworfen")
	}
}

// Die Ruecknahme ist ein eigener, benannter Ausgang - kein Fehler.
func TestAnEmptyPayloadIsTheWithdrawal(t *testing.T) {
	if _, err := Parse(nil); !errors.Is(err, ErrEmpty) {
		t.Fatalf("leere Nutzlast = Ruecknahme, got %v", err)
	}
	if _, err := Parse([]byte("   ")); !errors.Is(err, ErrEmpty) {
		t.Fatalf("leerraum-Nutzlast = Ruecknahme, got %v", err)
	}
}

func TestIdentityMustMatchTheTopic(t *testing.T) {
	cfg, err := Parse(doc(`,"grid_limit_kw":277`))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.MatchesIdentity(tenant, site, device) {
		t.Fatal("die eigene Identitaet muss passen")
	}
	if cfg.MatchesIdentity(tenant, site, "00000000-0000-0000-0000-0000000000ff") {
		t.Fatal("ein fremdes Geraet darf nie passen")
	}
}

// Doppelte und leere Kennungen werden geraeuschlos gesaeubert - eine Liste mit
// derselben Saeule zweimal ist keine andere Aussage.
func TestThePriorityListIsCleanedNotRejected(t *testing.T) {
	cfg, err := Parse(doc(`,"priority_charge_point_ids":[" saeule-1 ","saeule-1","","saeule-2"]`))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"saeule-1", "saeule-2"}
	if len(cfg.Priorities) != len(want) {
		t.Fatalf("priorities = %v", cfg.Priorities)
	}
	for i := range want {
		if cfg.Priorities[i] != want[i] {
			t.Fatalf("priorities = %v", cfg.Priorities)
		}
	}
}

// Die Allowlist FUEGT NUR HINZU, und deshalb sind abwesend und leer hier
// dasselbe - anders als bei der Vorrang-Liste. Eine Kennung zu entfernen wirft
// eine Saeule beim naechsten Verbindungsaufbau vom Broker; das bleibt eine
// ausdrueckliche Handlung am Geraet.
func TestTheAllowlistOnlyEverAddsSoAbsentAndEmptyAreTheSame(t *testing.T) {
	absent, err := Parse(doc(`,"grid_limit_kw":277`))
	if err != nil {
		t.Fatal(err)
	}
	if len(absent.ChargePoints) != 0 {
		t.Fatalf("abwesend = nichts hinzuzufuegen: %+v", absent.ChargePoints)
	}

	empty, err := Parse(doc(`,"charge_points":[]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.ChargePoints) != 0 {
		t.Fatalf("eine leere Liste ist hier KEINE Aussage 'keine Saeule': %+v", empty.ChargePoints)
	}
}

// Die Felder reisen vollstaendig durch - was der Betreiber im Portal weiss,
// soll die Box beim ERSTEN Anlegen uebernehmen koennen.
func TestAChargePointCarriesEverythingTheOperatorKnows(t *testing.T) {
	cfg, err := Parse(doc(`,"charge_points":[{"id":" saeule-1 ","label":" Hof Nord ",` +
		`"priority":true,"rated_kw":22,"connectors":2}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ChargePoints) != 1 {
		t.Fatalf("charge points = %+v", cfg.ChargePoints)
	}
	cp := cfg.ChargePoints[0]
	if cp.ID != "saeule-1" || cp.Label != "Hof Nord" || !cp.Priority ||
		cp.RatedKw != 22 || cp.Connectors != 2 {
		t.Fatalf("charge point = %+v", cp)
	}
}

// ⚠ Eine unbrauchbare Kennung wird UEBERSPRUNGEN, nicht zum Abbruch: das ganze
// Dokument daran scheitern zu lassen kostete die Anschlussgrenze mit - und die
// ist die Groesse, ohne die nichts laedt.
func TestAnUnusableIdentifierIsSkippedNeverTakingTheLimitWithIt(t *testing.T) {
	cfg, err := Parse(doc(`,"grid_limit_kw":277,"charge_points":[{"id":"  "},` +
		`{"id":"saeule-1"},{"id":"saeule-1","label":"zweite Zeile"}]`))
	if err != nil {
		t.Fatalf("eine kaputte Zeile darf das Dokument nicht versenken: %v", err)
	}
	if cfg.GridLimitKw == nil || *cfg.GridLimitKw != 277 {
		t.Fatal("die Anschlussgrenze muss ueberleben")
	}
	if len(cfg.ChargePoints) != 1 || cfg.ChargePoints[0].ID != "saeule-1" {
		t.Fatalf("charge points = %+v", cfg.ChargePoints)
	}
	if cfg.ChargePoints[0].Label != "" {
		t.Fatal("die erste Nennung gewinnt - eine doppelte Zeile ist keine zweite Saeule")
	}
}

// Der Deckel des Vertrags ist eine Ablehnung, nie eine stille Kappung.
func TestTooManyChargePointsAreRefused(t *testing.T) {
	var sb []byte
	sb = append(sb, `,"charge_points":[`...)
	for i := 0; i <= MaxChargePoints; i++ {
		if i > 0 {
			sb = append(sb, ',')
		}
		sb = append(sb, `{"id":"s`...)
		sb = append(sb, []byte(string(rune('a'+i%26)))...)
		sb = append(sb, []byte(string(rune('0'+i/26)))...)
		sb = append(sb, `"}`...)
	}
	sb = append(sb, ']')
	if _, err := Parse(doc(string(sb))); err == nil {
		t.Fatalf("mehr als %d Saeulen muessen abgelehnt werden", MaxChargePoints)
	}
}

// Die eingecheckten Kontrakt-Beispiele werden PER PFAD gelesen: wer eine
// Fixture verschiebt, bricht diesen Test absichtlich.
func TestTheContractFixturesParseExactlyAsSpecified(t *testing.T) {
	dir := filepath.Join("..", "..", "..", "..", "docs", "contracts", "examples")

	full := mustRead(t, filepath.Join(dir, "mqtt-charging-config.valid.grenze-und-vorrang.json"))
	cfg, err := Parse(full)
	if err != nil {
		t.Fatalf("die gueltige Fixture muss parsen: %v", err)
	}
	if cfg.GridLimitKw == nil || *cfg.GridLimitKw != 277 || len(cfg.Priorities) != 1 {
		t.Fatalf("fixture = %+v", cfg)
	}

	withdrawn := mustRead(t,
		filepath.Join(dir, "mqtt-charging-config.valid.nur-vorrang-zurueckgenommen.json"))
	cfg2, err := Parse(withdrawn)
	if err != nil {
		t.Fatalf("die zweite gueltige Fixture muss parsen: %v", err)
	}
	if cfg2.GridLimitKw != nil {
		t.Fatal("sie nennt keine Grenze - die Box behaelt ihre eigene")
	}
	if cfg2.Priorities == nil || len(cfg2.Priorities) != 0 {
		t.Fatalf("sie nimmt den Vorrang ausdruecklich zurueck: %v", cfg2.Priorities)
	}

	allow := mustRead(t, filepath.Join(dir, "mqtt-charging-config.valid.saeulen-eintragen.json"))
	cfg3, err := Parse(allow)
	if err != nil {
		t.Fatalf("die Allowlist-Fixture muss parsen: %v", err)
	}
	if len(cfg3.ChargePoints) != 2 {
		t.Fatalf("allowlist = %+v", cfg3.ChargePoints)
	}
	if cfg3.ChargePoints[0].Label != "Hof Nord" || cfg3.ChargePoints[0].RatedKw != 22 {
		t.Fatalf("erste Saeule = %+v", cfg3.ChargePoints[0])
	}
	// Die zweite Zeile nennt NUR ihre Kennung - alles Weitere ist das, was der
	// Betreiber zufaellig schon weiss.
	if cfg3.ChargePoints[1].ID != "saeule-halle" || cfg3.ChargePoints[1].Label != "" ||
		cfg3.ChargePoints[1].Connectors != 0 {
		t.Fatalf("zweite Saeule = %+v", cfg3.ChargePoints[1])
	}

	invalid := mustRead(t, filepath.Join(dir, "mqtt-charging-config.invalid.grenze-null.json"))
	if _, err := Parse(invalid); err == nil {
		t.Fatal("die ungueltige Fixture muss abgelehnt werden")
	}
	// Und sie ist syntaktisch einwandfrei - der Test prueft die REGEL, nicht
	// einen Tippfehler in der Datei.
	var any map[string]any
	if err := json.Unmarshal(invalid, &any); err != nil {
		t.Fatalf("die ungueltige Fixture muss gueltiges JSON sein: %v", err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("Fixture %s: %v", path, err)
	}
	return b
}
