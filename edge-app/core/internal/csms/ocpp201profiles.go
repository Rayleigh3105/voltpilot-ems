package csms

// Charging profiles over OCPP 2.0.1 (MiSpeL MP-36). The orchestration in
// smartcharging.go - commissioning with the two permanent profiles, the live
// TxProfile with its 120-second fuse, the readback, the clear at session end -
// is ONE chain for both protocols: it talks to a profileLane, and this file is
// the 2.0.1 implementation of that lane. Use cases refer to OCPP 2.0.1
// Edition 3, Part 2: K01 SetChargingProfile, K10 ClearChargingProfile, K08
// GetCompositeSchedule, K09 GetChargingProfiles, B05/B06 Set/GetVariables,
// B07 GetBaseReport. Charging only - every limit is >= 0 (nonNegative in
// profiles.go); discharge and V2X are MP-37/MP-39. Table: docs/edge-ocpp201.md.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/provisioning"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/types"
	"github.com/lorenzodonini/ocpp-go/ws"
)

// profileLane is what the Smart-Charging orchestration needs from a protocol.
// The 1.6 transport implements it with its unchanged wire calls (ocppmap.go);
// transport201 translates each call into its 2.0.1 use case. Configuration
// keys stay the 1.6 names on purpose: they name "the same guard" for both
// protocols, and config201 maps each one onto its Device Model variable.
type profileLane interface {
	getConfiguration(ctx context.Context, id string, keys []string) (map[string]string, []string, error)
	changeConfiguration(ctx context.Context, id, key, value string) (string, error)
	setChargingProfile(ctx context.Context, id string, connectorID int, p ChargingProfile) (string, error)
	clearChargingProfile(ctx context.Context, id string, profileID int) (string, error)
	clearProfilePurpose(ctx context.Context, id, purpose string) error
	getCompositeSchedule(ctx context.Context, id string, connectorID int, d time.Duration) (CompositeSchedule, error)
}

var (
	_ profileLane = (*transport)(nil)
	_ profileLane = (*transport201)(nil)
)

// config201 maps the 1.6 configuration keys the box reads and writes before
// it commands a station onto the 2.0.1 Device Model (Part 2, Appendix 2
// "Components and Variables"; the 1.6 -> 2.0.1 key migration table).
//
// MaxChargingProfilesInstalled has no entry: 2.0.1 keeps it as the maxLimit
// CHARACTERISTIC of SmartChargingCtrlr.Entries[ChargingProfiles], which
// GetVariables cannot read. It is reported as unknown, never guessed - the
// 1.6 path does not decide anything on it either.
var config201 = map[string]VariableRef201{
	KeyAllowedChargingRateUnit:   {Component: "SmartChargingCtrlr", Variable: "RateUnit"},
	KeyMaxStackLevel:             {Component: "SmartChargingCtrlr", Variable: "ProfileStackLevel"},
	KeyMaxPeriods:                {Component: "SmartChargingCtrlr", Variable: "PeriodsPerSchedule"},
	KeyMeterValueSampleInterval:  samplerVar("TxUpdatedInterval"),
	KeyMeterValuesSampledData:    samplerVar("TxUpdatedMeasurands"),
	"AllowOfflineTxForUnknownId": {Component: "AuthCtrlr", Variable: "OfflineTxForUnknownIdEnabled"},
	"AuthorizationCacheEnabled":  {Component: "AuthCacheCtrlr", Variable: "Enabled"},
	"LocalPreAuthorize":          {Component: "AuthCtrlr", Variable: "LocalPreAuthorize"},
	"LocalAuthorizeOffline":      {Component: "AuthCtrlr", Variable: "LocalAuthorizeOffline"},
	"LocalAuthListEnabled":       {Component: "LocalAuthListCtrlr", Variable: "Enabled"},
	"StopTransactionOnInvalidId": {Component: "TxCtrlr", Variable: "StopTxOnInvalidId"},
	"MaxEnergyOnInvalidId":       {Component: "TxCtrlr", Variable: "MaxEnergyOnInvalidId"},
	"AuthorizeRemoteTxRequests":  {Component: "AuthCtrlr", Variable: "AuthorizeRemoteStart"},
}

// Config201Variable names the Device Model variable a 1.6 configuration key
// is read and written as on the 2.0.1 lane ("" when it has none).
func Config201Variable(key string) string {
	if ref, ok := config201[key]; ok {
		return ref.Component + "/" + ref.Variable
	}
	return ""
}

// purpose201 is the 2.0.1 word for a profile purpose: only the station-wide
// cap was renamed (ChargePointMaxProfile -> ChargingStationMaxProfile).
func purpose201(purpose string) types.ChargingProfilePurposeType {
	if purpose == PurposeMax {
		return types.ChargingProfilePurposeChargingStationMaxProfile
	}
	return types.ChargingProfilePurposeType(purpose)
}

// bool201 writes a Device Model boolean the way 1.6 compares it ("true" /
// "false"); every other value passes unchanged.
func bool201(v string) string {
	switch {
	case strings.EqualFold(v, "true"):
		return "true"
	case strings.EqualFold(v, "false"):
		return "false"
	}
	return v
}

// getConfiguration reads 1.6-named keys through GetVariables (B06). An empty
// key list is 1.6's full inventory; on 2.0.1 that is the base report (B07),
// whose NotifyReport messages land in DeviceModel201.
func (t *transport201) getConfiguration(ctx context.Context, id string, keys []string) (map[string]string, []string, error) {
	if len(keys) == 0 {
		_, status, err := t.baseReport(ctx, id, string(provisioning.ReportTypeFullInventory))
		if err != nil {
			return nil, nil, err
		}
		if status != string(types.GenericDeviceModelStatusAccepted) {
			return nil, nil, fmt.Errorf("die Ladesäule liefert kein vollständiges Device Model (%s)", status)
		}
		return map[string]string{}, nil, nil
	}
	values := map[string]string{}
	var unknown []string
	refs := make([]VariableRef201, 0, len(keys))
	asked := make([]string, 0, len(keys))
	for _, k := range keys {
		ref, ok := config201[k]
		if !ok {
			unknown = append(unknown, k)
			continue
		}
		refs, asked = append(refs, ref), append(asked, k)
	}
	if len(refs) == 0 {
		return values, unknown, nil
	}
	read, err := t.getVariables(ctx, id, refs)
	if err != nil {
		return nil, nil, err
	}
	for i, r := range read {
		switch provisioning.GetVariableStatus(r.Status) {
		case provisioning.GetVariableStatusAccepted:
			values[asked[i]] = bool201(r.Value)
		case provisioning.GetVariableStatusUnknownComponent, provisioning.GetVariableStatusUnknownVariable,
			provisioning.GetVariableStatusNotSupported:
			unknown = append(unknown, asked[i])
		}
		// Rejected or unanswered: neither a value nor "unknown" - missing.
	}
	return values, unknown, nil
}

// changeConfiguration writes one 1.6-named key through SetVariables (B05) and
// answers in 1.6 words, so every caller keeps its "Accepted" test. The
// station's own 2.0.1 status stays in the error text.
func (t *transport201) changeConfiguration(ctx context.Context, id, key, value string) (string, error) {
	ref, ok := config201[key]
	if !ok {
		return "NotSupported", fmt.Errorf("die Einstellung %s hat in OCPP 2.0.1 keine Entsprechung", key)
	}
	res, err := t.setVariables(ctx, id, []VariableSet201{{ref, value}})
	if err != nil {
		return "", err
	}
	status := "Rejected"
	switch provisioning.SetVariableStatus(res[0].Status) {
	case provisioning.SetVariableStatusAccepted:
		status = "Accepted"
	case provisioning.SetVariableStatusRebootRequired:
		status = "RebootRequired"
	case provisioning.SetVariableStatusUnknownComponent, provisioning.SetVariableStatusUnknownVariable,
		provisioning.SetVariableStatusNotSupported:
		status = "NotSupported"
	}
	if status != "Accepted" && status != "RebootRequired" {
		return status, fmt.Errorf("die Ladesäule hat die Einstellung %s abgelehnt (%s)", key, res[0].Status)
	}
	return status, nil
}

// toProfile201 maps our plain profile onto the 2.0.1 wire type. It is the
// ONLY place the 2.0.1 shape is built, like toOcppProfile for 1.6: the limit
// is WATTS (or amperes with phase count), one absolute schedule.
//
// ⚠ A TxProfile carries the station's OWN transactionId (2.0.1 names the
// transaction, a string; the box's number is internal). Without it the
// station could not bind the profile, so it is refused here, never sent loose.
func (t *transport201) toProfile201(id string, evseID int, p ChargingProfile) (*types.ChargingProfile, error) {
	period := types.NewChargingSchedulePeriod(0, p.LimitKw*1000)
	unit := types.ChargingRateUnitWatts
	if p.RateUnit == "A" {
		period.Limit = p.LimitA
		phases := p.NumberPhases
		period.NumberPhases = &phases
		unit = types.ChargingRateUnitAmperes
	}
	schedule := types.NewChargingSchedule(p.ID, unit, period)
	schedule.StartSchedule = types.NewDateTime(p.StartsAt)
	if p.Duration > 0 {
		d := int(p.Duration / time.Second)
		schedule.Duration = &d
	}
	out := types.NewChargingProfile(p.ID, p.StackLevel, purpose201(p.Purpose),
		types.ChargingProfileKindAbsolute, []types.ChargingSchedule{*schedule})
	if p.Purpose == PurposeTx {
		tx, ok := t.srv.stationTransaction201(id, evseID, p.TransactionID)
		if !ok {
			return nil, errors.New("Ladegrenze nicht gesendet: die Ladesäule hat für diese Sitzung keine Transaktionskennung gemeldet")
		}
		out.TransactionID = tx
	}
	return out, nil
}

// stationTransaction201 is the station's transactionId of the box's open
// session txID on an EVSE.
func (s *Server) stationTransaction201(id string, evseID, txID int) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.chargers[id]
	if !ok || txID <= 0 {
		return "", false
	}
	con := c.ConnectorByID(evseID)
	if con == nil || con.Session == nil || con.Session.TransactionID != txID || con.Session.StationTransactionID == "" {
		return "", false
	}
	return con.Session.StationTransactionID, true
}

// setChargingProfile is K01. The EVSE is the box's connector number
// (ocpp201map.go); 0 is the whole station, as 1.6's connector 0.
func (t *transport201) setChargingProfile(ctx context.Context, id string, evseID int, p ChargingProfile) (string, error) {
	profile, err := t.toProfile201(id, evseID, p)
	if err != nil {
		return "", err
	}
	conf, err := await(ctx, func(cb func(*smartcharging.SetChargingProfileResponse, error)) error {
		return t.cs.SetChargingProfile(id, cb, evseID, profile)
	})
	if err != nil {
		return "", err
	}
	if conf == nil {
		return "", errors.New("leere Antwort auf SetChargingProfile")
	}
	return string(conf.Status), nil
}

// clearChargingProfile is K10 by profile id.
func (t *transport201) clearChargingProfile(ctx context.Context, id string, profileID int) (string, error) {
	conf, err := await(ctx, func(cb func(*smartcharging.ClearChargingProfileResponse, error)) error {
		return t.cs.ClearChargingProfile(id, cb, func(r *smartcharging.ClearChargingProfileRequest) {
			r.ChargingProfileID = &profileID
		})
	})
	if err != nil {
		return "", err
	}
	if conf == nil {
		return "", errors.New("leere Antwort auf ClearChargingProfile")
	}
	return string(conf.Status), nil
}

// clearProfilePurpose is K10 by purpose: the whole stack of one purpose, on
// every EVSE. "Unknown" (nothing to clear) is as good as cleared.
func (t *transport201) clearProfilePurpose(ctx context.Context, id, purpose string) error {
	conf, err := await(ctx, func(cb func(*smartcharging.ClearChargingProfileResponse, error)) error {
		return t.cs.ClearChargingProfile(id, cb, func(r *smartcharging.ClearChargingProfileRequest) {
			r.ChargingProfileCriteria = &smartcharging.ClearChargingProfileType{ChargingProfilePurpose: purpose201(purpose)}
		})
	})
	if err != nil {
		return err
	}
	if conf == nil || (conf.Status != smartcharging.ClearChargingProfileStatusAccepted && conf.Status != smartcharging.ClearChargingProfileStatusUnknown) {
		return errors.New("Profilbestand konnte nicht bereinigt werden")
	}
	return nil
}

// compositeSchedule201 is GetCompositeScheduleResponse.schedule in the shape
// of the final OCPP 2.0.1 JSON schema (CompositeScheduleType: evseId,
// duration, scheduleStart, chargingRateUnit, chargingSchedulePeriod). The
// library models an older draft (startDateTime + chargingSchedule) and drops
// these fields without error, so the lane also reads them from the raw frame
// (scheduleTap201) - otherwise every real station's readback would be
// "unknown".
type compositeSchedule201 struct {
	EvseID                 int                            `json:"evseId"`
	Duration               int                            `json:"duration"`
	ScheduleStart          *types.DateTime                `json:"scheduleStart"`
	ChargingRateUnit       string                         `json:"chargingRateUnit"`
	ChargingSchedulePeriod []types.ChargingSchedulePeriod `json:"chargingSchedulePeriod"`
}

// parseComposite201 returns the final-schema schedule of a CALLRESULT frame,
// if it carries one.
func parseComposite201(data []byte) (compositeSchedule201, bool) {
	if !bytes.Contains(data, []byte(`"scheduleStart"`)) {
		return compositeSchedule201{}, false
	}
	var frame []json.RawMessage
	if json.Unmarshal(data, &frame) != nil || len(frame) != 3 || string(frame[0]) != "3" {
		return compositeSchedule201{}, false
	}
	var payload struct {
		Schedule *compositeSchedule201 `json:"schedule"`
	}
	if json.Unmarshal(frame[2], &payload) != nil || payload.Schedule == nil || len(payload.Schedule.ChargingSchedulePeriod) == 0 {
		return compositeSchedule201{}, false
	}
	return *payload.Schedule, true
}

// scheduleTap201 is the 2.0.1 lane as the library sees it, plus one look at
// every incoming frame: a final-schema composite schedule is kept for the
// readback waiting for it. OCPP-J allows one open CALL per connection, and
// the frame is seen before the library hands the answer to that readback.
type scheduleTap201 struct {
	*protocolLane
	t *transport201
}

func (l *scheduleTap201) SetMessageHandler(handler ws.MessageHandler) {
	l.protocolLane.SetMessageHandler(func(c ws.Channel, data []byte) error {
		if cs, ok := parseComposite201(data); ok {
			l.t.mu.Lock()
			l.t.composite[c.ID()] = cs
			l.t.mu.Unlock()
		}
		return handler(c, data)
	})
}

// getCompositeSchedule is K08 - the readback, the same rung of the evidence
// ladder as for 1.6 (smartcharging.go ReadBack).
func (t *transport201) getCompositeSchedule(ctx context.Context, id string, evseID int, d time.Duration) (CompositeSchedule, error) {
	p, prepErr := t.srv.stationProfile(id, evseID, ChargingProfile{})
	if prepErr != nil {
		return CompositeSchedule{}, prepErr
	}
	unit := types.ChargingRateUnitWatts
	if p.RateUnit == "A" {
		unit = types.ChargingRateUnitAmperes
	}
	t.mu.Lock()
	delete(t.composite, id)
	t.mu.Unlock()
	conf, err := await(ctx, func(cb func(*smartcharging.GetCompositeScheduleResponse, error)) error {
		return t.cs.GetCompositeSchedule(id, cb, int(d/time.Second), evseID,
			func(r *smartcharging.GetCompositeScheduleRequest) { r.ChargingRateUnit = unit })
	})
	t.mu.Lock()
	raw, fromRaw := t.composite[id]
	delete(t.composite, id)
	t.mu.Unlock()
	if err != nil {
		return CompositeSchedule{}, err
	}
	if conf == nil {
		return CompositeSchedule{}, errors.New("leere Antwort auf GetCompositeSchedule")
	}
	out := CompositeSchedule{
		Accepted:  conf.Status == smartcharging.GetCompositeScheduleStatusAccepted,
		Connector: evseID,
	}
	// The FIRST period is what applies now (as for 1.6).
	var first *types.ChargingSchedulePeriod
	var rateUnit string
	switch {
	case fromRaw:
		if raw.ScheduleStart != nil {
			out.StartsAt = raw.ScheduleStart.Time
		}
		first, rateUnit = &raw.ChargingSchedulePeriod[0], raw.ChargingRateUnit
	case conf.Schedule != nil && conf.Schedule.ChargingSchedule != nil && len(conf.Schedule.ChargingSchedule.ChargingSchedulePeriod) > 0:
		if conf.Schedule.StartDateTime != nil {
			out.StartsAt = conf.Schedule.StartDateTime.Time
		}
		sch := conf.Schedule.ChargingSchedule
		first, rateUnit = &sch.ChargingSchedulePeriod[0], string(sch.ChargingRateUnit)
	}
	if out.Accepted && first != nil {
		out.LimitKw = t.srv.compositeLimitKw(id, evseID, rateUnit, first.Limit, first.NumberPhases)
	}
	return out, nil
}

// --- station -> box: the Smart-Charging messages of a 2.0.1 station ---

// InstalledProfile201 is one profile a 2.0.1 station reported holding (K09).
type InstalledProfile201 struct {
	EVSE          int     `json:"evse"`
	ID            int     `json:"id"`
	StackLevel    int     `json:"stack_level"`
	Purpose       string  `json:"purpose"`
	Source        string  `json:"source"`
	TransactionID string  `json:"transaction_id,omitempty"`
	RateUnit      string  `json:"rate_unit"`
	Limit         float64 `json:"limit"`
	DurationS     int     `json:"duration_s,omitempty"`
}

type profileReport201 struct {
	profiles []InstalledProfile201
	done     chan struct{}
}

type smartHandler201 struct{ t *transport201 }

func (h *smartHandler201) OnReportChargingProfiles(id string, req *smartcharging.ReportChargingProfilesRequest) (*smartcharging.ReportChargingProfilesResponse, error) {
	t := h.t
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.reports[pendingReportKey(id, req.RequestID)]
	if r == nil {
		return smartcharging.NewReportChargingProfilesResponse(), nil
	}
	for _, p := range req.ChargingProfile {
		ip := InstalledProfile201{EVSE: req.EvseID, ID: p.ID, StackLevel: p.StackLevel,
			Purpose: string(p.ChargingProfilePurpose), Source: string(req.ChargingLimitSource),
			TransactionID: p.TransactionID}
		if len(p.ChargingSchedule) > 0 {
			sch := p.ChargingSchedule[0]
			ip.RateUnit = string(sch.ChargingRateUnit)
			if len(sch.ChargingSchedulePeriod) > 0 {
				ip.Limit = sch.ChargingSchedulePeriod[0].Limit
			}
			if sch.Duration != nil {
				ip.DurationS = *sch.Duration
			}
		}
		r.profiles = append(r.profiles, ip)
	}
	if !req.Tbc {
		close(r.done)
		delete(t.reports, pendingReportKey(id, req.RequestID))
	}
	return smartcharging.NewReportChargingProfilesResponse(), nil
}

// A limit set by someone else (energy management, grid operator) is the
// station's business and bounds the composite schedule the readback sees; the
// box records it in the log only.
func (h *smartHandler201) OnNotifyChargingLimit(id string, req *smartcharging.NotifyChargingLimitRequest) (*smartcharging.NotifyChargingLimitResponse, error) {
	h.t.srv.log.Info("OCPP-2.0.1-Ladesäule meldet eine fremde Ladegrenze",
		"charge_point_id", id, "source", req.ChargingLimit.ChargingLimitSource)
	return smartcharging.NewNotifyChargingLimitResponse(), nil
}

func (h *smartHandler201) OnClearedChargingLimit(id string, req *smartcharging.ClearedChargingLimitRequest) (*smartcharging.ClearedChargingLimitResponse, error) {
	h.t.srv.log.Info("OCPP-2.0.1-Ladesäule meldet: fremde Ladegrenze aufgehoben",
		"charge_point_id", id, "source", req.ChargingLimitSource)
	return smartcharging.NewClearedChargingLimitResponse(), nil
}

// ISO 15118 charging needs: the box makes no 15118 schedule before MP-37, and
// says so (Rejected) instead of promising one; the station's profiles still
// bound the vehicle.
func (h *smartHandler201) OnNotifyEVChargingNeeds(id string, _ *smartcharging.NotifyEVChargingNeedsRequest) (*smartcharging.NotifyEVChargingNeedsResponse, error) {
	return smartcharging.NewNotifyEVChargingNeedsResponse(smartcharging.EVChargingNeedsStatusRejected), nil
}

func (h *smartHandler201) OnNotifyEVChargingSchedule(id string, _ *smartcharging.NotifyEVChargingScheduleRequest) (*smartcharging.NotifyEVChargingScheduleResponse, error) {
	return smartcharging.NewNotifyEVChargingScheduleResponse(types.GenericStatusAccepted), nil
}

func pendingReportKey(id string, requestID int) string { return fmt.Sprintf("%s\x00%d", id, requestID) }

// ChargingProfiles201 asks a 2.0.1 station which charging profiles it holds
// (K09 GetChargingProfiles; the list arrives as ReportChargingProfiles, tbc =
// more follow). evseID nil = every EVSE. Diagnostics and proof; the readback
// that judges a command stays GetCompositeSchedule, as for 1.6.
func (s *Server) ChargingProfiles201(ctx context.Context, id string, evseID *int) ([]InstalledProfile201, error) {
	t, err := s.live201(id)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	t.nextRequestID++
	requestID := t.nextRequestID
	r := &profileReport201{done: make(chan struct{})}
	t.reports[pendingReportKey(id, requestID)] = r
	t.mu.Unlock()
	forget := func() {
		t.mu.Lock()
		delete(t.reports, pendingReportKey(id, requestID))
		t.mu.Unlock()
	}
	conf, err := await(ctx, func(cb func(*smartcharging.GetChargingProfilesResponse, error)) error {
		return t.cs.GetChargingProfiles(id, cb, smartcharging.ChargingProfileCriterion{},
			func(req *smartcharging.GetChargingProfilesRequest) {
				req.RequestID = requestID
				req.EvseID = evseID
			})
	})
	if err != nil {
		forget()
		return nil, err
	}
	if conf == nil {
		forget()
		return nil, errors.New("leere Antwort auf GetChargingProfiles")
	}
	if conf.Status == smartcharging.GetChargingProfileStatusNoProfiles {
		forget()
		return []InstalledProfile201{}, nil
	}
	select {
	case <-r.done:
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]InstalledProfile201(nil), r.profiles...), nil
}
