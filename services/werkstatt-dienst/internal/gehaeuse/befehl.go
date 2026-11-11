package gehaeuse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Befehl baut mit dem Gehäuse-Programm auf diesem Rechner (ohne Cluster, etwa
// am Rechner des Betreibers mit eingerichtetem Programm und Bambu Studio):
// `<Programm>/bauen.sh --referenz <ref>`. Das Programm schreibt nach
// <Programm>/aus/kennung/<ref>/; von dort kommt die Ausgabe nach ziel.
type Befehl struct {
	Programm string // Ordner des Gehäuse-Programms (mit bauen.sh)
}

func (b Befehl) Baue(ctx context.Context, ref, ziel string, _ func(string)) error {
	log, err := os.Create(filepath.Join(ziel, Ausgabe))
	if err != nil {
		return err
	}
	defer log.Close()
	cmd := exec.CommandContext(ctx, filepath.Join(b.Programm, "bauen.sh"), "--referenz", ref)
	cmd.Dir = b.Programm
	cmd.Stdout, cmd.Stderr = log, log
	// Eigene Prozessgruppe: Bei Abbruch endet auch der Slicer, nicht nur die Shell.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	lauf := cmd.Run()
	quelle := filepath.Join(b.Programm, "aus", "kennung", ref)
	if _, err := os.Stat(quelle); err == nil {
		if err := os.MkdirAll(filepath.Join(ziel, "kennung"), 0o770); err != nil {
			return err
		}
		if err := verschiebe(quelle, filepath.Join(ziel, "kennung", ref)); err != nil {
			return fmt.Errorf("Ausgabe des Programms: %w", err)
		}
	}
	var ende *exec.ExitError
	if errors.As(lauf, &ende) {
		return fmt.Errorf("bauen.sh endete mit %d", ende.ExitCode())
	}
	return lauf
}

// verschiebe legt einen Ordner um; liegt das Ziel auf einem anderen
// Dateisystem, werden seine Dateien (ohne Unterordner) kopiert.
func verschiebe(von, nach string) error {
	if err := os.Rename(von, nach); err == nil {
		return nil
	}
	if err := os.MkdirAll(nach, 0o770); err != nil {
		return err
	}
	eintraege, err := os.ReadDir(von)
	if err != nil {
		return err
	}
	for _, e := range eintraege {
		if !e.Type().IsRegular() {
			continue
		}
		if err := kopiere(filepath.Join(von, e.Name()), filepath.Join(nach, e.Name())); err != nil {
			return err
		}
	}
	return os.RemoveAll(von)
}

func kopiere(von, nach string) error {
	q, err := os.Open(von)
	if err != nil {
		return err
	}
	defer q.Close()
	z, err := os.Create(nach)
	if err != nil {
		return err
	}
	if _, err := io.Copy(z, q); err != nil {
		z.Close()
		return err
	}
	return z.Close()
}
