package main

// `vp-ota trust` - das Trust-Set ALLEIN pruefen.
//
// Die Luecke, die es schliesst (OTA Stufe 4 „Politur", §8.2 Schluessel-
// Rotation): waehrend eines Rotations-Drills gibt es ein NEUES root-signiertes
// Trust-Set, aber noch KEIN neues Release - und die erste Frage lautet
// trotzdem „akzeptiert die eingebackene Wurzel dieses Set, und welche
// Schluessel gelten damit?". `vp-ota verify` konnte das nicht beantworten: es
// verlangt ein Manifest, also haette der Owner eines erfinden muessen, um
// seinen Widerruf zu pruefen - genau die Sorte Umweg, aus der ein
// uebersprungener Pruefschritt wird.
//
// Es ruft DIESELBE Funktion auf, die auch das Geraet fuer seinen Herzschlag
// benutzt ([otaverify.InspectTrust]) - der Owner sieht hier also genau die
// Zeichenkette, die spaeter in der Flotten-Matrix steht. Zwei Quellen fuer
// „welches Set faehrt diese Box" waeren zwei Wahrheiten.

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

func cmdTrust(args []string) error {
	fs := flag.NewFlagSet("trust", flag.ExitOnError)
	root := fs.String("root", "baked",
		"Wurzel: 'baked' (die eingebackene aus rootkeys.json) oder ein Pfad zu rootkeys.json / <root>.pub")
	trustSet := fs.String("trust-set", "trust-set.json",
		"Trust-Set (die .sig daneben wird automatisch gesucht)")
	noClock := fs.Bool("no-clock", false,
		"so pruefen, als haette das Geraet keine vertrauenswuerdige Uhr")
	fs.Usage = func() {
		fmt.Fprint(os.Stderr, `vp-ota trust - das Vertrauens-Set allein pruefen

  gebackene Wurzel -> root-signiertes Trust-Set

Fuer den Rotations-Drill: es zeigt, WELCHE Release-Schluessel ein Set gewaehrt
und mit welchem Stempel - GENAU so, wie das Geraet es spaeter meldet. Ein
Release-Manifest wird dafuer NICHT gebraucht.

  vp-ota trust --root root-2026-a.pub --trust-set trust-set.json

`)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	roots, err := loadRoots(*root)
	if err != nil {
		return err
	}
	tsRaw, tsSig, err := readWithSig(*trustSet)
	if err != nil {
		return err
	}
	now := time.Now()
	if *noClock {
		now = time.Time{}
	}

	info := otaverify.InspectTrust(roots, tsRaw, tsSig, now)
	fmt.Printf("Wurzel:        %v\n", info.RootKeyIDs)
	if info.TrustSetError != "" {
		fmt.Printf("Befund:        %s\n", info.TrustSetError)
	}
	if !info.HasTrustSet() {
		// Ein LEERES, aber gueltig signiertes Set ist der Total-Widerruf - eine
		// gueltige Aussage. Es wird trotzdem als Fehlschlag zurueckgegeben,
		// damit ein Skript nicht versehentlich ein Set ausliefert, das keinem
		// Schluessel mehr traut, ohne dass es jemand bemerkt hat.
		return errors.New("dieses Vertrauens-Set gewaehrt keinen Release-Schluessel")
	}
	fmt.Printf("Signiert von:  %s\n", info.TrustSetSignedBy)
	fmt.Printf("Gueltig ab:    %s\n", orDash(info.TrustSetGeneratedAt))
	fmt.Printf("Schluessel:    %v\n", info.TrustSetKeyIDs)
	fmt.Println()
	fmt.Println("Auf einem Geraet mit diesem Set meldet der Herzschlag danach:")
	fmt.Printf("  trust_set_key_ids       %v\n", info.TrustSetKeyIDs)
	fmt.Printf("  trust_set_generated_at  %s\n", orDash(info.TrustSetGeneratedAt))
	fmt.Println()
	fmt.Println("Damit ist im Portal (Plattform -> Edge-Updates, Spalte „Vertrauen\")")
	fmt.Println("nachvollziehbar, welche Box dieses Set schon gesehen hat.")
	return nil
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}
