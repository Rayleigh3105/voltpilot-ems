package state

import (
	"testing"
	"time"
)

// CloudReached: the link counts, and so does a FRESH portal answer (a box
// waiting for its assignment holds no certificate and so no link). An old
// answer or none at all is no connection - the setup-WLAN watchdog of Edge
// Light keeps "VoltPilot-Einrichtung" open on exactly that.
func TestCloudReached(t *testing.T) {
	jetzt := time.Date(2026, 11, 19, 14, 0, 0, 0, time.UTC)
	faelle := []struct {
		name string
		snap Snapshot
		want bool
	}{
		{"nichts", Snapshot{}, false},
		{"Cloud-Verbindung steht", Snapshot{CloudConnected: true}, true},
		{"Portal hat eben geantwortet", Snapshot{PortalAnsweredAt: jetzt.Add(-time.Minute)}, true},
		{"Antwort knapp im Fenster", Snapshot{PortalAnsweredAt: jetzt.Add(-CloudReachWindow + time.Second)}, true},
		{"Antwort zu alt", Snapshot{PortalAnsweredAt: jetzt.Add(-CloudReachWindow)}, false},
	}
	for _, f := range faelle {
		if got := f.snap.CloudReached(jetzt); got != f.want {
			t.Errorf("%s: CloudReached = %v, want %v", f.name, got, f.want)
		}
	}
}
