package localbus

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"
)

// freePort reserves an ephemeral port and hands it back, so two buses in the
// same run never collide.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// connectPacket builds a minimal MQTT 3.1.1 CONNECT with a CLEAN session, so
// the broker really REMOVES the client from its map on disconnect - that
// removal is the write that wedges an unguarded shutdown. The test speaks the
// wire itself rather than driving a client library: what has to be timed here
// is the moment a client's server-side read loop ENDS, and a raw socket we
// close on purpose is the only way to place that moment exactly.
func connectPacket(clientID string) []byte {
	id := []byte(clientID)
	payload := make([]byte, 2+len(id))
	binary.BigEndian.PutUint16(payload, uint16(len(id)))
	copy(payload[2:], id)

	variable := []byte{
		0x00, 0x04, 'M', 'Q', 'T', 'T', // protocol name
		0x04,       // protocol level 3.1.1
		0x02,       // clean session
		0x00, 0x3C, // keepalive 60 s
	}
	body := append(variable, payload...)
	return append([]byte{0x10, byte(len(body))}, body...)
}

// attach connects one client and returns only once the broker acknowledged it,
// i.e. once dropping this socket really produces a client-map removal.
func attach(t *testing.T, addr, clientID string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if _, err := conn.Write(connectPacket(clientID)); err != nil {
		_ = conn.Close()
		t.Fatalf("connect: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Read(make([]byte, 4)); err != nil { // CONNACK
		_ = conn.Close()
		t.Fatalf("connack: %v", err)
	}
	conn.SetReadDeadline(time.Time{})
	return conn
}

// shutdownProbe watches the broker's own log for the line it prints at the top
// of its Close() and records, at exactly that instant, whether the listener was
// still accepting connections.
type shutdownProbe struct {
	slog.Handler
	addr string

	mu       sync.Mutex
	saw      bool
	accepted bool
}

func (p *shutdownProbe) Handle(ctx context.Context, r slog.Record) error {
	if r.Message == "gracefully stopping server" {
		accepted := false
		if c, err := net.DialTimeout("tcp", p.addr, 500*time.Millisecond); err == nil {
			accepted = true
			_ = c.Close()
		}
		p.mu.Lock()
		p.saw, p.accepted = true, accepted
		p.mu.Unlock()
	}
	return nil
}

func (p *shutdownProbe) Enabled(context.Context, slog.Level) bool { return true }

func (p *shutdownProbe) result(t *testing.T) bool {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.saw {
		t.Fatal("the broker never logged its shutdown - the probe proved nothing")
	}
	return p.accepted
}

// ⚠ REGRESSION GUARD for the mochi-mqtt shutdown deadlock documented on
// Bus.Close. The whole fix is an ORDERING: shut this listener down OURSELVES
// first, so the library's own Close() finds it already ended (its client walk
// sits behind a CompareAndSwap on that flag) and never reaches the recursive
// read lock that wedges it.
//
// So the ordering is what gets asserted, and it is exactly observable: the
// library logs "gracefully stopping server" as the FIRST thing in its Close(),
// and only closes the net listener further down. Guarded, nothing accepts by
// then; with a bare b.server.Close() the port is still open at that line -
// which is the state in which a dropping client can wedge the shutdown for
// good. Deterministic on purpose: the wedge itself only reproduces when a
// removal lands in a nanosecond-wide window, so testing FOR the hang would be
// a coin flip, while testing for its precondition is not.
func TestCloseShutsTheListenerDownBeforeHandingOverToTheLibrary(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	probe := &shutdownProbe{Handler: slog.NewTextHandler(io.Discard, nil), addr: addr}
	bus, err := Start(addr, slog.New(probe))
	if err != nil {
		t.Fatal(err)
	}
	client := attach(t, addr, "watcher")
	defer client.Close()

	if err := bus.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if probe.result(t) {
		t.Fatal("the listener was STILL accepting when the library began its " +
			"own shutdown - Bus.Close() no longer ends the listener first, so " +
			"the library will walk the client map again and can deadlock " +
			"(see the comment on Bus.Close)")
	}
}

// The liveness property the ordering exists for: a shutdown that overlaps a
// storm of dropping clients must still RETURN. Unlike the guard above this
// cannot fail reliably when the fix is removed (the wedge needs a removal to
// land in that nanosecond window), but when it does fail it fails loudly
// instead of hanging a CI job for ten minutes.
func TestCloseReturnsWhileClientsAreDropping(t *testing.T) {
	const (
		rounds = 4
		pool   = 200
	)
	for round := 0; round < rounds; round++ {
		addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
		bus, err := Start(addr, nil)
		if err != nil {
			t.Fatal(err)
		}
		conns := make([]net.Conn, 0, pool)
		for i := 0; i < pool; i++ {
			conns = append(conns, attach(t, addr, fmt.Sprintf("drop-%d-%d", round, i)))
		}

		// Release every drop and the shutdown together, so Close runs while
		// removals are queuing behind it.
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, c := range conns {
			wg.Add(1)
			go func(c net.Conn) {
				defer wg.Done()
				<-start
				_ = c.Close()
			}(c)
		}
		closed := make(chan error, 1)
		go func() {
			<-start
			closed <- bus.Close()
		}()
		close(start)
		wg.Wait()

		select {
		case err := <-closed:
			if err != nil {
				t.Fatalf("round %d: Close: %v", round, err)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("round %d: Bus.Close() never returned while clients were "+
				"dropping - the mochi shutdown deadlock is back (see the "+
				"comment on Bus.Close)", round)
		}
	}
}

// A quiet bus must still shut down cleanly - the pre-close listener shutdown
// must not turn the ordinary path into an error, and it must really stop the
// listener.
func TestCloseOnAnIdleBus(t *testing.T) {
	addr := fmt.Sprintf("127.0.0.1:%d", freePort(t))
	bus, err := Start(addr, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- bus.Close() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Close: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Close() on an idle bus never returned")
	}
	if c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond); err == nil {
		_ = c.Close()
		t.Fatal("the bus still accepts connections after Close()")
	}
}
