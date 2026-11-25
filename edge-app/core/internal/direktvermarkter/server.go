package direktvermarkter

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"
)

// Robustness limits mirror the read-only data-mirror (internal/mirror): this
// interface can never take the core down, and a misbehaving partner at worst
// loads the box's CPU, never a device socket (the server answers exclusively
// from cached values, Grundsatz vp-direktvermarktung-konzept d2 §5.1 - a
// query NEVER triggers a device read).
const (
	// connIdleTimeout closes a partner connection with no complete request
	// for this long.
	connIdleTimeout = 5 * time.Minute
	// writeTimeout bounds one response write.
	writeTimeout = 10 * time.Second
	// maxFrameSize is the Modbus ADU bound (MBAP 7 + PDU 253).
	maxFrameSize = 260
)

// Modbus exception codes the interface answers with.
const (
	excIllegalFunction    = 0x01 // a function code the profile does not list
	excIllegalDataAddress = 0x02 // an address the profile's register map does not cover
	excIllegalDataValue   = 0x03 // a write outside the register's band
	excGatewayTargetFail  = 0x0B // no fresh cached value yet (§5.1 "Unbekannt ist keine Null")
)

// Event is one state change this interface records (vp-direktvermarktung-
// konzept d2 §5.4 Nachweis). Stage 1 only exposes it to the caller (onEvent);
// writing it to the box's flash event list is Stage 2.
type Event struct {
	Kind string
	At   time.Time
}

// EventWatchdogExpired fires once per expiry, when the watchdog register has
// not been rewritten within the profile's lebenszeichen_frist_s and the
// set-point is forced back to the rest value.
const EventWatchdogExpired = "lebenszeichen_abgelaufen"

// The subset of vp-direktvermarktung-konzept d2 §5.4's connection states this
// package can actually observe: it has no tunnel, so "ohne_profil",
// "ohne_zugang", "baut_auf", "tunnel_oben", "tunnel_unten" and
// "zugang_ungueltig" are OpenVPN/Stage 2 states and never appear here.
const (
	StateWaitingForQuery = "wartet_auf_abfrage" // never answered a request yet
	StateConnected       = "verbunden"          // last query fresh, no active limit
	StateLimitActive     = "vorgabe_aktiv"      // last query fresh, set-point below the rest value
	StateExpired         = "abgelaufen"         // watchdog stale; set-point already forced back
)

// Server is the partner's data-mirror interface: a Modbus-TCP slave that
// answers reads from a cached snapshot of measurements and accepts bounded
// writes to the partner set-point and watchdog registers. One Server serves
// one partner profile.
//
// The watchdog is a GATE on the set-point, not just a timer an outside
// reader can observe: a write that moves the set-point away from the rest
// value is refused (ILLEGAL DATA VALUE) unless the watchdog is already fresh
// or is renewed in the very same request. Without this, a partner that keeps
// rewriting the set-point every cycle but never touches the watchdog could
// hold a limit alive forever - exactly what the Lumenaza table's watchdog
// line exists to prevent.
//
// Not wired into composeCurtailment, the heartbeat or the PLC request yet -
// that is Stage 2 (Mango) and Stage 4 (PFC200) of the concept. This package
// is self-contained and independently testable on purpose.
type Server struct {
	profile Profile

	mu           sync.Mutex
	values       map[string]float64 // cached input values, by bedeutung (register "input")
	valuesAt     time.Time
	staleAfter   time.Duration
	holding      map[uint16]uint16 // holding registers, by individual 16-bit word address
	lastQuery    time.Time
	lastWatchdog time.Time
	watchdogDone bool // the current expiry has already been applied + the event fired

	onEvent func(Event)
	now     func() time.Time

	lnMu    sync.Mutex
	ln      net.Listener
	lnErr   string
	conns   map[net.Conn]struct{}
	connsMu sync.Mutex
}

// NewServer builds the interface for one partner profile. staleAfter bounds
// how old a cached input value may be before a read answers with
// excGatewayTargetFail instead of the stale value (independent of the
// watchdog, which governs the OUTGOING set-point only). onEvent may be nil.
//
// The holding registers start at the profile's rest value - after a restart
// there is no other state to continue from (concept §5.4 "Neustart und
// Update"): a fresh Server always does this, by construction.
func NewServer(p Profile, staleAfter time.Duration, onEvent func(Event)) *Server {
	s := &Server{
		profile:    p,
		values:     map[string]float64{},
		staleAfter: staleAfter,
		holding:    map[uint16]uint16{},
		onEvent:    onEvent,
		now:        time.Now,
		conns:      map[net.Conn]struct{}{},
	}
	s.resetHolding()
	return s
}

func (s *Server) resetHolding() {
	for _, r := range s.profile.Register {
		if r.Table != "holding" {
			continue
		}
		rest := 0.0
		if r.Meaning == setpointMeaning {
			rest = float64(s.profile.Rules.RestPct)
		}
		words, ok := Encode(rest, r.Type, s.profile.Modbus.WordOrder)
		if !ok {
			continue
		}
		for i, w := range words {
			s.holding[r.Address+uint16(i)] = w
		}
	}
}

const (
	setpointMeaning = "vermarkter_vorgabe_pct"
	watchdogMeaning = "lebenszeichen"
)

// SetValues replaces the cached input snapshot the server answers reads
// from. The agent (Stage 2) feeds this from the same measurements the Box
// already holds - never a new device read.
func (s *Server) SetValues(at time.Time, values map[string]float64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.valuesAt = at
	for k, v := range values {
		s.values[k] = v
	}
}

// Limit is the resulting partner limit (concept §5.4): pct is the current
// set-point register value, active reports whether it is currently backed by
// a fresh watchdog (StateLimitActive) rather than resting at 100% or expired.
func (s *Server) Limit() (pct int, active bool) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	ev := s.checkWatchdogLocked(now)
	pct = s.setpointLocked()
	active = ev == nil && !s.lastWatchdog.IsZero() && now.Sub(s.lastWatchdog) < s.watchdogDeadline() && pct < s.profile.Rules.RestPct
	s.fireLocked(ev)
	return pct, active
}

// State is the connection state (the subset of concept §5.4 this package can
// observe - see the State* constants).
func (s *Server) State() string {
	now := s.now()
	s.mu.Lock()
	ev := s.checkWatchdogLocked(now)
	state := s.stateLocked(now)
	s.mu.Unlock()
	s.fireLocked(ev)
	return state
}

func (s *Server) watchdogDeadline() time.Duration {
	return time.Duration(s.profile.Rules.WatchdogDeadlineS) * time.Second
}

func (s *Server) setpointLocked() int {
	r, ok := s.profile.ByMeaning(setpointMeaning)
	if !ok {
		return s.profile.Rules.RestPct
	}
	v, ok := Decode(s.wordsLocked(r), r.Type, s.profile.Modbus.WordOrder)
	if !ok {
		return s.profile.Rules.RestPct
	}
	return int(v)
}

func (s *Server) wordsLocked(r Register) []uint16 {
	out := make([]uint16, r.Words())
	for i := range out {
		out[i] = s.holding[r.Address+uint16(i)]
	}
	return out
}

// checkWatchdogLocked forces the set-point back to the rest value the first
// time the watchdog is found stale, and returns the event to fire (nil = no
// transition). Called on every read, every write and every status query, so
// the expiry applies even where nothing else wires in a periodic ticker yet.
func (s *Server) checkWatchdogLocked(now time.Time) *Event {
	if s.lastWatchdog.IsZero() || s.watchdogDone {
		return nil
	}
	if now.Sub(s.lastWatchdog) < s.watchdogDeadline() {
		return nil
	}
	s.watchdogDone = true
	if r, ok := s.profile.ByMeaning(setpointMeaning); ok {
		if words, ok := Encode(float64(s.profile.Rules.RestPct), r.Type, s.profile.Modbus.WordOrder); ok {
			for i, w := range words {
				s.holding[r.Address+uint16(i)] = w
			}
		}
	}
	return &Event{Kind: EventWatchdogExpired, At: now}
}

func (s *Server) fireLocked(ev *Event) {
	if ev != nil && s.onEvent != nil {
		s.onEvent(*ev)
	}
}

func (s *Server) stateLocked(now time.Time) string {
	if s.lastQuery.IsZero() {
		return StateWaitingForQuery
	}
	if s.lastWatchdog.IsZero() || now.Sub(s.lastWatchdog) >= s.watchdogDeadline() {
		return StateExpired
	}
	if s.setpointLocked() < s.profile.Rules.RestPct {
		return StateLimitActive
	}
	return StateConnected
}

// --- listener ---------------------------------------------------------------

// Start opens the Modbus-TCP listener on addr (e.g. ":1502"; later the
// tunnel address - 502 on the Mango, 1502 on the PFC200 where 502 belongs to
// the PLC, concept §5.4). Idempotent: a running listener is left alone.
func (s *Server) Start(addr string) error {
	s.lnMu.Lock()
	defer s.lnMu.Unlock()
	if s.ln != nil {
		return nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		s.lnErr = err.Error()
		return err
	}
	s.ln = ln
	s.lnErr = ""
	go s.acceptLoop(ln)
	slog.Info("direktvermarkter: Schnittstelle lauscht", "partner", s.profile.ID, "addr", addr)
	return nil
}

// Stop closes the listener and every open connection. The cached values and
// holding registers survive (a re-enable serves instantly, same as mirror).
func (s *Server) Stop() {
	s.lnMu.Lock()
	ln := s.ln
	s.ln = nil
	s.lnErr = ""
	s.lnMu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	s.connsMu.Lock()
	for c := range s.conns {
		_ = c.Close()
	}
	s.connsMu.Unlock()
}

// Running reports whether the listener is up; Addr returns its address.
func (s *Server) Running() bool {
	s.lnMu.Lock()
	defer s.lnMu.Unlock()
	return s.ln != nil
}

func (s *Server) Addr() string {
	s.lnMu.Lock()
	defer s.lnMu.Unlock()
	if s.ln == nil {
		return ""
	}
	return s.ln.Addr().String()
}

func (s *Server) ListenError() string {
	s.lnMu.Lock()
	defer s.lnMu.Unlock()
	return s.lnErr
}

func (s *Server) maxConns() int {
	n := s.profile.Modbus.Connections
	if n < 1 {
		return 1
	}
	if n > 8 {
		return 8
	}
	return n
}

func (s *Server) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed
		}
		s.connsMu.Lock()
		if len(s.conns) >= s.maxConns() {
			s.connsMu.Unlock()
			_ = conn.Close()
			continue
		}
		s.conns[conn] = struct{}{}
		s.connsMu.Unlock()
		go s.handleConn(conn)
	}
}

func (s *Server) handleConn(conn net.Conn) {
	defer func() {
		_ = conn.Close()
		s.connsMu.Lock()
		delete(s.conns, conn)
		s.connsMu.Unlock()
	}()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	var acc []byte
	buf := make([]byte, 4096)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(connIdleTimeout))
		n, err := conn.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
			for {
				frame, rest, ok, malformed := splitFrame(acc)
				if malformed {
					return
				}
				if !ok {
					break
				}
				acc = rest
				resp, closeConn := s.handleFrame(frame)
				if closeConn {
					return
				}
				if resp != nil {
					_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
					if _, err := conn.Write(resp); err != nil {
						return
					}
				}
			}
			if len(acc) > 2*maxFrameSize {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func splitFrame(acc []byte) (frame, rest []byte, ok, malformed bool) {
	if len(acc) < 7 {
		return nil, acc, false, false
	}
	if binary.BigEndian.Uint16(acc[2:4]) != 0 {
		return nil, acc, false, true
	}
	length := int(binary.BigEndian.Uint16(acc[4:6]))
	if length < 2 || length > maxFrameSize-6 {
		return nil, acc, false, true
	}
	total := 6 + length
	if len(acc) < total {
		return nil, acc, false, false
	}
	return acc[:total], acc[total:], true, false
}

// handleFrame answers one MBAP frame. closeConn=true for malformed PDUs.
func (s *Server) handleFrame(frame []byte) (resp []byte, closeConn bool) {
	tid := binary.BigEndian.Uint16(frame[0:2])
	unit := frame[6]
	pdu := frame[7:]
	if len(pdu) < 1 {
		return nil, true
	}
	fc := pdu[0]

	if !s.functionAllowed(fc) {
		s.logRefused(fc)
		return mbapException(tid, unit, fc, excIllegalFunction), false
	}

	var regs []uint16
	var exc byte
	switch fc {
	case 3, 4:
		if len(pdu) != 5 {
			return nil, true
		}
		start := binary.BigEndian.Uint16(pdu[1:3])
		count := binary.BigEndian.Uint16(pdu[3:5])
		if count < 1 || count > 125 || int(start)+int(count) > 0x10000 {
			return mbapException(tid, unit, fc, excIllegalDataValue), false
		}
		table := "holding"
		if fc == 4 {
			table = "input"
		}
		regs, exc = s.read(table, start, count)
		if exc != 0 {
			return mbapException(tid, unit, fc, exc), false
		}
		return mbapData(tid, unit, fc, regs), false

	case 6:
		if len(pdu) != 5 {
			return nil, true
		}
		addr := binary.BigEndian.Uint16(pdu[1:3])
		value := binary.BigEndian.Uint16(pdu[3:5])
		if exc := s.write(addr, []uint16{value}); exc != 0 {
			return mbapException(tid, unit, fc, exc), false
		}
		return append([]byte(nil), frame...), false // FC6 success echoes the request verbatim

	case 16:
		if len(pdu) < 6 {
			return nil, true
		}
		addr := binary.BigEndian.Uint16(pdu[1:3])
		count := binary.BigEndian.Uint16(pdu[3:5])
		byteCount := pdu[5]
		if count < 1 || count > 123 || int(byteCount) != 2*int(count) || len(pdu) != 6+int(byteCount) {
			return mbapException(tid, unit, fc, excIllegalDataValue), false
		}
		values := make([]uint16, count)
		for i := range values {
			values[i] = binary.BigEndian.Uint16(pdu[6+2*i : 8+2*i])
		}
		if exc := s.write(addr, values); exc != 0 {
			return mbapException(tid, unit, fc, exc), false
		}
		resp := make([]byte, 12)
		copy(resp, frame[:9])
		binary.BigEndian.PutUint16(resp[4:6], 6)
		binary.BigEndian.PutUint16(resp[8:10], addr)
		binary.BigEndian.PutUint16(resp[10:12], count)
		return resp, false
	}
	return mbapException(tid, unit, fc, excIllegalFunction), false
}

func (s *Server) functionAllowed(fc byte) bool {
	for _, f := range s.profile.Modbus.Functions {
		if int(fc) == f {
			return true
		}
	}
	return false
}

// read serves [start, start+count) of a table from the caches. NEVER
// performs device I/O - only the snapshot SetValues or a write last left
// behind.
func (s *Server) read(table string, start, count uint16) ([]uint16, byte) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	ev := s.checkWatchdogLocked(now)
	defer s.fireLocked(ev)

	out := make([]uint16, count)
	for i := range out {
		addr := start + uint16(i)
		r, ok := s.profile.RegisterAt(table, addr)
		if !ok {
			return nil, excIllegalDataAddress
		}
		var v uint16
		switch table {
		case "holding":
			v = s.holding[addr]
		case "input":
			value, ok := s.values[r.Meaning]
			if !ok || s.valuesAt.IsZero() || now.Sub(s.valuesAt) > s.staleAfter {
				return nil, onStaleException(s.profile.Rules.OnStale)
			}
			words, ok := Encode(value, r.Type, s.profile.Modbus.WordOrder)
			if !ok {
				return nil, excGatewayTargetFail
			}
			v = words[addr-r.Address]
		}
		out[i] = v
	}
	s.lastQuery = now
	return out, 0
}

// write validates the WHOLE request (every address known, every banded
// register still inside its band after the trial) before committing
// anything - a rejected write changes nothing, per concept §5.4.
func (s *Server) write(addr uint16, values []uint16) byte {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	ev := s.checkWatchdogLocked(now)
	defer s.fireLocked(ev)

	trial := make(map[uint16]uint16, len(s.holding))
	for k, v := range s.holding {
		trial[k] = v
	}
	touchedWatchdog := false
	for i, v := range values {
		a := addr + uint16(i)
		r, ok := s.profile.RegisterAt("holding", a)
		if !ok {
			return excIllegalDataAddress
		}
		trial[a] = v
		if r.Meaning == watchdogMeaning {
			touchedWatchdog = true
		}
	}
	// The watchdog is a GATE on the set-point, not just a timer the outside
	// can observe: once it is stale, re-asserting a non-rest set-point every
	// cycle without ever touching the watchdog register must not keep a
	// limit alive. A write that also renews the watchdog in the SAME
	// request (both registers in one FC16, F4 open) counts as fresh.
	watchdogFresh := touchedWatchdog || (!s.lastWatchdog.IsZero() && now.Sub(s.lastWatchdog) < s.watchdogDeadline())

	for _, r := range s.profile.Register {
		if r.Table != "holding" {
			continue
		}
		words := make([]uint16, r.Words())
		for i := range words {
			words[i] = trial[r.Address+uint16(i)]
		}
		if r.Meaning == setpointMeaning {
			val, ok := Decode(words, r.Type, s.profile.Modbus.WordOrder)
			if !ok {
				return excIllegalDataValue
			}
			if r.Band != nil && (int(val) < r.Band[0] || int(val) > r.Band[1]) {
				return excIllegalDataValue
			}
			if !watchdogFresh && int(val) != s.profile.Rules.RestPct {
				return excIllegalDataValue
			}
			continue
		}
		if r.Band == nil {
			continue
		}
		val, ok := Decode(words, r.Type, s.profile.Modbus.WordOrder)
		if !ok || int(val) < r.Band[0] || int(val) > r.Band[1] {
			return excIllegalDataValue
		}
	}
	s.holding = trial
	s.lastQuery = now
	if touchedWatchdog {
		s.lastWatchdog = now
		s.watchdogDone = false
	}
	return 0
}

// onStaleException maps the profile's (resolved) regeln.bei_veraltet to a
// Modbus exception. "ausnahme_0x0b" is the only resolved value today (the
// provisional default for the still-open F8); an unrecognized value fails
// closed the same way, never a fabricated 0.
func onStaleException(policy string) byte {
	switch policy {
	case "ausnahme_0x0b":
		return excGatewayTargetFail
	default:
		return excGatewayTargetFail
	}
}

func (s *Server) logRefused(fc byte) {
	slog.Warn("direktvermarkter: nicht erlaubter Funktionscode", "partner", s.profile.ID, "fc", fmt.Sprintf("0x%02x", fc))
}

func mbapData(tid uint16, unit, fc byte, regs []uint16) []byte {
	n := len(regs)
	resp := make([]byte, 9+2*n)
	binary.BigEndian.PutUint16(resp[0:2], tid)
	binary.BigEndian.PutUint16(resp[4:6], uint16(3+2*n))
	resp[6] = unit
	resp[7] = fc
	resp[8] = byte(2 * n)
	for i, v := range regs {
		binary.BigEndian.PutUint16(resp[9+2*i:], v)
	}
	return resp
}

func mbapException(tid uint16, unit, fc, code byte) []byte {
	resp := make([]byte, 9)
	binary.BigEndian.PutUint16(resp[0:2], tid)
	binary.BigEndian.PutUint16(resp[4:6], 3)
	resp[6] = unit
	resp[7] = fc | 0x80
	resp[8] = code
	return resp
}
