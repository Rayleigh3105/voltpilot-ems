package agent

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
)

// orderedStatusLink records statuses in arrival order. The first publish is
// held between "read" and "arrive" until the test releases it.
type orderedStatusLink struct {
	mu       sync.Mutex
	calls    int
	arrived  []string
	entered  chan struct{}
	released chan struct{}
}

func (l *orderedStatusLink) Connected() bool { return true }

func (l *orderedStatusLink) PublishMeasurementConfigStatus(payload []byte) error {
	l.mu.Lock()
	l.calls++
	first := l.calls == 1
	l.mu.Unlock()
	if first {
		close(l.entered)
		<-l.released
	}
	l.mu.Lock()
	l.arrived = append(l.arrived, string(payload))
	l.mu.Unlock()
	return nil
}

// After a box update the stored file still says "applied" for revision N.
// The reconnect republish reads it; before it arrives, the planner's new
// refusal of N is written and sent. The older status must never arrive last.
func TestReconnectRepublishNeverOvertakesNewerMeasurementStatus(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a := &Agent{Cfg: cfg}
	const alt = `{"revision":7,"accepted":["p.a"],"rejected":[]}`
	const neu = `{"revision":7,"accepted":[],"rejected":[{"point_key":"p.a","reason":"unsupported_catalog"}]}`
	path := filepath.Join(cfg.DataDir, "measurement-status.json")
	if err := os.WriteFile(path, []byte(alt), 0o644); err != nil {
		t.Fatal(err)
	}
	link := &orderedStatusLink{entered: make(chan struct{}), released: make(chan struct{})}

	republished := make(chan struct{})
	go func() {
		a.republishMeasurementStatus(link)
		close(republished)
	}()
	<-link.entered // the old status is read and in flight

	stored := make(chan struct{})
	go func() {
		a.storeAndSendMeasurementStatus([]byte(neu), link)
		close(stored)
	}()
	select {
	case <-stored: // without a shared lock the newer status overtakes here
	case <-time.After(200 * time.Millisecond):
	}
	close(link.released)
	<-republished
	<-stored

	link.mu.Lock()
	arrived := append([]string(nil), link.arrived...)
	link.mu.Unlock()
	if len(arrived) != 2 || arrived[len(arrived)-1] != neu {
		t.Fatalf("arrival order = %q, want the newer refusal last", arrived)
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != neu {
		t.Fatalf("stored status = %q, err=%v", got, err)
	}
}
