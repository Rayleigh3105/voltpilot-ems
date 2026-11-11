package lauf

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/faelle"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/geheim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/werkstatt-dienst/internal/protokoll"
)

// geheimeAngaben stehen in echten Belegen, dürfen aber nie in eine Zeile der
// Ansicht (E3 A: eine Zeile aus einer festen Liste, nie ein Geheimnis).
var geheimeAngaben = map[string]string{
	"passwort_age":         "-----BEGIN AGE ENCRYPTED FILE-----GEHEIM1",
	"passwd":               "passwd: password for root changed GEHEIM2",
	"code":                 "für edge-x ausgegeben GEHEIM3",
	"tunnel_schluessel":    "wg-public GEHEIM4",
	"techniker_schluessel": "SHA256:GEHEIM5",
	"abgewiesen":           "Fehler GEHEIM6",
	"install":              "Ausgabe GEHEIM7",
	"einrichten":           "Ausgabe GEHEIM8",
	"box_log_anmeldung":    "Log GEHEIM9",
	"sysupgrade":           "Ausgabe GEHEIM10",
	"host_schluessel":      "ssh-ed25519 SHA256:GEHEIM11",
	"probe_fenster":        "fenster GEHEIM12",
}

func TestBelegzeileNieMitGeheimnis(t *testing.T) {
	schritte := []string{"erkennen", "fassungen", "openwrt", "wiedererkennen", "internet", "passwort", "notfall", "programm",
		"tunnel_schluessel", "einloesen", "tunnel_adresse", "tunnel", "lan", "neustart", "probe", "internet_weg", "uebergabe", "unbekannt"}
	for _, s := range schritte {
		b := protokoll.Beleg{}
		for n, v := range geheimeAngaben {
			b = b.Mit(n, v)
		}
		z := Zeile(s, b)
		if z == "" || strings.Contains(z, "GEHEIM") || strings.Contains(z, "BEGIN") {
			t.Fatalf("%s: %q", s, z)
		}
		if len([]rune(z)) > zeileMax {
			t.Fatalf("%s: zu lang %q", s, z)
		}
	}
	// Landet Schlüsselmaterial doch in einer erlaubten Angabe, steht nur „belegt“
	// da (die API wiese die ganze Ansicht sonst ab); ein bekanntes Geheimnis
	// schwärzt der Schwärzer.
	if z := Zeile("internet_weg", protokoll.Beleg{}.Mit("ergebnis", "-----BEGIN OPENSSH PRIVATE KEY----- abc")); z != "belegt" {
		t.Fatalf("nicht abgefangen: %q", z)
	}
	g := geheim.Neu("Wurzel-Passwort-1234")
	defer g.Vergessen()
	if z := Zeile("internet_weg", protokoll.Beleg{}.Mit("ergebnis", "Box sagt Wurzel-Passwort-1234")); strings.Contains(z, "Wurzel-Passwort-1234") {
		t.Fatalf("nicht geschwärzt: %q", z)
	}
}

func TestBelegzeileAusDenAngaben(t *testing.T) {
	sha := strings.Repeat("ab", 32)
	for _, f := range []struct {
		schritt string
		b       protokoll.Beleg
		will    string
	}{
		{"erkennen", protokoll.Beleg{}.Mit("modell", "GL.iNet GL-MT300N-V2").Mit("gl_firmware", "4.3.17").Mit("root_passwort", "leer"),
			"GL.iNet GL-MT300N-V2 · GL-Firmware 4.3.17 · root-Passwort: leer"},
		{"openwrt", protokoll.Beleg{}.Mit("sha256_dienst", sha).Mit("sha256_box", sha), "Prüfsumme auf der Box = Freigabe · Test vor dem Aufspielen bestanden"},
		{"openwrt", protokoll.Beleg{}.Mit("sha256_dienst", sha).Mit("sha256_box", "x"), "aufgespielt"},
		{"passwort", protokoll.Beleg{}.Mit("ohne_passwort", "abgewiesen").Mit("passwort_age", "GEHEIM"), "gesetzt, nur verschlüsselt abgelegt · ohne Passwort abgewiesen"},
		{"programm", protokoll.Beleg{}.Mit("health", "ref edge-k7m2xq3, version 2026.11.1").Mit("update_bereit", "ja"), "meldet sich: ref edge-k7m2xq3, version 2026.11.1 · update-bereit"},
		{"uebergabe", protokoll.Beleg{}.Mit("fassung", "edge-light-g1").Mit("pruefung_a", "x").Mit("pruefung_b", "y"), "edge-light-g1 · 2 Prüfungen mit Beleg"},
		{"internet", protokoll.Beleg{}.Mit("internet", "nein"), "belegt"},
	} {
		if z := Zeile(f.schritt, f.b); z != f.will {
			t.Fatalf("%s: %q, will %q", f.schritt, z, f.will)
		}
	}
}

func TestVorherAusErkennen(t *testing.T) {
	for _, f := range []struct {
		b      protokoll.Beleg
		fall   string
		system string
		edge   string
		ers    bool
	}{
		{protokoll.Beleg{}.Mit("gl_firmware", "4.3.17"), "", "GL-Firmware 4.3.17", "kein VoltPilot", false},
		{protokoll.Beleg{}.Mit("openwrt", "25.12.5 ramips/mt76x8"), "", "OpenWrt 25.12.5", "kein VoltPilot", false},
		{protokoll.Beleg{}.Mit("openwrt", "25.12.5 ramips/mt76x8"), faelle.SchonEdgeLight, "OpenWrt 25.12.5", "Edge Light, ohne Lauf dieser Werkstatt", false},
		{protokoll.Beleg{}.Mit("host_schluessel_werk", "none"), faelle.GLPasswort, "GL-Firmware, Fassung unbekannt (Passwort)", "unbekannt", false},
		{protokoll.Beleg{}.Mit("lauf_vorher", "2026-11-04-162800-ab12").Mit("referenz_vorher", "edge-pmzasg2"), faelle.HalbEigene,
			"OpenWrt mit Passwort dieser Werkstatt", "edge-pmzasg2, halb eingerichtet (Lauf 2026-11-04-162800-ab12)", true},
	} {
		v := vorherAus(f.b, f.fall)
		if v == nil || v.System != f.system || v.EdgeLight != f.edge || v.Ersetzt != f.ers {
			t.Fatalf("%v %s: %+v", f.b, f.fall, v)
		}
	}
	if v := vorherAus(protokoll.Beleg{}.Mit("mac", "x"), faelle.BrueckeWeg); v != nil {
		t.Fatalf("%+v", v)
	}
}
