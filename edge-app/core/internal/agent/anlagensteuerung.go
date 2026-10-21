package agent

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// anlagensteuerungFile persists the local choice "this box reads a plant
// controller (SPS) instead of an inverter" (EZ-5, finding :8484). It opens the
// claim gate of the local page (web.deriveOnboarding) and nothing else: no read,
// no write, no plan depends on it. Absent = not chosen, the gate as before.
const anlagensteuerungFile = "onboarding-anlagensteuerung"

// loadAnlagensteuerung reads the choice; an unreadable file counts as "not
// chosen" - in doubt the gate stays where it always was.
func loadAnlagensteuerung(dataDir string) bool {
	raw, err := os.ReadFile(filepath.Join(dataDir, anlagensteuerungFile))
	return err == nil && strings.TrimSpace(string(raw)) == "1"
}

// SetAnlagensteuerung stores the choice and mirrors it into the snapshot
// (web.AnlagensteuerungController). Written atomically, so a power cut never
// leaves half a file.
func (a *Agent) SetAnlagensteuerung(aktiv bool) error {
	path := filepath.Join(a.Cfg.DataDir, anlagensteuerungFile)
	if aktiv {
		if err := os.MkdirAll(a.Cfg.DataDir, 0o755); err != nil {
			return err
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte("1\n"), 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, path); err != nil {
			return err
		}
	} else if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	a.State.Update(func(s *state.Snapshot) { s.Anlagensteuerung = aktiv })
	return nil
}
