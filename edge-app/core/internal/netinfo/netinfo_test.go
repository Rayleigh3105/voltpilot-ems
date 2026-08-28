package netinfo

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAcceptHostTakesOnlyAnAddressSomeoneElseCanType(t *testing.T) {
	ok := []struct{ in, want string }{
		{"192.168.254.51:8484", "192.168.254.51:8484"},
		{"192.168.254.51", "192.168.254.51"},
		{"voltpilot.local:8484", "voltpilot.local:8484"},
		{"[fd00::1]:8484", "[fd00::1]:8484"},
	}
	for _, c := range ok {
		got, accepted := AcceptHost(c.in)
		if !accepted || got != c.want {
			t.Fatalf("AcceptHost(%q) = %q,%v; want %q,true", c.in, got, accepted, c.want)
		}
	}
	// Rejected: nothing here is an address a second person could open.
	for _, bad := range []string{
		"", "   ", "localhost:8484", "127.0.0.1:8484", "[::1]:8484", "0.0.0.0:8484",
		"voltpilot", "voltpilot:8484",
	} {
		if got, accepted := AcceptHost(bad); accepted {
			t.Fatalf("AcceptHost(%q) accepted as %q - it is not a reachable address", bad, got)
		}
	}
}

func TestConfiguredLANHostMustBeAProvablyLocalEndpoint(t *testing.T) {
	for _, c := range []string{
		"192.168.178.42:8484", "10.0.7.19:8484", "[fd00::5]:8484", "box.home.arpa:8484",
	} {
		if got, ok := AcceptLANHost(c); !ok || got != c {
			t.Fatalf("AcceptLANHost(%q) = %q,%v", c, got, ok)
		}
	}
	for _, bad := range []string{
		"8.8.8.8:8484", "portal.voltpilot.de:8484", "127.0.0.1:8484", "voltpilot:8484",
	} {
		if got, ok := AcceptLANHost(bad); ok {
			t.Fatalf("AcceptLANHost(%q) accepted as %q", bad, got)
		}
	}
}

func TestObservedAddressSurvivesARestartAndIsForgottenWhenStale(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 8, 21, 9, 12, 0, 0, time.UTC)

	s := NewStore(dir)
	if !s.Observe("192.168.254.51:8484", now) {
		t.Fatal("a real Host header must be recorded")
	}
	if err := s.Persist(); err != nil {
		t.Fatalf("persist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "network.json")); err != nil {
		t.Fatalf("network.json missing: %v", err)
	}

	// Ein Neustart vergisst die Adresse NICHT - sonst wäre sie genau nach dem
	// Update wieder unbekannt, also genau dann, wenn jemand sie sucht.
	wieder := NewStore(dir)
	got := wieder.Snapshot(now.Add(time.Hour))
	if got.Host != "192.168.254.51:8484" || got.SeenAt.IsZero() {
		t.Fatalf("restart lost the observation: %+v", got)
	}

	// Nach zwei Wochen ist sie nicht mehr glaubwürdig - eine falsche Adresse
	// ist schlimmer als keine.
	alt := wieder.Snapshot(now.Add(30 * 24 * time.Hour))
	if alt.Host != "" || !alt.SeenAt.IsZero() {
		t.Fatalf("a stale address must be dropped, got %+v", alt)
	}
}

func TestALoopbackRequestNeverBecomesTheBoxAddress(t *testing.T) {
	s := NewStore(t.TempDir())
	now := time.Now()
	// Genau das schickt der Installateur-Selbsttest bei jedem Start.
	if s.Observe("127.0.0.1:8484", now) {
		t.Fatal("loopback must not be recorded")
	}
	got := s.Snapshot(now)
	if got.Host != "" {
		t.Fatalf("nothing may be claimed, got %+v", got)
	}
	if !InContainer() && !got.Empty() {
		// Ausserhalb eines Containers darf hoechstens die Schnittstelle stehen -
		// aber niemals die Loopback-Anfrage.
		if got.Host != "" {
			t.Fatal("a loopback request must never become the box address")
		}
	}
}

func TestTheNewestProvenAddressWins(t *testing.T) {
	s := NewStore(t.TempDir())
	base := time.Date(2026, 8, 21, 9, 0, 0, 0, time.UTC)
	s.Observe("192.168.0.10:8484", base)
	s.Observe("192.168.0.77:8484", base.Add(2*time.Hour))
	if got := s.Snapshot(base.Add(3 * time.Hour)); got.Host != "192.168.0.77:8484" {
		t.Fatalf("newest address must win, got %q", got.Host)
	}
}

func TestInterfaceIsNeverReportedInAContainer(t *testing.T) {
	// Die Regel ist eine Eigenschaft von Snapshot: in einem Container wird die
	// Schnittstellen-Adresse GAR NICHT erst gelesen, weil sie dort die
	// Bridge-Adresse ist - nutzlos für den Kunden und damit eine erfundene
	// Antwort auf „wie erreiche ich meine Box".
	s := NewStore(t.TempDir())
	now := time.Now()
	s.Observe("192.168.254.51:8484", now)
	got := s.Snapshot(now)
	if InContainer() && (got.IP != "" || got.Iface != "") {
		t.Fatalf("in a container no interface address may be reported, got %+v", got)
	}
	if got.Host == "" {
		t.Fatal("the proven address must be reported in either case")
	}
}
