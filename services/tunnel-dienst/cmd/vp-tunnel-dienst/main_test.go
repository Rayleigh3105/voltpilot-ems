package main

import (
	"bytes"
	"errors"
	"log/slog"
	"runtime/debug"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/ausgabe"
	"git.tecmaxx.de/mamotec/voltpilot-ems/services/tunnel-dienst/internal/konfig"
)

func TestStandNimmtDenBeimBauGesetztenWert(t *testing.T) {
	git := &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs.revision", Value: "3a8519f1d34a276c3504edf93440ac581062dd4d"},
		{Key: "vcs.modified", Value: "false"},
	}}
	geaendert := &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs.revision", Value: "3a8519f1d34a276c3504edf93440ac581062dd4d"},
		{Key: "vcs.modified", Value: "true"},
	}}
	for _, f := range []struct {
		name    string
		gesetzt string
		info    *debug.BuildInfo
		want    string
	}{
		{"per -ldflags gesetzt", "3a8519f1d34a", git, "3a8519f1d34a"},
		{"nicht gesetzt, Go kennt den Commit", "", git, "3a8519f1d34a"},
		{"nicht gesetzt, Arbeitsverzeichnis geändert", "", geaendert, "3a8519f1d34a+geaendert"},
		{"nicht gesetzt, kein Commit (-buildvcs=false)", "", &debug.BuildInfo{}, "unbekannt"},
		{"ohne Bau-Angaben", "", nil, "unbekannt"},
	} {
		if got := stand(f.gesetzt, f.info); got != f.want {
			t.Errorf("%s: %q, erwartet %q", f.name, got, f.want)
		}
	}
}

func TestVersionStehtInDerStartzeileUndImStatus(t *testing.T) {
	k, err := konfig.Lies(func(string) string { return "" }, true)
	if err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	startMeldung(slog.New(slog.NewTextHandler(&log, nil)), k, "3a8519f1d34a")
	if !strings.Contains(log.String(), `msg="Tunnel-Dienst läuft" version=3a8519f1d34a `) {
		t.Errorf("Startzeile: %s", log.String())
	}
	if got := versionsZeile("3a8519f1d34a"); got != "vp-tunnel-dienst Version 3a8519f1d34a" {
		t.Errorf("status/version: %q", got)
	}
}

func TestBasisZeile(t *testing.T) {
	if got := basisZeile(true, nil); got != "Firewall-Basis stimmt: ja" {
		t.Errorf("%q", got)
	}
	if got := basisZeile(false, nil); !strings.HasPrefix(got, "Firewall-Basis stimmt: nein") {
		t.Errorf("%q", got)
	}
	// Ein Fehler beim Lesen ist weder ja noch nein.
	if got := basisZeile(false, errors.New("nft: Operation not permitted")); strings.Contains(got, "stimmt") ||
		!strings.Contains(got, "Operation not permitted") {
		t.Errorf("%q", got)
	}
}

func TestStatusNenntJeBoxDieLetzteAnfrage(t *testing.T) {
	jetzt := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	boxen := map[string]string{"10.10.16.2": "edge-5t2dcy6", "10.10.16.3": "edge-zay5sdd"}
	aus, _ := konfig.Lies(func(string) string { return "" }, true)
	an, err := konfig.Lies(func(k string) string {
		if k == "VP_TUNNEL_SCHLUESSEL_PORT" {
			return "8022"
		}
		return ""
	}, true)
	if err != nil {
		t.Fatal(err)
	}

	var b bytes.Buffer
	schluesselStatus(&b, aus, boxen, ausgabe.Zustand{}, errors.New("keine Datei"), jetzt)
	if got := b.String(); got != "Schlüsselausgabe: aus (VP_TUNNEL_SCHLUESSEL_PORT nicht gesetzt)\n" {
		t.Errorf("abgeschaltet: %q", got)
	}

	b.Reset()
	schluesselStatus(&b, an, boxen, ausgabe.Zustand{}, errors.New("keine Datei"), jetzt)
	if got := b.String(); !strings.HasPrefix(got, "Schlüsselausgabe: 10.10.32.1:8022 eingestellt, aber kein Stand") {
		t.Errorf("ohne Datei: %q", got)
	}

	z := ausgabe.Zustand{Seit: jetzt.Add(-time.Hour), Geschrieben: jetzt.Add(-10 * time.Second), Adresse: "10.10.32.1:8022", Laeuft: true,
		Boxen: map[string]ausgabe.BoxZustand{
			"10.10.16.2": {LetzteAnfrage: jetzt.Add(-12 * time.Second), Anfragen: 80, Ausgegeben: []ausgabe.Ausgegeben{
				{Zugang: "t1", Techniker: "Max (Laptop)", Fingerabdruck: "SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc", Bis: jetzt.Add(time.Hour)}}},
			"10.10.16.9": {LetzteAnfrage: jetzt.Add(-3 * time.Minute), Anfragen: 1},
		}}
	b.Reset()
	schluesselStatus(&b, an, boxen, z, nil, jetzt)
	got := b.String()
	for _, muss := range []string{
		"Schlüsselausgabe: 10.10.32.1:8022, lauscht, Dienst gestartet ",
		"edge-5t2dcy6                 10.10.16.2      zuletzt gefragt vor 12s, 1 Schlüssel in der letzten Antwort\n",
		"      Max (Laptop)  SHA256:TDOx3bpPNtPLIdd+juZoGcDMz3ZRCklaP5G6aBrp9Zc  bis ",
		"edge-zay5sdd                 10.10.16.3      seit dem Start nicht gefragt\n",
		// Eine Box, die fragt, aber nicht (mehr) im Soll-Stand steht, wird nicht verschwiegen.
		"10.10.16.9      zuletzt gefragt vor 3m0s, 0 Schlüssel in der letzten Antwort\n",
	} {
		if !strings.Contains(got, muss) {
			t.Errorf("fehlt %q in:\n%s", muss, got)
		}
	}
	if strings.Contains(got, "läuft der Dienst?") || strings.Contains(got, "LAUSCHT NICHT") {
		t.Errorf("frischer Stand:\n%s", got)
	}
	if strings.Index(got, "10.10.16.2 ") > strings.Index(got, "10.10.16.3 ") || strings.Index(got, "10.10.16.3 ") > strings.Index(got, "10.10.16.9 ") {
		t.Errorf("nicht nach Adresse geordnet:\n%s", got)
	}

	// Ein alter Stand und ein Schalter, der nicht lauscht, werden benannt.
	z.Geschrieben = jetzt.Add(-10 * time.Minute)
	z.Laeuft = false
	b.Reset()
	schluesselStatus(&b, an, boxen, z, nil, jetzt)
	if got := b.String(); !strings.Contains(got, "LAUSCHT NICHT") || !strings.Contains(got, "Stand von vor 10m0s, läuft der Dienst?") {
		t.Errorf("alter Stand:\n%s", got)
	}
}

func TestStartzeileNenntDieSchluesselausgabe(t *testing.T) {
	for port, will := range map[string]string{"": "schluesselausgabe=aus", "8022": "schluesselausgabe=10.10.32.1:8022"} {
		k, err := konfig.Lies(func(k string) string {
			if k == "VP_TUNNEL_SCHLUESSEL_PORT" {
				return port
			}
			return ""
		}, true)
		if err != nil {
			t.Fatal(err)
		}
		var log bytes.Buffer
		startMeldung(slog.New(slog.NewTextHandler(&log, nil)), k, "x")
		if !strings.Contains(log.String(), will) {
			t.Errorf("Port %q: %s", port, log.String())
		}
		if r := regeln(k); (r.SchluesselPort != 0) != (port != "") {
			t.Errorf("Port %q kommt nicht in der Firewall-Basis an: %+v", port, r)
		}
	}
}
