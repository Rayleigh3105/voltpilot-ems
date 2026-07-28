package mirror

import (
	"encoding/binary"
	"math/rand"
	"net"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"
)

// --- helpers -----------------------------------------------------------------

func startServer(t *testing.T, s *Server) string {
	t.Helper()
	if err := s.Start("127.0.0.1:0"); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(s.Stop)
	return s.Addr()
}

func dial(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func readReq(tid uint16, unit, fc byte, start, count int) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint16(b[0:2], tid)
	binary.BigEndian.PutUint16(b[4:6], 6)
	b[6] = unit
	b[7] = fc
	binary.BigEndian.PutUint16(b[8:10], uint16(start))
	binary.BigEndian.PutUint16(b[10:12], uint16(count))
	return b
}

// readResp reads exactly one MBAP response frame off the connection.
func readResp(t *testing.T, conn net.Conn) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	head := make([]byte, 7)
	if _, err := ioReadFull(conn, head); err != nil {
		t.Fatalf("read response header: %v", err)
	}
	length := int(binary.BigEndian.Uint16(head[4:6]))
	body := make([]byte, length-1)
	if _, err := ioReadFull(conn, body); err != nil {
		t.Fatalf("read response body: %v", err)
	}
	return append(head, body...)
}

func ioReadFull(conn net.Conn, buf []byte) (int, error) {
	n := 0
	for n < len(buf) {
		m, err := conn.Read(buf[n:])
		n += m
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

// exchange sends one read request and returns (regs, exceptionCode).
func exchange(t *testing.T, conn net.Conn, tid uint16, unit, fc byte, start, count int) ([]uint16, byte) {
	t.Helper()
	if _, err := conn.Write(readReq(tid, unit, fc, start, count)); err != nil {
		t.Fatalf("write request: %v", err)
	}
	return parseResp(t, readResp(t, conn), tid, unit, fc)
}

func parseResp(t *testing.T, resp []byte, tid uint16, unit, fc byte) ([]uint16, byte) {
	t.Helper()
	if got := binary.BigEndian.Uint16(resp[0:2]); got != tid {
		t.Fatalf("tid = %d, want %d", got, tid)
	}
	if resp[6] != unit {
		t.Fatalf("unit = %d, want %d", resp[6], unit)
	}
	if resp[7] == fc|0x80 {
		return nil, resp[8]
	}
	if resp[7] != fc {
		t.Fatalf("fc = 0x%02x, want 0x%02x", resp[7], fc)
	}
	n := int(resp[8]) / 2
	regs := make([]uint16, n)
	for i := range regs {
		regs[i] = binary.BigEndian.Uint16(resp[9+2*i:])
	}
	return regs, 0
}

func f(v float64) *float64 { return &v }

func seededServer(now time.Time) *Server {
	s := NewServer(90*time.Second, nil, nil)
	s.now = func() time.Time { return now }
	s.UpdateRaw(now, 1, []RawBlock{
		{Start: 0x0000, Regs: []uint16{0x0006}},
		{Start: 0x024C, Regs: seqRegs(0x024C, 121)},
	})
	return s
}

// seqRegs builds recognizable register values (value = address).
func seqRegs(start, n int) []uint16 {
	out := make([]uint16, n)
	for i := range out {
		out[i] = uint16(start + i)
	}
	return out
}

// --- native area -------------------------------------------------------------

func TestServesCachedBlocksByteFaithfullyOnFC3AndFC4(t *testing.T) {
	now := time.Now()
	s := seededServer(now)
	addr := startServer(t, s)
	conn := dial(t, addr)

	// Full block, boundary edges, and an inner slice - FC3 and FC4 identical.
	for _, fc := range []byte{3, 4} {
		regs, exc := exchange(t, conn, 7, 1, fc, 0x024C, 121)
		if exc != 0 {
			t.Fatalf("fc %d: exception 0x%02x", fc, exc)
		}
		if !reflect.DeepEqual(regs, seqRegs(0x024C, 121)) {
			t.Fatalf("fc %d: block mismatch", fc)
		}
		if regs, exc = exchange(t, conn, 8, 1, fc, 0x02C4, 1); exc != 0 || regs[0] != 0x02C4 {
			t.Fatalf("fc %d: last register wrong (exc 0x%02x, regs %v)", fc, exc, regs)
		}
		if regs, exc = exchange(t, conn, 9, 1, fc, 0x026B, 2); exc != 0 || regs[0] != 0x026B || regs[1] != 0x026C {
			t.Fatalf("fc %d: inner slice wrong", fc)
		}
	}
}

func TestStraddlingReadLearnsAndAnswersGatewayFail(t *testing.T) {
	now := time.Now()
	var published atomic.Value
	s := seededServer(now)
	s.onWant = func(b []Block) { published.Store(b) }
	addr := startServer(t, s)
	conn := dial(t, addr)

	// One register beyond the cached block end: not covered -> 0x0B + learned.
	_, exc := exchange(t, conn, 1, 1, 3, 0x02C0, 10) // 0x02C0..0x02C9, cache ends 0x02C4
	if exc != excGatewayTargetFail {
		t.Fatalf("straddling read: exception 0x%02x, want 0x0B", exc)
	}
	wants := s.Wants()
	if len(wants) != 1 || wants[0].Start != 0x02C5 || wants[0].Count != 5 {
		t.Fatalf("learned wants = %+v, want the 5 uncovered registers", wants)
	}
	if got, _ := published.Load().([]Block); !reflect.DeepEqual(got, wants) {
		t.Fatalf("onWant published %+v, want %+v", got, wants)
	}

	// The poll delivers the learned block -> the SAME read now answers.
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x02C5, Regs: seqRegs(0x02C5, 5), Learned: true}})
	regs, exc := exchange(t, conn, 2, 1, 3, 0x02C0, 10)
	if exc != 0 || !reflect.DeepEqual(regs, seqRegs(0x02C0, 10)) {
		t.Fatalf("read after learn: exc 0x%02x regs %v", exc, regs)
	}
}

func TestFirstMissThenHitOnFreshRange(t *testing.T) {
	now := time.Now()
	s := NewServer(90*time.Second, nil, nil)
	s.now = func() time.Time { return now }
	addr := startServer(t, s)
	conn := dial(t, addr)

	if _, exc := exchange(t, conn, 1, 1, 3, 0x0060, 4); exc != excGatewayTargetFail {
		t.Fatalf("first miss: exception 0x%02x, want 0x0B", exc)
	}
	if wants := s.Wants(); len(wants) != 1 || wants[0] != (Block{Start: 0x0060, Count: 4}) {
		t.Fatalf("wants = %+v", wants)
	}
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x0060, Regs: []uint16{10, 11, 12, 13}, Learned: true}})
	regs, exc := exchange(t, conn, 2, 1, 3, 0x0060, 4)
	if exc != 0 || !reflect.DeepEqual(regs, []uint16{10, 11, 12, 13}) {
		t.Fatalf("hit after learn: exc 0x%02x regs %v", exc, regs)
	}
}

func TestStaleBlockAnswersGatewayFail(t *testing.T) {
	base := time.Now()
	s := seededServer(base)
	now := base
	s.now = func() time.Time { return now }
	addr := startServer(t, s)
	conn := dial(t, addr)

	if _, exc := exchange(t, conn, 1, 1, 3, 0x024C, 2); exc != 0 {
		t.Fatalf("fresh read failed: 0x%02x", exc)
	}
	now = base.Add(91 * time.Second)
	if _, exc := exchange(t, conn, 2, 1, 3, 0x024C, 2); exc != excGatewayTargetFail {
		t.Fatalf("stale read: exception 0x%02x, want 0x0B", exc)
	}
	// A fresh poll heals it.
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x024C, Regs: seqRegs(0x024C, 121)}})
	if _, exc := exchange(t, conn, 3, 1, 3, 0x024C, 2); exc != 0 {
		t.Fatalf("healed read failed: 0x%02x", exc)
	}
}

func TestWriteFunctionCodesRefusedIllegalFunction(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)
	conn := dial(t, addr)

	// FC6 write single register (well-formed): must be refused, never applied.
	req := make([]byte, 12)
	binary.BigEndian.PutUint16(req[0:2], 42)
	binary.BigEndian.PutUint16(req[4:6], 6)
	req[6] = 1
	req[7] = 0x06
	binary.BigEndian.PutUint16(req[8:10], 0x024C)
	binary.BigEndian.PutUint16(req[10:12], 0xDEAD)
	if _, err := conn.Write(req); err != nil {
		t.Fatalf("write: %v", err)
	}
	resp := readResp(t, conn)
	if resp[7] != 0x86 || resp[8] != excIllegalFunction {
		t.Fatalf("FC6 response = fc 0x%02x code 0x%02x, want exception 0x01", resp[7], resp[8])
	}
	// Value untouched.
	if regs, exc := exchange(t, conn, 43, 1, 3, 0x024C, 1); exc != 0 || regs[0] != 0x024C {
		t.Fatalf("register changed by refused write: %v (exc 0x%02x)", regs, exc)
	}
	// Other write/diagnostic FCs likewise (FC16 with trailing data, FC5, FC1).
	for _, fc := range []byte{0x10, 0x05, 0x01, 0x2B} {
		pdu := []byte{fc, 0, 1, 2, 3}
		frame := make([]byte, 7+len(pdu))
		binary.BigEndian.PutUint16(frame[0:2], uint16(fc))
		binary.BigEndian.PutUint16(frame[4:6], uint16(1+len(pdu)))
		frame[6] = 1
		copy(frame[7:], pdu)
		if _, err := conn.Write(frame); err != nil {
			t.Fatalf("write fc 0x%02x: %v", fc, err)
		}
		resp := readResp(t, conn)
		if resp[7] != fc|0x80 || resp[8] != excIllegalFunction {
			t.Fatalf("fc 0x%02x: got fc 0x%02x code 0x%02x, want exception 0x01", fc, resp[7], resp[8])
		}
	}
}

func TestCountAndAddressLimits(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)
	conn := dial(t, addr)

	if _, exc := exchange(t, conn, 1, 1, 3, 0x024C, 126); exc != excIllegalDataValue {
		t.Fatalf("count 126: exception 0x%02x, want 0x03", exc)
	}
	if _, exc := exchange(t, conn, 2, 1, 3, 0xFFFF, 2); exc != excIllegalDataAddress {
		t.Fatalf("beyond address space: exception 0x%02x, want 0x02", exc)
	}
	// count 0 is malformed per spec -> ILLEGAL DATA VALUE.
	if _, exc := exchange(t, conn, 3, 1, 3, 0x024C, 0); exc != excIllegalDataValue {
		t.Fatalf("count 0: exception 0x%02x, want 0x03", exc)
	}
}

func TestUnknownUnitAnswersGatewayFail(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)
	conn := dial(t, addr)
	if _, exc := exchange(t, conn, 1, 7, 3, 0x024C, 1); exc != excGatewayTargetFail {
		t.Fatalf("unknown unit: exception 0x%02x, want 0x0B", exc)
	}
	if wants := s.Wants(); len(wants) != 0 {
		t.Fatalf("unknown unit must not learn, got %+v", wants)
	}
}

// --- control window ----------------------------------------------------------

func TestControlWindowServedFromReadbackNeverLearned(t *testing.T) {
	now := time.Now()
	s := seededServer(now)
	addr := startServer(t, s)
	conn := dial(t, addr)

	// No readback data yet: 0x0B and NOTHING learned.
	if _, exc := exchange(t, conn, 1, 1, 3, 1100, 10); exc != excGatewayTargetFail {
		t.Fatalf("control window without readback: 0x%02x, want 0x0B", exc)
	}
	if wants := s.Wants(); len(wants) != 0 {
		t.Fatalf("control window must never be learned, got %+v", wants)
	}

	// Feed a control readback: the window serves those values.
	s.UpdateControl(now, map[uint16]uint16{1100: 1, 1101: 60, 1104: 1, 1105: 2, 1109: 0xFFCE, 1121: 3})
	regs, exc := exchange(t, conn, 2, 1, 3, 1100, 2)
	if exc != 0 || regs[0] != 1 || regs[1] != 60 {
		t.Fatalf("control read: exc 0x%02x regs %v", exc, regs)
	}
	if regs, exc = exchange(t, conn, 3, 1, 3, 1121, 1); exc != 0 || regs[0] != 3 {
		t.Fatalf("status register 1121: exc 0x%02x regs %v", exc, regs)
	}
	// A gap inside the window (1102 never read back) stays 0x0B, unlearned.
	if _, exc = exchange(t, conn, 4, 1, 3, 1100, 4); exc != excGatewayTargetFail {
		t.Fatalf("window gap: 0x%02x, want 0x0B", exc)
	}
	if wants := s.Wants(); len(wants) != 0 {
		t.Fatalf("window gap must not learn, got %+v", wants)
	}
	// A straddling request learns ONLY the parts outside the window.
	if _, exc = exchange(t, conn, 5, 1, 3, 1098, 30); exc != excGatewayTargetFail {
		t.Fatalf("straddle: 0x%02x", exc)
	}
	for _, w := range s.Wants() {
		if overlapsControlWindow(w.Start, w.Count) {
			t.Fatalf("learned want overlaps the control window: %+v", w)
		}
	}
	if len(s.Wants()) != 2 {
		t.Fatalf("wants = %+v, want the two flanks", s.Wants())
	}
}

// --- VP standard map ---------------------------------------------------------

func TestVPMapValuesSentinelsAndQuality(t *testing.T) {
	base := time.Now()
	s := NewServer(90*time.Second, nil, nil)
	now := base
	s.now = func() time.Time { return now }
	addr := startServer(t, s)
	conn := dial(t, addr)

	// No data yet: magic/version valid, age sentinel, quality 2, channels
	// sentinel - never a fabricated 0.
	regs, exc := exchange(t, conn, 1, VPUnit, 3, 0, 15)
	if exc != 0 {
		t.Fatalf("vp read: 0x%02x", exc)
	}
	if regs[0] != 0x5650 || regs[1] != 1 {
		t.Fatalf("magic/version = 0x%04x/%d", regs[0], regs[1])
	}
	if regs[2] != 0xFFFF || regs[3] != vpQualityNoData {
		t.Fatalf("age/quality = %d/%d, want sentinel/no-data", regs[2], regs[3])
	}
	if regs[4] != 0x8000 || regs[5] != 0x0000 || regs[12] != 0xFFFF {
		t.Fatalf("absent channels must carry sentinels: %v", regs)
	}

	// Feed a composite reading: values in W, SoC in 0.1 %.
	s.UpdateComposite(base, Composite{
		PvKw: f(5.5), LoadKw: f(1.234), GridKw: f(-3.2), BattKw: f(7.534), SocPct: f(87.4),
	})
	regs, exc = exchange(t, conn, 2, VPUnit, 3, 0, 15)
	if exc != 0 {
		t.Fatalf("vp read: 0x%02x", exc)
	}
	s32 := func(i int) int32 { return int32(uint32(regs[i])<<16 | uint32(regs[i+1])) }
	if regs[3] != vpQualityOK {
		t.Fatalf("quality = %d, want ok", regs[3])
	}
	if s32(4) != 5500 || s32(6) != 1234 || s32(8) != -3200 || s32(10) != 7534 {
		t.Fatalf("W values wrong: pv=%d load=%d grid=%d batt=%d", s32(4), s32(6), s32(8), s32(10))
	}
	if regs[12] != 874 {
		t.Fatalf("soc = %d, want 874 (0.1 %%)", regs[12])
	}
	if s32(13) != int32(sentinelS32) {
		t.Fatalf("absent grid limit must be sentinel, got %d", s32(13))
	}

	// Staleness is SURFACED, not failed: quality flips, values keep serving.
	now = base.Add(2 * time.Minute)
	regs, exc = exchange(t, conn, 3, VPUnit, 3, 0, 15)
	if exc != 0 || regs[3] != vpQualityStale {
		t.Fatalf("stale vp: exc 0x%02x quality %d, want served + stale", exc, regs[3])
	}
	if regs[2] != 120 {
		t.Fatalf("age = %d, want 120 s", regs[2])
	}
	// Beyond the frozen map: ILLEGAL DATA ADDRESS - the VP area never learns.
	if _, exc = exchange(t, conn, 4, VPUnit, 3, 14, 2); exc != excIllegalDataAddress {
		t.Fatalf("beyond map: 0x%02x, want 0x02", exc)
	}
	if wants := s.Wants(); len(wants) != 0 {
		t.Fatalf("vp map must never learn, got %+v", wants)
	}
	// FC4 serves the same image.
	if regs4, exc := exchange(t, conn, 5, VPUnit, 4, 0, 15); exc != 0 || !reflect.DeepEqual(regs4, regs) {
		t.Fatalf("FC4 differs from FC3 on the VP map")
	}
}

// --- framing robustness --------------------------------------------------------

func TestFragmentedCoalescedAndPipelinedFrames(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)
	conn := dial(t, addr)

	// Fragmented: one request split into three TCP writes.
	req := readReq(11, 1, 3, 0x024C, 2)
	for _, part := range [][]byte{req[:3], req[3:9], req[9:]} {
		if _, err := conn.Write(part); err != nil {
			t.Fatalf("write: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if regs, exc := parseResp(t, readResp(t, conn), 11, 1, 3); exc != 0 || regs[0] != 0x024C {
		t.Fatalf("fragmented request failed")
	}

	// Coalesced + pipelined: two requests in ONE write, answered in order.
	both := append(readReq(21, 1, 3, 0x024C, 1), readReq(22, 1, 3, 0x024D, 1)...)
	if _, err := conn.Write(both); err != nil {
		t.Fatalf("write: %v", err)
	}
	if regs, exc := parseResp(t, readResp(t, conn), 21, 1, 3); exc != 0 || regs[0] != 0x024C {
		t.Fatalf("first pipelined response wrong")
	}
	if regs, exc := parseResp(t, readResp(t, conn), 22, 1, 3); exc != 0 || regs[0] != 0x024D {
		t.Fatalf("second pipelined response wrong")
	}
}

func TestMalformedFramesCloseTheConnection(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)

	assertClosed := func(name string, raw []byte) {
		t.Helper()
		conn := dial(t, addr)
		if _, err := conn.Write(raw); err != nil {
			t.Fatalf("%s write: %v", name, err)
		}
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		buf := make([]byte, 16)
		if _, err := conn.Read(buf); err == nil {
			t.Fatalf("%s: connection not closed (got a response)", name)
		}
	}

	// Wrong protocol id.
	bad := readReq(1, 1, 3, 0, 1)
	bad[2] = 0xDE
	assertClosed("protocol id", bad)
	// Impossible length field.
	bad = readReq(1, 1, 3, 0, 1)
	binary.BigEndian.PutUint16(bad[4:6], 0x4000)
	assertClosed("oversized length", bad)
	// Truncated read PDU (fc3 with 2 data bytes).
	frame := []byte{0, 1, 0, 0, 0, 4, 1, 3, 0}
	assertClosed("short pdu", frame)

	// The server survives all of that: a healthy request still answers.
	conn := dial(t, addr)
	if regs, exc := exchange(t, conn, 5, 1, 3, 0x024C, 1); exc != 0 || regs[0] != 0x024C {
		t.Fatalf("server unhealthy after malformed frames")
	}
}

func TestParserFuzzTruncatedAndOversizedFramesNeverPanic(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)

	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 200; i++ {
		conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
		if err != nil {
			t.Fatalf("dial %d: %v", i, err)
		}
		n := rng.Intn(300)
		raw := make([]byte, n)
		rng.Read(raw)
		if i%3 == 0 && n >= 12 {
			// Bias some frames toward valid headers so deeper paths run too.
			copy(raw, readReq(uint16(i), byte(rng.Intn(255)), byte(rng.Intn(6)), rng.Intn(0xFFFF), rng.Intn(200)))
		}
		_, _ = conn.Write(raw)
		_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
		buf := make([]byte, 512)
		_, _ = conn.Read(buf)
		_ = conn.Close()
	}
	// Still healthy afterwards.
	conn := dial(t, addr)
	if regs, exc := exchange(t, conn, 999, 1, 3, 0x024C, 1); exc != 0 || regs[0] != 0x024C {
		t.Fatalf("server unhealthy after fuzz")
	}
}

func TestConnectionCapRefusesTheNinth(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)

	conns := make([]net.Conn, 0, MaxConns)
	for i := 0; i < MaxConns; i++ {
		c := dial(t, addr)
		// Prove the slot is really held (a served request registers the conn).
		if regs, exc := exchange(t, c, uint16(i), 1, 3, 0x024C, 1); exc != 0 || regs[0] != 0x024C {
			t.Fatalf("conn %d unusable", i)
		}
		conns = append(conns, c)
	}
	ninth := dial(t, addr)
	if _, err := ninth.Write(readReq(99, 1, 3, 0x024C, 1)); err == nil {
		_ = ninth.SetReadDeadline(time.Now().Add(time.Second))
		buf := make([]byte, 16)
		if _, err := ninth.Read(buf); err == nil {
			t.Fatalf("ninth connection was served; want refused")
		}
	}
	// Freeing one slot admits a new consumer.
	_ = conns[0].Close()
	time.Sleep(50 * time.Millisecond)
	again := dial(t, addr)
	if regs, exc := exchange(t, again, 100, 1, 3, 0x024C, 1); exc != 0 || regs[0] != 0x024C {
		t.Fatalf("connection after freeing a slot unusable")
	}
}

// --- auto-learn --------------------------------------------------------------

func TestLearnerCoalescesScatteredSingleRegisterReads(t *testing.T) {
	now := time.Now()
	s := NewServer(90*time.Second, nil, nil)
	s.now = func() time.Time { return now }
	// A Loxone sensor tree: scattered singles in one area.
	for _, a := range []int{0x0100, 0x0104, 0x0102, 0x0110, 0x013F} {
		s.read(1, a, 1)
	}
	wants := s.Wants()
	if len(wants) != 1 || wants[0] != (Block{Start: 0x0100, Count: 0x40}) {
		t.Fatalf("wants = %+v, want ONE coalesced 64-register block", wants)
	}
	// A far-away area becomes its own block.
	s.read(1, 0x0500, 2)
	if wants = s.Wants(); len(wants) != 2 {
		t.Fatalf("wants = %+v, want two blocks", wants)
	}
	// A read wider than the block cap splits.
	s.read(1, 0x0700, 100)
	wants = s.Wants()
	if len(wants) != 4 || wants[2].Count != 64 || wants[3].Count != 36 {
		t.Fatalf("wide read not split: %+v", wants)
	}
}

func TestLearnerLRUEvictionAtCapKeepsActivelyAskedBlocks(t *testing.T) {
	base := time.Now()
	now := base
	s := NewServer(90*time.Second, nil, nil)
	s.now = func() time.Time { return now }
	// Fill the cap with 8 far-apart blocks; block 0 is asked FIRST (oldest).
	for i := 0; i < MaxLearnedBlocks; i++ {
		now = base.Add(time.Duration(i) * time.Second)
		s.read(1, 0x1000+i*0x100, 2)
	}
	if len(s.Wants()) != MaxLearnedBlocks {
		t.Fatalf("wants = %d, want %d", len(s.Wants()), MaxLearnedBlocks)
	}
	// Keep block 0 hot by re-asking it (still a miss - re-noted).
	now = base.Add(20 * time.Second)
	s.read(1, 0x1000, 2)
	// A ninth block evicts the LRU - which is now block 1, not block 0.
	now = base.Add(30 * time.Second)
	s.read(1, 0x3000, 2)
	wants := s.Wants()
	if len(wants) != MaxLearnedBlocks {
		t.Fatalf("cap violated: %d blocks", len(wants))
	}
	has := func(start int) bool {
		for _, w := range wants {
			if w.Start == start {
				return true
			}
		}
		return false
	}
	if !has(0x1000) || has(0x1100) || !has(0x3000) {
		t.Fatalf("LRU eviction wrong: %+v", wants)
	}
}

func TestServedLearnedBlockStaysHotViaTouch(t *testing.T) {
	base := time.Now()
	now := base
	s := NewServer(90*time.Second, nil, nil)
	s.now = func() time.Time { return now }
	s.read(1, 0x1000, 2) // learned first (would be LRU by ask time)
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x1000, Regs: []uint16{1, 2}, Learned: true}})
	for i := 1; i < MaxLearnedBlocks; i++ {
		now = base.Add(time.Duration(i) * time.Second)
		s.read(1, 0x1000+i*0x100, 2)
	}
	// The consumer keeps READING (not missing) the first block - touch keeps it.
	now = base.Add(20 * time.Second)
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x1000, Regs: []uint16{1, 2}, Learned: true}})
	if regs, exc := s.read(1, 0x1000, 2); exc != 0 || regs[0] != 1 {
		t.Fatalf("served read failed: 0x%02x", exc)
	}
	now = base.Add(30 * time.Second)
	s.read(1, 0x3000, 2)
	wants := s.Wants()
	has := func(start int) bool {
		for _, w := range wants {
			if w.Start == start {
				return true
			}
		}
		return false
	}
	// The actively READ block survives; the never-served 0x1100 is the LRU.
	if !has(0x1000) || has(0x1100) || !has(0x3000) {
		t.Fatalf("touch did not keep the served block hot: %+v", wants)
	}
}

func TestInverterRejectedBlockAnswersIllegalAddressAndStopsPolling(t *testing.T) {
	now := time.Now()
	var lastWant atomic.Value
	s := NewServer(90*time.Second, nil, func(b []Block) { lastWant.Store(b) })
	s.now = func() time.Time { return now }
	s.read(1, 0x0F00, 4)
	if len(s.Wants()) != 1 {
		t.Fatalf("want not recorded")
	}
	// The poll reports the inverter refused the block (Modbus exception).
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x0F00, Count: 4, Learned: true, Err: "Modbus-Ausnahme 0x2"}})
	if len(s.Wants()) != 0 {
		t.Fatalf("rejected block still wanted: %+v", s.Wants())
	}
	if got, _ := lastWant.Load().([]Block); len(got) != 0 {
		t.Fatalf("empty want set not republished: %+v", got)
	}
	// The consumer now gets a definitive ILLEGAL DATA ADDRESS, and nothing is
	// re-learned.
	if _, exc := s.read(1, 0x0F00, 4); exc != excIllegalDataAddress {
		t.Fatalf("rejected read: 0x%02x, want 0x02", exc)
	}
	if len(s.Wants()) != 0 {
		t.Fatalf("rejected range re-learned: %+v", s.Wants())
	}
	// A TRANSIENT error (timeout) keeps the want.
	s.read(1, 0x0E00, 2)
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x0E00, Count: 2, Learned: true, Err: "Timeout"}})
	if len(s.Wants()) != 1 {
		t.Fatalf("transient error dropped the want: %+v", s.Wants())
	}
}

func TestPrimaryCoverageDropsRedundantWants(t *testing.T) {
	now := time.Now()
	s := NewServer(90*time.Second, nil, nil)
	s.now = func() time.Time { return now }
	// Consumer asks before the first poll message arrived.
	s.read(1, 0x024C, 4)
	if len(s.Wants()) != 1 {
		t.Fatalf("want not recorded")
	}
	// The PRIMARY poll covers that range -> the want is dropped.
	s.UpdateRaw(now, 1, []RawBlock{{Start: 0x024C, Regs: seqRegs(0x024C, 121)}})
	if len(s.Wants()) != 0 {
		t.Fatalf("primary-covered want kept: %+v", s.Wants())
	}
}

func TestSettingsPersistenceRoundTripWithLearnedBlocks(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	cfg := Settings{Enabled: true, Port: 1502, StaleAfterS: 60,
		LearnedBlocks: []Block{{Start: 0x0100, Count: 64}, {Start: 0x0500, Count: 2}}}
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.Load()
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if !reflect.DeepEqual(got, cfg) {
		t.Fatalf("round trip: %+v != %+v", got, cfg)
	}
	if _, err := filepath.Glob(filepath.Join(dir, "mirror.json")); err != nil {
		t.Fatal(err)
	}
	// A control-window block in a (hand-edited) file is silently dropped.
	bad := cfg
	bad.LearnedBlocks = append(bad.LearnedBlocks, Block{Start: 1100, Count: 4})
	if err := store.Save(bad); err != nil {
		t.Fatal(err)
	}
	got, _, _ = store.Load()
	if !reflect.DeepEqual(got.LearnedBlocks, cfg.LearnedBlocks) {
		t.Fatalf("control-window block not dropped: %+v", got.LearnedBlocks)
	}
	// A seeded server carries the persisted wants (restart does not forget).
	s := NewServer(90*time.Second, got.LearnedBlocks, nil)
	if !reflect.DeepEqual(s.Wants(), cfg.LearnedBlocks) {
		t.Fatalf("seeded wants = %+v", s.Wants())
	}
}

func TestSettingsValidation(t *testing.T) {
	if _, err := (Settings{Port: -1, StaleAfterS: 90}).Normalize(); err == nil {
		t.Fatal("bad port accepted")
	}
	if _, err := (Settings{Port: 1502, StaleAfterS: 2}).Normalize(); err == nil {
		t.Fatal("bad stale threshold accepted")
	}
	got, err := Settings{}.Normalize()
	if err != nil || got.Port != 1502 || got.StaleAfterS != 90 || got.Enabled {
		t.Fatalf("defaults wrong: %+v err=%v", got, err)
	}
}

func TestStopClosesListenerAndConsumers(t *testing.T) {
	s := seededServer(time.Now())
	addr := startServer(t, s)
	conn := dial(t, addr)
	if _, exc := exchange(t, conn, 1, 1, 3, 0x024C, 1); exc != 0 {
		t.Fatalf("pre-stop read failed")
	}
	s.Stop()
	if s.Running() {
		t.Fatal("still running after Stop")
	}
	if _, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
		t.Fatal("listener still accepting after Stop")
	}
}
