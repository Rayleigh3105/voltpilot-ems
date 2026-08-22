package inverter

// KATALOG-NEUSTRUKTUR (Konzept data/vp-anlegen-rework/konzept.md, Stufe 1).
//
// Zwei Dinge werden hier bewiesen, und das zweite ist das wichtigere:
//
//  1. die NEUE Struktur tut, was sie verspricht (Geraetetyp-Dimension, EIN
//     Fronius mit Transport je Modell + Experten-Ausweg, offizielle
//     Schreibweisen ohne Technik-Klammern, kein Duplikat mehr);
//  2. die UPDATE-KONTINUITAET: eine Bestandsanlage, die eine ALTE Marken-/
//     Familien-/Modell-Kennung traegt, loest danach unveraendert auf und
//     behaelt Verhalten UND Identitaet (das Muster aus PR 425).

import (
	"strings"
	"testing"
)

// --- 1. Geraetetyp-Dimension ------------------------------------------------

func TestEveryBrandDeclaresAKnownDeviceType(t *testing.T) {
	known := map[string]bool{
		DeviceTypeInverter: true, DeviceTypeWallbox: true, DeviceTypeSwitch: true,
		DeviceTypeMeter: true, DeviceTypeChargePoint: true, DeviceTypeCustom: true,
	}
	for _, b := range DefaultCatalog().Brands {
		if !known[b.DeviceType] {
			t.Errorf("Marke %s traegt den unbekannten Geraetetyp %q", b.ID, b.DeviceType)
		}
		for _, m := range b.Models {
			if got := b.DeviceTypeOf(m); !known[got] {
				t.Errorf("Marke %s Modell %s traegt den unbekannten Geraetetyp %q", b.ID, m.ID, got)
			}
		}
	}
}

func TestTheConsumerDriversAreTypedNotBrandedAsCategories(t *testing.T) {
	cat := DefaultCatalog()
	for _, tc := range []struct{ brand, label, deviceType string }{
		{BrandGoe, "go-e", DeviceTypeWallbox},
		{BrandShelly, "Shelly", DeviceTypeSwitch},
	} {
		b, ok := cat.brand(tc.brand)
		if !ok {
			t.Fatalf("Marke %s fehlt", tc.brand)
		}
		if b.Label != tc.label {
			t.Errorf("%s heisst %q, erwartet %q (offizielle Schreibweise, ohne Kategorie im Namen)", tc.brand, b.Label, tc.label)
		}
		if b.DeviceType != tc.deviceType {
			t.Errorf("%s ist Typ %q, erwartet %q", tc.brand, b.DeviceType, tc.deviceType)
		}
	}
}

// TestNoBrandLabelCarriesATechnicalParenthesis nagelt Captain-Entscheid 4 fest:
// ALLE Klammer-Technik-Zusaetze fliegen aus den MARKENnamen; die Technik steht
// in der Beschreibungszeile bzw. am Transport.
func TestNoBrandLabelCarriesATechnicalParenthesis(t *testing.T) {
	for _, b := range DefaultCatalog().Brands {
		if strings.ContainsAny(b.Label, "()/") {
			t.Errorf("Markenname %q traegt einen Technik-Zusatz - er gehoert in Note/Transport", b.Label)
		}
	}
}

// --- 2. EIN Fronius, Transport je Modell ------------------------------------

func TestOnlyOneFroniusIsOffered(t *testing.T) {
	seen := map[string]int{}
	for _, b := range DefaultCatalog().VisibleBrands() {
		seen[b.Label]++
	}
	if seen["Fronius"] != 1 {
		t.Fatalf("Fronius wird %d-mal angeboten, erwartet genau einmal", seen["Fronius"])
	}
	for label, n := range seen {
		if n > 1 {
			t.Errorf("Marke %q wird %d-mal angeboten", label, n)
		}
	}
}

func TestFroniusTransportPerModel(t *testing.T) {
	b, _ := DefaultCatalog().brand(BrandFronius)
	for _, tc := range []struct{ model, wantComm, wantFamily string }{
		{FamFroniusSolarAPI, CommFroniusSolarAPI, FamFroniusSolarAPI},
		{"fronius-eco-27-3-s", CommFroniusSunSpec, FamSunSpecLive},
		{"fronius-eco-25-3-s", CommFroniusSunSpec, FamSunSpecLive},
		{FamSunSpecLive, CommFroniusSunSpec, FamSunSpecLive},
	} {
		sel, err := DefaultCatalog().Normalize(SelectionRequest{
			Brand: BrandFronius, Model: tc.model,
			Connection: Connection{IP: "192.168.0.20"},
		}, now)
		if err != nil {
			t.Fatalf("%s: %v", tc.model, err)
		}
		if sel.Communication != tc.wantComm {
			t.Errorf("%s: Verbindungsweg %q, erwartet %q", tc.model, sel.Communication, tc.wantComm)
		}
		if sel.Family != tc.wantFamily {
			t.Errorf("%s: Registerprofil %q, erwartet %q", tc.model, sel.Family, tc.wantFamily)
		}
	}
	_ = b
}

// TestTheExpertOverrideSwitchesTransportAndProfile ist der „die Solar API
// antwortet nicht"-Fall: der Kunde stellt den Verbindungsweg um, und damit
// wechselt auch das Decode-Profil - sonst waere die Umstellung wirkungslos.
func TestTheExpertOverrideSwitchesTransportAndProfile(t *testing.T) {
	cat := DefaultCatalog()
	sel, err := cat.Normalize(SelectionRequest{
		Brand: BrandFronius, Model: FamFroniusSolarAPI,
		Connection: Connection{IP: "192.168.0.20", Transport: CommFroniusSunSpec},
	}, now)
	if err != nil {
		t.Fatalf("Ausweg abgelehnt: %v", err)
	}
	if sel.Communication != CommFroniusSunSpec || sel.Family != FamSunSpecLive {
		t.Fatalf("Ausweg wirkungslos: %q/%q", sel.Communication, sel.Family)
	}
	if sel.Connection.Port != defaultFroniusSunSpecPort || sel.Connection.UnitID != 1 {
		t.Errorf("Vorgaben des gewaehlten Wegs fehlen: %+v", sel.Connection)
	}
	// Der Weg IST `communication`; das Anfrage-Feld darf nirgends ueberleben.
	if sel.Connection.Transport != "" {
		t.Errorf("das Anfrage-Feld wurde nicht geloescht: %q", sel.Connection.Transport)
	}
	if strings.Contains(string(sel.BusPayload()), "\"transport\"") {
		t.Error("der Verbindungsweg darf nicht als eigenes Feld veroeffentlicht werden")
	}
}

func TestAnUnavailableTransportIsRejectedNotSilentlyIgnored(t *testing.T) {
	cat := DefaultCatalog()
	if _, err := cat.Normalize(SelectionRequest{
		Brand: BrandDeye, Model: "sun-30k-sg01hp3",
		Connection: Connection{IP: "1.2.3.4", Serial: "s", Transport: CommFroniusSunSpec},
	}, now); err == nil {
		t.Fatal("ein Weg, den das Modell nicht kennt, muss abgelehnt werden")
	}
}

// TestASingleTransportModelOffersNoChoice: wo es nichts zu waehlen gibt, gibt es
// kein Auswahlfeld - ein Feld mit genau einer Option waere Laerm.
func TestASingleTransportModelOffersNoChoice(t *testing.T) {
	for _, b := range DefaultCatalog().Brands {
		for _, m := range b.Models {
			multi := len(b.TransportsFor(m)) > 1
			hasField := false
			for _, f := range b.FieldsFor(m, "") {
				if f.Key == "transport" {
					hasField = true
				}
			}
			if multi != hasField {
				t.Errorf("Marke %s Modell %s: %d Wege, Auswahlfeld=%v", b.ID, m.ID, len(b.TransportsFor(m)), hasField)
			}
			if len(m.Fields) > 0 && !multi {
				t.Errorf("Marke %s Modell %s traegt eigene Felder ohne mehrere Wege", b.ID, m.ID)
			}
		}
	}
}

// --- 3. Duplikat-Fix --------------------------------------------------------

func TestNoBrandShowsTheSameLabelForAModelAndItsFamily(t *testing.T) {
	for _, b := range DefaultCatalog().Brands {
		fams := map[string]bool{}
		for _, f := range b.Families {
			fams[f.Label] = true
		}
		for _, m := range b.Models {
			if fams[m.Label] {
				t.Errorf("Marke %s zeigt %q zweimal (als Modell UND als Familie)", b.ID, m.Label)
			}
		}
	}
}

// --- 4. UPDATE-KONTINUITAET (das Muster aus PR 425) -------------------------

// legacySelections sind Auswahl-Zeilen, wie sie auf BESTEHENDEN Boxen in
// `inverter.json`/`sources.json` liegen bzw. wie die Cloud sie im Registry-Push
// zurueckschickt. Sie muessen nach der Neustrukturierung UNVERAENDERT aufloesen.
func legacySelections() []SelectionRequest {
	return []SelectionRequest{
		// Anlage Herzogau: zwei Fronius Eco hinter EINEM Datamanager, unter der
		// frueher eigenstaendigen Marke `fronius_sunspec`.
		{Brand: BrandFroniusSunSpec, Model: "fronius-eco-27-3-s",
			Connection: Connection{IP: "192.168.210.40", Port: 502, UnitID: 1}},
		{Brand: BrandFroniusSunSpec, Model: "fronius-eco-27-3-s",
			Connection: Connection{IP: "192.168.210.40", Port: 502, UnitID: 2}},
		{Brand: BrandFroniusSunSpec, Model: FamSunSpecLive,
			Connection: Connection{IP: "192.168.210.41", Port: 502, UnitID: 1}},
		// Der generische Fronius ueber die Solar API.
		{Brand: BrandFronius, Model: FamFroniusSolarAPI,
			Connection: Connection{IP: "192.168.0.20", Port: 80}},
		// Anlage Pilsting: der Deye-Hybrid.
		{Brand: BrandDeye, Model: "sun-30k-sg01hp3",
			Connection: Connection{IP: "192.168.0.28", Port: 8899, Serial: "2985159064", MbSlaveID: 1}},
		// Der generische Modbus-Eintrag (Kennung `sunspec`).
		{Brand: BrandGenericModbus, Model: FamSunSpec,
			Connection: Connection{IP: "192.168.0.50", Port: 502, UnitID: 1}},
		// Verbraucher-Treiber.
		{Brand: BrandGoe, Model: FamGoeHTTP, Connection: Connection{IP: "192.168.0.60", Port: 80}},
		{Brand: BrandShelly, Model: FamShellyHTTP, Connection: Connection{IP: "192.168.0.61", Port: 80}},
		// KOSTAL.
		{Brand: BrandKostal, Model: "plenticore-bi-10-26",
			Connection: Connection{IP: "192.168.0.70", Port: 1502, UnitID: 71}},
		// Eine reine FAMILIEN-Anfrage (aelterer Client / Integration).
		{Brand: BrandDeye, Family: FamHybrid3p,
			Connection: Connection{IP: "192.168.0.28", Port: 8899, Serial: "2985159064", MbSlaveID: 1}},
		{Brand: BrandFroniusSunSpec, Family: FamSunSpecLive,
			Connection: Connection{IP: "192.168.210.40", Port: 502, UnitID: 1}},
	}
}

// TestEveryLegacySelectionStillResolvesUnchanged ist der Kontinuitaets-Beweis:
// Marke, Modell, Registerprofil und Verbindungsweg einer Bestandsanlage bleiben
// nach der Neustrukturierung, was sie waren - der Bus-Payload also auch.
func TestEveryLegacySelectionStillResolvesUnchanged(t *testing.T) {
	cat := DefaultCatalog()
	want := []struct{ comm, family string }{
		{CommFroniusSunSpec, FamSunSpecLive},
		{CommFroniusSunSpec, FamSunSpecLive},
		{CommFroniusSunSpec, FamSunSpecLive},
		{CommFroniusSolarAPI, FamFroniusSolarAPI},
		{CommSolarmanV5, FamHybrid3p},
		{CommModbusTCP, FamSunSpec},
		{CommGoeHTTP, FamGoeHTTP},
		{CommShellyHTTP, FamShellyHTTP},
		{CommKostalModbus, FamKostalPlenticore},
		{CommSolarmanV5, FamHybrid3p},
		{CommFroniusSunSpec, FamSunSpecLive},
	}
	reqs := legacySelections()
	if len(reqs) != len(want) {
		t.Fatalf("Vektoren aus dem Tritt: %d/%d", len(reqs), len(want))
	}
	for i, req := range reqs {
		sel, err := cat.Normalize(req, now)
		if err != nil {
			t.Fatalf("Bestandsauswahl %d (%s/%s) wird abgelehnt: %v", i, req.Brand, req.Model+req.Family, err)
		}
		if sel.Brand != req.Brand {
			t.Errorf("Bestandsauswahl %d: die Marken-Kennung hat sich geaendert: %q -> %q", i, req.Brand, sel.Brand)
		}
		if sel.Model != req.Model {
			t.Errorf("Bestandsauswahl %d: die Modell-Kennung hat sich geaendert: %q -> %q", i, req.Model, sel.Model)
		}
		if sel.Communication != want[i].comm {
			t.Errorf("Bestandsauswahl %d: Verbindungsweg %q, erwartet %q", i, sel.Communication, want[i].comm)
		}
		if sel.Family != want[i].family {
			t.Errorf("Bestandsauswahl %d: Registerprofil %q, erwartet %q", i, sel.Family, want[i].family)
		}
	}
}

// TestTheLegacyFroniusBrandStaysResolvableButHidden: die Alias-Ebene. Sie darf
// nicht angeboten werden, muss aber jede Nachfrage beantworten - sonst verloere
// eine Bestandsanlage ihre Vorlage und ihre Bestands-Uebernahme.
func TestTheLegacyFroniusBrandStaysResolvableButHidden(t *testing.T) {
	cat := DefaultCatalog()
	b, ok := cat.brand(BrandFroniusSunSpec)
	if !ok {
		t.Fatal("die abgeloeste Marke muss aufloesbar bleiben")
	}
	if !b.Hidden || b.SupersededBy != BrandFronius {
		t.Fatalf("sie muss versteckt sein und ihren Nachfolger nennen: %+v", b)
	}
	for _, v := range cat.VisibleBrands() {
		if v.ID == BrandFroniusSunSpec {
			t.Error("eine versteckte Marke darf nicht angeboten werden")
		}
	}
	// Backfill (der Boot-Pfad jeder Bestandsbox) loest sie ebenfalls auf.
	sel := Selection{Brand: BrandFroniusSunSpec, Model: "fronius-eco-27-3-s", Family: FamSunSpecLive}
	out, _, resolved := cat.Backfill(sel)
	if !resolved {
		t.Fatal("Backfill muss die abgeloeste Marke aufloesen")
	}
	if out.RatedKw != 27 {
		t.Errorf("Nennleistung aus dem Alias: %v", out.RatedKw)
	}
	if kw, ok := cat.RatedKw(BrandFroniusSunSpec, "fronius-eco-27-3-s"); !ok || kw != 27 {
		t.Errorf("RatedKw ueber die alte Kennung: %v/%v", kw, ok)
	}
}

// TestEveryHiddenBrandModelHasASuccessor: eine versteckte Marke ohne Nachfolger
// waere eine Sackgasse - ihre Geraete liessen sich nie wieder anlegen.
func TestEveryHiddenBrandModelHasASuccessor(t *testing.T) {
	cat := DefaultCatalog()
	for _, b := range cat.Brands {
		if !b.Hidden {
			continue
		}
		succ, ok := cat.brand(b.SupersededBy)
		if !ok {
			t.Fatalf("Marke %s nennt den unbekannten Nachfolger %q", b.ID, b.SupersededBy)
		}
		for _, m := range b.Models {
			if _, ok := succ.model(m.ID); !ok {
				t.Errorf("Modell %s/%s hat im Nachfolger %s keine Entsprechung", b.ID, m.ID, succ.ID)
			}
		}
	}
}
