package direktvermarkter

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// The server snapshot feeds heartbeat and measurement points: write/query
// bookkeeping and the two delivery-stage events.
func TestServerStandUndEreignisse(t *testing.T) {
	now := time.Date(2026, 11, 26, 8, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	var events []Event
	srv := NewServer(gueltigesProfil(), 30*time.Second, func(ev Event) {
		mu.Lock()
		events = append(events, ev)
		mu.Unlock()
	})
	srv.now = func() time.Time { return now }

	st := srv.Stand()
	if st.State != StateWaitingForQuery || st.Abfragen != 0 || !st.LetzteSchreibung.IsZero() {
		t.Fatalf("Start-Stand: %+v", st)
	}
	if exc := srv.write(2, []uint16{40}); exc != 0 {
		t.Fatalf("write exc=0x%02x", exc)
	}
	if exc := srv.write(3, []uint16{0, 7}); exc != 0 {
		t.Fatalf("watchdog exc=0x%02x", exc)
	}
	st = srv.Stand()
	if st.Abfragen != 2 || st.LetzteSchreibung.IsZero() || st.EffektivPct != 40 || !st.Aktiv {
		t.Fatalf("Stand nach Schreiben: %+v", st)
	}
	mu.Lock()
	kinds := map[string]int{}
	var pct *int
	for _, ev := range events {
		kinds[ev.Kind]++
		if ev.Kind == EventSetpointWritten {
			pct = ev.Pct
		}
	}
	mu.Unlock()
	if kinds[EventFirstQuery] != 1 {
		t.Fatalf("partner_liest: %v", kinds)
	}
	if kinds[EventSetpointWritten] != 1 || pct == nil || *pct != 40 {
		t.Fatalf("vorgabe_geschrieben: %v pct=%v", kinds, pct)
	}
	// The same value written again is no new event.
	if exc := srv.write(2, []uint16{40}); exc != 0 {
		t.Fatal("write")
	}
	mu.Lock()
	n := 0
	for _, ev := range events {
		if ev.Kind == EventSetpointWritten {
			n++
		}
	}
	mu.Unlock()
	if n != 1 {
		t.Fatalf("vorgabe_geschrieben nach identischem Schreiben: %d", n)
	}
}

// End to end over TCP: the little word order serves a u32 low word first.
func TestServerDientUeberTCP(t *testing.T) {
	srv := NewServer(gueltigesProfil(), 30*time.Second, nil)
	if err := srv.Start("127.0.0.1:0"); err != nil {
		t.Fatal(err)
	}
	defer srv.Stop()
	srv.SetValues(time.Now(), map[string]float64{"referenz_w": 10000})

	conn, err := net.Dial("tcp", srv.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// FC 4, input register 5 (referenz_w, u32 = 2 words).
	req := make([]byte, 12)
	binary.BigEndian.PutUint16(req[0:2], 1)
	binary.BigEndian.PutUint16(req[4:6], 6)
	req[6] = 1
	req[7] = 4
	binary.BigEndian.PutUint16(req[8:10], 5)
	binary.BigEndian.PutUint16(req[10:12], 2)
	if _, err := conn.Write(req); err != nil {
		t.Fatal(err)
	}
	resp := make([]byte, 13)
	if _, err := io.ReadFull(conn, resp); err != nil {
		t.Fatal(err)
	}
	if resp[7] != 4 || resp[8] != 4 {
		t.Fatalf("Antwort: % x", resp)
	}
	lo := binary.BigEndian.Uint16(resp[9:11])
	hi := binary.BigEndian.Uint16(resp[11:13])
	if got := uint32(hi)<<16 | uint32(lo); got != 10000 {
		t.Fatalf("referenz_w = %d", got)
	}
}
