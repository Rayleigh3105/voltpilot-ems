package main

import (
	"bytes"
	"errors"
	"log/slog"
	"runtime/debug"
	"strings"
	"testing"

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
