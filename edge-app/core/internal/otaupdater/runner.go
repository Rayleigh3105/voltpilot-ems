package otaupdater

// Die EINE Stelle, an der dieser Prozess die Aussenwelt beruehrt.
//
// Alles, was der Sidecar am System tut, geht durch [Runner]. Das ist kein
// Selbstzweck: dadurch ist die gesamte Orchestrierung - und damit jede
// Sicherheitsregel, die an einer Reihenfolge haengt - ohne einen einzigen
// Container pruefbar, und die Fehlerfaelle (Platte voll, Registry weg,
// haengender Pull, weggeraeumtes Rueckfall-Image) sind als Eingabe
// beschreibbar statt nur im Feld beobachtbar.

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Runner fuehrt EIN Kommando aus und liefert seine Standardausgabe.
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (string, error)
}

// ExecRunner ist die echte Umsetzung (docker / docker compose).
type ExecRunner struct {
	// Timeout begrenzt JEDEN einzelnen Aufruf. Ein haengender `docker pull`
	// ist ein realer Ausfallmodus (Registry antwortet, liefert aber nichts) -
	// ohne Deckel wuerde er den Sidecar still fuer immer beschaeftigen, und
	// genau das ist der Zustand, in dem niemand mehr etwas merkt.
	Timeout time.Duration
	// Env sind zusaetzliche Umgebungsvariablen (z. B. DOCKER_CONFIG fuer die
	// Registry-Zugangsdaten dieses Geraets).
	Env []string
}

// Run fuehrt das Kommando aus.
func (r *ExecRunner) Run(ctx context.Context, name string, args ...string) (string, error) {
	to := r.Timeout
	if to <= 0 {
		to = 10 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	if len(r.Env) > 0 {
		cmd.Env = append(cmd.Environ(), r.Env...)
	}
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return out.String(), fmt.Errorf("%s %s: nach %s ohne Antwort abgebrochen",
				name, strings.Join(args, " "), to)
		}
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		return out.String(), fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, msg)
	}
	return out.String(), nil
}
