package mirror

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
)

// Robustness limits (report §6.4): defensive by construction so the mirror
// can never take the core down and a misbehaving consumer at worst loads the
// edge box's CPU, never the Solarman socket.
const (
	// MaxConns bounds concurrent consumer TCP connections; the next one is
	// refused (closed immediately).
	MaxConns = 8
	// MaxRegistersPerRead is the Modbus-spec FC3/FC4 quantity limit.
	MaxRegistersPerRead = 125
	// connIdleTimeout closes a consumer connection with no complete request
	// for this long (a polling consumer refreshes it constantly).
	connIdleTimeout = 5 * time.Minute
	// writeTimeout bounds one response write.
	writeTimeout = 10 * time.Second
	// maxRejected bounds the remembered inverter-refused ranges.
	maxRejected = 16
	// refuseLogInterval rate-limits the refused-function-code log line.
	refuseLogInterval = 30 * time.Second
)

// Modbus exception codes the mirror answers with.
const (
	excIllegalFunction    = 0x01 // any non-read function code (read-only)
	excIllegalDataAddress = 0x02 // beyond the address space / inverter-refused
	excIllegalDataValue   = 0x03 // count 0 or > 125
	excGatewayTargetFail  = 0x0B // no fresh data (stale / not yet learned)
)

// RawBlock is one register block from the Node-RED poll (edge/registers/raw).
type RawBlock struct {
	Start   int      `json:"start"`
	Regs    []uint16 `json:"regs"`
	Learned bool     `json:"learned,omitempty"`
	Count   int      `json:"count,omitempty"`
	Err     string   `json:"error,omitempty"`
}

// cachedBlock is one served register block with its freshness timestamp.
type cachedBlock struct {
	start   int
	regs    []uint16
	ts      time.Time
	learned bool
}

func (b cachedBlock) end() int { return b.start + len(b.regs) }

// Status is the operator-facing state served on GET /api/mirror.
type Status struct {
	Enabled       bool    `json:"enabled"`
	Running       bool    `json:"running"`
	ListenPort    int     `json:"listen_port"`
	AdvertisePort int     `json:"advertise_port"`
	StaleAfterS   int     `json:"stale_after_s"`
	NativeUnit    int     `json:"native_unit"`
	VPUnit        int     `json:"vp_unit"`
	LearnedBlocks []Block `json:"learned_blocks"`
	// TelemetryAgeS / RawAgeS report data freshness (nil = no data yet).
	TelemetryAgeS *int `json:"telemetry_age_s,omitempty"`
	RawAgeS       *int `json:"raw_age_s,omitempty"`
	// Error carries the listener failure (e.g. port in use), empty when fine.
	Error string `json:"error,omitempty"`
}

// Server is the read-only Modbus-TCP slave. All caches are push-updated by
// the agent (bus subscriptions); the request path answers exclusively from
// them. Start/Stop control the listener; the cache lives independently of it
// so toggling the mirror never loses learned state.
type Server struct {
	mu         sync.Mutex
	staleAfter time.Duration
	nativeUnit int

	raw      []cachedBlock
	ctrlRegs map[uint16]uint16
	ctrlTs   time.Time
	comp     Composite
	compTs   time.Time

	learn    learner
	rejected []Block
	// onWant is invoked (outside the lock) whenever the learned want set
	// changes; the agent persists it and republishes edge/registers/want.
	onWant func([]Block)

	now func() time.Time // test seam

	lastRefuseLog time.Time

	lnMu    sync.Mutex
	ln      net.Listener
	lnErr   string
	conns   map[net.Conn]struct{}
	connsMu sync.Mutex
}

// NewServer builds the mirror with the persisted learned blocks seeded.
// onWant may be nil.
func NewServer(staleAfter time.Duration, learned []Block, onWant func([]Block)) *Server {
	s := &Server{
		staleAfter: staleAfter,
		nativeUnit: 1,
		ctrlRegs:   map[uint16]uint16{},
		onWant:     onWant,
		now:        time.Now,
		conns:      map[net.Conn]struct{}{},
	}
	s.learn.set(learned, time.Time{})
	return s
}

// SetNativeUnit sets the unit ID of the native pass-through area (the
// device's mb_slave_id). A raw-block update carries the authoritative unit
// and overrides this.
func (s *Server) SetNativeUnit(u int) {
	if u < 1 || u > 247 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if u == VPUnit {
		slog.Warn("mirror: mb_slave_id equals the VoltPilot map unit; the native area is unreachable", "unit", u)
	}
	s.nativeUnit = u
}

// SetStaleAfter applies a new freshness threshold live.
func (s *Server) SetStaleAfter(d time.Duration) {
	s.mu.Lock()
	s.staleAfter = d
	s.mu.Unlock()
}

// UpdateRaw ingests one edge/registers/raw message: the poll's raw register
// blocks. A learned block that the inverter answered with a Modbus exception
// is dropped from the want set and remembered as REJECTED (answered 0x02) -
// polling it forever would waste the one learned-block slot per cycle.
func (s *Server) UpdateRaw(ts time.Time, unit int, blocks []RawBlock) {
	var want []Block
	s.mu.Lock()
	if unit >= 1 && unit <= 247 {
		s.nativeUnit = unit
	}
	changed := false
	for _, rb := range blocks {
		if rb.Start < 0 || rb.Start > 0xFFFF {
			continue
		}
		if rb.Err != "" {
			// The inverter refused this learned block. A Modbus exception is a
			// definitive "no such register area" -> reject permanently (until
			// restart); a transport error (timeout) is transient -> keep the want,
			// staleness handles the gap.
			if rb.Learned && strings.Contains(rb.Err, "Modbus-Ausnahme") {
				count := rb.Count
				if count < 1 {
					count = 1
				}
				if s.learn.drop(rb.Start, count) {
					changed = true
				}
				s.addRejected(Block{Start: rb.Start, Count: count})
			}
			continue
		}
		if len(rb.Regs) == 0 || rb.Start+len(rb.Regs) > 0x10000 {
			continue
		}
		s.putRaw(cachedBlock{start: rb.Start, regs: rb.Regs, ts: ts, learned: rb.Learned})
		if !rb.Learned {
			// A range the PRIMARY poll covers needs no learned block: prune wants
			// the primary already answers (e.g. a want recorded before the first
			// raw message arrived).
			if s.learn.drop(rb.Start, len(rb.Regs)) {
				changed = true
			}
		}
	}
	if changed {
		want = s.learn.list()
	}
	s.mu.Unlock()
	if changed && s.onWant != nil {
		s.onWant(want)
	}
}

// putRaw inserts/replaces a cached block, replacing same-start blocks and
// dropping blocks fully shadowed by the new one.
func (s *Server) putRaw(nb cachedBlock) {
	out := s.raw[:0]
	for _, b := range s.raw {
		if b.start >= nb.start && b.end() <= nb.end() {
			continue // fully covered by the new block
		}
		out = append(out, b)
	}
	s.raw = append(out, nb)
}

func (s *Server) addRejected(b Block) {
	for _, r := range s.rejected {
		if r == b {
			return
		}
	}
	s.rejected = append(s.rejected, b)
	if len(s.rejected) > maxRejected {
		s.rejected = s.rejected[1:]
	}
}

// UpdateControl merges the actual register values of a control readback
// (registers 1100-1121 only; the agent filters). These come from the reads
// the control path performs anyway - the mirror never adds poll traffic for
// them.
func (s *Server) UpdateControl(ts time.Time, regs map[uint16]uint16) {
	if len(regs) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for a, v := range regs {
		if int(a) < ControlRegFirst || int(a) > ControlRegLast {
			continue
		}
		s.ctrlRegs[a] = v
	}
	if ts.After(s.ctrlTs) {
		s.ctrlTs = ts
	}
}

// UpdateComposite ingests the gated composite site reading (the VP map
// source), stamped with its observation time.
func (s *Server) UpdateComposite(ts time.Time, c Composite) {
	s.mu.Lock()
	s.comp = c
	s.compTs = ts
	s.mu.Unlock()
}

// Wants returns the current learned want set (address-ordered).
func (s *Server) Wants() []Block {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.learn.list()
}

// StatusInto fills the data-side fields of a Status (listener fields are the
// agent's).
func (s *Server) StatusInto(st *Status) {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	st.NativeUnit = s.nativeUnit
	st.VPUnit = VPUnit
	st.LearnedBlocks = s.learn.list()
	if !s.compTs.IsZero() {
		v := int(now.Sub(s.compTs) / time.Second)
		st.TelemetryAgeS = &v
	}
	var newest time.Time
	for _, b := range s.raw {
		if !b.learned && b.ts.After(newest) {
			newest = b.ts
		}
	}
	if !newest.IsZero() {
		v := int(now.Sub(newest) / time.Second)
		st.RawAgeS = &v
	}
}

// --- listener ---------------------------------------------------------------

// Start opens the Modbus-TCP listener on addr (e.g. ":1502"). Idempotent: a
// running listener is left alone.
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
	slog.Info("modbus mirror listening (read-only)", "addr", addr)
	return nil
}

// Stop closes the listener and every consumer connection. The caches and the
// learned set survive (a re-enable serves instantly).
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

// Addr returns the bound listener address ("" when not running) - tests use
// it to learn the ephemeral port.
func (s *Server) Addr() string {
	s.lnMu.Lock()
	defer s.lnMu.Unlock()
	if s.ln == nil {
		return ""
	}
	return s.ln.Addr().String()
}

// ListenError returns the last listener start failure ("" when none).
func (s *Server) ListenError() string {
	s.lnMu.Lock()
	defer s.lnMu.Unlock()
	return s.lnErr
}

func (s *Server) acceptLoop(ln net.Listener) {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return // listener closed
		}
		s.connsMu.Lock()
		if len(s.conns) >= MaxConns {
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
		// Wall clock deliberately (s.now is a CACHE-freshness test seam only).
		_ = conn.SetReadDeadline(time.Now().Add(connIdleTimeout))
		n, err := conn.Read(buf)
		if n > 0 {
			acc = append(acc, buf[:n]...)
			// MBAP reassembly: consumers may fragment one request across TCP
			// segments AND coalesce several requests into one (Loxone
			// "Fragmentierte Pakete") - process every complete frame in order.
			for {
				frame, rest, ok, malformed := splitFrame(acc)
				if malformed {
					return // protocol violation: close, per report §6.4
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
				return // runaway garbage that never forms a frame
			}
		}
		if err != nil {
			return // EOF / deadline / reset: drop the connection
		}
	}
}

// maxFrameSize is the Modbus ADU bound (MBAP 7 + PDU 253).
const maxFrameSize = 260

// splitFrame extracts one complete MBAP frame from acc. malformed=true means
// the stream is unrecoverable (wrong protocol id / impossible length) and the
// connection must be closed.
func splitFrame(acc []byte) (frame, rest []byte, ok, malformed bool) {
	if len(acc) < 7 {
		return nil, acc, false, false
	}
	if binary.BigEndian.Uint16(acc[2:4]) != 0 {
		return nil, acc, false, true // protocol id must be 0 (Modbus)
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

	if fc != 3 && fc != 4 {
		// READ-ONLY structurally: every non-read function code - writes above
		// all - is refused with ILLEGAL FUNCTION and logged (rate-limited).
		s.logRefused(fc, unit)
		return mbapException(tid, unit, fc, excIllegalFunction), false
	}
	if len(pdu) != 5 {
		return nil, true // a read PDU is exactly fc+start+count
	}
	start := int(binary.BigEndian.Uint16(pdu[1:3]))
	count := int(binary.BigEndian.Uint16(pdu[3:5]))
	if count < 1 || count > MaxRegistersPerRead {
		return mbapException(tid, unit, fc, excIllegalDataValue), false
	}
	if start+count > 0x10000 {
		return mbapException(tid, unit, fc, excIllegalDataAddress), false
	}

	regs, exc := s.read(int(unit), start, count)
	if exc != 0 {
		return mbapException(tid, unit, fc, exc), false
	}
	return mbapData(tid, unit, fc, regs), false
}

// read serves [start, start+count) for a unit from the caches. Returns the
// register values or a Modbus exception code. NEVER performs I/O.
func (s *Server) read(unit, start, count int) ([]uint16, byte) {
	now := s.now()
	var want []Block
	regs, exc := func() ([]uint16, byte) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if unit == VPUnit {
			if start+count > VPMapSize {
				return nil, excIllegalDataAddress
			}
			img := vpImage(s.comp, s.compTs, s.staleAfter, now)
			return img[start : start+count], 0
		}
		if unit != s.nativeUnit {
			return nil, excGatewayTargetFail
		}
		// Native pass-through: assemble from the control-readback cache (the
		// 1100-1121 window) + the raw poll blocks; per-block freshness.
		out := make([]uint16, count)
		stale := false
		var missing []Block
		reg := start
		for reg < start+count {
			if reg >= ControlRegFirst && reg <= ControlRegLast {
				v, ok := s.ctrlRegs[uint16(reg)]
				if !ok || s.ctrlTs.IsZero() {
					// No readback data (control not active): 0x0B without ever
					// learning - the control window never enters the poll.
					missing = append(missing, Block{Start: reg, Count: 1})
				} else {
					if now.Sub(s.ctrlTs) > s.staleAfter {
						stale = true
					}
					out[reg-start] = v
				}
				reg++
				continue
			}
			covered := false
			for _, b := range s.raw {
				if reg >= b.start && reg < b.end() {
					if now.Sub(b.ts) > s.staleAfter {
						stale = true
					}
					out[reg-start] = b.regs[reg-b.start]
					covered = true
					break
				}
			}
			if !covered {
				missing = append(missing, Block{Start: reg, Count: 1})
			}
			reg++
		}
		if len(missing) > 0 {
			// Inverter-refused ranges answer ILLEGAL DATA ADDRESS so the
			// installer sees WHICH sensor is wrong instead of a forever-pending
			// one.
			for _, m := range missing {
				for _, r := range s.rejected {
					if m.Start >= r.Start && m.Start < r.End() {
						return nil, excIllegalDataAddress
					}
				}
			}
			// Auto-learn: record the uncovered parts as wants (coalesced,
			// capped, control window excluded) and answer "no data yet". The
			// consumer polls cyclically; from the next poll cycles on the range
			// is served.
			changed := false
			for _, m := range coalesce(missing) {
				if s.learn.note(m.Start, m.Count, now) {
					changed = true
				}
			}
			if changed {
				want = s.learn.list()
			}
			return nil, excGatewayTargetFail
		}
		// Served from learned data: keep those blocks alive (LRU).
		s.learn.touch(start, count, now)
		if stale {
			return nil, excGatewayTargetFail
		}
		return out, 0
	}()
	if want != nil && s.onWant != nil {
		s.onWant(want)
	}
	return regs, exc
}

// coalesce merges adjacent single-register misses into ranges.
func coalesce(bs []Block) []Block {
	if len(bs) == 0 {
		return nil
	}
	out := []Block{bs[0]}
	for _, b := range bs[1:] {
		last := &out[len(out)-1]
		if b.Start == last.End() {
			last.Count += b.Count
		} else {
			out = append(out, b)
		}
	}
	return out
}

func (s *Server) logRefused(fc, unit byte) {
	s.mu.Lock()
	quiet := s.now().Sub(s.lastRefuseLog) < refuseLogInterval
	if !quiet {
		s.lastRefuseLog = s.now()
	}
	s.mu.Unlock()
	if !quiet {
		slog.Warn("modbus mirror: non-read function code refused (the mirror is read-only)",
			"fc", fmt.Sprintf("0x%02x", fc), "unit", unit)
	}
}

// mbapData builds a successful FC3/FC4 response frame.
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

// mbapException builds a Modbus exception response frame.
func mbapException(tid uint16, unit, fc, code byte) []byte {
	resp := make([]byte, 9)
	binary.BigEndian.PutUint16(resp[0:2], tid)
	binary.BigEndian.PutUint16(resp[4:6], 3)
	resp[6] = unit
	resp[7] = fc | 0x80
	resp[8] = code
	return resp
}
