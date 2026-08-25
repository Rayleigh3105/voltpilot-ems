package csms

import "time"

// This file holds the STATE TRANSITIONS the OCPP handlers cause. It has no
// ocpp-go import on purpose: the mapping from library types to these plain
// arguments lives in ocppmap.go, and everything that DECIDES lives here, so
// the behaviour is testable without a websocket.

// admitted reports whether id is on the allowlist. This is the ONE pairing
// rule (Konzept §7.4): only a charge point the operator registered may connect.
// An unknown id is refused and loudly logged — never silently accepted, and
// never silently dropped.
func (s *Server) admitted(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.chargers[id]
	return ok
}

// onConnect records that a registered station opened its websocket.
func (s *Server) onConnect(id string) {
	now := s.opts.Now()
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.Connected = true
		c.ConnectedAt = now
		c.LastSeen = now
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.log.Info("Ladesäule verbunden", "charge_point_id", id)
	s.journal.RecordConnection(id, "Connected", now)
	s.notifyChanged()
	s.reconcileMeasurementConfigurationAsync()
}

// onDisconnect records the loss of a station's websocket.
//
// ⚠ The RECORDED session and connector state is deliberately KEPT: a dropped
// socket says nothing about what the station is physically doing, and the
// OCPP dead-man's-switch (the TxProfile's duration, Konzept §3.1) is exactly
// what makes that safe — the station falls back to its own stored default on
// its own. Inventing "everything stopped" here would be a claim nobody
// measured. What DOES change is Connected, which every surface keys on.
func (s *Server) onDisconnect(id string) {
	now := s.opts.Now()
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.Connected = false
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.log.Warn("Ladesäule getrennt — sie fällt auf ihr hinterlegtes Sicherheitsprofil zurück",
		"charge_point_id", id)
	s.journal.RecordConnection(id, "Disconnected", now)
	s.notifyChanged()
}

// touch records "we heard from this station just now" for any message.
func (s *Server) touch(id string, now time.Time) {
	s.mu.Lock()
	if c, ok := s.chargers[id]; ok {
		c.LastSeen = now
		c.Connected = true
	}
	s.mu.Unlock()
}

// bootInfo is what a BootNotification tells us about a station. Every field is
// display-only — see the package doc: no mechanism branches on any of them.
type bootInfo struct {
	Vendor, Model, Firmware, Serial string
}

// onBoot records the station's self-description.
func (s *Server) onBoot(id string, b bootInfo, now time.Time) {
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.Vendor, c.Model = b.Vendor, b.Model
		c.Firmware, c.Serial = b.Firmware, b.Serial
		c.BootedAt = now
		c.LastSeen = now
		c.Connected = true
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.log.Info("Ladesäule gestartet (BootNotification)",
		"charge_point_id", id, "vendor", b.Vendor, "model", b.Model, "firmware", b.Firmware)
	s.notifyChanged()
}

// onStatus records a StatusNotification. connectorID 0 is the STATION, not a
// plug. A status word outside the OCPP vocabulary is DROPPED (the connector
// keeps its last known one) rather than stored — a word we do not understand
// must not become a sentence.
func (s *Server) onStatus(id string, connectorID int, status, errorCode string, now time.Time) {
	if !KnownStatus(status) {
		s.log.Warn("unbekannter Ladepunkt-Status verworfen",
			"charge_point_id", id, "connector", connectorID, "status", status)
		return
	}
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.LastSeen = now
		c.Connected = true
		if connectorID <= 0 {
			c.Status = status
		} else {
			con := c.connector(connectorID)
			con.Status = status
			con.ErrorCode = errorCode
			// A connector that becomes Available/Unavailable/Faulted after a
			// transaction ended without a StopTransaction (a station reboot
			// mid-session) has no live session any more. Only these three
			// terminal states clear it: Preparing/Finishing are part of a
			// normal cycle and must not drop a running transaction.
			if con.Session != nil && (status == StatusAvailable || status == StatusUnavailable || status == StatusFaulted) {
				con.Session = nil
			}
		}
	}
	s.mu.Unlock()
	if ok {
		s.notifyChanged()
	}
}

// onStartTransaction opens a session and returns the transaction id assigned.
// Ids are monotonic and PERSISTED, so a box reboot never re-issues an id a
// station still holds for a running session.
func (s *Server) onStartTransaction(id string, connectorID int, idTag string, meterStartWh int, now time.Time) int {
	s.mu.Lock()
	c, ok := s.chargers[id]
	if !ok {
		s.mu.Unlock()
		return 0
	}
	txID := s.nextTxID
	s.nextTxID++
	con := c.connector(connectorID)
	con.Session = &Session{
		TransactionID: txID,
		IDTag:         idTag,
		StartedAt:     now,
		MeterStartWh:  meterStartWh,
	}
	c.LastSeen = now
	c.Connected = true
	list, next := s.listLocked()
	s.mu.Unlock()

	// Persist the counter. A failure is logged, never fatal: refusing to start
	// a customer's charge because a disk hiccuped would be the wrong trade.
	if err := s.store.Save(list, next); err != nil {
		s.log.Error("Transaktionszähler konnte nicht gespeichert werden", "err", err)
	}
	s.log.Info("Ladevorgang gestartet",
		"charge_point_id", id, "connector", connectorID, "transaction_id", txID)
	s.notifyChanged()
	return txID
}

// onStopTransaction closes the session carrying txID, wherever it sits.
func (s *Server) onStopTransaction(id string, txID int, now time.Time) {
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.LastSeen = now
		c.Connected = true
		for i := range c.Connectors {
			if sess := c.Connectors[i].Session; sess != nil && sess.TransactionID == txID {
				c.Connectors[i].Session = nil
				// The connector's own power reading is now meaningless: no
				// vehicle is drawing. Clear it rather than leave a stale kW
				// standing next to "kein Ladevorgang".
				c.Connectors[i].PowerKw = nil
			}
		}
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	s.log.Info("Ladevorgang beendet", "charge_point_id", id, "transaction_id", txID)
	s.notifyChanged()
}

// onMeterValues folds a parsed reading into a connector.
func (s *Server) onMeterValues(id string, connectorID int, r MeterReading, now time.Time) {
	s.mu.Lock()
	c, ok := s.chargers[id]
	if ok {
		c.LastSeen = now
		c.Connected = true
		if connectorID > 0 && !r.Empty() {
			con := c.connector(connectorID)
			if r.PowerKw != nil {
				con.PowerKw = r.PowerKw
			}
			if r.EnergyKwh != nil {
				con.EnergyKwh = r.EnergyKwh
			}
			if r.SocPct != nil {
				con.SocPct = r.SocPct
			}
			con.MeteredAt = now
		}
	}
	s.mu.Unlock()
	if ok {
		s.notifyChanged()
	}
}

// connector returns the connector with id, creating it on first sight. Caller
// holds s.mu.
func (c *ChargerState) connector(id int) *Connector {
	for i := range c.Connectors {
		if c.Connectors[i].ID == id {
			return &c.Connectors[i]
		}
	}
	c.Connectors = append(c.Connectors, Connector{ID: id})
	sortConnectors(c.Connectors)
	for i := range c.Connectors {
		if c.Connectors[i].ID == id {
			return &c.Connectors[i]
		}
	}
	return &c.Connectors[len(c.Connectors)-1]
}
