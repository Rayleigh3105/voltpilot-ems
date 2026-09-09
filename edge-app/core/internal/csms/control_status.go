package csms

import "time"

type ControlStatus struct {
	RejectedRevision  int64            `json:"rejected_revision,omitempty"`
	RejectionReason   string           `json:"rejection_reason,omitempty"`
	SeenTags          []string         `json:"seen_tags"`
	Revision          int64            `json:"revision"`
	Enabled           bool             `json:"enabled"`
	AuthorizationMode string           `json:"authorization_mode"`
	Stations          []ControlStation `json:"stations"`
	Test              *ControlTest     `json:"test,omitempty"`
}

type ControlStation struct {
	ID               string             `json:"id"`
	Connected        bool               `json:"connected"`
	CapabilitiesRead bool               `json:"capabilities_read"`
	ProfilesAccepted bool               `json:"profiles_accepted"`
	Note             string             `json:"note,omitempty"`
	Connectors       []ControlConnector `json:"connectors"`
}

type ControlConnector struct {
	ID            int       `json:"id"`
	Reconciling   bool      `json:"reconciling"`
	PowerKw       *float64  `json:"power_kw,omitempty"`
	PowerAt       time.Time `json:"power_at,omitzero"`
	EnergyAt      time.Time `json:"energy_at,omitzero"`
	SocAt         time.Time `json:"soc_at,omitzero"`
	ReceivedAt    time.Time `json:"received_at,omitzero"`
	FreshPower    bool      `json:"fresh_power"`
	CommandStatus string    `json:"command_status,omitempty"`
	Readback      string    `json:"readback,omitempty"`
	ReadbackAt    time.Time `json:"readback_at,omitzero"`
}

type ControlTest struct {
	ChargePointID string    `json:"charge_point_id"`
	ConnectorID   int       `json:"connector_id"`
	RequestedAt   time.Time `json:"requested_at"`
	Vendor        string    `json:"vendor"`
	Model         string    `json:"model"`
	Firmware      string    `json:"firmware"`
	TransactionID int       `json:"transaction_id"`
	LimitKw       float64   `json:"limit_kw"`
	BaselineKw    *float64  `json:"baseline_kw,omitempty"`
	Limited       bool      `json:"limited"`
	Paused        bool      `json:"paused"`
	Resumed       bool      `json:"resumed"`
	State         string    `json:"state"` // running | confirmed | not_confirmed | cancelled
}

func (s *Server) ControlStatus(enabled bool, now time.Time) ControlStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.observeControlTestLocked(enabled, now)
	out := ControlStatus{Revision: s.control.Revision, Enabled: enabled, AuthorizationMode: s.control.Authorization.Mode,
		Stations: []ControlStation{}}
	out.SeenTags = append([]string{}, s.seenTags...)
	out.RejectedRevision, out.RejectionReason = s.rejectedRevision, s.controlRejection
	if out.AuthorizationMode == "" {
		out.AuthorizationMode = "free"
	}
	if s.controlTest != nil {
		cp := *s.controlTest
		cp.BaselineKw = clonePtr(cp.BaselineKw)
		out.Test = &cp
	}
	list, _ := s.listLocked()
	for _, declared := range list {
		c := s.chargers[declared.ID]
		station := ControlStation{ID: c.ID, Connected: c.Connected, CapabilitiesRead: c.Capabilities.Read,
			ProfilesAccepted: c.Connected && !c.CommissionedAt.IsZero() && !c.CommissionedAt.Before(c.BootedAt) && !c.CommissionedAt.Before(c.ConnectedAt),
			Note:             c.CommissionError, Connectors: []ControlConnector{}}
		for _, con := range c.Connectors {
			station.Connectors = append(station.Connectors, ControlConnector{ID: con.ID,
				Reconciling: con.Session != nil && con.Session.Reconciling,
				PowerKw:     clonePtr(con.PowerKw), PowerAt: con.MeteredAt, EnergyAt: con.EnergyMeasuredAt, SocAt: con.SocMeasuredAt,
				ReceivedAt: con.MeterReceivedAt, FreshPower: c.Connected && con.PowerKw != nil && liveMeterTime(con.MeteredAt, now),
				CommandStatus: con.CommandStatus, Readback: con.Readback, ReadbackAt: con.ReadbackAt})
		}
		out.Stations = append(out.Stations, station)
	}
	return out
}

func (s *Server) startControlTestLocked() {
	t := s.control.Test
	if t == nil {
		if s.controlTest != nil && s.controlTest.State == "running" {
			s.controlTest.State = "cancelled"
		}
		return
	}
	if old := s.controlTest; old != nil && old.RequestedAt.Equal(t.RequestedAt) && old.ChargePointID == t.ChargePointID && old.ConnectorID == t.ConnectorID && old.LimitKw == t.LimitKw {
		return
	}
	result := &ControlTest{ChargePointID: t.ChargePointID, ConnectorID: t.ConnectorID, RequestedAt: t.RequestedAt, LimitKw: t.LimitKw, State: "running"}
	if c := s.chargers[t.ChargePointID]; c != nil {
		result.Vendor, result.Model, result.Firmware = c.Vendor, c.Model, c.Firmware
		if con := c.ConnectorByID(t.ConnectorID); con != nil && con.Session != nil && !con.Session.Reconciling && c.Connected && liveMeterTime(con.MeteredAt, s.opts.Now()) {
			result.BaselineKw, result.TransactionID = clonePtr(con.PowerKw), con.Session.TransactionID
		}
	}
	s.controlTest = result
}

func (s *Server) observeControlTestLocked(enabled bool, now time.Time) {
	t, report := s.control.Test, s.controlTest
	if t == nil || report == nil || report.State != "running" {
		return
	}
	previous := *report
	age := now.Sub(t.RequestedAt)
	if !enabled {
		report.State = "cancelled"
	}
	if c := s.chargers[t.ChargePointID]; c != nil && enabled && c.Connected && c.Firmware != "" && c.Model != "" && c.Firmware == report.Firmware && c.Model == report.Model && c.Vendor == report.Vendor {
		if con := c.ConnectorByID(t.ConnectorID); con != nil && con.Session != nil && !con.Session.Reconciling && con.Session.TransactionID == report.TransactionID &&
			con.PowerKw != nil && liveMeterTime(con.MeteredAt, now) && con.CommandedKw != nil && con.CommandStatus == "Accepted" && con.Readback == ReadbackOK && !con.MeteredAt.Before(con.CommandedChangedAt) {
			step := int(age / (60 * time.Second))
			start := t.RequestedAt.Add(time.Duration(step) * 60 * time.Second)
			if age >= 0 && !con.MeteredAt.Before(start) && !con.CommandedAt.Before(start) && !con.ReadbackAt.Before(start) {
				measured := *con.PowerKw
				if step == 0 && *con.CommandedKw > 0 && *con.CommandedKw <= t.LimitKw && report.BaselineKw != nil && *report.BaselineKw > t.LimitKw+0.2 && measured > 0.2 && measured <= t.LimitKw+0.1 {
					report.Limited = true
				}
				if step == 1 && *con.CommandedKw == 0 && report.Limited && measured <= 0.1 {
					report.Paused = true
				}
				if step == 2 && *con.CommandedKw > 0 && *con.CommandedKw <= t.LimitKw && report.Paused && measured > 0.2 && measured <= t.LimitKw+0.1 {
					report.Resumed = true
				}
			}
		}
	}
	if age >= 180*time.Second && report.State == "running" {
		report.State = "not_confirmed"
		if report.Limited && report.Paused && report.Resumed {
			report.State = "confirmed"
		}
	}
	if previous != *report {
		if err := s.persistLocked(); err != nil {
			s.log.Error("OCPP-Prüfergebnis nicht gespeichert", "err", err)
		}
	}
}
