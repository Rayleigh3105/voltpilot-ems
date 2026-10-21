package agent

import (
	"os"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// EZ-5: the local "Anlagensteuerung" choice survives a restart and can be
// taken back; nothing else depends on it.
func TestAnlagensteuerungChoiceIsPersistedAndTakenBack(t *testing.T) {
	dir := t.TempDir()
	a := &Agent{Cfg: config.Config{DataDir: dir}, State: state.New("VP-7K3M-Q2", "test")}
	if loadAnlagensteuerung(dir) {
		t.Fatal("a fresh box has made no choice")
	}
	if err := a.SetAnlagensteuerung(true); err != nil {
		t.Fatal(err)
	}
	if !a.State.Get().Anlagensteuerung || !loadAnlagensteuerung(dir) {
		t.Fatal("the choice must reach the snapshot and the data dir")
	}
	if _, err := os.Stat(filepath.Join(dir, anlagensteuerungFile+".tmp")); !os.IsNotExist(err) {
		t.Fatal("no half-written file may stay behind")
	}
	if err := a.SetAnlagensteuerung(false); err != nil {
		t.Fatal(err)
	}
	if a.State.Get().Anlagensteuerung || loadAnlagensteuerung(dir) {
		t.Fatal("taken back = gone from snapshot and data dir")
	}
	// Taking back twice is no error.
	if err := a.SetAnlagensteuerung(false); err != nil {
		t.Fatal(err)
	}
	// Anything but "1" is no choice - in doubt the gate stays shut.
	if err := os.WriteFile(filepath.Join(dir, anlagensteuerungFile), []byte("ja\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if loadAnlagensteuerung(dir) {
		t.Fatal("an unreadable choice must not open the gate")
	}
}
