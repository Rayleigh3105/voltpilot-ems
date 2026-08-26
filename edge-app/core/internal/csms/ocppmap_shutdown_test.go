package csms

import (
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/lorenzodonini/ocpp-go/ws"
)

type stuckShutdownServer struct {
	ws.Server
	stopRequests atomic.Int32
}

func (s *stuckShutdownServer) GetChannel(string) (ws.Channel, bool) {
	return stuckShutdownChannel{}, true
}

func (s *stuckShutdownServer) StopConnection(string, websocket.CloseError) error {
	s.stopRequests.Add(1)
	return nil
}

type stuckShutdownChannel struct{}

func (stuckShutdownChannel) ID() string                               { return "STUCK" }
func (stuckShutdownChannel) RemoteAddr() net.Addr                     { return nil }
func (stuckShutdownChannel) TLSConnectionState() *tls.ConnectionState { return nil }
func (stuckShutdownChannel) IsConnected() bool                        { return true }

func TestTransportStopIsBoundedWhenDependencyNeverRemovesChannel(t *testing.T) {
	const limit = 25 * time.Millisecond
	done := make(chan struct{})
	close(done)
	dependency := &stuckShutdownServer{}
	var stopped atomic.Bool
	tpt := &transport{
		srv: &Server{
			chargers: map[string]*ChargerState{"STUCK": {}},
			log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		wsrv: dependency, done: done, drainTimeout: limit,
		stopServer: func() { stopped.Store(true) },
	}

	started := time.Now()
	tpt.stop()
	elapsed := time.Since(started)
	if elapsed > 10*limit {
		t.Fatalf("transport stop took %s, want bounded near %s", elapsed, limit)
	}
	if !stopped.Load() {
		t.Fatal("synchronized dependency fallback was not invoked")
	}
	if dependency.stopRequests.Load() == 0 {
		t.Fatal("drain never attempted to close the stuck channel")
	}
}
