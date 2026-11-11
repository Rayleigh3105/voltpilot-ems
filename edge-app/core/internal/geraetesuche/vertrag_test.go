package geraetesuche

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

var vertrag = filepath.Join("..", "..", "..", "..", "docs", "contracts")

type fall struct {
	Name       string          `json:"name"`
	Topic      string          `json:"topic"`
	BoxArt     *string         `json:"box_art"`
	Ueberlesen json.RawMessage `json:"ueberlesen"`
	Payload    json.RawMessage `json:"payload"`
}

type familie struct {
	Gueltig        []fall `json:"gueltig"`
	Ungueltig      []fall `json:"ungueltig"`
	FundUeberlesen []fall `json:"fund_ueberlesen"`
	Toleriert      []fall `json:"toleriert"`
}

type vektoren struct {
	Topics   map[string]string   `json:"topics"`
	Grenzen  map[string]int      `json:"grenzen"`
	Gruende  map[string][]string `json:"gruende"`
	Erkenner []string            `json:"erkenner"`
	Wege     struct {
		Namen []string `json:"namen"`
	} `json:"wege"`
	NetztechnikArten  []string `json:"netztechnik_arten"`
	WeitereArten      []string `json:"weitere_arten"`
	Erkennungskatalog []struct {
		Erkenner      string  `json:"erkenner"`
		Art           string  `json:"art"`
		Schnitt       int     `json:"schnitt"`
		Communication *string `json:"communication"`
		Docker        *string `json:"docker"`
		EdgeLight     *string `json:"edge_light"`
	} `json:"erkennungskatalog"`
	Auftrag familie `json:"auftrag"`
	Frist   []struct {
		Name         string    `json:"name"`
		AusgeloestAm time.Time `json:"ausgeloest_am"`
		GueltigBis   time.Time `json:"gueltig_bis"`
		Jetzt        time.Time `json:"jetzt"`
		Beginnt      bool      `json:"beginnt"`
	} `json:"frist"`
	Stand    familie `json:"stand"`
	Ergebnis familie `json:"ergebnis"`
}

func lade(t *testing.T, name string, ziel any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(vertrag, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, ziel); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func ladeVektoren(t *testing.T) vektoren {
	t.Helper()
	var v vektoren
	lade(t, "v2/geraetesuche-vectors.json", &v)
	return v
}

type schema struct {
	Properties map[string]json.RawMessage `json:"properties"`
	Required   []string                   `json:"required"`
	Enum       []string                   `json:"enum"`
	Defs       map[string]json.RawMessage `json:"$defs"`
}

func ladeSchema(t *testing.T, name string) (schema, map[string]schema) {
	t.Helper()
	var s schema
	lade(t, "v2/"+name, &s)
	defs := map[string]schema{}
	for k, raw := range s.Defs {
		var d schema
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		defs[k] = d
	}
	return s, defs
}

// felder lists the json names of a struct; pflicht those without omitempty.
func felder(typ any) (alle, pflicht []string) {
	rt := reflect.TypeOf(typ)
	for i := 0; i < rt.NumField(); i++ {
		tag := rt.Field(i).Tag.Get("json")
		name, opt, _ := strings.Cut(tag, ",")
		alle = append(alle, name)
		if opt != "omitempty" {
			pflicht = append(pflicht, name)
		}
	}
	return alle, pflicht
}

func gleicheMenge(t *testing.T, was string, got, want []string) {
	t.Helper()
	g, w := append([]string(nil), got...), append([]string(nil), want...)
	sort.Strings(g)
	sort.Strings(w)
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("%s: %v, want %v", was, g, w)
	}
}

func schluessel(m map[string]json.RawMessage) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// The Go shapes ARE the schemas: same field names, required = never omitted.
// Whatever the box marshals therefore always carries every required field.
func TestStructsSindZwillingeDerSchemas(t *testing.T) {
	stand, standDefs := ladeSchema(t, "mqtt-geraetesuche-stand.schema.json")
	ergebnis, ergebnisDefs := ladeSchema(t, "mqtt-geraetesuche-ergebnis.schema.json")
	_, auftragDefs := ladeSchema(t, "mqtt-geraetesuche.schema.json")

	for _, p := range []struct {
		was    string
		schema schema
		typ    any
	}{
		{"stand", stand, Stand{}}, {"ergebnis", ergebnis, Ergebnis{}},
		{"netz", standDefs["netz"], Netz{}}, {"fund", standDefs["fund"], Fund{}},
		{"verbindung", standDefs["verbindung"], Verbindung{}}, {"weitere", ergebnisDefs["weitere"], Weitere{}},
	} {
		alle, pflicht := felder(p.typ)
		gleicheMenge(t, p.was+" properties", schluessel(p.schema.Properties), alle)
		gleicheMenge(t, p.was+" required", p.schema.Required, pflicht)
	}
	alle, _ := felder(Auftrag{})
	gleicheMenge(t, "auftrag starten", schluessel(auftragDefs["starten"].Properties), alle)
	for k := range auftragDefs["abbrechen"].Properties {
		if !enthaelt(alle, k) {
			t.Fatalf("abbrechen field %s unknown to Auftrag", k)
		}
	}
	// Every form both message schemas carry is ONE form.
	for k, raw := range ergebnis.Defs {
		if other, ok := stand.Defs[k]; ok && !bytes.Equal(normal(t, raw), normal(t, other)) {
			t.Fatalf("$defs/%s differs between stand and ergebnis", k)
		}
	}
	if !bytes.Equal(normal(t, auftragDefs["erkenner"].raw(t)), normal(t, ergebnisDefs["erkenner"].raw(t))) {
		t.Fatal("$defs/erkenner differs between auftrag and ergebnis")
	}

	for _, p := range []struct {
		was  string
		got  []string
		want []string
	}{
		{"erkenner", auftragDefs["erkenner"].Enum, Erkenner},
		{"erkenner_fund", standDefs["erkenner_fund"].Enum, ohne(Erkenner, Wege)},
		{"art", standDefs["art"].Enum, Arten},
		{"anbindung", standDefs["anbindung"].Enum, Anbindungen},
		{"erkennung", enumVon(t, standDefs["fund"], "erkennung"), Erkennungen},
		{"hindernis", enumVon(t, standDefs["fund"], "hindernis"), Hindernisse},
		{"communication", enumVon(t, standDefs["verbindung"], "communication"), Communications},
		{"schritt", enumVon(t, stand, "schritt"), Schritte},
		{"rolle", enumVon(t, standDefs["netz"], "rolle"), Rollen},
		{"zustand", enumVon(t, ergebnis, "zustand"), Zustaende},
		{"grund", enumVon(t, ergebnis, "grund"), alleGruende()},
	} {
		if !reflect.DeepEqual(p.got, p.want) {
			t.Fatalf("%s: schema %v, Go %v", p.was, p.got, p.want)
		}
	}
}

func (s schema) raw(t *testing.T) []byte {
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func normal(t *testing.T, raw []byte) []byte {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v)
	return b
}

func enumVon(t *testing.T, s schema, feld string) []string {
	t.Helper()
	var p schema
	if err := json.Unmarshal(s.Properties[feld], &p); err != nil {
		t.Fatal(err)
	}
	return p.Enum
}

func ohne(liste, weg []string) []string {
	var out []string
	for _, x := range liste {
		if !enthaelt(weg, x) {
			out = append(out, x)
		}
	}
	return out
}

func alleGruende() []string {
	var out []string
	for _, z := range []string{"abgebrochen", "abgelehnt", "fehlgeschlagen"} {
		out = append(out, Gruende[z]...)
	}
	return out
}

// DP-3 A in the schema itself: no field can carry a MAC address, a hostname or
// a name; people's devices exist only as counts in weitere.
func TestKeinFeldFuerMacHostnameOderName(t *testing.T) {
	verboten := regexp.MustCompile(`(?i)(^|_)(mac|hostname|host_name|name)($|_)`)
	for _, datei := range []string{"v2/mqtt-geraetesuche.schema.json", "v2/mqtt-geraetesuche-stand.schema.json",
		"v2/mqtt-geraetesuche-ergebnis.schema.json", "ocpp-klopft-an.schema.json"} {
		var wurzel any
		lade(t, datei, &wurzel)
		var lauf func(v any)
		lauf = func(v any) {
			switch x := v.(type) {
			case map[string]any:
				if props, ok := x["properties"].(map[string]any); ok {
					for k := range props {
						if verboten.MatchString(k) {
							t.Fatalf("%s: field %q (DP-3 A)", datei, k)
						}
					}
				}
				for _, w := range x {
					lauf(w)
				}
			case []any:
				for _, w := range x {
					lauf(w)
				}
			}
		}
		lauf(wurzel)
	}
	v := ladeVektoren(t)
	weitere, _ := felder(Weitere{})
	if !reflect.DeepEqual(weitere, v.WeitereArten) {
		t.Fatalf("weitere %v, vectors %v", weitere, v.WeitereArten)
	}
	for _, a := range v.WeitereArten {
		if enthaelt(Arten, a) {
			t.Fatalf("%s is a count, never a find", a)
		}
	}
}

func TestVokabularUndGrenzenSindDieDerVektoren(t *testing.T) {
	v := ladeVektoren(t)
	if v.Topics["auftrag"] != TopicAuftrag || v.Topics["stand"] != TopicStand || v.Topics["ergebnis"] != TopicErgebnis {
		t.Fatalf("topics %v", v.Topics)
	}
	grenzen := map[string]int{"frist_s": int(Frist / time.Second), "stand_takt_s": int(StandTakt / time.Second),
		"max_dauer_s": int(MaxDauer / time.Second), "max_je_stunde": MaxJeStunde, "max_netze": MaxNetze,
		"max_praefix": MaxPraefix, "max_funde": MaxFunde, "max_merkmale": MaxMerkmale,
		"keine_antwort_s": int(KeineAntwort / time.Second)}
	if !reflect.DeepEqual(v.Grenzen, grenzen) {
		t.Fatalf("grenzen %v, Go %v", v.Grenzen, grenzen)
	}
	if !reflect.DeepEqual(v.Gruende, Gruende) || !reflect.DeepEqual(v.Erkenner, Erkenner) ||
		!reflect.DeepEqual(v.Wege.Namen, Wege) || !reflect.DeepEqual(v.NetztechnikArten, NetztechnikArten) {
		t.Fatal("vocabulary differs from the vectors")
	}
	if len(v.Erkennungskatalog) != len(Katalog) {
		t.Fatalf("catalog: %d rows, Go %d", len(v.Erkennungskatalog), len(Katalog))
	}
	text := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	for i, z := range v.Erkennungskatalog {
		got := KatalogZeile{z.Erkenner, z.Art, z.Schnitt, text(z.Communication), text(z.Docker), text(z.EdgeLight)}
		if got != Katalog[i] {
			t.Fatalf("catalog row %d: vectors %+v, Go %+v", i, got, Katalog[i])
		}
		for _, wort := range []string{got.Docker, got.EdgeLight} {
			if wort != "" && !enthaelt(Anbindungen, wort) {
				t.Fatalf("catalog row %d: anbindung %q", i, wort)
			}
		}
		if enthaelt(Wege, z.Erkenner) {
			t.Fatalf("catalog row %d: %s is a way, it makes no find", i, z.Erkenner)
		}
	}
}

// ---------------------------------------------------------------- Auftrag

func TestAuftragLesen(t *testing.T) {
	v := ladeVektoren(t)
	for _, c := range v.Auftrag.Gueltig {
		a, err := LiesAuftrag(c.Topic, c.Payload)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		gleichesJSON(t, c.Name, a, c.Payload)
	}
	for _, c := range v.Auftrag.Ungueltig {
		if _, err := LiesAuftrag(c.Topic, c.Payload); err == nil {
			t.Fatalf("%s: accepted", c.Name)
		}
	}
	for _, c := range v.Auftrag.Toleriert {
		a, err := LiesAuftrag(c.Topic, c.Payload)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		gleichesJSON(t, c.Name, a, ohnePfade(t, c.Payload, c.Ueberlesen))
	}
}

func TestAuftragFrist(t *testing.T) {
	for _, c := range ladeVektoren(t).Frist {
		bis := c.GueltigBis
		a := Auftrag{Aktion: "starten", AusgeloestAm: c.AusgeloestAm, GueltigBis: &bis}
		if a.Beginnbar(c.Jetzt) != c.Beginnt {
			t.Fatalf("%s: beginnbar %v", c.Name, !c.Beginnt)
		}
	}
	if (Auftrag{Aktion: "abbrechen"}).Beginnbar(time.Now()) {
		t.Fatal("a cancel never begins a search")
	}
}

// ---------------------------------------------------------------- Stand, Ergebnis

// sendbar: the box would send exactly this - strict shape (no unknown field,
// nothing missing), the topic names the payload's identity, and Pruefe passes.
func sendbar(c fall, leaf string, ziel interface{ Pruefe(string) error }) error {
	dec := json.NewDecoder(bytes.NewReader(c.Payload))
	dec.DisallowUnknownFields()
	if err := dec.Decode(ziel); err != nil {
		return err
	}
	var kopf struct{ TenantID, SiteID, DeviceID string }
	var roh map[string]any
	_ = json.Unmarshal(c.Payload, &roh)
	kopf.TenantID, _ = roh["tenant_id"].(string)
	kopf.SiteID, _ = roh["site_id"].(string)
	kopf.DeviceID, _ = roh["device_id"].(string)
	if c.Topic != Topic(kopf.TenantID, kopf.SiteID, kopf.DeviceID, leaf) {
		return fmt.Errorf("topic %s", c.Topic)
	}
	boxArt := BoxArtDocker
	if c.BoxArt != nil {
		boxArt = *c.BoxArt
	}
	if err := ziel.Pruefe(boxArt); err != nil {
		return err
	}
	raus, _ := json.Marshal(ziel)
	if !bytes.Equal(normalAny(raus), normalAny(c.Payload)) {
		return fmt.Errorf("marshals differently: %s", raus)
	}
	return nil
}

func normalAny(raw []byte) []byte {
	var v any
	_ = json.Unmarshal(raw, &v)
	b, _ := json.Marshal(v)
	return b
}

func pruefeFamilie(t *testing.T, f familie, leaf string, neu func() interface{ Pruefe(string) error }) {
	t.Helper()
	for _, c := range f.Gueltig {
		if err := sendbar(c, leaf, neu()); err != nil {
			t.Fatalf("%s/%s: %v", leaf, c.Name, err)
		}
	}
	// The box never sends what a reader would drop or skip.
	for _, klasse := range [][]fall{f.Ungueltig, f.FundUeberlesen, f.Toleriert} {
		for _, c := range klasse {
			if sendbar(c, leaf, neu()) == nil {
				t.Fatalf("%s/%s: the box would send it", leaf, c.Name)
			}
		}
	}
	// ... and exactly the named finds or fields are the reason: without them
	// the message is sendable again.
	for _, c := range f.FundUeberlesen {
		var idx []int
		if err := json.Unmarshal(c.Ueberlesen, &idx); err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		c.Payload = ohneFunde(t, c.Payload, idx)
		if err := sendbar(c, leaf, neu()); err != nil {
			t.Fatalf("%s/%s without the skipped finds: %v", leaf, c.Name, err)
		}
	}
	for _, c := range f.Toleriert {
		c.Payload = ohnePfade(t, c.Payload, c.Ueberlesen)
		if err := sendbar(c, leaf, neu()); err != nil {
			t.Fatalf("%s/%s without the skipped fields: %v", leaf, c.Name, err)
		}
	}
}

func TestStandWieDieBoxIhnSendet(t *testing.T) {
	pruefeFamilie(t, ladeVektoren(t).Stand, TopicStand, func() interface{ Pruefe(string) error } { return &Stand{} })
}

func TestErgebnisWieDieBoxEsSendet(t *testing.T) {
	pruefeFamilie(t, ladeVektoren(t).Ergebnis, TopicErgebnis, func() interface{ Pruefe(string) error } { return &Ergebnis{} })
}

// The Läufer of the other sides does not check maxItems; the bound of 256
// finds is pinned here.
func TestHoechstens256Funde(t *testing.T) {
	var e Ergebnis
	if err := json.Unmarshal(ladeVektoren(t).Ergebnis.Gueltig[0].Payload, &e); err != nil {
		t.Fatal(err)
	}
	vorlage := e.Funde[3] // the open Modbus port
	e.Funde = nil
	for i := 0; i <= MaxFunde; i++ {
		f := vorlage
		f.Schluessel = "modbus_offen:192.168.178.70:" + strconv.Itoa(1000+i)
		f.Verbindung.Port = 1000 + i
		e.Funde = append(e.Funde, f)
	}
	if err := e.Pruefe(BoxArtDocker); err == nil {
		t.Fatal("257 finds accepted")
	}
	e.Funde = e.Funde[:MaxFunde]
	if err := e.Pruefe(BoxArtDocker); err != nil {
		t.Fatalf("256 finds: %v", err)
	}
}

// ---------------------------------------------------------------- helpers

func gleichesJSON(t *testing.T, name string, got any, want []byte) {
	t.Helper()
	raus, _ := json.Marshal(got)
	if !bytes.Equal(normalAny(raus), normalAny(want)) {
		t.Fatalf("%s: %s, want %s", name, raus, want)
	}
}

func ohneFunde(t *testing.T, payload []byte, idx []int) []byte {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatal(err)
	}
	funde := m["funde"].([]any)
	var rest []any
	for i, f := range funde {
		weg := false
		for _, j := range idx {
			weg = weg || i == j
		}
		if !weg {
			rest = append(rest, f)
		}
	}
	if rest == nil {
		rest = []any{}
	}
	m["funde"] = rest
	b, _ := json.Marshal(m)
	return b
}

var pfadTeil = regexp.MustCompile(`^([a-z_]+)(?:\[(\d+)\])?$`)

// ohnePfade deletes paths like "netze", "erkenner[1]", "funde[1].mac".
func ohnePfade(t *testing.T, payload []byte, pfade json.RawMessage) []byte {
	t.Helper()
	var liste []string
	if err := json.Unmarshal(pfade, &liste); err != nil {
		t.Fatal(err)
	}
	var wurzel map[string]any
	if err := json.Unmarshal(payload, &wurzel); err != nil {
		t.Fatal(err)
	}
	for _, pfad := range liste {
		teile := strings.Split(pfad, ".")
		var knoten any = wurzel
		for i, teil := range teile {
			m := pfadTeil.FindStringSubmatch(teil)
			obj := knoten.(map[string]any)
			letzter := i == len(teile)-1
			if m[2] == "" {
				if letzter {
					delete(obj, m[1])
					break
				}
				knoten = obj[m[1]]
				continue
			}
			n, _ := strconv.Atoi(m[2])
			arr := obj[m[1]].([]any)
			if letzter {
				obj[m[1]] = append(append([]any{}, arr[:n]...), arr[n+1:]...)
				break
			}
			knoten = arr[n]
		}
	}
	b, _ := json.Marshal(wurzel)
	return b
}
