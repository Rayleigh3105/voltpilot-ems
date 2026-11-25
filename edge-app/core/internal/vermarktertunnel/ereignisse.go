package vermarktertunnel

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Ereignisliste is the connection's evidence trail in flash (concept §5.4
// "Nachweis"), following the house rule of the Wartungstunnel's list: written
// ONLY when an event happened, a fixed upper bound, and never a key, a
// password or file content - timestamps, states and error classes only.
const ereignisseMax = 250

// Ereignis is one recorded state change of the connection.
type Ereignis struct {
	Zeit time.Time
	Text string // state words and error classes, never secrets
}

type ereignisliste struct {
	mu   sync.Mutex
	pfad string
}

func (e *ereignisliste) schreibe(ev Ereignis) {
	if e.pfad == "" {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	zeile := fmt.Sprintf("%s %s\n", ev.Zeit.UTC().Format(time.RFC3339), ev.Text)
	alt, _ := os.ReadFile(e.pfad)
	zeilen := strings.Split(strings.TrimRight(string(alt), "\n"), "\n")
	if len(zeilen) == 1 && zeilen[0] == "" {
		zeilen = nil
	}
	zeilen = append(zeilen, strings.TrimRight(zeile, "\n"))
	if len(zeilen) > ereignisseMax {
		zeilen = zeilen[len(zeilen)-ereignisseMax:]
	}
	_ = os.WriteFile(e.pfad, []byte(strings.Join(zeilen, "\n")+"\n"), 0o600)
}
