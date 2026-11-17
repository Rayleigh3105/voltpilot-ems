package agent

// N4 (vp-box-rueckkehr-diagnose, Abschnitt 6): after teardownLink (entered on
// "Gerät entfernt", or before adopting a new identity on a re-claim), the old
// link's MQTT client can still have a reconnect queued in its own backoff
// goroutine. That reconnect used to fire OnConnect(true) unconditionally,
// setting pairing_state = "verbunden" even though nothing is actually
// connected anymore - the box's local page then showed "Verbunden" while
// buffering stayed paused. handleLinkConnect is the extracted body of
// cloud.Options.OnConnect; these are unit tests, not an integration test,
// because the defect is a pure Go-level race between a closure's captured
// link and a.link, independent of any real network timing.

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func TestHandleLinkConnectIgnoresADelayedReconnectOfAReplacedLink(t *testing.T) {
	current := &cloud.Link{}
	stale := &cloud.Link{} // a distinct pointer: the link teardownLink already closed

	a := &Agent{Cfg: configWithTempDataDir(t), State: state.New("edge-rueckkehr", "test")}
	a.link = current
	a.State.Update(func(s *state.Snapshot) {
		s.PairingState = string(enroll.StateRemoved)
		s.CloudConnected = false
		s.BufferPaused = true
	})

	// The delayed reconnect of the OLD link fires - late, against a link
	// nobody uses anymore. It must be a complete no-op.
	a.handleLinkConnect(stale, true)

	got := a.State.Get()
	if got.PairingState != string(enroll.StateRemoved) {
		t.Fatalf("stale reconnect must never leave 'geraet_entfernt': pairing_state = %q", got.PairingState)
	}
	if got.CloudConnected {
		t.Fatal("stale reconnect must never flip cloud_connected to true")
	}
	if !got.BufferPaused {
		t.Fatal("stale reconnect must never resume buffering - only a re-claim does")
	}
}

// Same stale link, now reporting a disconnect: must not touch the state
// either (a resumeFromRemoved-triggered teardown already settled it).
func TestHandleLinkConnectIgnoresADelayedDisconnectOfAReplacedLink(t *testing.T) {
	current := &cloud.Link{}
	stale := &cloud.Link{}

	a := &Agent{Cfg: configWithTempDataDir(t), State: state.New("edge-rueckkehr", "test")}
	a.link = current
	a.State.Update(func(s *state.Snapshot) {
		s.PairingState = string(enroll.StateConnected)
		s.CloudConnected = true
	})

	a.handleLinkConnect(stale, false)

	got := a.State.Get()
	if got.PairingState != string(enroll.StateConnected) || !got.CloudConnected {
		t.Fatalf("stale disconnect must never touch the current link's state: %+v", got)
	}
}

// The identity check must not break the normal case: the CURRENT link
// reconnecting (e.g. after a network blip, not a removal) still sets
// pairing_state = verbunden - this is the behavior
// TestUnclaimRemovalDetectedOnlyWhenSustainedAndReclaimRecovers exercises
// end-to-end; here it is pinned at the unit level the N4 fix touched.
func TestHandleLinkConnectAppliesTheCurrentLinksOwnReconnect(t *testing.T) {
	link := &cloud.Link{}

	a := &Agent{Cfg: configWithTempDataDir(t), State: state.New("edge-rueckkehr", "test")}
	a.link = link
	a.State.Update(func(s *state.Snapshot) {
		s.PairingState = string(enroll.StateCloudDisconnected)
		s.CloudConnected = false
	})

	a.handleLinkConnect(link, true)

	got := a.State.Get()
	if got.PairingState != string(enroll.StateConnected) || !got.CloudConnected {
		t.Fatalf("the current link's own reconnect must still apply: %+v", got)
	}
}

func configWithTempDataDir(t *testing.T) config.Config {
	t.Helper()
	c := config.Defaults()
	c.DataDir = t.TempDir()
	return c
}
