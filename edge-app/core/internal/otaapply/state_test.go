package otaapply

// Der Image-Hebel (.env), die Gruppen-Sicherung und der Schalter.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaverify"
)

func TestTheImagePinTouchesOnlyItsOwnKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	original := "# VoltPilot Edge-App\n" +
		"VP_PORTAL_BASE_URL=https://portal.voltpilot.de\n" +
		"VP_NODERED_PASSWORD=geheim\n" +
		"\n" +
		"# ein Kommentar mitten drin\n" +
		"VP_EDGE_CORE_IMAGE=repo/core@sha256:alt\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := SetEnv(path, map[string]string{"VP_EDGE_CORE_IMAGE": "repo/core@sha256:neu"}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(got)
	// Das Passwort des Kunden und die Kommentare stehen ZEICHENGLEICH da.
	for _, keep := range []string{"VP_NODERED_PASSWORD=geheim",
		"# ein Kommentar mitten drin", "VP_PORTAL_BASE_URL=https://portal.voltpilot.de"} {
		if !strings.Contains(s, keep) {
			t.Fatalf("der Updater hat fremden Inhalt verloren: %q fehlt in\n%s", keep, s)
		}
	}
	if strings.Contains(s, "sha256:alt") || !strings.Contains(s, "sha256:neu") {
		t.Fatalf("der Pin wurde nicht ersetzt:\n%s", s)
	}
	// An der Stelle des alten Eintrags, nicht am Ende angehaengt.
	if strings.Count(s, "VP_EDGE_CORE_IMAGE=") != 1 {
		t.Fatalf("der Schluessel steht doppelt:\n%s", s)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("die .env muss 0600 bleiben (%v, %v)", err, fi.Mode().Perm())
	}
}

func TestSetEnvCreatesAndClears(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := SetEnv(path, map[string]string{
		"VP_EDGE_NODERED_IMAGE": "repo/nr@sha256:x",
		"VP_EDGE_CORE_IMAGE":    "repo/core@sha256:y",
	}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "VP_EDGE_CORE_IMAGE=repo/core@sha256:y") {
		t.Fatalf("angelegt? \n%s", raw)
	}
	// Neue Schluessel stabil sortiert: zwei Laeufe derselben Absicht ergeben
	// dieselbe Datei.
	if i, j := strings.Index(string(raw), "CORE"), strings.Index(string(raw), "NODERED"); i > j {
		t.Fatalf("neue Schluessel sind nicht stabil sortiert:\n%s", raw)
	}

	if err := SetEnv(path, map[string]string{"VP_EDGE_CORE_IMAGE": ""}); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if strings.Contains(string(raw), "VP_EDGE_CORE_IMAGE") {
		t.Fatalf("ein leerer Wert loescht den Schluessel:\n%s", raw)
	}

	env, err := ReadEnv(path)
	if err != nil {
		t.Fatal(err)
	}
	if env["VP_EDGE_NODERED_IMAGE"] != "repo/nr@sha256:x" {
		t.Fatalf("gelesen: %v", env)
	}
	if _, err := ReadEnv(filepath.Join(dir, "gibtsnicht")); err != nil {
		t.Fatalf("eine fehlende .env ist kein Fehler: %v", err)
	}
}

func TestOnlyFullDigestRefsAreAccepted(t *testing.T) {
	ok := "git.tecmaxx.de/mamotec/voltpilot-ems/edge-app-core@sha256:" + strings.Repeat("a", 64)
	if !ValidDigestRef(ok) {
		t.Fatalf("gueltige Referenz abgelehnt: %s", ok)
	}
	for _, bad := range []string{
		"repo/core:latest",
		"repo/core@sha256:kurz",
		"repo/core@sha512:" + strings.Repeat("a", 64),
		"repo/core@sha256:" + strings.Repeat("A", 64), // Grossbuchstaben sind kein Digest
		"repo/core@sha256:" + strings.Repeat("a", 63),
		"repo/core@sha256:" + strings.Repeat("a", 64) + " ; rm -rf /",
		"",
	} {
		if ValidDigestRef(bad) {
			t.Fatalf("ungueltige Referenz akzeptiert: %q", bad)
		}
	}
}

// Die Identitaet wird GESICHERT, aber NIE automatisch zurueckgespielt - siehe
// die Begruendung in snapshot.go (der Identitaets-Drift, den ein automatisches
// Zuruecksetzen wiederherstellen wuerde).
func TestTheSnapshotBacksUpIdentityButNeverRestoresIt(t *testing.T) {
	data := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(data, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("device.key", "ALTER-SCHLUESSEL")
	write("identity.json", `{"device_id":"alt"}`)
	write("calibration-certified.json", `{"families":["hybrid_3p"]}`)
	write("inverter.json", `{"brand":"deye"}`)

	if err := Snapshot(data); err != nil {
		t.Fatal(err)
	}

	// Der neue Stand aendert alles - eine legitime Neu-Uebernahme der
	// Identitaet UND eine kaputte Migration der Freigabe.
	write("identity.json", `{"device_id":"neu"}`)
	write("device.key", "NEUER-SCHLUESSEL")
	write("calibration-certified.json", `{}`)

	restored, err := RestoreSnapshot(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range restored {
		if name == "identity.json" || name == "device.key" {
			t.Fatalf("die Identitaet darf NIE automatisch zurueckgesetzt werden (%s)", name)
		}
	}
	if id, _ := os.ReadFile(filepath.Join(data, "identity.json")); string(id) != `{"device_id":"neu"}` {
		t.Fatalf("die neue Identitaet wurde ueberschrieben: %s", id)
	}
	if k, _ := os.ReadFile(filepath.Join(data, "device.key")); string(k) != "NEUER-SCHLUESSEL" {
		t.Fatalf("der Schluessel wurde ueberschrieben: %s", k)
	}
	// Die Betreiber-Freigabe dagegen SCHON.
	cal, _ := os.ReadFile(filepath.Join(data, "calibration-certified.json"))
	if string(cal) != `{"families":["hybrid_3p"]}` {
		t.Fatalf("die Freigabe wurde nicht zurueckgesetzt: %s", cal)
	}
	// Sie ist aber im Snapshot-Verzeichnis von Hand erreichbar.
	if _, err := os.Stat(filepath.Join(SnapshotDir(data), "device.key")); err != nil {
		t.Fatalf("die Identitaet muss gesichert SEIN, auch wenn sie nicht zurueckgespielt wird: %v", err)
	}
	// Nur wirklich Geaendertes wird gemeldet.
	for _, name := range restored {
		if name == "inverter.json" {
			t.Fatal("eine unveraenderte Datei darf nicht als zurueckgesetzt gemeldet werden")
		}
	}
}

func TestTheSelfUpdateLockLeavesTheUpdaterOutOfEveryRelease(t *testing.T) {
	m := manifest()
	if ReleaseNamesUpdater(m) {
		t.Fatal("dieses Manifest nennt den Updater nicht")
	}
	m.Artifacts = append(m.Artifacts, otaverify.Artifact{
		Type: otaverify.ArtifactOCIImage, Name: UpdaterComponent,
		Ref: "repo/updater@sha256:" + strings.Repeat("c", 64)})
	if !ReleaseNamesUpdater(m) {
		t.Fatal("die Nennung muss erkannt werden - die Auslassung ist LAUT, nicht still")
	}
	refs := TargetRefs(m)
	if _, ok := refs[UpdaterComponent]; ok {
		t.Fatal("der Sidecar tauscht sich NIE selbst")
	}
	if _, ok := refs["core"]; !ok {
		t.Fatal("die uebrigen Komponenten bleiben")
	}
}

func TestCurrentIsDiscardedRatherThanGuessed(t *testing.T) {
	data := t.TempDir()
	if ReadCurrent(data) != nil {
		t.Fatal("ohne Datei gibt es keinen Boden")
	}
	if err := WriteJSON(data, FileCurrent, Current{Release: "edge-2026.08.0", ReleaseSeq: 0}); err != nil {
		t.Fatal(err)
	}
	if ReadCurrent(data) != nil {
		t.Fatal("eine unsinnige Sequenznummer wird verworfen, nicht geraten")
	}
	if CurrentSeq(data) != nil {
		t.Fatal("ohne belastbaren Boden gibt es keinen Zeiger")
	}
	if err := WriteJSON(data, FileCurrent, Current{Release: "edge-2026.08.0", ReleaseSeq: 12,
		StateSchema: 3}); err != nil {
		t.Fatal(err)
	}
	c := ReadCurrent(data)
	if c == nil || c.ReleaseSeq != 12 || c.StateSchema != 3 {
		t.Fatalf("Boden nicht gelesen: %+v", c)
	}
}
