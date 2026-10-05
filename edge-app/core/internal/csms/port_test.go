package csms

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"syscall"
	"testing"
)

// takenPort binds a TCP port on the IPv6 wildcard WITHOUT listening on it -
// the way a dual-stack socket of another process (a container port mapping
// of Docker Desktop, say) holds it. The library's own bind on that port then
// fails and the readiness dial is refused: exactly what Start meets when the
// port was taken between freePort's probe and the library's bind.
func takenPort(t *testing.T) int {
	t.Helper()
	fd, err := syscall.Socket(syscall.AF_INET6, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Close(fd) })
	if err := syscall.Bind(fd, &syscall.SockaddrInet6{}); err != nil {
		t.Fatal(err)
	}
	sa, err := syscall.Getsockname(fd)
	if err != nil {
		t.Fatal(err)
	}
	return sa.(*syscall.SockaddrInet6).Port
}

func TestStartPicksAgainWhenTheFreePortWasTakenMeanwhile(t *testing.T) {
	taken := takenPort(t)
	picks := 0
	pickFreePort = func() (int, error) {
		picks++
		if picks == 1 {
			return taken, nil
		}
		return freePort()
	}
	t.Cleanup(func() { pickFreePort = freePort })
	s, err := New(Options{Enabled: true, DataDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(s.Stop)
	snap := s.Snapshot()
	if picks != 2 || !snap.Listening || snap.Port == taken {
		t.Fatalf("picks %d, listening %v on %d (taken %d)", picks, snap.Listening, snap.Port, taken)
	}
}

func TestStartOnATakenConfiguredPortFailsAsBefore(t *testing.T) {
	taken := takenPort(t)
	s, err := New(Options{Enabled: true, Port: taken, DataDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Stop)
	err = s.Start(context.Background())
	if err == nil || !strings.HasSuffix(err.Error(), "konnte nicht gestartet werden (Port belegt?)") {
		t.Fatalf("configured taken port: %v", err)
	}
	if snap := s.Snapshot(); snap.Listening || snap.Port != taken {
		t.Fatalf("snapshot after a failed start: %+v", snap)
	}
}
