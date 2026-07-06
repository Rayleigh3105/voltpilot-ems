package web

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func ptr(v float64) *float64 { return &v }

// fakeInverter is an in-memory InverterController for the HTTP-layer test.
type fakeInverter struct {
	cat inverter.Catalog
	sel *inverter.Selection
}

func (f *fakeInverter) InverterCatalog() inverter.Catalog { return f.cat }

func (f *fakeInverter) GetInverter() (inverter.Selection, bool) {
	if f.sel == nil {
		return inverter.Selection{}, false
	}
	return *f.sel, true
}

func (f *fakeInverter) SetInverter(req inverter.SelectionRequest) (inverter.Selection, error) {
	sel, err := f.cat.Normalize(req, time.Unix(0, 0))
	if err != nil {
		return inverter.Selection{}, err
	}
	f.sel = &sel
	return sel, nil
}

// fakePurge is an in-memory PurgeController for the HTTP-layer test.
type fakePurge struct {
	calls int
	err   error
}

func (f *fakePurge) PurgeRecordedData() (state.DataPurgeInfo, error) {
	f.calls++
	if f.err != nil {
		return state.DataPurgeInfo{}, f.err
	}
	return state.DataPurgeInfo{
		RequestedAt: time.Unix(1751791234, 0).UTC(),
		CloudState:  "angefordert",
	}, nil
}

func newServer(t *testing.T) (*httptest.Server, *fakeInverter) {
	t.Helper()
	srv, fi, _ := newServerWithHistory(t)
	return srv, fi
}

func newServerWithHistory(t *testing.T) (*httptest.Server, *fakeInverter, *history.Ring) {
	t.Helper()
	fi := &fakeInverter{cat: inverter.DefaultCatalog()}
	h := history.New(100)
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"), fi, &fakePurge{}, h))
	t.Cleanup(srv.Close)
	return srv, fi, h
}

func TestGetInverterReturnsCatalogAndNilSelection(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := http.Get(srv.URL + "/api/inverter")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body struct {
		Catalog   inverter.Catalog    `json:"catalog"`
		Selection *inverter.Selection `json:"selection"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Catalog.Brands) < 2 {
		t.Fatalf("catalog brands: %d", len(body.Catalog.Brands))
	}
	if body.Selection != nil {
		t.Fatalf("expected nil selection, got %+v", body.Selection)
	}
}

func TestPostInverterRoundTrip(t *testing.T) {
	srv, fi := newServer(t)
	req := `{"brand":"deye","family":"hybrid_3p","connection":{"ip":"192.168.0.28","serial":"2985159064"}}`
	resp, err := http.Post(srv.URL+"/api/inverter", "application/json", strings.NewReader(req))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body struct {
		Selection inverter.Selection `json:"selection"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Selection.Communication != inverter.CommSolarmanV5 || body.Selection.Connection.Port != 8899 {
		t.Fatalf("normalized selection: %+v", body.Selection)
	}
	if fi.sel == nil || fi.sel.Family != "hybrid_3p" {
		t.Fatalf("controller not updated: %+v", fi.sel)
	}

	// The selection now comes back on GET.
	g, err := http.Get(srv.URL + "/api/inverter")
	if err != nil {
		t.Fatal(err)
	}
	defer g.Body.Close()
	var got struct {
		Selection *inverter.Selection `json:"selection"`
	}
	_ = json.NewDecoder(g.Body).Decode(&got)
	if got.Selection == nil || got.Selection.Connection.Serial != "2985159064" {
		t.Fatalf("GET after POST: %+v", got.Selection)
	}
}

func TestPostInverterByModel(t *testing.T) {
	srv, fi := newServer(t)
	// The customer picks their exact model in the UI (no family grouping).
	req := `{"brand":"deye","model":"sun-12k-sg04lp3","connection":{"ip":"192.168.0.28","serial":"2985159064"}}`
	resp, err := http.Post(srv.URL+"/api/inverter", "application/json", strings.NewReader(req))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if fi.sel == nil || fi.sel.Model != "sun-12k-sg04lp3" || fi.sel.Family != inverter.FamHybrid3p {
		t.Fatalf("model selection not resolved to its register map: %+v", fi.sel)
	}
}

func TestPostInverterValidationReturns400(t *testing.T) {
	srv, _ := newServer(t)
	// Deye without a serial is a validation error.
	req := `{"brand":"deye","family":"hybrid_3p","connection":{"ip":"192.168.0.28"}}`
	resp, err := http.Post(srv.URL+"/api/inverter", "application/json", strings.NewReader(req))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Error == "" {
		t.Fatalf("expected a German error message")
	}
}

func TestPostInverterMalformedBodyReturns400(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := http.Post(srv.URL+"/api/inverter", "application/json", strings.NewReader("{not json"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}

func TestStateEnvelopeCarriesServerClock(t *testing.T) {
	// Unlock the onboarding gate so the reference is present in the envelope
	// (it is withheld until the inverter delivers data - see the gate tests).
	st := state.New("edge-test", "test")
	st.Update(func(s *state.Snapshot) {
		s.Inverter = configuredInverter()
		s.LastTelemetry = time.Now().UTC()
	})
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, history.New(10)))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Ref         string `json:"ref"`
		ServerNowMs int64  `json:"server_now_ms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Ref != "edge-test" {
		t.Fatalf("ref: %q", body.Ref)
	}
	if body.ServerNowMs <= 0 {
		t.Fatalf("expected a device clock, got %d", body.ServerNowMs)
	}
}

func TestHistoryReturnsRecentSamplesWithDerivedBattery(t *testing.T) {
	srv, _, h := newServerWithHistory(t)
	now := time.Now()
	// pv 3, load 1, grid -2 -> battery = grid - load + pv = 0 (self-balanced).
	h.Add(history.Sample{Ts: now.Add(-30 * time.Second), PvKw: ptr(3), LoadKw: ptr(1), GridKw: ptr(-2), SocPct: ptr(74.5)})
	// An old sample outside the window must be excluded.
	h.Add(history.Sample{Ts: now.Add(-3 * time.Hour), PvKw: ptr(9)})

	resp, err := http.Get(srv.URL + "/api/history?minutes=60")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Samples []struct {
			T    int64    `json:"t"`
			Pv   *float64 `json:"pv"`
			Batt *float64 `json:"batt"`
			Soc  *float64 `json:"soc"`
		} `json:"samples"`
		ServerNowMs int64 `json:"server_now_ms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Samples) != 1 {
		t.Fatalf("expected 1 in-window sample, got %d", len(body.Samples))
	}
	s := body.Samples[0]
	if s.Pv == nil || *s.Pv != 3 {
		t.Fatalf("pv: %+v", s.Pv)
	}
	if s.Batt == nil || *s.Batt != 0 {
		t.Fatalf("derived battery should be 0, got %+v", s.Batt)
	}
	if s.Soc == nil || *s.Soc != 74.5 {
		t.Fatalf("soc: %+v", s.Soc)
	}
	if body.ServerNowMs <= 0 {
		t.Fatalf("missing server clock")
	}
}

// The buffer data-loss flag reaches the UI via /api/state so the dashboard can
// warn during a long outage (Batch B m1).
func TestStateExposesBufferDataLoss(t *testing.T) {
	st := state.New("edge-test", "test")
	st.Update(func(s *state.Snapshot) { s.BufferDataLoss = true; s.BufferPending = 7 })
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, history.New(10)))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		BufferDataLoss bool `json:"buffer_data_loss"`
		BufferPending  int  `json:"buffer_pending"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.BufferDataLoss || body.BufferPending != 7 {
		t.Fatalf("state did not expose buffer data-loss: %+v", body)
	}
}

// getState fetches /api/state and decodes the onboarding-gate fields.
func getState(t *testing.T, srv *httptest.Server) struct {
	Ref               string `json:"ref"`
	OnboardingStep    string `json:"onboarding_step"`
	InverterConnected bool   `json:"inverter_connected"`
	ClaimUnlocked     bool   `json:"claim_unlocked"`
} {
	t.Helper()
	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Ref               string `json:"ref"`
		OnboardingStep    string `json:"onboarding_step"`
		InverterConnected bool   `json:"inverter_connected"`
		ClaimUnlocked     bool   `json:"claim_unlocked"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body
}

func configuredInverter() *state.InverterInfo {
	return &state.InverterInfo{Brand: "deye", Label: "Deye Hybrid 3-Phasen", Configured: true}
}

// The enforced onboarding gate: the reference stays withheld and the customer is
// held on the inverter step until an inverter is configured AND has delivered at
// least one telemetry reading - only then does the portal-claim step unlock.
func TestOnboardingGateHoldsClaimUntilInverterDeliversData(t *testing.T) {
	// (a) No inverter configured -> step "inverter", locked, no reference.
	st := state.New("edge-gate", "test")
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, history.New(10)))
	defer srv.Close()

	b := getState(t, srv)
	if b.OnboardingStep != "inverter" || b.InverterConnected || b.ClaimUnlocked {
		t.Fatalf("no inverter: got %+v", b)
	}
	if b.Ref != "" {
		t.Fatalf("reference must be withheld before the gate, got %q", b.Ref)
	}

	// (b) Inverter configured but no telemetry yet -> still locked, no reference.
	st.Update(func(s *state.Snapshot) { s.Inverter = configuredInverter() })
	b = getState(t, srv)
	if b.OnboardingStep != "inverter" || b.InverterConnected || b.ClaimUnlocked {
		t.Fatalf("configured, no data: got %+v", b)
	}
	if b.Ref != "" {
		t.Fatalf("reference must stay withheld until data arrives, got %q", b.Ref)
	}

	// (c) Inverter delivers data -> step "claim", unlocked, reference revealed.
	st.Update(func(s *state.Snapshot) { s.LastTelemetry = time.Now().UTC() })
	b = getState(t, srv)
	if b.OnboardingStep != "claim" || !b.InverterConnected || !b.ClaimUnlocked {
		t.Fatalf("inverter delivering: got %+v", b)
	}
	if b.Ref != "edge-gate" {
		t.Fatalf("reference must be revealed once unlocked, got %q", b.Ref)
	}
}

// A paired device (certificate on disk) is past onboarding: the gate no longer
// governs and the reference is always available, even without live telemetry.
func TestOnboardingGateDoneOncePaired(t *testing.T) {
	st := state.New("edge-paired", "test")
	st.Update(func(s *state.Snapshot) { s.PairingState = "verbunden" })
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, history.New(10)))
	defer srv.Close()

	b := getState(t, srv)
	if b.OnboardingStep != "done" || !b.ClaimUnlocked {
		t.Fatalf("paired device: got %+v", b)
	}
	if b.Ref != "edge-paired" {
		t.Fatalf("paired device keeps its reference, got %q", b.Ref)
	}
}

func TestStreamPushesStateThenNewSamples(t *testing.T) {
	srv, _, h := newServerWithHistory(t)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/stream", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content-type: %q", ct)
	}

	sc := bufio.NewScanner(resp.Body)
	// The first event is the initial state snapshot.
	if !waitForLine(sc, "event: state") {
		t.Fatal("did not receive initial state event")
	}
	// A sample added after connect must be pushed.
	h.Add(history.Sample{Ts: time.Now().Add(time.Second), PvKw: ptr(4.2)})
	if !waitForLine(sc, "event: sample") {
		t.Fatal("did not receive a sample event for new telemetry")
	}
}

// waitForLine scans until a line exactly matches want or the stream ends.
func waitForLine(sc *bufio.Scanner, want string) bool {
	for sc.Scan() {
		if sc.Text() == want {
			return true
		}
	}
	return false
}

func TestPurgeDataEndpointRunsThePurgeAndReturnsItsState(t *testing.T) {
	fp := &fakePurge{}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, fp, history.New(10)))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/purge-data", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if fp.calls != 1 {
		t.Fatalf("purge calls = %d", fp.calls)
	}
	var body struct {
		DataPurge struct {
			CloudState string `json:"cloud_state"`
		} `json:"data_purge"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.DataPurge.CloudState != "angefordert" {
		t.Fatalf("cloud_state = %q", body.DataPurge.CloudState)
	}
}

func TestPurgeDataEndpointMapsFailureToGermanError(t *testing.T) {
	fp := &fakePurge{err: context.DeadlineExceeded}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, fp, history.New(10)))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/purge-data", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d, want 500", resp.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Error == "" {
		t.Fatal("expected a German error message")
	}
}
