package csms

// This file — together with csms.go's Options plumbing, the OCPP 2.0.1 lane
// (ocpp201map.go, MiSpeL MP-35) and the subprotocol switch both share
// (subprotocol_mux.go) — is the ONLY place `github.com/lorenzodonini/ocpp-go`
// (MIT) is imported in this repository. Everything above it sees plain Go
// types, so an ocpp-go version bump is a change inside this package.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/lorenzodonini/ocpp-go/ocpp"
	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/firmware"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/smartcharging"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
	"github.com/lorenzodonini/ocpp-go/ws"
)

// transport owns the ocpp-go central system and its websocket server.
type transport struct {
	srv  *Server
	cs   ocpp16.CentralSystem
	wsrv ws.Server
	// mux puts the 1.6 lane (wsrv), the 2.0.1 lane (v201) and the 2.1 lane
	// (v21, MiSpeL MP-37) on one endpoint.
	mux  *subprotocolMux
	v201 *transport201
	v21  *transport201
	port int
	path string

	done         chan struct{}
	stopServer   func()
	drainTimeout time.Duration
	stopping     atomic.Bool
}

func newTransport(s *Server, port int, path string) *transport {
	// Journal at the websocket boundary: typed handlers cannot see malformed
	// calls or CALLERROR frames, whereas Slice 10 must preserve all three OCPP-J
	// message kinds. The wrapper delegates byte-for-byte after recording.
	upstream := ws.NewServer()
	timeouts := ws.NewServerTimeoutConfig()
	timeouts.WriteWait = commandSocketWriteWait
	upstream.SetTimeoutConfig(timeouts)
	// The 1.6 lane is created first and is therefore the mux's primary: it
	// owns the shared server exactly as the bare upstream did before.
	mux := newSubprotocolMux(upstream, s.log)
	wsrv := &journalWsServer{Server: mux.lane(subprotocolOCPP16), journal: s.journal}
	cs := ocpp16.NewCentralSystem(nil, wsrv)
	t := &transport{
		srv: s, cs: cs, wsrv: wsrv, mux: mux, port: port, path: path, done: make(chan struct{}),
		drainTimeout: commandSocketWriteWait + time.Second,
	}
	t.v201 = newTransport201(s, mux.lane(subprotocolOCPP201), func() bool { return t.stopping.Load() })
	t.v21 = newTransport21(s, mux.lane(subprotocolOCPP21), func() bool { return t.stopping.Load() })
	t.stopServer = func() {
		t.v21.stop()
		t.v201.stop()
		cs.Stop()
	}

	// The allowlist gate. Returning false makes the library refuse the
	// websocket upgrade, so an unregistered station never reaches a handler.
	cs.SetNewChargingStationValidationHandler(func(id string, _ *http.Request) bool {
		if t.stopping.Load() {
			return false
		}
		if s.admitted(id) {
			return true
		}
		s.log.Warn("unbekannte Ladesäule abgewiesen — die Kennung steht nicht in der Freigabeliste",
			"charge_point_id", id)
		return false
	})
	cs.SetNewChargePointHandler(func(cp ocpp16.ChargePointConnection) { s.onConnect(cp.ID()) })
	cs.SetChargePointDisconnectedHandler(func(cp ocpp16.ChargePointConnection) { s.onDisconnect(cp.ID()) })
	cs.SetCoreHandler(&coreHandler{srv: s})
	cs.SetFirmwareManagementHandler(&firmwareHandler{srv: s})
	return t
}

// journalWsServer decorates exactly the two byte-bearing methods. Embedding
// keeps the complete ws.Server API delegated to the upstream implementation.
type journalWsServer struct {
	ws.Server
	journal *Journal
	writeMu sync.Mutex
}

func (s *journalWsServer) SetMessageHandler(handler ws.MessageHandler) {
	s.Server.SetMessageHandler(func(ch ws.Channel, data []byte) error {
		s.journal.RecordWire("station_to_csms", ch.ID(), data)
		return handler(ch, data)
	})
}

func (s *journalWsServer) Write(id string, data []byte) error {
	// Upstream has a one-slot per-station handoff queue. Serializing every
	// producer here prevents an unbounded stack of blocked writes from defeating
	// the command gateway's deadline reserve.
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err := s.Server.Write(id, data)
	if err == nil {
		s.journal.RecordWire("csms_to_station", id, data)
	}
	return err
}

// start launches the server goroutine and returns once the socket accepts a
// TCP connection (or the attempt failed). Readiness is proven by DIALING, not
// by reading the library's address field — that field is written without
// synchronisation, and a health check must not be a data race.
func (t *transport) start(ctx context.Context) error {
	errC := t.wsrv.Errors()
	// The library's error channel is 1-buffered and its writer BLOCKS, so it
	// must be drained for the lifetime of the server or a second error wedges
	// the writer. Stop() closes the channel, which ends this goroutine.
	go func() {
		for err := range errC {
			if err != nil {
				t.srv.log.Warn("OCPP-Server meldet einen Fehler", "err", privacySafeProtocolError(err))
			}
		}
	}()

	// The 2.0.1 lane registers its handlers before the shared socket opens,
	// so a 2.0.1 station never meets a half-wired endpoint.
	t.v201.start(t.port, t.path+"/{ws}")
	t.v21.start(t.port, t.path+"/{ws}")
	go func() {
		defer close(t.done)
		// The library takes a gorilla-mux pattern; the trailing segment is the
		// ChargePointId (ws://box:8887/ocpp/<id>).
		t.cs.Start(t.port, t.path+"/{ws}")
	}()

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(t.port))
	deadline := time.Now().Add(5 * time.Second)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		select {
		case <-t.done:
			return portTakenError{port: t.port}
		default:
		}
		if time.Now().After(deadline) {
			return errors.New("der Ladepunkt-Server ist nicht innerhalb von 5 Sekunden bereit geworden")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (t *transport) stop() {
	// Stop admitting reconnects before draining. The post-v0.19 upstream channel
	// lifecycle serializes Close with websocket cleanup; waiting for every
	// admitted socket to disappear then also ensures no writePump can report into
	// errC while Server.Stop closes it. This keeps both closeC and errC owned by
	// the dependency's synchronized lifecycle, without a local dependency fork.
	// StopConnection itself may wait on that lifecycle mutex, so run one bounded
	// worker for all sockets rather than letting an inline call defeat the drain
	// deadline or spawning a new goroutine on every poll.
	t.stopping.Store(true)
	t.srv.mu.Lock()
	ids := make([]string, 0, len(t.srv.chargers))
	for id := range t.srv.chargers {
		ids = append(ids, id)
	}
	t.srv.mu.Unlock()
	closeDone := make(chan struct{})
	go func() {
		defer close(closeDone)
		for _, id := range ids {
			if _, ok := t.sockets().GetChannel(id); !ok {
				continue
			}
			_ = t.sockets().StopConnection(id, websocket.CloseError{
				Code: websocket.CloseNormalClosure,
				Text: "Edge wird beendet",
			})
		}
	}()

	drainTimer := time.NewTimer(t.drainTimeout)
	drainTicker := time.NewTicker(5 * time.Millisecond)
	defer drainTimer.Stop()
	defer drainTicker.Stop()
	drained := false
drain:
	for {
		open := false
		for _, id := range ids {
			if _, ok := t.sockets().GetChannel(id); ok {
				open = true
				break
			}
		}
		if !open {
			drained = true
			break
		}
		select {
		case <-drainTimer.C:
			break drain
		case <-drainTicker.C:
		}
	}
	if !drained {
		t.srv.log.Warn("OCPP-WebSockets nicht innerhalb der Drain-Frist beendet; synchronisierter Server-Stop übernimmt",
			"timeout", t.drainTimeout)
	}
	t.stopServer()
	joinTimer := time.NewTimer(t.drainTimeout)
	select {
	case <-closeDone:
		joinTimer.Stop()
	case <-joinTimer.C:
		t.srv.log.Warn("OCPP-Close-Worker blieb trotz synchronisiertem Server-Stop blockiert; Prozess-Shutdown läuft weiter",
			"timeout", t.drainTimeout)
	}
	select {
	case <-t.done:
	case <-time.After(3 * time.Second):
	}
}

// sockets is the view over EVERY station socket, whichever OCPP it speaks:
// shutdown drains and a revoked registration kicks both protocols alike.
func (t *transport) sockets() ws.Server {
	if t.mux != nil {
		return t.mux.upstream
	}
	return t.wsrv
}

// disconnect kicks a station off (used when its registration is revoked).
func (t *transport) disconnect(id string) {
	_ = t.sockets().StopConnection(id, websocket.CloseError{
		Code: websocket.CloseNormalClosure,
		Text: "Ladepunkt entfernt",
	})
}

// --- the OCPP 1.6 Core profile, CSMS side ---

type coreHandler struct{ srv *Server }

// The two FirmwareManagement notifications are Station -> CSMS status data.
// They are accepted and journalled by the websocket decorator; the handler
// additionally keeps liveness current. No UpdateFirmware/GetDiagnostics
// command is introduced here.
type firmwareHandler struct{ srv *Server }

func (h *firmwareHandler) OnDiagnosticsStatusNotification(id string,
	_ *firmware.DiagnosticsStatusNotificationRequest) (*firmware.DiagnosticsStatusNotificationConfirmation, error) {
	h.srv.touch(id, h.srv.opts.Now())
	return firmware.NewDiagnosticsStatusNotificationConfirmation(), nil
}

func (h *firmwareHandler) OnFirmwareStatusNotification(id string,
	_ *firmware.FirmwareStatusNotificationRequest) (*firmware.FirmwareStatusNotificationConfirmation, error) {
	h.srv.touch(id, h.srv.opts.Now())
	return firmware.NewFirmwareStatusNotificationConfirmation(), nil
}

// OnBootNotification accepts every registered station: registration IS the
// admission decision, and it already happened at the websocket upgrade.
func (h *coreHandler) OnBootNotification(id string, req *core.BootNotificationRequest) (*core.BootNotificationConfirmation, error) {
	now := h.srv.opts.Now()
	h.srv.onBoot(id, bootInfo{
		Vendor:   req.ChargePointVendor,
		Model:    req.ChargePointModel,
		Firmware: req.FirmwareVersion,
		Serial:   req.ChargePointSerialNumber,
	}, now)
	interval := int(h.srv.opts.HeartbeatInterval / time.Second)
	return core.NewBootNotificationConfirmation(types.NewDateTime(now), interval, core.RegistrationStatusAccepted), nil
}

// OnHeartbeat answers with our clock. Charge points use it to set theirs, so a
// box with a wrong clock produces wrong session timestamps everywhere — the
// box's own time discipline is the whole answer here.
func (h *coreHandler) OnHeartbeat(id string, _ *core.HeartbeatRequest) (*core.HeartbeatConfirmation, error) {
	now := h.srv.opts.Now()
	h.srv.touch(id, now)
	return core.NewHeartbeatConfirmation(types.NewDateTime(now)), nil
}

// OnStatusNotification records a connector (or station) status.
func (h *coreHandler) OnStatusNotification(id string, req *core.StatusNotificationRequest) (*core.StatusNotificationConfirmation, error) {
	h.srv.onStatus(id, req.ConnectorId, string(req.Status), string(req.ErrorCode), h.srv.opts.Now())
	return core.NewStatusNotificationConfirmation(), nil
}

// OnAuthorize uses the same durable local card policy as StartTransaction.
func (h *coreHandler) OnAuthorize(id string, req *core.AuthorizeRequest) (*core.AuthorizeConfirmation, error) {
	h.srv.touch(id, h.srv.opts.Now())
	if !h.srv.authorized(req.IdTag) || !h.srv.startReady(id) {
		return core.NewAuthorizationConfirmation(types.NewIdTagInfo(types.AuthorizationStatusInvalid)), nil
	}
	return core.NewAuthorizationConfirmation(types.NewIdTagInfo(types.AuthorizationStatusAccepted)), nil
}

// OnStartTransaction opens a session and hands back its id.
func (h *coreHandler) OnStartTransaction(id string, req *core.StartTransactionRequest) (*core.StartTransactionConfirmation, error) {
	h.srv.authorized(req.IdTag) // also observes the pseudonym; admission is atomic below
	txID := h.srv.onStartTransaction(id, req.ConnectorId, req.IdTag, req.MeterStart, req.Timestamp.Time)
	if txID == 0 {
		if !h.srv.authorized(req.IdTag) || !h.srv.startReady(id) {
			return core.NewStartTransactionConfirmation(types.NewIdTagInfo(types.AuthorizationStatusInvalid), 0), nil
		}
		return nil, errors.New("Ladevorgang konnte nicht eindeutig und dauerhaft angenommen werden")
	}
	return core.NewStartTransactionConfirmation(types.NewIdTagInfo(types.AuthorizationStatusAccepted), txID), nil
}

// OnStopTransaction closes the session and folds in the final meter values.
func (h *coreHandler) OnStopTransaction(id string, req *core.StopTransactionRequest) (*core.StopTransactionConfirmation, error) {
	now := h.srv.opts.Now()
	for _, mv := range req.TransactionData {
		samples := mapSamples(mv.SampledValue)
		h.srv.emitLiveSampledValues(samples, mv.Timestamp.Time, now)
		connectorID := connectorOfTransaction(h.srv, id, req.TransactionId)
		h.srv.onMeterSample(id, connectorID, ParseMeterValues(samples), mv.Timestamp.Time, now, &req.TransactionId)
		h.srv.signedSamples16(id, connectorID, &req.TransactionId, "TransactionData", mv.SampledValue, now)
	}
	if err := h.srv.onStopTransaction(id, req.TransactionId, now); err != nil {
		return nil, err
	}
	return core.NewStopTransactionConfirmation(), nil
}

// OnMeterValues folds a sampled reading into the connector it belongs to.
func (h *coreHandler) OnMeterValues(id string, req *core.MeterValuesRequest) (*core.MeterValuesConfirmation, error) {
	now := h.srv.opts.Now()
	for _, mv := range req.MeterValue {
		samples := mapSamples(mv.SampledValue)
		h.srv.emitLiveSampledValues(samples, mv.Timestamp.Time, now)
		r := ParseMeterValues(samples)
		if r.Dropped > 0 {
			h.srv.log.Debug("Messwerte einer Ladesäule teilweise verworfen",
				"charge_point_id", id, "connector", req.ConnectorId, "dropped", r.Dropped)
		}
		h.srv.onMeterSample(id, req.ConnectorId, r, mv.Timestamp.Time, now, req.TransactionId)
		h.srv.signedSamples16(id, req.ConnectorId, req.TransactionId, "MeterValues", mv.SampledValue, now)
	}
	return core.NewMeterValuesConfirmation(), nil
}

// OnDataTransfer refuses with UnknownVendorId — deliberately.
//
// ⚠ HERSTELLERNEUTRAL (Konzept §0): DataTransfer is the door through which
// vendor-proprietary logic enters a CSMS. We implement none, so the honest
// answer is "we do not know your vendor id". Accepting silently would let a
// station believe a proprietary exchange succeeded.
func (h *coreHandler) OnDataTransfer(id string, req *core.DataTransferRequest) (*core.DataTransferConfirmation, error) {
	h.srv.touch(id, h.srv.opts.Now())
	h.srv.log.Info("DataTransfer einer Ladesäule abgelehnt (keine herstellerspezifische Erweiterung implementiert)",
		"charge_point_id", id, "vendor_id", req.VendorId)
	return core.NewDataTransferConfirmation(core.DataTransferStatusUnknownVendorId), nil
}

// connectorOfTransaction finds which connector holds txID; 0 when unknown
// (then the reading is dropped rather than attributed to a guess).
func connectorOfTransaction(s *Server, id string, txID int) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.chargers[id]
	if !ok {
		return 0
	}
	for _, con := range c.Connectors {
		if con.Session != nil && con.Session.TransactionID == txID {
			return con.ID
		}
	}
	return 0
}

// mapSamples converts ocpp-go sampled values to the plain shape the parser
// takes. One-to-one, no interpretation — the interpreting lives in meter.go.
func mapSamples(in []types.SampledValue) []SampledReading {
	out := make([]SampledReading, 0, len(in))
	for _, s := range in {
		out = append(out, SampledReading{
			Value:     s.Value,
			Measurand: string(s.Measurand),
			Unit:      string(s.Unit),
			Phase:     string(s.Phase),
			Context:   string(s.Context),
			Format:    string(s.Format),
			Location:  string(s.Location),
		})
	}
	return out
}

func (s *Server) emitSampledValues(samples []SampledReading, now time.Time) {
	if s.opts.OnSampledValues != nil && len(samples) > 0 {
		s.opts.OnSampledValues(samples, now)
	}
}

func (s *Server) emitLiveSampledValues(samples []SampledReading, sampled, received time.Time) {
	if liveMeterTime(sampled, received) {
		s.emitSampledValues(samples, sampled)
	}
}

// --- Smart Charging + configuration, CSMS -> station ---
//
// ocpp-go sends every CSMS-initiated request asynchronously with a callback.
// `await` turns one into a synchronous, context-bounded call, which is what
// the orchestration above wants: every command has an answer, a named refusal
// or a timeout — never an open end.

func await[T any](ctx context.Context, send func(cb func(T, error)) error) (T, error) {
	var zero T
	type result struct {
		v   T
		err error
	}
	ch := make(chan result, 1)
	err := send(func(v T, err error) {
		select {
		case ch <- result{v, err}:
		default:
		}
	})
	if err != nil {
		return zero, privacySafeProtocolError(err)
	}
	select {
	case <-ctx.Done():
		return zero, ctx.Err()
	case r := <-ch:
		return r.v, privacySafeProtocolError(r.err)
	}
}

// ocpp-go exposes CallError.errorDescription through error.Error() in addition
// to the raw websocket frame. That free station/vendor prose must not escape
// through commissioning state, command status or logs after the journal has
// already redacted it. Keep the typed code; reduce description presence to the
// same fixed marker used on disk and at the cloud boundary.
func privacySafeProtocolError(err error) error {
	if err == nil {
		return nil
	}
	var protocolErr *ocpp.Error
	if errors.As(err, &protocolErr) {
		return fmt.Errorf("OCPP CallError (%s): %s", protocolErr.Code, redactedErrorDescription)
	}
	return err
}

// toOcppProfile maps our plain profile onto the library's type. It is the ONLY
// place the wire shape is built.
func toOcppProfile(p ChargingProfile) *types.ChargingProfile {
	period := types.NewChargingSchedulePeriod(0, p.LimitKw)
	// The limit unit is WATTS: our model is kW and the station's is W.
	period.Limit = p.LimitKw * 1000
	schedule := types.NewChargingSchedule(types.ChargingRateUnitWatts, period)
	if p.RateUnit == "A" {
		period.Limit = p.LimitA
		period.NumberPhases = &p.NumberPhases
		schedule = types.NewChargingSchedule(types.ChargingRateUnitAmperes, period)
	}
	schedule.StartSchedule = types.NewDateTime(p.StartsAt)
	if p.Duration > 0 {
		d := int(p.Duration / time.Second)
		schedule.Duration = &d
	}
	out := types.NewChargingProfile(p.ID, p.StackLevel,
		types.ChargingProfilePurposeType(p.Purpose), types.ChargingProfileKindAbsolute, schedule)
	if p.TransactionID > 0 {
		out.TransactionId = p.TransactionID
	}
	return out
}

func (t *transport) setChargingProfile(ctx context.Context, id string, connectorID int, p ChargingProfile) (string, error) {
	conf, err := await(ctx, func(cb func(*smartcharging.SetChargingProfileConfirmation, error)) error {
		return t.cs.SetChargingProfile(id, cb, connectorID, toOcppProfile(p))
	})
	if err != nil {
		return "", err
	}
	if conf == nil {
		return "", errors.New("leere Antwort auf SetChargingProfile")
	}
	return string(conf.Status), nil
}

func (t *transport) clearChargingProfile(ctx context.Context, id string, profileID int) (string, error) {
	conf, err := await(ctx, func(cb func(*smartcharging.ClearChargingProfileConfirmation, error)) error {
		return t.cs.ClearChargingProfile(id, cb, func(r *smartcharging.ClearChargingProfileRequest) {
			r.Id = &profileID
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

func (t *transport) clearProfilePurpose(ctx context.Context, id, purpose string) error {
	conf, err := await(ctx, func(cb func(*smartcharging.ClearChargingProfileConfirmation, error)) error {
		return t.cs.ClearChargingProfile(id, cb, func(r *smartcharging.ClearChargingProfileRequest) {
			r.ChargingProfilePurpose = types.ChargingProfilePurposeType(purpose)
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

func (t *transport) getCompositeSchedule(ctx context.Context, id string, connectorID int, d time.Duration) (CompositeSchedule, error) {
	p, prepErr := t.srv.stationProfile(id, connectorID, ChargingProfile{})
	if prepErr != nil {
		return CompositeSchedule{}, prepErr
	}
	conf, err := await(ctx, func(cb func(*smartcharging.GetCompositeScheduleConfirmation, error)) error {
		return t.cs.GetCompositeSchedule(id, cb, connectorID, int(d/time.Second),
			func(r *smartcharging.GetCompositeScheduleRequest) {
				r.ChargingRateUnit = types.ChargingRateUnitWatts
				if p.RateUnit == "A" {
					r.ChargingRateUnit = types.ChargingRateUnitAmperes
				}
			})
	})
	if err != nil {
		return CompositeSchedule{}, err
	}
	if conf == nil {
		return CompositeSchedule{}, errors.New("leere Antwort auf GetCompositeSchedule")
	}
	out := CompositeSchedule{
		Accepted:  conf.Status == smartcharging.GetCompositeScheduleStatusAccepted,
		Connector: connectorID,
	}
	if conf.ScheduleStart != nil {
		out.StartsAt = conf.ScheduleStart.Time
	}
	// The FIRST period is what applies now; a station may report a whole
	// staircase, and reading a later step as "the current limit" would be a
	// claim about the future.
	if sch := conf.ChargingSchedule; sch != nil && len(sch.ChargingSchedulePeriod) > 0 {
		first := sch.ChargingSchedulePeriod[0]
		out.LimitKw = t.srv.compositeLimitKw(id, connectorID, string(sch.ChargingRateUnit), first.Limit, first.NumberPhases)
	}
	return out, nil
}

// compositeLimitKw converts the first period of a composite schedule into kW
// - the one rule for both protocol lanes (OCPP 1.6 and 2.0.1 share the units
// "W" and "A"). nil = not convertible.
func (s *Server) compositeLimitKw(id string, connectorID int, unit string, limit float64, numberPhases *int) *float64 {
	switch unit {
	case string(types.ChargingRateUnitWatts):
		kw := limit / 1000
		return &kw
	case string(types.ChargingRateUnitAmperes):
		wiring, known := s.ControlPolicy().Wiring(id, connectorID)
		phases := 3
		if numberPhases != nil {
			phases = *numberPhases
		}
		// One phase is a real answer only where the operator allowed the
		// switch; anywhere else it stays the mismatch it always was.
		if known && (phases == len(wiring.Phases) || (wiring.PhaseSwitching && phases == 1)) && limit >= 0 {
			kw := limit * wiring.VoltageV * float64(phases) / 1000
			return &kw
		}
	default:
		// An answer in amperes cannot be converted without voltage and
		// phase count - see Capabilities.Usable. Reporting it as kW would
		// be exactly the guess this feature refuses to make, so the
		// readback stays honestly unknown.
	}
	return nil
}

func (t *transport) getConfiguration(ctx context.Context, id string, keys []string) (map[string]string, []string, error) {
	conf, err := await(ctx, func(cb func(*core.GetConfigurationConfirmation, error)) error {
		return t.cs.GetConfiguration(id, cb, keys)
	})
	if err != nil {
		return nil, nil, err
	}
	if conf == nil {
		return nil, nil, errors.New("leere Antwort auf GetConfiguration")
	}
	values := map[string]string{}
	for _, kv := range conf.ConfigurationKey {
		if kv.Value != nil {
			values[kv.Key] = *kv.Value
		} else {
			values[kv.Key] = ""
		}
	}
	return values, conf.UnknownKey, nil
}

func (t *transport) changeConfiguration(ctx context.Context, id, key, value string) (string, error) {
	conf, err := await(ctx, func(cb func(*core.ChangeConfigurationConfirmation, error)) error {
		return t.cs.ChangeConfiguration(id, cb, key, value)
	})
	if err != nil {
		return "", err
	}
	if conf == nil {
		return "", errors.New("leere Antwort auf ChangeConfiguration")
	}
	if conf.Status != core.ConfigurationStatusAccepted && conf.Status != core.ConfigurationStatusRebootRequired {
		return string(conf.Status), fmt.Errorf("die Ladesäule hat die Einstellung %s abgelehnt (%s)", key, conf.Status)
	}
	return string(conf.Status), nil
}
