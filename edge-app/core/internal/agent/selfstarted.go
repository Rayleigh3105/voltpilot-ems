package agent

import "sync"

// selfStarted remembers, from one setpoint tick to the next, whether the
// setpoint in force is a discharge or a charge the box STARTED on its own
// authority - the deficit cover and the unplanned-load discharge on one side,
// the surplus store's idle entry on the other. Those are the directions that
// demand a held Layer-1 readback to begin (idleReadbackHealthy); once one of
// them is running, the same direction rides out a failed readback within
// runningReadbackHealthy's bounds instead of dropping to the plan's value on
// the first flicker.
//
// The two sides are kept apart on purpose: a running discharge is no licence
// to START a charge on a failed readback, and the other way round.
//
// A tick that publishes nothing for the battery (no reading, a bounded test
// owning the inverter) notes "nothing running", so the next start is a start.
// Concurrency-safe like the guards beside it: the setpoint path is reachable
// from the tick loop, the schedule handler and the arbitration nudge.
type selfStarted struct {
	mu                sync.Mutex
	discharge, charge bool
}

func (s *selfStarted) running() (discharge, charge bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.discharge, s.charge
}

func (s *selfStarted) note(discharge, charge bool) {
	s.mu.Lock()
	s.discharge, s.charge = discharge, charge
	s.mu.Unlock()
}
