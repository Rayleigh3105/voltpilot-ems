package agent

// Die Pflege der WLAN-Skripte durch das bestaetigte Programm (wlan_pflege.go):
// die Schranken des Agenten. Das Schreiben selbst belegt
// internal/wlanstand; die Probe im echten OpenWrt-Rootfs
// (edge-light/test/boot-update-probe.sh, Fall 12) und im Emulator mit WLAN
// (edge-light/test/wlan-anschluss-probe.sh, Lauf skripte-update) fahren den
// Weg zusaetzlich auf der Box.

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otalight"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/wlanstand"
)

// Die WLAN-Skripte im Feld vor der Marke (edge-light-2026.11.17 und frueher).
const (
	alterWlanAnschluss  = "#!/bin/sh\n# wlan-anschluss.sh ohne WLAN_STAND\nexit 0\n"
	alteWlanEinrichtung = "#!/bin/sh\n# einrichtung-wlan.sh vor der Marke\nexit 0\n"
)

func lightWlanBox(t *testing.T) (*Agent, string) {
	t.Helper()
	a := lightPflegeBox(t)
	dir := filepath.Join(filepath.Dir(a.Cfg.LoaderPath), "libexec")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	a.Cfg.WlanSkript = filepath.Join(dir, "wlan-anschluss.sh")
	schreibe(t, a.Cfg.WlanSkript, alterWlanAnschluss)
	einr := filepath.Join(dir, wlanstand.EinrichtungName)
	schreibe(t, einr, alteWlanEinrichtung)
	return a, einr
}

func gleich(t *testing.T, pfad string, soll []byte) bool {
	t.Helper()
	ist, err := os.ReadFile(pfad)
	return err == nil && string(ist) == string(soll)
}

// Altes Skript + bestaetigtes Programm: beide Skripte werden ersetzt, die alten
// liegen als .alt daneben; ein zweiter Lauf schreibt nichts mehr.
func TestEdgeLightWlanPflegeErneuertAlteSkripte(t *testing.T) {
	a, einr := lightWlanBox(t)
	fertig, err := a.wlanPflegen(context.Background())
	if err != nil || !fertig {
		t.Fatalf("fertig=%v err=%v", fertig, err)
	}
	if !gleich(t, a.Cfg.WlanSkript, wlanstand.Anschluss()) || !gleich(t, einr, wlanstand.Einrichtung()) {
		t.Fatal("die Skripte sind nicht die eingebetteten Kopien")
	}
	if !gleich(t, a.Cfg.WlanSkript+wlanstand.Alt, []byte(alterWlanAnschluss)) ||
		!gleich(t, einr+wlanstand.Alt, []byte(alteWlanEinrichtung)) {
		t.Fatal("die alten Fassungen liegen nicht als .alt daneben")
	}

	vor := mtime(t, a.Cfg.WlanSkript)
	time.Sleep(10 * time.Millisecond)
	if fertig, err := a.wlanPflegen(context.Background()); err != nil || !fertig {
		t.Fatalf("zweiter Lauf: fertig=%v err=%v", fertig, err)
	}
	if !mtime(t, a.Cfg.WlanSkript).Equal(vor) {
		t.Fatal("der zweite Lauf hat erneut geschrieben")
	}
}

// Nie waehrend der Probe: solange probe.json liegt, wird nichts eingespielt.
func TestEdgeLightWlanPflegeWartetAufDasProbenEnde(t *testing.T) {
	a, _ := lightWlanBox(t)
	probe := filepath.Join(a.Cfg.OtaRAMDir, otalight.FileProbe)
	schreibe(t, probe, `{"release":"edge-light-2026.11.19","release_seq":42,"zuweisung":"z-1"}`)
	if fertig, err := a.wlanPflegen(context.Background()); err != nil || fertig {
		t.Fatalf("waehrend der Probe: fertig=%v err=%v", fertig, err)
	}
	if !gleich(t, a.Cfg.WlanSkript, []byte(alterWlanAnschluss)) {
		t.Fatal("waehrend der Probe wurde das Skript angefasst")
	}
	if err := os.Remove(probe); err != nil {
		t.Fatal(err)
	}
	if fertig, err := a.wlanPflegen(context.Background()); err != nil || !fertig {
		t.Fatalf("nach der Probe: fertig=%v err=%v", fertig, err)
	}
	if !gleich(t, a.Cfg.WlanSkript, wlanstand.Anschluss()) {
		t.Fatal("nach der Probe wurde das Skript nicht erneuert")
	}
}

// Nur ein vom Loader gestartetes Edge-Light-Programm pflegt: ohne
// VP_OTA_RAM_DIR (Labortest, Stufe 1), auf Edge Industrie und auf der
// Docker-Box endet die Schleife sofort, ohne etwas anzufassen.
func TestEdgeLightWlanPflegeNurEdgeLightUnterEinemUpdateLoader(t *testing.T) {
	for _, f := range []struct {
		name string
		mach func(a *Agent)
	}{
		{"ohne VP_OTA_RAM_DIR", func(a *Agent) { a.Cfg.OtaRAMDir = "" }},
		{"Edge Industrie", func(a *Agent) { a.Cfg.BoxArt = geraetesuche.BoxArtEdgeIndustrie }},
		{"Docker-Box", func(a *Agent) { a.Cfg.BoxArt = geraetesuche.BoxArtDocker }},
	} {
		a, einr := lightWlanBox(t)
		f.mach(a)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		a.done.Add(1)
		a.wlanPflegeLoop(ctx, time.Millisecond, time.Millisecond)
		cancel()
		if !gleich(t, a.Cfg.WlanSkript, []byte(alterWlanAnschluss)) || !gleich(t, einr, []byte(alteWlanEinrichtung)) {
			t.Fatalf("%s: die Skripte wurden angefasst", f.name)
		}
		if _, err := os.Stat(a.Cfg.WlanSkript + wlanstand.Alt); !os.IsNotExist(err) {
			t.Fatalf("%s: eine .alt wurde angelegt", f.name)
		}
	}
}

// Ein beschaedigt geschriebener Stand wird verworfen; die Schleife gibt nach
// hoechstens loaderPflegeVersucheMax Versuchen auf (Flash schonen), das alte
// Skript bleibt unversehrt.
func TestEdgeLightWlanPflegeGibtNachDreiVersuchenAuf(t *testing.T) {
	a, _ := lightWlanBox(t)
	stoerungen := 0
	a.wlanPflege.nachSchreiben = func(tmp string) {
		stoerungen++
		if err := os.WriteFile(tmp, []byte("beschaedigt"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	a.done.Add(1)
	a.wlanPflegeLoop(ctx, time.Millisecond, time.Millisecond)

	// Je Versuch eine Stoerung: der Waechter wird im ersten Versuch beschaedigt
	// und bricht ab, bevor wlan-anschluss.sh an der Reihe ist.
	if stoerungen != loaderPflegeVersucheMax {
		t.Fatalf("%d Schreibversuche, erwartet %d", stoerungen, loaderPflegeVersucheMax)
	}
	if !gleich(t, a.Cfg.WlanSkript, []byte(alterWlanAnschluss)) {
		t.Fatal("das alte Skript ist nicht mehr unversehrt")
	}
	if _, err := os.Stat(a.Cfg.WlanSkript + ".neu"); !os.IsNotExist(err) {
		t.Fatal("die beschaedigte temporaere Datei blieb liegen")
	}
}
