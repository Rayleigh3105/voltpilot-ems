package logikdienst

// Die Verbraucherregel einer Steuerart als Logik der Regelsprache (Stufe 6, Zusammenführen,
// dritter Teil): die Übersetzung (Paket steuerart) mit dem Namen des Geräts aus dem Registry-Push,
// danach dieselbe Prüfung wie jeder Text - mit der Pflicht (must_run), die nur eine Steuerart
// trägt. Die API speichert das Ergebnis als abgeleitete Logik der Steuerart; bearbeitet wird die
// Steuerart.

import (
	"encoding/json"
	"errors"
	"fmt"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst/regel"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/logikdienst/steuerart"
)

// ErrSteuerart: das Dokument ist nicht die generierte Verbraucherregel einer Steuerart.
var ErrSteuerart = errors.New("keine Verbraucherregel einer Steuerart")

// SteuerartAuftrag ist eine Übersetzung.
type SteuerartAuftrag struct {
	Dokument json.RawMessage `json:"dokument"`
	Name     string          `json:"name"`
	Fassung  int             `json:"fassung"`
	Registry json.RawMessage `json:"registry"`
}

// SteuerartErgebnis ist die Antwort: ein geprüfter Text oder die Gründe, warum nicht; Pflicht sagt,
// ob die Logik must_run trägt (dann baut die API ihr Artefakt mit pflicht).
type SteuerartErgebnis struct {
	RegelErgebnis
	Pflicht bool `json:"pflicht"`
}

// AusSteuerart übersetzt die Verbraucherregel einer Steuerart und prüft das Ergebnis.
func AusSteuerart(a SteuerartAuftrag) (*SteuerartErgebnis, error) {
	if len(a.Dokument) == 0 {
		return nil, fmt.Errorf("%w: dokument fehlt", ErrAuftrag)
	}
	if a.Fassung < 1 {
		a.Fassung = 1
	}
	r, err := steuerart.Lies(a.Dokument)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrSteuerart, err)
	}
	geraet := ""
	var reg entities.Registry
	if len(a.Registry) > 0 && json.Unmarshal(a.Registry, &reg) == nil {
		if e := reg.Find(r.Entity); e != nil {
			geraet = e.Label
		}
	}
	erg := steuerart.Uebersetze(r, steuerart.Herkunft{Name: a.Name, Fassung: a.Fassung, Geraet: geraet})
	if len(erg.Gruende) > 0 {
		gruende := []regel.Grund{}
		for _, g := range erg.Gruende {
			gruende = append(gruende, regel.Grund{Code: g.Code, Text: g.Text})
		}
		return &SteuerartErgebnis{RegelErgebnis: RegelErgebnis{Gruende: gruende}}, nil
	}
	g, err := PruefeMit([]byte(erg.Text), nil, a.Registry, Erlaubt{Pflicht: erg.Pflicht})
	if err != nil {
		return nil, fmt.Errorf("Übersetzung nicht lesbar: %w", err)
	}
	if g.Bericht.Sperrt {
		gruende := []regel.Grund{}
		for _, b := range g.Bericht.Befunde {
			gruende = append(gruende, regel.Grund{Code: "pruefung", Text: b})
		}
		return &SteuerartErgebnis{RegelErgebnis: RegelErgebnis{Gruende: gruende, Bericht: g.Bericht}}, nil
	}
	return &SteuerartErgebnis{RegelErgebnis: RegelErgebnis{Uebersetzt: true, Text: erg.Text, Gruende: []regel.Grund{},
		Bericht: g.Bericht}, Pflicht: erg.Pflicht}, nil
}
