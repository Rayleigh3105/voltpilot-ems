package inverter

// TYPENSCHILD-VARIANTEN (Bauplan P8 „Stammdaten-Kosmetik", Diagnose
// data/vp-deye-diybms-luecke-l5 §2.6/§3.1).
//
// Deye liefert dieselbe HV-Hybrid-Reihe unter mehreren Namen aus: im Katalog
// heisst sie „SUN-30K-SG01HP3-EU", auf dem Geraet steht „…-EU-BM3" bzw.
// „…-EU-BM4". Model.Aliases traegt diese Namen, damit der Kunde findet, was er
// abtippt - und NUR das. Hier steht der Beweis, dass ein Alias nie mehr wird
// als ein Name.

import (
	"strings"
	"testing"
	"time"
)

// TestTheDeyeHvHybridsCarryTheirNameplateVariants ist die Aussage des Pakets:
// jede kW-Stufe der SG01HP3-Reihe kennt ihre BM3- und BM4-Variante.
func TestTheDeyeHvHybridsCarryTheirNameplateVariants(t *testing.T) {
	want := map[string][]string{
		"sun-29.9k-sg01hp3": {"SUN-29.9K-SG01HP3-EU-BM3", "SUN-29.9K-SG01HP3-EU-BM4"},
		"sun-30k-sg01hp3":   {"SUN-30K-SG01HP3-EU-BM3", "SUN-30K-SG01HP3-EU-BM4"},
		"sun-35k-sg01hp3":   {"SUN-35K-SG01HP3-EU-BM3", "SUN-35K-SG01HP3-EU-BM4"},
		"sun-40k-sg01hp3":   {"SUN-40K-SG01HP3-EU-BM3", "SUN-40K-SG01HP3-EU-BM4"},
		"sun-50k-sg01hp3":   {"SUN-50K-SG01HP3-EU-BM3", "SUN-50K-SG01HP3-EU-BM4"},
	}
	got := map[string][]string{}
	for _, b := range DefaultCatalog().Brands {
		if b.ID != BrandDeye {
			continue
		}
		for _, m := range b.Models {
			if len(m.Aliases) > 0 {
				got[m.ID] = m.Aliases
			}
		}
	}
	for id, aliases := range want {
		have, ok := got[id]
		if !ok {
			t.Errorf("Modell %s traegt keine Typenschild-Variante", id)
			continue
		}
		if strings.Join(have, "|") != strings.Join(aliases, "|") {
			t.Errorf("Modell %s: Varianten %v, erwartet %v", id, have, aliases)
		}
	}
}

// TestANameplateVariantKeepsTheModelsIdentity ist die HARTE Regel: ein Alias
// erzeugt kein zweites Modell. Familie, Nennleistung und Kennung bleiben, was
// sie waren - sonst haette die Kosmetik das Decode-Profil oder (ueber
// brand+model) die Steuerungs-Freigabe verschoben.
func TestANameplateVariantKeepsTheModelsIdentity(t *testing.T) {
	for _, b := range DefaultCatalog().Brands {
		for _, m := range b.Models {
			if len(m.Aliases) == 0 {
				continue
			}
			if m.Family != FamHybrid3p && b.ID == BrandDeye {
				t.Errorf("%s/%s: Variante hat die Registerkarte verschoben (%s)",
					b.ID, m.ID, m.Family)
			}
			if m.RatedKw <= 0 {
				t.Errorf("%s/%s: Variante ohne Nennleistung", b.ID, m.ID)
			}
		}
	}
	// Die Kennung, an der die Steuerungs-Freigabe der Anlage Pilsting haengt
	// (inverter_control_certification, V20260814000000), ist unveraendert
	// aufloesbar - inklusive Registerkarte und Nennleistung.
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "192.168.0.28", Port: 8899, Serial: "2985159064", MbSlaveID: 1},
	}, time.Unix(0, 0).UTC())
	if err != nil {
		t.Fatalf("Bestands-Auswahl loest nicht mehr auf: %v", err)
	}
	if sel.Model != "sun-30k-sg01hp3" || sel.Family != FamHybrid3p {
		t.Errorf("Bestands-Auswahl verschoben: %s / %s", sel.Model, sel.Family)
	}
}

// TestNoNameplateVariantCollidesWithARealSelection schuetzt den Namensraum:
// eine Variante darf nie so heissen wie ein Modell-Label oder eine
// Modell-Kennung - sonst waere unklar, ob eine Eingabe den Alias oder den
// Eintrag selbst meint.
func TestNoNameplateVariantCollidesWithARealSelection(t *testing.T) {
	labels := map[string]string{}
	ids := map[string]string{}
	for _, b := range DefaultCatalog().Brands {
		for _, m := range b.Models {
			labels[strings.ToLower(m.Label)] = b.ID + "/" + m.ID
			ids[strings.ToLower(m.ID)] = b.ID + "/" + m.ID
		}
	}
	seen := map[string]string{}
	for _, b := range DefaultCatalog().Brands {
		for _, m := range b.Models {
			for _, a := range m.Aliases {
				key := strings.ToLower(strings.TrimSpace(a))
				if key == "" {
					t.Errorf("%s/%s: leerer Alias", b.ID, m.ID)
					continue
				}
				if owner, ok := labels[key]; ok {
					t.Errorf("Alias %q von %s/%s ist schon das Label von %s", a, b.ID, m.ID, owner)
				}
				if owner, ok := ids[key]; ok {
					t.Errorf("Alias %q von %s/%s ist schon die Kennung von %s", a, b.ID, m.ID, owner)
				}
				if owner, ok := seen[key]; ok {
					t.Errorf("Alias %q steht bei %s UND bei %s/%s", a, owner, b.ID, m.ID)
				}
				seen[key] = b.ID + "/" + m.ID
			}
		}
	}
}

// TestTheExportCarriesTheVariantsAndNothingElse: die Vorlagen-Datei, aus der
// die Cloud ihr Register fuellt, transportiert die Varianten - ohne einen
// eigenen Vorlagen-Schluessel dafuer zu erfinden.
func TestTheExportCarriesTheVariantsAndNothingElse(t *testing.T) {
	var found *Template
	refs := map[string]bool{}
	for i, tpl := range BuiltinTemplates() {
		refs[tpl.TemplateRef] = true
		if tpl.TemplateRef == BuiltinTemplateRef(BrandDeye, "sun-30k-sg01hp3") {
			found = &BuiltinTemplates()[i]
		}
	}
	if found == nil {
		t.Fatal("die Vorlage sun-30k-sg01hp3 fehlt im Export")
	}
	if len(found.ModelAliases) != 2 || found.ModelAliases[0] != "SUN-30K-SG01HP3-EU-BM3" {
		t.Errorf("Varianten fehlen im Export: %v", found.ModelAliases)
	}
	for _, a := range found.ModelAliases {
		bad := BuiltinTemplateRef(BrandDeye, strings.ToLower(a))
		if refs[bad] {
			t.Errorf("die Variante %q hat einen EIGENEN Vorlagen-Schluessel bekommen", a)
		}
	}
}
