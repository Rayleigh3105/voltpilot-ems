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
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
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

// --- KACO ---------------------------------------------------------------------

// TestKacoReadsOverTheSharedSunSpecPath pins the whole point of the KACO catalog
// entry: the KACO-OWN line adds NO decoder. Every model resolves to the existing
// `sunspec_live` decode profile over the SunSpec-TCP way, so a KACO is read by
// exactly the walker a Fronius Eco is read by.
func TestKacoReadsOverTheSharedSunSpecPath(t *testing.T) {
	cat := DefaultCatalog()
	b, ok := cat.brand(BrandKaco)
	if !ok {
		t.Fatal("KACO is not in the catalog")
	}
	if b.DeviceType != DeviceTypeInverter {
		t.Errorf("KACO device type = %q, want %q", b.DeviceType, DeviceTypeInverter)
	}
	if len(b.Models) < 60 {
		t.Errorf("KACO offers only %d models - the palette should be Deye-dense", len(b.Models))
	}
	own := 0
	for _, m := range b.Models {
		ways := b.TransportsFor(m)
		if len(ways) != 1 || ways[0] != CommSunSpecTCP {
			continue // AISWEI-Plattform, eigener Test
		}
		own++
		if m.Family != FamSunSpecLive {
			t.Errorf("model %q family = %q, want %q", m.ID, m.Family, FamSunSpecLive)
		}
		sel, err := cat.Normalize(SelectionRequest{
			Brand: BrandKaco, Model: m.ID,
			Connection: Connection{IP: "192.168.0.9"},
		}, time.Now())
		if err != nil {
			t.Fatalf("model %q does not normalize: %v", m.ID, err)
		}
		if sel.Communication != CommSunSpecTCP || sel.Family != FamSunSpecLive {
			t.Errorf("model %q -> comm %q / family %q", m.ID, sel.Communication, sel.Family)
		}
		if sel.Connection.Port != 502 || sel.Connection.UnitID != 1 || sel.Connection.ModelType != "auto" {
			t.Errorf("model %q defaults: port=%d unit=%d model_type=%q",
				m.ID, sel.Connection.Port, sel.Connection.UnitID, sel.Connection.ModelType)
		}
	}
	if own < 40 {
		t.Errorf("nur %d Modelle der KACO-eigenen Linie", own)
	}
}

// TestKacoAisweiDefaultsToTheAppInterface pins the load-bearing decision of the
// AISWEI platform: the DEFAULT way is the communication unit's HTTP API, because
// it runs ALONGSIDE the KACO app and the SmartCloud. The stick's SunSpec mode is
// exclusive to the cloud, so it is the EXPERT way out - and every model says so
// in its own note, so nobody is surprised after switching.
func TestKacoAisweiDefaultsToTheAppInterface(t *testing.T) {
	cat := DefaultCatalog()
	b, _ := cat.brand(BrandKaco)
	aiswei := 0
	for _, m := range b.Models {
		ways := b.TransportsFor(m)
		if len(ways) < 2 {
			continue
		}
		aiswei++
		if ways[0] != CommKacoHTTP {
			t.Errorf("model %q default way = %q, want %q", m.ID, ways[0], CommKacoHTTP)
		}
		if ways[len(ways)-1] != CommSunSpecTCP {
			t.Errorf("model %q: the SunSpec way out must stay last, got %v", m.ID, ways)
		}
		if !strings.Contains(m.Note, "KACO-App/Cloud ab") {
			t.Errorf("model %q: the note must say what the SunSpec way out costs", m.ID)
		}
		sel, err := cat.Normalize(SelectionRequest{
			Brand: BrandKaco, Model: m.ID, Connection: Connection{IP: "192.168.0.30"},
		}, time.Now())
		if err != nil {
			t.Fatalf("model %q does not normalize: %v", m.ID, err)
		}
		if sel.Communication != CommKacoHTTP || sel.Connection.Port != defaultKacoHTTPPort {
			t.Errorf("model %q -> comm %q port %d", m.ID, sel.Communication, sel.Connection.Port)
		}
	}
	if aiswei < 20 {
		t.Errorf("nur %d Modelle der AISWEI-Plattform", aiswei)
	}
}

// TestTheNh3CarriesADifferentProfileOnTheSameHttpWay is the whole reason
// Model.FamilyPerTransport exists: the hybrid NH3 is read over the SAME HTTP
// interface as its string siblings, but its AC power is PV + discharge - charge,
// so it needs the DC-sourced profile. And the expert ways must STILL switch the
// profile - the trap a plain Model.Family would have walked into.
func TestTheNh3CarriesADifferentProfileOnTheSameHttpWay(t *testing.T) {
	cat := DefaultCatalog()
	for _, tc := range []struct {
		model, want, wantFamily string
	}{
		{"bp-hybrid-10.0-nh3-m3", CommKacoHTTP, FamKacoHTTPHybrid},
		{"bp-hybrid-10.0-nh3-m3", CommKacoModbus, FamKacoNH3},
		{"bp-hybrid-10.0-nh3-m3", CommSunSpecTCP, FamSunSpecLive},
		// Ein String-Geraet derselben Plattform bleibt auf dem NICHT-hybriden Profil.
		{"bp-10.0-nx3-m2", CommKacoHTTP, FamKacoHTTP},
		{"bp-10.0-nx3-m2", CommSunSpecTCP, FamSunSpecLive},
	} {
		sel, err := cat.Normalize(SelectionRequest{
			Brand: BrandKaco, Model: tc.model,
			Connection: Connection{IP: "192.168.0.30", Transport: tc.want},
		}, time.Now())
		if err != nil {
			t.Fatalf("%s over %s: %v", tc.model, tc.want, err)
		}
		if sel.Communication != tc.want || sel.Family != tc.wantFamily {
			t.Errorf("%s over %s -> comm %q family %q, want family %q",
				tc.model, tc.want, sel.Communication, sel.Family, tc.wantFamily)
		}
	}
	// Und die Batterie-Frage wird je Profil ehrlich beantwortet.
	if !FamilyHasBattery(FamKacoHTTPHybrid) || !FamilyHasBattery(FamKacoNH3) {
		t.Error("die NH3-Profile fuehren einen Speicher")
	}
	if FamilyHasBattery(FamKacoHTTP) {
		t.Error("ein NX-String-Geraet hat keinen Speicher")
	}
	// Ein String-Geraet ist NICHT „beweisbar batterielos" auf dem HTTP-Weg:
	// die API traegt keinen Beleg dafuer, und eine fehlende Batterie-Antwort
	// darf nie als physische 0 gelesen werden.
	if FamilyBatteryless(FamKacoHTTP) || FamilyBatteryless(FamKacoHTTPHybrid) {
		t.Error("die HTTP-Profile duerfen nicht als beweisbar batterielos gelten")
	}
}

// TestKacoRatedPowerIsTheAcNameplate pins the honest reading of the catalog's
// kW: it is the AC nameplate, which on the Powador TL3 line differs from the
// PRODUCT number (that one names the DC side). Too big a number blinds
// guards.Envelope, so this is a safety fact, not cosmetics.
func TestKacoRatedPowerIsTheAcNameplate(t *testing.T) {
	cat := DefaultCatalog()
	for _, tc := range []struct {
		model string
		want  float64
	}{
		{"powador-20.0-tl3", 17},      // product 20.0, AC 17 kW (KACO type table)
		{"powador-60.0-tl3", 49.9},    // product 60.0, AC 49,9 kW
		{"powador-39.0-tl3-m1", 33.3}, // product 39.0, AC 33,3 kW
		{"bp-2.6-tl1", 2.0},           // product 2.6, AC 2,0 kW
		{"bp-4.6-tl1", 4.6},           // here product == AC
		{"bp-165-tl3", 165},
		{"bp-gridsave-92.0-tl3-s", 92},
	} {
		got, ok := cat.RatedKw(BrandKaco, tc.model)
		if !ok || got != tc.want {
			t.Errorf("RatedKw(%q) = %v (ok=%v), want %v", tc.model, got, ok, tc.want)
		}
	}
	// The catch-all entry has NO rating - an invented one would be a claim about
	// a device nobody measured.
	if _, ok := cat.RatedKw(BrandKaco, "kaco-sunspec-generic"); ok {
		t.Error("the generic KACO entry must carry no nameplate")
	}
}

// TestKacoExcludesTheDevicesWithoutALocalInterface keeps the scout's exclusions
// (§2.9) honest: listing a device we cannot reach would promise an anbindung
// that does not exist. The hybrid 10.0 TL3 speaks the proprietary EDCOM
// protocol (partner identkey, no Modbus, no web interface); the Powador
// xi/supreme/2002 and TR3 lines speak KACO's RS232/RS485 ASCII protocol.
func TestKacoExcludesTheDevicesWithoutALocalInterface(t *testing.T) {
	cat := DefaultCatalog()
	b, _ := cat.brand(BrandKaco)
	for _, m := range b.Models {
		l := strings.ToLower(m.Label)
		// Der hybrid 10.0 TL3 - der EINZIGE „hybrid ... TL3" - spricht EDCOM.
		// Der hybride NH3 ist eine andere Plattform und wird gelistet.
		if strings.Contains(l, "hybrid") && strings.Contains(l, "tl3") {
			t.Errorf("model %q: der hybrid 10.0 TL3 hat keine lokale Schnittstelle (EDCOM mit Partner-Identkey)", m.Label)
		}
		for _, banned := range []string{"xi", "supreme", "tr3"} {
			if strings.Contains(l, " "+banned) || strings.HasSuffix(l, banned) {
				t.Errorf("model %q: %s devices speak the KACO ASCII protocol, not Modbus", m.Label, banned)
			}
		}
	}
}

// TestTheSunSpecTcpAliasIsOneWay pins the alias rule: `sunspec_tcp` and
// `fronius_sunspec` are the SAME read path under two ids. The Fronius id stays
// persisted and BYTE-IDENTICAL (the two Fronius Eco of Anlage Herzogau carry
// it); every brand added to the path afterwards carries the neutral one, so no
// operator surface has to call a KACO a "Fronius SunSpec".
func TestTheSunSpecTcpAliasIsOneWay(t *testing.T) {
	if !IsSunSpecTCP(CommFroniusSunSpec) || !IsSunSpecTCP(CommSunSpecTCP) {
		t.Fatal("both ids must name the SunSpec-live path")
	}
	if IsSunSpecTCP(CommModbusTCP) || IsSunSpecTCP(CommKostalModbus) || IsSunSpecTCP("") {
		t.Fatal("no other communication may pass as SunSpec-TCP")
	}
	cat := DefaultCatalog()
	// A Fronius Eco keeps its stored communication unchanged.
	fro, err := cat.Normalize(SelectionRequest{
		Brand: BrandFronius, Model: "fronius-eco-27-3-s",
		Connection: Connection{IP: "192.168.210.40"},
	}, time.Now())
	if err != nil {
		t.Fatalf("fronius eco: %v", err)
	}
	if fro.Communication != CommFroniusSunSpec {
		t.Errorf("the Fronius id must not move: got %q", fro.Communication)
	}
	// Both ways publish the SAME connection keys, so Layer 1 sees one shape.
	kac, err := cat.Normalize(SelectionRequest{
		Brand: BrandKaco, Model: "bp-4.6-tl1",
		Connection: Connection{IP: "192.168.0.9"},
	}, time.Now())
	if err != nil {
		t.Fatalf("kaco tl1: %v", err)
	}
	var froPayload, kacPayload map[string]any
	if err := json.Unmarshal(fro.BusPayload(), &froPayload); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(kac.BusPayload(), &kacPayload); err != nil {
		t.Fatal(err)
	}
	froKeys := sortedKeys(froPayload["connection"].(map[string]any))
	kacKeys := sortedKeys(kacPayload["connection"].(map[string]any))
	if !reflect.DeepEqual(froKeys, kacKeys) {
		t.Errorf("connection keys differ between the two ids:\n fronius %v\n kaco    %v", froKeys, kacKeys)
	}
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
