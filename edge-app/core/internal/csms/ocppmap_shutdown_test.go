package csms

import (
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"sync"
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

type blockingShutdownServer struct {
	ws.Server
	entered     chan struct{}
	release     chan struct{}
	returned    chan struct{}
	enterOnce   sync.Once
	releaseOnce sync.Once
	returnOnce  sync.Once
}

func newBlockingShutdownServer() *blockingShutdownServer {
	return &blockingShutdownServer{
		entered: make(chan struct{}), release: make(chan struct{}), returned: make(chan struct{}),
	}
}

func (s *blockingShutdownServer) GetChannel(string) (ws.Channel, bool) {
	return stuckShutdownChannel{}, true
}

func (s *blockingShutdownServer) StopConnection(string, websocket.CloseError) error {
	s.enterOnce.Do(func() { close(s.entered) })
	<-s.release
	s.returnOnce.Do(func() { close(s.returned) })
	return nil
}

func (s *blockingShutdownServer) unblock() { s.releaseOnce.Do(func() { close(s.release) }) }

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

func TestTransportStopBoundsBlockingDependencyCloseAndJoinsItAfterFallback(t *testing.T) {
	const limit = 20 * time.Millisecond
	done := make(chan struct{})
	close(done)
	dependency := newBlockingShutdownServer()
	var stopped atomic.Bool
	var fallbackSawBlocked atomic.Bool
	tpt := &transport{
		srv: &Server{
			chargers: map[string]*ChargerState{"STUCK": {}},
			log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		wsrv: dependency, done: done, drainTimeout: limit,
		stopServer: func() {
			stopped.Store(true)
			select {
			case <-dependency.entered:
				select {
				case <-dependency.returned:
				default:
					fallbackSawBlocked.Store(true)
				}
			default:
			}
			dependency.unblock()
		},
	}

	stopDone := make(chan struct{})
	started := time.Now()
	go func() {
		tpt.stop()
		close(stopDone)
	}()
	select {
	case <-stopDone:
	case <-time.After(10 * limit):
		dependency.unblock() // clean up the old synchronous implementation
		<-stopDone
		t.Fatalf("transport stop stayed blocked in StopConnection for %s", time.Since(started))
	}
	if !stopped.Load() {
		t.Fatal("synchronized dependency fallback was not invoked")
	}
	if !fallbackSawBlocked.Load() {
		t.Fatal("dependency close was not demonstrably blocked when fallback took over")
	}
	select {
	case <-dependency.entered:
	default:
		t.Fatal("blocking dependency close was never attempted")
	}
	select {
	case <-dependency.returned:
	default:
		t.Fatal("transport returned without joining the dependency close worker")
	}
}
