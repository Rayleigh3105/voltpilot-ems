package geheim

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestGeheimFormatiertNieSeinenWert(t *testing.T) {
	g := Neu("sehr-geheimes-passwort-1")
	defer g.Vergessen()
	b, _ := json.Marshal(struct{ P Geheim }{g})
	txt, _ := g.MarshalText()
	for _, s := range []string{
		fmt.Sprintf("%v %s %q %+v %#v %x %d", g, g, g, g, g, g, g),
		fmt.Sprint(g), fmt.Sprintf("%+v", struct{ P Geheim }{g}), string(b), string(txt), g.LogValue().String(),
	} {
		if strings.Contains(s, "sehr-geheimes") {
			t.Fatalf("Wert sichtbar: %s", s)
		}
	}
	if g.Offenbaren() != "sehr-geheimes-passwort-1" || g.Leer() {
		t.Fatal("Offenbaren liefert den Wert nicht")
	}
	if !(Geheim{}).Leer() || (Geheim{}).Offenbaren() != "" {
		t.Fatal("Nullwert nicht leer")
	}
	var _ slog.LogValuer = g
}

func TestSchwaerzer(t *testing.T) {
	a := Neu("passwort-der-box-1234")
	kurz := Neu("kurz") // zu kurz zum Schwärzen: nie Teilwörter ersetzen
	pem := Neu("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUA\nAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----\n")
	if got := Schwaerze("Ausgabe: passwort-der-box-1234 und kurz"); got != "Ausgabe: [geheim] und kurz" {
		t.Fatalf("got %q", got)
	}
	if got := Schwaerze("nur eine Zeile: AAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW"); strings.Contains(got, "AAAAEbm9uZQ") {
		t.Fatalf("Zeile eines Schlüssels nicht geschwärzt: %q", got)
	}
	a.Vergessen()
	if got := Schwaerze("passwort-der-box-1234"); got != "passwort-der-box-1234" {
		t.Fatalf("nach Vergessen noch geschwärzt: %q", got)
	}
	// zwei Geheimnisse mit gleichem Wert: erst nach beiden vergessen
	b1, b2 := Neu("doppelt-gleicher-wert"), Neu("doppelt-gleicher-wert")
	b1.Vergessen()
	if Schwaerze("doppelt-gleicher-wert") != Ersatz {
		t.Fatal("zu früh vergessen")
	}
	b2.Vergessen()
	kurz.Vergessen()
	pem.Vergessen()
}
