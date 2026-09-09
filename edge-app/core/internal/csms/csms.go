package csms

import (
	"context"
	"encoding/json"
	"fmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/ocppcontrol"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Defaults for the CSMS endpoint. 8887 is the port the OCPP world uses for a
// plain-websocket central system, and it is a free LAN port on the box next to
// :8484 (web), :1883 (local bus) and :502 (Modbus mirror).
const (
	DefaultPort    = 8887
	DefaultURLPath = "/ocpp"
	// DefaultHeartbeatInterval is what BootNotification hands the station. 300 s
	// is the OCPP field default; the heartbeat is a liveness anchor, not a
	// control loop — the control loop rides MeterValues and the profile TTL.
	DefaultHeartbeatInterval = 300 * time.Second
	// DefaultMeterInterval is the MeterValues cadence we ASK the station for
	// (ChangeConfiguration MeterValueSampleInterval). 10 s is the Konzept §3.1
	// figure: fast enough for a seconds-scale budget loop, slow enough not to
	// flood a cheap firmware.
	DefaultMeterInterval = 10 * time.Second
)

// Options configure the central system.
type Options struct {
	// Enabled mirrors VP_OCPP_ENABLED. False = New still builds a Server (so
	// every caller can hold one unconditionally) but Start does nothing and
	// the snapshot honestly says so.
	Enabled bool
	// Port the websocket server listens on. 0 = pick a free one (tests).
	//
	// ⚠ The bind address is not selectable: the library binds ":port" on every
	// interface. The LAN-only posture is therefore the SAME as :8484 and the
	// Node-RED editor — the compose port mapping and the host firewall are the
	// boundary, plus the ID allowlist below. Never expose this port publicly.
	Port int
	// URLPath the stations dial; the ChargePointId is the segment after it.
	URLPath string
	// DataDir holds chargers.json.
	DataDir string
	// HeartbeatInterval is handed to the station in the BootNotification reply.
	HeartbeatInterval time.Duration
	// Now is the clock (injectable — the house rule that every time-dependent
	// function takes its now).
	Now func() time.Time
	// Log receives the CSMS's own lines. nil = slog.Default().
	Log *slog.Logger
	// OnSampledValues mirrors the untouched OCPP values to the additive
	// measurement runtime. It is observation-only and never blocks CSMS state.
	OnSampledValues func([]SampledReading, time.Time)
	// OnMeasurementConfigurationResult reports only a station-confirmed,
	// read-back result. The Node-RED measurement plan must not acknowledge an
	// OCPP selection merely because a local desired document was parsed.
	OnMeasurementConfigurationResult func(MeasurementConfigurationResult)
}

func (o *Options) applyDefaults() {
	if o.Port <= 0 {
		o.Port = 0 // resolved to a concrete free port in Start
	}
	if o.URLPath == "" {
		o.URLPath = DefaultURLPath
	}
	if !strings.HasPrefix(o.URLPath, "/") {
		o.URLPath = "/" + o.URLPath
	}
	o.URLPath = strings.TrimRight(o.URLPath, "/")
	if o.URLPath == "" {
		o.URLPath = DefaultURLPath
	}
	if o.HeartbeatInterval <= 0 {
		o.HeartbeatInterval = DefaultHeartbeatInterval
	}
	if o.Now == nil {
		o.Now = func() time.Time { return time.Now().UTC() }
	}
	if o.Log == nil {
		o.Log = slog.Default()
	}
}

// Server is the OCPP 1.6J central system on the box.
type Server struct {
	opts     Options
	store    *Store
	journal  *Journal
	commands *commandLedger
	log      *slog.Logger

	mu        sync.Mutex
	chargers  map[string]*ChargerState
	nextTxID  int
	listening bool
	port      int
	startErr  string

	// changed coalesces "something a budget decision depends on has moved"
	// into a single wake-up. 1-buffered: a burst of meter values costs one
	// notification, never a queue (the OTA-blocker lesson: a per-tick signal
	// is noise the real signal drowns in).
	changed chan struct{}

	// transport is the ocpp-go half. It is created in Start and is the ONLY
	// place the library is touched besides ocppmap.go.
	transport *transport

	measurementApplyMu sync.Mutex
	profileMu          sync.Mutex
	control            ocppcontrol.Policy
	startWatermarks    map[string]startWatermark
	controlTest        *ControlTest
	seenTags           []string
	rejectedRevision   int64
	controlRejection   string
	measurementDesired MeasurementConfiguration
}

// New builds the server and loads the persisted allowlist. It never opens a
// socket — Start does.
func New(opts Options) (*Server, error) {
	opts.applyDefaults()
	st, err := NewStore(opts.DataDir)
	if err != nil {
		return nil, err
	}
	saved, _, err := st.loadState()
	if err != nil {
		return nil, err
	}
	journal, err := newJournal(opts.DataDir, opts.Log)
	if err != nil {
		return nil, fmt.Errorf("OCPP journal: %w", err)
	}
	commands, err := newCommandLedger(opts.DataDir)
	if err != nil {
		return nil, fmt.Errorf("OCPP command ledger: %w", err)
	}
	measurementDesired, err := loadMeasurementConfiguration(opts.DataDir)
	if err != nil {
		return nil, fmt.Errorf("OCPP measurement configuration: %w", err)
	}
	s := &Server{
		opts:               opts,
		store:              st,
		journal:            journal,
		commands:           commands,
		log:                opts.Log,
		chargers:           map[string]*ChargerState{},
		nextTxID:           saved.NextTransactionID,
		changed:            make(chan struct{}, 1),
		measurementDesired: measurementDesired,
	}
	journal.RestoreCommandMappings(commands.wireMappings())
	if saved.Control != nil {
		if err := saved.Control.Validate(); err != nil {
			return nil, err
		}
		s.control = *saved.Control
	}
	s.controlTest = saved.ControlTest
	s.startWatermarks = saved.StartWatermarks
	if s.startWatermarks == nil {
		s.startWatermarks = map[string]startWatermark{}
	}
	for _, c := range saved.Chargers {
		s.chargers[c.ID] = &ChargerState{Charger: c}
	}
	for _, tx := range saved.Sessions {
		c, ok := s.chargers[tx.ChargePointID]
		if !ok || tx.ConnectorID < 1 || tx.ConnectorID > maxConnectors || tx.TransactionID < 1 || tx.StartedAt.IsZero() {
			continue
		}
		if key := ocppcontrol.Key(tx.ChargePointID, tx.ConnectorID); tx.StartedAt.After(s.startWatermarks[key].At) {
			s.startWatermarks[key] = startWatermark{At: tx.StartedAt, MeterStartWh: tx.MeterStartWh, TagRef: tx.TagRef}
		}
		c.connector(tx.ConnectorID).Session = &Session{TransactionID: tx.TransactionID,
			StartedAt: tx.StartedAt, MeterStartWh: tx.MeterStartWh, TagRef: tx.TagRef, Reconciling: true}
		if s.nextTxID <= tx.TransactionID {
			s.nextTxID = tx.TransactionID + 1
		}
	}
	journal.onCommandResult = func(chargePointID, wireID, action string, payload json.RawMessage) {
		s.commandReadback(chargePointID, wireID, action, payload)
	}
	journal.onCommandError = func(chargePointID, wireID, _ string) {
		if entry, readback, ok := commands.getByWire(wireID); ok && readback {
			journal.RecordCommandEvent(chargePointID, entry.CorrelationID, "CommandRejected", entry.ActionID,
				"readback_failed", "Station hat den gezielten OCPP-Readback abgelehnt", opts.Now())
		}
		_ = commands.finishByWire(wireID, "responded", opts.Now())
	}
	return s, nil
}

// NextProtocolEvent/AckProtocolEvent expose the durable visibility queue to
// the agent's cloud uploader. They are deliberately not a command surface.
func (s *Server) NextProtocolEvent() ([]byte, string, bool) { return s.journal.Next() }
func (s *Server) AckProtocolEvent(token string) error       { return s.journal.Ack(token) }
func (s *Server) PurgeProtocolEventsThrough(t time.Time) error {
	return s.journal.PurgeThrough(t)
}
func (s *Server) ProtocolEventsChanged() <-chan struct{} { return s.journal.Changed() }

// Enabled reports whether the feature flag is on.
func (s *Server) Enabled() bool { return s.opts.Enabled }

// Changed is the coalescing wake-up channel for the allocator: a receive means
// "re-decide", never "here is what happened".
func (s *Server) Changed() <-chan struct{} { return s.changed }

func (s *Server) notifyChanged() {
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

// Start opens the websocket server. It returns once the socket is accepting
// (or with an error) — a caller that gets nil back may tell the operator the
// endpoint is up. With Enabled false it is a no-op returning nil.
func (s *Server) Start(ctx context.Context) error {
	if !s.opts.Enabled {
		return nil
	}
	port := s.opts.Port
	if port == 0 {
		p, err := freePort()
		if err != nil {
			return fmt.Errorf("kein freier Port für den Ladepunkt-Server: %w", err)
		}
		port = p
	}
	t := newTransport(s, port, s.opts.URLPath)
	s.mu.Lock()
	s.transport = t
	s.port = port
	s.mu.Unlock()

	if err := t.start(ctx); err != nil {
		s.mu.Lock()
		s.startErr = err.Error()
		s.listening = false
		s.mu.Unlock()
		return err
	}
	s.mu.Lock()
	s.listening = true
	s.startErr = ""
	s.mu.Unlock()
	s.log.Info("OCPP central system listening",
		"port", port, "path", s.opts.URLPath, "chargers", len(s.chargers))
	return nil
}

// Stop shuts the websocket server down. Safe to call when never started.
func (s *Server) Stop() {
	s.mu.Lock()
	t := s.transport
	s.transport = nil
	s.listening = false
	s.mu.Unlock()
	if t != nil {
		t.stop()
	}
	s.journal.Close()
}

// EndpointFor renders the FULL ws:// URL an operator types into ONE station:
// the base endpoint plus that station's ChargePointId. This is the string the
// "Säule anbinden" surface shows as a copy field — a real charge point is
// configured with the complete URL, id included.
func (s *Server) EndpointFor(host, id string) string {
	return s.Endpoint(host) + "/" + id
}

// Endpoint renders the BASE ws:// URL, with host left to the caller (the box
// knows its own LAN name, this package does not).
func (s *Server) Endpoint(host string) string {
	s.mu.Lock()
	port := s.port
	s.mu.Unlock()
	if port == 0 {
		port = s.opts.Port
	}
	if host == "" {
		host = "<box>"
	}
	return "ws://" + net.JoinHostPort(host, strconv.Itoa(port)) + s.opts.URLPath
}

// Snapshot returns a deep copy of the plant view.
func (s *Server) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Snapshot{
		Enabled:   s.opts.Enabled,
		Listening: s.listening,
		Error:     s.startErr,
		URLPath:   s.opts.URLPath,
		Port:      s.port,
	}
	for _, c := range s.chargers {
		out.Chargers = append(out.Chargers, cloneCharger(c))
	}
	sortChargers(out.Chargers)
	if out.Chargers == nil {
		out.Chargers = []ChargerState{}
	}
	return out
}

func cloneCharger(c *ChargerState) ChargerState {
	cp := *c
	cp.Connectors = make([]Connector, len(c.Connectors))
	for i, con := range c.Connectors {
		cc := con
		if con.Session != nil {
			sess := *con.Session
			cc.Session = &sess
		}
		cc.PowerKw = clonePtr(con.PowerKw)
		cc.EnergyKwh = clonePtr(con.EnergyKwh)
		cc.SocPct = clonePtr(con.SocPct)
		cp.Connectors[i] = cc
	}
	sortConnectors(cp.Connectors)
	return cp
}

func clonePtr(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

// --- allowlist administration (the setup surface) ---

// List returns the persisted allowlist, deterministically ordered.
func (s *Server) List() []Charger {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Charger, 0, len(s.chargers))
	for _, c := range s.chargers {
		out = append(out, c.Charger)
	}
	SortChargers(out)
	return out
}

// Add registers a charge point id so a station carrying it is admitted. This
// is the "Säule anbinden" step: the operator creates the entry, then types the
// endpoint + this id into the station's own admin surface.
func (s *Server) Add(req AddRequest) (Charger, error) {
	s.mu.Lock()
	existing := make([]Charger, 0, len(s.chargers))
	for _, c := range s.chargers {
		existing = append(existing, c.Charger)
	}
	c, err := NormalizeAdd(req, existing, s.opts.Now())
	if err != nil {
		s.mu.Unlock()
		return Charger{}, err
	}
	s.chargers[c.ID] = &ChargerState{Charger: c}
	err = s.persistLocked()
	if err != nil {
		delete(s.chargers, c.ID)
	}
	s.mu.Unlock()

	if err != nil {
		return Charger{}, err
	}
	s.log.Info("Ladepunkt eingetragen", "charge_point_id", c.ID)
	s.notifyChanged()
	return c, nil
}

// Remove drops a charge point from the allowlist and disconnects it if it is
// currently on. The station will keep retrying and be refused — which is the
// point: removal is a revocation.
func (s *Server) Remove(id string) error {
	s.mu.Lock()
	if _, ok := s.chargers[id]; !ok {
		s.mu.Unlock()
		return ErrNotFound
	}
	previous := s.chargers[id]
	delete(s.chargers, id)
	err := s.persistLocked()
	if err != nil {
		s.chargers[id] = previous
	}
	t := s.transport
	s.mu.Unlock()

	if err != nil {
		return err
	}
	if t != nil {
		t.disconnect(id)
	}
	s.log.Info("Ladepunkt entfernt", "charge_point_id", id)
	s.notifyChanged()
	return nil
}

// UpdateRequest carries the operator-editable fields. Every field is a
// POINTER: an absent field KEEPS the stored value (the PATCH semantics the
// house uses on every settings surface), so a form that saves one knob never
// resets the rest.
type UpdateRequest struct {
	Label      *string  `json:"label,omitempty"`
	Priority   *bool    `json:"priority,omitempty"`
	RatedKw    *float64 `json:"rated_kw,omitempty"`
	MinKw      *float64 `json:"min_kw,omitempty"`
	Connectors *int     `json:"connectors,omitempty"`
	// Connection: "haus"/"eigen" - see Charger.Connection. nil = leave as is.
	Connection *string `json:"connection,omitempty"`
	// Source: this station's own source lane - see Charger.Source. nil = leave
	// as is; an EMPTY STRING hands the station back to the site-wide policy,
	// which is a statement of its own ("Anlagen-Standard verwenden").
	Source *string `json:"source,omitempty"`
	// Rank: this station's Rangliste position - see Charger.Rank. nil = leave
	// as is, 0 = unranked.
	Rank *int `json:"rank,omitempty"`
}

// Update changes the operator-editable fields. Identity (the ChargePointId)
// and everything the station reported about itself stay untouched.
func (s *Server) Update(id string, req UpdateRequest) (Charger, error) {
	s.mu.Lock()
	c, ok := s.chargers[id]
	if !ok {
		s.mu.Unlock()
		return Charger{}, ErrNotFound
	}
	// Validate against a COPY so a refusal changes nothing.
	next := c.Charger
	if req.Label != nil {
		l := strings.TrimSpace(*req.Label)
		if l == "" {
			l = id
		}
		next.Label = l
	}
	if req.Priority != nil {
		next.Priority = *req.Priority
	}
	if req.RatedKw != nil {
		next.RatedKw = *req.RatedKw
	}
	if req.MinKw != nil {
		next.MinKw = *req.MinKw
	}
	if req.Connectors != nil {
		next.Connectors = *req.Connectors
	}
	if req.Connection != nil {
		next.Connection = strings.TrimSpace(*req.Connection)
	}
	if req.Source != nil {
		next.Source = strings.TrimSpace(*req.Source)
	}
	if req.Rank != nil {
		next.Rank = *req.Rank
	}
	// Reuse the ONE validation path: the same rules must hold whether a
	// charger is created or edited.
	checked, err := NormalizeAdd(AddRequest{
		ID: id, Label: next.Label, Priority: next.Priority,
		RatedKw: next.RatedKw, MinKw: next.MinKw, Connectors: next.Connectors,
		Connection: next.Connection, Source: next.Source, Rank: next.Rank,
	}, nil, next.AddedAt)
	if err != nil {
		s.mu.Unlock()
		return Charger{}, err
	}
	checked.AddedAt = next.AddedAt
	previous := c.Charger
	c.Charger = checked
	out := c.Charger
	err = s.persistLocked()
	if err != nil {
		c.Charger = previous
	}
	s.mu.Unlock()

	if err != nil {
		return Charger{}, err
	}
	s.notifyChanged()
	return out, nil
}

// listLocked snapshots the persisted half. Caller holds s.mu.
func (s *Server) listLocked() ([]Charger, int) {
	out := make([]Charger, 0, len(s.chargers))
	for _, c := range s.chargers {
		out = append(out, c.Charger)
	}
	SortChargers(out)
	return out, s.nextTxID
}

// Serialise the snapshot AND the durable write under s.mu. A slower earlier
// write must never resurrect a stopped transaction or an older counter.
func (s *Server) persistLocked() error {
	list, next := s.listLocked()
	var sessions []storedSession
	for _, charger := range list {
		for _, con := range s.chargers[charger.ID].Connectors {
			if tx := con.Session; tx != nil {
				sessions = append(sessions, storedSession{ChargePointID: charger.ID, ConnectorID: con.ID,
					TransactionID: tx.TransactionID, StartedAt: tx.StartedAt, MeterStartWh: tx.MeterStartWh, TagRef: tx.TagRef})
			}
		}
	}
	var control *ocppcontrol.Policy
	if s.control.Revision > 0 {
		control = &s.control
	}
	starts := map[string]startWatermark{}
	for _, c := range list {
		for plug := 1; plug <= maxConnectors; plug++ {
			key := ocppcontrol.Key(c.ID, plug)
			if mark, ok := s.startWatermarks[key]; ok {
				starts[key] = mark
			}
		}
	}
	return s.store.save(list, next, sessions, control, s.controlTest, starts)
}

// freePort asks the OS for an unused TCP port and hands it back. Used only
// when Port is 0 (tests): the library binds ":port" itself and exposes the
// resolved address only through an unsynchronised field, so we choose the port
// up front instead of reading it back.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}
