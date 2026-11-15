package logik

// Sicherung des Laufs auf die Platte (Stufe 2, zweiter Teil): Der Mitlauf auf der
// Box schreibt den gemerkten Zustand einer Logik bei Wechseln weg und liest ihn
// nach einem Neustart zurück. Die Neustart-Regeln des Vertrags bleiben beim Kern:
// Wer einen gesicherten Lauf lädt, ruft danach Neustart auf - erst das wendet
// `after_restart` an (keep liest den gesicherten Wert) und leert die holds-Zähler.
// Rein additiv: kein Takt und kein Vektor ändert sich.

import (
	"encoding/json"
	"fmt"
)

// gesicherterLauf ist die Plattenform eines Laufs (schema_version 1).
type gesicherterLauf struct {
	SchemaVersion int                           `json:"schema_version"`
	Stell         map[string]json.RawMessage    `json:"stellwerte"`
	Zustaende     map[string]gesicherterZustand `json:"zustaende"`
	Geraete       map[string]gesichertesGeraet  `json:"geraete"`
	Meldungen     []gesicherteMeldung           `json:"meldungen"`
	Tag           int                           `json:"tag"`
	TagGilt       bool                          `json:"tag_gilt"`
	Gestartet     float64                       `json:"gestartet"`
}

type gesicherterZustand struct {
	Art     string   `json:"art"`
	An      bool     `json:"an,omitempty"`
	Wert    int      `json:"wert,omitempty"`
	Seit    float64  `json:"seit,omitempty"`
	Zuletzt string   `json:"zuletzt,omitempty"`
	Bis     *float64 `json:"bis,omitempty"`
	// Wechsel ist der Verlauf eines Zählers (changes(), oldest_change()); er bleibt über den Neustart.
	Wechsel []zaehlerWechsel `json:"wechsel,omitempty"`
}

type gesichertesGeraet struct {
	AusgangsSekunden float64 `json:"ausgangs_sekunden"`
	Wunsch           float64 `json:"wunsch"`
}

type gesicherteMeldung struct {
	Aktiv   bool     `json:"aktiv"`
	Zuletzt *float64 `json:"zuletzt,omitempty"`
}

// SichereLauf friert den gemerkten Zustand eines Laufs als JSON ein.
func (L *Logik) SichereLauf(st *Lauf) ([]byte, error) {
	g := gesicherterLauf{
		SchemaVersion: 1,
		Stell:         map[string]json.RawMessage{},
		Zustaende:     map[string]gesicherterZustand{},
		Geraete:       map[string]gesichertesGeraet{},
		Tag:           st.tag,
		TagGilt:       st.tagGilt,
		Gestartet:     st.Gestartet,
	}
	for n, w := range st.Stell {
		roh, err := wertRoh(w)
		if err != nil {
			return nil, fmt.Errorf("Stellwert %s: %w", n, err)
		}
		g.Stell[n] = roh
	}
	for n, z := range st.Z {
		gz := gesicherterZustand{Art: z.art, An: z.an, Wert: z.wert, Seit: z.seit, Zuletzt: z.zuletzt,
			Wechsel: append([]zaehlerWechsel(nil), z.wechsel...)}
		if z.bis != nil {
			v := *z.bis
			gz.Bis = &v
		}
		g.Zustaende[n] = gz
	}
	for n, ger := range st.G {
		g.Geraete[n] = gesichertesGeraet{AusgangsSekunden: ger.ausgangsSekunden, Wunsch: ger.wunsch}
	}
	for _, m := range st.M {
		gm := gesicherteMeldung{Aktiv: m.aktiv}
		if m.zuletzt != nil {
			v := *m.zuletzt
			gm.Zuletzt = &v
		}
		g.Meldungen = append(g.Meldungen, gm)
	}
	return json.Marshal(g)
}

// gesichertesFenster ist ein Planfenster der Plattenform.
type gesichertesFenster struct {
	Tage []int   `json:"tage"`
	Von  float64 `json:"von"`
	Bis  float64 `json:"bis"`
	Text string  `json:"text,omitempty"`
}

// wertRoh bildet einen Wert auf seine JSON-Rohform ab, so dass liesWertRoh ihn
// wieder liest (Zahl mit Größe, Ja/Nein, Wort oder Zeitplan).
func wertRoh(w Wert) (json.RawMessage, error) {
	switch w.Art {
	case WertZahl:
		return json.Marshal(map[string]any{"zahl": w.V, "groesse": string(w.D)})
	case WertBool:
		return json.Marshal(map[string]any{"bool": w.B})
	case WertWort:
		return json.Marshal(map[string]any{"wort": w.W})
	case WertPlan:
		var fenster []gesichertesFenster
		if w.Plan != nil {
			for _, f := range w.Plan.Fenster {
				fenster = append(fenster, gesichertesFenster{
					Tage: append([]int(nil), f.Tage...), Von: f.Von, Bis: f.Bis, Text: f.Text})
			}
		}
		return json.Marshal(map[string]any{"plan": fenster})
	default:
		return json.Marshal(map[string]any{})
	}
}

// liesWertRoh liest die Rohform aus SichereLauf zurück.
func liesWertRoh(roh json.RawMessage) (Wert, bool) {
	var o struct {
		Zahl    *float64             `json:"zahl"`
		Groesse string               `json:"groesse"`
		Bool    *bool                `json:"bool"`
		Wort    *string              `json:"wort"`
		Plan    []gesichertesFenster `json:"plan"`
	}
	if json.Unmarshal(roh, &o) != nil {
		return Wert{}, false
	}
	switch {
	case o.Zahl != nil:
		return zahlW(*o.Zahl, Groesse(o.Groesse)), true
	case o.Bool != nil:
		return boolW(*o.Bool), true
	case o.Wort != nil:
		return wortW(*o.Wort), true
	case o.Plan != nil:
		plan := &Zeitplan{}
		for _, f := range o.Plan {
			plan.Fenster = append(plan.Fenster, Planfenster{
				Tage: append([]int(nil), f.Tage...), Von: f.Von, Bis: f.Bis, Text: f.Text})
		}
		return Wert{Art: WertPlan, Plan: plan}, true
	}
	return unbekanntW(), true
}

// LadeLauf liest einen gesicherten Lauf zurück. Unbekannte Stellwerte und
// Zustände der Sicherung werden übergangen, fehlende aus der Vorgabe ergänzt -
// eine inzwischen geänderte Logik beginnt dort sauber neu. Der Aufrufer wendet
// danach Neustart an; erst das setzt `after_restart` um.
func (L *Logik) LadeLauf(daten []byte, jetzt float64) (*Lauf, error) {
	var g gesicherterLauf
	if err := json.Unmarshal(daten, &g); err != nil {
		return nil, fmt.Errorf("gesicherter Lauf nicht lesbar: %w", err)
	}
	if g.SchemaVersion != 1 {
		return nil, fmt.Errorf("gesicherter Lauf: schema_version %d unbekannt", g.SchemaVersion)
	}
	st := L.NeuerLauf(jetzt)
	for n := range st.Stell {
		roh, ok := g.Stell[n]
		if !ok {
			continue
		}
		if w, gelesen := liesWertRoh(roh); gelesen && w.Art != WertUnbekannt {
			st.Stell[n] = w
		}
	}
	for _, z := range L.Zustaende {
		gz, ok := g.Zustaende[z.Kennung]
		if !ok || gz.Art != z.Art {
			continue
		}
		l := st.Z[z.Kennung]
		l.an = gz.An
		l.wert = gz.Wert
		l.seit = gz.Seit
		l.zuletzt = gz.Zuletzt
		if z.Art == "counter" {
			l.wechsel = append([]zaehlerWechsel(nil), gz.Wechsel...)
		}
		if gz.Bis != nil {
			v := *gz.Bis
			l.bis = &v
		} else {
			l.bis = nil
		}
	}
	for _, n := range L.GeraetListe {
		if gg, ok := g.Geraete[n]; ok {
			st.G[n].ausgangsSekunden = gg.AusgangsSekunden
			st.G[n].wunsch = gg.Wunsch
		}
	}
	for i := range st.M {
		if i < len(g.Meldungen) {
			st.M[i].aktiv = g.Meldungen[i].Aktiv
			if g.Meldungen[i].Zuletzt != nil {
				v := *g.Meldungen[i].Zuletzt
				st.M[i].zuletzt = &v
			}
		}
	}
	st.tag = g.Tag
	st.tagGilt = g.TagGilt
	st.Gestartet = g.Gestartet
	return st, nil
}

// ZustandKurz ist der gemerkte Zustand eines Laufs in Kurzform für die
// Rückmeldung im Herzschlag: je Zustand ein kurzes Wort oder eine Zahl.
func (L *Logik) ZustandKurz(st *Lauf, jetzt float64) map[string]string {
	out := make(map[string]string, len(L.Zustaende))
	for _, z := range L.Zustaende {
		l, ok := st.Z[z.Kennung]
		if !ok {
			continue
		}
		switch l.art {
		case "boolean":
			if l.an {
				out[z.Kennung] = "on"
			} else {
				out[z.Kennung] = "off"
			}
		case "counter":
			out[z.Kennung] = fmt.Sprintf("%d", l.wert)
		default: // timer
			if l.bis != nil && jetzt < *l.bis {
				out[z.Kennung] = fmt.Sprintf("%ds", int(*l.bis-jetzt))
			} else {
				out[z.Kennung] = "aus"
			}
		}
	}
	return out
}
