package boxevents

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const (
	tenant = "11111111-1111-4111-8111-111111111111"
	site   = "22222222-2222-4222-8222-222222222222"
	box    = "33333333-3333-4333-8333-333333333333"
	eid    = "44444444-4444-4444-4444-444444444444"
)

func ident() Identity { return Identity{TenantID: tenant, SiteID: site, DeviceID: box} }

// Das Vokabular ist das der Cloud. Diese Prüfung liest den GEBAUTEN Vertrag und
// vergleicht ihn mit der Tabelle dieses Pakets - Wort für Wort, Feld für Feld.
func TestVokabularIstDasDesVertrags(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/mqtt-events-2.1.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		Defs map[string]struct {
			Required   []string                   `json:"required"`
			Properties map[string]json.RawMessage `json:"properties"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	vertrag := map[string]struct{}{}
	for name, def := range schema.Defs {
		if !strings.HasPrefix(name, "box_") || name == "box_ereignis" {
			continue
		}
		art := strings.TrimPrefix(name, "box_")
		regel, bekannt := arten[art]
		if !bekannt {
			t.Fatalf("Vertrag kennt die Art %q, das Paket nicht", art)
		}
		vertrag[art] = struct{}{}
		if !reflect.DeepEqual(sortiert(def.Required), sortiert(regel.pflicht)) {
			t.Fatalf("%s: Pflichtfelder %v != %v", art, def.Required, regel.pflicht)
		}
		for feld := range def.Properties {
			if _, erlaubt := regel.erlaubt[feld]; !erlaubt {
				t.Fatalf("%s: Vertrag erlaubt %q, das Paket nicht", art, feld)
			}
		}
		for feld := range regel.erlaubt {
			if _, erlaubt := def.Properties[feld]; !erlaubt {
				t.Fatalf("%s: das Paket erfindet %q", art, feld)
			}
		}
	}
	if len(vertrag) != len(arten) {
		t.Fatalf("Arten des Pakets %v, des Vertrags %v", Arten(), vertrag)
	}
}

func sortiert(in []string) []string {
	out := append([]string(nil), in...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// clock_jump ist KEINE Box-Art: sein Urheber ist die Datenannahme
// (events-vocabulary.md §4, Spalte "Box" = "-"). Die Box darf ihn nie senden.
func TestClockJumpIstKeinBoxWort(t *testing.T) {
	for _, art := range []string{"clock_jump", "clock_ahead", "too_old", "rejected",
		"sequence_gap", "backfill", "handover", "counter_reset"} {
		if _, err := Pruefe(map[string]any{"ereignis_id": eid, "art": art,
			"zeitpunkt": "2027-02-01T10:00:00Z"}); err == nil {
			t.Fatalf("%s wurde als Box-Art angenommen", art)
		}
	}
	if _, err := VomTreiber([]byte(`{"art":"clock_jump","zeitpunkt":"2027-02-01T10:00:00Z"}`),
		NeueID); err == nil {
		t.Fatal("ein Treiber durfte clock_jump melden")
	}
}

func TestGeschlosseneFelderUndTypen(t *testing.T) {
	gut := map[string]any{"ereignis_id": eid, "art": "range_limit",
		"zeitpunkt": "2027-02-01T10:00:00Z", "datenquelle": "EK-3", "statuswort": 4096}
	if _, err := Pruefe(gut); err != nil {
		t.Fatal(err)
	}
	schlecht := []map[string]any{
		{"ereignis_id": eid, "art": "range_limit", "zeitpunkt": "2027-02-01T10:00:00Z",
			"datenquelle": "EK-3", "messstelle": "MS-10"}, // die Box kennt keine Messstelle
		{"ereignis_id": eid, "art": "range_limit", "zeitpunkt": "2027-02-01T10:00:00Z",
			"datenquelle": "EK-3", "statuswort": 65536}, // über dem Wertebereich
		{"ereignis_id": eid, "art": "range_limit", "zeitpunkt": "2027-02-01T10:00:00Z"}, // Pflicht fehlt
		{"ereignis_id": "keine-uuid", "art": "box_restart", "zeitpunkt": "2027-02-01T10:00:00Z"},
		{"ereignis_id": eid, "art": "box_restart", "zeitpunkt": "2027-02-01T10:00:00.500Z"},
		{"ereignis_id": eid, "art": "box_restart", "zeitpunkt": "2027-02-01T10:00:00+01:00"},
		{"ereignis_id": eid, "art": "data_gap", "von": "2027-02-01T10:00:00Z",
			"bis": "2027-02-01T11:00:00Z", "erkannt_aus": "kadenz"}, // kadenz ist die des Writers
		{"ereignis_id": eid, "art": "frozen_source", "zeitpunkt": "2027-02-01T10:00:00Z",
			"datenquelle": "EK-3", "lesungen": 0}, // ganz_ab_1
		{"ereignis_id": eid, "art": "device_restart", "zeitpunkt": "2027-02-01T10:00:00Z",
			"datenquelle": "EK 3"}, // Leerzeichen verletzt das Kennungsmuster
	}
	for i, e := range schlecht {
		if _, err := Pruefe(e); err == nil {
			t.Fatalf("Fall %d wurde angenommen: %v", i, e)
		}
	}
}

// Ein Treiber darf nur melden, was er auch sehen kann. box_restart und die
// Puffer-Verdrängung weiß nur der Kern.
func TestTreiberDarfKeinKernEreignisMelden(t *testing.T) {
	for _, roh := range []string{
		`{"art":"box_restart","zeitpunkt":"2027-02-01T10:00:00Z"}`,
		`{"art":"data_gap","von":"2027-02-01T10:00:00Z","bis":"2027-02-01T11:00:00Z","erkannt_aus":"verdraengung"}`,
	} {
		if _, err := VomTreiber([]byte(roh), NeueID); err == nil {
			t.Fatalf("Treiber durfte %s melden", roh)
		}
	}
	e, err := VomTreiber([]byte(`{"art":"layout_changed","zeitpunkt":"2027-03-01T08:00:00Z",`+
		`"datenquelle":"EK-7","fassung_erwartet":1,"fassung_gelesen":2}`), NeueID)
	if err != nil {
		t.Fatal(err)
	}
	if !uuidMuster.MatchString(e["ereignis_id"].(string)) {
		t.Fatalf("der Kern hat keine Ereignis-Kennung vergeben: %v", e)
	}
}

func TestUmschlagIstVertragstreu(t *testing.T) {
	dir := t.TempDir()
	o, err := OpenOutbox(dir, 4)
	if err != nil {
		t.Fatal(err)
	}
	neustart, err := BoxNeustart(eid, time.Date(2027, 2, 1, 9, 59, 30, 700_000_000, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	env, err := o.Append([]Ereignis{neustart}, ident(),
		time.Date(2027, 2, 1, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(env.Raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["schema_version"] != "2.1" || wire["tenant_id"] != tenant ||
		wire["site_id"] != site || wire["device_id"] != box ||
		wire["observed_at"] != "2027-02-01T10:00:00Z" {
		t.Fatalf("Umschlag: %v", wire)
	}
	if wire["sequence"].(float64) != 0 {
		t.Fatalf("Sequenz: %v", wire["sequence"])
	}
	ereignisse := wire["events"].([]any)
	if len(ereignisse) != 1 {
		t.Fatalf("Ereignisse: %v", ereignisse)
	}
	erstes := ereignisse[0].(map[string]any)
	// Auf die Sekunde ABGESCHNITTEN, nie gerundet: 09:59:30.7 bleibt 09:59:30.
	if erstes["zeitpunkt"] != "2027-02-01T09:59:30Z" || erstes["art"] != "box_restart" {
		t.Fatalf("Ereignis: %v", erstes)
	}
	if _, da := erstes["box"]; da {
		t.Fatal("die Box steht im Topic, nie im Ereignis")
	}
}

func TestOutboxVerliertNichtsUndVerdoppeltNichts(t *testing.T) {
	dir := t.TempDir()
	o, err := OpenOutbox(dir, 8)
	if err != nil {
		t.Fatal(err)
	}
	e, _ := BoxNeustart(eid, time.Date(2027, 2, 1, 9, 0, 0, 0, time.UTC))
	if _, err := o.Append([]Ereignis{e}, ident(), time.Date(2027, 2, 1, 9, 0, 1, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	// Ein Uplink-Ausfall: Next, kein Ack, Prozess stirbt.
	erst, ok := o.Next()
	if !ok {
		t.Fatal("nichts zu senden")
	}
	wieder, err := OpenOutbox(dir, 8)
	if err != nil {
		t.Fatal(err)
	}
	if wieder.Pending() != 1 {
		t.Fatalf("nach dem Neustart offen: %d", wieder.Pending())
	}
	nochmal, ok := wieder.Next()
	if !ok {
		t.Fatal("der Replay fand nichts")
	}
	// Byte-gleich: dieselbe Sequenz, dieselbe Ereignis-Kennung, dieselbe Zeit.
	if string(nochmal.Raw) != string(erst.Raw) {
		t.Fatalf("Replay verändert den Umschlag:\n%s\n%s", erst.Raw, nochmal.Raw)
	}
	if err := wieder.Ack(nochmal.Sequence); err != nil {
		t.Fatal(err)
	}
	if wieder.Pending() != 0 {
		t.Fatalf("nach dem Ack offen: %d", wieder.Pending())
	}
	// Die nächste Sequenz zählt weiter, sie beginnt nicht neu.
	zweite, err := wieder.Append([]Ereignis{e}, ident(), time.Date(2027, 2, 1, 9, 5, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if zweite.Sequence != 1 {
		t.Fatalf("Sequenz nach Neustart: %d", zweite.Sequence)
	}
}

func TestOutboxWeistLeereUndUeberlangeUmschlaegeAb(t *testing.T) {
	o, err := OpenOutbox(t.TempDir(), 4)
	if err != nil {
		t.Fatal(err)
	}
	e, _ := BoxNeustart(eid, time.Now())
	if _, err := o.Append(nil, ident(), time.Now()); err == nil {
		t.Fatal("leerer Umschlag angenommen")
	}
	zuviele := make([]Ereignis, MaxEvents+1)
	for i := range zuviele {
		zuviele[i] = e
	}
	if _, err := o.Append(zuviele, ident(), time.Now()); err == nil {
		t.Fatal("65 Ereignisse angenommen")
	}
	if _, err := o.Append([]Ereignis{e}, Identity{TenantID: tenant}, time.Now()); err == nil {
		t.Fatal("Umschlag ohne vollständige Kennung angenommen")
	}
	if len(mussLeer(t, o)) != 0 {
		t.Fatal("ein abgewiesener Umschlag liegt in der Outbox")
	}
}

func mussLeer(t *testing.T, o *Outbox) []string {
	t.Helper()
	f, err := o.files()
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestOutboxVerdraengtAeltesteUndZaehltDas(t *testing.T) {
	dir := t.TempDir()
	o, err := OpenOutbox(dir, 3)
	if err != nil {
		t.Fatal(err)
	}
	e, _ := BoxNeustart(eid, time.Now())
	for i := 0; i < 5; i++ {
		if _, err := o.Append([]Ereignis{e}, ident(), time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if o.Pending() != 3 || o.Verdraengt() != 2 {
		t.Fatalf("offen %d, verdrängt %d", o.Pending(), o.Verdraengt())
	}
	// Die Lücke ist an der Sequenz sichtbar: die Cloud wertet sie als
	// sequence_gap mit strom = events aus.
	next, _ := o.Next()
	var wire map[string]any
	_ = json.Unmarshal(next.Raw, &wire)
	if wire["sequence"].(float64) != 2 {
		t.Fatalf("älteste überlebende Sequenz: %v", wire["sequence"])
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); err != nil {
		t.Fatal(err)
	}
}

// Die Zeitsprung-Erkennung mit injizierter Uhr: die Box ohne Echtzeituhr startet
// 1970, bekommt drei Minuten später NTP - und meldet den KORRIGIERTEN Startzeitpunkt.
func TestZeitsprungKorrigiertDenStempelStattIhnZuMelden(t *testing.T) {
	wand := time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)
	var laufzeit time.Duration
	uhr := Uhr(func() (time.Time, time.Duration) { return wand, laufzeit })
	wache := NeueZeitWache(uhr)

	laufzeit = 180 * time.Second
	wand = time.Date(2027, 2, 1, 10, 3, 0, 0, time.UTC) // NTP setzt die Uhr.
	sprungS, sprang := wache.Pruefe(uhr)
	if !sprang || sprungS <= 0 {
		t.Fatalf("Sprung nicht erkannt: %d s", sprungS)
	}
	if wache.Spruenge() != 1 || wache.LetzterSprungS() != sprungS {
		t.Fatalf("Zähler: %d / %d", wache.Spruenge(), wache.LetzterSprungS())
	}
	start := wache.Startzeit(uhr)
	if !start.Equal(time.Date(2027, 2, 1, 10, 0, 0, 0, time.UTC)) {
		t.Fatalf("Startzeit aus der korrigierten Uhr: %s", start)
	}
	e, err := BoxNeustart(eid, start)
	if err != nil {
		t.Fatal(err)
	}
	if e["zeitpunkt"] != "2027-02-01T10:00:00Z" {
		t.Fatalf("box_restart trägt den alten Stempel: %v", e)
	}
	// Normaler Lauf: Wanduhr und Laufzeit gehen gleich weiter - kein Sprung.
	laufzeit += 60 * time.Second
	wand = wand.Add(61 * time.Second)
	if _, sprang := wache.Pruefe(uhr); sprang {
		t.Fatal("eine Sekunde Drift ist kein Sprung")
	}
	// Genau an der Schwelle ist es noch KEIN Sprung (wie clock_ahead: erst > 300 s).
	laufzeit += 60 * time.Second
	wand = wand.Add(60*time.Second + SprungSchwelleS*time.Second)
	if abweichung, sprang := wache.Pruefe(uhr); sprang || abweichung != SprungSchwelleS {
		t.Fatalf("genau 300 s gelten schon als Sprung: %d s", abweichung)
	}
	// Eine Sekunde darüber schon - und rückwärts genauso.
	laufzeit += 60 * time.Second
	wand = wand.Add(60*time.Second - (SprungSchwelleS+1)*time.Second)
	if abweichung, sprang := wache.Pruefe(uhr); !sprang || abweichung != -(SprungSchwelleS+1) {
		t.Fatalf("Rücksprung nicht erkannt: %d s", abweichung)
	}
	if wache.Spruenge() != 2 {
		t.Fatalf("Sprünge: %d", wache.Spruenge())
	}
}

func TestPufferVerdraengungIstHalboffenUndTraegtDieMenge(t *testing.T) {
	von := time.Date(2026, 11, 3, 9, 40, 0, 0, time.UTC)
	bis := time.Date(2026, 11, 6, 9, 40, 0, 0, time.UTC)
	e, err := PufferVerdraengung(eid, von, bis, 3640, "DQ-4")
	if err != nil {
		t.Fatal(err)
	}
	if e["art"] != "data_gap" || e["erkannt_aus"] != "verdraengung" ||
		e["von"] != "2026-11-03T09:40:00Z" || e["bis"] != "2026-11-06T09:40:00Z" ||
		e["erwartet_fehlend"] != int64(3640) || e["datenquelle"] != "DQ-4" {
		t.Fatalf("Verdrängung: %v", e)
	}
	ohne, err := PufferVerdraengung(eid, von, bis, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	// Ein Feld, das diese Lesung nicht ergeben hat, FEHLT - es wird nie 0.
	if _, da := ohne["erwartet_fehlend"]; da {
		t.Fatalf("erwartet_fehlend als 0 erfunden: %v", ohne)
	}
	if _, da := ohne["datenquelle"]; da {
		t.Fatalf("Datenquelle erfunden: %v", ohne)
	}
}

// Die Beispiel-Umschläge des gebauten Vertrags sind der Gegenbeweis: was die
// Cloud annimmt, muss dieses Paket annehmen - und was sie abweist, abweisen.
func TestVertragsbeispieleEntscheidenGleich(t *testing.T) {
	dir := "../../../../docs/contracts/v2/examples"
	eintraege, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	gesehen := 0
	for _, e := range eintraege {
		name := e.Name()
		if !strings.HasPrefix(name, "mqtt-events-2.1.") {
			continue
		}
		gesehen++
		roh, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		var umschlag map[string]any
		if err := json.Unmarshal(roh, &umschlag); err != nil {
			t.Fatal(err)
		}
		if umschlag["schema_version"] != SchemaVersion {
			t.Fatalf("%s: Fassung %v", name, umschlag["schema_version"])
		}
		gueltig := strings.Contains(name, ".valid.")
		alleOk := true
		for _, roh := range umschlag["events"].([]any) {
			if _, err := Pruefe(roh.(map[string]any)); err != nil {
				alleOk = false
			}
		}
		if alleOk != gueltig {
			t.Fatalf("%s: angenommen=%v, erwartet=%v", name, alleOk, gueltig)
		}
	}
	if gesehen < 3 {
		t.Fatalf("nur %d Beispiel-Umschläge gefunden", gesehen)
	}
}
