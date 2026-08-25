package agent

import (
	"errors"
	"fmt"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

func TestOcppCommandStorageFailureIsTheOnlyUnacknowledgedOutcome(t *testing.T) {
	if acknowledgeOcppCommand(fmt.Errorf("gateway: %w", csms.ErrCommandStorage)) {
		t.Fatal("pre-send storage failure must remain unacknowledged for QoS1 retry")
	}
	if acknowledgeOcppCommand(errors.New("terminal edge rejection")) == false {
		t.Fatal("terminal business rejection must be acknowledged")
	}
}
