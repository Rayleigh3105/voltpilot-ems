// Package referenz prüft die Kennung einer Box (edge-Referenz) mit ihrem
// Prüfzeichen, wie edge-app/core (refCheckChar), die API (EdgeRef.java), das
// Portal (edgeRef.ts) und das Gehäuse-Programm (kennung.py). Vektor:
// docs/contracts/edge-ref-vectors.json; Algorithmus und Vektor nur gemeinsam
// ändern.
package referenz

import "strings"

const (
	// Alphabet ohne verwechselbare Zeichen (kein i, l, o, 0, 1).
	Alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	Praefix  = "edge-"
	// KoerperLaenge: Zeichen zwischen Präfix und Prüfzeichen.
	KoerperLaenge = 6
)

// Gueltig sagt, ob ref eine Kennung mit richtigem Prüfzeichen ist. Die Box
// schreibt sie klein; eine andere Schreibung ist hier nicht gültig.
func Gueltig(ref string) bool {
	k, ok := strings.CutPrefix(ref, Praefix)
	if !ok || len(k) != KoerperLaenge+1 {
		return false
	}
	summe := 0
	for i := 0; i < KoerperLaenge; i++ {
		p := strings.IndexByte(Alphabet, k[i])
		if p < 0 {
			return false
		}
		summe += (i + 1) * p
	}
	if strings.IndexByte(Alphabet, k[KoerperLaenge]) < 0 {
		return false
	}
	return Alphabet[summe%len(Alphabet)] == k[KoerperLaenge]
}
