package inverter

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// committedExport ist der Ort der eingecheckten Export-Datei, relativ zu DIESEM
// Paketverzeichnis (edge-app/core/internal/inverter). Cross-Tree-Lesen per Pfad
// ist Haus-Muster (plan_test.go liest docs/contracts/examples,
// flowdeploy/crosscheck_test.go liest nodered/flowc/testdata).
const committedExport = "../../../../services/api/src/main/resources/componenttemplates/builtin.json"

// TestBuiltinTemplateExportMatchesTheCommittedFile IST der Drift-Waechter:
// links der Go-Katalog (die Wahrheit darueber, was die Box lesen kann), rechts
// die Datei, aus der die Cloud ihr Vorlagen-Register fuellt. Verglichen werden
// BYTES, nicht geparste Strukturen - ein JSON-Round-Trip machte aus der
// Ganzzahl 502 die Gleitkommazahl 502.0 und der Vergleich waere blind fuer
// genau die Formatierungs-Drift, die er finden soll.
func TestBuiltinTemplateExportMatchesTheCommittedFile(t *testing.T) {
	want, err := MarshalBuiltinTemplates()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	have, err := os.ReadFile(filepath.Clean(committedExport))
	if err != nil {
		t.Fatalf("eingecheckte Export-Datei nicht lesbar (%s): %v", committedExport, err)
	}
	if string(have) != string(want) {
		t.Fatalf("Der Geraete-Katalog und die eingecheckte Vorlagen-Datei sind auseinandergelaufen.\n"+
			"Neu erzeugen mit:\n  (cd edge-app/core && go run ./cmd/vp-template-export)\n"+
			"(Datei %d Bytes, Katalog %d Bytes)", len(have), len(want))
	}
}

// TestBuiltinTemplatesCoverEveryCatalogModel nagelt fest, dass der Export
// VOLLSTAENDIG ist: jede Marke, jedes Modell, genau einmal. Ohne diese Zusage
// koennte eine kuenftige Filterung Modelle still verschlucken - der Kunde
// bekaeme im Assistenten eine Auswahl, die kleiner ist als das, was seine Box
// lesen kann.
func TestBuiltinTemplatesCoverEveryCatalogModel(t *testing.T) {
	cat := DefaultCatalog()
	tpl := BuiltinTemplates()

	want := 0
	for _, b := range cat.Brands {
		want += len(b.Models)
	}
	if len(tpl) != want {
		t.Fatalf("Vorlagen %d, Katalog-Modelle %d", len(tpl), want)
	}

	seen := map[string]bool{}
	for _, tp := range tpl {
		if seen[tp.TemplateRef] {
			t.Fatalf("doppelter template_ref: %s", tp.TemplateRef)
		}
		seen[tp.TemplateRef] = true
	}
	for _, b := range cat.Brands {
		for _, m := range b.Models {
			ref := BuiltinTemplateRef(b.ID, m.ID)
			if !seen[ref] {
				t.Fatalf("Modell %s/%s fehlt im Export", b.ID, m.ID)
			}
		}
	}
}

// TestBuiltinTemplatesCarryTheCatalogFactsVerbatim prueft an einem Modell mit
// bekannten Werten, dass NICHTS umgedeutet wird: Familie, Kommunikation,
// Transport-Schema und Nennleistung kommen wortgleich aus dem Katalog.
func TestBuiltinTemplatesCarryTheCatalogFactsVerbatim(t *testing.T) {
	tp := findRef(t, "builtin:deye:sun-30k-sg01hp3")

	if tp.Brand != BrandDeye || tp.Model != "sun-30k-sg01hp3" {
		t.Fatalf("Identitaet falsch: %+v", tp)
	}
	if tp.Family != FamHybrid3p {
		t.Fatalf("Decode-Profil %q, erwartet %q", tp.Family, FamHybrid3p)
	}
	if tp.Communication != CommSolarmanV5 {
		t.Fatalf("Kommunikation %q", tp.Communication)
	}
	if tp.ControlTier != ControlTierToU {
		t.Fatalf("ControlTier %d, erwartet %d", tp.ControlTier, ControlTierToU)
	}
	if tp.RatedKw == nil || *tp.RatedKw != 30 {
		t.Fatalf("Nennleistung %v, erwartet 30", tp.RatedKw)
	}

	// Das Transport-Schema ist das ECHTE Feld-Vokabular der Marke.
	deye, _ := DefaultCatalog().brand(BrandDeye)
	if len(tp.TransportSchema) != len(deye.Fields) {
		t.Fatalf("Transport-Schema %d Felder, Katalog %d",
			len(tp.TransportSchema), len(deye.Fields))
	}
	if tp.TransportSchema[0].Key != "ip" || !tp.TransportSchema[0].Required {
		t.Fatalf("erstes Feld unerwartet: %+v", tp.TransportSchema[0])
	}
	// Der Anzeigetext setzt Modell- und Markenhinweis zusammen, erfindet aber
	// nichts dazu.
	if !strings.Contains(tp.Note, "Hochvolt-Speicher") || !strings.Contains(tp.Note, "Datenlogger") {
		t.Fatalf("Anzeigetext unerwartet: %q", tp.Note)
	}
}

// TestBuiltinTemplatesDeclareNoChannelsAndNoWritesAsNull ist die EHRLICHKEITS-
// Zusage dieser Stufe: eine eingebaute Vorlage sagt „hier nicht erklaert"
// (null), nicht „gibt es nicht" ([]). Ein Deye liefert PV/SoC/Batterie/Netz/
// Last und ein Hybrid kann geschrieben werden - ein leeres Array waere an
// beiden Stellen eine glatte Falschaussage, und die JSON-Bytes muessen das
// zeigen, nicht nur die Go-Struktur.
func TestBuiltinTemplatesDeclareNoChannelsAndNoWritesAsNull(t *testing.T) {
	for _, tp := range BuiltinTemplates() {
		if tp.Channels != nil {
			t.Fatalf("%s deklariert Kanaele, obwohl sie im Decode-Profil wohnen", tp.TemplateRef)
		}
		if tp.Writes != nil {
			t.Fatalf("%s deklariert Schreibwege, obwohl der Steuer-Adapter sie besitzt",
				tp.TemplateRef)
		}
	}

	raw, err := MarshalBuiltinTemplates()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	var doc struct {
		Templates []map[string]json.RawMessage `json:"templates"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("Export unlesbar: %v", err)
	}
	for _, tp := range doc.Templates {
		for _, key := range []string{"channels", "writes"} {
			v, ok := tp[key]
			if !ok {
				t.Fatalf("%s fehlt im Export - absent und null sind verschiedene Aussagen", key)
			}
			if string(v) != "null" {
				t.Fatalf("%s ist %s, erwartet null", key, string(v))
			}
		}
	}
}

// TestBuiltinTemplateRatedKwIsNullWhenUnknown: 0 kW waere eine Aussage ueber
// ein Geraet, die niemand belegt hat - der generische SunSpec-Eintrag hat keine
// Nennleistung, also traegt er null.
func TestBuiltinTemplateRatedKwIsNullWhenUnknown(t *testing.T) {
	generic := findRef(t, BuiltinTemplateRef(BrandGenericModbus, FamSunSpec))
	if generic.RatedKw != nil {
		t.Fatalf("generischer SunSpec-Eintrag traegt %v kW", *generic.RatedKw)
	}
	rated := findRef(t, "builtin:kostal:plenticore-bi-10-26")
	if rated.RatedKw == nil || *rated.RatedKw != 10 {
		t.Fatalf("PLENTICORE BI 10/26 traegt %v kW", rated.RatedKw)
	}
}

// TestBuiltinTemplateRefsAreSlugSafe: der Schluessel reist als Pfad-/Spalten-
// Wert durch die Cloud; die Zeichenmenge ist deshalb gepinnt (die api-Seite
// prueft dieselbe).
func TestBuiltinTemplateRefsAreSlugSafe(t *testing.T) {
	const allowed = "abcdefghijklmnopqrstuvwxyz0123456789._:-"
	for _, tp := range BuiltinTemplates() {
		if tp.TemplateRef == "" || len(tp.TemplateRef) > 128 {
			t.Fatalf("Laenge unzulaessig: %q", tp.TemplateRef)
		}
		for _, r := range tp.TemplateRef {
			if !strings.ContainsRune(allowed, r) {
				t.Fatalf("Zeichen %q in %q nicht erlaubt", r, tp.TemplateRef)
			}
		}
		if !strings.HasPrefix(tp.TemplateRef, TemplateKindBuiltin+":") {
			t.Fatalf("%q traegt nicht die builtin-Herkunft", tp.TemplateRef)
		}
	}
}

// TestMarshalBuiltinTemplatesIsDeterministic: ohne diese Zusage koennte der
// Drift-Test nicht auf Bytes vergleichen.
func TestMarshalBuiltinTemplatesIsDeterministic(t *testing.T) {
	a, err := MarshalBuiltinTemplates()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	b, err := MarshalBuiltinTemplates()
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if string(a) != string(b) {
		t.Fatal("zwei Laeufe, zwei Ergebnisse - der Export ist nicht deterministisch")
	}
	if !strings.HasSuffix(string(a), "\n") {
		t.Fatal("Export ohne abschliessenden Zeilenumbruch")
	}
}

func findRef(t *testing.T, ref string) Template {
	t.Helper()
	for _, tp := range BuiltinTemplates() {
		if tp.TemplateRef == ref {
			return tp
		}
	}
	t.Fatalf("Vorlage %q nicht gefunden", ref)
	return Template{}
}
