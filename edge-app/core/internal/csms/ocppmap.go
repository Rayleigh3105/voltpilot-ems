package csms

// This file — together with csms.go's Options plumbing — is the ONLY place
// `github.com/lorenzodonini/ocpp-go` (MIT) is imported in this repository.
// Everything above it sees plain Go types, so an ocpp-go version bump, or the
// later OCPP 2.0.1 adapter (Konzept E3: 1.6J first, 2.0.1 when a real station
// demands it), is a change inside this package.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"

	ocpp16 "github.com/lorenzodonini/ocpp-go/ocpp1.6"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/core"
	"github.com/lorenzodonini/ocpp-go/ocpp1.6/types"
	"github.com/lorenzodonini/ocpp-go/ws"
)

// transport owns the ocpp-go central system and its websocket server.
type transport struct {
	srv  *Server
	cs   ocpp16.CentralSystem
	wsrv ws.WsServer
	port int
	path string

	done chan struct{}
}

func newTransport(s *Server, port int, path string) *transport {
	wsrv := ws.NewServer()
	cs := ocpp16.NewCentralSystem(nil, wsrv)
	t := &transport{srv: s, cs: cs, wsrv: wsrv, port: port, path: path, done: make(chan struct{})}

	// The allowlist gate. Returning false makes the library refuse the
	// websocket upgrade, so an unregistered station never reaches a handler.
	cs.SetNewChargingStationValidationHandler(func(id string, _ *http.Request) bool {
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
	return t
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
				t.srv.log.Warn("OCPP-Server meldet einen Fehler", "err", err)
			}
		}
	}()

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
			return fmt.Errorf("der Ladepunkt-Server auf Port %d konnte nicht gestartet werden (Port belegt?)", t.port)
		default:
		}
		if time.Now().After(deadline) {
			return errors.New("der Ladepunkt-Server ist nicht innerhalb von 5 Sekunden bereit geworden")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (t *transport) stop() {
	t.cs.Stop()
	select {
	case <-t.done:
	case <-time.After(3 * time.Second):
	}
}

// disconnect kicks a station off (used when its registration is revoked).
func (t *transport) disconnect(id string) {
	_ = t.wsrv.StopConnection(id, websocket.CloseError{
		Code: websocket.CloseNormalClosure,
		Text: "Ladepunkt entfernt",
	})
}

// --- the OCPP 1.6 Core profile, CSMS side ---

type coreHandler struct{ srv *Server }

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

// OnAuthorize ACCEPTS every tag.
//
// ⚠ This is the scope fence (Konzept E4), not an oversight: this product is
// LOAD MANAGEMENT, not a charge point operator backend. There is no billing,
// no calibration law, no roaming and no user management here, so there is
// nothing an authorization decision could be based on — and a fabricated
// "Invalid" would stop a customer's car for a reason we invented. Access
// control at a private site is the site's own (gate, parking, RFID inside the
// station). A local allow list is the natural additive follow-up.
func (h *coreHandler) OnAuthorize(id string, req *core.AuthorizeRequest) (*core.AuthorizeConfirmation, error) {
	h.srv.touch(id, h.srv.opts.Now())
	return core.NewAuthorizationConfirmation(types.NewIdTagInfo(types.AuthorizationStatusAccepted)), nil
}

// OnStartTransaction opens a session and hands back its id.
func (h *coreHandler) OnStartTransaction(id string, req *core.StartTransactionRequest) (*core.StartTransactionConfirmation, error) {
	now := h.srv.opts.Now()
	txID := h.srv.onStartTransaction(id, req.ConnectorId, req.IdTag, req.MeterStart, now)
	return core.NewStartTransactionConfirmation(types.NewIdTagInfo(types.AuthorizationStatusAccepted), txID), nil
}

// OnStopTransaction closes the session and folds in the final meter values.
func (h *coreHandler) OnStopTransaction(id string, req *core.StopTransactionRequest) (*core.StopTransactionConfirmation, error) {
	now := h.srv.opts.Now()
	for _, mv := range req.TransactionData {
		h.srv.onMeterValues(id, connectorOfTransaction(h.srv, id, req.TransactionId), ParseMeterValues(mapSamples(mv.SampledValue)), now)
	}
	h.srv.onStopTransaction(id, req.TransactionId, now)
	return core.NewStopTransactionConfirmation(), nil
}

// OnMeterValues folds a sampled reading into the connector it belongs to.
func (h *coreHandler) OnMeterValues(id string, req *core.MeterValuesRequest) (*core.MeterValuesConfirmation, error) {
	now := h.srv.opts.Now()
	for _, mv := range req.MeterValue {
		r := ParseMeterValues(mapSamples(mv.SampledValue))
		if r.Dropped > 0 {
			h.srv.log.Debug("Messwerte einer Ladesäule teilweise verworfen",
				"charge_point_id", id, "connector", req.ConnectorId, "dropped", r.Dropped)
		}
		h.srv.onMeterValues(id, req.ConnectorId, r, now)
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
		})
	}
	return out
}
