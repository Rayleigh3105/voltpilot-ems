package logikdienst

// Der Übersetzer aus Home Assistant (Steuerlogik Stufe 6, erster Teil; Entscheid E8 = A):
// die Dateien einer Anlage von Home Assistant werden eine Logik der Textform, die Entitäten
// von Geräten und Messwerten Lücken, die der Mensch Geräten und Eingängen dieser Anlage
// zuordnet - mit den Kandidaten, die die Box an der Anlage lesen und schalten kann
// (Quellen, dieselben Regeln wie die Box). Die Prüfung urteilt über das Ergebnis; nichts
// wird gespeichert, auch die Dateien nicht.

import (
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst/homeassistant"
)

// MaxHADateien und MaxHABytes begrenzen, was hochgeladen wird.
const (
	MaxHADateien = 8
	MaxHABytes   = 1024 * 1024
)

// ErrHomeAssistant: die Dateien lassen sich nicht lesen (kein YAML, zu groß, keine Datei).
var ErrHomeAssistant = errors.New("Dateien von Home Assistant nicht lesbar")

// HAAuftrag ist eine Übersetzung.
type HAAuftrag struct {
	Dateien   []homeassistant.Datei              `json:"dateien"`
	Zuordnung map[string]homeassistant.Zuordnung `json:"zuordnung"`
	Registry  json.RawMessage                    `json:"registry"`
}

// HAKandidat ist ein Gerät oder eine Quelle der Anlage, die in eine Lücke passt.
type HAKandidat struct {
	Wert string `json:"wert"`
	Name string `json:"name"`
	// Hinweis, etwa wenn das Gerät eine andere Zahl von Ausgängen hat.
	Hinweis string `json:"hinweis,omitempty"`
}

// HALuecke ist eine Lücke mit ihren Kandidaten.
type HALuecke struct {
	homeassistant.Luecke
	Kandidaten []HAKandidat `json:"kandidaten"`
	// Vorgeschlagen: der Wert stammt nicht vom Menschen, sondern ist der erste passende.
	Vorgeschlagen bool   `json:"vorgeschlagen,omitempty"`
	WertText      string `json:"wert_text,omitempty"`
}

// HAHinweis ist ein Hinweis mit seiner Zeile im übersetzten Text.
type HAHinweis struct {
	homeassistant.Hinweis
	Zeile int `json:"zeile,omitempty"`
}

// HAErgebnis ist die Antwort des Übersetzers.
type HAErgebnis struct {
	Luecken []HALuecke `json:"luecken"`
	// Vollstaendig: eine Logik ist entstanden, jede Lücke ist der Anlage zugeordnet und die
	// Prüfung sperrt nichts. Erst dann lässt sie sich übernehmen.
	Vollstaendig     bool                   `json:"vollstaendig"`
	Text             string                 `json:"text"`
	Bericht          *Bericht               `json:"bericht"`
	NichtUebersetzt  []homeassistant.Stelle `json:"nicht_uebersetzt"`
	NichtUebernommen []homeassistant.Stelle `json:"nicht_uebernommen"`
	Hinweise         []HAHinweis            `json:"hinweise"`
	Kennungen        map[string]string      `json:"kennungen"`
	Dateien          []string               `json:"dateien"`
}

// Kandidaten für Leistungen: das Vorzeichen der Box ist fest (Netz + Bezug, Batterie + laden);
// zählt Home Assistant umgekehrt, gilt die gedrehte Quelle.
var haLeistung = []HAKandidat{
	{Wert: "site.grid", Name: "Netz, + ist Bezug"},
	{Wert: "-site.grid", Name: "Netz, + ist Einspeisung"},
	{Wert: "battery.power", Name: "Batterie, + ist Laden"},
	{Wert: "-battery.power", Name: "Batterie, + ist Entladen"},
	{Wert: "site.pv", Name: "PV-Leistung"},
}

// UebersetzeHA übersetzt, schlägt für offene Lücken Kandidaten vor und prüft das Ergebnis.
func UebersetzeHA(a HAAuftrag) (*HAErgebnis, error) {
	if len(a.Dateien) == 0 || len(a.Dateien) > MaxHADateien {
		return nil, fmt.Errorf("%w: zwischen 1 und %d Dateien", ErrHomeAssistant, MaxHADateien)
	}
	gesamt := 0
	namen := map[string]bool{}
	var dateien []string
	for i := range a.Dateien {
		d := &a.Dateien[i]
		d.Name = path.Base(strings.ReplaceAll(d.Name, "\\", "/"))
		if d.Name == "" || d.Name == "." || namen[d.Name] {
			return nil, fmt.Errorf("%w: jede Datei braucht einen eigenen Namen", ErrHomeAssistant)
		}
		namen[d.Name] = true
		gesamt += len(d.Text)
		dateien = append(dateien, d.Name)
	}
	if gesamt > MaxHABytes {
		return nil, fmt.Errorf("%w: zusammen höchstens %d KB", ErrHomeAssistant, MaxHABytes/1024)
	}
	erst, err := homeassistant.Uebersetze(a.Dateien, a.Zuordnung)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrHomeAssistant, err)
	}
	bestand := Quellen(a.Registry)
	luecken := make([]HALuecke, len(erst.Luecken))
	vergeben := map[string]bool{}
	for i, l := range erst.Luecken {
		luecken[i] = HALuecke{Luecke: l, Kandidaten: haKandidaten(l, bestand)}
		if l.Wert != "" {
			vergeben[strings.TrimPrefix(l.Wert, "-")] = true
		}
	}
	// Ohne Zuordnung gilt das erste passende Gerät und der Fühler mit dem ähnlichsten Namen;
	// eine Leistung nie, ihr Vorzeichen muss der Mensch wählen.
	zuordnung := map[string]homeassistant.Zuordnung{}
	for k, v := range a.Zuordnung {
		zuordnung[k] = v
	}
	for i := range luecken {
		l := &luecken[i]
		if _, gesetzt := a.Zuordnung[l.Kennung]; gesetzt || l.Groesse == "leistung" {
			continue
		}
		for _, k := range l.Kandidaten {
			if vergeben[k.Wert] && k.Wert != "battery.soc" {
				continue
			}
			// unter mehreren Fühlern nur einer, dessen Name zur Lücke passt
			if l.Art == "eingang" && l.Groesse == "temperatur" && haNaehe(l.Name, k.Name) == 0 && len(l.Kandidaten) > 1 {
				continue
			}
			zuordnung[l.Kennung] = homeassistant.Zuordnung{Wert: k.Wert, Name: k.Name}
			l.Vorgeschlagen = true
			vergeben[k.Wert] = true
			break
		}
	}
	for k, z := range zuordnung {
		// Ein Eingang heißt wie die Quelle der Box, nicht wie die Wahl des Vorzeichens.
		for _, f := range FesteQuellen {
			if f.Source == strings.TrimPrefix(z.Wert, "-") {
				z.Name = f.Name
				zuordnung[k] = z
			}
		}
		if z.Name == "" {
			for _, l := range luecken {
				if l.Kennung == k {
					if c := findeHAKandidat(l.Kandidaten, z.Wert); c != nil {
						z.Name = c.Name
						zuordnung[k] = z
					}
				}
			}
		}
	}
	e, err := homeassistant.Uebersetze(a.Dateien, zuordnung)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrHomeAssistant, err)
	}
	out := &HAErgebnis{Luecken: []HALuecke{}, Text: e.Text, NichtUebersetzt: e.NichtUebersetzt,
		NichtUebernommen: e.NichtUebernommen, Hinweise: []HAHinweis{}, Kennungen: e.Kennungen, Dateien: dateien}
	for _, l := range e.Luecken {
		hl := HALuecke{Luecke: l, Kandidaten: haKandidaten(l, bestand)}
		for _, alt := range luecken {
			if alt.Kennung == l.Kennung {
				hl.Vorgeschlagen = alt.Vorgeschlagen && l.Wert != ""
			}
		}
		if c := findeHAKandidat(hl.Kandidaten, l.Wert); c != nil {
			hl.WertText = c.Name
		}
		out.Luecken = append(out.Luecken, hl)
	}
	vollstaendig := e.Text != ""
	for _, l := range out.Luecken {
		if l.Wert == "" || l.Fehler != "" {
			vollstaendig = false
		}
	}
	if e.Text != "" {
		z := neueZeilen([]byte(e.Text))
		for _, h := range e.Hinweise {
			out.Hinweise = append(out.Hinweise, HAHinweis{Hinweis: h, Zeile: z.zeile(h.Stelle)})
		}
		g, err := Pruefe([]byte(e.Text), nil, a.Registry)
		if err != nil {
			// Was der Übersetzer schreibt, muss der Leser lesen; sonst ist es ein Fehler des Übersetzers.
			return nil, fmt.Errorf("Übersetzung nicht lesbar: %w", err)
		}
		out.Bericht = g.Bericht
		if g.Bericht.Sperrt {
			vollstaendig = false
		}
	} else {
		for _, h := range e.Hinweise {
			out.Hinweise = append(out.Hinweise, HAHinweis{Hinweis: h})
		}
	}
	out.Vollstaendig = vollstaendig
	return out, nil
}

func findeHAKandidat(ks []HAKandidat, wert string) *HAKandidat {
	for i := range ks {
		if ks[i].Wert == wert {
			return &ks[i]
		}
	}
	return nil
}

// haKandidaten nennt, was die Anlage für eine Lücke bietet.
func haKandidaten(l homeassistant.Luecke, bestand Bestand) []HAKandidat {
	out := []HAKandidat{}
	if l.Art == "geraet" {
		var passend []Schaltbar
		for _, g := range bestand.Geraete {
			if slices.Contains(g.Ausgaenge, l.Ausgang) {
				passend = append(passend, g)
			}
		}
		// genau so viele Ausgänge zuerst, dann der ähnlichste Name
		sort.SliceStable(passend, func(i, j int) bool {
			gi, gj := passend[i].Ausgangszahl == l.Ausgaenge, passend[j].Ausgangszahl == l.Ausgaenge
			if gi != gj {
				return gi
			}
			return haNaehe(l.Name, passend[i].Name) > haNaehe(l.Name, passend[j].Name)
		})
		for _, g := range passend {
			k := HAKandidat{Wert: g.EntityID, Name: g.Name}
			if l.Ausgang == "level" && g.Ausgangszahl != l.Ausgaenge {
				k.Hinweis = fmt.Sprintf("hat %d Ausgänge, Home Assistant schaltet %d", g.Ausgangszahl, l.Ausgaenge)
			}
			out = append(out, k)
		}
		return out
	}
	gruppe := func(groesse string) []HAKandidat {
		var ks []HAKandidat
		switch groesse {
		case "leistung":
			return append(ks, haLeistung...)
		case "winkel":
			return append(ks, HAKandidat{Wert: "sun.elevation", Name: "Sonnenstand"})
		}
		einheit := map[string]string{"temperatur": "°C", "prozent": "%", "ja_nein": "ja_nein"}[groesse]
		for _, q := range bestand.Quellen {
			if q.Einheit == einheit {
				ks = append(ks, HAKandidat{Wert: q.Source, Name: q.Name})
			}
		}
		sort.SliceStable(ks, func(i, j int) bool { return haNaehe(l.Name, ks[i].Name) > haNaehe(l.Name, ks[j].Name) })
		return ks
	}
	alle := []string{"temperatur", "leistung", "prozent", "ja_nein", "winkel"}
	switch {
	case l.Groesse == "":
		for _, g := range alle {
			out = append(out, gruppe(g)...)
		}
	case l.Geschaetzt:
		out = append(out, gruppe(l.Groesse)...)
		for _, g := range alle {
			if g != l.Groesse {
				out = append(out, gruppe(g)...)
			}
		}
	default:
		out = append(out, gruppe(l.Groesse)...)
	}
	return out
}

// haNaehe zählt die Wörter (ab drei Buchstaben) und Zahlen, die zwei Namen teilen:
// „Speicher 2 oben“ passt zu „Heizstab Speicher 2“ besser als zu „Heizstab Speicher 3“.
func haNaehe(a, b string) int {
	woerter := func(s string) map[string]bool {
		out := map[string]bool{}
		for _, w := range strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
			if utf8.RuneCountInString(w) >= 3 || strings.IndexFunc(w, unicode.IsDigit) >= 0 {
				out[w] = true
			}
		}
		return out
	}
	n, wb := 0, woerter(b)
	for w := range woerter(a) {
		if wb[w] {
			n++
		}
	}
	return n
}
