package agent

// S6, second half (vp-edge-light-wlan-konzept §6): a Bekannt device's own
// Wiederfinden (geraetesuche/suche) only reports a moved device under its new
// address; wiederfinden.go is what then keeps the box's OWN reading working -
// durably updating the ONE store the device came from, and learning a MAC for
// a device that does not have one pinned yet. Every test here drives
// wiederfindenTick directly (not the real 2-minute ticker) against a staged,
// injected network - a unit test sends nothing into a real one, the same
// discipline geraetesuche_test.go and network_test.go already keep.

import (
	"context"
	"net"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/config"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/geraetesim"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/suche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

func wfAgent(t *testing.T) *Agent {
	t.Helper()
	cfg := config.Defaults()
	cfg.DataDir = t.TempDir()
	cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Both prechecks and the full sweep wait this long for an ARP answer; a
	// unit test does not need to spend 300 ms real time per device.
	wiederfindenEinzelsondeWartezeit = 5 * time.Millisecond
	t.Cleanup(func() { wiederfindenEinzelsondeWartezeit = 300 * time.Millisecond })
	// The full search's own production pace nudges a /24 at 20/s; against a
	// handful of loopback addresses a unit test can go far faster.
	a.netzTakt = suche.Takt{JeSekunde: 100000, Zeitlimit: time.Second, Nachlauf: 10 * time.Millisecond}
	return a
}

// wfMac parses a literal MAC; panics on a typo in the test itself.
func wfMac(s string) net.HardwareAddr {
	m, err := net.ParseMAC(s)
	if err != nil {
		panic(err)
	}
	return m
}

// wfNetz redirects the search's dialer from a staged "customer" address to
// the real httptest/modbus listener behind it - the same indirection
// geraetesuche/suche's own tests use, reused here because the agent dials
// through the identical a.geraetesucheDial seam.
type wfNetz struct {
	mu    sync.Mutex
	ziele map[string]string
}

func (n *wfNetz) dial(ctx context.Context, addr string) (net.Conn, error) {
	n.mu.Lock()
	ziel, ok := n.ziele[addr]
	n.mu.Unlock()
	if !ok {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", ziel)
}

// wfNetzwerk stages one customer /24 (192.168.178.0/24, the box on .21) with
// the given ARP picture and dial redirection - injected through the SAME
// netzSchnittstellen/netzRouten/netzNachbarn/netzAnstoss/geraetesucheDialer
// seams wiederfinden.go and network.go already define for tests.
func wfNetzwerk(a *Agent, n *wfNetz, arp []suche.Nachbar) {
	a.geraetesucheDialer = n.dial
	a.netzSchnittstellen = func() ([]suche.Schnittstelle, error) {
		return []suche.Schnittstelle{
			{Name: "eth0", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/24")}},
		}, nil
	}
	a.netzRouten = func() ([]suche.Route, error) {
		return []suche.Route{{Schnittstelle: "eth0", Ziel: netip.MustParsePrefix("0.0.0.0/0"),
			Gateway: netip.MustParseAddr("192.168.178.1")}}, nil
	}
	a.netzNachbarn = func() ([]suche.Nachbar, error) { return arp, nil }
	a.netzAnstoss = func(_ context.Context, _ netip.Addr) error { return nil }
}

func shellyAddr(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	return strings.TrimPrefix(srv.URL, "http://")
}

// pinSourceMAC simulates "the box already learned this MAC in an earlier
// run": shelly_http's own normalizeConn does not yet accept a MAC at setup
// (only ebyte_modbus_tcp and, since this change, huawei_modbus/kaco_serial
// do - CommShellyHTTP is not part of this slice), so a test staging an
// ALREADY-pinned shelly writes it directly into the store, exactly like
// wiederfindenLernen itself would have after the device's first tick.
func pinSourceMAC(t *testing.T, a *Agent, id, mac string) {
	t.Helper()
	a.srcMu.Lock()
	idx := -1
	for i := range a.srcs {
		if a.srcs[i].ID == id {
			idx = i
			break
		}
	}
	if idx < 0 {
		a.srcMu.Unlock()
		t.Fatalf("source %s not found", id)
	}
	a.srcs[idx].Connection.MAC = mac
	list := append([]sources.Source(nil), a.srcs...)
	a.srcMu.Unlock()
	if err := a.srcStore.Save(list); err != nil {
		t.Fatal(err)
	}
}

func findSource(t *testing.T, a *Agent, id string) sources.Source {
	t.Helper()
	for _, s := range a.ListSources() {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("source %s not found", id)
	return sources.Source{}
}

// TestWiederfindenLerntMACAmErfolgreichenLesen: a source configured before
// this feature existed carries no MAC. The watchdog learns it from this
// run's ARP picture at the device's OWN configured address (never elsewhere -
// learning never triggers a search) and persists it.
func TestWiederfindenLerntMACAmErfolgreichenLesen(t *testing.T) {
	a := wfAgent(t)
	src, err := a.AddSource(sources.Request{Role: sources.RoleConsumer, Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Connection: inverter.Connection{IP: "192.168.178.50", Port: 80}})
	if err != nil {
		t.Fatal(err)
	}
	n := &wfNetz{ziele: map[string]string{}}
	wfNetzwerk(a, n, []suche.Nachbar{
		{IP: netip.MustParseAddr("192.168.178.50"), MAC: wfMac("00:11:22:aa:bb:10"), Schnittstelle: "eth0"},
	})

	a.wiederfindenTick(context.Background())

	got := findSource(t, a, src.ID)
	if got.Connection.MAC != "00:11:22:aa:bb:10" {
		t.Fatalf("MAC not learned: %+v", got.Connection)
	}
	// Durable: reload from disk, not only the in-memory copy.
	list, _, err := a.srcStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Connection.MAC != "00:11:22:aa:bb:10" {
		t.Fatalf("MAC not persisted to disk: %+v", list)
	}
}

// TestWiederfindenUebernimmtNeueAdresseUndLiestWeiter: the configured address
// went silent; the pinned MAC answers under a new one, and the normal search
// pass confirms a genuine Shelly there. The box adopts it durably.
func TestWiederfindenUebernimmtNeueAdresseUndLiestWeiter(t *testing.T) {
	a := wfAgent(t)
	src, err := a.AddSource(sources.Request{Role: sources.RoleConsumer, Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Connection: inverter.Connection{IP: "192.168.178.50", Port: 80}})
	if err != nil {
		t.Fatal(err)
	}
	pinSourceMAC(t, a, src.ID, "00:11:22:aa:bb:10")
	srv := httptest.NewServer(geraetesim.ShellyGen2(&geraetesim.Protokoll{}, "SPSW-003XE16EU", "1.4.4", 1, false, false))
	defer srv.Close()
	n := &wfNetz{ziele: map[string]string{"192.168.178.51:80": shellyAddr(t, srv)}}
	wfNetzwerk(a, n, []suche.Nachbar{
		// .50 (the configured address) is silent; the SAME mac answers at .51.
		{IP: netip.MustParseAddr("192.168.178.51"), MAC: wfMac("00:11:22:aa:bb:10"), Schnittstelle: "eth0"},
	})

	a.wiederfindenTick(context.Background())

	got := findSource(t, a, src.ID)
	if got.Connection.IP != "192.168.178.51" {
		t.Fatalf("address not adopted: %+v", got.Connection)
	}
	list, _, err := a.srcStore.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Connection.IP != "192.168.178.51" {
		t.Fatalf("new address not persisted to disk: %+v", list)
	}
}

// TestWiederfindenFremdesGeraetAnAlterAdresseAendertNichts: a different MAC
// now answers at the configured address, and the pinned one is nowhere else
// in this run's ARP picture. Nothing is adopted - the configured address
// stays exactly as it was rather than silently trusting whatever is there now.
func TestWiederfindenFremdesGeraetAnAlterAdresseAendertNichts(t *testing.T) {
	a := wfAgent(t)
	src, err := a.AddSource(sources.Request{Role: sources.RoleConsumer, Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Connection: inverter.Connection{IP: "192.168.178.50", Port: 80}})
	if err != nil {
		t.Fatal(err)
	}
	pinSourceMAC(t, a, src.ID, "00:11:22:aa:bb:10")
	srv := httptest.NewServer(geraetesim.ShellyGen2(&geraetesim.Protokoll{}, "SPSW-003XE16EU", "1.4.4", 1, false, false))
	defer srv.Close()
	n := &wfNetz{ziele: map[string]string{"192.168.178.50:80": shellyAddr(t, srv)}}
	wfNetzwerk(a, n, []suche.Nachbar{
		// A foreign device, not the configured source's MAC, sits at .50 now.
		{IP: netip.MustParseAddr("192.168.178.50"), MAC: wfMac("00:11:22:aa:bb:99"), Schnittstelle: "eth0"},
	})

	a.wiederfindenTick(context.Background())

	got := findSource(t, a, src.ID)
	if got.Connection.IP != "192.168.178.50" || got.Connection.MAC != "00:11:22:aa:bb:10" {
		t.Fatalf("configuration must stay untouched: %+v", got.Connection)
	}
}

// TestWiederfindenGeraetAntwortetNichtAendertNichts: the device answers
// nowhere at all. Nothing is adopted; the stale configuration is left as a
// visible gap (the device search's own report, not this watchdog, is what
// surfaces the missing device) rather than papered over.
func TestWiederfindenGeraetAntwortetNichtAendertNichts(t *testing.T) {
	a := wfAgent(t)
	src, err := a.AddSource(sources.Request{Role: sources.RoleConsumer, Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Connection: inverter.Connection{IP: "192.168.178.50", Port: 80}})
	if err != nil {
		t.Fatal(err)
	}
	pinSourceMAC(t, a, src.ID, "00:11:22:aa:bb:10")
	n := &wfNetz{ziele: map[string]string{}}
	wfNetzwerk(a, n, []suche.Nachbar{
		{IP: netip.MustParseAddr("192.168.178.90"), MAC: wfMac("00:11:22:aa:bb:99"), Schnittstelle: "eth0"},
	})

	a.wiederfindenTick(context.Background())

	got := findSource(t, a, src.ID)
	if got.Connection.IP != "192.168.178.50" {
		t.Fatalf("configuration must stay untouched: %+v", got.Connection)
	}
}

// TestWiederfindenZweiGeraeteTauschenAdressen: two configured sources of the
// SAME communication swap addresses (a router handing out new leases on a
// reboot). Each is confirmed by its OWN MAC under the other's former
// address - never cross-wired, even though both are Shelly devices.
func TestWiederfindenZweiGeraeteTauschenAdressen(t *testing.T) {
	a := wfAgent(t)
	srcA, err := a.AddSource(sources.Request{Role: sources.RoleConsumer, Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Connection: inverter.Connection{IP: "192.168.178.50", Port: 80}})
	if err != nil {
		t.Fatal(err)
	}
	pinSourceMAC(t, a, srcA.ID, "00:11:22:aa:bb:10")
	srcB, err := a.AddSource(sources.Request{Role: sources.RoleConsumer, Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Connection: inverter.Connection{IP: "192.168.178.51", Port: 80}})
	if err != nil {
		t.Fatal(err)
	}
	pinSourceMAC(t, a, srcB.ID, "00:11:22:aa:bb:20")
	srvA := httptest.NewServer(geraetesim.ShellyGen2(&geraetesim.Protokoll{}, "SPSW-003XE16EU", "1.4.4", 1, false, false))
	defer srvA.Close()
	srvB := httptest.NewServer(geraetesim.ShellyGen2(&geraetesim.Protokoll{}, "SPSW-003XE16EU", "1.4.4", 2, false, false))
	defer srvB.Close()
	// A and B swapped addresses: the .50 slot now answers as B's http stand-in
	// and the .51 slot as A's.
	n := &wfNetz{ziele: map[string]string{
		"192.168.178.50:80": shellyAddr(t, srvB),
		"192.168.178.51:80": shellyAddr(t, srvA),
	}}
	wfNetzwerk(a, n, []suche.Nachbar{
		{IP: netip.MustParseAddr("192.168.178.50"), MAC: wfMac("00:11:22:aa:bb:20"), Schnittstelle: "eth0"},
		{IP: netip.MustParseAddr("192.168.178.51"), MAC: wfMac("00:11:22:aa:bb:10"), Schnittstelle: "eth0"},
	})

	a.wiederfindenTick(context.Background())

	gotA := findSource(t, a, srcA.ID)
	if gotA.Connection.IP != "192.168.178.51" {
		t.Fatalf("A must follow its OWN mac to .51: %+v", gotA.Connection)
	}
	gotB := findSource(t, a, srcB.ID)
	if gotB.Connection.IP != "192.168.178.50" {
		t.Fatalf("B must follow its OWN mac to .50: %+v", gotB.Connection)
	}
}

// TestWiederfindenUebernimmtAdresseDesHauptwechselrichters proves the SAME
// mechanism also drives the ONE inverter selection (not only additional
// sources) - the actual customer path (a Huawei dongle, communication
// huawei_modbus) rather than a Verbraucher.
func TestWiederfindenUebernimmtAdresseDesHauptwechselrichters(t *testing.T) {
	a := wfAgent(t)
	mb, err := geraetesim.StartModbus("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer mb.Close()
	mb.SetzeText(1, 30000, 15, "SUN2000-3KTL-M1")
	mb.SetzeText(1, 30015, 10, "2102xxxxxx")

	if _, err := a.SetInverter(inverter.SelectionRequest{Brand: inverter.BrandHuawei, Model: "sun2000-m1",
		Connection: inverter.Connection{IP: "192.168.178.40", Port: 502, MAC: "00:11:22:aa:bb:30"}}); err != nil {
		t.Fatalf("SetInverter abgelehnt: %v", err)
	}
	n := &wfNetz{ziele: map[string]string{"192.168.178.41:502": mb.Addr()}}
	wfNetzwerk(a, n, []suche.Nachbar{
		{IP: netip.MustParseAddr("192.168.178.41"), MAC: wfMac("00:11:22:aa:bb:30"), Schnittstelle: "eth0"},
	})

	a.wiederfindenTick(context.Background())

	sel, ok, err := a.invStore.Load()
	if err != nil || !ok {
		t.Fatalf("inverter selection unavailable: %v %v", ok, err)
	}
	if sel.Connection.IP != "192.168.178.41" {
		t.Fatalf("inverter address not adopted: %+v", sel.Connection)
	}
}
