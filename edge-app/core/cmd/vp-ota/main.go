// Command vp-ota ist das Operator-Werkzeug der OTA-Signaturkette: Schluessel
// erzeugen, Trust-Set bauen, Releases signieren, alles verifizieren.
//
// Es ist BEWUSST ein eigenes Kommando und nicht Teil des Edge-Binaers: der
// Agent verifiziert nur (internal/otaverify, ohne eine Zeile Code fuer private
// Schluessel), und die ZEREMONIE laeuft auf der Maschine des Owners - der
// KALTE Root-Schluessel geht nie an CI.
//
// Der RELEASE-Schluessel dagegen liegt seit dem 04.08.2026 als CI-Geheimnis
// vor (Captain-Order „git tag -> fertig", bewusste Revision von D3): der
// Tag-Lauf ruft genau diese Befehle auf. Die Gegenleistungen dafuer -
// insbesondere ein Register-Konto, das NUR registrieren darf - stehen in
// docs/ota-signing.md §1.
//
// Der geteilte Kern ist internal/otaverify: Signierer und Geraet erzeugen die
// zu signierenden Bytes ueber DIESELBE Funktion (otaverify.SigningInput), damit
// die beiden Seiten nicht auseinanderlaufen koennen.
//
// Anleitung + Zeremonie: docs/ota-signing.md.
//
//	go run ./cmd/vp-ota <befehl> [optionen]
//
// Befehle: keygen · trust-set · trust · manifest · sign · verify · register
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = cmdKeygen(os.Args[2:])
	case "trust-set":
		err = cmdTrustSet(os.Args[2:])
	case "trust":
		err = cmdTrust(os.Args[2:])
	case "manifest":
		err = cmdManifest(os.Args[2:])
	case "sign":
		err = cmdSign(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "register":
		err = cmdRegister(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "Unbekannter Befehl %q.\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Fehler: "+err.Error())
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `vp-ota - Signaturkette fuer VoltPilot-Edge-Releases

  keygen     Ed25519-Schluesselpaar erzeugen (Root ODER Release)
  trust-set  Trust-Set aus Release-Oeffentlichschluesseln bauen
  trust      Ein Trust-Set ALLEIN pruefen (Rotations-Drill, ohne Manifest)
  manifest   Unsigniertes release.json erzeugen
  sign       Abgetrennte Signatur erzeugen (Domain release | trust-set)
  verify     Vollstaendige Kette pruefen (Wurzel -> Trust-Set -> Manifest)
  register   Register-Eintrag fuer das Portal vorbereiten (Body + curl)

Jeder Befehl kennt --help. Vollstaendige Zeremonie: docs/ota-signing.md
`)
}
