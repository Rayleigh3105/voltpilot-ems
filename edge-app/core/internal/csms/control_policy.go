package csms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
)

func (s *Server) ControlPolicy() ocppcontrol.Policy {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.control.Clone()
}

func (s *Server) SetControlPolicy(p ocppcontrol.Policy) error {
	if err := p.Validate(); err != nil {
		return err
	}
	s.profileMu.Lock()
	defer s.profileMu.Unlock()
	s.mu.Lock()
	if p.Revision < s.control.Revision {
		s.mu.Unlock()
		return errors.New("Veraltete OCPP-Steuerung")
	}
	if p.Revision == s.control.Revision {
		before, _ := json.Marshal(s.control)
		after, _ := json.Marshal(p)
		s.mu.Unlock()
		if !bytes.Equal(before, after) {
			return errors.New("OCPP-Revision hat einen anderen Inhalt")
		}
		return nil
	}
	if p.PhaseKey() != s.control.PhaseKey() && (len(p.PhaseLimitsA) > 0 || len(s.control.PhaseLimitsA) > 0) {
		// Changing a circuit can increase another connector's reserved share.
		// Never do that while an unreachable or charging station still holds
		// an old fallback. New starts stay gated until EVERY station is ready.
		for _, e := range append(append([]ocppcontrol.Electrical{}, p.Electrical...), s.control.Electrical...) {
			if s.chargers[e.ChargePointID] == nil {
				s.rejectedRevision, s.controlRejection = p.Revision, "Phasengrenzen benötigen alle Säulen an derselben Box."
				s.mu.Unlock()
				s.notifyChanged()
				return errors.New("Phasengrenzen benötigen alle Säulen an derselben Box")
			}
		}
		for _, c := range s.chargers {
			idle := c.Connected && len(c.Connectors) > 0
			for plug := 1; plug <= c.Charger.Connectors; plug++ {
				con := c.ConnectorByID(plug)
				idle = idle && con != nil && con.Session == nil && con.Status == StatusAvailable
			}
			for _, con := range c.Connectors {
				idle = idle && con.Session == nil && con.Status == StatusAvailable
			}
			if !idle {
				s.rejectedRevision, s.controlRejection = p.Revision, "Phasengrenzen erst ändern, wenn alle Säulen verbunden und alle Stecker frei sind."
				reason := s.controlRejection
				s.mu.Unlock()
				s.notifyChanged()
				return errors.New(reason)
			}
		}
	}
	before := s.control
	previousTest := s.controlTest
	if previousTest != nil {
		cp := *previousTest
		previousTest = &cp
	}
	s.control = p.Clone()
	s.startControlTestLocked()
	err := s.persistLocked()
	if err != nil {
		s.control = before
		s.controlTest = previousTest
	} else {
		s.rejectedRevision, s.controlRejection = 0, ""
		if before.SafetyKey() != p.SafetyKey() {
			for _, c := range s.chargers {
				c.CommissionedAt = time.Time{}
				c.CommissionError = "Neue Sicherheitseinstellungen noch nicht von der Säule bestätigt"
			}
		}
	}
	s.mu.Unlock()
	if err == nil {
		s.notifyChanged()
	}
	return err
}

func (s *Server) authorized(idTag string) bool {
	tag := s.tagRefOf(idTag)
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for _, known := range s.seenTags {
		if known == tag {
			found = true
		}
	}
	if tag != "" && !found {
		s.seenTags = append(s.seenTags, tag)
		if len(s.seenTags) > 128 {
			s.seenTags = s.seenTags[1:]
		}
	}
	return s.control.Allows(tag)
}

func (s *Server) startReadyLocked(id string) bool {
	if s.control.Authorization.Mode != "allowlist" && len(s.control.PhaseLimitsA) == 0 {
		return true
	}
	for _, c := range s.chargers {
		if c.ID != id && len(s.control.PhaseLimitsA) == 0 {
			continue
		}
		if !c.Connected || c.CommissionedAt.IsZero() || c.CommissionedAt.Before(c.ConnectedAt) || c.CommissionedAt.Before(c.BootedAt) || c.SafetyKey != s.control.SafetyKey() {
			return false
		}
	}
	return true
}

func (s *Server) startReady(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startReadyLocked(id)
}

// absentAuthorizationKeys are the keys whose ABSENCE already is the safe state
// configureAuthorization wants. A station without an authorization cache or a
// local list has no local id store, so LocalPreAuthorize and
// LocalAuthorizeOffline have nothing to authorize from; one without "offline
// transactions for unknown ids" cannot start one. StopTransactionOnInvalidId
// only chooses HOW a station reacts to a non-Accepted StartTransaction.conf -
// end the transaction or just stop energy delivery (OCPP 1.6, StartTransaction) - and
// MaxEnergyOnInvalidId is an allowance a station without the key does not
// grant. The conclusion holds because commissioning succeeds only when EVERY
// key of the list is safe: cache and local list are off or absent. A station
// that answers NotSupported AND confirms the key as unknown on GetConfiguration
// therefore needs nothing set. Found on a go-e Charger V4 (firmware 59.4, which
// lacks all of the above but the local list), which could otherwise never be
// commissioned - and with phase limits not even start a charge. A key the
// station does know must hold the desired value.
var absentAuthorizationKeys = map[string]bool{
	"AuthorizationCacheEnabled":  true,
	"AllowOfflineTxForUnknownId": true,
	"LocalPreAuthorize":          true,
	"LocalAuthorizeOffline":      true,
	"LocalAuthListEnabled":       true,
	"StopTransactionOnInvalidId": true,
	"MaxEnergyOnInvalidId":       true,
}

// boxCheckedAuthorizationKeys are set where the station lets the box, but their
// state does not matter: AuthorizeRemoteTxRequests=true only makes the station
// ask THIS box again about a RemoteStartTransaction the box already checked
// (card and start readiness, ExecuteCloudCommand) before sending it, and the
// StartTransaction that follows is checked once more. The go-e (firmware 59.4)
// holds it fixed at false.
var boxCheckedAuthorizationKeys = map[string]bool{
	"AuthorizeRemoteTxRequests": true,
}

// Station-side caches must not circumvent the box's offline card decision.
// "Offline" here means no cloud: the local CSMS still authorizes. With no
// CSMS connection the station must not start an unverified new transaction.
func (s *Server) configureAuthorization(ctx context.Context, t *transport, id string) error {
	policy := s.ControlPolicy()
	if policy.Authorization.Mode != "allowlist" && len(policy.PhaseLimitsA) == 0 {
		return nil
	}
	for _, setting := range [][2]string{{"AllowOfflineTxForUnknownId", "false"}, {"AuthorizationCacheEnabled", "false"}, {"LocalPreAuthorize", "false"}, {"LocalAuthorizeOffline", "false"}, {"LocalAuthListEnabled", "false"}, {"StopTransactionOnInvalidId", "true"}, {"MaxEnergyOnInvalidId", "0"}, {"AuthorizeRemoteTxRequests", "true"}} {
		key, desired := setting[0], setting[1]
		status, _ := t.changeConfiguration(ctx, id, key, desired)
		if status != "Accepted" && status != "Rejected" && status != "NotSupported" {
			return fmt.Errorf("Kartenfreigabe nicht abgesichert: %s (%s)", key, status)
		}
		if status == "Accepted" {
			values, _, err := t.getConfiguration(ctx, id, []string{key})
			if err != nil || values[key] != desired {
				return fmt.Errorf("Kartenfreigabe nicht zurückgelesen: %s", key)
			}
			continue
		}
		// Refused: what counts is the state the station is in, not the write.
		values, unknown, err := t.getConfiguration(ctx, id, []string{key})
		value, known := values[key]
		if err == nil && known && value == desired {
			continue // read-only, already safe
		}
		if err == nil && !known && slices.Contains(unknown, key) && absentAuthorizationKeys[key] {
			continue // the feature does not exist on this station: already safe
		}
		if boxCheckedAuthorizationKeys[key] {
			continue
		}
		if known {
			return fmt.Errorf("Kartenfreigabe nicht abgesichert: %s (%s, steht auf %s)", key, status, value)
		}
		return fmt.Errorf("Kartenfreigabe nicht abgesichert: %s (%s)", key, status)
	}
	return nil
}

func (s *Server) stationProfile(id string, connector int, p ChargingProfile) (ChargingProfile, error) {
	s.mu.Lock()
	c, ok := s.chargers[id]
	if !ok {
		s.mu.Unlock()
		return p, ErrNotFound
	}
	caps := c.Capabilities
	count := c.Charger.Connectors
	for _, con := range c.Connectors {
		if con.ID > count {
			count = con.ID
		}
	}
	s.mu.Unlock()
	policy := s.ControlPolicy()
	if len(policy.PhaseLimitsA) > 0 {
		if count < 1 {
			return p, errors.New("Steckerzahl für die Phasengrenzen fehlt")
		}
		for plug := 1; plug <= count; plug++ {
			if _, ok := policy.Wiring(id, plug); !ok {
				return p, errors.New("Bestätigte Phasenzuordnung für jeden Stecker erforderlich")
			}
		}
	}
	if connector > 0 {
		p.LimitKw = policy.PhaseCaps(id, connector, p.LimitKw)
	}
	if caps.WattsAllowed && len(policy.PhaseLimitsA) == 0 {
		return p, nil
	}
	if !caps.AmpsAllowed {
		return p, errors.New("Keine unterstützte Einheit für Ladegrenzen")
	}
	if count < 1 {
		return p, errors.New("Steckerzahl für Ampere-Steuerung fehlt")
	}
	var wiring ocppcontrol.Electrical
	if connector > 0 {
		var ok bool
		wiring, ok = policy.Wiring(id, connector)
		if !ok {
			return p, errors.New("Ampere-Steuerung braucht Spannung und Phasenzuordnung")
		}
	} else {
		// One connector-0 profile covers all plugs. Use the most restrictive
		// current conversion; differently wired plugs may receive less power.
		wiring = ocppcontrol.Electrical{VoltageV: 0, MaxCurrentA: math.MaxFloat64}
		phaseCount := 0
		for plug := 1; plug <= count; plug++ {
			e, ok := policy.Wiring(id, plug)
			if !ok {
				return p, errors.New("Ampere-Steuerung braucht die Verdrahtung aller Stecker")
			}
			wiring.VoltageV = math.Max(wiring.VoltageV, e.VoltageV)
			wiring.MaxCurrentA = math.Min(wiring.MaxCurrentA, e.MaxCurrentA)
			if len(e.Phases) > phaseCount {
				phaseCount = len(e.Phases)
			}
			// Defaults and station maximum must fit even during a core outage.
			p.LimitKw = math.Min(p.LimitKw, policy.PhaseCaps(id, plug, p.LimitKw))
		}
		wiring.Phases = make([]int, phaseCount)
	}
	p.RateUnit, p.NumberPhases = "A", len(wiring.Phases)
	p.LimitA = wiring.AmpereCeiling(p.LimitKw)
	p.LimitKw = p.LimitA * wiring.VoltageV * float64(len(wiring.Phases)) / 1000
	return p, nil
}
