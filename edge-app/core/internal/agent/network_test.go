package agent

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/geraetesuche/suche"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/netinfo"
)

func withNetStore(t *testing.T) *Agent {
	t.Helper()
	return &Agent{net: netinfo.NewStore(t.TempDir())}
}

func TestTheBoxLearnsItsOwnAddressFromTheRequestThatReachedIt(t *testing.T) {
	a := withNetStore(t)
	// Der Kunde tippt seine Adresse - der Browser schreibt sie als Host, und
	// Dockers DNAT kann genau dieses Feld nicht umschreiben.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "http://192.168.254.51:8484/api/state", nil)
	req.Host = "192.168.254.51:8484"
	a.WebObserver(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	})).ServeHTTP(rec, req)

	if rec.Code != http.StatusTeapot {
		t.Fatalf("the observer must not change the response, got %d", rec.Code)
	}
	n := a.networkSummary()
	if n == nil || n.Host != "192.168.254.51:8484" || n.SeenAt == "" {
		t.Fatalf("address not learned: %+v", n)
	}
	if n.ReportedAt == "" {
		t.Fatal("the block must carry its own freshness anchor")
	}
}

func TestConfiguredCustomerLANEndpointSurvivesAVPNServiceVisit(t *testing.T) {
	a := withNetStore(t)
	a.Cfg.LANHost = "192.168.178.42:8484"

	// Support reaches the same web app via WireGuard. That Host header remains
	// useful fallback evidence, but it must never become the customer link.
	req := httptest.NewRequest(http.MethodGet, "http://10.10.1.23:8484/health", nil)
	req.Host = "10.10.1.23:8484"
	a.WebObserver(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), req)

	n := a.networkSummary()
	if n == nil || n.LANHost != "192.168.178.42:8484" {
		t.Fatalf("customer LAN endpoint missing: %+v", n)
	}
	if n.Host != "10.10.1.23:8484" {
		t.Fatalf("observed VPN evidence should stay separate: %+v", n)
	}
}

func TestAHealthCheckOnLoopbackNeverBecomesTheBoxAddress(t *testing.T) {
	a := withNetStore(t)
	// Genau das schickt install.sh bei jedem Start gegen /health.
	req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8484/health", nil)
	req.Host = "127.0.0.1:8484"
	a.WebObserver(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), req)

	if n := a.networkSummary(); n != nil && n.Host != "" {
		t.Fatalf("loopback must never be reported as the box address: %+v", n)
	}
}

func TestABoxThatKnowsNothingSendsNoBlockAtAll(t *testing.T) {
	// Ohne beobachtete Adresse (und im Container ohne Schnittstellen-Adresse)
	// bleibt der Herzschlag BYTE-GLEICH zu vorher - das Portal behaelt seinen
	// ehrlichen Satz „meldet Ihre Box noch nicht" statt einer leeren Behauptung.
	a := withNetStore(t)
	if netinfo.InContainer() {
		if n := a.networkSummary(); n != nil {
			t.Fatalf("no block expected, got %+v", n)
		}
		return
	}
	// Ausserhalb eines Containers darf hoechstens die eigene Schnittstelle
	// stehen - aber niemals eine erfundene erreichte Adresse.
	if n := a.networkSummary(); n != nil && n.Host != "" {
		t.Fatalf("no proven address exists, got %+v", n)
	}
}

func TestTheAddressSurvivesARestartOfTheProcess(t *testing.T) {
	dir := t.TempDir()
	a := &Agent{net: netinfo.NewStore(dir)}
	req := httptest.NewRequest(http.MethodGet, "http://192.168.0.77:8484/", nil)
	req.Host = "192.168.0.77:8484"
	a.WebObserver(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), req)

	if _, err := filepath.Abs(dir); err != nil {
		t.Fatal(err)
	}
	// Ein Neustart darf die Adresse nicht vergessen - sonst waere sie nach
	// jedem Update genau dann unbekannt, wenn jemand sie sucht.
	wieder := &Agent{net: netinfo.NewStore(dir)}
	if n := wieder.networkSummary(); n == nil || n.Host != "192.168.0.77:8484" {
		t.Fatalf("restart lost the address: %+v", n)
	}
}

// ---------------------------------------------------------------------------
// Edge Light: the box runs on the router itself, so it has to detect its own
// customer-network address - and must not hand out the service tunnel's.
// ---------------------------------------------------------------------------

// mangoNetze is the pilot Mango as the field notes describe it: WAN into the
// customer network, br-lan its own WLAN, wg_service the maintenance tunnel.
func mangoNetze(t *testing.T, a *Agent, standardUeber string) {
	t.Helper()
	a.Cfg.BoxArt = geraetesuche.BoxArtEdgeLight
	a.netzSchnittstellen = func() ([]suche.Schnittstelle, error) {
		return []suche.Schnittstelle{
			{Name: "br-lan", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.1.1/24")}},
			{Name: "eth0.2", Prefixe: []netip.Prefix{netip.MustParsePrefix("192.168.178.21/24")}},
			{Name: "wg_service", Prefixe: []netip.Prefix{netip.MustParsePrefix("10.10.1.25/24")}},
		}, nil
	}
	a.netzRouten = func() ([]suche.Route, error) {
		routen := []suche.Route{
			{Schnittstelle: "eth0.2", Ziel: netip.MustParsePrefix("192.168.178.0/24")},
			{Schnittstelle: "br-lan", Ziel: netip.MustParsePrefix("192.168.1.0/24")},
			{Schnittstelle: "wg_service", Ziel: netip.MustParsePrefix("10.10.1.0/24")},
		}
		switch standardUeber {
		case "eth0.2":
			routen = append(routen, suche.Route{Schnittstelle: "eth0.2", Ziel: netip.MustParsePrefix("0.0.0.0/0"),
				Gateway: netip.MustParseAddr("192.168.178.1")})
		case "wg_service":
			routen = append(routen, suche.Route{Schnittstelle: "wg_service", Ziel: netip.MustParsePrefix("0.0.0.0/0")})
		}
		return routen, nil
	}
}

func beobachte(t *testing.T, a *Agent, host string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/state", nil)
	req.Host = host
	a.WebObserver(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).
		ServeHTTP(httptest.NewRecorder(), req)
}

// The bug of 04.11.2026: the portal's "Adresse in der Säule eintragen" showed
// ws://10.10.1.25:8887/ocpp - the tunnel address a technician had opened the
// web app under, which no charge point in the customer network can reach.
// Edge Light never set VP_LAN_HOST, and with several interfaces the box
// withheld its own address, so the observed Host header was all the cloud had.
func TestEdgeLightReportsItsCustomerNetworkAddressNotTheServiceTunnel(t *testing.T) {
	a := withNetStore(t)
	a.Cfg.HTTPAddr = ":8484"
	mangoNetze(t, a, "eth0.2")
	// Support opens http://10.10.1.25:8484 over WireGuard.
	beobachte(t, a, "10.10.1.25:8484")

	n := a.networkSummary()
	if n == nil || n.LANHost != "192.168.178.21:8484" {
		t.Fatalf("the box must report its address in the customer network (WAN side), got %+v", n)
	}
	if n.Host != "" || n.SeenAt != "" {
		t.Fatalf("a call over the box's own tunnel proves nothing about the customer network, got host=%q", n.Host)
	}

	// A customer who opens the web app from the LAN is still proven evidence.
	beobachte(t, a, "192.168.178.21:8484")
	if n := a.networkSummary(); n == nil || n.LANHost != "192.168.178.21:8484" || n.Host != "192.168.178.21:8484" {
		t.Fatalf("LAN call must stay: %+v", n)
	}
}

func TestEdgeLightAnExplicitLANHostStillWins(t *testing.T) {
	a := withNetStore(t)
	a.Cfg.LANHost = "192.168.178.250:8484"
	mangoNetze(t, a, "eth0.2")
	if n := a.networkSummary(); n == nil || n.LANHost != "192.168.178.250:8484" {
		t.Fatalf("VP_LAN_HOST set by hand must win over detection: %+v", n)
	}
}

// Default route into the tunnel (a misconfigured box): WAN and br-lan are both
// left and the box cannot tell which one is the customer's - so it says
// nothing rather than guessing, and the tunnel observation is no substitute.
func TestEdgeLightSaysNothingWhenItCannotTellItsCustomerNetwork(t *testing.T) {
	a := withNetStore(t)
	mangoNetze(t, a, "wg_service")
	beobachte(t, a, "10.10.1.25:8484")
	if n := a.networkSummary(); n != nil && (n.LANHost != "" || n.Host != "") {
		t.Fatalf("no address may be claimed: %+v", n)
	}
}

// The Docker box keeps its rule: the installer's VP_LAN_HOST is the answer and
// the container's interfaces are never read (they are the bridge).
func TestTheDockerBoxDoesNotDetectAnAddressFromItsContainerInterfaces(t *testing.T) {
	a := withNetStore(t)
	mangoNetze(t, a, "eth0.2")
	a.Cfg.BoxArt = geraetesuche.BoxArtDocker
	beobachte(t, a, "10.10.1.23:8484")
	n := a.networkSummary()
	if n == nil || n.LANHost != "" || n.Host != "10.10.1.23:8484" {
		t.Fatalf("Docker box must behave as before: %+v", n)
	}
}
