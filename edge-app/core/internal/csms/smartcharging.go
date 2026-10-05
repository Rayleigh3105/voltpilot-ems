package csms

import (
	"context"
	"errors"
	"fmt"
	"math"
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

// ErrNotOCPP16 refuses a command that only exists in OCPP 1.6 vocabulary (the
// cloud's measurement configuration keys) to a station on the 2.0.1 lane.
// Charging profiles are not such a command: since MiSpeL MP-36 they reach
// both lanes through liveLane.
var ErrNotOCPP16 = errors.New("die Ladesäule ist nicht über OCPP 1.6 verbunden")

// Commission prepares a station for load management, in the order that makes
// each step safe:
//
//  1. ASK what it can do (GetConfiguration) — never assume;
//  2. ask for meter values at a useful cadence — without measurements the
//     whole thing is blind;
//  3. block with a zero cap while reconciling foreign profile stacks;
//  4. install the safe default, then replace the whole-station cap.
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
	s.profileMu.Lock()
	defer s.profileMu.Unlock()
	if math.IsNaN(maxKw) || math.IsInf(maxKw, 0) || maxKw < 0 || math.IsNaN(defaultKw) || math.IsInf(defaultKw, 0) || defaultKw < 0 {
		return errors.New("Ungültige Sicherheitsgrenzen")
	}
	defaultKw = math.Min(defaultKw, maxKw)
	t, err := s.liveLane(chargerID)
	if err != nil {
		s.recordCommission(chargerID, nil, nil, err)
		return err
	}
	now := s.opts.Now()
	// Previous acknowledgements are no evidence for this connection/setup.
	s.recordCommission(chargerID, nil, nil, errors.New("Sicherheitsprofile werden geprüft"))

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
	maximum, err := s.stationProfile(chargerID, 0, MaxProfile(maxKw, now))
	if err != nil {
		s.recordCommission(chargerID, nil, nil, err)
		return err
	}
	fallback, err := s.stationProfile(chargerID, 0, DefaultProfile(defaultKw, now))
	if err != nil {
		s.recordCommission(chargerID, nil, nil, err)
		return err
	}
	maxKw, defaultKw = maximum.LimitKw, fallback.LimitKw
	if err := s.configureAuthorization(ctx, t, chargerID); err != nil {
		s.recordCommission(chargerID, nil, nil, err)
		return err
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

	// Take ownership of the entire profile stack under a temporary zero cap.
	// Old foreign IDs, connector-specific defaults and higher Tx stacks must
	// not survive commissioning and defeat the 120-second fallback later.
	guard := maximum
	guard.LimitKw, guard.LimitA = 0, 0
	guard.StackLevel = caps.MaxStackLevel
	if st, err := t.setChargingProfile(ctx, chargerID, 0, guard); err != nil {
		e := fmt.Errorf("die Höchstgrenze konnte nicht hinterlegt werden: %w", err)
		s.recordCommission(chargerID, nil, nil, e)
		return e
	} else if st != "Accepted" {
		e := fmt.Errorf("die Ladesäule hat die Höchstgrenze abgelehnt (%s)", st)
		s.recordCommission(chargerID, nil, nil, e)
		return e
	}
	for _, purpose := range []string{PurposeTx, PurposeTxDefault} {
		if err := t.clearProfilePurpose(ctx, chargerID, purpose); err != nil {
			s.recordCommission(chargerID, nil, nil, err)
			return err
		}
	}

	if st, err := t.setChargingProfile(ctx, chargerID, 0, fallback); err != nil {
		e := fmt.Errorf("das Sicherheitsprofil konnte nicht hinterlegt werden: %w", err)
		s.recordCommission(chargerID, &maxKw, nil, e)
		return e
	} else if st != "Accepted" {
		e := fmt.Errorf("die Ladesäule hat das Sicherheitsprofil abgelehnt (%s)", st)
		s.recordCommission(chargerID, &maxKw, nil, e)
		return e
	}
	// There are no Tx profiles left and the freshly installed connector-0
	// default bounds every plug while the old Max stack is replaced.
	if err := t.clearProfilePurpose(ctx, chargerID, PurposeMax); err != nil {
		s.recordCommission(chargerID, nil, nil, err)
		return err
	}
	if st, err := t.setChargingProfile(ctx, chargerID, 0, maximum); err != nil || st != "Accepted" {
		e := fmt.Errorf("die Höchstgrenze wurde nicht bestätigt (%s): %v", st, err)
		s.recordCommission(chargerID, nil, &defaultKw, e)
		return e
	}

	// Separate best-effort inventory: a station that refuses the OCPP empty-key
	// form is still safely commissioned from the targeted capability read. The
	// full answer (when supported) is retained by the protocol journal and
	// normalized in the cloud; failure cannot unwind already-installed failsafes.
	inventory, _, err := t.getConfiguration(ctx, chargerID, InventoryKeys())
	if err != nil {
		s.log.Info("Ladesäule lehnt die vollständige Konfigurationsinventur ab — Sicherheitsprofile bleiben aktiv",
			"charge_point_id", chargerID, "err", err)
	}
	s.readPhaseSwitch(ctx, t, chargerID, inventory)

	s.recordCommission(chargerID, &maxKw, &defaultKw, nil)
	s.log.Info("Ladesäule eingerichtet",
		"charge_point_id", chargerID, "max_kw", maxKw, "default_kw", defaultKw)
	return nil
}

// readPhaseSwitch records whether the station can switch to one phase. The
// inventory usually answers it; a station that refused the inventory is asked
// for the one key, but only where the operator allowed switching. Best-effort:
// the safety profiles are already installed, and unknown means "no switching".
// Any protocol lane: the 2.0.1 Device Model has no variable for the key
// (config201), so a 2.0.1/2.1 station reports it unknown and stays on its
// wired phases.
func (s *Server) readPhaseSwitch(ctx context.Context, t profileLane, chargerID string, inventory map[string]string) {
	supported := ParsePhaseSwitch(inventory)
	if supported == nil && s.switchingAllowed(chargerID) {
		values, _, err := t.getConfiguration(ctx, chargerID, []string{KeyPhaseSwitch})
		if err != nil {
			s.log.Info("Ladesäule meldet nicht, ob sie auf eine Phase umschalten kann — sie lädt weiter dreiphasig",
				"charge_point_id", chargerID, "err", err)
		}
		supported = ParsePhaseSwitch(values)
	}
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok {
		c.Capabilities.PhaseSwitch = supported
	}
	s.mu.Unlock()
}

// RefreshPhaseSwitch asks a connected station for KeyPhaseSwitch again: for a
// switch the operator allowed after the station was set up, which changes no
// safety profile and therefore triggers no new commissioning.
func (s *Server) RefreshPhaseSwitch(ctx context.Context, chargerID string) error {
	s.profileMu.Lock()
	defer s.profileMu.Unlock()
	t, err := s.liveTransport(chargerID)
	if err != nil {
		return err
	}
	values, _, err := t.getConfiguration(ctx, chargerID, []string{KeyPhaseSwitch})
	if err != nil {
		return err
	}
	supported := ParsePhaseSwitch(values)
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok {
		c.Capabilities.PhaseSwitch = supported
	}
	s.mu.Unlock()
	return nil
}

// switchingAllowed reports whether the operator allowed one-phase charging on
// any connector of this station.
func (s *Server) switchingAllowed(chargerID string) bool {
	for _, e := range s.ControlPolicy().Electrical {
		if e.ChargePointID == chargerID && e.PhaseSwitching {
			return true
		}
	}
	return false
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
	c.SafetyKey = s.control.SafetyKey()
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
	return s.ApplyLimitPhases(ctx, chargerID, connectorID, transactionID, limitKw, 0)
}

// ApplyLimitPhases is ApplyLimit with an explicit phase count for a connector
// the operator allowed to switch (1 or 3; 0 = its wired phases, as always).
// One phase additionally needs the station's own ConnectorSwitch3to1PhaseSupported.
func (s *Server) ApplyLimitPhases(ctx context.Context, chargerID string, connectorID, transactionID int, limitKw float64, phases int) error {
	s.profileMu.Lock()
	defer s.profileMu.Unlock()
	t, err := s.liveLane(chargerID)
	if err != nil {
		s.recordCommand(chargerID, connectorID, nil, err.Error())
		return err
	}
	s.mu.Lock()
	c := s.chargers[chargerID]
	ready := c != nil && !c.CommissionedAt.IsZero() && !c.CommissionedAt.Before(c.ConnectedAt) && !c.CommissionedAt.Before(c.BootedAt) && c.SafetyKey == s.control.SafetyKey() && s.startReadyLocked(chargerID)
	valid := ready && c.MaxKw != nil && limitKw >= 0 && !math.IsNaN(limitKw) && !math.IsInf(limitKw, 0)
	if valid {
		limitKw = math.Min(limitKw, *c.MaxKw)
	}
	s.mu.Unlock()
	if !valid {
		err := errors.New("Ladegrenze nicht gesendet: Sicherheitsprofile fehlen oder die Grenze ist ungültig")
		s.recordCommand(chargerID, connectorID, nil, err.Error())
		return err
	}
	policy := s.ControlPolicy()
	limitKw = policy.LimitKw(chargerID, connectorID, s.opts.Now(), limitKw)
	tx := TxProfile(connectorID, transactionID, limitKw, s.opts.Now(), policy.ProfileDuration(chargerID, connectorID, s.opts.Now(), TxProfileDuration))
	tx.NumberPhases = phases
	p, err := s.stationProfile(chargerID, connectorID, tx)
	if err != nil {
		s.recordCommand(chargerID, connectorID, nil, err.Error())
		return err
	}
	status, err := t.setChargingProfile(ctx, chargerID, connectorID, p)
	if err != nil {
		s.recordCommand(chargerID, connectorID, nil, "Keine Antwort der Ladesäule: "+err.Error())
		return err
	}
	kw := p.LimitKw
	s.recordCommand(chargerID, connectorID, &kw, status)
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok && status == "Accepted" {
		c.connector(connectorID).CommandedPhases = p.NumberPhases
	}
	s.mu.Unlock()
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
	now := s.opts.Now()
	if kw != nil {
		// ⚠ CommandedChangedAt moves only on a REAL change of the value. The
		// executor re-writes an unchanged limit every tick (that write is what
		// re-arms the dead man's switch), so stamping it here unconditionally
		// would mark every connector "in transit" forever and starve the
		// dynamic budget of measurements (Connector.MeterInTransit).
		if con.CommandedKw == nil || math.Abs(*con.CommandedKw-*kw) > commandedChangeEpsilonKw {
			con.CommandedChangedAt = now
		}
		con.CommandedKw = kw
	}
	con.CommandStatus = status
	con.CommandedAt = now
}

// ReadBack asks the station what it will ACTUALLY do (GetCompositeSchedule)
// and records the verdict against what we commanded. It is the D3 evidence
// ladder's middle rung and the reason the Deye lesson does not repeat here:
// an accepted command is not a command in force.
func (s *Server) ReadBack(ctx context.Context, chargerID string, connectorID int) (CompositeSchedule, string, error) {
	t, err := s.liveLane(chargerID)
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

// liveLane returns the protocol lane of a station when the feature is on,
// the server is running and the station is connected - the three
// preconditions any command has, each with its own error so a surface can say
// which one is missing. A station on OCPP 2.0.1 or 2.1 gets its 2.x lane
// (ocpp201profiles.go, MiSpeL MP-36), every other the 1.6 transport: one
// orchestration, the same limits, the same guards for both.
func (s *Server) liveLane(chargerID string) (profileLane, error) {
	t, version, err := s.liveStation(chargerID)
	if err != nil {
		return nil, err
	}
	if isOCPP2x(version) {
		v2 := t.lane2x(version)
		if v2 == nil {
			return nil, ErrDisabled
		}
		return v2, nil
	}
	return t, nil
}

// liveTransport is liveLane for the paths that speak 1.6 vocabulary verbatim
// (measurement configuration keys from the cloud).
func (s *Server) liveTransport(chargerID string) (*transport, error) {
	t, version, err := s.liveStation(chargerID)
	if err != nil {
		return nil, err
	}
	if isOCPP2x(version) {
		return nil, ErrNotOCPP16
	}
	return t, nil
}

func (s *Server) liveStation(chargerID string) (*transport, string, error) {
	if !s.opts.Enabled {
		return nil, "", ErrDisabled
	}
	s.mu.Lock()
	t := s.transport
	c, known := s.chargers[chargerID]
	connected := known && c.Connected
	version := ""
	if known {
		version = c.OCPPVersion
	}
	s.mu.Unlock()
	if t == nil {
		return nil, "", ErrDisabled
	}
	if !known {
		return nil, "", ErrNotFound
	}
	if !connected {
		return nil, "", ErrNotConnected
	}
	return t, version, nil
}

// ClearLimit removes the live TxProfile of one connector.
//
// ⚠ It is called when a SESSION ENDS, and it matters more than the spec
// suggests: OCPP says a station discards a TxProfile with its transaction,
// but a firmware that keeps it would let the NEXT vehicle on that plug
// silently inherit the previous one's limit. Clearing costs one message and
// removes a whole class of "why is this car slow" from the field.
func (s *Server) ClearLimit(ctx context.Context, chargerID string, connectorID int) error {
	t, err := s.liveLane(chargerID)
	if err != nil {
		return err
	}
	_, err = t.clearChargingProfile(ctx, chargerID, TxProfileID(connectorID))
	s.mu.Lock()
	if c, ok := s.chargers[chargerID]; ok {
		if con := c.ConnectorByID(connectorID); con != nil {
			con.CommandedKw = nil
			con.CommandedPhases = 0
			con.CommandedChangedAt = time.Time{}
			con.CommandStatus = ""
			con.Readback = ""
			con.ReadbackKw = nil
			con.ReadbackNote = ""
		}
	}
	s.mu.Unlock()
	return err
}
