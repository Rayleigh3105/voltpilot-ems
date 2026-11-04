package otalight

import (
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

func manifest() *otaverify.Manifest {
	return &otaverify.Manifest{
		Release:     "edge-light-2026.11.2",
		ReleaseSeq:  42,
		StateSchema: 1,
		Artifacts: []otaverify.Artifact{
			{Type: otaverify.ArtifactBinary, Name: "vp-edge-light", Arch: "linux/mipsle", SHA256: strings.Repeat("a", 64)},
			{Type: otaverify.ArtifactBinary, Name: "vp-edge-light", Arch: "linux/arm64", SHA256: strings.Repeat("b", 64)},
		},
	}
}

func TestZuweisungIstEinWort(t *testing.T) {
	for in, want := range map[[2]string]string{
		{"2026-11-04T13:00:00Z", "r"}: "2026-11-04T13:00:00Z",
		{"", "r-1"}:                   "r-1",
		{"", ""}:                      "-",
		{" a b\tc ", ""}:              "a_b_c",
	} {
		if got := Zuweisung(in[0], in[1]); got != want {
			t.Errorf("Zuweisung(%q,%q) = %q, erwartet %q", in[0], in[1], got, want)
		}
	}
}

func TestParseVersucheUebergehtKaputteZeilen(t *testing.T) {
	raw := []byte("start 42 z1\n" +
		"zurueck 42 z1 Selbsttest: Steuerpfad kaputt\n" +
		"quatsch 42 z1\n" +
		"ok x z1\n" +
		"abbruch 0 z1\n" +
		"ok 43 z2\n" +
		"abbr") // halb geschrieben (Strom weg)
	got := ParseVersuche(raw)
	if len(got) != 3 {
		t.Fatalf("%d Zeilen, erwartet 3: %+v", len(got), got)
	}
	if got[1].Art != VersuchZurueck || got[1].Grund != "Selbsttest: Steuerpfad kaputt" {
		t.Fatalf("Grund falsch gelesen: %+v", got[1])
	}
	if got[2].Seq != 43 || got[2].Zuweisung != "z2" {
		t.Fatalf("%+v", got[2])
	}
}

func TestEntscheideWendetDasEigeneProgrammAn(t *testing.T) {
	e := Entscheide(Eingang{Manifest: manifest(), Arch: "linux/arm64", Zuweisung: "z1", StateSchemaLokal: 1})
	if !e.Anwenden || e.Programm.Arch != "linux/arm64" || e.Programm.SHA256 != strings.Repeat("b", 64) {
		t.Fatalf("%+v", e)
	}
	// Unbekanntes lokales Datenformat (alte Box ohne current.json): anwenden.
	if !Entscheide(Eingang{Manifest: manifest(), Arch: "linux/mipsle", Zuweisung: "z1"}).Anwenden {
		t.Fatal("ohne bekanntes lokales Datenformat wurde nicht angewandt")
	}
}

func TestEntscheideOhneProgrammFuerDiesePlattform(t *testing.T) {
	e := Entscheide(Eingang{Manifest: manifest(), Arch: "linux/amd64", Zuweisung: "z1"})
	if e.Anwenden || e.Zustand != ZustandDeferred || !strings.Contains(e.Grund, "linux/amd64") {
		t.Fatalf("%+v", e)
	}
}

func TestEntscheideAnderesDatenformat(t *testing.T) {
	e := Entscheide(Eingang{Manifest: manifest(), Arch: "linux/mipsle", Zuweisung: "z1", StateSchemaLokal: 2})
	if e.Anwenden || e.Zustand != ZustandDeferred || !strings.Contains(e.Grund, "Datenformat") {
		t.Fatalf("%+v", e)
	}
}

func TestEntscheideKeinNeuerVersuchOhneNeueZuweisung(t *testing.T) {
	v := ParseVersuche([]byte("start 42 z1\nzurueck 42 z1 keine Cloud-Verbindung in der Probezeit\n"))
	e := Entscheide(Eingang{Manifest: manifest(), Arch: "linux/mipsle", Zuweisung: "z1", Versuche: v})
	if e.Anwenden || e.Zustand != ZustandRolledBack || !strings.Contains(e.Grund, "keine Cloud-Verbindung") ||
		!strings.Contains(e.Grund, "neue Zuweisung") {
		t.Fatalf("%+v", e)
	}
	// Eine NEUE Zuweisung desselben Release versucht es erneut.
	if !Entscheide(Eingang{Manifest: manifest(), Arch: "linux/mipsle", Zuweisung: "z2", Versuche: v}).Anwenden {
		t.Fatal("eine neue Zuweisung wurde nicht angewandt")
	}
}

func TestEntscheideZweiAbbruecheSindGescheitert(t *testing.T) {
	ein := ParseVersuche([]byte("start 42 z1\nabbruch 42 z1\n"))
	if !Entscheide(Eingang{Manifest: manifest(), Arch: "linux/mipsle", Zuweisung: "z1", Versuche: ein}).Anwenden {
		t.Fatal("nach einem Abbruch muss die Box es noch einmal versuchen (P8)")
	}
	zwei := ParseVersuche([]byte("start 42 z1\nabbruch 42 z1\nstart 42 z1\nabbruch 42 z1\n"))
	e := Entscheide(Eingang{Manifest: manifest(), Arch: "linux/mipsle", Zuweisung: "z1", Versuche: zwei})
	if e.Anwenden || e.Zustand != ZustandRolledBack {
		t.Fatalf("%+v", e)
	}
}
