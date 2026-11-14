package agent

import (
	"os"
	"path/filepath"
	"testing"
)

// fakeWlanSkript writes a throwaway "#!/bin/sh" script that echoes fixed
// "status" output - the same test pattern as web/einrichtung_test.go, so this
// never depends on a real OpenWrt box.
func fakeWlanSkript(t *testing.T, aus string) string {
	t.Helper()
	pfad := filepath.Join(t.TempDir(), "wlan-anschluss.sh")
	inhalt := "#!/bin/sh\nprintf '%s' '" + aus + "'\n"
	if err := os.WriteFile(pfad, []byte(inhalt), 0o755); err != nil {
		t.Fatal(err)
	}
	return pfad
}

func TestWlanVerbindungVonSkriptLiestWlanMitSignal(t *testing.T) {
	skript := fakeWlanSkript(t, "modus=wlan\nfunkmodul=an\nwlan_signal=-62\nwlan_kanal=6\n")
	kind, signal := wlanVerbindungVonSkript(skript)
	if kind != "wlan" || signal == nil || *signal != -62 {
		t.Fatalf("got kind=%q signal=%v", kind, signal)
	}
}

func TestWlanVerbindungVonSkriptLiestKabelOhneSignal(t *testing.T) {
	skript := fakeWlanSkript(t, "modus=kabel\nfunkmodul=aus\n")
	kind, signal := wlanVerbindungVonSkript(skript)
	if kind != "kabel" || signal != nil {
		t.Fatalf("got kind=%q signal=%v", kind, signal)
	}
}

// "keins" (noch nichts eingerichtet) ist unbekannt, nie eine erfundene Art.
func TestWlanVerbindungVonSkriptKeinsIstUnbekannt(t *testing.T) {
	skript := fakeWlanSkript(t, "modus=keins\n")
	kind, signal := wlanVerbindungVonSkript(skript)
	if kind != "" || signal != nil {
		t.Fatalf("got kind=%q signal=%v", kind, signal)
	}
}

// Ein Wort außerhalb des Vokabulars (ein künftiger Skript-Stand) wird
// verworfen statt verbatim gespeichert - dieselbe Disziplin wie beim
// unbekannten Update-Zustand (UpdateStatusListener).
func TestWlanVerbindungVonSkriptUnbekanntesWortWirdVerworfen(t *testing.T) {
	skript := fakeWlanSkript(t, "modus=mesh\n")
	kind, signal := wlanVerbindungVonSkript(skript)
	if kind != "" || signal != nil {
		t.Fatalf("got kind=%q signal=%v", kind, signal)
	}
}

func TestWlanVerbindungVonSkriptEinFehlendesSkriptIstUnbekannt(t *testing.T) {
	kind, signal := wlanVerbindungVonSkript(filepath.Join(t.TempDir(), "fehlt.sh"))
	if kind != "" || signal != nil {
		t.Fatalf("got kind=%q signal=%v", kind, signal)
	}
}

func TestWlanFelderAusZeilen(t *testing.T) {
	f := wlanFelderAusZeilen("modus=wlan\nwlan_signal=-70\nleer\n=ohne-schluessel\n")
	if f["modus"] != "wlan" || f["wlan_signal"] != "-70" {
		t.Fatalf("got %+v", f)
	}
	if _, ok := f["leer"]; ok {
		t.Fatalf("a line without '=' must not become a field: %+v", f)
	}
}
