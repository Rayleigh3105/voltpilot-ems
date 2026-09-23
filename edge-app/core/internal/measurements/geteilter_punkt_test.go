package measurements

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AP-07 IP-18b Box-Schritt: the shared point (same point_key once per
// component) in plan, local batch and status. The rule is the contract's
// x-point-key-rule; see geteiltePunkte.

const (
	komponenteA = "00000000-0000-0000-0000-0000000000a1"
	komponenteB = "00000000-0000-0000-0000-0000000000a2"
)

func planMit(selections string) []byte {
	return []byte(fmt.Sprintf(`{"schema_version":"2.0","tenant_id":"%s","site_id":"%s","device_id":"%s","revision":2,"catalog_version":"2026.08.25.1","selections":[%s]}`,
		testID.TenantID, testID.SiteID, testID.DeviceID, selections))
}

func auswahl(pointKey, entityID string, cadence int) string {
	if entityID == "" {
		return fmt.Sprintf(`{"point_key":"%s","cadence_s":%d}`, pointKey, cadence)
	}
	return fmt.Sprintf(`{"point_key":"%s","cadence_s":%d,"entity_id":"%s"}`, pointKey, cadence, entityID)
}

func TestGeteilterPunktIstImPlanJeKomponenteZulaessig(t *testing.T) {
	c, err := ParseConfig(planMit(auswahl("p.shared", komponenteA, 30)+","+auswahl("p.shared", komponenteB, 10)), testID, 1)
	if err != nil {
		t.Fatalf("shared point refused: %v", err)
	}
	if len(c.Selections) != 2 || c.Selections[0].EntityID != komponenteA || c.Selections[1].CadenceS != 10 {
		t.Fatalf("each occurrence keeps its own component and cadence: %+v", c.Selections)
	}
}

func TestEchteDuplikateBleibenAbgewiesen(t *testing.T) {
	for name, selections := range map[string]string{
		"dieselbe Komponente zweimal": auswahl("p.shared", komponenteA, 30) + "," + auswahl("p.shared", komponenteA, 10),
		"dieselbe Komponente in anderer Schreibweise": auswahl("p.shared", komponenteA, 30) + "," +
			auswahl("p.shared", strings.ToUpper(komponenteA), 10),
		"ohne Komponente zweimal":        auswahl("p.x", "", 30) + "," + auswahl("p.x", "", 10),
		"erst ohne, dann mit Komponente": auswahl("p.x", "", 30) + "," + auswahl("p.x", komponenteA, 10),
		"erst mit, dann ohne Komponente": auswahl("p.x", komponenteA, 30) + "," + auswahl("p.x", "", 10),
		"drei Vorkommen, eins ohne":      auswahl("p.x", komponenteA, 30) + "," + auswahl("p.x", komponenteB, 30) + "," + auswahl("p.x", "", 30),
	} {
		if _, err := ParseConfig(planMit(selections), testID, 1); err == nil || !strings.Contains(err.Error(), "duplicate point") {
			t.Fatalf("%s: want duplicate point, got %v", name, err)
		}
	}
}

// Mischbetrieb, neue Box an heutiger Cloud: every plan the cloud sends today
// (merged, one entry per point_key) parses exactly as before, and the shared
// example of the contract - refused by the previous core - is accepted.
func TestHeutigerPlanUndVertragsbeispieleWerdenAngenommen(t *testing.T) {
	files, err := filepath.Glob("../../../../docs/contracts/v2/examples/mqtt-measurement-config.valid*.json")
	if err != nil || len(files) < 5 {
		t.Fatalf("examples: %v %v", files, err)
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var id Identity
		if err := json.Unmarshal(raw, &id); err != nil {
			t.Fatal(err)
		}
		c, err := ParseConfig(raw, id, 0)
		if err != nil {
			t.Fatalf("%s: %v", filepath.Base(file), err)
		}
		if len(c.Selections) == 0 {
			t.Fatalf("%s: no selections", filepath.Base(file))
		}
	}
	// The merged plan of a point observed by two components: one entry, no
	// entity_id (MeasurementPlan#compose) - unchanged.
	if _, err := ParseConfig(planMit(auswahl("p.shared", "", 10)), testID, 1); err != nil {
		t.Fatal(err)
	}
}

func lokalerStapel(samples string) []byte {
	return []byte(`{"catalog_version":"2026.08.25.1","observed_at":"2026-09-23T10:00:00Z","samples":[` + samples + `]}`)
}

func probe(pointKey, entityID string, raw int) string {
	if entityID == "" {
		return fmt.Sprintf(`{"point_key":"%s","raw":%d,"quality":"good"}`, pointKey, raw)
	}
	return fmt.Sprintf(`{"point_key":"%s","raw":%d,"quality":"good","entity_id":"%s"}`, pointKey, raw, entityID)
}

func TestStapelTraegtJeKomponenteEinSample(t *testing.T) {
	b, err := parseBatch(lokalerStapel(probe("p.shared", komponenteA, 7) + "," + probe("p.shared", komponenteB, 7)))
	if err != nil || len(b.Samples) != 2 {
		t.Fatalf("one sample per component refused: %v", err)
	}
	for name, samples := range map[string]string{
		"dieselbe Komponente zweimal": probe("p.shared", komponenteA, 7) + "," + probe("p.shared", komponenteA, 8),
		"ohne Komponente zweimal":     probe("p.x", "", 7) + "," + probe("p.x", "", 8),
		"eins ohne Komponente":        probe("p.x", komponenteA, 7) + "," + probe("p.x", "", 8),
	} {
		if _, err := parseBatch(lokalerStapel(samples)); err == nil {
			t.Fatalf("%s: duplicate sample accepted", name)
		}
	}
	// The envelope carries both with their entity_id (measurement-samples 2.1).
	dir := t.TempDir()
	o, err := OpenOutbox(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	env, err := o.Append(lokalerStapel(probe("p.shared", komponenteA, 7)+","+probe("p.shared", komponenteB, 7)), testID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(env.Raw, []byte(`"schema_version":"2.1"`)) ||
		!bytes.Contains(env.Raw, []byte(komponenteA)) || !bytes.Contains(env.Raw, []byte(komponenteB)) {
		t.Fatalf("envelope lost a component: %s", env.Raw)
	}
}

func status(rejected string) []byte {
	return []byte(`{"revision":2,"applied_at":"2026-09-23T10:00:00Z","accepted":["p.shared"],"rejected":[` + rejected + `]}`)
}

func TestStatusMeldetDieAblehnungJeKomponente(t *testing.T) {
	wrapped, err := WrapStatus(status(`{"point_key":"p.shared","reason":"binding_unavailable","entity_id":"`+komponenteB+`"}`), testID, "edge-test")
	if err != nil {
		t.Fatalf("per-component refusal of a shared point refused: %v", err)
	}
	if !bytes.Contains(wrapped, []byte(`{"point_key":"p.shared","reason":"binding_unavailable","entity_id":"`+komponenteB+`"}`)) {
		t.Fatalf("entity_id lost on the wire: %s", wrapped)
	}
	for name, rejected := range map[string]string{
		"ganzer Punkt angenommen UND abgelehnt": `{"point_key":"p.shared","reason":"binding_unavailable"}`,
		"dieselbe Komponente zweimal": `{"point_key":"p.other","reason":"binding_unavailable","entity_id":"` + komponenteA + `"},` +
			`{"point_key":"p.other","reason":"unknown_point","entity_id":"` + komponenteA + `"}`,
		"Komponente neben ganzem Punkt": `{"point_key":"p.other","reason":"unknown_point"},` +
			`{"point_key":"p.other","reason":"binding_unavailable","entity_id":"` + komponenteA + `"}`,
		"kaputte Komponente": `{"point_key":"p.other","reason":"binding_unavailable","entity_id":"nope"}`,
	} {
		if _, err := WrapStatus(status(rejected), testID, "edge-test"); err == nil {
			t.Fatalf("%s: accepted", name)
		}
	}
	// A status without a shared point is byte for byte the previous one.
	heute := []byte(`{"revision":2,"applied_at":"2026-09-23T10:00:00Z","accepted":["p.a"],"rejected":[{"point_key":"p.b","reason":"unknown_point"}]}`)
	wrapped, err = WrapStatus(heute, testID, "edge-test")
	if err != nil {
		t.Fatal(err)
	}
	want := `{"schema_version":"2.0","tenant_id":"` + testID.TenantID + `","site_id":"` + testID.SiteID + `","device_id":"` +
		testID.DeviceID + `","revision":2,"applied_at":"2026-09-23T10:00:00Z","accepted":["p.a"],"rejected":[{"point_key":"p.b","reason":"unknown_point"}],"edge_version":"edge-test"}`
	if string(wrapped) != want {
		t.Fatalf("status changed:\n%s\n%s", wrapped, want)
	}
}
