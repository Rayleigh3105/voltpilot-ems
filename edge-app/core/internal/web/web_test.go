package web

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

func ptr(v float64) *float64 { return &v }

// fakeDespike is an in-memory DespikeController for the HTTP-layer test; it runs
// the real validation/normalization so the endpoint behavior is exercised.
type fakeDespike struct {
	cfg guards.DespikeSettings
}

func (f *fakeDespike) current() guards.DespikeSettings {
	if f.cfg.Channels == nil {
		return guards.DefaultSettings()
	}
	return f.cfg
}

func (f *fakeDespike) GetDespike() guards.DespikeStatus {
	d := guards.NewDespikerWithSettings(f.current())
	return d.Status()
}

func (f *fakeDespike) SetDespike(req guards.DespikeSettings) (guards.DespikeStatus, error) {
	cfg, err := req.Normalize()
	if err != nil {
		return guards.DespikeStatus{}, err
	}
	f.cfg = cfg
	return f.GetDespike(), nil
}

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

// fakePlan is an in-memory PlanController for the HTTP-layer test. A nil view
// means "no plan cached yet" (has_plan=false).
type fakePlan struct {
	view *plan.View
}

func (f *fakePlan) CurrentPlan() (plan.View, bool) {
	if f.view == nil {
		return plan.View{}, false
	}
	return *f.view, true
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
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"), fi, &fakePurge{}, &fakeDespike{}, h, &fakePlan{}))
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}))
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}))
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}))
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}))
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
		&fakeInverter{cat: inverter.DefaultCatalog()}, fp, &fakeDespike{}, history.New(10), &fakePlan{}))
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
		&fakeInverter{cat: inverter.DefaultCatalog()}, fp, &fakeDespike{}, history.New(10), &fakePlan{}))
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

// The despike settings endpoint returns the current filter config, the channel
// metadata (so the UI is data-driven) and per-channel counters.
func TestGetDespikeReturnsSettingsAndMetadata(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := http.Get(srv.URL + "/api/despike")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body guards.DespikeStatus
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Settings.Preset != guards.PresetNormal {
		t.Fatalf("default preset = %q, want %q", body.Settings.Preset, guards.PresetNormal)
	}
	if len(body.Channels) != len(guards.GatedChannels) {
		t.Fatalf("expected %d channel metas, got %d", len(guards.GatedChannels), len(body.Channels))
	}
	if len(body.Presets) == 0 {
		t.Fatal("expected the preset list for the UI")
	}
}

// A preset POST is applied and reflected on the next GET (live apply through
// the controller).
func TestPostDespikePresetApplies(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := http.Post(srv.URL+"/api/despike", "application/json",
		strings.NewReader(`{"preset":"streng"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body guards.DespikeStatus
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Settings.Preset != guards.PresetStrict {
		t.Fatalf("preset not applied: %q", body.Settings.Preset)
	}

	// GET now reflects the applied preset.
	g, err := http.Get(srv.URL + "/api/despike")
	if err != nil {
		t.Fatal(err)
	}
	defer g.Body.Close()
	var got guards.DespikeStatus
	_ = json.NewDecoder(g.Body).Decode(&got)
	if got.Settings.Preset != guards.PresetStrict {
		t.Fatalf("applied preset not persisted in controller: %q", got.Settings.Preset)
	}
}

// A nonsensical custom value is rejected with a 400 + German message.
func TestPostDespikeValidationReturns400(t *testing.T) {
	srv, _ := newServer(t)
	// A negative rate is nonsense.
	req := `{"preset":"benutzerdefiniert","channels":{"soc_pct":{"enabled":true,"max_rate_per_sec":-1,"margin":5}}}`
	resp, err := http.Post(srv.URL+"/api/despike", "application/json", strings.NewReader(req))
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
		t.Fatal("expected a German error message")
	}
}

func TestPostDespikeMalformedBodyReturns400(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := http.Post(srv.URL+"/api/despike", "application/json", strings.NewReader("{nope"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d, want 400", resp.StatusCode)
	}
}

// The inverter page's model picker is a custom listbox built by inverter.js
// against fixed element ids; this pins the embedded page structure + assets so
// a static/ edit that forgets the //go:embed rebuild contract (or renames a
// mount point) fails here instead of silently shipping a broken picker.
func TestInverterPageServesModelPickerStructure(t *testing.T) {
	srv, _ := newServer(t)

	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d", path, resp.StatusCode)
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	page := get("/inverter.html")
	for _, want := range []string{
		`id="modelSearch"`, `id="modelList"`, `role="listbox"`,
		`id="modelEmpty"`, `id="modelChosen"`,
		`href="dashboard.css"`, `href="inverter.css"`, `src="inverter.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("inverter.html: missing %s", want)
		}
	}
	if strings.Contains(page, "app.css") {
		t.Error("inverter.html: still references the retired app.css")
	}

	css := get("/inverter.css")
	if !strings.Contains(css, ".picker-opt") {
		t.Error("inverter.css: missing model picker styles")
	}
	js := get("/inverter.js")
	if !strings.Contains(js, "modelList") {
		t.Error("inverter.js: does not drive the modelList listbox")
	}
}

// The settings page (Ausreißer-Filter) is built by einstellungen.js against
// fixed element ids; this pins the embedded page + assets so a static/ edit that
// forgets the //go:embed rebuild contract fails here instead of shipping broken.
func TestSettingsPageServesStructure(t *testing.T) {
	srv, _ := newServer(t)
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d", path, resp.StatusCode)
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	page := get("/einstellungen.html")
	for _, want := range []string{
		`id="presetSeg"`, `id="chanList"`, `id="expertToggle"`, `id="saveBtn"`,
		`href="dashboard.css"`, `href="einstellungen.css"`, `src="einstellungen.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einstellungen.html: missing %s", want)
		}
	}
	if !strings.Contains(get("/einstellungen.css"), ".seg-btn") {
		t.Error("einstellungen.css: missing preset segmented control styles")
	}
	if !strings.Contains(get("/einstellungen.js"), "/api/despike") {
		t.Error("einstellungen.js: does not call the despike API")
	}

	// The dashboard + inverter pages link to the settings page.
	if !strings.Contains(get("/index.html"), `href="einstellungen.html"`) {
		t.Error("index.html: missing the Einstellungen link")
	}
	if !strings.Contains(get("/inverter.html"), `href="einstellungen.html"`) {
		t.Error("inverter.html: missing the Einstellungen link")
	}
}

// serveHandler builds a test server with the given plan controller (and the
// standard fakes) so the plan endpoint can be exercised with/without a plan.
func serveHandler(t *testing.T, pl PlanController) *httptest.Server {
	t.Helper()
	st := state.New("edge-test", "test")
	st.Update(func(s *state.Snapshot) {
		s.Mode = state.ModeSchedule
		s.SetpointKw = 12.5
		s.SlotStart = time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC)
	})
	srv := httptest.NewServer(Handler(st,
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), pl))
	t.Cleanup(srv.Close)
	return srv
}

// The Fahrplan endpoint returns the cached plan (slots + freshness + active
// slot) alongside the live guard-clamped setpoint/mode from state.
func TestPlanEndpointReturnsCachedPlan(t *testing.T) {
	payload := `{
	  "schema_version": "1.0", "slot_minutes": 15,
	  "slots": [
	    { "start": "2026-07-01T09:00:00Z", "battery_setpoint_kw": 12.5, "pv_limit_kw": 4.0 },
	    { "start": "2026-07-01T09:15:00Z", "battery_setpoint_kw": -8.0 }
	  ]
	}`
	rx := time.Now().UTC() // fresh so the plan is not stale
	p, err := plan.Parse([]byte(payload), rx)
	if err != nil {
		t.Fatal(err)
	}
	view := p.BuildView(time.Now().UTC())
	srv := serveHandler(t, &fakePlan{view: &view})

	resp, err := http.Get(srv.URL + "/api/plan")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body struct {
		HasPlan    bool      `json:"has_plan"`
		Mode       string    `json:"mode"`
		SetpointKw float64   `json:"setpoint_kw"`
		ServerNow  int64     `json:"server_now_ms"`
		Plan       plan.View `json:"plan"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.HasPlan || len(body.Plan.Slots) != 2 {
		t.Fatalf("plan not returned: %+v", body)
	}
	if body.Mode != string(state.ModeSchedule) || body.SetpointKw != 12.5 {
		t.Errorf("live setpoint/mode not carried: mode=%q setpoint=%v", body.Mode, body.SetpointKw)
	}
	if !body.Plan.Slots[0].Curtailed || body.Plan.Slots[0].PvLimitKw == nil {
		t.Errorf("curtailment not surfaced: %+v", body.Plan.Slots[0])
	}
	if body.Plan.StaleAfterSeconds != int(plan.StaleAfter/time.Second) {
		t.Errorf("stale window not exposed: %d", body.Plan.StaleAfterSeconds)
	}
	if body.ServerNow <= 0 {
		t.Errorf("missing device clock")
	}
}

// With no plan cached, the endpoint reports has_plan=false (and omits "plan"),
// so the UI shows the honest empty state.
func TestPlanEndpointNoPlan(t *testing.T) {
	srv := serveHandler(t, &fakePlan{})
	resp, err := http.Get(srv.URL + "/api/plan")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var raw map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		t.Fatal(err)
	}
	if raw["has_plan"] != false {
		t.Fatalf("expected has_plan=false, got %v", raw["has_plan"])
	}
	if _, present := raw["plan"]; present {
		t.Errorf("plan key must be omitted when no plan is cached")
	}
}

// The Fahrplan section is built by plan.js against fixed element ids; pin the
// embedded page + asset so a static/ edit that forgets the //go:embed rebuild
// (or renames a mount point) fails here instead of shipping a broken view.
func TestFahrplanSectionServed(t *testing.T) {
	srv := serveHandler(t, &fakePlan{})
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d", path, resp.StatusCode)
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	page := get("/index.html")
	for _, want := range []string{
		`id="planChart"`, `id="planEmpty"`, `id="planBody"`, `id="planFresh"`,
		`id="planNow"`, `Noch kein Fahrplan empfangen`, `src="plan.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing %s", want)
		}
	}
	js := get("/plan.js")
	if !strings.Contains(js, "/api/plan") {
		t.Error("plan.js: does not call the plan API")
	}
	if !strings.Contains(js, "VPPlan") {
		t.Error("plan.js: does not expose the VPPlan hook dashboard.js calls")
	}
}

// The "Steuerung & Bestätigung" section is built by control.js against fixed
// element ids and fed by state.control; pin the embedded page + asset so a
// static/ edit that forgets the //go:embed rebuild fails here.
func TestSteuerungSectionServed(t *testing.T) {
	srv := serveHandler(t, &fakePlan{})
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: status %d", path, resp.StatusCode)
		}
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	page := get("/index.html")
	for _, want := range []string{
		`id="ctrlRows"`, `id="ctrlBody"`, `id="ctrlEmpty"`, `id="ctrlBanner"`,
		`Wechselrichter-Steuerung`, `src="control.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing %s", want)
		}
	}
	js := get("/control.js")
	if !strings.Contains(js, "VPControl") {
		t.Error("control.js: does not expose the VPControl hook dashboard.js calls")
	}
	if !strings.Contains(js, "Abweichung") {
		t.Error("control.js: missing the mismatch wording")
	}
}
