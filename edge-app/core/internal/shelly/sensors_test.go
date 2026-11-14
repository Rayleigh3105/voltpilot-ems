package shelly

// Steuerlogik-Konzept Stufe 1: staged Shelly answers for every scenario the
// firstmate build order names - a sensor present, a sensor missing, the
// add-on module absent entirely, and several sensors at once. The real
// hardware proof (an actual Shelly + add-on at a prüfstand) belongs in the
// PR text, not here.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
)

func sensorConfig(t *testing.T, srv *httptest.Server) Config {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	return Config{IP: u.Hostname(), Port: port}
}

func tempC(v float64) *float64 { return &v }

// --- Gen2: a sensor-only Shelly (nothing switches) with a Plus Add-on ---

func gen2SensorServer(body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"name":null,"id":"shellyplusaddon-0c0000000001","mac":"0C0000000001",` +
				`"slot":1,"model":"SNSN-0043X","gen":2,"fw_id":"20241011-114451/1.4.4-g6d2a586",` +
				`"ver":"1.4.4","app":"PlusAddOn","auth_en":false,"auth_domain":null}`))
		case "/rpc/Shelly.GetStatus":
			_, _ = w.Write([]byte(body))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestDetectSensorsGen2OneTemperaturePresent(t *testing.T) {
	srv := gen2SensorServer(`{"temperature:100":{"id":100,"tC":21.6,"tF":70.9},"sys":{"restart_required":false}}`)
	defer srv.Close()
	ident, st, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err != nil {
		t.Fatalf("DetectSensors: %v", err)
	}
	if ident.Gen != Gen2 {
		t.Fatalf("gen = %d, want 2", ident.Gen)
	}
	if len(st.Temperatures) != 1 || st.Temperatures[0].ID != 100 || *st.Temperatures[0].TempC != 21.6 {
		t.Fatalf("temperatures = %+v", st.Temperatures)
	}
}

// A probe the device names but could not read: tC is JSON null, never a
// fabricated value - "fehlend ist keine Null".
func TestReadSensorsGen2TemperatureMissingStaysNil(t *testing.T) {
	srv := gen2SensorServer(`{"temperature:100":{"id":100,"tC":null,"tF":null,"errors":["read"]}}`)
	defer srv.Close()
	ident := Identity{Gen: Gen2}
	st, de := ReadSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv), ident)
	if de != nil {
		t.Fatalf("ReadSensors: %v", de)
	}
	if len(st.Temperatures) != 1 || st.Temperatures[0].ID != 100 || st.Temperatures[0].TempC != nil {
		t.Fatalf("temperatures = %+v, want one entry with a nil value", st.Temperatures)
	}
}

// The add-on module is absent entirely: no temperature:*/input:* keys at
// all, never an invented sensor.
func TestDetectSensorsGen2NoAddonModule(t *testing.T) {
	srv := gen2SensorServer(`{"switch:0":{"id":0,"output":false},"sys":{"restart_required":false}}`)
	defer srv.Close()
	_, st, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err != nil {
		t.Fatalf("DetectSensors: %v", err)
	}
	if len(st.Temperatures) != 0 || len(st.Inputs) != 0 {
		t.Fatalf("expected no sensors, got %+v", st)
	}
}

// Several sensors at once, in whatever order Shelly.GetStatus names them:
// two temperature probes and a digital input, sorted by component id.
func TestDetectSensorsGen2MultipleSensors(t *testing.T) {
	srv := gen2SensorServer(`{"temperature:101":{"id":101,"tC":18.2},"input:100":{"id":100,"state":true},` +
		`"temperature:100":{"id":100,"tC":22.4}}`)
	defer srv.Close()
	_, st, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err != nil {
		t.Fatalf("DetectSensors: %v", err)
	}
	if len(st.Temperatures) != 2 || st.Temperatures[0].ID != 100 || st.Temperatures[1].ID != 101 {
		t.Fatalf("temperatures = %+v", st.Temperatures)
	}
	if *st.Temperatures[0].TempC != 22.4 || *st.Temperatures[1].TempC != 18.2 {
		t.Fatalf("temperature values = %+v", st.Temperatures)
	}
	if len(st.Inputs) != 1 || st.Inputs[0].ID != 100 || st.Inputs[0].On == nil || !*st.Inputs[0].On {
		t.Fatalf("inputs = %+v", st.Inputs)
	}
}

func TestDetectSensorsGen2PasswordProtectedRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"gen":2,"model":"SNSN-0043X","auth_en":true}`))
	}))
	defer srv.Close()
	_, _, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err == nil {
		t.Fatal("expected a refusal for a password-protected device")
	}
}

// --- Gen1: a Shelly1 with a DS1820 temperature add-on ---

func gen1SensorServer(body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"type":"SHSW-1","mac":"EC0000000001","auth":false}`))
		case "/status":
			_, _ = w.Write([]byte(body))
		default:
			w.WriteHeader(404)
		}
	}))
}

func TestDetectSensorsGen1OneProbePresent(t *testing.T) {
	srv := gen1SensorServer(`{"relays":[{"ison":false}],"ext_temperature":{"0":{"hwID":"28FF0001","tC":34.1}}}`)
	defer srv.Close()
	ident, st, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err != nil {
		t.Fatalf("DetectSensors: %v", err)
	}
	if ident.Gen != Gen1 {
		t.Fatalf("gen = %d, want 1", ident.Gen)
	}
	if len(st.Temperatures) != 1 || st.Temperatures[0].ID != 0 || *st.Temperatures[0].TempC != 34.1 {
		t.Fatalf("temperatures = %+v", st.Temperatures)
	}
}

// The device's own invalid marker (999, pinned docs: "reports temperature in
// °C, 999 if invalid") must become a missing value, never a 999° reading.
func TestReadSensorsGen1InvalidProbeBecomesMissing(t *testing.T) {
	srv := gen1SensorServer(`{"relays":[{"ison":false}],"ext_temperature":{"0":{"hwID":"28FF0001","tC":999}}}`)
	defer srv.Close()
	st, de := ReadSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv), Identity{Gen: Gen1})
	if de != nil {
		t.Fatalf("ReadSensors: %v", de)
	}
	if len(st.Temperatures) != 1 || st.Temperatures[0].TempC != nil {
		t.Fatalf("temperatures = %+v, want one entry with a nil value", st.Temperatures)
	}
}

func TestDetectSensorsGen1NoAddonModule(t *testing.T) {
	srv := gen1SensorServer(`{"relays":[{"ison":false}]}`)
	defer srv.Close()
	_, st, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err != nil {
		t.Fatalf("DetectSensors: %v", err)
	}
	if len(st.Temperatures) != 0 {
		t.Fatalf("expected no sensors, got %+v", st.Temperatures)
	}
}

func TestDetectSensorsGen1ThreeProbes(t *testing.T) {
	srv := gen1SensorServer(`{"relays":[{"ison":false}],"ext_temperature":{` +
		`"0":{"hwID":"A","tC":10},"1":{"hwID":"B","tC":11},"2":{"hwID":"C","tC":999}}}`)
	defer srv.Close()
	_, st, err := DetectSensors(context.Background(), srvDoer{srv.Client()}, sensorConfig(t, srv))
	if err != nil {
		t.Fatalf("DetectSensors: %v", err)
	}
	if len(st.Temperatures) != 3 {
		t.Fatalf("temperatures = %+v, want 3 probes", st.Temperatures)
	}
	for i, want := range []*float64{tempC(10), tempC(11), nil} {
		got := st.Temperatures[i].TempC
		if (want == nil) != (got == nil) || (want != nil && *want != *got) {
			t.Fatalf("probe %d = %v, want %v", i, got, want)
		}
	}
}

func TestDetectSensorsUnreachable(t *testing.T) {
	_, _, err := DetectSensors(context.Background(), srvDoer{http.DefaultClient},
		Config{IP: "127.0.0.1", Port: 1})
	if err == nil {
		t.Fatal("expected an unreachable error")
	}
}
