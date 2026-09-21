package anteile

import (
	"bytes"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"reflect"
	"sort"
	"testing"
)

// NW-1 in Go: the third twin of docs/contracts/v2/verbund-anteil-vectors.json
// (Java SteuerungsverbundAnteile, Python test_steuerungsverbund_referenz) and
// the box reader of verbund-anteile-mqtt-vectors.json (Java
// VerbundAnteileVectorsTest). Every vector of both files runs; the counts per
// group are pinned so a new vector cannot slip past this twin.

func lies(t *testing.T, name string, ziel any) {
	t.Helper()
	raw, err := os.ReadFile("../../../../docs/contracts/v2/" + name)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(ziel); err != nil {
		t.Fatal(err)
	}
}

func rat(t *testing.T, n json.Number) *big.Rat {
	t.Helper()
	r, ok := new(big.Rat).SetString(n.String())
	if !ok {
		t.Fatalf("keine Zahl: %q", n)
	}
	return r
}

func zehntel(t *testing.T, n json.Number) int64 {
	t.Helper()
	z := new(big.Rat).Mul(rat(t, n), big.NewRat(10, 1))
	if !z.IsInt() {
		t.Fatalf("%s kW ist kein ganzes Zehntel", n)
	}
	return z.Num().Int64()
}

func rats(t *testing.T, m map[string]json.Number) map[string]*big.Rat {
	out := map[string]*big.Rat{}
	for k, v := range m {
		out[k] = rat(t, v)
	}
	return out
}

type anteilVektoren struct {
	Vokabulare struct {
		Rolle             []string `json:"rolle"`
		AuslegungUrteil   []string `json:"auslegung_urteil"`
		DokumentUrteil    []string `json:"dokument_urteil"`
		DokumentAblehnung []string `json:"dokument_ablehnung"`
	} `json:"vokabulare"`
	NichtGebaut struct {
		Stufe []struct {
			Code string `json:"code"`
		} `json:"stufe"`
	} `json:"nicht_gebaut"`
	Anteile []struct {
		Name       string      `json:"name"`
		GrenzeKw   json.Number `json:"grenze_kw"`
		Vorbehalt  json.Number `json:"vorbehalt_kw"`
		Mitglieder []struct {
			Box       string      `json:"box"`
			Rolle     string      `json:"rolle"`
			Nenn      json.Number `json:"nenn_kw"`
			Rueckfall json.Number `json:"rueckfall_kw"`
		} `json:"mitglieder"`
		Erwartet struct {
			Fehler         bool                   `json:"fehler"`
			Urteil         string                 `json:"urteil"`
			Ablehnung      *string                `json:"ablehnung"`
			Verteilbar     json.Number            `json:"verteilbar_kw"`
			SummeRueckfall *json.Number           `json:"summe_rueckfall_kw"`
			Anteile        map[string]json.Number `json:"anteile"`
			Ungenutzt      *json.Number           `json:"ungenutzt_kw"`
		} `json:"erwartet"`
	} `json:"anteile"`
	Uebergangsstand []struct {
		Name string `json:"name"`
		Alt  struct {
			Anteile map[string]json.Number `json:"anteile"`
		} `json:"alt"`
		Neu struct {
			Anteile map[string]json.Number `json:"anteile"`
		} `json:"neu"`
		Erwartet struct {
			Uebergang      map[string]json.Number `json:"uebergang"`
			VerengteBoxen  []string               `json:"verengte_boxen"`
			ZweiterSchritt bool                   `json:"zweiter_schritt"`
			SummeAlt       json.Number            `json:"summe_alt_kw"`
			SummeUebergang json.Number            `json:"summe_uebergang_kw"`
			SummeNeu       json.Number            `json:"summe_neu_kw"`
		} `json:"erwartet"`
	} `json:"uebergangsstand"`
	DokumentPruefen []struct {
		Name       string `json:"name"`
		Identitaet struct {
			Mandant string `json:"mandant"`
			Anlage  string `json:"anlage"`
			Box     string `json:"box"`
		} `json:"identitaet"`
		Stand    *Stand `json:"stand"`
		Dokument struct {
			Mandant    string                            `json:"mandant"`
			Anlage     string                            `json:"anlage"`
			Epoche     int64                             `json:"epoche"`
			Revision   int64                             `json:"revision"`
			Verteilbar map[string]json.Number            `json:"verteilbar"`
			Anteile    map[string]map[string]json.Number `json:"anteile"`
		} `json:"dokument"`
		Erwartet struct {
			Urteil string  `json:"urteil"`
			Grund  *string `json:"grund"`
		} `json:"erwartet"`
	} `json:"dokument_pruefen"`
}

func TestNW1VokabulareWieDieVektoren(t *testing.T) {
	var v anteilVektoren
	lies(t, "verbund-anteil-vectors.json", &v)
	for name, paar := range map[string][2][]string{
		"rolle":              {v.Vokabulare.Rolle, Rollen},
		"auslegung_urteil":   {v.Vokabulare.AuslegungUrteil, AuslegungUrteile},
		"dokument_urteil":    {v.Vokabulare.DokumentUrteil, DokumentUrteile},
		"dokument_ablehnung": {v.Vokabulare.DokumentAblehnung, DokumentAblehnung},
	} {
		if !reflect.DeepEqual(paar[0], paar[1]) {
			t.Fatalf("%s: Vektoren %v, Go %v", name, paar[0], paar[1])
		}
	}
	// E1 = A: the time-limited allocation (S4) is not built, no twin knows it
	for _, s := range v.NichtGebaut.Stufe {
		for _, w := range append(append([]string{}, Rollen...), AuslegungUrteile...) {
			if w == s.Code {
				t.Fatalf("nicht gebautes Wort %q bekannt", s.Code)
			}
		}
	}
}

func TestNW1Anteile(t *testing.T) {
	var v anteilVektoren
	lies(t, "verbund-anteil-vectors.json", &v)
	fehler := 0
	for _, c := range v.Anteile {
		var ms []Mitglied
		for _, m := range c.Mitglieder {
			ms = append(ms, Mitglied{Box: m.Box, Rolle: m.Rolle, NennKw: rat(t, m.Nenn), RueckfallKw: rat(t, m.Rueckfall)})
		}
		a, err := Verteilen(rat(t, c.GrenzeKw), rat(t, c.Vorbehalt), ms)
		if c.Erwartet.Fehler {
			if !errors.Is(err, ErrEingang) {
				t.Fatalf("%s: Eingabefehler erwartet, bekam %+v / %v", c.Name, a, err)
			}
			fehler++
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		e := c.Erwartet
		ablehnung := ""
		if e.Ablehnung != nil {
			ablehnung = *e.Ablehnung
		}
		if a.Urteil != e.Urteil || a.Ablehnung() != ablehnung || a.VerteilbarZehntel != zehntel(t, e.Verteilbar) {
			t.Fatalf("%s: %+v, erwartet %+v", c.Name, a, e)
		}
		if (e.SummeRueckfall == nil) != (a.SummeRueckfallZehntel == nil) ||
			e.SummeRueckfall != nil && *a.SummeRueckfallZehntel != zehntel(t, *e.SummeRueckfall) {
			t.Fatalf("%s: Summe der Rueckfaelle %v, erwartet %v", c.Name, a.SummeRueckfallZehntel, e.SummeRueckfall)
		}
		if (e.Ungenutzt == nil) != (a.UngenutztZehntel == nil) ||
			e.Ungenutzt != nil && *a.UngenutztZehntel != zehntel(t, *e.Ungenutzt) {
			t.Fatalf("%s: ungenutzt %v, erwartet %v", c.Name, a.UngenutztZehntel, e.Ungenutzt)
		}
		want := map[string]int64{}
		for b, kw := range e.Anteile {
			want[b] = zehntel(t, kw)
		}
		if !reflect.DeepEqual(a.AnteileZehntel, want) {
			t.Fatalf("%s: Anteile %v, erwartet %v (Zehntel-kW)", c.Name, a.AnteileZehntel, want)
		}
	}
	if len(v.Anteile) != 18 || fehler != 4 {
		t.Fatalf("anteile: %d Faelle, davon %d Eingabefehler - Vektor-Datei gewachsen, Zwilling pruefen", len(v.Anteile), fehler)
	}
}

func TestNW1Uebergangsstand(t *testing.T) {
	var v anteilVektoren
	lies(t, "verbund-anteil-vectors.json", &v)
	summe := func(m map[string]*big.Rat) *big.Rat {
		s := new(big.Rat)
		for _, kw := range m {
			s.Add(s, kw)
		}
		return s
	}
	for _, c := range v.Uebergangsstand {
		alt, neu := rats(t, c.Alt.Anteile), rats(t, c.Neu.Anteile)
		u := Uebergangsstand(alt, neu)
		e := c.Erwartet
		want := rats(t, e.Uebergang)
		if len(u.Uebergang) != len(want) {
			t.Fatalf("%s: Uebergang %v, erwartet %v", c.Name, u.Uebergang, e.Uebergang)
		}
		for b, kw := range want {
			if u.Uebergang[b] == nil || u.Uebergang[b].Cmp(kw) != 0 {
				t.Fatalf("%s: %s = %v, erwartet %v", c.Name, b, u.Uebergang[b], kw)
			}
		}
		verengt := append([]string{}, e.VerengteBoxen...)
		sort.Strings(verengt)
		if !reflect.DeepEqual(u.VerengteBoxen, verengt) || u.ZweiterSchritt != e.ZweiterSchritt {
			t.Fatalf("%s: verengt %v / zweiter Schritt %v, erwartet %v / %v", c.Name, u.VerengteBoxen,
				u.ZweiterSchritt, verengt, e.ZweiterSchritt)
		}
		if summe(alt).Cmp(rat(t, e.SummeAlt)) != 0 || summe(u.Uebergang).Cmp(rat(t, e.SummeUebergang)) != 0 ||
			summe(neu).Cmp(rat(t, e.SummeNeu)) != 0 {
			t.Fatalf("%s: Summen weichen ab", c.Name)
		}
	}
	if len(v.Uebergangsstand) != 5 {
		t.Fatalf("uebergangsstand: %d Faelle - Vektor-Datei gewachsen, Zwilling pruefen", len(v.Uebergangsstand))
	}
}

func TestNW1DokumentPruefen(t *testing.T) {
	var v anteilVektoren
	lies(t, "verbund-anteil-vectors.json", &v)
	gesehen := map[string]bool{}
	for _, c := range v.DokumentPruefen {
		d := Dokument{Mandant: c.Dokument.Mandant, Anlage: c.Dokument.Anlage, Epoche: c.Dokument.Epoche,
			Revision: c.Dokument.Revision, Verteilbar: map[string]*big.Rat{}, Anteile: map[string]map[string]*big.Rat{}}
		for _, r := range Richtungen {
			d.Verteilbar[r] = rat(t, c.Dokument.Verteilbar[r+"_kw"])
			if tab, ok := c.Dokument.Anteile[r]; ok {
				d.Anteile[r] = rats(t, tab)
			}
		}
		p := DokumentPruefen(Identitaet{c.Identitaet.Mandant, c.Identitaet.Anlage, c.Identitaet.Box}, c.Stand, d)
		grund := ""
		if c.Erwartet.Grund != nil {
			grund = *c.Erwartet.Grund
		}
		if p.Urteil != c.Erwartet.Urteil || p.Grund != grund {
			t.Fatalf("%s: %+v, erwartet %s/%s", c.Name, p, c.Erwartet.Urteil, grund)
		}
		gesehen[p.Urteil+"/"+p.Grund] = true
	}
	for _, g := range DokumentAblehnung {
		if !gesehen[Abgelehnt+"/"+g] {
			t.Fatalf("kein Vektor fuer %s", g)
		}
	}
	if len(v.DokumentPruefen) != 15 {
		t.Fatalf("dokument_pruefen: %d Faelle - Vektor-Datei gewachsen, Zwilling pruefen", len(v.DokumentPruefen))
	}
}

type mqttVektoren struct {
	Kennungen map[string]string `json:"kennungen"`
	Dokumente []struct {
		Name       string                            `json:"name"`
		Box        string                            `json:"box"`
		Stand      *Stand                            `json:"stand"`
		Epoche     int64                             `json:"epoche"`
		Revision   int64                             `json:"revision"`
		Schritt    string                            `json:"schritt"`
		Verteilbar map[string]json.Number            `json:"verteilbar"`
		Anteile    map[string]map[string]json.Number `json:"anteile"`
		Erwartet   struct {
			Urteil string  `json:"urteil"`
			Grund  *string `json:"grund"`
		} `json:"erwartet"`
	} `json:"dokumente"`
	Identitaet []struct {
		Name  string `json:"name"`
		Topic struct {
			Tenant string `json:"tenant"`
			Site   string `json:"site"`
			Box    string `json:"box"`
		} `json:"topic"`
		Nutzlast map[string]string `json:"nutzlast"`
		Erwartet struct {
			Gelesen bool   `json:"gelesen"`
			Grund   string `json:"grund"`
		} `json:"erwartet"`
	} `json:"identitaet"`
}

// drahtNutzlast is the payload the cloud publishes for this vector (Java
// VerbundAnteileDokument.nutzlast): the WHOLE table, device_id = the box.
func drahtNutzlast(t *testing.T, tenant, site, box string, epoche, revision int64, schritt string,
	verteilbar map[string]json.Number, anteile map[string]map[string]json.Number) map[string]any {
	return map[string]any{"schema_version": "1.0", "tenant_id": tenant, "site_id": site, "device_id": box,
		"epoche": epoche, "revision": revision, "schritt": schritt, "verteilbar": verteilbar, "anteile": anteile,
		"published_at": "2027-10-20T09:00:00Z"}
}

func TestNW1DrahtDokumente(t *testing.T) {
	var v mqttVektoren
	lies(t, "verbund-anteile-mqtt-vectors.json", &v)
	tenant, site := v.Kennungen["tenant"], v.Kennungen["site"]
	for _, c := range v.Dokumente {
		raw, _ := json.Marshal(drahtNutzlast(t, tenant, site, c.Box, c.Epoche, c.Revision, c.Schritt, c.Verteilbar, c.Anteile))
		own := Identitaet{tenant, site, c.Box}
		g, err := Lesen(own, raw)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		p := DokumentPruefen(own, c.Stand, g.Dokument)
		grund := ""
		if c.Erwartet.Grund != nil {
			grund = *c.Erwartet.Grund
		}
		if p.Urteil != c.Erwartet.Urteil || p.Grund != grund || g.Schritt != c.Schritt {
			t.Fatalf("%s: %+v (%s), erwartet %s/%s", c.Name, p, g.Schritt, c.Erwartet.Urteil, grund)
		}
		if p.Angenommen() {
			h := Halten(g)
			for _, r := range Richtungen {
				if h.AnteilKw[r] != c.Anteile[r][c.Box] {
					t.Fatalf("%s: eigener Anteil %s = %s, im Dokument %s", c.Name, r, h.AnteilKw[r], c.Anteile[r][c.Box])
				}
			}
		}
	}
	if len(v.Dokumente) != 7 {
		t.Fatalf("dokumente: %d Faelle - Vektor-Datei gewachsen, Zwilling pruefen", len(v.Dokumente))
	}
}

func TestNW1TopicUndNutzlastNennenDieselbeBox(t *testing.T) {
	var v mqttVektoren
	lies(t, "verbund-anteile-mqtt-vectors.json", &v)
	muster := v.Dokumente[0]
	for _, c := range v.Identitaet {
		n := drahtNutzlast(t, c.Topic.Tenant, c.Topic.Site, c.Topic.Box, 1, 8, "uebergang", muster.Verteilbar, muster.Anteile)
		for k, val := range c.Nutzlast {
			n[k] = val
		}
		raw, _ := json.Marshal(n)
		own := Identitaet{c.Topic.Tenant, c.Topic.Site, c.Topic.Box}
		g, err := Lesen(own, raw)
		if !c.Erwartet.Gelesen {
			if !errors.Is(err, ErrNichtIhres) {
				t.Fatalf("%s: verworfen ohne Quittung erwartet, bekam %v", c.Name, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if p := DokumentPruefen(own, nil, g.Dokument); p.Grund != c.Erwartet.Grund {
			t.Fatalf("%s: %+v, erwartet %s", c.Name, p, c.Erwartet.Grund)
		}
	}
	if len(v.Identitaet) != 3 {
		t.Fatalf("identitaet: %d Faelle - Vektor-Datei gewachsen, Zwilling pruefen", len(v.Identitaet))
	}
}
