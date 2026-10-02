package ocppsim

// Station201 is the OCPP 2.0.1 twin of Station (MiSpeL MP-36): the same pure
// stack (stack.go) and the same vehicle physics, bound to an ocpp-go 2.0.1
// charging station instead of a 1.6 charge point. It is what makes "a 2.0.1
// station obeys the box's load management" measurable at the simulated meter.
//
// Modelled 2.0.1 rules (OCPP 2.0.1 Edition 3, Part 2): a TxProfile needs the
// transactionId of a transaction running on its EVSE, otherwise Rejected
// (K01); the station drops a transaction's TxProfile when the transaction
// ends; ChargingStationMaxProfile is the 1.6 ChargePointMaxProfile; the Device
// Model answers per component/variable (B05/B06). Dev/rig tool, never part of
// a customer image.

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	ocpp2 "github.com/lorenzodonini/ocpp-go/ocpp2.0.1"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/availability"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/provisioning"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/transactions"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/types"
)

// Station201 is a running simulated OCPP 2.0.1 charging station. One EVSE
// per Config.Connectors, one connector each.
type Station201 struct {
	cfg Config
	cs  ocpp2.ChargingStation

	mu       sync.Mutex
	profiles map[int]Profile // by profile id
	txOf     map[int]string  // profile id -> transactionId (TxProfile)
	vars     map[string]string
	vehicles map[int]Vehicle
	tx       map[int]string // evse -> transactionId
	seq      map[int]int
	energyWh map[int]float64
	lastTick time.Time
	txSeq    int
	stopped  bool
}

// NewStation201 builds a 2.0.1 station (it does not connect yet).
func NewStation201(cfg Config) *Station201 {
	if cfg.Connectors < 1 {
		cfg.Connectors = 1
	}
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Now().UTC() }
	}
	if cfg.MeterInterval <= 0 {
		cfg.MeterInterval = 10 * time.Second
	}
	if cfg.Vendor == "" {
		cfg.Vendor = "RigVendor"
	}
	if cfg.Model == "" {
		cfg.Model = "RigStation201"
	}
	unit := "W"
	if cfg.AmpsOnly {
		unit = "A"
	}
	return &Station201{
		cfg: cfg, profiles: map[int]Profile{}, txOf: map[int]string{},
		vehicles: map[int]Vehicle{}, tx: map[int]string{}, seq: map[int]int{}, energyWh: map[int]float64{},
		// The auth variables start PERMISSIVE on purpose, so a rig proves the
		// box tightens them (the same guard as 1.6) instead of finding them so.
		vars: map[string]string{
			"SmartChargingCtrlr/RateUnit":                unit,
			"SmartChargingCtrlr/ProfileStackLevel":       "8",
			"SmartChargingCtrlr/PeriodsPerSchedule":      "24",
			"SampledDataCtrlr/TxUpdatedInterval":         fmt.Sprint(int(cfg.MeterInterval / time.Second)),
			"SampledDataCtrlr/TxUpdatedMeasurands":       "Energy.Active.Import.Register",
			"SampledDataCtrlr/TxStartedMeasurands":       "",
			"SampledDataCtrlr/TxEndedMeasurands":         "",
			"AuthCtrlr/OfflineTxForUnknownIdEnabled":     "true",
			"AuthCtrlr/LocalPreAuthorize":                "true",
			"AuthCtrlr/LocalAuthorizeOffline":            "true",
			"AuthCtrlr/AuthorizeRemoteStart":             "false",
			"AuthCacheCtrlr/Enabled":                     "true",
			"LocalAuthListCtrlr/Enabled":                 "true",
			"TxCtrlr/StopTxOnInvalidId":                  "false",
			"TxCtrlr/MaxEnergyOnInvalidId":               "1000",
			"SecurityCtrlr/BasicAuthPassword":            "rig-secret-must-never-leave-edge",
			"SmartChargingCtrlr/Enabled":                 "true",
			"SmartChargingCtrlr/LimitChangeSignificance": "0.1",
		},
	}
}

// Connect dials the box with subprotocol ocpp2.0.1, boots and reports every
// EVSE Available.
func (s *Station201) Connect(endpoint string) error {
	cs := ocpp2.NewChargingStation(s.cfg.ID, nil, nil)
	cs.SetProvisioningHandler(s)
	cs.SetSmartChargingHandler(s)
	if err := cs.Start(endpoint); err != nil {
		return err
	}
	s.cs = cs
	if _, err := cs.BootNotification(provisioning.BootReasonPowerUp, s.cfg.Model, s.cfg.Vendor); err != nil {
		return err
	}
	for e := 1; e <= s.cfg.Connectors; e++ {
		if _, err := cs.StatusNotification(types.NewDateTime(s.cfg.Now()), availability.ConnectorStatusAvailable, e, 1); err != nil {
			return err
		}
	}
	return nil
}

// Reconnect dials again after a network loss WITHOUT a reboot: no
// BootNotification, the running transactions and held profiles stay.
func (s *Station201) Reconnect(endpoint string) error {
	cs := ocpp2.NewChargingStation(s.cfg.ID, nil, nil)
	cs.SetProvisioningHandler(s)
	cs.SetSmartChargingHandler(s)
	if err := cs.Start(endpoint); err != nil {
		return err
	}
	s.mu.Lock()
	s.cs, s.stopped = cs, false
	s.mu.Unlock()
	return nil
}

// Stop disconnects.
func (s *Station201) Stop() {
	s.mu.Lock()
	already := s.stopped
	s.stopped = true
	s.mu.Unlock()
	if !already && s.cs != nil {
		s.cs.Stop()
	}
}

func (s *Station201) nextSeq(evse int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.seq[evse]
	s.seq[evse] = n + 1
	return n
}

func (s *Station201) register(evse int, wh float64, ctx types.ReadingContext) []types.MeterValue {
	return []types.MeterValue{{Timestamp: *types.NewDateTime(s.cfg.Now()), SampledValue: []types.SampledValue{{
		Value: wh, Context: ctx, Measurand: types.MeasurandEnergyActiveImportRegister,
		Location: types.LocationOutlet, UnitOfMeasure: &types.UnitOfMeasure{Unit: "Wh"},
	}}}}
}

// Plug starts a transaction on an EVSE with a vehicle behind it: Occupied,
// then TransactionEvent Started with the idToken (the moment the box opens
// its session).
func (s *Station201) Plug(evse int, v Vehicle) error {
	if _, err := s.cs.StatusNotification(types.NewDateTime(s.cfg.Now()), availability.ConnectorStatusOccupied, evse, 1); err != nil {
		return err
	}
	s.mu.Lock()
	s.txSeq++
	txID := fmt.Sprintf("%s-tx-%d", s.cfg.ID, s.txSeq)
	s.vehicles[evse] = v
	s.tx[evse] = txID
	s.seq[evse] = 0
	start := s.energyWh[evse]
	s.mu.Unlock()
	tag := v.IdTag
	if tag == "" {
		tag = defaultIdTag
	}
	_, err := s.cs.TransactionEvent(transactions.TransactionEventStarted, types.NewDateTime(s.cfg.Now()),
		transactions.TriggerReasonAuthorized, s.nextSeq(evse),
		transactions.Transaction{TransactionID: txID, ChargingState: transactions.ChargingStateCharging},
		func(r *transactions.TransactionEventRequest) {
			r.Evse = &types.EVSE{ID: evse}
			r.IDToken = &types.IdToken{IdToken: tag, Type: types.IdTokenTypeISO14443}
			r.MeterValue = s.register(evse, start, types.ReadingContextTransactionBegin)
		})
	return err
}

// Unplug ends the transaction (Ended) and drops its TxProfiles, as a 2.0.1
// station does when a transaction ends.
func (s *Station201) Unplug(evse int) error {
	s.mu.Lock()
	txID := s.tx[evse]
	wh := s.energyWh[evse]
	delete(s.tx, evse)
	delete(s.vehicles, evse)
	for id, p := range s.profiles {
		if p.Purpose == PurposeTx && s.txOf[id] == txID {
			delete(s.profiles, id)
			delete(s.txOf, id)
		}
	}
	s.mu.Unlock()
	if txID == "" {
		return nil
	}
	if _, err := s.cs.TransactionEvent(transactions.TransactionEventEnded, types.NewDateTime(s.cfg.Now()),
		transactions.TriggerReasonEVCommunicationLost, s.nextSeq(evse),
		transactions.Transaction{TransactionID: txID, StoppedReason: transactions.ReasonEVDisconnected},
		func(r *transactions.TransactionEventRequest) {
			r.MeterValue = s.register(evse, wh, types.ReadingContextTransactionEnd)
		}); err != nil {
		return err
	}
	_, err := s.cs.StatusNotification(types.NewDateTime(s.cfg.Now()), availability.ConnectorStatusAvailable, evse, 1)
	return err
}

// DrawKw is what an EVSE draws right now, per the profiles it holds.
func (s *Station201) DrawKw(evse int) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.vehicles[evse]
	if !ok {
		return 0
	}
	return DrawKw(v, s.profileList(), evse, s.cfg.Now())
}

// TotalDrawKw is the whole station's draw.
func (s *Station201) TotalDrawKw() float64 {
	total := 0.0
	for e := 1; e <= s.cfg.Connectors; e++ {
		total += s.DrawKw(e)
	}
	return total
}

// Profiles returns a copy of what the station holds (diagnostics).
func (s *Station201) Profiles() []Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.profileList()
}

func (s *Station201) profileList() []Profile {
	out := make([]Profile, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Var reads one Device Model variable ("Component/Variable").
func (s *Station201) Var(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.vars[key]
}

// PublishMeterValues sends one TransactionEvent Updated per charging EVSE,
// integrating the import register from the draw since the last call.
func (s *Station201) PublishMeterValues() error {
	now := s.cfg.Now()
	s.mu.Lock()
	elapsed := time.Duration(0)
	if !s.lastTick.IsZero() {
		elapsed = now.Sub(s.lastTick)
	}
	s.lastTick = now
	evses := make([]int, 0, len(s.tx))
	for e := range s.tx {
		evses = append(evses, e)
	}
	s.mu.Unlock()
	sort.Ints(evses)
	for _, e := range evses {
		kw := s.DrawKw(e)
		s.mu.Lock()
		s.energyWh[e] += kw * 1000 * elapsed.Hours()
		wh, txID := s.energyWh[e], s.tx[e]
		s.mu.Unlock()
		mv := s.register(e, wh, types.ReadingContextSamplePeriodic)
		mv[0].SampledValue = append(mv[0].SampledValue, types.SampledValue{
			Value: kw * 1000, Context: types.ReadingContextSamplePeriodic, Measurand: types.MeasurandPowerActiveImport,
			Location: types.LocationOutlet, UnitOfMeasure: &types.UnitOfMeasure{Unit: "W"},
		})
		if _, err := s.cs.TransactionEvent(transactions.TransactionEventUpdated, types.NewDateTime(now),
			transactions.TriggerReasonMeterValuePeriodic, s.nextSeq(e),
			transactions.Transaction{TransactionID: txID, ChargingState: transactions.ChargingStateCharging},
			func(r *transactions.TransactionEventRequest) { r.MeterValue = mv }); err != nil {
			return err
		}
	}
	return nil
}

// --- Smart Charging (K01, K08, K09, K10) ---

func (s *Station201) OnSetChargingProfile(r *smartcharging.SetChargingProfileRequest) (*smartcharging.SetChargingProfileResponse, error) {
	rejected := smartcharging.NewSetChargingProfileResponse(smartcharging.ChargingProfileStatusRejected)
	p := r.ChargingProfile
	if p == nil || len(p.ChargingSchedule) == 0 || len(p.ChargingSchedule[0].ChargingSchedulePeriod) == 0 {
		return rejected, nil
	}
	sch := p.ChargingSchedule[0]
	if s.cfg.AmpsOnly != (sch.ChargingRateUnit == types.ChargingRateUnitAmperes) {
		return rejected, nil
	}
	purpose := string(p.ChargingProfilePurpose)
	if p.ChargingProfilePurpose == types.ChargingProfilePurposeChargingStationMaxProfile {
		purpose = PurposeMax
	}
	prof := Profile{ID: p.ID, ConnectorD: r.EvseID, Purpose: purpose, StackLevel: p.StackLevel,
		LimitW: sch.ChargingSchedulePeriod[0].Limit}
	if sch.StartSchedule != nil {
		prof.StartsAt = sch.StartSchedule.Time
	}
	if sch.Duration != nil {
		prof.Duration = time.Duration(*sch.Duration) * time.Second
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if purpose == PurposeTx && (r.EvseID == 0 || p.TransactionID == "" || s.tx[r.EvseID] != p.TransactionID) {
		return rejected, nil
	}
	s.profiles[prof.ID] = prof
	s.txOf[prof.ID] = p.TransactionID
	return smartcharging.NewSetChargingProfileResponse(smartcharging.ChargingProfileStatusAccepted), nil
}

func (s *Station201) OnClearChargingProfile(r *smartcharging.ClearChargingProfileRequest) (*smartcharging.ClearChargingProfileResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	removed := false
	for id, p := range s.profiles {
		match := false
		switch {
		case r.ChargingProfileID != nil:
			match = id == *r.ChargingProfileID
		case r.ChargingProfileCriteria != nil:
			c := r.ChargingProfileCriteria
			purpose := string(c.ChargingProfilePurpose)
			if c.ChargingProfilePurpose == types.ChargingProfilePurposeChargingStationMaxProfile {
				purpose = PurposeMax
			}
			match = (purpose == "" || purpose == p.Purpose) &&
				(c.EvseID == nil || *c.EvseID == p.ConnectorD) &&
				(c.StackLevel == nil || *c.StackLevel == p.StackLevel)
		}
		if match {
			delete(s.profiles, id)
			delete(s.txOf, id)
			removed = true
		}
	}
	if !removed {
		return smartcharging.NewClearChargingProfileResponse(smartcharging.ClearChargingProfileStatusUnknown), nil
	}
	return smartcharging.NewClearChargingProfileResponse(smartcharging.ClearChargingProfileStatusAccepted), nil
}

func (s *Station201) OnGetCompositeSchedule(r *smartcharging.GetCompositeScheduleRequest) (*smartcharging.GetCompositeScheduleResponse, error) {
	s.mu.Lock()
	list := s.profileList()
	s.mu.Unlock()
	resp := smartcharging.NewGetCompositeScheduleResponse(smartcharging.GetCompositeScheduleStatusAccepted, r.EvseID)
	if limitW, ok := Resolve(list, r.EvseID, s.cfg.Now()); ok {
		resp.Schedule = &smartcharging.CompositeSchedule{
			StartDateTime:    types.NewDateTime(s.cfg.Now()),
			ChargingSchedule: types.NewChargingSchedule(0, types.ChargingRateUnitWatts, types.NewChargingSchedulePeriod(0, limitW)),
		}
	}
	return resp, nil
}

// OnGetChargingProfiles answers Accepted and sends the profiles in one
// ReportChargingProfiles per EVSE (tbc on all but the last).
func (s *Station201) OnGetChargingProfiles(r *smartcharging.GetChargingProfilesRequest) (*smartcharging.GetChargingProfilesResponse, error) {
	s.mu.Lock()
	byEVSE := map[int][]types.ChargingProfile{}
	for _, p := range s.profileList() {
		if r.EvseID != nil && *r.EvseID != p.ConnectorD {
			continue
		}
		purpose := types.ChargingProfilePurposeType(p.Purpose)
		if p.Purpose == PurposeMax {
			purpose = types.ChargingProfilePurposeChargingStationMaxProfile
		}
		sch := types.NewChargingSchedule(p.ID, types.ChargingRateUnitWatts, types.NewChargingSchedulePeriod(0, p.LimitW))
		if p.Duration > 0 {
			d := int(p.Duration / time.Second)
			sch.Duration = &d
		}
		cp := types.NewChargingProfile(p.ID, p.StackLevel, purpose, types.ChargingProfileKindAbsolute, []types.ChargingSchedule{*sch})
		cp.TransactionID = s.txOf[p.ID]
		byEVSE[p.ConnectorD] = append(byEVSE[p.ConnectorD], *cp)
	}
	s.mu.Unlock()
	if len(byEVSE) == 0 {
		return smartcharging.NewGetChargingProfilesResponse(smartcharging.GetChargingProfileStatusNoProfiles), nil
	}
	evses := make([]int, 0, len(byEVSE))
	for e := range byEVSE {
		evses = append(evses, e)
	}
	sort.Ints(evses)
	go func() {
		for i, e := range evses {
			tbc := i < len(evses)-1
			_, _ = s.cs.ReportChargingProfiles(r.RequestID, types.ChargingLimitSourceCSO, e, byEVSE[e],
				func(req *smartcharging.ReportChargingProfilesRequest) { req.Tbc = tbc })
		}
	}()
	return smartcharging.NewGetChargingProfilesResponse(smartcharging.GetChargingProfileStatusAccepted), nil
}

// --- Device Model (B05, B06, B07) ---

func (s *Station201) OnGetVariables(r *provisioning.GetVariablesRequest) (*provisioning.GetVariablesResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]provisioning.GetVariableResult, 0, len(r.GetVariableData))
	for _, d := range r.GetVariableData {
		v, ok := s.vars[d.Component.Name+"/"+d.Variable.Name]
		status := provisioning.GetVariableStatusAccepted
		if !ok {
			status = provisioning.GetVariableStatusUnknownVariable
		}
		out = append(out, provisioning.GetVariableResult{AttributeStatus: status, AttributeValue: v, Component: d.Component, Variable: d.Variable})
	}
	return provisioning.NewGetVariablesResponse(out), nil
}

func (s *Station201) OnSetVariables(r *provisioning.SetVariablesRequest) (*provisioning.SetVariablesResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]provisioning.SetVariableResult, 0, len(r.SetVariableData))
	for _, d := range r.SetVariableData {
		k := d.Component.Name + "/" + d.Variable.Name
		status := provisioning.SetVariableStatusAccepted
		if _, ok := s.vars[k]; !ok || strings.HasPrefix(k, "SecurityCtrlr/") {
			status = provisioning.SetVariableStatusUnknownVariable
		} else {
			s.vars[k] = d.AttributeValue
		}
		out = append(out, provisioning.SetVariableResult{AttributeStatus: status, Component: d.Component, Variable: d.Variable})
	}
	return provisioning.NewSetVariablesResponse(out), nil
}

func (s *Station201) OnGetBaseReport(r *provisioning.GetBaseReportRequest) (*provisioning.GetBaseReportResponse, error) {
	s.mu.Lock()
	keys := make([]string, 0, len(s.vars))
	for k := range s.vars {
		if !strings.HasPrefix(k, "SecurityCtrlr/") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	data := make([]provisioning.ReportData, 0, len(keys))
	for _, k := range keys {
		comp, name, _ := strings.Cut(k, "/")
		data = append(data, provisioning.ReportData{Component: types.Component{Name: comp}, Variable: types.Variable{Name: name},
			VariableAttribute: []provisioning.VariableAttribute{{Type: types.AttributeActual, Value: s.vars[k]}}})
	}
	s.mu.Unlock()
	go func() {
		_, _ = s.cs.NotifyReport(r.RequestID, types.NewDateTime(s.cfg.Now()), 0, func(req *provisioning.NotifyReportRequest) {
			req.ReportData = data
		})
	}()
	return provisioning.NewGetBaseReportResponse(types.GenericDeviceModelStatusAccepted), nil
}

func (s *Station201) OnGetReport(*provisioning.GetReportRequest) (*provisioning.GetReportResponse, error) {
	return provisioning.NewGetReportResponse(types.GenericDeviceModelStatusNotSupported), nil
}

func (s *Station201) OnReset(*provisioning.ResetRequest) (*provisioning.ResetResponse, error) {
	return provisioning.NewResetResponse(provisioning.ResetStatusRejected), nil
}

func (s *Station201) OnSetNetworkProfile(*provisioning.SetNetworkProfileRequest) (*provisioning.SetNetworkProfileResponse, error) {
	return provisioning.NewSetNetworkProfileResponse(provisioning.SetNetworkProfileStatusRejected), nil
}
