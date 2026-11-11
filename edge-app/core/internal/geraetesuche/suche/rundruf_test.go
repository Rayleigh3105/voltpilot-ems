package suche

import (
	"context"
	"net"
	"testing"
	"time"
)

// Speedwire says whether it listened, like mDNS and SSDP (VoltPilotGATE
// 30.10.2026: "not searched" and "nothing there" looked the same). A socket
// that cannot open is no way that ran; one that opens is.
func TestSpeedwireMeldetObEsLief(t *testing.T) {
	ctx, ende := context.WithCancel(context.Background())
	ende()
	if speedwireHoeren(ctx, &net.Interface{Index: 1 << 20, Name: "gibtsnicht0"}, nil) {
		t.Fatal("listened on an interface that does not exist")
	}
	ifis, err := net.Interfaces()
	if err != nil {
		t.Skip(err)
	}
	for _, ifi := range ifis {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagMulticast == 0 || !ipv4Von(&ifi).IsValid() {
			continue
		}
		if !speedwireHoeren(ctx, &ifi, nil) {
			continue
		}
		hoer, ende := context.WithTimeout(context.Background(), 50*time.Millisecond)
		a := SystemRundruf{}.Hoeren(hoer, []string{ifi.Name}, []string{"speedwire"})
		ende()
		if !enthaelt(a.Wege, "speedwire") {
			t.Fatalf("%s: the socket opens, but the way is not reported: %v", ifi.Name, a.Wege)
		}
		return
	}
	t.Skip("no interface here opens the Speedwire multicast socket")
}
