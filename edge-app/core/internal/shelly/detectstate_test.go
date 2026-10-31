package shelly

// DetectState: the connection test's detection + state read in TWO requests
// (Live-Fall VoltPilotGATE, 31.10.2026: a Shelly Pro 3 on a weak WLAN needed
// 1.5-3.5 s per request, and the third, redundant read pushed the box's answer
// past the portal's wait - "Ihre VoltPilot-Box hat nicht rechtzeitig
// geantwortet" for a device that worked).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
)

// countingDoer counts the HTTP requests a call sends to the device.
type countingDoer struct {
	inner Doer
	n     atomic.Int32
}

func (d *countingDoer) Get(ctx context.Context, u string) (int, []byte, error) {
	d.n.Add(1)
	return d.inner.Get(ctx, u)
}

// fakePro3 answers like the Shelly Pro 3 at the VoltPilotGATE (firmware
// 1.4.4): three switch channels, no metering, the /shelly and
// Switch.GetStatus bodies as the device sent them (id and MAC replaced).
type fakePro3 struct {
	mu sync.Mutex
	on [3]bool
}

func (f *fakePro3) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"name":null,"id":"shellypro3-000000000001","mac":"000000000001","slot":1,` +
				`"model":"SPSW-003XE16EU","gen":2,"fw_id":"20241011-114451/1.4.4-g6d2a586","ver":"1.4.4",` +
				`"app":"Pro3","auth_en":false,"auth_domain":null}`))
		case "/rpc/Switch.GetStatus":
			id, err := strconv.Atoi(r.URL.Query().Get("id"))
			if err != nil || id < 0 || id > 2 {
				_, _ = w.Write([]byte(`{"code":-105,"message":"Argument 'id', value 3 not found!"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": id, "source": "init", "output": f.on[id],
				"temperature": map[string]any{"tC": 33.2, "tF": 91.8},
			})
		default:
			w.WriteHeader(404)
		}
	})
}

func TestDetectStateReadsTwiceAndAgreesWithDetectPlusReadState(t *testing.T) {
	type device struct {
		name    string
		handler func(on bool) http.Handler
	}
	devices := []device{
		{"gen2 metering", func(on bool) http.Handler {
			return (&fakeGen2{metering: true, apowerW: 2980, on: on}).handler()
		}},
		{"gen2 plain", func(on bool) http.Handler { return (&fakeGen2{on: on}).handler() }},
		{"gen1 metering", func(on bool) http.Handler {
			return (&fakeGen1{metering: true, powerW: 2980, on: on}).handler()
		}},
		{"gen1 plain", func(on bool) http.Handler { return (&fakeGen1{on: on}).handler() }},
		{"pro3", func(on bool) http.Handler { return (&fakePro3{on: [3]bool{on, false, false}}).handler() }},
	}
	for _, d := range devices {
		for _, on := range []bool{false, true} {
			srv := httptest.NewServer(d.handler(on))
			cfg := cfgFor(t, srv)
			doer := &countingDoer{inner: httpDoer{srv.Client()}}

			ident, st, err := DetectState(context.Background(), doer, cfg)
			if err != nil {
				t.Fatalf("%s on=%v: %v", d.name, on, err)
			}
			if got := doer.n.Load(); got != 2 {
				t.Fatalf("%s on=%v: the test must read the device twice, not %d times", d.name, on, got)
			}

			// The answer is the one Detect + ReadState give (the old three-request path).
			want, err := Detect(context.Background(), httpDoer{srv.Client()}, cfg)
			if err != nil {
				t.Fatal(err)
			}
			wantSt, de := ReadState(context.Background(), httpDoer{srv.Client()}, cfg, want)
			if de != nil {
				t.Fatal(de)
			}
			if ident.Gen != want.Gen || ident.Model != want.Model || ident.App != want.App ||
				ident.HasMetering != want.HasMetering {
				t.Fatalf("%s on=%v: identity %+v, Detect says %+v", d.name, on, ident, want)
			}
			if st.On == nil || *st.On != on || *st.On != *wantSt.On {
				t.Fatalf("%s on=%v: relay %v, ReadState says %v", d.name, on, st.On, wantSt.On)
			}
			if (st.PowerKw == nil) != (wantSt.PowerKw == nil) ||
				(st.PowerKw != nil && *st.PowerKw != *wantSt.PowerKw) {
				t.Fatalf("%s on=%v: power %v, ReadState says %v", d.name, on, st.PowerKw, wantSt.PowerKw)
			}
			srv.Close()
		}
	}
}

func TestDetectStateReadsTheConfiguredChannelOfAPro3(t *testing.T) {
	f := &fakePro3{on: [3]bool{false, false, true}}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	cfg := cfgFor(t, srv)

	cfg.Channel = 2
	ident, st, err := DetectState(context.Background(), httpDoer{srv.Client()}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if ident.Gen != Gen2 || ident.App != "Pro3" || ident.HasMetering {
		t.Fatalf("a Pro 3 is a non-metering Gen2 device: %+v", ident)
	}
	if st.On == nil || !*st.On || st.PowerKw != nil {
		t.Fatalf("channel 2 is on and nothing is measured: %+v", st)
	}

	// A channel the device does not have is named, exactly as before.
	cfg.Channel = 3
	_, _, err = DetectState(context.Background(), httpDoer{srv.Client()}, cfg)
	de, _ := err.(*DriverError)
	if de == nil || de.Code != ErrInvalidResponse || de.Message != "Diesen Schaltkanal kennt das Gerät nicht (Kanal prüfen)." {
		t.Fatalf("unknown channel must be named, got %v", err)
	}
}

func TestDetectStateRefusesAStatusWithoutRelayState(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shelly":
			_, _ = w.Write([]byte(`{"gen":2,"model":"SNSW-001X16EU","app":"Plus1","auth_en":false}`))
		case "/rpc/Switch.GetStatus":
			_, _ = w.Write([]byte(`{"id":0,"source":"init"}`))
		}
	}))
	defer srv.Close()
	_, _, err := DetectState(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
	de, _ := err.(*DriverError)
	if de == nil || de.Code != ErrInvalidResponse || de.Message != "Der Schaltkanal hat nicht verständlich geantwortet." {
		t.Fatalf("a status without the relay state is ReadState's refusal, got %v", err)
	}
}
