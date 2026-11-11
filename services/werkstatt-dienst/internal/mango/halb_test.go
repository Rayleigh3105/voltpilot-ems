package mango_test

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/lauf"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/mango"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/portal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// vorigerLauf schreibt das Protokoll eines Laufs, der dieser Box ein Passwort
// setzte und dann anhielt (bis: die belegten Schritte nach erkennen).
func vorigerLauf(t *testing.T, a *aufbau, host string, bis ...string) {
	t.Helper()
	k := "2026-11-04-162800-ab12"
	_ = a.ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBegonnen, Angaben: map[string]string{"mac": a.m.MAC, "einstieg": "openwrt"}})
	_ = a.ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.SchrittBelegt, Schritt: "erkennen", Beleg: protokoll.Beleg{}.Mit("mac", a.m.MAC).Mit("host_schluessel", "ssh-rsa "+host)})
	for _, s := range bis {
		b := protokoll.Beleg{}.Mit("x", "y")
		if s == "programm" {
			b = b.Mit("referenz", "edge-k7m2xq3 (Prüfzeichen gültig)")
		}
		_ = a.ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.SchrittBelegt, Schritt: s, Beleg: b})
	}
	_ = a.ablage.Schreibe(protokoll.Eintrag{Lauf: k, Art: protokoll.LaufBeendet, Zustand: "angehalten"})
}

// Eine Box, deren Lauf nach dem Passwort und vor dem LAN-Netz anhielt, steht
// unter 192.168.1.1 mit dem Passwort der Werkstatt. Mit Protokoll, gleichem
// Host-Schlüssel und Portal „nicht abgenommen, nicht gekoppelt“: Zurücksetzen.
// Sonst nie - und angemeldet wird in keinem Fall.
func TestHalbEingerichtetUnter192168_1_1(t *testing.T) {
	frei := map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3"}}
	for name, f := range map[string]struct {
		bis           []string
		host          string // leer: der echte
		stand         map[string]portal.BoxStand
		ohne          bool
		fall          string
		zuruecksetzen bool
	}{
		"nach passwort, vor programm": {bis: []string{"fassungen", "internet", "passwort"}, fall: "halb_eigene", zuruecksetzen: true},
		"mit Edge Light, Portal frei": {bis: []string{"fassungen", "internet", "passwort", "notfall", "programm"}, stand: frei, fall: "halb_eigene", zuruecksetzen: true},
		"mit Edge Light, abgenommen": {bis: []string{"fassungen", "internet", "passwort", "notfall", "programm"},
			stand: map[string]portal.BoxStand{"edge-k7m2xq3": {EdgeRef: "edge-k7m2xq3", Abgenommen: true}}, fall: "box_in_gebrauch"},
		"mit Edge Light, ohne Portal": {bis: []string{"fassungen", "internet", "passwort", "notfall", "programm"}, fall: "nicht_nachweisbar"},
		"anderer Host-Schlüssel":      {bis: []string{"fassungen", "internet", "passwort"}, host: "SHA256:einanderer", fall: "nicht_nachweisbar"},
		"kein Lauf der Werkstatt":     {ohne: true, fall: "passwort_fremd"},
		"Lauf ohne Passwort":          {bis: []string{"fassungen", "internet"}, fall: "passwort_fremd"},
	} {
		t.Run(name, func(t *testing.T) {
			a := neu(t, true)
			a.m.HalbEingerichtet("192.168.1.1", "werkstatt-passwort-vom-04-11")
			a.k.Spuren = a.ablage
			if f.stand != nil {
				a.k.Portal = &falschesPortal{stand: f.stand}
			}
			host := f.host
			if host == "" {
				host = a.m.HostOpenWrt()
			}
			if !f.ohne {
				vorigerLauf(t, a, host, f.bis...)
			}
			l, z := a.fahre(t, mango.AbOpenWrt)
			s := l.Stand()
			if z != lauf.Angehalten || s.Schritt != "erkennen" || s.Fall != f.fall || strings.HasPrefix(s.Handgriff, "Zurücksetzen:") != f.zuruecksetzen {
				t.Fatalf("Zustand %s: %+v", z, s)
			}
			if f.zuruecksetzen && !strings.Contains(s.Grund, "2026-11-04-162800-ab12") {
				t.Fatalf("Grund nennt den Lauf nicht: %s", s.Grund)
			}
			if len(a.m.Befehle()) != 0 {
				t.Fatalf("an der Box ausgeführt: %v", a.m.Befehle())
			}
		})
	}
}
