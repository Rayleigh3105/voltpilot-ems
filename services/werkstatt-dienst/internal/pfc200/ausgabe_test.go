package pfc200

import "testing"

// Ein Werkzeug der Firmware, das bei einem Fehler nichts ausgibt (etwa
// config_linux_user bei user=root), darf sich in der Meldung nicht wie eine
// abgeschnittene Anzeige lesen.
func TestAusgabeOderHinweisOhneAusgabe(t *testing.T) {
	if got := ausgabeOderHinweis("", 4); got != "(keine Ausgabe)" {
		t.Errorf("ausgabeOderHinweis(\"\", 4) = %q, erwartet \"(keine Ausgabe)\"", got)
	}
	if got := ausgabeOderHinweis("   \n  ", 4); got != "(keine Ausgabe)" {
		t.Errorf("ausgabeOderHinweis mit nur Leerraum = %q, erwartet \"(keine Ausgabe)\"", got)
	}
}

func TestAusgabeOderHinweisMitAusgabe(t *testing.T) {
	if got := ausgabeOderHinweis("Invalid user (foo)", 4); got != "Invalid user (foo)" {
		t.Errorf("ausgabeOderHinweis = %q", got)
	}
	if got := ausgabeOderHinweis("eins\nzwei\ndrei\nvier\nfuenf", 2); got != "vier | fuenf" {
		t.Errorf("ausgabeOderHinweis kürzt nicht auf die letzten Zeilen: %q", got)
	}
}
