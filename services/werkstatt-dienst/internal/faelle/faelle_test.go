package faelle

import (
	"os"
	"strings"
	"testing"
)

// Jeder Code hat eine Lösung mit Titel und Schritten und steht im Vertrag;
// zur Seite und von selbst weiter schließen sich aus.
func TestJederCodeHatEineLoesungUndStehtImVertrag(t *testing.T) {
	vertrag, err := os.ReadFile("../../../../docs/contracts/werkstatt-ansicht-v1.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range Codes() {
		l := Zu(c)
		if l == nil || l.Titel == "" || len(l.Schritte) == 0 {
			t.Errorf("%s: %+v", c, l)
			continue
		}
		if l.Selbst && l.ZurSeite {
			t.Errorf("%s: selbst und zur Seite", c)
		}
		if !strings.Contains(string(vertrag), "`"+c+"`") {
			t.Errorf("%s steht nicht in werkstatt-ansicht-v1.md", c)
		}
	}
	if Zu("gibt_es_nicht") != nil {
		t.Fatal("unbekannter Code")
	}
	a := Zu(SchrittGescheitert)
	a.Schritte[0] = "verändert"
	if Zu(SchrittGescheitert).Schritte[0] == "verändert" {
		t.Fatal("Zu gibt keine Kopie")
	}
}

// Die Gründe vom 05.11. und die übrigen Fehler ohne eigenen Fall.
func TestEinordnen(t *testing.T) {
	for _, f := range []struct{ schritt, grund, code string }{
		{"erkennen", "Frist von 1m0s überschritten: Brücke 192.168.0.157:22 nicht erreichbar: dial tcp 192.168.0.157:22: i/o timeout", BrueckeWeg},
		{"erkennen", "Brücke leitet nicht weiter zu 192.168.1.1:22: No route to host", BoxWeg},
		{"internet", "kein Internet über die Brücke (Prüfstein PS-12): Standardweg \"\"", KeinInternet},
		{"fassungen", "Abbild im Zwischenspeicher hat nicht die Prüfsumme der Freigabe", FassungNichtBereit},
		{"openwrt", "Prüfsumme auf der Box abc, erwartet def: nicht aufgespielt", Uebertragung},
		{"einloesen", "das Portal hat die Einlösung abgewiesen: schluessel_festgehalten", EinloesenAbgewiesen},
		{"uebergabe", "die Box ist nicht update-bereit (nicht signiert) - keine Abnahme (Entscheid 5c)", NichtUpdateBereit},
		{"neustart", "kein frischer Handshake an wg_wartung nach dem Neustart", SchrittGescheitert},
	} {
		if c := Einordnen(f.schritt, f.grund); c != f.code {
			t.Errorf("%s / %q: %s, erwartet %s", f.schritt, f.grund, c, f.code)
		}
	}
}
