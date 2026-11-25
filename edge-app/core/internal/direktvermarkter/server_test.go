package direktvermarkter

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// --- helpers (mirrors internal/mirror/server_test.go's style) --------------

// vectorsPath reads the catalog's shared vectors BY PATH, like
// modbusprofil's modbus-tcp-vectors.json: an edit there that this twin does
// not follow fails `go test` even where Python never runs.
func vectorsPath(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "catalog", "direktvermarkter", "vectors", "luox.json"))
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

func testProfile(t *testing.T) Profile {
	t.Helper()
	p, ok := For("luox")
	if !ok {
		t.Fatal("luox not embedded")
	}
	return p
}

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

func readFullFrame(t *testing.T, conn net.Conn) []byte {
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

func sendHex(t *testing.T, conn net.Conn, hexStr string) {
	t.Helper()
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		t.Fatalf("decode %q: %v", hexStr, err)
	}
	if _, err := conn.Write(raw); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func fc6Request(tid, addr, value uint16) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint16(b[0:2], tid)
	binary.BigEndian.PutUint16(b[4:6], 6)
	b[6] = 1
	b[7] = 6
	binary.BigEndian.PutUint16(b[8:10], addr)
	binary.BigEndian.PutUint16(b[10:12], value)
	return b
}

func fc16Request(tid, addr uint16, values []uint16) []byte {
	b := make([]byte, 13+2*len(values))
	binary.BigEndian.PutUint16(b[0:2], tid)
	binary.BigEndian.PutUint16(b[4:6], uint16(7+2*len(values)))
	b[6] = 1
	b[7] = 16
	binary.BigEndian.PutUint16(b[8:10], addr)
	binary.BigEndian.PutUint16(b[10:12], uint16(len(values)))
	b[12] = byte(2 * len(values))
	for i, v := range values {
		binary.BigEndian.PutUint16(b[13+2*i:], v)
	}
	return b
}

// --- vectors -----------------------------------------------------------------

type telegramVector struct {
	Name            string `json:"name"`
	Gruppe          string `json:"gruppe"`
	WordOrder       string `json:"wortfolge"`
	RequestHex      string `json:"anfrage_hex"`
	ResponseHex     string `json:"antwort_hex"`
	WantSetpointPct *int   `json:"erwartet_vermarkter_vorgabe_pct"`
}

type watchdogVector struct {
	Name              string `json:"name"`
	SinceLastQueryS   int    `json:"seit_letzter_abfrage_s"`
	SetpointBeforeExp *int   `json:"vermarkter_vorgabe_pct_vor_ablauf"`
	WantState         string `json:"erwartet_zustand"`
	WantSetpointPct   *int   `json:"erwartet_vermarkter_vorgabe_pct"`
	WantEvent         string `json:"erwartet_ereignis"`
}

type staleVector struct {
	Name          string `json:"name"`
	AgeS          int    `json:"alter_s"`
	StaleAfterS   int    `json:"stale_after_s"`
	WantException *int   `json:"erwartet_ausnahme"`
}

type vectorFile struct {
	Telegramme       []telegramVector `json:"telegramme"`
	LebenszeichenAbl []watchdogVector `json:"lebenszeichen_ablauf"`
	Veraltet         []staleVector    `json:"veraltet"`
}

func loadVectorFile(t *testing.T) vectorFile {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath(t))
	if err != nil {
		t.Fatalf("Vektoren nicht lesbar: %v", err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("Vektoren unlesbar: %v", err)
	}
	if len(v.Telegramme) == 0 || len(v.LebenszeichenAbl) == 0 || len(v.Veraltet) == 0 {
		t.Fatal("Vektoren leer")
	}
	return v
}

// TestTelegramVectors replays the catalog's raw Modbus telegrams (PS-D23):
// read a known feed-in value under both F3 hypotheses, write within/outside
// the band, write an unknown address, renew the watchdog via FC16 and read
// the set-point back. Vectors sharing a "gruppe" run against ONE server, in
// order, so the write-then-read sequence is meaningful.
func TestTelegramVectors(t *testing.T) {
	p := testProfile(t)
	byGroup := map[string][]telegramVector{}
	var order []string
	for _, v := range loadVectorFile(t).Telegramme {
		if _, seen := byGroup[v.Gruppe]; !seen {
			order = append(order, v.Gruppe)
		}
		byGroup[v.Gruppe] = append(byGroup[v.Gruppe], v)
	}
	for _, group := range order {
		vecs := byGroup[group]
		t.Run(group, func(t *testing.T) {
			profile := p
			if wo := vecs[0].WordOrder; wo != "" {
				profile.Modbus.WordOrder = wo
			}
			srv := NewServer(profile, time.Minute, nil)
			if group == "lesen_little" || group == "lesen_big" {
				srv.SetValues(time.Now(), map[string]float64{
					"nvp_einspeisung_w":         2350,
					"erzeugung_w":               3100,
					"netzbetreiber_vorgabe_pct": 100,
					"referenz_w":                10000,
				})
			}
			addr := startServer(t, srv)
			conn := dial(t, addr)
			for _, v := range vecs {
				sendHex(t, conn, v.RequestHex)
				got := readFullFrame(t, conn)
				want, err := hex.DecodeString(v.ResponseHex)
				if err != nil {
					t.Fatalf("%s: decode expected hex: %v", v.Name, err)
				}
				if hex.EncodeToString(got) != hex.EncodeToString(want) {
					t.Errorf("%s: got % x, want % x", v.Name, got, want)
				}
				if v.WantSetpointPct != nil {
					if pct, _ := srv.Limit(); pct != *v.WantSetpointPct {
						t.Errorf("%s: set-point = %d, want %d", v.Name, pct, *v.WantSetpointPct)
					}
				}
			}
		})
	}
}

// TestWatchdogExpiry drives the server's clock directly (no real sleeping,
// the same test seam internal/mirror uses): a fresh watchdog keeps an active
// limit visible, one at the deadline is still fresh, and past the deadline
// the set-point is forced back to the rest value and the expiry event fires.
func TestWatchdogExpiry(t *testing.T) {
	p := testProfile(t)
	for _, v := range loadVectorFile(t).LebenszeichenAbl {
		t.Run(v.Name, func(t *testing.T) {
			var events []Event
			srv := NewServer(p, time.Minute, func(e Event) { events = append(events, e) })
			base := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
			now := base
			srv.now = func() time.Time { return now }

			addr := startServer(t, srv)
			conn := dial(t, addr)
			// Renew the watchdog FIRST: the gate must be open before a
			// non-rest set-point write is honoured at all.
			sendHex(t, conn, hex.EncodeToString(fc16Request(2, 3, []uint16{0, 0})))
			readFullFrame(t, conn)
			if v.SetpointBeforeExp != nil {
				sendHex(t, conn, hex.EncodeToString(fc6Request(1, 2, uint16(*v.SetpointBeforeExp))))
				readFullFrame(t, conn)
			}

			now = base.Add(time.Duration(v.SinceLastQueryS) * time.Second)

			if got := srv.State(); got != v.WantState {
				t.Errorf("State() = %q, want %q", got, v.WantState)
			}
			if v.WantSetpointPct != nil {
				if pct, _ := srv.Limit(); pct != *v.WantSetpointPct {
					t.Errorf("Limit() pct = %d, want %d", pct, *v.WantSetpointPct)
				}
			}
			if v.WantEvent != "" {
				found := false
				for _, e := range events {
					if e.Kind == v.WantEvent {
						found = true
					}
				}
				if !found {
					t.Errorf("expected event %q, got %+v", v.WantEvent, events)
				}
			}
		})
	}
}

// TestRestartResetsToTheRestValue: concept §5.4 "Neustart und Update" - a new
// Server (= a restarted process, nothing persists across one) never
// continues a previous Vorgabe.
func TestRestartResetsToTheRestValue(t *testing.T) {
	p := testProfile(t)
	srv := NewServer(p, time.Minute, nil)
	addr := startServer(t, srv)
	conn := dial(t, addr)
	sendHex(t, conn, hex.EncodeToString(fc16Request(1, 3, []uint16{0, 0}))) // renew the watchdog gate first
	readFullFrame(t, conn)
	sendHex(t, conn, hex.EncodeToString(fc6Request(2, 2, 55)))
	readFullFrame(t, conn)
	if pct, _ := srv.Limit(); pct != 55 {
		t.Fatalf("setup: set-point = %d, want 55", pct)
	}

	fresh := NewServer(p, time.Minute, nil)
	pct, active := fresh.Limit()
	if pct != p.Rules.RestPct || active {
		t.Errorf("fresh server: Limit() = (%d, %v), want (%d, false)", pct, active, p.Rules.RestPct)
	}
	if got := fresh.State(); got != StateWaitingForQuery {
		t.Errorf("fresh server: State() = %q, want %q", got, StateWaitingForQuery)
	}
}

// TestStaleInputNeverFabricatesAValue: §5.1 "Unbekannt ist keine Null" - a
// read of an input register whose cached value is older than staleAfter (or
// was never set) answers the resolved bei_veraltet exception, never 0 or a
// stale number silently relabelled fresh.
func TestStaleInputNeverFabricatesAValue(t *testing.T) {
	p := testProfile(t)
	for _, v := range loadVectorFile(t).Veraltet {
		t.Run(v.Name, func(t *testing.T) {
			srv := NewServer(p, time.Duration(v.StaleAfterS)*time.Second, nil)
			base := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
			now := base
			srv.now = func() time.Time { return now }
			srv.SetValues(now, map[string]float64{"nvp_einspeisung_w": 2350})
			now = base.Add(time.Duration(v.AgeS) * time.Second)

			addr := startServer(t, srv)
			conn := dial(t, addr)
			sendHex(t, conn, "000100000006010400000002") // FC4, addr0, count2 (nvp_einspeisung_w)
			resp := readFullFrame(t, conn)
			if v.WantException == nil {
				if resp[7] != 4 {
					t.Errorf("expected a fresh success, got exception byte 0x%02x", resp[7])
				}
				return
			}
			if resp[7] != 0x84 || resp[8] != byte(*v.WantException) {
				t.Errorf("expected exception 0x%02x, got fc=0x%02x code=0x%02x", *v.WantException, resp[7], resp[8])
			}
		})
	}
}

func TestConnectionLimitAndIdleClose(t *testing.T) {
	p := testProfile(t)
	srv := NewServer(p, time.Minute, nil)
	addr := startServer(t, srv)

	a := dial(t, addr)
	b := dial(t, addr)
	// the catalog's verbindungen: 2 - a third connection must be refused.
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("dial third: %v", err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 1)
	if n, err := c.Read(buf); err == nil && n > 0 {
		t.Fatalf("third connection should have been refused, got %d bytes", n)
	}
	_ = a.Close()
	_ = b.Close()
}

func TestUnknownFunctionCodeIsRefused(t *testing.T) {
	p := testProfile(t)
	srv := NewServer(p, time.Minute, nil)
	addr := startServer(t, srv)
	conn := dial(t, addr)
	// FC 1 (read coils) is not in the profile's funktionen list.
	sendHex(t, conn, "0001000000060101000a0001")
	resp := readFullFrame(t, conn)
	if resp[7] != 0x81 || resp[8] != 0x01 {
		t.Errorf("got fc=0x%02x code=0x%02x, want ILLEGAL FUNCTION", resp[7], resp[8])
	}
}
