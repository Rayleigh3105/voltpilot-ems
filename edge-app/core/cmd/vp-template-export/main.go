// Command vp-template-export schreibt den eingebauten Geraete-Katalog als
// Vorlagen-DATEN heraus - die Datei, aus der die Cloud ihr Vorlagen-Register
// (`component_template`) fuellt.
//
// Einheitsmodell Stufe 0a (Scout data/vp-komponenten-einheit-h2 Teil 8):
// „Vorlagen werden Daten". Der Go-Katalog bleibt die WAHRHEIT - er entscheidet,
// was die Box wirklich lesen kann; dieses Kommando erzeugt daraus die zweite,
// cloud-seitige DARSTELLUNG.
//
// Aufruf (aus dem Repo-Wurzelverzeichnis):
//
//	go run ./cmd/vp-template-export -out ../../services/api/src/main/resources/componenttemplates/builtin.json
//
// oder mit dem eingebauten Standardpfad, relativ zum Modulverzeichnis:
//
//	(cd edge-app/core && go run ./cmd/vp-template-export)
//
// ⚠ Die Ausgabe ist DETERMINISTISCH (keine Zeitstempel). Wer den Katalog
// aendert und diese Datei nicht neu erzeugt, faellt in
// TestBuiltinTemplateExportMatchesTheCommittedFile durch - das ist der
// Drift-Waechter, kein Zufall.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
)

// defaultOut ist der eingecheckte Ort, relativ zum Modulverzeichnis
// edge-app/core. Er MUSS mit dem Pfad uebereinstimmen, den der Drift-Test und
// die api-Ressource verwenden.
const defaultOut = "../../services/api/src/main/resources/componenttemplates/builtin.json"

func main() {
	out := flag.String("out", defaultOut, "Zieldatei fuer den Vorlagen-Export")
	check := flag.Bool("check", false,
		"nur pruefen, ob die Zieldatei aktuell ist (schreibt nichts, Exit 1 bei Drift)")
	flag.Parse()

	raw, err := inverter.MarshalBuiltinTemplates()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Fehler:", err)
		os.Exit(1)
	}

	if *check {
		have, readErr := os.ReadFile(*out)
		if readErr != nil {
			fmt.Fprintf(os.Stderr, "Fehler: %s ist nicht lesbar: %v\n", *out, readErr)
			os.Exit(1)
		}
		if string(have) != string(raw) {
			fmt.Fprintf(os.Stderr,
				"Drift: %s entspricht nicht mehr dem Katalog. Neu erzeugen mit:\n"+
					"  (cd edge-app/core && go run ./cmd/vp-template-export)\n", *out)
			os.Exit(1)
		}
		fmt.Printf("%s ist aktuell (%d Vorlagen).\n", *out, len(inverter.BuiltinTemplates()))
		return
	}

	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "Fehler:", err)
		os.Exit(1)
	}
	if err := os.WriteFile(*out, raw, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "Fehler:", err)
		os.Exit(1)
	}
	fmt.Printf("%d Vorlagen nach %s geschrieben.\n", len(inverter.BuiltinTemplates()), *out)
}
