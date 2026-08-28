package ocppsim

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/firmware"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
)

// This file binds the pure model to a REAL ocpp-go charge point, so the rig
// and the agent tests talk to a station over an actual OCPP-J websocket.
//
// Dev/rig tool only — never in a customer image, and the one place besides
// internal/csms where the library is used.

// Config describes one simulated station.
type Config struct {
	// ID is the ChargePointId it dials with. It IS its identity.
	ID string
	// Connectors is how many plugs it has (>= 1).
	Connectors int
	// Vendor/Model/Firmware are what it says about itself. They are pure
	// decoration by design: nothing in the product may branch on them, and the
	// rig sets deliberately unremarkable values to keep it that way.
	Vendor, Model, Firmware, Serial string
	// AmpsOnly makes the station report that it takes limits in amperes only —
	// the firmware class the product refuses to guess for.
	AmpsOnly bool
	// RejectFullConfiguration models stations that refuse an empty OCPP key
	// list but accept targeted GetConfiguration calls.
	RejectFullConfiguration bool
	// MeterInterval is how often it reports meter values. 0 = 10 s.
	MeterInterval time.Duration
	// Now is the clock (injectable, so a rig can compress time).
	Now func() time.Time
}

// Station is a running simulated charge point.
type Station struct {
	cfg Config
	cp  ocpp16.ChargePoint

	mu       sync.Mutex
	profiles map[int]Profile // by profile id
	config   map[string]string
	vehicles map[int]Vehicle
	tx       map[int]int // connector -> transaction id
	energyWh map[int]float64
	lastTick time.Time
	stopped  bool
}

// New builds a station (it does not connect yet).
func New(cfg Config) *Station {
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
		cfg.Model = "RigStation"
	}
	unit := "Power"
	if cfg.AmpsOnly {
		unit = "Current"
	}
	return &Station{
		cfg:      cfg,
		profiles: map[int]Profile{},
		vehicles: map[int]Vehicle{},
		tx:       map[int]int{},
		energyWh: map[int]float64{},
		config: map[string]string{
			"ChargingScheduleAllowedChargingRateUnit": unit,
			"ChargeProfileMaxStackLevel":              "8",
			"ChargingScheduleMaxPeriods":              "24",
			"MaxChargingProfilesInstalled":            "10",
			"MeterValueSampleInterval":                fmt.Sprint(int(cfg.MeterInterval / time.Second)),
			"SupportedFeatureProfiles":                "Core,FirmwareManagement,SmartCharging",
			"AuthorizationKey":                        "rig-secret-must-never-leave-edge",
			"RigVendor.Mode":                          "complete",
		},
	}
}

// Connect dials the CSMS at the given BASE endpoint (the library appends the
// station's own id) and announces itself.
func (s *Station) Connect(endpoint string) error {
	cp := ocpp16.NewChargePoint(s.cfg.ID, nil, nil)
	cp.SetCoreHandler(s)
	cp.SetSmartChargingHandler(s)
	if err := cp.Start(endpoint); err != nil {
		return err
	}
	s.cp = cp
	if _, err := cp.BootNotification(s.cfg.Model, s.cfg.Vendor, func(r *core.BootNotificationRequest) {
		r.FirmwareVersion = s.cfg.Firmware
		r.ChargePointSerialNumber = s.cfg.Serial
	}); err != nil {
		return err
	}
	// Per OCPP a station reports every connector's status after boot.
	for c := 1; c <= s.cfg.Connectors; c++ {
		if _, err := cp.StatusNotification(c, core.NoError, core.ChargePointStatusAvailable,
			func(r *core.StatusNotificationRequest) {
				r.Timestamp = types.NewDateTime(s.cfg.Now())
				if c == 1 {
					r.Info = "rig connector healthy"
					r.VendorId = "RigVendor"
					r.VendorErrorCode = "RV-0"
				}
			}); err != nil {
			return err
		}
	}
	// These are station-originated observations, not remote actions. Emitting
	// the terminal idle states makes the local rig exercise both status streams
	// without asking a live station to upload or install anything.
	if _, err := cp.DiagnosticsStatusNotification(firmware.DiagnosticsStatusIdle); err != nil {
		return err
	}
	if _, err := cp.FirmwareStatusNotification(firmware.FirmwareStatusIdle); err != nil {
		return err
	}
	return nil
}

// Stop disconnects.
func (s *Station) Stop() {
	s.mu.Lock()
	already := s.stopped
	s.stopped = true
	s.mu.Unlock()
	if !already && s.cp != nil {
		s.cp.Stop()
	}
}

// Plug starts a transaction on a connector with a vehicle behind it.
func (s *Station) Plug(connector int, v Vehicle) error {
	if _, err := s.cp.StatusNotification(connector, core.NoError, core.ChargePointStatusPreparing); err != nil {
		return err
	}
	s.mu.Lock()
	start := int(s.energyWh[connector])
	s.vehicles[connector] = v
	s.mu.Unlock()
	if _, err := s.cp.Authorize("RIG-TAG"); err != nil {
		return err
	}
	conf, err := s.cp.StartTransaction(connector, "RIG-TAG", start, types.NewDateTime(s.cfg.Now()))
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.tx[connector] = conf.TransactionId
	s.mu.Unlock()
	_, err = s.cp.StatusNotification(connector, core.NoError, core.ChargePointStatusCharging)
	return err
}

// Unplug closes the transaction.
func (s *Station) Unplug(connector int) error {
	s.mu.Lock()
	tx := s.tx[connector]
	meter := int(s.energyWh[connector])
	delete(s.tx, connector)
	delete(s.vehicles, connector)
	s.mu.Unlock()
	if tx == 0 {
		return nil
	}
	if _, err := s.cp.StopTransaction(meter, types.NewDateTime(s.cfg.Now()), tx,
		func(r *core.StopTransactionRequest) {
			r.IdTag = "RIG-TAG"
			r.Reason = core.ReasonEVDisconnected
			r.TransactionData = []types.MeterValue{{
				Timestamp: types.NewDateTime(s.cfg.Now()),
				SampledValue: []types.SampledValue{{
					Value: fmt.Sprint(meter), Context: types.ReadingContextTransactionEnd,
					Format: types.ValueFormatRaw, Measurand: types.MeasurandEnergyActiveImportRegister,
					Location: types.LocationOutlet, Unit: types.UnitOfMeasureWh,
				}},
			}}
		}); err != nil {
		return err
	}
	_, err := s.cp.StatusNotification(connector, core.NoError, core.ChargePointStatusAvailable)
	return err
}

// ReportStatus makes the station announce an arbitrary OCPP 1.6 connector
// status - the rig hook for the state words a plug-and-unplug cannot produce
// (`SuspendedEVSE`, `SuspendedEV`, `Finishing`, `Faulted`, `Reserved`, …).
//
// ⚠ It reports, it does not SIMULATE: the vehicle behind the plug keeps
// drawing whatever the profiles allow. That is deliberate - the rig proves the
// SHAPE of the heartbeat the cloud sees for each status, and a status that
// silently changed the meter would make the two assertions depend on each
// other. Dev/rig tool only.
func (s *Station) ReportStatus(connector int, status core.ChargePointStatus, errorCode core.ChargePointErrorCode) error {
	if connector < 1 || connector > s.cfg.Connectors {
		return fmt.Errorf("connector %d out of range", connector)
	}
	if errorCode == "" {
		errorCode = core.NoError
	}
	_, err := s.cp.StatusNotification(connector, errorCode, status)
	return err
}

// DrawKw is what a connector is drawing right now, per the profiles it holds.
// This is THE measurement the rig asserts on: it obeys the charging profiles,
// so "the budget is held" is provable at the meter and not merely at the ack.
func (s *Station) DrawKw(connector int) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.vehicles[connector]
	if !ok {
		return 0
	}
	return DrawKw(v, s.profileList(), connector, s.cfg.Now())
}

// TotalDrawKw is the whole station's draw.
func (s *Station) TotalDrawKw() float64 {
	total := 0.0
	for c := 1; c <= s.cfg.Connectors; c++ {
		total += s.DrawKw(c)
	}
	return total
}

// Profiles returns a copy of what the station currently holds (diagnostics).
func (s *Station) Profiles() []Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.profileList()
}

func (s *Station) profileList() []Profile {
	out := make([]Profile, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, p)
	}
	return out
}

// PublishMeterValues sends one sample per charging connector, integrating the
// energy register from the draw since the last call.
func (s *Station) PublishMeterValues() error {
	now := s.cfg.Now()
	s.mu.Lock()
	elapsed := time.Duration(0)
	if !s.lastTick.IsZero() {
		elapsed = now.Sub(s.lastTick)
	}
	s.lastTick = now
	connectors := make([]int, 0, len(s.tx))
	for c := range s.tx {
		connectors = append(connectors, c)
	}
	s.mu.Unlock()

	for _, c := range connectors {
		kw := s.DrawKw(c)
		s.mu.Lock()
		s.energyWh[c] += kw * 1000 * elapsed.Hours()
		wh := s.energyWh[c]
		s.mu.Unlock()
		if _, err := s.cp.MeterValues(c, []types.MeterValue{{
			Timestamp: types.NewDateTime(now),
			SampledValue: []types.SampledValue{
				{Value: fmt.Sprintf("%.0f", kw*1000), Context: types.ReadingContextSamplePeriodic,
					Format: types.ValueFormatRaw, Measurand: types.MeasurandPowerActiveImport,
					Phase: types.PhaseL1, Location: types.LocationOutlet, Unit: types.UnitOfMeasureW},
				{Value: fmt.Sprintf("%.0f", wh), Context: types.ReadingContextSamplePeriodic,
					Format: types.ValueFormatRaw, Measurand: types.MeasurandEnergyActiveImportRegister,
					Location: types.LocationOutlet, Unit: types.UnitOfMeasureWh},
				{Value: "230.1", Context: types.ReadingContextSamplePeriodic,
					Format: types.ValueFormatRaw, Measurand: types.MeasurandVoltage,
					Phase: types.PhaseL1N, Location: types.LocationOutlet, Unit: types.UnitOfMeasureV},
				{Value: "229.9", Context: types.ReadingContextSamplePeriodic,
					Format: types.ValueFormatRaw, Measurand: types.MeasurandVoltage,
					Phase: types.PhaseL2N, Location: types.LocationOutlet, Unit: types.UnitOfMeasureV},
			},
		}}); err != nil {
			return err
		}
	}
	return nil
}

// --- OCPP handlers ---

func (s *Station) OnSetChargingProfile(r *smartcharging.SetChargingProfileRequest) (*smartcharging.SetChargingProfileConfirmation, error) {
	if s.cfg.AmpsOnly {
		// A station that only speaks amperes refuses a watt limit. It is the
		// honest behaviour AND the guard that our refusal to guess is real:
		// if the product ever did send one, this would reject it.
		return smartcharging.NewSetChargingProfileConfirmation(smartcharging.ChargingProfileStatusNotSupported), nil
	}
	p := r.ChargingProfile
	prof := Profile{
		ID: p.ChargingProfileId, ConnectorD: r.ConnectorId,
		Purpose: string(p.ChargingProfilePurpose), StackLevel: p.StackLevel,
	}
	if sch := p.ChargingSchedule; sch != nil {
		if len(sch.ChargingSchedulePeriod) > 0 {
			prof.LimitW = sch.ChargingSchedulePeriod[0].Limit
		}
		if sch.StartSchedule != nil {
			prof.StartsAt = sch.StartSchedule.Time
		}
		if sch.Duration != nil {
			prof.Duration = time.Duration(*sch.Duration) * time.Second
		}
	}
	s.mu.Lock()
	s.profiles[prof.ID] = prof
	s.mu.Unlock()
	return smartcharging.NewSetChargingProfileConfirmation(smartcharging.ChargingProfileStatusAccepted), nil
}

func (s *Station) OnClearChargingProfile(r *smartcharging.ClearChargingProfileRequest) (*smartcharging.ClearChargingProfileConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.Id == nil {
		return smartcharging.NewClearChargingProfileConfirmation(smartcharging.ClearChargingProfileStatusUnknown), nil
	}
	if _, ok := s.profiles[*r.Id]; !ok {
		return smartcharging.NewClearChargingProfileConfirmation(smartcharging.ClearChargingProfileStatusUnknown), nil
	}
	delete(s.profiles, *r.Id)
	return smartcharging.NewClearChargingProfileConfirmation(smartcharging.ClearChargingProfileStatusAccepted), nil
}

func (s *Station) OnGetCompositeSchedule(r *smartcharging.GetCompositeScheduleRequest) (*smartcharging.GetCompositeScheduleConfirmation, error) {
	s.mu.Lock()
	list := s.profileList()
	s.mu.Unlock()
	limitW, ok := Resolve(list, r.ConnectorId, s.cfg.Now())
	conf := &smartcharging.GetCompositeScheduleConfirmation{
		Status: smartcharging.GetCompositeScheduleStatusAccepted, ConnectorId: &r.ConnectorId,
	}
	if ok {
		conf.ScheduleStart = types.NewDateTime(s.cfg.Now())
		conf.ChargingSchedule = types.NewChargingSchedule(types.ChargingRateUnitWatts,
			types.NewChargingSchedulePeriod(0, limitW))
	}
	return conf, nil
}

func (s *Station) OnGetConfiguration(r *core.GetConfigurationRequest) (*core.GetConfigurationConfirmation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(r.Key) == 0 && s.cfg.RejectFullConfiguration {
		return nil, errors.New("AuthorizationKey=rig-full-secret " +
			"https://rig.invalid/upload?token=rig-url-token idTag=RIG-DESC-TAG " +
			"client_secret=rig-generic-secret")
	}
	var keys []core.ConfigurationKey
	var unknown []string
	requested := append([]string(nil), r.Key...)
	if len(requested) == 0 {
		for k := range s.config {
			requested = append(requested, k)
		}
		sort.Strings(requested)
	}
	for _, k := range requested {
		if v, ok := s.config[k]; ok {
			val := v
			keys = append(keys, core.ConfigurationKey{Key: k, Readonly: true, Value: &val})
			continue
		}
		unknown = append(unknown, k)
	}
	return &core.GetConfigurationConfirmation{ConfigurationKey: keys, UnknownKey: unknown}, nil
}

func (s *Station) OnChangeConfiguration(r *core.ChangeConfigurationRequest) (*core.ChangeConfigurationConfirmation, error) {
	s.mu.Lock()
	s.config[r.Key] = r.Value
	s.mu.Unlock()
	return core.NewChangeConfigurationConfirmation(core.ConfigurationStatusAccepted), nil
}

func (s *Station) OnChangeAvailability(*core.ChangeAvailabilityRequest) (*core.ChangeAvailabilityConfirmation, error) {
	return core.NewChangeAvailabilityConfirmation(core.AvailabilityStatusAccepted), nil
}
func (s *Station) OnClearCache(*core.ClearCacheRequest) (*core.ClearCacheConfirmation, error) {
	return core.NewClearCacheConfirmation(core.ClearCacheStatusAccepted), nil
}
func (s *Station) OnDataTransfer(*core.DataTransferRequest) (*core.DataTransferConfirmation, error) {
	return core.NewDataTransferConfirmation(core.DataTransferStatusRejected), nil
}
func (s *Station) OnRemoteStartTransaction(*core.RemoteStartTransactionRequest) (*core.RemoteStartTransactionConfirmation, error) {
	return core.NewRemoteStartTransactionConfirmation(types.RemoteStartStopStatusRejected), nil
}
func (s *Station) OnRemoteStopTransaction(*core.RemoteStopTransactionRequest) (*core.RemoteStopTransactionConfirmation, error) {
	return core.NewRemoteStopTransactionConfirmation(types.RemoteStartStopStatusRejected), nil
}
func (s *Station) OnReset(*core.ResetRequest) (*core.ResetConfirmation, error) {
	return core.NewResetConfirmation(core.ResetStatusRejected), nil
}
func (s *Station) OnUnlockConnector(*core.UnlockConnectorRequest) (*core.UnlockConnectorConfirmation, error) {
	return core.NewUnlockConnectorConfirmation(core.UnlockStatusNotSupported), nil
}
