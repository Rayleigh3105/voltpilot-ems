package agent

import (
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
)

// noopMeasurementLink satisfies measurementStatusLink without a real cloud
// link; onCloudConnected's measurement-status republish is not what this test
// is about.
type noopMeasurementLink struct{}

func (noopMeasurementLink) Connected() bool                               { return true }
func (noopMeasurementLink) PublishMeasurementConfigStatus(_ []byte) error { return nil }

// vp-box-verbinden-konzept S3: the cloud connect callback must ask for an
// immediate status heartbeat instead of leaving the box's first "online"
// signal to the next statusHeartbeatEvery tick (up to 15 s later) - the setup
// assistant's "Box ist online" follows the connect handshake, not a fixed
// cadence (see report.md §4.3, §7.1).
func TestCloudConnectAsksForAnImmediateHeartbeat(t *testing.T) {
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	a := &Agent{Cfg: cfg}

	kick := a.statusKick()
	a.onCloudConnected(noopMeasurementLink{})

	select {
	case <-kick:
	default:
		t.Fatal("connecting must kick an immediate status heartbeat, not wait for the regular cadence")
	}
}
