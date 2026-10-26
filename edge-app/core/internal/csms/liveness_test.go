package csms

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestAnIdleStationKeepsItsSocket is W-07 (audit probe A5): a station with no
// car sends nothing, and the library closes a socket after its read wait
// without a frame. The box used to hand out a 300-s heartbeat and never ping,
// so an idle station whose firmware pings rarely dropped every minute. Now the
// box pings: a station whose websocket stack answers (every RFC 6455 stack
// does, gorilla's default included) stays on without sending one OCPP message,
// while a stack that answers nothing is still found dead after the read wait.
func TestAnIdleStationKeepsItsSocket(t *testing.T) {
	period, wait := socketPingPeriod, socketPongWait
	socketPingPeriod, socketPongWait = 100*time.Millisecond, 400*time.Millisecond
	t.Cleanup(func() { socketPingPeriod, socketPongWait = period, wait })

	s, err := New(Options{Enabled: true, DataDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"IDLE", "DEAD"} {
		if _, err := s.Add(AddRequest{ID: id}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Stop)

	dial := func(id string, answersPings bool) <-chan error {
		snap := s.Snapshot()
		d := websocket.Dialer{Subprotocols: []string{"ocpp1.6"}}
		conn, _, err := d.Dial(fmt.Sprintf("ws://127.0.0.1:%d%s/%s", snap.Port, snap.URLPath, id), nil)
		if err != nil {
			t.Fatalf("dial %s: %v", id, err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		if !answersPings {
			conn.SetPingHandler(func(string) error { return nil })
		}
		gone := make(chan error, 1)
		go func() {
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					gone <- err
					return
				}
			}
		}()
		return gone
	}
	idle := dial("IDLE", true)
	dead := dial("DEAD", false)

	select {
	case err := <-idle:
		t.Fatalf("an idle station that answers pings lost its socket: %v", err)
	case <-time.After(5 * socketPongWait):
	}
	if c, _ := s.Snapshot().ChargerByID("IDLE"); !c.Connected {
		t.Fatal("the idle station is shown offline")
	}
	select {
	case <-dead:
	case <-time.After(5 * socketPongWait):
		t.Fatal("a station that answers nothing was never found dead")
	}
}

// TestTheHeartbeatFitsInsideTheReadWait is the other half of W-07: a station
// that keeps to the heartbeat the box hands out is never silent long enough to
// be closed, pongs or not. 300 s against a 60-s read wait was the bug.
func TestTheHeartbeatFitsInsideTheReadWait(t *testing.T) {
	if DefaultHeartbeatInterval > 50*time.Second || DefaultHeartbeatInterval >= socketPongWait {
		t.Fatalf("heartbeat %v must stay at most 50 s and inside the read wait %v",
			DefaultHeartbeatInterval, socketPongWait)
	}
}
