package agent

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

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
