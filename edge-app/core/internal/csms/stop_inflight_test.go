package csms_test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/gorilla/websocket"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
)

// TestStopWithFramesInFlightRacesNothing: the box stops while a station is
// still sending. The shutdown drain closes the socket and the mux (MiSpeL
// MP-35, #1349) releases the station's lane - but the reader may already hold
// the next frame. Handed back to the library as an error, that frame went into
// the error channel ws.Server.Stop was closing at the same moment (go test
// -race: ws.(*server).error against ws.(*server).Stop; outside the race
// detector a panic on send). The late frame is now dropped. Several rounds,
// because the frame has to land exactly in that window; with errWrongLane
// handed back, the first run already reported the race 14 times and then
// panicked with "send on closed channel".
func TestStopWithFramesInFlightRacesNothing(t *testing.T) {
	for round := 0; round < 25; round++ {
		s, err := csms.New(csms.Options{Enabled: true, DataDir: t.TempDir(), Log: quiet()})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.Add(csms.AddRequest{ID: "FLUT"}); err != nil {
			t.Fatal(err)
		}
		if err := s.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		snap := s.Snapshot()
		dialer := websocket.Dialer{Subprotocols: []string{"ocpp1.6"}}
		conn, _, err := dialer.Dial(fmt.Sprintf("ws://127.0.0.1:%d%s/FLUT", snap.Port, snap.URLPath), nil)
		if err != nil {
			s.Stop()
			t.Fatal(err)
		}
		var station sync.WaitGroup
		station.Add(2)
		answered, readerGone := make(chan struct{}), make(chan struct{})
		go func() { // the station keeps reading so the box's answers never block
			defer station.Done()
			defer close(readerGone)
			var once sync.Once
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
				once.Do(func() { close(answered) })
			}
		}()
		go func() { // ... and keeps sending until its socket is gone
			defer station.Done()
			for n := 0; ; n++ {
				if err := conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`[2,"%d","Heartbeat",{}]`, n))); err != nil {
					return
				}
			}
		}()
		// Stop only once the box has answered a frame: its reader runs, so the
		// frames that follow are really in flight when the drain closes the
		// socket.
		select {
		case <-answered:
		case <-readerGone:
			s.Stop()
			t.Fatal("the box closed the station before answering a frame")
		}
		s.Stop()
		_ = conn.Close()
		station.Wait()
	}
}
