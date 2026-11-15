package logikdienst

// Eine Regel des Regel-Baukastens als Logik der Regelsprache (Stufe 6, Zusammenführen): die
// Übersetzung (Paket regel) mit den Geräten der Anlage aus dem Registry-Push, danach dieselbe
// Prüfung wie jeder Text. Die API speichert das Ergebnis als abgeleitete Logik der Regel; die
// Regel selbst bleibt, was der Kunde bearbeitet.

import (
	"encoding/json"
	"errors"
	"fmt"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst/regel"
)

// ErrRegel: das Dokument ist keine Regel des Regel-Baukastens (der freie Editor baut mehr).
var ErrRegel = errors.New("keine Regel des Regel-Baukastens")

// RegelAuftrag ist eine Übersetzung.
type RegelAuftrag struct {
	Dokument json.RawMessage `json:"dokument"`
	Name     string          `json:"name"`
	Fassung  int             `json:"fassung"`
	Registry json.RawMessage `json:"registry"`
}

// RegelErgebnis ist die Antwort: entweder ein geprüfter Text oder die Gründe, warum nicht.
type RegelErgebnis struct {
	Uebersetzt bool          `json:"uebersetzt"`
	Text       string        `json:"text,omitempty"`
	Gruende    []regel.Grund `json:"gruende"`
	Bericht    *Bericht      `json:"bericht,omitempty"`
}

// regelAnlage liest aus dem Registry-Push, was die Übersetzung über die Geräte wissen muss.
func regelAnlage(registry json.RawMessage) regel.Anlage {
	a := regel.Anlage{}
	var reg entities.Registry
	if len(registry) == 0 || json.Unmarshal(registry, &reg) != nil {
		return a
	}
	for _, e := range reg.Entities {
		g := regel.Geraet{Name: e.Label, Typ: e.Type}
		for _, m := range e.Capabilities.Measure {
			g.Misst = append(g.Misst, m.Channel)
		}
		a[e.ID] = g
	}
	return a
}

// AusRegel übersetzt eine Regel und prüft das Ergebnis. Eine Übersetzung, die die Prüfung
// sperrt, ist keine: dann steht der Befund unter den Gründen.
func AusRegel(a RegelAuftrag) (*RegelErgebnis, error) {
	if len(a.Dokument) == 0 {
		return nil, fmt.Errorf("%w: dokument fehlt", ErrAuftrag)
	}
	if a.Fassung < 1 {
		a.Fassung = 1
	}
	erg, err := regel.UebersetzeDokument(a.Dokument, regelAnlage(a.Registry), regel.Herkunft{Name: a.Name, Fassung: a.Fassung})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrRegel, err)
	}
	if len(erg.Gruende) > 0 {
		return &RegelErgebnis{Gruende: erg.Gruende}, nil
	}
	g, err := Pruefe([]byte(erg.Text), nil, a.Registry)
	if err != nil {
		return nil, fmt.Errorf("Übersetzung nicht lesbar: %w", err)
	}
	if g.Bericht.Sperrt {
		gruende := []regel.Grund{}
		for _, b := range g.Bericht.Befunde {
			gruende = append(gruende, regel.Grund{Code: "pruefung", Text: b})
		}
		return &RegelErgebnis{Gruende: gruende, Bericht: g.Bericht}, nil
	}
	return &RegelErgebnis{Uebersetzt: true, Text: erg.Text, Gruende: []regel.Grund{}, Bericht: g.Bericht}, nil
}
