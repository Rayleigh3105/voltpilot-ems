package csms

// The OCPP 2.0.1 lane of the box's central system (MiSpeL MP-35). A station
// that offers the websocket subprotocol "ocpp2.0.1" lands here; everything it
// reports is translated onto the SAME internal calls the 1.6 lane uses
// (onBoot, onStatus, openSession, onMeterSample, onStopTransaction), so the
// snapshot, the agent's allocation and the measurement runtime see one kind of
// charge point, whichever protocol it speaks. Use-case numbers refer to OCPP
// 2.0.1 Edition 3, Part 2 (Specification). The table of what maps to what is
// docs/edge-ocpp201.md.
//
// Not here (MiSpeL Bauplan § 8): charging profiles (MP-36), V2X/ISO 15118-20
// (MP-37), discharge commands with protection limits (MP-39). A 2.0.1 station
// is measured, never steered, until those land - liveTransport refuses every
// 1.6 command to it with ErrOCPP201Profiles.

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	ocpp2 "github.com/lorenzodonini/ocpp-go/ocpp2.0.1"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/authorization"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/availability"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/meter"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/provisioning"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/transactions"
	"github.com/lorenzodonini/ocpp-go/ocpp2.0.1/types"
)

// OCPPVersion201 is ChargerState.OCPPVersion of a station on the 2.0.1 lane.
const OCPPVersion201 = "2.0.1"

// ErrNotOCPP201 refuses a Device Model call to a station that is not
// connected over OCPP 2.0.1 (1.6 has no Device Model).
var ErrNotOCPP201 = errors.New("die Ladesäule ist nicht über OCPP 2.0.1 verbunden")

// The sampled-data configuration the box asks a 2.0.1 station for (B05 Set
// Variables on the SampledDataCtrlr, Part 2 Appendix 2). Both registers ride
// every transaction event: Energy.Active.Import.Register is Z2V, ...Export...
// Z2E at the charge point (MiSpeL A1 S. 32, Abschn. 4.2.1; contract
// mispel-ladepunkt-bidirektional.md § 4) - never one signed number.
const (
	sampledDataCtrlr        = "SampledDataCtrlr"
	measurandsRegisters201  = "Energy.Active.Import.Register,Energy.Active.Export.Register"
	measurandsUpdated201    = "Energy.Active.Import.Register,Energy.Active.Export.Register,Power.Active.Import,Power.Active.Export,SoC"
	measurandsUpdatedMin201 = "Energy.Active.Import.Register,Power.Active.Import"
)

// Metering201 is the READ-BACK sampled-data configuration of one station:
// what the station says it now has, not what the box asked for.
type Metering201 struct {
	At     time.Time         `json:"at"`
	Status string            `json:"status"` // confirmed | partial | failed
	Values map[string]string `json:"values,omitempty"`
	Error  string            `json:"error,omitempty"`
}

// VariableRef201 names one Device Model variable (component + variable,
// optionally at an EVSE).
type VariableRef201 struct {
	Component string `json:"component"`
	EVSE      int    `json:"evse,omitempty"`
	Variable  string `json:"variable"`
}

// VariableValue201 is one GetVariables result; Value is only meaningful when
// Status is "Accepted".
type VariableValue201 struct {
	VariableRef201
	Status string `json:"status"`
	Value  string `json:"value,omitempty"`
}

// VariableSet201 is one SetVariables entry.
type VariableSet201 struct {
	VariableRef201
	Value string `json:"value"`
}

type evse201 struct {
	// chargingState of the open transaction ("" = none open).
	chargingState transactions.ChargingState
	// connector is the last ConnectorStatus the station reported (G01).
	connector availability.ConnectorStatus
	// ended: a transaction ended on this EVSE since it was last Available.
	ended bool
}

// pendingTx201 is a 2.0.1 transaction that started before it was authorized
// (E02 cable plugin first): it becomes a session with the event that carries
// the idToken - the moment 1.6 would have sent StartTransaction.
type pendingTx201 struct {
	evse       int
	startedAt  time.Time
	meterWh    int
	meterKnown bool
}

type transport201 struct {
	srv      *Server
	cs       ocpp2.CSMS
	lane     *protocolLane
	stopping func() bool
	done     chan struct{}

	mu            sync.Mutex
	evses         map[string]map[int]*evse201
	pending       map[string]pendingTx201
	needsMetering map[string]bool
	deviceModel   map[string]map[string]string
	metering      map[string]Metering201
	nextRequestID int
}

func newTransport201(s *Server, lane *protocolLane, stopping func() bool) *transport201 {
	cs := ocpp2.NewCSMS(nil, lane)
	t := &transport201{srv: s, cs: cs, lane: lane, stopping: stopping, done: make(chan struct{}),
		evses: map[string]map[int]*evse201{}, pending: map[string]pendingTx201{},
		needsMetering: map[string]bool{}, deviceModel: map[string]map[string]string{},
		metering: map[string]Metering201{}}
	// The same admission as 1.6 (ocppmap.go): only allowlisted ids, nothing
	// while the box shuts down.
	cs.SetNewChargingStationValidationHandler(func(id string, _ *http.Request) bool {
		if stopping() {
			return false
		}
		if s.admitted(id) {
			return true
		}
		s.log.Warn("unbekannte Ladesäule abgewiesen — die Kennung steht nicht in der Freigabeliste",
			"charge_point_id", id, "ocpp", OCPPVersion201)
		return false
	})
	cs.SetNewChargingStationHandler(func(cp ocpp2.ChargingStationConnection) { t.onConnect(cp.ID()) })
	cs.SetChargingStationDisconnectedHandler(func(cp ocpp2.ChargingStationConnection) { t.onDisconnect(cp.ID()) })
	h := &handler201{t: t}
	cs.SetProvisioningHandler(h)
	cs.SetAvailabilityHandler(h)
	cs.SetAuthorizationHandler(h)
	cs.SetTransactionsHandler(h)
	cs.SetMeterHandler(h)
	return t
}

// start wires the lane and returns once its handlers are registered; the
// lane's Start then blocks until stop.
func (t *transport201) start(port int, pattern string) {
	go func() {
		defer close(t.done)
		t.cs.Start(port, pattern)
	}()
	<-t.lane.started
}

func (t *transport201) stop() {
	t.cs.Stop()
	select {
	case <-t.done:
	case <-time.After(3 * time.Second):
	}
}

func (t *transport201) onConnect(id string) {
	t.srv.mu.Lock()
	if c, ok := t.srv.chargers[id]; ok {
		c.OCPPVersion = OCPPVersion201
	}
	t.srv.mu.Unlock()
	t.srv.onConnect(id)
}

func (t *transport201) onDisconnect(id string) {
	t.srv.mu.Lock()
	if c, ok := t.srv.chargers[id]; ok {
		c.OCPPVersion = ""
	}
	t.srv.mu.Unlock()
	t.mu.Lock()
	delete(t.needsMetering, id)
	t.mu.Unlock()
	t.srv.onDisconnect(id)
}

func (t *transport201) evse(id string, evseID int) *evse201 {
	m := t.evses[id]
	if m == nil {
		m = map[int]*evse201{}
		t.evses[id] = m
	}
	e := m[evseID]
	if e == nil {
		e = &evse201{}
		m[evseID] = e
	}
	return e
}

// status16 maps a 2.0.1 connector status onto the 1.6 status vocabulary the
// whole box keys on (KnownStatus). 2.0.1 splits what 1.6 said in one word
// into ConnectorStatus (G01) and the transaction's chargingState (E01-E07);
// "Occupied" is resolved through the latter. Table: docs/edge-ocpp201.md.
//
// Inoperative words win; an open transaction's chargingState wins over an
// operative connector word (a station need not send Occupied before its
// TransactionEvent); Occupied without a transaction is Finishing after one
// ended there, Preparing otherwise.
func status16(e *evse201) string {
	switch e.connector {
	case availability.ConnectorStatusUnavailable:
		return StatusUnavailable
	case availability.ConnectorStatusFaulted:
		return StatusFaulted
	}
	switch e.chargingState {
	case transactions.ChargingStateCharging:
		return StatusCharging
	case transactions.ChargingStateSuspendedEV:
		return StatusSuspendedEV
	case transactions.ChargingStateSuspendedEVSE:
		return StatusSuspendedEVSE
	case transactions.ChargingStateEVConnected, transactions.ChargingStateIdle:
		return StatusPreparing
	}
	switch e.connector {
	case availability.ConnectorStatusAvailable:
		return StatusAvailable
	case availability.ConnectorStatusReserved:
		return StatusReserved
	}
	if e.ended {
		return StatusFinishing
	}
	return StatusPreparing
}

func pendingKey(id, stationTx string) string { return id + "\x00" + stationTx }

// sessionOf201 finds the open session a station's transactionId belongs to.
func (s *Server) sessionOf201(id, stationTx string) (connectorID, txID int, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, known := s.chargers[id]
	if !known || stationTx == "" {
		return 0, 0, false
	}
	for _, con := range c.Connectors {
		if con.Session != nil && con.Session.StationTransactionID == stationTx {
			return con.ID, con.Session.TransactionID, true
		}
	}
	return 0, 0, false
}

// mapSamples201 converts 2.0.1 sampled values to the plain shape the 1.6
// parser and the measurement runtime already take. 2.0.1 sends a number with
// a power-of-ten multiplier (UnitOfMeasureType); the value is scaled here so
// "unit" keeps meaning what it means for 1.6. Signed meter values (OCMF) are
// MP-38 and pass through unread.
func mapSamples201(in []types.SampledValue) []SampledReading {
	out := make([]SampledReading, 0, len(in))
	for _, sv := range in {
		v := sv.Value
		unit := ""
		if sv.UnitOfMeasure != nil {
			unit = sv.UnitOfMeasure.Unit
			if sv.UnitOfMeasure.Multiplier != nil {
				v *= math.Pow10(*sv.UnitOfMeasure.Multiplier)
			}
		}
		out = append(out, SampledReading{
			Value:     strconv.FormatFloat(v, 'f', -1, 64),
			Measurand: string(sv.Measurand),
			Unit:      unit,
			Phase:     string(sv.Phase),
			Context:   string(sv.Context),
			Location:  string(sv.Location),
		})
	}
	return out
}

// registerWh reads the overall Energy.Active.Import.Register of a meter value
// batch in Wh - the 2.0.1 counterpart of 1.6 StartTransaction.meterStart.
func registerWh(mvs []types.MeterValue) (int, bool) {
	for _, mv := range mvs {
		r := ParseMeterValues(mapSamples201(mv.SampledValue))
		if r.EnergyKwh != nil {
			return int(math.Round(*r.EnergyKwh * 1000)), true
		}
	}
	return 0, false
}

func (t *transport201) foldMeterValues(id string, evseID int, mvs []types.MeterValue, txID *int, now time.Time) {
	for _, mv := range mvs {
		samples := mapSamples201(mv.SampledValue)
		t.srv.emitLiveSampledValues(samples, mv.Timestamp.Time, now)
		r := ParseMeterValues(samples)
		if r.Dropped > 0 {
			t.srv.log.Debug("Messwerte einer Ladesäule teilweise verworfen",
				"charge_point_id", id, "evse", evseID, "dropped", r.Dropped)
		}
		t.srv.onMeterSample(id, evseID, r, mv.Timestamp.Time, now, txID)
	}
}

// configureMeteringOnce runs the sampled-data configuration once per boot,
// triggered by the first message AFTER the BootNotification answer (B01: the
// CSMS sends nothing before the station has its Accepted).
func (t *transport201) configureMeteringOnce(id string) {
	t.mu.Lock()
	needed := t.needsMetering[id]
	delete(t.needsMetering, id)
	t.mu.Unlock()
	if !needed {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		m := t.configureMetering(ctx, id)
		t.mu.Lock()
		t.metering[id] = m
		t.mu.Unlock()
		if m.Status == "confirmed" {
			t.srv.log.Info("OCPP-2.0.1-Messwerte eingerichtet", "charge_point_id", id)
		} else {
			t.srv.log.Warn("OCPP-2.0.1-Messwerte nicht vollständig eingerichtet",
				"charge_point_id", id, "status", m.Status, "err", m.Error)
		}
	}()
}

func samplerVar(name string) VariableRef201 {
	return VariableRef201{Component: sampledDataCtrlr, Variable: name}
}

// configureMetering sets the SampledDataCtrlr variables and READS THEM BACK
// (B06): the result is what the station holds, not what was asked. A station
// that refuses the full measurand list (e.g. no SoC, no export register on a
// unidirectional box) gets the import-only list; a missing Z2E then shows up
// as an absent register downstream, never as a 0.
func (t *transport201) configureMetering(ctx context.Context, id string) Metering201 {
	now := t.srv.opts.Now()
	interval := strconv.Itoa(int(DefaultMeterInterval / time.Second))
	sets := []VariableSet201{
		{samplerVar("TxUpdatedMeasurands"), measurandsUpdated201},
		{samplerVar("TxStartedMeasurands"), measurandsRegisters201},
		{samplerVar("TxEndedMeasurands"), measurandsRegisters201},
		{samplerVar("TxUpdatedInterval"), interval},
	}
	results, err := t.setVariables(ctx, id, sets)
	if err != nil {
		return Metering201{At: now, Status: "failed", Error: err.Error()}
	}
	var retry []VariableSet201
	for i, r := range results {
		if r.Status != string(provisioning.SetVariableStatusAccepted) &&
			r.Status != string(provisioning.SetVariableStatusRebootRequired) &&
			strings.HasSuffix(sets[i].Variable, "Measurands") {
			fallback := sets[i]
			fallback.Value = measurandsUpdatedMin201
			if fallback.Variable != "TxUpdatedMeasurands" {
				fallback.Value = "Energy.Active.Import.Register"
			}
			retry = append(retry, fallback)
		}
	}
	if len(retry) > 0 {
		if _, err := t.setVariables(ctx, id, retry); err != nil {
			return Metering201{At: now, Status: "failed", Error: err.Error()}
		}
	}
	refs := make([]VariableRef201, 0, len(sets))
	for _, s := range sets {
		refs = append(refs, s.VariableRef201)
	}
	read, err := t.getVariables(ctx, id, refs)
	if err != nil {
		return Metering201{At: now, Status: "failed", Error: err.Error()}
	}
	m := Metering201{At: now, Status: "confirmed", Values: map[string]string{}}
	for i, r := range read {
		if r.Status != string(provisioning.GetVariableStatusAccepted) {
			m.Status = "partial"
			continue
		}
		m.Values[r.Variable] = r.Value
		if r.Value != sets[i].Value {
			m.Status = "partial"
		}
	}
	return m
}

func toComponent(r VariableRef201) types.Component {
	c := types.Component{Name: r.Component}
	if r.EVSE > 0 {
		c.EVSE = &types.EVSE{ID: r.EVSE}
	}
	return c
}

func (t *transport201) getVariables(ctx context.Context, id string, refs []VariableRef201) ([]VariableValue201, error) {
	data := make([]provisioning.GetVariableData, 0, len(refs))
	for _, r := range refs {
		data = append(data, provisioning.GetVariableData{Component: toComponent(r), Variable: types.Variable{Name: r.Variable}})
	}
	conf, err := await(ctx, func(cb func(*provisioning.GetVariablesResponse, error)) error {
		return t.cs.GetVariables(id, cb, data)
	})
	if err != nil {
		return nil, err
	}
	if conf == nil {
		return nil, errors.New("leere Antwort auf GetVariables")
	}
	// Results are matched by component/variable, not by position: the
	// station may answer in any order.
	out := make([]VariableValue201, 0, len(refs))
	for _, r := range refs {
		v := VariableValue201{VariableRef201: r, Status: "Missing"}
		for _, res := range conf.GetVariableResult {
			if strings.EqualFold(res.Component.Name, r.Component) && strings.EqualFold(res.Variable.Name, r.Variable) {
				v.Status, v.Value = string(res.AttributeStatus), res.AttributeValue
				break
			}
		}
		out = append(out, v)
	}
	return out, nil
}

func (t *transport201) setVariables(ctx context.Context, id string, sets []VariableSet201) ([]VariableValue201, error) {
	data := make([]provisioning.SetVariableData, 0, len(sets))
	for _, s := range sets {
		data = append(data, provisioning.SetVariableData{Component: toComponent(s.VariableRef201),
			Variable: types.Variable{Name: s.Variable}, AttributeValue: s.Value})
	}
	conf, err := await(ctx, func(cb func(*provisioning.SetVariablesResponse, error)) error {
		return t.cs.SetVariables(id, cb, data)
	})
	if err != nil {
		return nil, err
	}
	if conf == nil {
		return nil, errors.New("leere Antwort auf SetVariables")
	}
	out := make([]VariableValue201, 0, len(sets))
	for _, s := range sets {
		v := VariableValue201{VariableRef201: s.VariableRef201, Status: "Missing"}
		for _, res := range conf.SetVariableResult {
			if strings.EqualFold(res.Component.Name, s.Component) && strings.EqualFold(res.Variable.Name, s.Variable) {
				v.Status = string(res.AttributeStatus)
				break
			}
		}
		out = append(out, v)
	}
	return out, nil
}

// --- Server surface (plain Go types) ---

func (s *Server) live201(id string) (*transport201, error) {
	if !s.opts.Enabled {
		return nil, ErrDisabled
	}
	s.mu.Lock()
	t := s.transport
	c, known := s.chargers[id]
	connected := known && c.Connected
	speaks201 := known && c.OCPPVersion == OCPPVersion201
	s.mu.Unlock()
	switch {
	case t == nil || t.v201 == nil:
		return nil, ErrDisabled
	case !known:
		return nil, ErrNotFound
	case !connected:
		return nil, ErrNotConnected
	case !speaks201:
		return nil, ErrNotOCPP201
	}
	return t.v201, nil
}

// GetVariables201 reads Device Model variables of a 2.0.1 station (B06).
func (s *Server) GetVariables201(ctx context.Context, id string, refs []VariableRef201) ([]VariableValue201, error) {
	t, err := s.live201(id)
	if err != nil {
		return nil, err
	}
	return t.getVariables(ctx, id, refs)
}

// SetVariables201 writes Device Model variables of a 2.0.1 station (B05).
// The answer is the station's per-variable status; a caller that needs the
// value proven reads it back with GetVariables201.
func (s *Server) SetVariables201(ctx context.Context, id string, sets []VariableSet201) ([]VariableValue201, error) {
	t, err := s.live201(id)
	if err != nil {
		return nil, err
	}
	return t.setVariables(ctx, id, sets)
}

// RequestBaseReport201 asks a 2.0.1 station for its Device Model (B07); the
// report arrives as NotifyReport messages and is read with DeviceModel201.
func (s *Server) RequestBaseReport201(ctx context.Context, id, reportBase string) (int, string, error) {
	t, err := s.live201(id)
	if err != nil {
		return 0, "", err
	}
	t.mu.Lock()
	t.nextRequestID++
	requestID := t.nextRequestID
	t.mu.Unlock()
	conf, err := await(ctx, func(cb func(*provisioning.GetBaseReportResponse, error)) error {
		return t.cs.GetBaseReport(id, cb, requestID, provisioning.ReportBaseType(reportBase))
	})
	if err != nil {
		return requestID, "", err
	}
	if conf == nil {
		return requestID, "", errors.New("leere Antwort auf GetBaseReport")
	}
	return requestID, string(conf.Status), nil
}

// DeviceModel201 is a copy of what the station reported via NotifyReport,
// keyed "Component[@evse]/Variable[/Attribute]" (only the Actual attribute
// carries no suffix).
func (s *Server) DeviceModel201(id string) map[string]string {
	s.mu.Lock()
	t := s.transport
	s.mu.Unlock()
	if t == nil || t.v201 == nil {
		return nil
	}
	t.v201.mu.Lock()
	defer t.v201.mu.Unlock()
	out := make(map[string]string, len(t.v201.deviceModel[id]))
	for k, v := range t.v201.deviceModel[id] {
		out[k] = v
	}
	return out
}

// Metering201 is the read-back sampled-data configuration of a 2.0.1 station.
func (s *Server) Metering201(id string) (Metering201, bool) {
	s.mu.Lock()
	t := s.transport
	s.mu.Unlock()
	if t == nil || t.v201 == nil {
		return Metering201{}, false
	}
	t.v201.mu.Lock()
	defer t.v201.mu.Unlock()
	m, ok := t.v201.metering[id]
	return m, ok
}

// --- station -> CSMS handlers ---

type handler201 struct{ t *transport201 }

// OnBootNotification accepts every registered station (B01): registration IS
// the admission decision, made at the websocket upgrade - exactly as in 1.6.
func (h *handler201) OnBootNotification(id string, req *provisioning.BootNotificationRequest) (*provisioning.BootNotificationResponse, error) {
	s := h.t.srv
	now := s.opts.Now()
	s.onBoot(id, bootInfo{
		Vendor:   req.ChargingStation.VendorName,
		Model:    req.ChargingStation.Model,
		Firmware: req.ChargingStation.FirmwareVersion,
		Serial:   req.ChargingStation.SerialNumber,
	}, now)
	h.t.mu.Lock()
	h.t.needsMetering[id] = true
	delete(h.t.evses, id)
	// A transaction still waiting for its idToken does not outlive the
	// station's reboot; one it resumes comes back with its next event.
	for k := range h.t.pending {
		if strings.HasPrefix(k, id+"\x00") {
			delete(h.t.pending, k)
		}
	}
	h.t.mu.Unlock()
	interval := int(s.opts.HeartbeatInterval / time.Second)
	return provisioning.NewBootNotificationResponse(types.NewDateTime(now), interval, provisioning.RegistrationStatusAccepted), nil
}

// OnNotifyReport stores the reported Device Model (B07).
func (h *handler201) OnNotifyReport(id string, req *provisioning.NotifyReportRequest) (*provisioning.NotifyReportResponse, error) {
	h.t.srv.touch(id, h.t.srv.opts.Now())
	h.t.mu.Lock()
	dm := h.t.deviceModel[id]
	if dm == nil {
		dm = map[string]string{}
		h.t.deviceModel[id] = dm
	}
	for _, rd := range req.ReportData {
		key := rd.Component.Name
		if rd.Component.EVSE != nil {
			key += "@" + strconv.Itoa(rd.Component.EVSE.ID)
		}
		key += "/" + rd.Variable.Name
		for _, a := range rd.VariableAttribute {
			k := key
			if a.Type != "" && a.Type != types.AttributeActual {
				k += "/" + string(a.Type)
			}
			dm[k] = a.Value
		}
	}
	h.t.mu.Unlock()
	return provisioning.NewNotifyReportResponse(), nil
}

// OnHeartbeat answers with the box's clock (G02), like 1.6.
func (h *handler201) OnHeartbeat(id string, _ *availability.HeartbeatRequest) (*availability.HeartbeatResponse, error) {
	now := h.t.srv.opts.Now()
	h.t.srv.touch(id, now)
	h.t.configureMeteringOnce(id)
	return availability.NewHeartbeatResponse(*types.NewDateTime(now)), nil
}

// OnStatusNotification records a connector status (G01), mapped to 1.6 words.
func (h *handler201) OnStatusNotification(id string, req *availability.StatusNotificationRequest) (*availability.StatusNotificationResponse, error) {
	now := h.t.srv.opts.Now()
	h.t.mu.Lock()
	e := h.t.evse(id, req.EvseID)
	e.connector = req.ConnectorStatus
	if req.ConnectorStatus == availability.ConnectorStatusAvailable {
		e.ended = false
	}
	status := status16(e)
	h.t.mu.Unlock()
	h.t.srv.onStatus(id, req.EvseID, status, "", now)
	h.t.configureMeteringOnce(id)
	return availability.NewStatusNotificationResponse(), nil
}

// OnAuthorize uses the same local card policy as 1.6 (C01).
func (h *handler201) OnAuthorize(id string, req *authorization.AuthorizeRequest) (*authorization.AuthorizeResponse, error) {
	s := h.t.srv
	s.touch(id, s.opts.Now())
	status := types.AuthorizationStatusAccepted
	if !s.authorized(req.IdToken.IdToken) || !s.startReady(id) {
		status = types.AuthorizationStatusInvalid
	}
	return authorization.NewAuthorizationResponse(types.IdTokenInfo{Status: status}), nil
}

// OnTransactionEvent is the 2.0.1 transaction (E01-E07, J02). The box keeps
// its own monotonic transaction number and stores the station's
// transactionId next to it, so every consumer keys on what it always did.
func (h *handler201) OnTransactionEvent(id string, req *transactions.TransactionEventRequest) (*transactions.TransactionEventResponse, error) {
	s := h.t.srv
	now := s.opts.Now()
	stationTx := req.TransactionInfo.TransactionID
	eventAt := now
	if req.Timestamp != nil {
		eventAt = req.Timestamp.Time
	}
	connectorID, txID, open := s.sessionOf201(id, stationTx)
	key := pendingKey(id, stationTx)

	h.t.mu.Lock()
	p, isPending := h.t.pending[key]
	if !open && !isPending && req.EventType != transactions.TransactionEventEnded {
		p = pendingTx201{startedAt: eventAt}
		isPending = true
	}
	evseID := connectorID
	if req.Evse != nil && req.Evse.ID > 0 {
		evseID = req.Evse.ID
	} else if evseID == 0 {
		evseID = p.evse
	}
	p.evse = evseID
	if wh, ok := registerWh(req.MeterValue); ok && !p.meterKnown {
		p.meterWh, p.meterKnown = wh, true
	}
	if isPending {
		h.t.pending[key] = p
	}
	h.t.mu.Unlock()

	resp := transactions.NewTransactionEventResponse()
	tokenStatus := types.AuthorizationStatusAccepted
	if req.IDToken != nil && !s.authorized(req.IDToken.IdToken) {
		tokenStatus = types.AuthorizationStatusInvalid
	}

	// The authorized start: the first event that carries an idToken opens the
	// session, with the Started event's time and register (E01/E02).
	if !open && req.IDToken != nil && req.EventType != transactions.TransactionEventEnded && evseID > 0 {
		meterKnown := p.meterKnown
		txID = s.openSession(id, evseID, req.IDToken.IdToken, p.meterWh, p.startedAt, func(sess *Session) {
			sess.StationTransactionID = stationTx
			sess.MeterStartUnknown = !meterKnown
		})
		if txID > 0 {
			open, connectorID = true, evseID
			h.t.mu.Lock()
			delete(h.t.pending, key)
			h.t.mu.Unlock()
		} else {
			tokenStatus = types.AuthorizationStatusInvalid
		}
	}
	if req.IDToken != nil {
		resp.IDTokenInfo = &types.IdTokenInfo{Status: tokenStatus}
	}

	var txRef *int
	if open {
		txRef = &txID
	}
	h.t.foldMeterValues(id, evseID, req.MeterValue, txRef, now)

	if req.EventType == transactions.TransactionEventEnded {
		h.t.mu.Lock()
		delete(h.t.pending, key)
		status := ""
		if evseID > 0 {
			e := h.t.evse(id, evseID)
			e.chargingState, e.ended = "", true
			status = status16(e)
		}
		h.t.mu.Unlock()
		if open {
			if err := s.onStopTransaction(id, txID, now); err != nil {
				return nil, err
			}
		}
		if status != "" {
			s.onStatus(id, evseID, status, "", now)
		}
		return resp, nil
	}
	if req.TransactionInfo.ChargingState != "" && evseID > 0 {
		h.t.mu.Lock()
		e := h.t.evse(id, evseID)
		e.chargingState = req.TransactionInfo.ChargingState
		status := status16(e)
		h.t.mu.Unlock()
		s.onStatus(id, evseID, status, "", now)
	}
	return resp, nil
}

// OnMeterValues folds meter values outside a transaction (J01); evseId 0 is
// the station's main meter, which - as connectorId 0 in 1.6 - reaches the
// measurement runtime but no connector.
func (h *handler201) OnMeterValues(id string, req *meter.MeterValuesRequest) (*meter.MeterValuesResponse, error) {
	h.t.foldMeterValues(id, req.EvseID, req.MeterValue, nil, h.t.srv.opts.Now())
	return meter.NewMeterValuesResponse(), nil
}
