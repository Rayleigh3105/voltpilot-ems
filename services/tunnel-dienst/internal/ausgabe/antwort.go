// Package ausgabe ist die Schlüsselausgabe: Eine Box fragt über den
// Wartungstunnel, wessen SSH-Schlüssel sich gerade bei ihr anmelden darf, und
// bekommt die Schlüssel der Techniker, für die ein Fenster zu ihr offen ist.
//
// Was ausgegeben wird, entscheidet allein die Kernel-Menge "fenster": Steht
// das Paar Techniker . Box dort, wird der SSH-Schlüssel des Technikers aus
// dem letzten gültigen Soll-Stand genannt, mit der Restlaufzeit des Elements.
// Was dort abgelaufen ist oder nie hineinkam, wird nicht genannt.
//
// Der Dienst besteht dafür aus zwei Prozessen:
//
//   - Die Stelle (stelle.go) läuft im Dienst selbst, mit CAP_NET_ADMIN. Nur
//     sie liest die Kernel-Menge und den Soll-Stand und entscheidet.
//   - Der Schalter (schalter.go) ist ein eigener Prozess desselben Programms
//     (`vp-tunnel-dienst schluessel-schalter`). Er lauscht im Tunnel, liest
//     die HTTP-Anfragen der Boxen und hat dafür alle Rechte abgelegt: was aus
//     dem Tunnel erreichbar ist, kann weder WireGuard noch die Firewall ändern.
//
// Zwischen beiden liegt ein Kanal mit einer festen Zeilenform (kanal.go).
//
// Anfrage und Antwort (Vertrag: docs/contracts/fernwartung-schluessel-v1.md):
//
//	GET http://<Server-Adresse im Techniker-Netz>:<Port>/v1/schluessel?warte=<s>&stand=<Prüfwert>
//
//	vp-wartung-schluessel 1 <Prüfwert>
//	schluessel <Restlaufzeit in s> <Zugang> ssh-rsa <Base64>
//	ende <Anzahl>
package ausgabe

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const (
	// Kopf und Version stehen in der ersten Zeile jeder Antwort.
	Kopf    = "vp-wartung-schluessel"
	Version = 1
	// Pfad ist die einzige Route.
	Pfad = "/v1/schluessel"
	// MaxWarte: so lange hält der Server eine Anfrage höchstens offen; ein
	// größerer Wert der Box wird darauf gekürzt.
	MaxWarte = 300 * time.Second
	// MaxJeBox: mehr Schlüssel nennt eine Antwort nicht. Die Box nimmt eine
	// längere Liste als Ganzes nicht an.
	MaxJeBox = 8
)

// Eintrag ist eine Zeile der Antwort.
type Eintrag struct {
	// Sekunden ist die Restlaufzeit des Fensters, mindestens 1.
	Sekunden int
	// Zugang ist die ID des Techniker-Zugangs aus dem Soll-Stand.
	Zugang string
	// Schluessel ist die geprüfte Normalform "ssh-rsa <Base64>".
	Schluessel string
}

var zugangForm = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ZugangGueltig prüft die Kennung eines Zugangs, wie sie in einer Antwort
// stehen darf: ein Wort ohne Leerraum. Die IDs der API sind UUIDs.
func ZugangGueltig(id string) bool { return zugangForm.MatchString(id) }

// Pruefwert hängt nur an der Liste (wer, mit welchem Schlüssel), nicht an der
// Restlaufzeit: die läuft jede Sekunde weiter und wäre sonst jedes Mal eine
// Änderung. Eine Box nennt ihn bei der nächsten Anfrage; solange er gleich
// bleibt, hält der Server die Anfrage offen.
func Pruefwert(eintraege []Eintrag) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s %d\n", Kopf, Version)
	for _, e := range eintraege {
		fmt.Fprintf(h, "%s %s\n", e.Zugang, e.Schluessel)
	}
	return hex.EncodeToString(h.Sum(nil)[:8])
}

// Text ist die Antwort: eine Kopfzeile mit dem Prüfwert, eine Zeile je
// Schlüssel, zuletzt die Anzahl. Fehlt die letzte Zeile oder stimmt die Zahl
// nicht, ist die Antwort abgeschnitten, und die Box verwirft sie ganz.
func Text(eintraege []Eintrag) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "%s %d %s\n", Kopf, Version, Pruefwert(eintraege))
	for _, e := range eintraege {
		fmt.Fprintf(&b, "schluessel %d %s %s\n", e.Sekunden, e.Zugang, e.Schluessel)
	}
	fmt.Fprintf(&b, "ende %d\n", len(eintraege))
	return []byte(b.String())
}
