package metriken

import (
	"bytes"
	"testing"
)

func TestTextformat(t *testing.T) {
	r := Neu()
	m := r.Messwert("vp_b", "B-Wert.", "schritt")
	z := r.Zaehler("vp_a_total", "Zähler.", "ergebnis")
	u := r.Messwert("vp_c_alter_seconds", "Fehlt, wenn unbekannt.")
	z.Null("fertig")
	z.Plus("angehalten")
	m.Setze(1.5, `open"wrt`)
	u.Setze(3)
	u.Loesche()
	var b bytes.Buffer
	_ = r.Schreibe(&b)
	want := "# HELP vp_a_total Zähler.\n# TYPE vp_a_total counter\nvp_a_total{ergebnis=\"angehalten\"} 1\nvp_a_total{ergebnis=\"fertig\"} 0\n" +
		"# HELP vp_b B-Wert.\n# TYPE vp_b gauge\nvp_b{schritt=\"open\\\"wrt\"} 1.5\n" +
		"# HELP vp_c_alter_seconds Fehlt, wenn unbekannt.\n# TYPE vp_c_alter_seconds gauge\n"
	if b.String() != want {
		t.Fatalf("got\n%s\nwant\n%s", b.String(), want)
	}
}
