package agent

// Integration test for the confirmed-unclaim detection (geraet_entfernt):
//
//   - transient portal outages (5xx) and BRIEF clean-404 phases never trip the
//     removal verdict - the device stays connected with its identity;
//   - a SUSTAINED run of definitive clean 404s (the real api's answer after an
//     unclaim) transitions to geraet_entfernt: cloud link torn down, buffering
//     honestly paused (BufferPaused), local dashboard still alive;
//   - a re-claim exits the state cleanly: the new identity is adopted (same
//     key), the cloud link comes back and buffering resumes.
//
// The window/poll thresholds are configured tight so the test runs in seconds;
// production defaults are 20 min / 4 polls (VP_UNCLAIM_CONFIRM_*).

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/enroll"
)

func TestUnclaimRemovalDetectedOnlyWhenSustainedAndReclaimRecovers(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	const newDevice = "55555555-5555-5555-5555-555555555555"
	p := newPKI(t)

	cloudPort := freePort(t)
	cb := startCloudBroker(t, p, fmt.Sprintf("127.0.0.1:%d", cloudPort))
	defer cb.stop()

	stub := startReclaimEnrollStub(t, p, cloudPort)

	busPort := freePort(t)
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.PortalBaseURL = stub.srv.URL
	cfg.Ref = "VP-ITEST-UNCLAIM-01"
	cfg.LocalMQTTAddr = fmt.Sprintf("127.0.0.1:%d", busPort)
	cfg.HTTPAddr = "127.0.0.1:0"
	cfg.SetpointIntervalSeconds = 1
	cfg.SetpointInterval = time.Second
	// Fast loop + tight confirm bounds so the test runs in seconds. The
	// transient phases below are COUNT-limited (2 clean 404s < 3 required
	// polls), so their "never trips" assertions are deterministic regardless
	// of poll timing.
	cfg.ReconcileInterval = 100 * time.Millisecond
	cfg.UnclaimConfirm = 500 * time.Millisecond
	cfg.UnclaimConfirmPolls = 3

	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := a.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer a.Stop()

	// 1) Enroll + connect under the original identity; telemetry flows.
	waitFor(t, 30*time.Second, "cloud link up", func() bool {
		s := a.State.Get()
		return s.CloudConnected && s.DeviceID == tDevice
	})
	l1 := startLayer1(t, cfg.LocalMQTTAddr)
	l1.publishTelemetry(t, time.Now().UTC(), 12, 8, 50, 100)
	waitFor(t, 15*time.Second, "telemetry under original device_id", func() bool {
		return cb.telemetryCountForDevice(tDevice) >= 1
	})

	// 2) A portal OUTAGE (5xx) longer than the confirm window must never read
	// as "removed" - outages reset the detector, identity + link stay.
	stub.blip("503", 6)
	waitFor(t, 15*time.Second, "outage blip served", stub.blipDone)
	time.Sleep(600 * time.Millisecond) // > UnclaimConfirm, several reconcile polls
	if s := a.State.Get(); !s.CloudConnected || s.PairingState != string(enroll.StateConnected) || s.BufferPaused {
		t.Fatalf("transient 5xx outage must not trip removal: %+v", s)
	}

	// 3) A BRIEF clean-404 phase (2 answers < the 3 required consecutive polls)
	// must not trip either - e.g. a portal restore answering pending briefly.
	stub.blip("404", 2)
	waitFor(t, 15*time.Second, "404 blip served", stub.blipDone)
	time.Sleep(600 * time.Millisecond)
	if s := a.State.Get(); !s.CloudConnected || s.PairingState != string(enroll.StateConnected) || s.BufferPaused {
		t.Fatalf("brief clean-404 phase must not trip removal: %+v", s)
	}

	// 4) The customer REMOVES the device in the portal: sustained clean 404s.
	// Only now, after the confirm window + poll count, the device transitions.
	stub.unclaim()
	waitFor(t, 30*time.Second, "geraet_entfernt after the sustained window", func() bool {
		return a.State.Get().PairingState == string(enroll.StateRemoved)
	})
	if s := a.State.Get(); s.CloudConnected || !s.BufferPaused {
		t.Fatalf("removed state must tear down the cloud link and pause buffering: %+v", s)
	}

	// 5) While removed: the local dashboard stays alive (telemetry is ingested,
	// KPIs update) but the store-and-forward buffer does NOT grow.
	before := a.State.Get()
	for i := 0; i < 3; i++ {
		l1.publishTelemetry(t, time.Now().UTC(), 9, 5, 61, 100)
		time.Sleep(30 * time.Millisecond)
	}
	waitFor(t, 10*time.Second, "local ingest while removed", func() bool {
		s := a.State.Get()
		return s.LastTelemetry.After(before.LastTelemetry) && s.SocPct == 61
	})
	if got := a.State.Get().BufferPending; got != 0 {
		t.Fatalf("buffer must not grow while removed, pending = %d", got)
	}
	// The identity/keys stay on disk (re-claim must reuse the key).
	e := &enroll.Enroller{Dir: filepath.Join(cfg.DataDir, "identity")}
	if !e.Enrolled() {
		t.Fatal("removed state must keep the identity/keys on disk")
	}

	// 6) Re-claim in the portal: the ref maps to a NEW device row; the device
	// exits geraet_entfernt, adopts the new identity and resumes publishing.
	stub.reclaim(newDevice)
	waitFor(t, 30*time.Second, "re-onboarded after re-claim", func() bool {
		s := a.State.Get()
		return s.CloudConnected && s.DeviceID == newDevice &&
			s.PairingState == string(enroll.StateConnected) && !s.BufferPaused
	})
	countBefore := cb.telemetryCountForDevice(newDevice)
	l1.publishTelemetry(t, time.Now().UTC(), 10, 6, 55, 100)
	waitFor(t, 15*time.Second, "telemetry under the re-claimed device_id", func() bool {
		return cb.telemetryCountForDevice(newDevice) > countBefore
	})
}
