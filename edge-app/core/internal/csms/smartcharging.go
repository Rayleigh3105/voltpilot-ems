package csms

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// This file is the ORCHESTRATION of the Smart-Charging side: commissioning a
// station (read what it can do, then install the two permanent profiles) and
// pushing the live allocation. It speaks plain types only; the wire mapping is
// in ocppmap.go and every rule it applies is in profiles.go.

// ErrNotConnected is returned when a station is not on the websocket. It is a
// normal, expected state (a station reboots, a cable is unplugged), so it is
// its own error rather than a generic failure.
var ErrNotConnected = errors.New("die Ladesäule ist zurzeit nicht verbunden")

// ErrDisabled is returned when the feature flag is off.
var ErrDisabled = errors.New("die Ladepunkt-Anbindung ist nicht eingeschaltet")

// Commission prepares a station for load management, in the order that makes
// each step safe:
//
//  1. ASK what it can do (GetConfiguration) — never assume;
//  2. ask for meter values at a useful cadence — without measurements the
//     whole thing is blind;
//  3. install the whole-station cap (ChargePointMaxProfile);
//  4. install the SAFE per-connector default (TxDefaultProfile) — the value
//     the station falls back to when we go silent.
//
// ⚠ Steps 3 and 4 are what makes the box's own death harmless, so they run at
// EVERY (re)connect, not once at pairing: a station that rebooted may have
// lost them, and a station whose site limits changed must learn the new ones.
//
// A failure is recorded and RETURNED — it never leaves the station looking
// commissioned. Step 2 is best-effort on purpose: a firmware that refuses the
// meter-interval key still charges, and refusing to command it over that
// would be the tail wagging the dog.
func (s *Server) Commission(ctx context.Context, chargerID string, maxKw, defaultKw float64, meterInterval time.Duration) error {
	t, err := s.liveTransport(chargerID)
	if err != nil {
		s.recordCommission(chargerID, nil, nil, err)
		return err
	}
	now := s.opts.Now()

	values, unknown, err := t.getConfiguration(ctx, chargerID, CapabilityKeys())
	if err != nil {
		e := fmt.Errorf("die Ladesäule hat ihre Fähigkeiten nicht gemeldet: %w", err)
		s.recordCommission(chargerID, nil, nil, e)
		return e
	}
	caps := ParseCapabilities(values, unknown)
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok {
		c.Capabilities = caps
	}
	s.mu.Unlock()

	if ok, why := caps.Usable(); !ok {
		e := errors.New(why)
		s.recordCommission(chargerID, nil, nil, e)
		return e
	}

	// Best-effort: measurements make the loop see, but a firmware that refuses
	// the key still charges.
	if meterInterval > 0 {
		secs := int(meterInterval / time.Second)
		if _, err := t.changeConfiguration(ctx, chargerID, KeyMeterValueSampleInterval, fmt.Sprint(secs)); err != nil {
			s.log.Info("Ladesäule nimmt den Messtakt nicht an — es wird mit ihrer eigenen Kadenz gearbeitet",
				"charge_point_id", chargerID, "err", err)
		}
	}

	if st, err := t.setChargingProfile(ctx, chargerID, 0, MaxProfile(maxKw, now)); err != nil {
		e := fmt.Errorf("die Höchstgrenze konnte nicht hinterlegt werden: %w", err)
		s.recordCommission(chargerID, nil, nil, e)
		return e
	} else if st != "Accepted" {
		e := fmt.Errorf("die Ladesäule hat die Höchstgrenze abgelehnt (%s)", st)
		s.recordCommission(chargerID, nil, nil, e)
		return e
	}

	if st, err := t.setChargingProfile(ctx, chargerID, 0, DefaultProfile(defaultKw, now)); err != nil {
		e := fmt.Errorf("das Sicherheitsprofil konnte nicht hinterlegt werden: %w", err)
		s.recordCommission(chargerID, &maxKw, nil, e)
		return e
	} else if st != "Accepted" {
		e := fmt.Errorf("die Ladesäule hat das Sicherheitsprofil abgelehnt (%s)", st)
		s.recordCommission(chargerID, &maxKw, nil, e)
		return e
	}

	s.recordCommission(chargerID, &maxKw, &defaultKw, nil)
	s.log.Info("Ladesäule eingerichtet",
		"charge_point_id", chargerID, "max_kw", maxKw, "default_kw", defaultKw)
	return nil
}

func (s *Server) recordCommission(chargerID string, maxKw, defaultKw *float64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.chargers[chargerID]
	if !ok {
		return
	}
	c.MaxKw, c.DefaultKw = maxKw, defaultKw
	if err != nil {
		c.CommissionError = err.Error()
		c.CommissionedAt = time.Time{}
		return
	}
	c.CommissionError = ""
	c.CommissionedAt = s.opts.Now()
}

// ApplyLimit pushes the live allocation for ONE connector as a TxProfile with
// a duration — the dead man's switch (profiles.go). limitKw 0 is a legitimate
// command and means "pause": in OCPP that is how you stop a charge without
// ending its transaction.
//
// The station's own answer is recorded verbatim per connector. An
// unanswered request is recorded as a German reason, never as silence:
// silence is not agreement.
func (s *Server) ApplyLimit(ctx context.Context, chargerID string, connectorID, transactionID int, limitKw float64) error {
	t, err := s.liveTransport(chargerID)
	if err != nil {
		s.recordCommand(chargerID, connectorID, nil, err.Error())
		return err
	}
	p := TxProfile(connectorID, transactionID, limitKw, s.opts.Now(), TxProfileDuration)
	status, err := t.setChargingProfile(ctx, chargerID, connectorID, p)
	if err != nil {
		s.recordCommand(chargerID, connectorID, nil, "Keine Antwort der Ladesäule: "+err.Error())
		return err
	}
	kw := p.LimitKw
	s.recordCommand(chargerID, connectorID, &kw, status)
	if status != "Accepted" {
		return fmt.Errorf("die Ladesäule hat die Ladegrenze abgelehnt (%s)", status)
	}
	return nil
}

func (s *Server) recordCommand(chargerID string, connectorID int, kw *float64, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.chargers[chargerID]
	if !ok {
		return
	}
	con := c.connector(connectorID)
	if kw != nil {
		con.CommandedKw = kw
	}
	con.CommandStatus = status
	con.CommandedAt = s.opts.Now()
}

// ReadBack asks the station what it will ACTUALLY do (GetCompositeSchedule)
// and records the verdict against what we commanded. It is the D3 evidence
// ladder's middle rung and the reason the Deye lesson does not repeat here:
// an accepted command is not a command in force.
func (s *Server) ReadBack(ctx context.Context, chargerID string, connectorID int) (CompositeSchedule, string, error) {
	t, err := s.liveTransport(chargerID)
	if err != nil {
		return CompositeSchedule{}, ReadbackUnknown, err
	}
	cs, err := t.getCompositeSchedule(ctx, chargerID, connectorID, TxProfileDuration)
	if err != nil {
		s.recordReadback(chargerID, connectorID, CompositeSchedule{}, ReadbackUnknown,
			"Keine Antwort auf die Rückfrage nach dem Ladeplan.")
		return CompositeSchedule{}, ReadbackUnknown, err
	}
	s.mu.Lock()
	var commanded *float64
	if c, ok := s.chargers[chargerID]; ok {
		if con := c.ConnectorByID(connectorID); con != nil {
			commanded = con.CommandedKw
		}
	}
	s.mu.Unlock()

	verdict, note := ReadbackUnknown, "Es wurde noch keine Ladegrenze vorgegeben."
	if commanded != nil {
		verdict, note = CompareReadback(*commanded, cs, 0.05)
	}
	s.recordReadback(chargerID, connectorID, cs, verdict, note)
	if verdict == ReadbackMismatch {
		s.log.Warn("die Ladesäule meldet eine andere Ladegrenze als vorgegeben",
			"charge_point_id", chargerID, "connector", connectorID, "note", note)
	}
	return cs, verdict, nil
}

func (s *Server) recordReadback(chargerID string, connectorID int, cs CompositeSchedule, verdict, note string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.chargers[chargerID]
	if !ok {
		return
	}
	con := c.connector(connectorID)
	con.Readback = verdict
	con.ReadbackNote = note
	con.ReadbackKw = clonePtr(cs.LimitKw)
	con.ReadbackAt = s.opts.Now()
}

// liveTransport returns the transport when the feature is on, the server is
// running and the station is connected — the three preconditions any command
// has, each with its own error so a surface can say which one is missing.
func (s *Server) liveTransport(chargerID string) (*transport, error) {
	if !s.opts.Enabled {
		return nil, ErrDisabled
	}
	s.mu.Lock()
	t := s.transport
	c, known := s.chargers[chargerID]
	connected := known && c.Connected
	s.mu.Unlock()
	if t == nil {
		return nil, ErrDisabled
	}
	if !known {
		return nil, ErrNotFound
	}
	if !connected {
		return nil, ErrNotConnected
	}
	return t, nil
}

// ClearLimit removes the live TxProfile of one connector.
//
// ⚠ It is called when a SESSION ENDS, and it matters more than the spec
// suggests: OCPP says a station discards a TxProfile with its transaction,
// but a firmware that keeps it would let the NEXT vehicle on that plug
// silently inherit the previous one's limit. Clearing costs one message and
// removes a whole class of "why is this car slow" from the field.
func (s *Server) ClearLimit(ctx context.Context, chargerID string, connectorID int) error {
	t, err := s.liveTransport(chargerID)
	if err != nil {
		return err
	}
	_, err = t.clearChargingProfile(ctx, chargerID, TxProfileID(connectorID))
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok {
		if con := c.ConnectorByID(connectorID); con != nil {
			con.CommandedKw = nil
			con.CommandStatus = ""
			con.Readback = ""
			con.ReadbackKw = nil
			con.ReadbackNote = ""
		}
	}
	s.mu.Unlock()
	return err
}
