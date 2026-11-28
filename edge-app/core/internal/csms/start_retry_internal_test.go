package csms

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

// Port 0 (Tests, Entwicklung): lässt sich der gewählte Port nicht binden - im
// Volllauf unter Last nahm ihn ein anderer Prozess zwischen Wahl und Binden
// (Flake 28.11.2026, "Port belegt?", die Verbindung wurde abgelehnt) -, startet
// der Server mit einem frischen Port neu. Nachgestellt mit einer Portnummer,
// die sich nie binden lässt.
func TestStartWaehltBeiUnbindbaremPortEinenNeuen(t *testing.T) {
	const unbindbar = 70000
	vorher := waehleFreienPort
	t.Cleanup(func() { waehleFreienPort = vorher })
	erster := true
	waehleFreienPort = func() (int, error) {
		if erster {
			erster = false
			return unbindbar, nil
		}
		return freePort()
	}

	s, err := New(Options{Enabled: true, DataDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("Start mit einem frischen Port: %v", err)
	}
	s.mu.Lock()
	port := s.port
	s.mu.Unlock()
	if port == unbindbar || port == 0 || erster {
		t.Fatalf("port = %d - der zweite Versuch muss einen frischen Port nehmen", port)
	}
}
