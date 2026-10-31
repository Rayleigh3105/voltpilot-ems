package agent

// The portal's "Verbindung testen" for a Shelly, over the path the portal
// takes (probe op test_connection -> runProbeTestConnection -> TestConnection
// -> shellyTest). Live-Fall VoltPilotGATE, 31.10.2026: a Shelly Pro 3 on a
// weak WLAN answered every request after 1.5-3.5 s; the box needed three
// requests, its correct answer arrived after the portal's wait, and the
// customer read "Ihre VoltPilot-Box hat nicht rechtzeitig geantwortet".

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/probe"
)

// countingShellyDoer counts the requests the test sends to the device.
type countingShellyDoer struct {
	inner goeHTTPDoer
	n     atomic.Int32
}

func (d *countingShellyDoer) Get(ctx context.Context, u string) (int, []byte, error) {
	d.n.Add(1)
	return d.inner.Get(ctx, u)
}

// pro3Handler answers like the Pro 3 at the VoltPilotGATE: Gen2, three
// non-metering channels; channel 2 is on.
func pro3Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"id":"shellypro3-000000000001","model":"SPSW-003XE16EU","gen":2,` +
				`"ver":"1.4.4","app":"Pro3","auth_en":false,"auth_domain":null}`))
		case "/rpc/Switch.GetStatus":
			id, err := strconv.Atoi(r.URL.Query().Get("id"))
			if err != nil || id < 0 || id > 2 {
				_, _ = w.Write([]byte(`{"code":-105,"message":"Argument 'id' not found!"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "source": "init", "output": id == 2})
		default:
			w.WriteHeader(404)
		}
	})
}

func TestShellyPortalTestPassesInTwoRequests(t *testing.T) {
	srv := httptest.NewServer(pro3Handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)

	for ch := 0; ch <= 2; ch++ {
		a := newGateTestAgent(t)
		doer := &countingShellyDoer{inner: goeHTTPDoer{c: srv.Client()}}
		a.shellyDoer = doer
		conn, _ := json.Marshal(map[string]any{"ip": host, "port": port, "channel": ch})

		// What the portal sends for "Shelly Relais / Schaltaktor".
		line := a.runProbeTestConnection(probe.Op{
			Op: probe.OpTestConnection, ID: "verbindung", Brand: inverter.BrandShelly,
			Model: inverter.FamShellyHTTP, Family: inverter.FamShellyHTTP, Role: "consumer",
			Connection: conn,
		})
		if !line.OK || line.ErrorCode != "" {
			t.Fatalf("channel %d: the Pro 3 answers, the test must pass: %+v", ch, line)
		}
		if line.Reading != nil && line.Reading.LoadKw != nil {
			t.Fatalf("channel %d: a non-metering Shelly must report no load, got %v", ch, *line.Reading.LoadKw)
		}
		// Detection and state from ONE status answer: at 1.5-3.5 s per request
		// on the GATE's WLAN, a third request alone decided whether the answer
		// came in time.
		if got := doer.n.Load(); got != 2 {
			t.Fatalf("channel %d: the test must read the device twice, not %d times", ch, got)
		}
	}
}

func TestShellyPortalTestNamesAnUnknownChannel(t *testing.T) {
	srv := httptest.NewServer(pro3Handler())
	defer srv.Close()
	host, port := splitHostPort(t, srv.URL)
	a := newGateTestAgent(t)
	a.shellyDoer = goeHTTPDoer{c: srv.Client()}
	conn, _ := json.Marshal(map[string]any{"ip": host, "port": port, "channel": 3})

	line := a.runProbeTestConnection(probe.Op{
		Op: probe.OpTestConnection, ID: "verbindung", Brand: inverter.BrandShelly,
		Model: inverter.FamShellyHTTP, Family: inverter.FamShellyHTTP, Role: "consumer",
		Connection: conn,
	})
	if line.OK || line.ErrorCode != probe.ErrInvalidResponse ||
		line.Message != "Diesen Schaltkanal kennt das Gerät nicht (Kanal prüfen)." {
		t.Fatalf("a channel the device lacks must be named: %+v", line)
	}
}
