package csms

// One port, one path, two protocols (MiSpeL MP-35). A station says which OCPP
// it speaks in the websocket handshake (Sec-WebSocket-Protocol, OCPP-J 1.6
// §3.1.2 / OCPP 2.0.1 Part 4 §3.1.2); the box answers on the SAME endpoint it
// always had, so no second port is opened and the LAN-only posture, the ID
// allowlist and the (absent) TLS stay exactly what 1.6 has.
//
// ocpp-go binds one ocppj server to one ws.Server. subprotocolMux gives each
// protocol its own ws.Server LANE over one shared upstream server and routes
// every callback by the subprotocol the handshake negotiated. The 1.6 lane is
// the primary: it owns the upstream's Start/Stop/Errors, so the 1.6 central
// system runs exactly as before (TestOCPP16BestandBleibtByteGleich).

import (
	"errors"
	"net"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/lorenzodonini/ocpp-go/ws"
)

const (
	subprotocolOCPP16  = "ocpp1.6"
	subprotocolOCPP201 = "ocpp2.0.1"
)

var errWrongLane = errors.New("die Ladesäule spricht ein anderes OCPP-Protokoll")

type subprotocolMux struct {
	upstream ws.Server

	mu    sync.Mutex
	order []*protocolLane          // the box's preference: creation order
	lanes map[string]*protocolLane // by subprotocol
	byID  map[string]*protocolLane // station id -> lane of its live socket
}

func newSubprotocolMux(upstream ws.Server) *subprotocolMux {
	m := &subprotocolMux{upstream: upstream, lanes: map[string]*protocolLane{}, byID: map[string]*protocolLane{}}
	upstream.SetCheckClientHandler(m.check)
	upstream.SetNewClientHandler(func(ch ws.Channel) {
		if l := m.laneOf(ch.ID()); l != nil && l.handlers().connected != nil {
			l.handlers().connected(ch)
		}
	})
	upstream.SetDisconnectedClientHandler(func(ch ws.Channel) {
		l := m.laneOf(ch.ID())
		if _, live := upstream.GetChannel(ch.ID()); !live {
			m.mu.Lock()
			if m.byID[ch.ID()] == l {
				delete(m.byID, ch.ID())
			}
			m.mu.Unlock()
		}
		if l != nil && l.handlers().disconnected != nil {
			l.handlers().disconnected(ch)
		}
	})
	upstream.SetMessageHandler(func(ch ws.Channel, data []byte) error {
		l := m.laneOf(ch.ID())
		if l == nil || l.handlers().message == nil {
			return errWrongLane
		}
		return l.handlers().message(ch, data)
	})
	return m
}

// lane returns the ws.Server view for one subprotocol. The first lane created
// is the primary and drives the shared upstream server.
func (m *subprotocolMux) lane(subprotocol string) *protocolLane {
	m.mu.Lock()
	defer m.mu.Unlock()
	l := &protocolLane{mux: m, subprotocol: subprotocol, primary: len(m.lanes) == 0,
		started: make(chan struct{}), stopped: make(chan struct{})}
	m.lanes[subprotocol] = l
	m.order = append(m.order, l)
	return l
}

func (m *subprotocolMux) laneOf(id string) *protocolLane {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byID[id]
}

// ProtocolOf names the subprotocol of a station's live socket ("" = none).
func (m *subprotocolMux) ProtocolOf(id string) string {
	if l := m.laneOf(id); l != nil {
		if _, live := m.upstream.GetChannel(id); live {
			return l.subprotocol
		}
	}
	return ""
}

// check applies the rule the upgrade itself applies (gorilla's
// Upgrader.selectSubprotocol: the FIRST subprotocol in the box's own list
// that the station offers - 1.6 before 2.0.1) before the upgrade, binds the
// station id to that lane and lets the lane's own admission handler decide.
// A station offering both therefore keeps speaking 1.6, exactly as before
// there was a 2.0.1 lane (Bestandsschutz until 2.0.1 profiles, MP-36).
// A handshake without a supported subprotocol goes to the primary lane, which
// is what the box did before: admit by id, then the library closes the socket
// with "invalid or unsupported subprotocol".
func (m *subprotocolMux) check(id string, r *http.Request) bool {
	offered := websocket.Subprotocols(r)
	m.mu.Lock()
	var chosen *protocolLane
	for _, l := range m.order {
		for _, o := range offered {
			if o == l.subprotocol && chosen == nil {
				chosen = l
			}
		}
	}
	if chosen == nil && len(m.order) > 0 {
		chosen = m.order[0]
	}
	// A live socket keeps its lane: the library refuses the duplicate after
	// the upgrade, and that refusal must not re-route the station that IS
	// connected.
	if _, live := m.upstream.GetChannel(id); !live && chosen != nil {
		m.byID[id] = chosen
	}
	m.mu.Unlock()
	if chosen == nil {
		return false
	}
	if h := chosen.handlers().check; h != nil {
		return h(id, r)
	}
	return true
}

type laneHandlers struct {
	check        ws.CheckClientHandler
	connected    ws.ConnectedHandler
	disconnected func(ws.Channel)
	message      ws.MessageHandler
}

// protocolLane is a ws.Server that sees only the sockets of its subprotocol.
type protocolLane struct {
	mux         *subprotocolMux
	subprotocol string
	primary     bool

	mu          sync.Mutex
	h           laneHandlers
	started     chan struct{}
	startedOnce sync.Once
	stopped     chan struct{}
	stopOnce    sync.Once
}

var _ ws.Server = (*protocolLane)(nil)

func (l *protocolLane) handlers() laneHandlers {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.h
}

func (l *protocolLane) owns(id string) bool { return l.mux.laneOf(id) == l }

// Start: the primary lane runs the shared server (blocking, like any
// ws.Server); a secondary lane only marks itself ready and blocks until Stop.
func (l *protocolLane) Start(port int, listenPath string) {
	l.startedOnce.Do(func() { close(l.started) })
	if l.primary {
		l.mux.upstream.Start(port, listenPath)
		return
	}
	<-l.stopped
}

func (l *protocolLane) Stop() {
	l.stopOnce.Do(func() { close(l.stopped) })
	if l.primary {
		l.mux.upstream.Stop()
	}
}

func (l *protocolLane) StopConnection(id string, closeError websocket.CloseError) error {
	if !l.owns(id) {
		return errWrongLane
	}
	return l.mux.upstream.StopConnection(id, closeError)
}

func (l *protocolLane) Errors() <-chan error {
	if l.primary {
		return l.mux.upstream.Errors()
	}
	return nil
}

func (l *protocolLane) SetMessageHandler(handler ws.MessageHandler) {
	l.mu.Lock()
	l.h.message = handler
	l.mu.Unlock()
}

func (l *protocolLane) SetNewClientHandler(handler ws.ConnectedHandler) {
	l.mu.Lock()
	l.h.connected = handler
	l.mu.Unlock()
}

func (l *protocolLane) SetDisconnectedClientHandler(handler func(ws.Channel)) {
	l.mu.Lock()
	l.h.disconnected = handler
	l.mu.Unlock()
}

func (l *protocolLane) SetCheckClientHandler(handler ws.CheckClientHandler) {
	l.mu.Lock()
	l.h.check = handler
	l.mu.Unlock()
}

func (l *protocolLane) SetTimeoutConfig(config ws.ServerTimeoutConfig) {
	if l.primary {
		l.mux.upstream.SetTimeoutConfig(config)
	}
}

func (l *protocolLane) Write(id string, data []byte) error {
	if !l.owns(id) {
		return errWrongLane
	}
	return l.mux.upstream.Write(id, data)
}

func (l *protocolLane) AddSupportedSubprotocol(subProto string) {
	l.mux.upstream.AddSupportedSubprotocol(subProto)
}

// Authentication and origin policy are properties of the one endpoint, so a
// lane can only ever set them for both protocols alike.
func (l *protocolLane) SetBasicAuthHandler(handler func(username string, password string) bool) {
	l.mux.upstream.SetBasicAuthHandler(handler)
}

func (l *protocolLane) SetCheckOriginHandler(handler func(r *http.Request) bool) {
	l.mux.upstream.SetCheckOriginHandler(handler)
}

func (l *protocolLane) Addr() *net.TCPAddr { return l.mux.upstream.Addr() }

func (l *protocolLane) GetChannel(id string) (ws.Channel, bool) {
	if !l.owns(id) {
		return nil, false
	}
	return l.mux.upstream.GetChannel(id)
}
