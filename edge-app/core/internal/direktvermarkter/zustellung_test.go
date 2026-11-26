package direktvermarkter

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func gueltigesProfil() Profile {
	band := [2]int{0, 100}
	return Profile{
		ID: "luox",
		Modbus: Modbus{Unit: 1, WordOrder: "little", Functions: []int{3, 4, 6, 16},
			Connections: 2},
		Register: []Register{
			{Table: "input", Address: 0, Type: "s32", Meaning: "nvp_einspeisung_w"},
			{Table: "input", Address: 2, Type: "u32", Meaning: "erzeugung_w"},
			{Table: "input", Address: 4, Type: "u16", Meaning: "netzbetreiber_vorgabe_pct"},
			{Table: "input", Address: 5, Type: "u32", Meaning: "referenz_w"},
			{Table: "holding", Address: 2, Type: "u16", Meaning: "vermarkter_vorgabe_pct", Band: &band},
			{Table: "holding", Address: 3, Type: "u32", Meaning: "lebenszeichen"},
		},
		Rules: Rules{WatchdogDeadlineS: 900, RestPct: 100, OnStale: "ausnahme_0x0b"},
	}
}

func gueltigesDokument(t *testing.T) ([]byte, *ProfilDokument) {
	t.Helper()
	doc := ProfilDokument{SchemaVersion: SchemaVersion, TenantID: "t", SiteID: "s", DeviceID: "d",
		GeneratedAt: "2026-11-26T08:00:00Z", Partner: "luox", Revision: 1, ReferenzWp: 12000,
		ZugangFingerabdruck: "SHA256:abc"}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseProfilDokument(raw)
	if err != nil {
		t.Fatalf("gueltiges Dokument abgelehnt: %v", err)
	}
	return raw, parsed
}

func TestParseProfilDokumentEmptyIsWithdrawal(t *testing.T) {
	for _, raw := range [][]byte{nil, {}, []byte("  \n")} {
		doc, err := ParseProfilDokument(raw)
		if err != nil || doc != nil {
			t.Fatalf("leere Nutzlast: doc=%v err=%v", doc, err)
		}
	}
}

func TestParseProfilDokumentRejects(t *testing.T) {
	base := func() ProfilDokument {
		return ProfilDokument{SchemaVersion: SchemaVersion, Partner: "luox", Revision: 1,
			ReferenzWp: 12000, ZugangFingerabdruck: "SHA256:abc"}
	}
	cases := map[string]func(*ProfilDokument){
		"schema_version":      func(d *ProfilDokument) { d.SchemaVersion = "2.0" },
		"partner fehlt":       func(d *ProfilDokument) { d.Partner = " " },
		"fingerabdruck fehlt": func(d *ProfilDokument) { d.ZugangFingerabdruck = "" },
		"referenz fehlt":      func(d *ProfilDokument) { d.ReferenzWp = 0 },
		"referenz negativ":    func(d *ProfilDokument) { d.ReferenzWp = -1 },
	}
	for name, mutate := range cases {
		d := base()
		mutate(&d)
		raw, err := json.Marshal(d)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := ParseProfilDokument(raw); err == nil {
			t.Errorf("%s: angenommen, sollte abgelehnt sein", name)
		}
	}
}

func TestParseZugangAntwortStrict(t *testing.T) {
	base := func() ZugangAntwort {
		return ZugangAntwort{SchemaVersion: SchemaVersion, Partner: "luox",
			ZugangFingerabdruck: "SHA256:abc",
			Gegenstelle:         Gegenstelle{Host: "vpn.luox.example", Port: 1194, Protokoll: "udp"},
			Dateien:             Dateien{ZertifikatPEM: "Z", SchluesselPEM: "S", CAPEM: "C"}}
	}
	z, err := ParseZugangAntwort(mustJSON(t, base()))
	if err != nil {
		t.Fatalf("gueltige Antwort abgelehnt: %v", err)
	}
	if z.TLSSchluessel != "keine" {
		t.Fatalf("tls_schluessel ohne Angabe: %q, want keine", z.TLSSchluessel)
	}
	mitTLS := base()
	mitTLS.TLSSchluessel = "tls_crypt"
	mitTLS.Dateien.TLSSchluesselPEM = "T"
	if _, err := ParseZugangAntwort(mustJSON(t, mitTLS)); err != nil {
		t.Fatalf("tls_crypt mit Schluessel abgelehnt: %v", err)
	}
	cases := map[string]func(*ZugangAntwort){
		"schema":            func(z *ZugangAntwort) { z.SchemaVersion = "0.9" },
		"fingerabdruck":     func(z *ZugangAntwort) { z.ZugangFingerabdruck = "" },
		"zertifikat":        func(z *ZugangAntwort) { z.Dateien.ZertifikatPEM = "" },
		"schluessel":        func(z *ZugangAntwort) { z.Dateien.SchluesselPEM = "" },
		"ca":                func(z *ZugangAntwort) { z.Dateien.CAPEM = "" },
		"host":              func(z *ZugangAntwort) { z.Gegenstelle.Host = " " },
		"port":              func(z *ZugangAntwort) { z.Gegenstelle.Port = 0 },
		"protokoll fehlt":   func(z *ZugangAntwort) { z.Gegenstelle.Protokoll = "" },
		"protokoll fremd":   func(z *ZugangAntwort) { z.Gegenstelle.Protokoll = "icmp" },
		"tls-wort fremd":    func(z *ZugangAntwort) { z.TLSSchluessel = "irgendwas" },
		"tls ohne material": func(z *ZugangAntwort) { z.TLSSchluessel = "tls_auth" },
	}
	for name, mutate := range cases {
		z := base()
		mutate(&z)
		if _, err := ParseZugangAntwort(mustJSON(t, z)); err == nil {
			t.Errorf("%s: angenommen, sollte abgelehnt sein", name)
		}
	}
}

// A parse error over key material must never carry the material itself.
func TestParseZugangAntwortErrorNeverCarriesContent(t *testing.T) {
	z := ZugangAntwort{SchemaVersion: "0.9", ZugangFingerabdruck: "SHA256:abc",
		Dateien: Dateien{ZertifikatPEM: "-----BEGIN CERTIFICATE-----GEHEIM"}}
	_, err := ParseZugangAntwort(mustJSON(t, z))
	if err == nil {
		t.Fatal("angenommen")
	}
	if strings.Contains(err.Error(), "GEHEIM") || strings.Contains(err.Error(), "BEGIN") {
		t.Fatalf("Fehler traegt Inhalt: %v", err)
	}
}

func TestNeueAnfrageUndQuittung(t *testing.T) {
	now := time.Date(2026, 11, 26, 8, 0, 0, 0, time.UTC)
	a := NeueAnfrage("SHA256:abc", now)
	if a.SchemaVersion != SchemaVersion || a.ZugangFingerabdruck != "SHA256:abc" ||
		a.AngefragtAm != "2026-11-26T08:00:00Z" {
		t.Fatalf("Anfrage: %+v", a)
	}
	q := NeueQuittung("SHA256:abc", QuittungGeloescht, now)
	if q.Ereignis != QuittungGeloescht || q.Am != "2026-11-26T08:00:00Z" {
		t.Fatalf("Quittung: %+v", q)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
