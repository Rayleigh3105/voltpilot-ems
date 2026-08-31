package web

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/calibration"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/componentapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/csms"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/curtailcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/guards"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/installerwrite"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/lastmgmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/mirror"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otatarget"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/plan"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/testconn"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/topology"
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
	cat         inverter.Catalog
	sel         *inverter.Selection
	testResult  testconn.Result   // returned by TestConnection
	testReq     *testconn.Request // captured last TestConnection request
	probeResult testconn.Result   // returned by ProbeUnits
	probeReq    *testconn.Request // captured last ProbeUnits request
	// portalManaged mirrors the Stufe-2 authority: true = the plant's devices
	// are maintained in the portal and :8484 is a read-only mirror.
	portalManaged bool
	// setErr is the refusal SetInverter hands back (the authority gate).
	setErr error
}

func (f *fakeInverter) InverterCatalog() inverter.Catalog { return f.cat }

func (f *fakeInverter) PortalManagedComponents() bool { return f.portalManaged }

func (f *fakeInverter) TestConnection(req testconn.Request) testconn.Result {
	r := req
	f.testReq = &r
	return f.testResult
}

func (f *fakeInverter) ProbeUnits(req testconn.Request) testconn.Result {
	r := req
	f.probeReq = &r
	return f.probeResult
}

func (f *fakeInverter) GetInverter() (inverter.Selection, bool) {
	if f.sel == nil {
		return inverter.Selection{}, false
	}
	return *f.sel, true
}

func (f *fakeInverter) SetInverter(req inverter.SelectionRequest) (inverter.Selection, error) {
	if f.setErr != nil {
		return inverter.Selection{}, f.setErr
	}
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

// fakeTopology returns a fixed topology for the /api/state envelope test.
type fakeTopology struct{ topo topology.Topology }

func (f *fakeTopology) Topology() topology.Topology {
	if f.topo.SchemaVersion == "" {
		return topology.Topology{SchemaVersion: topology.SchemaVersion, Nodes: []topology.FlowNode{}}
	}
	return f.topo
}

// fakeActiveControl is an ActiveControlController stub for the HTTP-layer tests:
// it returns whatever ActiveControl view the test sets (zero value = empty).
type fakeActiveControl struct{ ac cloud.ActiveControl }

func (f *fakeActiveControl) ActiveControl() cloud.ActiveControl {
	if f.ac.Flows == nil {
		f.ac.Flows = []cloud.AppliedFlow{}
	}
	if f.ac.Entities == nil {
		f.ac.Entities = []cloud.ActiveControlEntity{}
	}
	return f.ac
}

// fakeCalibration is an in-memory CalibrationController for the HTTP-layer test:
// it records the calls the routes make and returns a configurable snapshot/error.
type fakeCalibration struct {
	snap    calibration.Snapshot
	armErr  error
	testErr error

	lastArmed      *bool
	lastTestDir    string
	lastTestKw     float64
	aborts         int
	lastSign       *bool
	lastScale      *bool
	lastInvertSig  *bool
	lastPowScale   *float64
	lastInvertBatt *bool
	certifyCalls   int
	decertifyCalls int
	confirmErr     error
	adminSecret    string

	curtailView          curtailcal.View
	curtailErr           error
	lastCurtailTest      string
	curtailAborts        int
	lastCurtailCertify   string
	lastCurtailDecertify string
}

func (f *fakeCalibration) CalibrationSnapshot() calibration.Snapshot { return f.snap }

// The curtailment First-Light surface (same controller interface). The fake
// records calls; curtailErr lets a test drive the 400 mapping.
func (f *fakeCalibration) CurtailSnapshot() curtailcal.View { return f.curtailView }
func (f *fakeCalibration) CurtailStartTest(sourceID string) (curtailcal.View, error) {
	f.lastCurtailTest = sourceID
	return f.curtailView, f.curtailErr
}
func (f *fakeCalibration) CurtailAbort() curtailcal.View { f.curtailAborts++; return f.curtailView }
func (f *fakeCalibration) CurtailCertify(sourceID string) (curtailcal.View, error) {
	f.lastCurtailCertify = sourceID
	return f.curtailView, f.curtailErr
}
func (f *fakeCalibration) CurtailDecertify(sourceID string) (curtailcal.View, error) {
	f.lastCurtailDecertify = sourceID
	return f.curtailView, f.curtailErr
}
func (f *fakeCalibration) CalibrationAdminSecret() string { return f.adminSecret }
func (f *fakeCalibration) CalibrationArm(armed bool) (calibration.Snapshot, error) {
	f.lastArmed = &armed
	return f.snap, f.armErr
}
func (f *fakeCalibration) CalibrationStartTest(direction string, magnitudeKw float64) (calibration.Snapshot, error) {
	f.lastTestDir, f.lastTestKw = direction, magnitudeKw
	return f.snap, f.testErr
}
func (f *fakeCalibration) CalibrationAbort() calibration.Snapshot { f.aborts++; return f.snap }
func (f *fakeCalibration) CalibrationConfirm(sign, scale *bool) (calibration.Snapshot, error) {
	f.lastSign, f.lastScale = sign, scale
	return f.snap, f.confirmErr
}
func (f *fakeCalibration) CalibrationCorrection(invertControlSign *bool, powerScale *float64, invertBattSign *bool) (calibration.Snapshot, error) {
	f.lastInvertSig, f.lastPowScale, f.lastInvertBatt = invertControlSign, powerScale, invertBattSign
	return f.snap, nil
}
func (f *fakeCalibration) CalibrationCertify() (calibration.Snapshot, error) {
	f.certifyCalls++
	return f.snap, nil
}
func (f *fakeCalibration) CalibrationDecertify() (calibration.Snapshot, error) {
	f.decertifyCalls++
	return f.snap, nil
}

// fakeMirror is an in-memory MirrorController for the HTTP-layer test: it
// records the settings requests the route forwards and returns a
// configurable status/error.
type fakeMirror struct {
	status  mirror.Status
	lastReq *mirror.SettingsRequest
	setErr  error
}

func (f *fakeMirror) GetMirror() mirror.Status { return f.status }
func (f *fakeMirror) SetMirror(req mirror.SettingsRequest) (mirror.Status, error) {
	f.lastReq = &req
	return f.status, f.setErr
}

// fakeOta is the OTA Stufe 2 controller double: it records what the supervised
// apply reported back and hands out a canned target view.
// fakeInstallerWrite is the InstallerWriteController double: the narrow 0x00E7
// installer write. There is no arming flag any more (Captain-Korrektur
// 20.08.2026) - the routes exist on every box, and the WRITE is guarded by the
// operator password.
type fakeInstallerWrite struct {
	view  installerwrite.View
	out   installerwrite.Outcome
	err   error
	calls []installerwrite.Request
	by    []string
}

func (f *fakeInstallerWrite) InstallerWriteView() installerwrite.View { return f.view }
func (f *fakeInstallerWrite) InstallerWrite(req installerwrite.Request, by string) (installerwrite.Outcome, error) {
	f.calls = append(f.calls, req)
	f.by = append(f.by, by)
	return f.out, f.err
}

type fakeOta struct {
	view    otatarget.View
	applied *struct {
		release string
		seq     int64
	}
	err error
	// OTA Stufe 4: der beaufsichtigte „Jetzt anwenden"-Pfad.
	applyCalls  int
	applyLastBy string

	// Teil C: der Autonomie-Schalter OHNE SHELL.
}

func (f *fakeOta) OtaTarget() otatarget.View { return f.view }
func (f *fakeOta) OtaRecordApplied(release string, seq int64) (otatarget.View, error) {
	if f.err != nil {
		return f.view, f.err
	}
	f.applied = &struct {
		release string
		seq     int64
	}{release, seq}
	return f.view, nil
}
func (f *fakeOta) IsOtaRejection(err error) bool { return err != nil }

// fakeSources is an in-memory SourcesController for the HTTP-layer test.
type fakeSources struct {
	list      []sources.Source
	statuses  map[string]string
	readings  map[string]sources.LastReading
	addErr    error
	delErr    error
	renameErr error
	bal       sources.BalanceSettings
	balErr    error
	custom    []componentapply.CustomDevice
}

func (f *fakeSources) ListSources() []sources.Source { return f.list }

func (f *fakeSources) CustomDevices() []componentapply.CustomDevice { return f.custom }

func (f *fakeSources) GetBalance() sources.BalanceSettings { return f.bal }

func (f *fakeSources) SetBalance(cfg sources.BalanceSettings) (sources.BalanceSettings, error) {
	if f.balErr != nil {
		return sources.BalanceSettings{}, f.balErr
	}
	f.bal = cfg
	return cfg, nil
}

func (f *fakeSources) SourceStatuses() map[string]string { return f.statuses }

func (f *fakeSources) SourceLastReadings() map[string]sources.LastReading { return f.readings }

func (f *fakeSources) AddSource(req sources.Request) (sources.Source, error) {
	if f.addErr != nil {
		return sources.Source{}, f.addErr
	}
	s, err := sources.Normalize(inverter.DefaultCatalog(), req, time.Unix(0, 0))
	if err != nil {
		return sources.Source{}, err
	}
	s.ID = "src-fixed"
	f.list = append(f.list, s)
	return s, nil
}

func (f *fakeSources) DeleteSource(id string) error {
	if f.delErr != nil {
		return f.delErr
	}
	for i, s := range f.list {
		if s.ID == id {
			f.list = append(f.list[:i], f.list[i+1:]...)
			return nil
		}
	}
	return sources.ErrNotFound
}

func (f *fakeSources) RenameSource(id, label string) (sources.Source, error) {
	if f.renameErr != nil {
		return sources.Source{}, f.renameErr
	}
	label = strings.TrimSpace(label)
	if label == "" || len([]rune(label)) > 64 {
		return sources.Source{}, &sources.ValidationError{
			Msg: "Bitte einen Namen mit 1 bis 64 Zeichen angeben."}
	}
	for i := range f.list {
		if f.list[i].ID == id {
			f.list[i].Label = label
			return f.list[i], nil
		}
	}
	return sources.Source{}, sources.ErrNotFound
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
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"), fi, &fakePurge{}, &fakeDespike{}, h, &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)
	return srv, fi, h
}

// TestStateEnvelopeCarriesBuildVersion pins the display path for the build
// version stamp: the ldflags-set agent.Version flows state.New(ref, version) ->
// Snapshot.Version -> the /api/state envelope's "version" field, which
// dashboard.js renders as "v<version>" (blank for the "dev" default). This is
// the on-device half of the edge-images VERSION build-arg wiring.
func TestStateEnvelopeCarriesBuildVersion(t *testing.T) {
	fi := &fakeInverter{cat: inverter.DefaultCatalog()}
	h := history.New(100)
	srv := httptest.NewServer(Handler(state.New("edge-ver", "test123"), fi, &fakePurge{}, &fakeDespike{}, h, &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var env struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		t.Fatal(err)
	}
	if env.Version != "test123" {
		t.Fatalf("state envelope version = %q, want %q", env.Version, "test123")
	}
}

// TestHealthCarriesBuildVersion (OTA Stufe 0): /health is the ungated,
// machine-readable endpoint install.sh/update.sh already poll, so "which build
// is on this box" must be answerable there - without a cloud link, without a
// browser, and independent of any flow deployment.
func TestHealthCarriesBuildVersion(t *testing.T) {
	fi := &fakeInverter{cat: inverter.DefaultCatalog()}
	srv := httptest.NewServer(Handler(state.New("edge-ver", "edge-2026.08.0+3bf8c0380000"), fi,
		&fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{},
		&fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var health struct {
		Status  string `json:"status"`
		Ref     string `json:"ref"`
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health.Version != "edge-2026.08.0+3bf8c0380000" {
		t.Fatalf("/health version = %q, want the build stamp", health.Version)
	}
	// The pre-existing fields stay - an installer parsing the old shape is
	// unaffected.
	if health.Status != "UP" || health.Ref != "edge-ver" {
		t.Fatalf("/health changed shape: %+v", health)
	}
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
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

func TestHistoryReturnsRecentSamplesWithMeasuredBattery(t *testing.T) {
	srv, _, h := newServerWithHistory(t)
	now := time.Now()
	// The wire `batt` is the MEASURED battery register (2026-07-17 standard):
	// here 0 kW measured while charging nothing; the balance derivation is
	// never emitted.
	h.Add(history.Sample{Ts: now.Add(-30 * time.Second), PvKw: ptr(3), LoadKw: ptr(1), GridKw: ptr(-2), SocPct: ptr(74.5), BattKw: ptr(0)})
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
		t.Fatalf("measured battery should be 0, got %+v", s.Batt)
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
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

// gateBody is the onboarding-gate half of /api/state.
type gateBody struct {
	Ref                  string `json:"ref"`
	OnboardingStep       string `json:"onboarding_step"`
	InverterConnected    bool   `json:"inverter_connected"`
	ChargePointConnected bool   `json:"charge_point_connected"`
	ClaimUnlocked        bool   `json:"claim_unlocked"`
}

// getState fetches /api/state and decodes the onboarding-gate fields.
func getState(t *testing.T, srv *httptest.Server) gateBody {
	t.Helper()
	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body gateBody
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
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
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	b := getState(t, srv)
	if b.OnboardingStep != "done" || !b.ClaimUnlocked {
		t.Fatalf("paired device: got %+v", b)
	}
	if b.Ref != "edge-paired" {
		t.Fatalf("paired device keeps its reference, got %q", b.Ref)
	}
}

// A device removed (unclaimed) in the cloud - geraet_entfernt - is DELIBERATELY
// not "paired": the onboarding gate re-opens the portal-claim step so the
// customer can re-claim, revealing the reference once the inverter delivers
// data. /health carries the state for headless tooling (installer/watchdogs).
func TestRemovedDeviceReopensClaimStepAndSurfacesOnHealth(t *testing.T) {
	st := state.New("edge-removed", "test")
	st.Update(func(s *state.Snapshot) {
		s.PairingState = "geraet_entfernt"
		s.Inverter = configuredInverter()
		s.LastTelemetry = time.Now().UTC()
		s.BufferPaused = true
	})
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	b := getState(t, srv)
	if b.OnboardingStep != "claim" || !b.ClaimUnlocked {
		t.Fatalf("removed device with a delivering inverter must re-open the claim step: %+v", b)
	}
	if b.Ref != "edge-removed" {
		t.Fatalf("removed device must reveal the reference for the re-claim, got %q", b.Ref)
	}

	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var health struct {
		PairingState   string `json:"pairing_state"`
		CloudConnected bool   `json:"cloud_connected"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	if health.PairingState != "geraet_entfernt" || health.CloudConnected {
		t.Fatalf("/health must surface the removed state: %+v", health)
	}

	// The state envelope carries the honest buffer-pause flag for the UI.
	sresp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	var env struct {
		BufferPaused bool `json:"buffer_paused"`
	}
	if err := json.NewDecoder(sresp.Body).Decode(&env); err != nil {
		t.Fatal(err)
	}
	if !env.BufferPaused {
		t.Fatal("state envelope must carry buffer_paused while removed")
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

// TestMirrorEndpoints wires GET/POST /api/mirror to a recording fake: GET
// returns the status under a "mirror" key, POST forwards the parsed partial
// update, and a *mirror.ValidationError maps to HTTP 400 with the German
// message (not 500).
func TestMirrorEndpoints(t *testing.T) {
	fm := &fakeMirror{status: mirror.Status{Enabled: true, Running: true, AdvertisePort: 502, StaleAfterS: 90, NativeUnit: 1, VPUnit: 100}}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10),
		&fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, fm, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/mirror")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Mirror mirror.Status `json:"mirror"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !got.Mirror.Enabled || got.Mirror.AdvertisePort != 502 || got.Mirror.VPUnit != 100 {
		t.Fatalf("GET /api/mirror: %+v", got.Mirror)
	}

	resp, err = http.Post(srv.URL+"/api/mirror", "application/json",
		strings.NewReader(`{"enabled":true,"stale_after_s":120}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("POST /api/mirror: %d", resp.StatusCode)
	}
	if fm.lastReq == nil || fm.lastReq.Enabled == nil || !*fm.lastReq.Enabled ||
		fm.lastReq.StaleAfterS == nil || *fm.lastReq.StaleAfterS != 120 {
		t.Fatalf("controller got %+v", fm.lastReq)
	}

	// A validation failure surfaces as 400 with the German message.
	fm.setErr = &mirror.ValidationError{Msg: "Die Frische-Schwelle (stale_after_s) muss zwischen 5 und 3600 Sekunden liegen."}
	resp, err = http.Post(srv.URL+"/api/mirror", "application/json", strings.NewReader(`{"stale_after_s":1}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 400 || !strings.Contains(string(body), "Frische-Schwelle") {
		t.Fatalf("validation failure: %d %s", resp.StatusCode, body)
	}
	// A malformed body is a 400 too.
	resp, err = http.Post(srv.URL+"/api/mirror", "application/json", strings.NewReader(`{`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("malformed body: %d", resp.StatusCode)
	}
}

func TestPurgeDataEndpointRunsThePurgeAndReturnsItsState(t *testing.T) {
	fp := &fakePurge{}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, fp, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
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
		&fakeInverter{cat: inverter.DefaultCatalog()}, fp, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
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

	// The Wechselrichter/Quellen surface now lives as the first AREA of the one
	// "Einrichten" page; /inverter.html stays only as a redirect (see
	// TestRetiredPageUrlsRedirectInsteadOfDisappearing).
	page := get("/einrichten.html")
	for _, want := range []string{
		// The model picker (built by inverter.js) is unchanged.
		`id="modelSearch"`, `id="modelList"`, `role="listbox"`,
		`id="modelEmpty"`, `id="modelChosen"`,
		// The role-grouped "Meine Anlage" card: the Wechselrichter summary/edit
		// group + the Erzeuger/Netz/Verbraucher groups. Empty categories are a
		// "+ hinzufügen" row inside the group, never standalone empty cards.
		`id="anlageCard"`, `id="invGroup"`, `id="invRows"`, `id="invEmpty"`,
		`id="erzList"`, `id="netzList"`, `id="verbList"`,
		`id="erzAdd"`, `id="netzAdd"`, `id="verbAdd"`,
		// The "Zuletzt gelesen" line of the Wechselrichter summary row.
		`id="invRead"`,
		// The "Verbindung testen" buttons + result panels (inverter form + drawer).
		`id="invTestBtn"`, `id="invVerify"`, `id="srcTestBtn"`, `id="srcVerify"`,
		// Der ZEILEN-Test (Befund L6): er prüft die GESPEICHERTE Verbindung und
		// bleibt deshalb auch auf einer portal-verwalteten Anlage erreichbar.
		// Ohne Knopf oder Kasten wäre der lokale Verbindungstest dort weiterhin
		// nur über das ausgeblendete Bearbeiten-Formular zu haben.
		`id="invRowTestBtn"`, `id="invRowVerify"`,
		`href="dashboard.css"`, `href="inverter.css"`, `src="verify.js"`, `src="inverter.js"`,
		// Die Modell-SUCHE ist der primäre Weg zum Modell und läuft über ALLE
		// Marken; ihre reinen Regeln liegen in modellsuche.js. Ohne das Skript
		// wäre der Picker still kaputt (window.VPModellSuche fehlte).
		`src="modellsuche.js"`,
		// Welle 3 des Picker-Systems: Marke, Quellen-Marke und Quellen-Modell
		// sind MONTAGEPUNKTE - ihre Auslöser entstehen erst im Browser
		// (vppicker.js). Ohne Punkt, Skript oder Stil bliebe die Auswahl leer.
		`id="brandPicker"`, `id="brandLabel"`,
		`id="srcBrandPicker"`, `id="srcModelPicker"`,
		`src="pickerregeln.js"`, `src="vppicker.js"`, `href="vppicker.css"`,
		// Katalog-Neustruktur: der Verbindungsweg haengt am MODELL, und seine
		// REGELN wohnen rein in katalogwege.js - beide Formulare (Wechselrichter
		// und Quellen-Drawer) rufen sie. Ohne das Skript blieben die
		// Verbindungsfelder leer.
		`src="katalogwege.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einrichten.html: missing %s", want)
		}
	}
	if strings.Contains(page, "app.css") {
		t.Error("einrichten.html: still references the retired app.css")
	}

	// Die Wege-Schicht wird AUSGELIEFERT und hängt an window - beide Formulare
	// rufen sie so, und sie muss VOR ihnen geladen werden.
	wege := get("/katalogwege.js")
	for _, want := range []string{"VPKatalogWege", "gewaehlterWeg", "ohneVorgaben", "sichtbar"} {
		if !strings.Contains(wege, want) {
			t.Errorf("katalogwege.js: missing %s", want)
		}
	}
	if i, j := strings.Index(page, `src="katalogwege.js"`), strings.Index(page, `src="inverter.js"`); i < 0 || j < 0 || i > j {
		t.Error("einrichten.html: katalogwege.js muss VOR inverter.js geladen werden")
	}
	if i, j := strings.Index(page, `src="katalogwege.js"`), strings.Index(page, `src="sources.js"`); i < 0 || j < 0 || i > j {
		t.Error("einrichten.html: katalogwege.js muss VOR sources.js geladen werden")
	}

	// Die Suche wird AUSGELIEFERT und hängt an window - inverter.js ruft sie so.
	suche := get("/modellsuche.js")
	for _, want := range []string{"VPModellSuche", "hervorheben", "suche"} {
		if !strings.Contains(suche, want) {
			t.Errorf("modellsuche.js: missing %s", want)
		}
	}

	// Der Picker der Box: die REGELN und die FLÄCHE hängen beide an window, und
	// die Regeln holen ihre Such-Toleranz aus modellsuche.js - eine zweite
	// Toleranz auf derselben Seite fände dieselbe Eingabe anders.
	regeln := get("/pickerregeln.js")
	for _, want := range []string{"VPPickerRegeln", "VPModellSuche", "tippSprung", "naechster", "SUCHE_AB"} {
		if !strings.Contains(regeln, want) {
			t.Errorf("pickerregeln.js: missing %s", want)
		}
	}
	pickerJs := get("/vppicker.js")
	for _, want := range []string{
		"VPPicker", "VPPickerRegeln", "listbox", "combobox", "aria-activedescendant",
		"aria-expanded", "is-sheet", "Escape",
	} {
		if !strings.Contains(pickerJs, want) {
			t.Errorf("vppicker.js: missing %s", want)
		}
	}
	pickerCss := get("/vppicker.css")
	for _, want := range []string{".vpp-ausloeser", ".vpp-panel", ".vpp-zeile", ".vpp-panel.is-sheet"} {
		if !strings.Contains(pickerCss, want) {
			t.Errorf("vppicker.css: missing %s", want)
		}
	}

	css := get("/inverter.css")
	if !strings.Contains(css, ".picker-opt") {
		t.Error("inverter.css: missing model picker styles")
	}
	if !strings.Contains(css, ".drawer") || !strings.Contains(css, ".role-card") || !strings.Contains(css, ".verify-panel") {
		t.Error("inverter.css: missing drawer / role-card / verify-panel styles")
	}
	js := get("/inverter.js")
	if !strings.Contains(js, "modelList") {
		t.Error("inverter.js: does not drive the modelList listbox")
	}

	// The shared "Verbindung testen" helper must ship and drive the endpoint.
	verifyJs := get("/verify.js")
	if !strings.Contains(verifyJs, "/api/test-connection") {
		t.Error("verify.js: does not call the /api/test-connection endpoint")
	}
	// A FAILED test must still show what arrived: the core computes the whole
	// diagnosis (Reading + Finding, see testconn.Result) and the surface used to
	// throw both away. These three are the pieces that turn the dead end into a
	// diagnosis - //go:embed contract, so a shipped binary really carries them.
	for _, want := range []string{
		// the reading really reaches the FAILURE panel
		"readingChips(res && res.reading)",
		// the finding is read, and the way forward hangs on the one rule that
		// is a device state instead of a read error
		`finding.rule === "missing"`,
		"VoltPilot-Portal anlegen",
	} {
		if !strings.Contains(verifyJs, want) {
			t.Errorf("verify.js: missing %q - a failed test would drop the finding again", want)
		}
	}
	// The chips of a failure panel take the panel's own tone; without this the
	// values would sit in the red panel wearing the success border.
	if !strings.Contains(css, ".verify-panel.err .vr-chip") {
		t.Error("inverter.css: failure-panel reading chips are unstyled")
	}

	// The Erzeuger + Netz-Zähler groups + the add drawer + its script must ship
	// too (//go:embed rebuild contract), driven by sources.js against fixed ids
	// and the /api/sources endpoints.
	for _, want := range []string{
		`id="srcDrawerBackdrop"`, `id="srcForm"`, `id="rolePick"`,
		`id="srcFields"`, `id="srcKwp"`, `id="srcKwpField"`, `id="srcSee"`, `src="sources.js"`,
		// The three role cards in the add-source picker (incl. the Verbraucher
		// card so a go-e consumer source is UI-complete end to end).
		`id="roleErz"`, `id="roleNetz"`, `id="roleVerbraucher"`,
		// The Verbraucher list group.
		`id="verbList"`, `id="verbAdd"`, `id="verbNote"`,
		// The "Primär misst den gesamten Netzübergang" toggle (Netz group).
		`id="primGridBlock"`, `id="primGridToggle"`, `id="primGridHelp"`,
		// Eigene Geräte (Einheitsmodell Stufe 3/4, Befund L5): the customer's
		// OWN devices. Without this markup the group is silently gone and the
		// devices are invisible on the box again.
		`id="eigenGroup"`, `id="eigenList"`, `id="eigenNote"`, `id="eigenHint"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einrichten.html: missing Energiequellen element %s", want)
		}
	}
	// ⚠ The Eigene-Geräte group carries NO editing at all: a self-built device
	// is created, changed and deleted in the PORTAL. A data-vp-edit button in
	// here would be a promise this page cannot keep (setPortalManaged only
	// hides such buttons on a portal-MANAGED plant - this group must be
	// read-only on every plant).
	if at := strings.Index(page, `id="eigenGroup"`); at >= 0 {
		grp := page[at:]
		if end := strings.Index(grp, "</section>"); end > 0 {
			grp = grp[:end]
		}
		if strings.Contains(grp, "data-vp-edit") || strings.Contains(grp, "add-row") {
			t.Error("einrichten.html: the Eigene-Geräte group must offer no editing - it is a mirror")
		}
	}
	srcJs := get("/sources.js")
	if !strings.Contains(srcJs, "/api/sources") || !strings.Contains(srcJs, "pv-generation") ||
		!strings.Contains(srcJs, "grid-meter") || !strings.Contains(srcJs, "consumer") {
		t.Error("sources.js: does not drive the /api/sources Erzeuger + Netz + Verbraucher surface")
	}
	if !strings.Contains(srcJs, "/api/balance") || !strings.Contains(srcJs, "primary_grid_not_site_total") {
		t.Error("sources.js: does not drive the /api/balance toggle")
	}
	if !strings.Contains(srcJs, "custom_devices") || !strings.Contains(srcJs, "eigenesGeraetRow") {
		t.Error("sources.js: does not render the customer's own devices from custom_devices")
	}
	// The row texts are the PURE VPGroups derivation, so they are provable
	// without a browser (jstest/ui.test.js) - not hand-built strings in here.
	gJs := get("/groups.js")
	for _, want := range []string{"eigenesGeraetRow", "eigenNote", "eigenAdresse",
		"EIGEN_GELESEN_VON_REGEL"} {
		if !strings.Contains(gJs, want) {
			t.Errorf("groups.js: missing the pure Eigene-Geräte derivation %s", want)
		}
	}
}

// TestCalibrationCardServesStructure pins the First-Light calibration card + its
// script so a static/ edit that forgets the //go:embed rebuild contract fails here.
func TestCalibrationCardServesStructure(t *testing.T) {
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
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	// First-Light lives in the "Steuerung freigeben" block of the Einrichten
	// page - deliberately its OWN step, below the guided flow. It must NOT be on
	// the customer-facing Betrieb page (which shows control state only).
	page := get("/einrichten.html")
	for _, want := range []string{
		`id="calCard"`, `id="calState"`, `id="calUnavail"`, `id="calBody"`,
		// ⚠ Die Testleistung ist seit Welle 3 ein VpPicker (vppicker.js) - im
		// Markup steht sein MONTAGEPUNKT, der Auslöser mit `id="calMag"`
		// entsteht erst im Browser. Ohne den Punkt bliebe die Stufenwahl leer.
		`id="calLive"`, `id="calArm"`, `id="calTestStep"`, `id="calMagPicker"`, `id="calMagLabel"`,
		`id="calCharge"`, `id="calDischarge"`, `id="calAbort"`, `id="calVerdict"`,
		`id="calCorrect"`, `id="calInvert"`, `id="calBattInvert"`, `id="calScale"`, `id="calSign"`,
		`id="calConfirm"`, `id="calCertify"`, `id="calDecertify"`, `src="calibration.js"`,
		// Defect 2/3 + admin-gate elements.
		`id="calRatedNote"`, `id="calAuth"`, `id="calToken"`, `id="calUnlock"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einrichten.html: missing calibration element %s", want)
		}
	}
	if strings.Contains(get("/index.html"), `id="calArm"`) {
		t.Error("index.html (Betrieb): must not carry calibration CONTROLS - state only")
	}
	// The script drives the /api/calibration surface end to end, sends the admin token
	// header, and renders the grace-window + rated-ladder + next-step fields.
	calJs := get("/calibration.js")
	for _, want := range []string{
		"/api/calibration", "/api/calibration/arm", "/api/calibration/test",
		"/api/calibration/abort", "/api/calibration/correction",
		"/api/calibration/confirm", "/api/calibration/certify", "/api/calibration/decertify",
		"X-VP-Calibration-Token", "test_steps", "evidence_valid", "next_step_kw", "admin_gate",
	} {
		if !strings.Contains(calJs, want) {
			t.Errorf("calibration.js: does not drive %s", want)
		}
	}
	// einrichten.js hands state to the calibration card for the register readback.
	if !strings.Contains(get("/einrichten.js"), "VPCalibration") {
		t.Error("einrichten.js: does not feed VPCalibration.onState")
	}
}

// TestCalibrationConfirmErrorAndDecertifyRoutes proves the web layer maps an
// evidence-gate confirm refusal to 400 (Gap B) and routes the new decertify endpoint
// (Gap A) to the controller.
func TestCalibrationConfirmErrorAndDecertifyRoutes(t *testing.T) {
	fc := &fakeCalibration{confirmErr: &calibration.ValidationError{Msg: "noch keine Bewegung"}}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, fc, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	// A confirm the agent refuses (evidence gate) -> 400 with the German message.
	resp, err := http.Post(srv.URL+"/api/calibration/confirm", "application/json", strings.NewReader(`{"sign":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("evidence-gated confirm should be 400, got %d", resp.StatusCode)
	}
	var body struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	if body.Error != "noch keine Bewegung" {
		t.Fatalf("confirm error passthrough: %q", body.Error)
	}
	if fc.lastSign == nil || *fc.lastSign != true {
		t.Fatal("confirm route must pass the sign flag to the controller")
	}

	// Decertify routes to the controller and returns 200.
	resp2, err := http.Post(srv.URL+"/api/calibration/decertify", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("decertify should be 200, got %d", resp2.StatusCode)
	}
	if fc.decertifyCalls != 1 {
		t.Fatalf("decertify route must call the controller once, got %d", fc.decertifyCalls)
	}
}

// TestCalibrationAdminGate proves the calibration MUTATION endpoints are gated by the
// admin secret server-side when one is configured, while read-only views stay open and
// an unconfigured secret leaves calibration open (owner request 2026-07-27).
func TestCalibrationAdminGate(t *testing.T) {
	const secret = "geheim-123"
	fc := &fakeCalibration{adminSecret: secret}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, fc, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	postTok := func(path, tok string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+path, strings.NewReader(`{"armed":true}`))
		req.Header.Set("Content-Type", "application/json")
		if tok != "" {
			req.Header.Set("X-VP-Calibration-Token", tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	// The read-only snapshot stays open (no token).
	r, err := http.Get(srv.URL + "/api/calibration")
	if err != nil {
		t.Fatal(err)
	}
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/calibration must stay open, got %d", r.StatusCode)
	}

	// Every mutation endpoint is rejected 401 WITHOUT the token, and the controller is
	// never called.
	for _, path := range []string{"arm", "test", "abort", "confirm", "correction", "certify", "decertify"} {
		resp := postTok("/api/calibration/"+path, "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("POST /api/calibration/%s without token: got %d, want 401", path, resp.StatusCode)
		}
	}
	if fc.lastArmed != nil || fc.aborts != 0 || fc.certifyCalls != 0 || fc.decertifyCalls != 0 {
		t.Fatal("an unauthenticated mutation must NOT reach the controller")
	}

	// A WRONG token is still rejected.
	resp := postTok("/api/calibration/arm", "falsch")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token must be 401, got %d", resp.StatusCode)
	}
	if fc.lastArmed != nil {
		t.Fatal("a wrong token must NOT reach the controller")
	}

	// The CORRECT token passes through to the controller.
	resp = postTok("/api/calibration/arm", secret)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("correct token should be 200, got %d", resp.StatusCode)
	}
	if fc.lastArmed == nil || !*fc.lastArmed {
		t.Fatal("the correct token must reach the arm controller")
	}

	// With NO secret configured, calibration stays open (no token needed) - the
	// non-bricking default that keeps an existing device working on upgrade.
	fcOpen := &fakeCalibration{}
	srv2 := httptest.NewServer(Handler(state.New("edge-open", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, fcOpen, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv2.Close)
	req, _ := http.NewRequest("POST", srv2.URL+"/api/calibration/abort", nil)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("no-secret calibration must stay open, got %d", resp2.StatusCode)
	}
	if fcOpen.aborts != 1 {
		t.Fatal("no-secret abort must reach the controller")
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

	// The former standalone "Einstellungen" page is now the
	// Messwert-Aufbereitung AREA of the Einrichten page. Its despike ids are
	// unchanged except the two buttons, which were renamed to avoid colliding
	// with the inverter form's #saveBtn now that both live on ONE page.
	page := get("/einrichten.html")
	for _, want := range []string{
		`id="presetSeg"`, `id="chanList"`, `id="expertToggle"`,
		`id="despikeSaveBtn"`, `id="despikeResetBtn"`, `id="messwerte"`,
		`href="dashboard.css"`, `href="einstellungen.css"`, `src="einstellungen.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einrichten.html: missing %s", want)
		}
	}
	if !strings.Contains(get("/einstellungen.css"), ".seg-btn") {
		t.Error("einstellungen.css: missing preset segmented control styles")
	}
	js := get("/einstellungen.js")
	if !strings.Contains(js, "/api/despike") {
		t.Error("einstellungen.js: does not call the despike API")
	}
	if !strings.Contains(js, `$("despikeSaveBtn")`) {
		t.Error("einstellungen.js: not wired to the renamed despike buttons")
	}

	// Both pages reach the other one through the SAME two-page nav.
	for _, p := range []string{"/index.html", "/einrichten.html"} {
		nav := get(p)
		if !strings.Contains(nav, `href="einrichten.html"`) || !strings.Contains(nav, `href="index.html"`) {
			t.Errorf("%s: missing the two-page nav", p)
		}
	}
}

// TestRetiredPageUrlsRedirectInsteadOfDisappearing: three pages became two, but
// a bookmark, a printed install sheet or an older doc must never hit a 404.
// /inverter.html and /einstellungen.html stay as redirects into the matching
// area of the one Einrichten page.
func TestRetiredPageUrlsRedirectInsteadOfDisappearing(t *testing.T) {
	srv, _ := newServer(t)
	for path, anchor := range map[string]string{
		"/inverter.html":      "einrichten.html#wechselrichter",
		"/einstellungen.html": "einrichten.html#messwerte",
	} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Errorf("GET %s: status %d, must not 404", path, resp.StatusCode)
		}
		page := string(body)
		// Belt and braces: a meta refresh AND a script redirect AND a plain link,
		// so it works with JS off and is never a dead end.
		for _, want := range []string{
			`http-equiv="refresh"`, anchor, `<a href="` + anchor + `"`,
		} {
			if !strings.Contains(page, want) {
				t.Errorf("%s: missing redirect element %q", path, want)
			}
		}
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
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), pl, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
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
		// Layer 1 - the plain-German state + its reason, always visible.
		`id="ctrlSummary"`, `id="ctrlSummaryTitle"`, `id="ctrlSummaryText"`,
		// WHY the setpoint is what it is (the price-aware in-slot limitation) -
		// NORMAL mode, inside the summary, never behind Technikmodus: a
		// limitation nobody names reads as a defect.
		`id="ctrlReason"`,
		// Layer 2 - the register evidence, on Betrieb behind Technikmodus.
		`id="ctrlRows"`, `id="ctrlTech"`, `id="ctrlBanner"`,
		`Wechselrichter-Steuerung`, `src="control.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing %s", want)
		}
	}
	js := get("/control.js")
	if !strings.Contains(js, "VPControl") {
		t.Error("control.js: does not expose the VPControl hook the page controllers call")
	}
	if !strings.Contains(js, "Abweichung") {
		t.Error("control.js: missing the mismatch wording")
	}
	if !strings.Contains(js, "deriveState") {
		t.Error("control.js: the pure state derivation must stay exported for the unit tests")
	}
	if !strings.Contains(js, "deriveTrim") {
		t.Error("control.js: the pure trim-reason derivation must stay exported for the unit tests")
	}
	// The reason element must NOT sit in a .tech-only block (the cause rule).
	reasonIdx := strings.Index(page, `id="ctrlReason"`)
	techIdx := strings.Index(page, `id="ctrlTech"`)
	if reasonIdx < 0 || techIdx < 0 || reasonIdx > techIdx {
		t.Error("index.html: the reason line must be rendered BEFORE (outside) the Technik block")
	}
	// The Betrieb page shows STATE only - no arm/test/certify button may appear.
	for _, forbidden := range []string{`id="calCertify"`, `id="calCharge"`, `id="calArm"`} {
		if strings.Contains(page, forbidden) {
			t.Errorf("index.html: control BUTTON %s leaked onto the Betrieb page", forbidden)
		}
	}
	// The control STATE is rendered on Einrichten too, but the register
	// evidence table left that page entirely (rework decision 1): it is live
	// monitoring and lives ONLY here on Betrieb, under Technikmodus. The
	// Freigabe workflow links back to it while a calibration is armed/running.
	setup := get("/einrichten.html")
	if !strings.Contains(setup, `id="ctrlSummary"`) {
		t.Error("einrichten.html: missing the control state summary")
	}
	for _, forbidden := range []string{`id="ctrlRows"`, `id="ctrlTech"`, `id="ctrlTable"`} {
		if strings.Contains(setup, forbidden) {
			t.Errorf("einrichten.html: register evidence %s must live only on Betrieb", forbidden)
		}
	}
	if !strings.Contains(setup, `id="calRegisterLink"`) ||
		!strings.Contains(setup, `href="index.html#controlCard"`) {
		t.Error("einrichten.html: the calibration workflow must link to the register evidence on Betrieb")
	}
	calJs := get("/calibration.js")
	if !strings.Contains(calJs, "calRegisterLink") {
		t.Error("calibration.js: does not toggle the register-evidence link while armed/running")
	}
}

// TestBlockedControlReasonIsVisibleWithoutTechnikmodus is the regression guard
// for THE rule of this UI: hidden content must never hide a CAUSE.
//
// A control plan that is EMPTY because something is wrong (unknown nameplate /
// power scale) carries `blocked` + `reason`. That reason must reach the
// customer with Technikmodus OFF - only the register/frame DETAIL may sit
// behind the switch.
func TestBlockedControlReasonIsVisibleWithoutTechnikmodus(t *testing.T) {
	srv, _ := newServer(t)
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	js := get("/control.js")
	// The blocked branch must put the raw reason into the summary text (layer 1),
	// not into the register block.
	if !strings.Contains(js, "c.blocked && c.reason") || !strings.Contains(js, "text: c.reason") {
		t.Error("control.js: the blocked branch no longer surfaces c.reason as the plain-German state")
	}

	page := get("/index.html")
	// The summary must NOT be inside a tech-only block. Slice from the control
	// card to the summary and assert no `.tech-only` container opened in between
	// that is still open (the summary sits directly in the card).
	cardIdx := strings.Index(page, `id="controlCard"`)
	sumIdx := strings.Index(page, `id="ctrlSummary"`)
	techIdx := strings.Index(page, `id="ctrlTech"`)
	if cardIdx < 0 || sumIdx < 0 || techIdx < 0 {
		t.Fatal("index.html: control card / summary / tech block not found")
	}
	if !(cardIdx < sumIdx && sumIdx < techIdx) {
		t.Fatal("index.html: the always-visible summary must come BEFORE the tech block")
	}
	between := page[cardIdx:sumIdx]
	if strings.Contains(between, "tech-only") {
		t.Error("index.html: the control summary sits inside a tech-only block - a cause would be hidden")
	}
	// The status hero (which also names causes) must not be tech-gated either.
	heroIdx := strings.Index(page, `id="statusHero"`)
	causeIdx := strings.Index(page, `id="statusHeroCause"`)
	if heroIdx < 0 || causeIdx < 0 {
		t.Fatal("index.html: status hero / cause not found")
	}
	if strings.Contains(page[heroIdx:causeIdx], "tech-only") {
		t.Error("index.html: the status cause sits inside a tech-only block")
	}
	// status.js is the ONE place that decides the plain-German verdict, and every
	// problem branch it can return carries a cause.
	st := get("/status.js")
	for _, want := range []string{"cause:", "VPStatus", "derive"} {
		if !strings.Contains(st, want) {
			t.Errorf("status.js: missing %s", want)
		}
	}
}

// TestTechnikmodusIsAVisibilityToggleNotAGate pins the three properties the
// concept made load-bearing: same switch on every page, OFF by default on a
// fresh browser, persisted per browser - and NOTHING gated by it.
func TestTechnikmodusIsAVisibilityToggleNotAGate(t *testing.T) {
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
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	for _, p := range []string{"/index.html", "/einrichten.html"} {
		page := get(p)
		for _, want := range []string{
			`id="techToggle"`, `aria-pressed="false"`, `aria-label="Technikmodus"`,
			`id="techBar"`, `id="techBarOff"`, `src="technik.js"`,
		} {
			if !strings.Contains(page, want) {
				t.Errorf("%s: missing Technikmodus element %s", p, want)
			}
		}
	}

	js := get("/technik.js")
	for _, want := range []string{
		`var KEY = "vp.edge.technik"`, // persisted per browser
		"localStorage",
		`classList.toggle("tech-on"`, // pure visibility
		`aria-pressed`,
	} {
		if !strings.Contains(js, want) {
			t.Errorf("technik.js: missing %s", want)
		}
	}
	// It must never touch a credential, a permission or an endpoint: the switch
	// flips a class and remembers the choice, nothing else.
	for _, forbidden := range []string{"fetch(", "/api/", "XMLHttpRequest", "setRequestHeader"} {
		if strings.Contains(js, forbidden) {
			t.Errorf("technik.js: must not reference %q - it reveals, it does not authorize", forbidden)
		}
	}
	// The destructive action stays red-bordered + confirmation-gated in BOTH
	// modes, i.e. it is not inside a tech-only block.
	setup := get("/einrichten.html")
	pIdx := strings.Index(setup, `id="purgeCard"`)
	if pIdx < 0 {
		t.Fatal("einrichten.html: purge card missing")
	}
	if !strings.Contains(setup[:pIdx][max(0, pIdx-400):], "danger-card") {
		t.Error("einrichten.html: the purge card lost its danger-zone framing")
	}
	if strings.Contains(setup[max(0, pIdx-400):pIdx], "tech-only") {
		t.Error("einrichten.html: the destructive action must be visible in BOTH modes")
	}
}

// TestEinrichtenPageServesTheGuidedFlowAndItsAreas pins the second page: the
// derived four-step flow at the top, then the areas in order. Control release
// is deliberately its OWN block below the flow, not a step of it.
func TestEinrichtenPageServesTheGuidedFlowAndItsAreas(t *testing.T) {
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
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	page := get("/einrichten.html")
	for _, want := range []string{
		// the guided flow (it disappears entirely once done - no receded line)
		`id="setupCard"`, `id="setupSteps"`, `id="setupProgress"`, `Daten kommen an`,
		// the legacy anchors, still landing inside the accordion groups
		`id="wechselrichter"`, `id="quellen"`, `id="portal"`, `id="steuerung"`,
		`id="messwerte"`, `id="purgeCard"`,
		// the portal pairing block (reference is withheld until unlocked)
		`id="pairLocked"`, `id="pairUnlocked"`, `id="ref"`, `id="copyBtn"`, `id="pairingError"`,
		`src="commissioning.js"`, `src="groups.js"`, `src="einrichten.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einrichten.html: missing %s", want)
		}
	}
	// The green "Eingerichtet" banner is GONE with no replacement (rework
	// decision 3): Betrieb's status hero is the single health voice.
	for _, forbidden := range []string{`id="setupDone"`, `id="setupDetailBtn"`, `Eingerichtet · Daten kommen an`} {
		if strings.Contains(page, forbidden) {
			t.Errorf("einrichten.html: the receded green banner must be gone, found %s", forbidden)
		}
	}
	// Order: the guided flow first, control release BELOW it.
	if strings.Index(page, `id="setupCard"`) > strings.Index(page, `id="steuerung"`) {
		t.Error("einrichten.html: the control-release block must sit BELOW the guided flow")
	}

	js := get("/commissioning.js")
	for _, want := range []string{
		"VPCommissioning", "derive", "Wechselrichter verbinden",
		"Erzeuger & Zähler erfassen", "Mit dem Portal koppeln", "Messwerte prüfen",
		"claim_unlocked", "last_telemetry", "inverter_link",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("commissioning.js: missing %s", want)
		}
	}
	// The guided flow derives its state from the EXISTING APIs - it must not
	// invent an endpoint or persist wizard progress.
	if strings.Contains(js, "fetch(") {
		t.Error("commissioning.js: must stay a pure derivation (no fetch)")
	}
}

// TestEinrichtenAccordionIsFourClosedGroups pins the rework's core shape: the
// steady state of the page is exactly FOUR accordion groups - Anlage /
// Steuerung / Datenfreigabe / Erweitert - each ONE row (status dot + title +
// summary) built as a real <button> with aria-expanded/-controls, and every
// body CLOSED in the served markup. Healthy = all closed, every visit; any
// opening happens client-side (groups.js shouldAutoOpen on a NEW problem, or
// a deep-link anchor). Presentation only: no gate, no API, no state machine
// changed - the same scripts drive the same endpoints as before.
func TestEinrichtenAccordionIsFourClosedGroups(t *testing.T) {
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
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	page := get("/einrichten.html")
	// Exactly four UNCONDITIONAL group rows, in the decided order,
	// keyboard-accessible.
	//
	// ⚠ The Ladepunkte group (OCPP) is the page's only CONDITIONAL one and is
	// served HIDDEN, so a plant without charge points still shows exactly the
	// four quiet rows this page promises - a fifth row everywhere would be the
	// noise the rework removed. It is counted out here and pinned separately
	// in TestTheLadepunktSurfaceIsServed.
	if n := strings.Count(page, `class="card acc-head"`) - strings.Count(page, `aria-controls="ladepunkteBody"`); n != 4 {
		t.Errorf("einrichten.html: want exactly 4 unconditional accordion group rows, got %d", n)
	}
	if !strings.Contains(page, `data-group="ladepunkte" hidden`) {
		t.Error("einrichten.html: the conditional Ladepunkte group must be served hidden")
	}
	last := -1
	for _, g := range []string{"anlage", "steuerung", "datenfreigabe", "erweitert"} {
		at := strings.Index(page, `data-group="`+g+`"`)
		if at < 0 {
			t.Errorf("einrichten.html: missing accordion group %q", g)
			continue
		}
		if at < last {
			t.Errorf("einrichten.html: group %q out of order", g)
		}
		last = at
	}
	for _, body := range []string{"anlageBody", "steuerungBody", "datenfreigabeBody", "erweitertBody"} {
		if !strings.Contains(page, `aria-controls="`+body+`"`) {
			t.Errorf("einrichten.html: no acc-head controls %q", body)
		}
		if !strings.Contains(page, `id="`+body+`" hidden`) {
			t.Errorf("einrichten.html: group body %q must be CLOSED in the served markup", body)
		}
	}
	if n := strings.Count(page, `class="card acc-head" aria-expanded="false"`); n != 5 {
		t.Errorf("every group row (4 fixed + the hidden Ladepunkte one) must serve aria-expanded=false, got %d", n)
	}

	// The Netzmessung expert exception left the main axis (rework ④): the
	// balance toggle and the purge card both live INSIDE the Erweitert body.
	erwAt := strings.Index(page, `id="erweitertBody"`)
	for _, id := range []string{`id="primGridBlock"`, `id="messwerte"`, `id="expertToggle"`, `id="purgeCard"`} {
		if at := strings.Index(page, id); at < erwAt {
			t.Errorf("einrichten.html: %s must sit inside the Erweitert group", id)
		}
	}
	// The raw "Zuletzt gelesen" line of the inverter row is Technik detail now.
	if !strings.Contains(page, `class="row-meta row-read tech-only" id="invRead"`) {
		t.Error(`einrichten.html: the inverter "Zuletzt gelesen" line must be Technik-gated`)
	}

	// groups.js owns the pure summaries + the auto-open rule; einrichten.js
	// wires the rows, the deep-link reveal and the paired-hides-pairing toggle.
	js := get("/groups.js")
	for _, want := range []string{"VPGroups", "anlageSummary", "steuerungSummary",
		"datenfreigabeSummary", "erweitertSummary", "shouldAutoOpen", "groupForAnchor"} {
		if !strings.Contains(js, want) {
			t.Errorf("groups.js: missing %s", want)
		}
	}
	ej := get("/einrichten.js")
	for _, want := range []string{"groupForAnchor", "shouldAutoOpen", "aria-expanded",
		"vp:mirror-state", "revealHash", "hashchange"} {
		if !strings.Contains(ej, want) {
			t.Errorf("einrichten.js: missing %s", want)
		}
	}
	// Once paired, the pairing card leaves the normal-mode page (tech-only);
	// while unpaired the guided flow still shows it. The mechanism is a class
	// toggle - the server keeps withholding the reference until claim_unlocked.
	if !strings.Contains(ej, `classList.toggle("tech-only", isTechOnly)`) {
		t.Error("einrichten.js: the paired pairing card must recede to Technikmodus")
	}
}

// The "Datenfreigabe im Hausnetz" card (Modbus-Datenspiegel) is a CUSTOMER
// control on the Einrichten page: visible and operable in NORMAL mode - the
// toggle and the copy-ready address must NOT sit behind Technikmodus or any
// admin token; only the register-area/learned-block detail is Technik-gated.
// //go:embed contract: mirror.js must ship and drive GET/POST /api/mirror.
func TestEinrichtenServesTheMirrorCardAsANormalModeCustomerControl(t *testing.T) {
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
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	page := get("/einrichten.html")
	for _, want := range []string{
		`id="datenfreigabe"`, `id="mirrorCard"`, `id="mirrorToggle"`, `id="mirrorPill"`,
		`id="mirrorEndpointRow"`, `id="mirrorEndpoint"`, `id="mirrorCopy"`,
		`id="mirrorDetail"`, `id="mirrorError"`, `src="mirror.js"`,
		`Messwerte per Modbus&nbsp;TCP bereitstellen (nur Lesen)`,
		`Die Steuerung durch
        VoltPilot wird dadurch nicht beeinflusst.`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("einrichten.html: missing mirror element %s", want)
		}
	}
	// The customer toggle + address sit OUTSIDE the tech-only block; only the
	// detail line is Technik-gated. Structural check: within the mirror card,
	// the tech-only block starts AFTER the toggle and the endpoint row.
	card := page[strings.Index(page, `id="mirrorCard"`):]
	if end := strings.Index(card, "</section>"); end > 0 {
		card = card[:end]
	}
	techAt := strings.Index(card, "tech-only")
	if techAt < 0 {
		t.Fatal("mirror card: missing the Technik detail block")
	}
	if at := strings.Index(card, `id="mirrorToggle"`); at < 0 || at > techAt {
		t.Error("mirror card: the toggle must be a NORMAL-mode control, before the tech-only block")
	}
	if at := strings.Index(card, `id="mirrorEndpoint"`); at < 0 || at > techAt {
		t.Error("mirror card: the copy-ready address must be NORMAL-mode, before the tech-only block")
	}
	if at := strings.Index(card, `id="mirrorDetail"`); at < 0 || at < techAt {
		t.Error("mirror card: the register/learned-block detail belongs INSIDE the tech-only block")
	}

	js := get("/mirror.js")
	for _, want := range []string{"/api/mirror", "mirrorToggle", "advertise_port", "location.hostname"} {
		if !strings.Contains(js, want) {
			t.Errorf("mirror.js: missing %s", want)
		}
	}
}

// max is a tiny local helper (the module targets a Go version where the
// builtin may be unavailable in this package's context).
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Defect 1: the register readback table must be VISIBLE during First-Light
// calibration even when the family is uncertified (control_certified === false),
// otherwise the operator/firstmate cannot judge the sign/scale conversion. The
// read-only banner may only win when there is NO calibration evidence. Pin the
// client logic + the label id so a regression that re-adds the unconditional
// uncertified early-return fails here.
func TestControlCardShowsCalibrationEvidenceForUncertifiedModel(t *testing.T) {
	srv := serveHandler(t, &fakePlan{})
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	if page := get("/index.html"); !strings.Contains(page, `id="ctrlCmdLabel"`) {
		t.Error("index.html: missing the ctrlCmdLabel id the calibration framing sets")
	}
	js := get("/control.js")
	for _, want := range []string{
		// The uncertified branch no longer returns unconditionally: it gates on
		// the absence of calibration evidence.
		"s.control_certified === false && !calibrating",
		// The calibration-evidence trigger (uncertified + a register readback).
		"var calibrating = s.control_certified === false",
		// The evidence is reframed as a Kalibrier-Test, not a certified plan.
		"Kalibrier-Test",
		"Kalibrier-Sollwert",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("control.js: calibration evidence path missing %q", want)
		}
	}
}

// The "Betrieb" card (PS-3: Marktoptimierung + Spitzen-Wache) is built by
// betrieb.js against fixed element ids and fed by the additive peak fields on
// /api/state; pin the embedded page + asset so a static/ edit that forgets the
// //go:embed rebuild fails here.
func TestBetriebSectionServed(t *testing.T) {
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
		`id="btMarkt"`, `id="btWache"`, `id="btMeanRow"`, `id="btMean"`,
		`id="btReserveRow"`, `id="btReserve"`, `id="btOffline"`,
		`Spitzen-Wache`, `Marktoptimierung`, `Bei Cloud-Ausfall`, `src="betrieb.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing %s", want)
		}
	}
	js := get("/betrieb.js")
	if !strings.Contains(js, "VPBetrieb") {
		t.Error("betrieb.js: does not expose the VPBetrieb hook dashboard.js calls")
	}
	for _, want := range []string{"peak_target_kw", "peak_quarter_mean_kw", "peak_reserve_soc_pct", "peak_guard_active", "wartet auf Netz-Messwerte"} {
		if !strings.Contains(js, want) {
			t.Errorf("betrieb.js: missing %s", want)
		}
	}
	dash := get("/dashboard.js")
	if !strings.Contains(dash, "VPBetrieb") {
		t.Error("dashboard.js: does not hand state to VPBetrieb")
	}
}

// The additive PS-3 peak fields flow through the /api/state envelope (present
// when the module is on, omitted when off - never a fabricated 0).
func TestStateEnvelopeCarriesPeakGuardFields(t *testing.T) {
	st := state.New("edge-test", "test")
	target, mean, reserve := 62.5, 44.2, 25.0
	st.Update(func(s *state.Snapshot) {
		s.PeakTargetKw = &target
		s.PeakQuarterMeanKw = &mean
		s.PeakReserveSocPct = &reserve
		s.PeakGuardActive = true
	})
	srv := httptest.NewServer(Handler(st,
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got["peak_target_kw"] != 62.5 || got["peak_quarter_mean_kw"] != 44.2 ||
		got["peak_reserve_soc_pct"] != 25.0 || got["peak_guard_active"] != true {
		t.Fatalf("peak fields missing/wrong in envelope: %v", got)
	}

	// Module off: the optional fields are omitted entirely.
	off := state.New("edge-test", "test")
	srv2 := httptest.NewServer(Handler(off,
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv2.Close)
	resp2, err := http.Get(srv2.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	raw, _ := io.ReadAll(resp2.Body)
	for _, absent := range []string{"peak_target_kw", "peak_quarter_mean_kw", "peak_reserve_soc_pct"} {
		if strings.Contains(string(raw), absent) {
			t.Errorf("module off must omit %s: %s", absent, raw)
		}
	}
}

// --- /api/sources (additional read-only Erzeuger measurement points) ---------

func sourcesServer(t *testing.T, fs *fakeSources) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, fs, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)
	return srv
}

func TestSourcesListReturnsSourcesAndCatalog(t *testing.T) {
	srv := sourcesServer(t, &fakeSources{})
	resp, err := http.Get(srv.URL + "/api/sources")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Sources []sources.Source `json:"sources"`
		Catalog inverter.Catalog `json:"catalog"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Sources == nil {
		t.Fatalf("sources should be a (possibly empty) array, not null")
	}
	if len(body.Catalog.Brands) == 0 {
		t.Fatalf("catalog should be embedded so the add form is data-driven")
	}
}

// Einheitsmodell Stufe 3/4 (Befund L5): the devices the CUSTOMER defined
// themselves ride along on the SAME payload the "Anlage" card already fetches.
// They are NOT sources - the applier deliberately skips them, their read plan
// travels as a generated flow - so before this they appeared NOWHERE on :8484.
//
// The field is ADDITIVE and always a LIST: a plant without one gets `[]`, never
// `null` and never an invented group.
func TestSourcesCarriesTheCustomersOwnDevices(t *testing.T) {
	type payload struct {
		Sources []sources.Source              `json:"sources"`
		Custom  []componentapply.CustomDevice `json:"custom_devices"`
	}
	get := func(fs *fakeSources) payload {
		t.Helper()
		resp, err := http.Get(sourcesServer(t, fs).URL + "/api/sources")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body payload
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body
	}

	// A plant without a self-built device: an empty LIST, so the page renders
	// the group off its length instead of every consumer writing the same
	// defensive null check.
	empty := get(&fakeSources{})
	if empty.Custom == nil || len(empty.Custom) != 0 {
		t.Fatalf("custom_devices must be an empty array, got %#v", empty.Custom)
	}

	body := get(&fakeSources{custom: []componentapply.CustomDevice{{
		ID: "zisterne", Label: "Zisterne", Communication: componentapply.CommunicationSelfBuild,
		Host: "192.168.210.77", Port: 502, UnitID: 3, Health: "ok",
		Channels: []componentapply.CustomChannel{{Channel: "fuellstand_pct",
			Label: "Füllstand Zisterne", Unit: "%"}},
	}}})
	if len(body.Custom) != 1 {
		t.Fatalf("want the one self-built device, got %#v", body.Custom)
	}
	d := body.Custom[0]
	if d.Label != "Zisterne" || d.Host != "192.168.210.77" || d.Port != 502 || d.UnitID != 3 {
		t.Errorf("the row's facts must survive the wire: %#v", d)
	}
	if d.Health != "ok" || len(d.Channels) != 1 || d.Channels[0].Label != "Füllstand Zisterne" {
		t.Errorf("health + the customer's OWN channel names must survive: %#v", d)
	}
	// It is NOT a source: the two lists stay separate, so nothing on the box
	// starts reading a device whose read plan lives in a flow.
	if len(body.Sources) != 0 {
		t.Errorf("a self-built device must never appear as a source: %#v", body.Sources)
	}
}

// The expert opt-out ("Die Netzmessung des Wechselrichters sitzt NICHT am
// Hausanschluss"): GET /api/sources carries the persisted settings (so the
// page renders them without a second call) and POST /api/balance writes them;
// malformed JSON is a 400.
func TestBalanceToggleRoundTrip(t *testing.T) {
	fs := &fakeSources{}
	srv := sourcesServer(t, fs)

	readBalance := func() bool {
		t.Helper()
		resp, err := http.Get(srv.URL + "/api/sources")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body struct {
			Balance sources.BalanceSettings `json:"balance"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body.Balance.PrimaryGridNotSiteTotal
	}

	if readBalance() {
		t.Fatal("opt-out must default to false (the standard is ON by default)")
	}

	resp, err := http.Post(srv.URL+"/api/balance", "application/json",
		strings.NewReader(`{"primary_grid_not_site_total": true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("set status %d", resp.StatusCode)
	}
	var set struct {
		Balance sources.BalanceSettings `json:"balance"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&set); err != nil {
		t.Fatal(err)
	}
	if !set.Balance.PrimaryGridNotSiteTotal || !fs.bal.PrimaryGridNotSiteTotal {
		t.Fatalf("toggle not applied: resp %+v, fake %+v", set.Balance, fs.bal)
	}
	if !readBalance() {
		t.Fatal("GET /api/sources does not echo the new opt-out state")
	}

	bad, err := http.Post(srv.URL+"/api/balance", "application/json", strings.NewReader(`{nope`))
	if err != nil {
		t.Fatal(err)
	}
	defer bad.Body.Close()
	if bad.StatusCode != 400 {
		t.Fatalf("malformed body: status %d, want 400", bad.StatusCode)
	}
}

func TestSourcesAddAndDelete(t *testing.T) {
	fs := &fakeSources{}
	srv := sourcesServer(t, fs)

	reqBody := `{"role":"pv-generation","brand":"generic_modbus","model":"sunspec","connection":{"ip":"192.168.0.70"},"capacity_kwp":70}`
	resp, err := http.Post(srv.URL+"/api/sources", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("add status %d", resp.StatusCode)
	}
	var added struct {
		Source sources.Source `json:"source"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}
	if added.Source.ID == "" || added.Source.CapacityKwp != 70 {
		t.Fatalf("added source wrong: %+v", added.Source)
	}
	if len(fs.list) != 1 {
		t.Fatalf("source not stored: %d", len(fs.list))
	}

	// DELETE the source.
	del, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/sources/"+added.Source.ID, nil)
	dresp, err := http.DefaultClient.Do(del)
	if err != nil {
		t.Fatal(err)
	}
	dresp.Body.Close()
	if dresp.StatusCode != 200 {
		t.Fatalf("delete status %d", dresp.StatusCode)
	}
	if len(fs.list) != 0 {
		t.Fatalf("source not removed")
	}

	// DELETE an unknown id -> 404.
	del2, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/sources/nope", nil)
	d2, err := http.DefaultClient.Do(del2)
	if err != nil {
		t.Fatal(err)
	}
	d2.Body.Close()
	if d2.StatusCode != 404 {
		t.Fatalf("delete unknown status = %d, want 404", d2.StatusCode)
	}
}

// Rename is label-only (PUT /api/sources/{id}): the id - and with it the
// cloud's adoption pin - survives, which is the whole point (before this the
// only "rename" was delete + re-add = a new id, vp-vier-erzeuger-p9).
func TestSourcesRenameIsLabelOnly(t *testing.T) {
	fs := &fakeSources{}
	srv := sourcesServer(t, fs)

	reqBody := `{"role":"pv-generation","brand":"generic_modbus","model":"sunspec","connection":{"ip":"192.168.0.70"},"capacity_kwp":70}`
	resp, err := http.Post(srv.URL+"/api/sources", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	var added struct {
		Source sources.Source `json:"source"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	put := func(id, body string) (*http.Response, sources.Source) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/sources/"+id,
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var out struct {
			Source sources.Source `json:"source"`
		}
		_ = json.NewDecoder(r.Body).Decode(&out)
		r.Body.Close()
		return r, out.Source
	}

	r, renamed := put(added.Source.ID, `{"label":"Fronius Anlage WR2"}`)
	if r.StatusCode != 200 {
		t.Fatalf("rename status %d, want 200", r.StatusCode)
	}
	if renamed.ID != added.Source.ID {
		t.Fatalf("rename must keep the id: %q -> %q", added.Source.ID, renamed.ID)
	}
	if renamed.Label != "Fronius Anlage WR2" || fs.list[0].Label != "Fronius Anlage WR2" {
		t.Fatalf("label not updated: %+v", renamed)
	}
	if fs.list[0].Connection.IP != "192.168.0.70" || fs.list[0].CapacityKwp != 70 {
		t.Fatalf("rename must not touch transport/master data: %+v", fs.list[0])
	}

	if r, _ := put("nope", `{"label":"X"}`); r.StatusCode != 404 {
		t.Fatalf("rename unknown id: status %d, want 404", r.StatusCode)
	}
	if r, _ := put(added.Source.ID, `{"label":"   "}`); r.StatusCode != 400 {
		t.Fatalf("empty label: status %d, want 400", r.StatusCode)
	}
	if r, _ := put(added.Source.ID, `{nope`); r.StatusCode != 400 {
		t.Fatalf("malformed body: status %d, want 400", r.StatusCode)
	}
}

func TestSourcesAddNetzMeter(t *testing.T) {
	fs := &fakeSources{}
	srv := sourcesServer(t, fs)
	// A grid meter carries no capacity_kwp; the transport is validated like any
	// source. Increment 1 accepts it (200).
	reqBody := `{"role":"grid-meter","brand":"generic_modbus","model":"sunspec","connection":{"ip":"192.168.0.71"}}`
	resp, err := http.Post(srv.URL+"/api/sources", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("add Netz status %d, want 200", resp.StatusCode)
	}
	var added struct {
		Source sources.Source `json:"source"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&added); err != nil {
		t.Fatal(err)
	}
	if added.Source.Role != sources.RoleNetz || added.Source.CapacityKwp != 0 {
		t.Fatalf("added Netz meter wrong: %+v", added.Source)
	}
}

func TestSourcesAddValidationErrorIs400(t *testing.T) {
	srv := sourcesServer(t, &fakeSources{})
	// An unknown role (wallbox is reserved, not yet configurable) -> the normalize
	// validation refuses it (400). grid-meter is now accepted (Increment 1).
	body := `{"role":"wallbox","brand":"generic_modbus","model":"sunspec","connection":{"ip":"1.2.3.4"}}`
	resp, err := http.Post(srv.URL+"/api/sources", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	var e struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&e)
	if e.Error == "" {
		t.Fatalf("expected a German error message")
	}
}

// The sources listing carries a per-source live status ("ok"|"warn"|"pending")
// so the page can render the status dot next to each source without a second
// call (backend dep A of the inverter-setup redesign).
func TestSourcesListReturnsPerSourceStatus(t *testing.T) {
	fs := &fakeSources{
		list: []sources.Source{
			{ID: "src-a", Role: sources.RoleErzeuger, Brand: "generic_modbus"},
			{ID: "src-b", Role: sources.RoleNetz, Brand: "generic_modbus"},
		},
		statuses: map[string]string{"src-a": "ok", "src-b": "pending"},
	}
	srv := sourcesServer(t, fs)
	resp, err := http.Get(srv.URL + "/api/sources")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Sources  []sources.Source  `json:"sources"`
		Statuses map[string]string `json:"statuses"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Statuses == nil {
		t.Fatalf("statuses should be a (possibly empty) map, not null")
	}
	if body.Statuses["src-a"] != "ok" || body.Statuses["src-b"] != "pending" {
		t.Fatalf("per-source status wrong: %+v", body.Statuses)
	}
}

// The sources listing carries each source's last accepted reading + when it was
// read ("Zuletzt gelesen"), plus the device clock so the page computes honest
// "vor X" ages. A source that never delivered is ABSENT from the map - the page
// keeps its "Wartet auf erste Daten" state instead of a fabricated value.
func TestSourcesListReturnsLastReadingsWithServerClock(t *testing.T) {
	pv := 20.1
	grid := -3.4
	readAt := time.Now().Add(-12 * time.Second).UnixMilli()
	fs := &fakeSources{
		list: []sources.Source{
			{ID: "src-a", Role: sources.RoleErzeuger, Brand: "generic_modbus"},
			{ID: "src-b", Role: sources.RoleNetz, Brand: "generic_modbus"},
			{ID: "src-c", Role: sources.RoleErzeuger, Brand: "generic_modbus"}, // never read
		},
		readings: map[string]sources.LastReading{
			"src-a": {PvKw: &pv, ReadAtMs: readAt},
			"src-b": {PowerKw: &grid, ReadAtMs: readAt},
		},
	}
	srv := sourcesServer(t, fs)
	resp, err := http.Get(srv.URL + "/api/sources")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Readings    map[string]sources.LastReading `json:"readings"`
		ServerNowMs int64                          `json:"server_now_ms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Readings == nil {
		t.Fatalf("readings should be a (possibly empty) map, not null")
	}
	a := body.Readings["src-a"]
	if a.PvKw == nil || *a.PvKw != 20.1 || a.ReadAtMs != readAt || a.PowerKw != nil {
		t.Fatalf("Erzeuger reading wrong: %+v", a)
	}
	b := body.Readings["src-b"]
	if b.PowerKw == nil || *b.PowerKw != -3.4 || b.ReadAtMs != readAt || b.PvKw != nil {
		t.Fatalf("Netz reading wrong: %+v", b)
	}
	if _, ok := body.Readings["src-c"]; ok {
		t.Fatalf("never-read source must be absent, never a fabricated value")
	}
	if body.ServerNowMs <= 0 {
		t.Fatalf("server_now_ms missing (the page needs the device clock for ages)")
	}
}

// The state envelope carries the PRIMARY inverter's last accepted reading with
// per-channel presence (last_reading), so the setup page shows the device's own
// values + LastTelemetry timestamp. Absent channels (a batteryless inverter's
// SoC) stay absent; before any telemetry the key is omitted entirely.
func TestStateExposesPrimaryLastReading(t *testing.T) {
	st := state.New("edge-test", "test")
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()},
		&fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	getState := func() map[string]any {
		t.Helper()
		resp, err := http.Get(srv.URL + "/api/state")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body
	}

	if _, ok := getState()["last_reading"]; ok {
		t.Fatalf("last_reading must be omitted before any telemetry (honest empty state)")
	}

	ts := time.Now().UTC().Truncate(time.Second)
	st.Update(func(s *state.Snapshot) {
		s.LastTelemetry = ts
		s.LastReading = map[string]float64{"pv_power_kw": 4.2, "power_kw": -1.1}
	})
	body := getState()
	lr, ok := body["last_reading"].(map[string]any)
	if !ok {
		t.Fatalf("last_reading missing: %v", body["last_reading"])
	}
	if lr["pv_power_kw"] != 4.2 || lr["power_kw"] != -1.1 {
		t.Fatalf("last_reading values wrong: %+v", lr)
	}
	if _, ok := lr["soc_pct"]; ok {
		t.Fatalf("never-delivered channel must stay absent, never a fabricated 0")
	}
	if body["last_telemetry"] == nil {
		t.Fatalf("last_telemetry timestamp missing alongside the reading")
	}
}

// POST /api/test-connection passes the unsaved form to TestConnection and
// returns its result verbatim (backend dep B). The endpoint never persists and
// answers HTTP 200 for both ok and classified-error outcomes.
func TestTestConnectionReturnsControllerResult(t *testing.T) {
	fi := &fakeInverter{
		cat:        inverter.DefaultCatalog(),
		testResult: testconn.Result{OK: true, Reading: &testconn.Reading{PvKw: ptr(4.8), SocPct: ptr(62)}},
	}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		fi, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	reqBody := `{"role":"pv-generation","brand":"generic_modbus","model":"sunspec","connection":{"ip":"192.168.0.70"}}`
	resp, err := http.Post(srv.URL+"/api/test-connection", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var res testconn.Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Reading == nil || res.Reading.PvKw == nil || *res.Reading.PvKw != 4.8 {
		t.Fatalf("result not returned verbatim: %+v", res)
	}
	// The controller saw the unsaved form (role + brand carried through).
	if fi.testReq == nil || fi.testReq.Role != "pv-generation" || fi.testReq.Brand != "generic_modbus" {
		t.Fatalf("TestConnection did not receive the form: %+v", fi.testReq)
	}
}

// POST /api/probe-units passes the unsaved form to ProbeUnits and returns the
// found unit ids verbatim (multi-inverter at one Datamanager auto-detection).
func TestProbeUnitsReturnsControllerResult(t *testing.T) {
	fi := &fakeInverter{
		cat:         inverter.DefaultCatalog(),
		probeResult: testconn.Result{OK: true, FoundUnits: []int{1, 2}},
	}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		fi, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)

	reqBody := `{"brand":"fronius_sunspec","model":"fronius-eco-27-3-s","connection":{"ip":"192.168.210.40","unit_id":1}}`
	resp, err := http.Post(srv.URL+"/api/probe-units", "application/json", strings.NewReader(reqBody))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var res testconn.Result
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		t.Fatal(err)
	}
	if !res.OK || len(res.FoundUnits) != 2 || res.FoundUnits[0] != 1 || res.FoundUnits[1] != 2 {
		t.Fatalf("probe result not returned verbatim: %+v", res)
	}
	if fi.probeReq == nil || fi.probeReq.Brand != "fronius_sunspec" {
		t.Fatalf("ProbeUnits did not receive the form: %+v", fi.probeReq)
	}
}

func TestTestConnectionMalformedBodyReturns400(t *testing.T) {
	fi := &fakeInverter{cat: inverter.DefaultCatalog()}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		fi, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	t.Cleanup(srv.Close)
	resp, err := http.Post(srv.URL+"/api/test-connection", "application/json", strings.NewReader("{bad"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

// TestStateEnvelopeCarriesTopology proves the AE1 read-model rides the
// /api/state envelope additively: an empty topology is always present (nodes:
// []), and a device with entities carries its role-grouped nodes.
func TestStateEnvelopeCarriesTopology(t *testing.T) {
	pv := 6.4
	topo := topology.Topology{SchemaVersion: topology.SchemaVersion, Nodes: []topology.FlowNode{
		{Role: topology.RolePV, ValueKw: &pv, FlowActive: true, Direction: "in",
			Members: []topology.FlowMember{{EntityID: "P", Label: "PV Dach", Primary: true, ValueKw: &pv}}},
	}}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{topo: topo}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got struct {
		Topology topology.Topology `json:"topology"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Topology.SchemaVersion != topology.SchemaVersion {
		t.Fatalf("topology schema_version = %q", got.Topology.SchemaVersion)
	}
	if len(got.Topology.Nodes) != 1 || got.Topology.Nodes[0].Role != topology.RolePV {
		t.Fatalf("topology nodes = %+v", got.Topology.Nodes)
	}

	// Empty topology (no entities) still serializes nodes: [].
	srv2 := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv2.Close()
	resp2, err := http.Get(srv2.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	raw, _ := io.ReadAll(resp2.Body)
	if !strings.Contains(string(raw), `"topology":{"schema_version":"1.0","nodes":[]}`) {
		t.Fatalf("empty topology not present in envelope: %s", raw)
	}
}

// TestStateEnvelopeCarriesActiveControl proves the read-only "Aktive Steuerung"
// view (report §7) rides the /api/state envelope additively: a populated view
// carries the deployed flow acks + the per-entity arbitration winner, and an
// empty view still serializes flows: [] / entities: [] (the page empty state).
func TestStateEnvelopeCarriesActiveControl(t *testing.T) {
	sp := 3.4
	match := true
	ac := cloud.ActiveControl{
		PaletteVersion: "0.2.0",
		Flows: []cloud.AppliedFlow{
			{FlowID: "flow-a", FlowVersion: 2, ContentHash: "h", State: "active"},
		},
		Entities: []cloud.ActiveControlEntity{
			{EntityID: "batt", Label: "Speicher", Type: "battery-hybrid",
				Holder: "flow", Source: "desired", SetpointKw: &sp, AllMatch: &match},
		},
	}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{ac: ac}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got struct {
		ActiveControl cloud.ActiveControl `json:"active_control"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.ActiveControl.PaletteVersion != "0.2.0" {
		t.Fatalf("palette_version = %q", got.ActiveControl.PaletteVersion)
	}
	if len(got.ActiveControl.Flows) != 1 || got.ActiveControl.Flows[0].State != "active" {
		t.Fatalf("flows = %+v", got.ActiveControl.Flows)
	}
	if len(got.ActiveControl.Entities) != 1 {
		t.Fatalf("entities = %+v", got.ActiveControl.Entities)
	}
	e := got.ActiveControl.Entities[0]
	if e.Label != "Speicher" || e.Holder != "flow" || e.Source != "desired" ||
		e.SetpointKw == nil || *e.SetpointKw != sp || e.AllMatch == nil || !*e.AllMatch {
		t.Fatalf("entity winner = %+v", e)
	}

	// Empty view (no flows, no decisions) still serializes flows/entities as [].
	srv2 := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv2.Close()
	resp2, err := http.Get(srv2.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	raw, _ := io.ReadAll(resp2.Body)
	if !strings.Contains(string(raw), `"active_control":{"flows":[],"entities":[]}`) {
		t.Fatalf("empty active_control not present in envelope: %s", raw)
	}
}

// TestActiveControlStripServed pins the read-only "Aktive Steuerung" strip in
// the dashboard (index.html + its script) so a static/ edit that drops it
// fails the //go:embed rebuild contract.
func TestActiveControlStripServed(t *testing.T) {
	srv, _ := newServer(t)

	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	page := get("/")
	for _, want := range []string{
		`id="actctrlBody"`, `id="actFlowsGroup"`, `id="actFlowsList"`,
		`id="actEntsGroup"`, `id="actEntsList"`, `id="actctrlEmpty"`,
		`src="active-control.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing Aktive-Steuerung element %s", want)
		}
	}
	js := get("/active-control.js")
	if !strings.Contains(js, "active_control") || !strings.Contains(js, "VPActiveControl") {
		t.Error("active-control.js: does not render state.active_control")
	}
	if !strings.Contains(js, "onState") {
		t.Error("active-control.js: missing onState hook dashboard.js calls")
	}
	// M7 (report §7): the strip names what runs in the CANONICAL customer mode
	// vocabulary ("Modi", decision F3), byte-identical to the portal read-model
	// frontend/portal/src/surface.ts MODE_LABELS. Pin the labels so a rename on
	// either side is caught instead of silently drifting apart. Copy only - the
	// edge derives no mode, it only speaks the same words.
	for _, want := range []string{
		"Eigenverbrauch", "Lastspitzenkappung", "Marktvermarktung", "Atypische Netznutzung",
	} {
		if !strings.Contains(js, want) {
			t.Errorf("active-control.js: missing canonical mode label %q", want)
		}
	}
	if strings.Contains(js, "Ablauf") {
		t.Error("active-control.js: retired wording \"Ablauf\" - use Modus/Automation (F3)")
	}
	if !strings.Contains(page, "Aktive Modi &amp; Automationen") {
		t.Error("index.html: Aktive-Steuerung group is not named in the mode vocabulary")
	}
}

// The AE6 adaptive energy picture: the dashboard grows an adaptive-tiles mount
// (#kpisAdaptive) and dashboard.js routes the #flowWrap diagram + the tiles off
// the /api/state topology block, with the fixed 4-node diagram + 4 KPI cards as
// the v1 fallback. Pin the embedded page + script so a static/ edit that forgets
// the //go:embed rebuild contract (any go build/test re-embeds) fails here.
func TestAdaptiveEnergyPictureServed(t *testing.T) {
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

	page := get("/index.html")
	// The adaptive-tiles mount alongside the fixed v1 KPI section, and the pure
	// role rules load BEFORE the page that consumes them - without the tag the
	// whole Betrieb page would be silently dead.
	for _, want := range []string{`id="kpisAdaptive"`, `id="kpis"`, `id="flowWrap"`, `src="flowrollen.js"`} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing %s", want)
		}
	}
	if i, j := strings.Index(page, `src="flowrollen.js"`), strings.Index(page, `src="dashboard.js"`); i < 0 || j < 0 || i > j {
		t.Error("index.html: flowrollen.js must load before dashboard.js")
	}

	dash := get("/dashboard.js")
	for _, want := range []string{
		// The topology gate + the two adaptive renderers.
		"hasTopology", "buildAdaptiveFlow", "renderAdaptiveTiles", "deriveTiles",
		// The controller that routes v1 vs adaptive, and reads the state topology.
		"createFlow", ".topology",
		// The role vocabulary the adaptive picture groups on.
		"storage", "consumer",
		// A1 parity (PR 4b): the composition affordance.
		"flow-comp", "über den Wechselrichter mitgemessen",
		// The pure rules live in their own module; this page only draws them.
		"VPFlowRollen",
	} {
		if !strings.Contains(dash, want) {
			t.Errorf("dashboard.js: missing %s", want)
		}
	}
	// ⚠ Die Rollen-Liste ist der Zwilling von internal/topology: seit PR 550
	// liefert DefaultRole für eine Wallbox `charging`/`charging-own`. Fehlt das
	// Wort hier, verschwindet der Knoten samt Kachel STILL (Befund L3).
	roles := get("/flowrollen.js")
	for _, want := range []string{
		"ROLE_NODE_LABEL", "subLabelFor", "Geräte", "flowLayout", "deriveTiles",
		topology.RoleCharging, topology.RoleChargingOwn,
		"Laden", "Ladepunkt", "eigener Anschluss",
	} {
		if !strings.Contains(roles, want) {
			t.Errorf("flowrollen.js: missing %s", want)
		}
	}
	for _, role := range []string{
		topology.RolePV, topology.RoleStorage, topology.RoleConsumer,
		topology.RoleGrid, topology.RoleCharging, topology.RoleChargingOwn,
	} {
		if !strings.Contains(roles, `"`+role+`"`) {
			t.Errorf("flowrollen.js: role %q has no place - its node and tile would vanish", role)
		}
	}
}

// TestCalibrationEndpoints wires the /api/calibration surface to a recording fake:
// each route forwards its parsed input to the controller and returns the snapshot,
// and a *calibration.ValidationError maps to HTTP 400 (not 500).
func TestCalibrationEndpoints(t *testing.T) {
	fc := &fakeCalibration{snap: calibration.Snapshot{Armed: true, Available: true, MaxKw: 1.0, TtlSeconds: 30}}
	srv := httptest.NewServer(Handler(state.New("edge-cal", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10),
		&fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, fc, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	// GET returns the snapshot under a "calibration" key.
	resp, err := http.Get(srv.URL + "/api/calibration")
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Calibration calibration.Snapshot `json:"calibration"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !got.Calibration.Armed || got.Calibration.MaxKw != 1.0 {
		t.Fatalf("GET snapshot: %+v", got.Calibration)
	}

	post := func(path, body string) int {
		r, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		return r.StatusCode
	}

	if code := post("/api/calibration/arm", `{"armed":true}`); code != 200 {
		t.Fatalf("arm status %d", code)
	}
	if fc.lastArmed == nil || !*fc.lastArmed {
		t.Fatalf("arm not forwarded: %v", fc.lastArmed)
	}
	if code := post("/api/calibration/test", `{"direction":"discharge","magnitude_kw":0.5}`); code != 200 {
		t.Fatalf("test status %d", code)
	}
	if fc.lastTestDir != "discharge" || fc.lastTestKw != 0.5 {
		t.Fatalf("test not forwarded: %q %v", fc.lastTestDir, fc.lastTestKw)
	}
	if code := post("/api/calibration/abort", ``); code != 200 || fc.aborts != 1 {
		t.Fatalf("abort status %d aborts %d", code, fc.aborts)
	}
	if code := post("/api/calibration/confirm", `{"sign":true,"scale":true}`); code != 200 {
		t.Fatalf("confirm status %d", code)
	}
	if fc.lastSign == nil || !*fc.lastSign || fc.lastScale == nil || !*fc.lastScale {
		t.Fatalf("confirm not forwarded: %v %v", fc.lastSign, fc.lastScale)
	}
	if code := post("/api/calibration/correction", `{"invert_control_sign":true,"power_scale":10}`); code != 200 {
		t.Fatalf("correction status %d", code)
	}
	if fc.lastInvertSig == nil || !*fc.lastInvertSig || fc.lastPowScale == nil || *fc.lastPowScale != 10 {
		t.Fatalf("correction not forwarded: %v %v", fc.lastInvertSig, fc.lastPowScale)
	}
	// The READ-side measured-battery-sign correction is forwarded too (Defect 1).
	fc.lastInvertBatt = nil
	if code := post("/api/calibration/correction", `{"invert_batt_sign":true}`); code != 200 {
		t.Fatalf("batt-sign correction status %d", code)
	}
	if fc.lastInvertBatt == nil || !*fc.lastInvertBatt {
		t.Fatalf("invert_batt_sign not forwarded: %v", fc.lastInvertBatt)
	}
	if code := post("/api/calibration/certify", ``); code != 200 || fc.certifyCalls != 1 {
		t.Fatalf("certify status %d calls %d", code, fc.certifyCalls)
	}

	// A validation error maps to 400 with a German message + the snapshot.
	fc.armErr = &calibration.ValidationError{Msg: "Not-Aus aktiv."}
	if code := post("/api/calibration/arm", `{"armed":true}`); code != 400 {
		t.Fatalf("a validation error must be 400, got %d", code)
	}
}

// TestCurtailmentSurfaceServed pins the //go:embed contract of the PV-
// curtailment surface: the Betrieb card (summary always visible, per-unit
// register evidence as Technik detail), the Einrichten calibration card + its
// script, and the /api/curtail endpoints (GET open; mutations behind the
// calibration admin gate like every calibration mutation).
func TestCurtailmentSurfaceServed(t *testing.T) {
	srv, _ := newServer(t)

	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	page := get("/")
	for _, want := range []string{
		`id="curtailCard"`, `id="curtailSummary"`, `id="curtailTitle"`,
		`id="curtailText"`, `id="curtailUnits"`,
	} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing PV-Abregelung element %s", want)
		}
	}
	ein := get("/einrichten.html")
	for _, want := range []string{
		`id="curtailCalCard"`, `id="curtailCalUnits"`, `id="curtailErr"`,
		`src="curtail.js"`,
	} {
		if !strings.Contains(ein, want) {
			t.Errorf("einrichten.html: missing PV-Abregelung element %s", want)
		}
	}
	js := get("/curtail.js")
	for _, want := range []string{"/api/curtail", "X-VP-Calibration-Token"} {
		if !strings.Contains(js, want) {
			t.Errorf("curtail.js: missing %s", want)
		}
	}
	ctrl := get("/control.js")
	if !strings.Contains(ctrl, "deriveCurtail") {
		t.Error("control.js: deriveCurtail missing")
	}
}

// The dynamic feed-in limitation's state must be reachable in NORMAL mode: it
// is a compliance limit, and the one sentence that matters most ("this cap
// reaches no device") may never sit behind Technikmodus - the operator reading
// it is about to disconnect the controller that holds the limit today.
func TestFeedInWatchdogStateIsVisibleWithoutTechnikmodus(t *testing.T) {
	srv, _ := newServer(t)
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}

	page := get("/index.html")
	if !strings.Contains(page, `id="curtailExport"`) {
		t.Fatal("index.html: the feed-in watchdog line is missing from the PV-Abregelung card")
	}
	// It sits INSIDE the always-visible summary, before the Technik block.
	expIdx := strings.Index(page, `id="curtailExport"`)
	techIdx := strings.Index(page, `id="curtailTech"`)
	if techIdx < 0 || expIdx > techIdx {
		t.Error("index.html: the watchdog line must render BEFORE (outside) the Technik block")
	}
	// ...and nothing between the card and the line opened a tech-only block.
	cardIdx := strings.Index(page, `id="curtailCard"`)
	if cardIdx < 0 || strings.Contains(page[cardIdx:expIdx], "tech-only") {
		t.Error("index.html: the watchdog line sits inside a tech-only block - a cause would be hidden")
	}
	// The NUMBERS row belongs in the Technik Betrieb card (the peak-guard twin).
	for _, want := range []string{`id="btEinspeiseRow"`, `id="btEinspeise"`, `id="btEinspeiseZiel"`} {
		if !strings.Contains(page, want) {
			t.Errorf("index.html: missing feed-in watchdog element %s", want)
		}
	}
	ctrl := get("/control.js")
	if !strings.Contains(ctrl, "deriveExportGuard") {
		t.Error("control.js: the pure watchdog derivation must stay exported for the unit tests")
	}
	if !strings.Contains(get("/betrieb.js"), "export_guard") {
		t.Error("betrieb.js: does not read the watchdog state")
	}

	// „Grenzen & Wächter" Stufe 0: the limit the DEVICE itself holds sits next to
	// the watchdog - the same quantity at the same grid connection point, only set
	// by somebody else. The SENTENCE is always visible; only its REGISTER (the
	// evidence) is Technikmodus.
	devIdx := strings.Index(page, `id="curtailDevice"`)
	if devIdx < 0 {
		t.Fatal("index.html: the device's own feed-in limit line is missing")
	}
	if strings.Contains(page[cardIdx:devIdx], "tech-only") {
		t.Error("index.html: the device-limit SENTENCE must not sit inside a tech-only block")
	}
	regIdx := strings.Index(page, `id="curtailDeviceReg"`)
	if regIdx < 0 || !strings.Contains(page[devIdx:regIdx+40], "tech-only") {
		t.Error("index.html: the register line is the evidence and belongs behind Technikmodus")
	}
	if !strings.Contains(ctrl, "deriveDeviceExportLimit") {
		t.Error("control.js: the pure device-limit derivation must stay exported for the unit tests")
	}
}

// TestCurtailEndpoints exercises the /api/curtail surface against the fake
// controller: the GET view, a mutation routed with its source id, the 400
// mapping of a *curtailcal.ValidationError, and the admin gate on mutations.
func TestCurtailEndpoints(t *testing.T) {
	fc := &fakeCalibration{curtailView: curtailcal.View{Available: true,
		Units: []curtailcal.UnitView{{SourceID: "src-1", UnitKey: "1.2.3.4:502#1"}}}}
	st := state.New("edge-test", "test")
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, fc, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	// GET is open and carries the view.
	resp, err := http.Get(srv.URL + "/api/curtail")
	if err != nil {
		t.Fatal(err)
	}
	var view struct {
		Curtail curtailcal.View `json:"curtail"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(view.Curtail.Units) != 1 || view.Curtail.Units[0].SourceID != "src-1" {
		t.Fatalf("view: %+v", view.Curtail)
	}

	// A mutation routes the source id through.
	resp, err = http.Post(srv.URL+"/api/curtail/test", "application/json", strings.NewReader(`{"source_id":"src-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || fc.lastCurtailTest != "src-1" {
		t.Fatalf("test mutation: %d, %q", resp.StatusCode, fc.lastCurtailTest)
	}

	// A ValidationError maps to 400 with the German message.
	fc.curtailErr = &curtailcal.ValidationError{Msg: "Zu wenig Leistung."}
	resp, err = http.Post(srv.URL+"/api/curtail/certify", "application/json", strings.NewReader(`{"source_id":"src-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || body["error"] != "Zu wenig Leistung." {
		t.Fatalf("validation mapping: %d %v", resp.StatusCode, body)
	}
	fc.curtailErr = nil

	// With the admin secret set, a mutation without the token is 401; GET stays open.
	fc.adminSecret = "geheim"
	resp, err = http.Post(srv.URL+"/api/curtail/abort", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("mutation without token must be 401, got %d", resp.StatusCode)
	}
	if fc.curtailAborts != 0 {
		t.Fatal("the gated mutation must not have run")
	}
	resp, err = http.Get(srv.URL + "/api/curtail")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET stays open under the gate, got %d", resp.StatusCode)
	}
	req, _ := http.NewRequest("POST", srv.URL+"/api/curtail/abort", nil)
	req.Header.Set("X-VP-Calibration-Token", "geheim")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || fc.curtailAborts != 1 {
		t.Fatalf("token-carrying mutation must run: %d, aborts=%d", resp.StatusCode, fc.curtailAborts)
	}
}

// TestDevaluingActionsAskBeforeActing pins the E3 "Nebenwirkungs-Regel" at the
// //go:embed + call-site level: the shared consequence layer must SHIP with the
// page, and every control that devalues a released/confirmed/recorded state
// must route through it instead of POSTing straight away.
//
// The behaviour itself (dialog text, cancel changes nothing, confirm executes)
// is proven at click level in jstest/ui.test.js; this test is the structural
// guard that a future edit cannot quietly drop the gate again - which is
// exactly how the calibration corrections silently revoked the control release
// (Wunde 2: agent/calibration.go CalibrationCorrection resets the confirmations
// AND deletes the per-device certification, while the button only said
// "umkehren").
func TestDevaluingActionsAskBeforeActing(t *testing.T) {
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

	// The page loads the shared layer, and it loads it BEFORE its consumers.
	page := get("/einrichten.html")
	if !strings.Contains(page, `src="consequences.js"`) {
		t.Fatal("einrichten.html: does not load consequences.js - every consequence question would silently vanish")
	}
	for _, consumer := range []string{"calibration.js", "curtail.js", "sources.js", "inverter.js"} {
		if strings.Index(page, `src="consequences.js"`) > strings.Index(page, `src="`+consumer+`"`) {
			t.Errorf("einrichten.html: consequences.js must load before %s", consumer)
		}
	}

	// The layer itself ships and states the consequence that matters most: an
	// unreleased inverter is no longer steered by the plan.
	cons := get("/consequences.js")
	for _, want := range []string{
		"calibrationCorrection", "calibrationDecertify", "curtailDecertify",
		"sourceRemoval", "inverterChange",
		"Steuerungs-Freigabe", "Fahrplan steuert diesen Wechselrichter dann nicht mehr",
	} {
		if !strings.Contains(cons, want) {
			t.Errorf("consequences.js: missing %s", want)
		}
	}

	// Every devaluing call site asks first. Checked as "the ask is wired",
	// not as an exact spelling, so the tests stay readable when the call sites
	// are refactored.
	for _, c := range []struct{ file, marker string }{
		{"/calibration.js", "askCorrection"},                   // the three sign/scale corrections
		{"/calibration.js", "C.calibrationDecertify(lastCal)"}, // "Freigabe zurücknehmen"
		{"/curtail.js", "C.curtailDecertify(u)"},               // per-unit curtailment release
		{"/sources.js", "C.sourceRemoval(s, units)"},           // removing a source
		{"/inverter.js", "askInverterChange"},                  // the second path to the control values
	} {
		if js := get(c.file); !strings.Contains(js, c.marker) {
			t.Errorf("%s: devaluing action no longer asks first (missing %s)", c.file, c.marker)
		}
	}
}

// ── OTA Stufe 4: der beaufsichtigte „Jetzt anwenden"-Knopf ──────────────────

// errApplyRefused steht fuer eine ABLEHNUNG (400), nicht fuer einen Fehler -
// der fakeOta bildet damit die IsOtaRejection-Regel des Agenten nach.
var errApplyRefused = errors.New("Auf dieser Box laeuft kein Aktualisierer.")

// TestPortalManagedMirrorIsServedAndHonest nagelt die :8484-Hälfte der
// Bestands-Übernahme fest (Einheitsmodell Stufe 2).
//
// Die Regel dahinter: auf einer portal-verwalteten Anlage ist diese Seite ein
// read-only SPIEGEL - sie ZEIGT weiter alles, bietet aber keine Bearbeitung an
// und sagt, wo gepflegt wird. Auf einer box-verwalteten Anlage (dem Bestand und
// jeder frisch installierten Box) ist sie unverändert voll bedienbar.
func TestPortalManagedMirrorIsServedAndHonest(t *testing.T) {
	srv, fi := newServer(t)

	read := func(path string) map[string]any {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body
	}

	// Bestandsfall: box-verwaltet - beide Endpunkte sagen es, und zwar
	// ausdrücklich (nicht durch Abwesenheit, sonst könnte die Seite es nicht von
	// einem älteren Kern unterscheiden).
	for _, path := range []string{"/api/inverter", "/api/sources"} {
		if got := read(path)["portal_managed"]; got != false {
			t.Fatalf("%s: portal_managed = %v, erwartet false", path, got)
		}
	}

	// Nach einer Übernahme.
	fi.portalManaged = true
	for _, path := range []string{"/api/inverter", "/api/sources"} {
		if got := read(path)["portal_managed"]; got != true {
			t.Fatalf("%s: portal_managed = %v, erwartet true", path, got)
		}
	}

	// Und die Seite bringt die Teile mit, die den Spiegel ausmachen: den
	// Hinweis-Platz und die Markierung an JEDER Bearbeitungs-Möglichkeit.
	resp, err := http.Get(srv.URL + "/einrichten.html")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	page := string(raw)
	for _, want := range []string{
		`id="anlagePortalNote"`,
		// Jeder Knopf, der Geräte-Konfiguration ÄNDERT, trägt die Markierung -
		// die dynamisch gebauten Zeilen-Knöpfe setzt sources.js.
		`id="invEditBtn" data-vp-edit`,
		`id="invSetupBtn" data-vp-edit`,
		`id="erzAdd" data-vp-edit`,
		`id="netzAdd" data-vp-edit`,
		`id="verbAdd" data-vp-edit`,
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("einrichten.html fehlt %q - der Spiegel wäre unvollständig", want)
		}
	}
	// ⚠ Die Gegenrichtung, und sie ist die Aussage dieses Befundes: „Verbindung
	// prüfen" ÄNDERT NICHTS und darf deshalb NIE die Markierung tragen - sonst
	// verschwände der lokale Test genau auf den Anlagen wieder, für die er
	// nachgerüstet wurde.
	ti := strings.Index(page, `id="invRowTestBtn"`)
	if ti < 0 {
		t.Fatal("einrichten.html fehlt der Zeilen-Test des Wechselrichters")
	}
	if end := strings.Index(page[ti:], ">"); end < 0 || strings.Contains(page[ti:ti+end], "data-vp-edit") {
		t.Fatal(`"Verbindung prüfen" darf kein data-vp-edit tragen - er ändert nichts`)
	}
	// Der Hinweis steht im NORMAL-Modus: ein Zustand, der die Bearbeitung
	// wegnimmt, darf nicht hinter dem Technikmodus verschwinden.
	idx := strings.Index(page, `id="anlagePortalNote"`)
	line := page[max0(idx-200):idx]
	if strings.Contains(line, "tech-only") {
		t.Fatal("der Portal-Hinweis darf nicht Technik-gated sein")
	}
}

func max0(i int) int {
	if i < 0 {
		return 0
	}
	return i
}

// --- the narrow installer write (0x00E7) ------------------------------------

// installerServer builds a test server around one fakeInstallerWrite.
func installerServer(t *testing.T, iw *fakeInstallerWrite, cal CalibrationController) *httptest.Server {
	t.Helper()
	if cal == nil {
		cal = &fakeCalibration{}
	}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{},
		cal, &fakeMirror{}, &fakeOta{}, iw, &fakeOcpp{}))
	t.Cleanup(srv.Close)
	return srv
}

// ⚠ THE PATH EXISTS ON EVERY BOX (Captain-Korrektur 20.08.2026). There used to
// be a feature flag whose OFF state made both routes 404; that arming existed
// for the canary phase and was never what makes the path safe. So: a plain
// controller with nothing switched on answers BOTH routes, and the WRITE is
// carried by the operator password (proven next door) - never by a 404.
func TestInstallerWritePathExistsWithoutAnyArmingStep(t *testing.T) {
	iw := &fakeInstallerWrite{
		view: installerwrite.View{Register: installerwrite.RegisterLabel, MaxRaw: installerwrite.MaxRaw},
	}
	srv := installerServer(t, iw, nil)

	r, err := http.Get(srv.URL + "/api/installer-write")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET must exist without any arming, got %d", r.StatusCode)
	}
	raw, _ := io.ReadAll(r.Body)
	if bytes.Contains(raw, []byte(`"enabled"`)) {
		t.Fatalf("the view must not carry a switch any more: %s", raw)
	}

	resp, err := http.Post(srv.URL+"/api/installer-write", "application/json",
		strings.NewReader(`{"register":"0x00E7","value":7000,"mode":"apply","confirm":"0x00E7=7000"}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST must reach the controller, got %d", resp.StatusCode)
	}
	if len(iw.calls) != 1 {
		t.Fatalf("the controller must be asked exactly once, got %d calls", len(iw.calls))
	}
}

// With the flag on: the GET serves the switch + the log, the POST forwards the
// request verbatim, and every refusal keeps its own status.
func TestInstallerWriteRoutesForwardAndMapEveryRefusal(t *testing.T) {
	before, after := 3300, 7000
	admitted, err := installerwrite.Admit("hybrid_3p", installerwrite.Request{
		Value: 7000, Mode: installerwrite.ModeApply, Confirm: installerwrite.ConfirmToken(installerwrite.RegisterAddr, 7000),
	})
	if err != nil {
		t.Fatal(err)
	}
	iw := &fakeInstallerWrite{
		view: installerwrite.View{
			Register: installerwrite.RegisterLabel, MaxRaw: installerwrite.MaxRaw,
			Family: "hybrid_3p", Allowed: true,
			Entries: []installerwrite.Entry{{Register: installerwrite.RegisterLabel, Requested: 7000, Result: installerwrite.ResultApplied}},
		},
		// ⚠ An AdmittedWrite cannot be built by hand (unexported fields) - that
		// IS the narrowness guarantee, so even the test goes through Admit.
		out: installerwrite.Outcome{
			Plan:   admitted,
			Before: &before, After: &after, Result: installerwrite.ResultApplied, Accepted: true,
		},
	}
	srv := installerServer(t, iw, nil)

	r, err := http.Get(srv.URL + "/api/installer-write")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET: %d", r.StatusCode)
	}
	var view installerwrite.View
	if err := json.NewDecoder(r.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if view.Register != installerwrite.RegisterLabel || len(view.Entries) != 1 {
		t.Fatalf("view: %#v", view)
	}

	body := `{"register":"0x00E7","value":7000,"mode":"apply","confirm":"0x00E7=7000"}`
	resp, err := http.Post(srv.URL+"/api/installer-write", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST: %d", resp.StatusCode)
	}
	if len(iw.calls) != 1 || iw.calls[0].Value != 7000 || iw.calls[0].Mode != installerwrite.ModeApply ||
		iw.calls[0].Confirm != "0x00E7=7000" || iw.calls[0].Register != "0x00E7" {
		t.Fatalf("the request must be forwarded verbatim: %#v", iw.calls)
	}
	if iw.by[0] == "" {
		t.Fatalf("the audit source must be passed")
	}

	// A refusal is a 400 with the German sentence; busy is a 409.
	iw.err = &installerwrite.ValidationError{Msg: "Nur 0x00E7 ist freigegeben."}
	resp2, err := http.Post(srv.URL+"/api/installer-write", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("validation refusal: %d", resp2.StatusCode)
	}
	var errBody struct {
		Error string `json:"error"`
	}
	_ = json.NewDecoder(resp2.Body).Decode(&errBody)
	if errBody.Error != "Nur 0x00E7 ist freigegeben." {
		t.Fatalf("the German sentence must survive: %q", errBody.Error)
	}

	iw.err = installerwrite.ErrBusy
	resp3, err := http.Post(srv.URL+"/api/installer-write", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusConflict {
		t.Fatalf("busy must be 409, got %d", resp3.StatusCode)
	}
}

// The WRITE sits behind the same maintenance password as every other physical
// mutation; the read-only view stays open (the calibration rule).
func TestInstallerWriteMutationIsBehindTheMaintenancePassword(t *testing.T) {
	const secret = "geheim-123"
	iw := &fakeInstallerWrite{}
	srv := installerServer(t, iw, &fakeCalibration{adminSecret: secret})

	post := func(tok string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+"/api/installer-write",
			strings.NewReader(`{"value":7000,"mode":"apply","confirm":"0x00E7=7000"}`))
		req.Header.Set("Content-Type", "application/json")
		if tok != "" {
			req.Header.Set("X-VP-Calibration-Token", tok)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}

	r := post("")
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token must be 401, got %d", r.StatusCode)
	}
	r = post("falsch")
	r.Body.Close()
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token must be 401, got %d", r.StatusCode)
	}
	if len(iw.calls) != 0 {
		t.Fatalf("the guard must run BEFORE the handler, got %d calls", len(iw.calls))
	}
	r = post(secret)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("the right token must pass, got %d", r.StatusCode)
	}
	if len(iw.calls) != 1 {
		t.Fatalf("want one call, got %d", len(iw.calls))
	}

	// The read-only view stays open, like GET /api/calibration.
	g, err := http.Get(srv.URL + "/api/installer-write")
	if err != nil {
		t.Fatal(err)
	}
	g.Body.Close()
	if g.StatusCode != http.StatusOK {
		t.Fatalf("GET must stay open, got %d", g.StatusCode)
	}
}

// --- OCPP charge points -----------------------------------------------------

// fakeOcpp is a tiny in-memory OcppController: the routes are what is under
// test here, not the executor.
type fakeOcpp struct {
	view      *state.OcppInfo
	chargers  []csms.Charger
	set       lastmgmt.Settings
	addErr    error
	setErr    error
	removed   []string
	boosts    []lastmgmt.BoostRequest
	boostErr  error
	boostNote string
}

func (f *fakeOcpp) OcppView() *state.OcppInfo { return f.view }
func (f *fakeOcpp) OcppBoost(r lastmgmt.BoostRequest) (lastmgmt.BoostResult, error) {
	if f.boostErr != nil {
		return lastmgmt.BoostResult{}, f.boostErr
	}
	f.boosts = append(f.boosts, r)
	return lastmgmt.BoostResult{Key: r.ChargePointID, Active: !r.Cancel, Note: f.boostNote}, nil
}
func (f *fakeOcpp) OcppChargers() []csms.Charger    { return f.chargers }
func (f *fakeOcpp) OcppSettings() lastmgmt.Settings { return f.set.WithDefaults() }
func (f *fakeOcpp) OcppAddCharger(r csms.AddRequest) (csms.Charger, error) {
	if f.addErr != nil {
		return csms.Charger{}, f.addErr
	}
	c := csms.Charger{ID: r.ID, Label: r.Label, Priority: r.Priority}
	f.chargers = append(f.chargers, c)
	return c, nil
}
func (f *fakeOcpp) OcppUpdateCharger(id string, _ csms.UpdateRequest) (csms.Charger, error) {
	for _, c := range f.chargers {
		if c.ID == id {
			return c, nil
		}
	}
	return csms.Charger{}, csms.ErrNotFound
}
func (f *fakeOcpp) OcppRemoveCharger(id string) error {
	for _, c := range f.chargers {
		if c.ID == id {
			f.removed = append(f.removed, id)
			return nil
		}
	}
	return csms.ErrNotFound
}
func (f *fakeOcpp) OcppSaveSettings(r lastmgmt.SettingsRequest) (lastmgmt.Settings, error) {
	if f.setErr != nil {
		return lastmgmt.Settings{}, f.setErr
	}
	next, err := f.set.WithDefaults().Apply(r)
	if err != nil {
		return lastmgmt.Settings{}, err
	}
	f.set = next
	return next, nil
}

func ocppServer(t *testing.T, f *fakeOcpp) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(Handler(state.New("edge-ocpp", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{},
		&fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, f))
	t.Cleanup(srv.Close)
	return srv
}

// TestOcppViewIsHonestWhenTheFeatureIsOff: an absent block is an absent block,
// not an empty plant.
func TestOcppViewIsHonestWhenTheFeatureIsOff(t *testing.T) {
	srv := ocppServer(t, &fakeOcpp{})
	resp, err := http.Get(srv.URL + "/api/ocpp")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		Ocpp     *state.OcppInfo `json:"ocpp"`
		Chargers []csms.Charger  `json:"chargers"`
		Settings map[string]any  `json:"settings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Ocpp != nil {
		t.Fatalf("an OCPP block appeared with the feature off: %+v", body.Ocpp)
	}
	// The settings still render, with their defaults - a form must not be
	// blank just because the server is off.
	if body.Settings["rotation_minutes"] != float64(15) {
		t.Fatalf("settings defaults: %+v", body.Settings)
	}
	if body.Settings["budget_kw"] != float64(0) {
		t.Fatalf("an unconfigured site must have a 0 budget: %+v", body.Settings)
	}
}

// TestOcppSetupRoutesRefuseInGerman: this is a setup surface an installer reads
// at a customer's site - every refusal names the field and the limit.
func TestOcppSetupRoutesRefuseInGerman(t *testing.T) {
	f := &fakeOcpp{}
	srv := ocppServer(t, f)

	post := func(path, body string) (int, string) {
		t.Helper()
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, strings.TrimSpace(string(b))
	}

	if code, _ := post("/api/ocpp/chargers", `{"id":"SAEULE-1","label":"Hof Nord"}`); code != 200 {
		t.Fatalf("valid add: %d", code)
	}
	if len(f.chargers) != 1 {
		t.Fatalf("charger not stored: %+v", f.chargers)
	}

	f.addErr = &csms.ValidationError{Msg: "Die Kennung ist nicht zulässig."}
	code, msg := post("/api/ocpp/chargers", `{"id":"hat leerzeichen"}`)
	if code != 400 || !strings.Contains(msg, "Kennung") {
		t.Fatalf("refusal: %d %q", code, msg)
	}
	f.addErr = nil

	f.setErr = &lastmgmt.ValidationError{Msg: "Die Anschlussgrenze muss zwischen 0 und 5000 kW liegen."}
	code, msg = post("/api/ocpp/settings", `{"grid_limit_kw":-1}`)
	if code != 400 || !strings.Contains(msg, "Anschlussgrenze") {
		t.Fatalf("settings refusal: %d %q", code, msg)
	}
	f.setErr = nil

	if code, _ := post("/api/ocpp/chargers", `not json`); code != 400 {
		t.Fatalf("garbage body: %d", code)
	}
}

// TestOcppSettingsRoundTripThroughTheRoute: the derived budget rides along so
// the page never re-derives it (one arithmetic, one answer).
func TestOcppSettingsRoundTripThroughTheRoute(t *testing.T) {
	f := &fakeOcpp{}
	srv := ocppServer(t, f)
	resp, err := http.Post(srv.URL+"/api/ocpp/settings", "application/json",
		strings.NewReader(`{"grid_limit_kw":277,"house_reserve_kw":167,"margin_pct":10,"min_power_kw":30}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if b, _ := got["budget_kw"].(float64); b < 82.29 || b > 82.31 {
		t.Fatalf("budget = %v, want 82.3 (the margin comes off the CONNECTION first)", got["budget_kw"])
	}
	if got["rotation_minutes"] != float64(15) {
		t.Fatalf("an untouched field was reset: %+v", got)
	}
	// Stufe 2: the dynamic budget is on unless the operator turns it off, and
	// the switch survives the route in both directions.
	if got["static_budget"] != false {
		t.Fatalf("the dynamic budget must be the default: %+v", got["static_budget"])
	}
	resp2, err := http.Post(srv.URL+"/api/ocpp/settings", "application/json",
		strings.NewReader(`{"static_budget":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	var back map[string]any
	if err := json.NewDecoder(resp2.Body).Decode(&back); err != nil {
		t.Fatal(err)
	}
	if back["static_budget"] != true {
		t.Fatalf("the operator's switch was dropped: %+v", back)
	}
	if b, _ := back["grid_limit_kw"].(float64); b != 277 {
		t.Fatalf("an untouched field was reset by the switch: %+v", back)
	}
}

// TestRemovingAnUnknownChargerIs404 - and a known one really goes.
func TestRemovingAChargerThroughTheRoute(t *testing.T) {
	f := &fakeOcpp{chargers: []csms.Charger{{ID: "SAEULE-1"}}}
	srv := ocppServer(t, f)

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/ocpp/chargers/SAEULE-1", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d", resp.StatusCode)
	}
	if len(f.removed) != 1 {
		t.Fatalf("removal did not reach the controller: %+v", f.removed)
	}

	req, _ = http.NewRequest(http.MethodDelete, srv.URL+"/api/ocpp/chargers/FREMDE", nil)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown id: %d, want 404", resp.StatusCode)
	}
}

// TestThereIsNoRouteThatCommandsAChargingLimit is a STRUCTURAL guard: limits
// come from the load management alone, so this surface can never become a
// second, unarbitrated writer to a customer's charge point.
func TestThereIsNoRouteThatCommandsAChargingLimit(t *testing.T) {
	srv := ocppServer(t, &fakeOcpp{})
	for _, path := range []string{
		"/api/ocpp/limit", "/api/ocpp/chargers/SAEULE-1/limit",
		"/api/ocpp/chargers/SAEULE-1/profile", "/api/ocpp/apply",
	} {
		resp, err := http.Post(srv.URL+path, "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("POST %s answered %d - a limit-commanding route must not exist", path, resp.StatusCode)
		}
	}
}

// TestTheLadepunktSurfaceIsServed pins the page structure the ocpp.js
// rendering keys on (the //go:embed reminder: rebuild after editing static).
func TestTheLadepunktSurfaceIsServed(t *testing.T) {
	srv := ocppServer(t, &fakeOcpp{})
	get := func(path string) string {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("GET %s: %d", path, resp.StatusCode)
		}
		return string(b)
	}
	setup := get("/einrichten.html")
	for _, want := range []string{
		`id="ladepunkte"`, `id="ocppCard"`, `id="ocppEndpoint"`, `id="ocppList"`,
		`id="ocppAddForm"`, `id="ocppSettingsForm"`, `id="ocppFailsafe"`,
		`id="ocppControlNote"`, `src="ocpp.js"`,
		// The conditional group: hidden in the served markup, unhidden by
		// ocpp.js only when the box really accepts charge points.
		`data-group="ladepunkte" hidden`,
		// Stufe 2: where the budget came from, and the operator's switch.
		`id="ocppBudgetSource"`, `id="ocppBudgetSourceText"`, `id="ocppBudgetDot"`,
		`id="ocppStaticBudget"`,
		// Stufe 4: the customer's SOURCE choice (the three priorities) and,
		// only where a storage really reports, who gets the surplus first.
		`name="ocppPolicy"`, `value="nur_sonne"`, `value="sonne_zuerst"`, `value="schnell"`,
		`name="ocppStorage"`, `value="speicher_vor_auto"`, `value="auto_vor_speicher"`,
		`id="ocppStorageRow"`, `id="ocppSurplus"`, `id="ocppSurplusText"`, `id="ocppSurplusDot"`,
	} {
		if !strings.Contains(setup, want) {
			t.Fatalf("einrichten.html is missing %s", want)
		}
	}
	// ⚠ The storage question is served HIDDEN: it only means something on a
	// plant that HAS a storage, and only the box knows whether one reports -
	// asking about a device that is not there would be noise.
	if !strings.Contains(setup, `id="ocppStorageRow" hidden`) {
		t.Fatal("the storage question must be served hidden")
	}
	op := get("/index.html")
	for _, want := range []string{`id="ocppOpCard"`, `id="ocppOpBudget"`, `id="ocppOpSource"`,
		`id="ocppOpSurplus"`, `id="ocppOpPlan"`, `id="ocppOpError"`, `id="ocppOpRows"`, `id="ocppOpIdle"`, `src="ocpp.js"`} {
		if !strings.Contains(op, want) {
			t.Fatalf("index.html is missing %s", want)
		}
	}
	if js := get("/ocpp.js"); !strings.Contains(js, "VPOcpp") {
		t.Fatal("ocpp.js is not served")
	}
}

// TestTheBoostRouteOverridesOneSessionAndNothingElse: „Jetzt voll laden" is the
// ONE customer action of this surface that moves an allocation - and it moves
// exactly one session's SOURCE, never a limit (the structural guard above still
// holds: no route commands a charging limit).
func TestTheBoostRouteOverridesOneSessionAndNothingElse(t *testing.T) {
	f := &fakeOcpp{boostNote: "Anschlussgrenze, Sicherheitsabstand und Ausfall-Schutz gelten weiter."}
	srv := ocppServer(t, f)
	post := func(body string) int {
		t.Helper()
		resp, err := http.Post(srv.URL+"/api/ocpp/boost", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	if code := post(`{"charge_point_id":"SAEULE-1","connector_id":1}`); code != 200 {
		t.Fatalf("boost answered %d", code)
	}
	if code := post(`{"charge_point_id":"SAEULE-1","connector_id":1,"cancel":true}`); code != 200 {
		t.Fatalf("cancel answered %d", code)
	}
	if len(f.boosts) != 2 || f.boosts[0].Cancel || !f.boosts[1].Cancel {
		t.Fatalf("the two calls did not reach the box: %+v", f.boosts)
	}
	// A refusal arrives as a German {message}, like every other setup surface.
	f.boostErr = &lastmgmt.ValidationError{Msg: "An diesem Stecker läuft gerade kein Ladevorgang."}
	if code := post(`{"charge_point_id":"SAEULE-1","connector_id":9}`); code != http.StatusBadRequest {
		t.Fatalf("a refusal answered %d, want 400", code)
	}
}

// A LADEPARK box has no inverter at all, and before Lastmanagement Stufe 3 the
// commissioning gate keyed on one alone - so a plant made of charge points plus
// a grid meter could never reveal its reference and could never be claimed.
// The gate now asks "does SOME component deliver data": a REGISTERED charge
// point that has reported itself opens it, and nothing else changes.
func TestOnboardingGateOpensForACharginParkWithoutAnInverter(t *testing.T) {
	st := state.New("edge-ladepark", "test")
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	// (a) A registered station that has NEVER spoken keeps the gate shut - a
	// name on an allowlist is not a component that delivers data.
	st.Update(func(s *state.Snapshot) {
		s.Ocpp = &state.OcppInfo{Enabled: true, Listening: true,
			Chargers: []state.OcppCharger{{ID: "saeule-1"}}}
	})
	b := getState(t, srv)
	if b.ChargePointConnected || b.ClaimUnlocked || b.OnboardingStep != "inverter" {
		t.Fatalf("a never-seen station must not open the gate: %+v", b)
	}
	if b.Ref != "" {
		t.Fatalf("reference must stay withheld, got %q", b.Ref)
	}

	// (b) The station reports itself -> the gate opens, WITHOUT ever claiming
	// an inverter is connected.
	st.Update(func(s *state.Snapshot) {
		s.Ocpp.Chargers[0].LastSeenMs = time.Now().UnixMilli()
		s.Ocpp.Chargers[0].Connected = true
	})
	b = getState(t, srv)
	if !b.ChargePointConnected || !b.ClaimUnlocked || b.OnboardingStep != "claim" {
		t.Fatalf("a reporting station must open the gate: %+v", b)
	}
	if b.InverterConnected {
		t.Fatal("there is no inverter on this plant - the gate must not claim one")
	}
	if b.Ref != "edge-ladepark" {
		t.Fatalf("reference must be revealed once unlocked, got %q", b.Ref)
	}

	// (c) The station drops off the websocket. The gate stays OPEN: a step that
	// was passed must not re-lock because a socket flapped.
	st.Update(func(s *state.Snapshot) { s.Ocpp.Chargers[0].Connected = false })
	b = getState(t, srv)
	if !b.ChargePointConnected || !b.ClaimUnlocked {
		t.Fatalf("a flapping socket must not re-lock the gate: %+v", b)
	}
}

// A plant with an inverter is BYTE-IDENTICAL to before the generalisation: the
// charge-point signal is false, and a box with neither component stays locked.
func TestTheGateGeneralisationChangesNothingWithoutChargePoints(t *testing.T) {
	st := state.New("edge-classic", "test")
	srv := httptest.NewServer(Handler(st, &fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{}, &fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	b := getState(t, srv)
	if b.ChargePointConnected || b.ClaimUnlocked || b.OnboardingStep != "inverter" {
		t.Fatalf("empty box: %+v", b)
	}
	st.Update(func(s *state.Snapshot) {
		s.Inverter = configuredInverter()
		s.LastTelemetry = time.Now().UTC()
	})
	b = getState(t, srv)
	if !b.InverterConnected || b.ChargePointConnected || b.OnboardingStep != "claim" {
		t.Fatalf("inverter plant: %+v", b)
	}
}

// The delivered VoltPilot favicon ships with the binary (//go:embed contract:
// static/ is embedded wholesale) and BOTH pages link it - a static/ edit that
// forgets the rebuild, or a dropped favicon file, fails here instead of leaving
// the browser tab (and every tool that blindly requests /favicon.ico) blank.
func TestFaviconShipsAndBothPagesLinkIt(t *testing.T) {
	srv, _ := newServer(t)

	getBytes := func(path string) []byte {
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
		return b
	}

	for _, page := range []string{"/index.html", "/einrichten.html"} {
		markup := string(getBytes(page))
		for _, want := range []string{
			`rel="icon" type="image/svg+xml" href="favicon.svg"`,
			`rel="shortcut icon" href="favicon.ico"`,
		} {
			if !strings.Contains(markup, want) {
				t.Errorf("%s: missing favicon link %q", page, want)
			}
		}
	}

	// The SVG is the delivered brand original (an SVG root, non-empty).
	if svg := getBytes("/favicon.svg"); !bytes.Contains(svg, []byte("<svg")) {
		t.Error("favicon.svg does not look like an SVG")
	}
	// The ICO ships and carries the real icon magic (00 00 01 00) - not an
	// HTML SPA-fallback body under the .ico URL.
	ico := getBytes("/favicon.ico")
	if len(ico) < 4 || ico[0] != 0x00 || ico[1] != 0x00 || ico[2] != 0x01 || ico[3] != 0x00 {
		t.Errorf("favicon.ico is not a real ICO (got %d bytes, magic %x)", len(ico), ico[:min(4, len(ico))])
	}
}

// TestPortalManagedRefusalIsAHintNotAServerError pins Befund L2 (Scout
// vp-portal-box-spiegel-s2): auf einer portal-verwalteten Anlage meldet die
// Autoritaets-Sperre (agent.refuseIfPortalManaged) einen
// *inverter.ValidationError - auch auf den QUELLEN-Routen. Vor dieser Runde
// fragten die drei Schreib-Handler nur den *sources.ValidationError ab und
// antworteten deshalb mit HTTP 500 "Energiequelle konnte nicht gespeichert
// werden", waehrend POST /api/inverter sauber 400 mit dem deutschen Hinweis
// gab. Die Oberflaeche versteckt die Knoepfe zwar, aber ein Deep-Link, eine
// aeltere Seite oder ein Skript bekam den falschen Grund.
//
// Der Typ ist die Naht zum Agenten: dass die Sperre ihn auf allen vier Wegen
// meldet, haelt component_apply_test.go fest.
func TestPortalManagedRefusalIsAHintNotAServerError(t *testing.T) {
	// Der Satz gehoert dem Agenten; hier zaehlt, dass er VERBATIM ankommt.
	gate := &inverter.ValidationError{
		Msg: "Die Geraete dieser Anlage werden im VoltPilot-Portal verwaltet."}
	fs := &fakeSources{addErr: gate, delErr: gate, renameErr: gate}
	fi := &fakeInverter{cat: inverter.DefaultCatalog(), portalManaged: true}
	srv := httptest.NewServer(Handler(state.New("edge-pm", "test"), fi, &fakePurge{},
		&fakeDespike{}, history.New(10), &fakePlan{}, fs, &fakeTopology{},
		&fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{},
		&fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv.Close()

	body := `{"role":"pv-generation","brand":"generic_modbus","model":"sunspec",` +
		`"connection":{"ip":"10.0.0.2","unit_id":1}}`
	for _, tc := range []struct {
		name, method, path, body string
	}{
		{"quelle anlegen", http.MethodPost, "/api/sources", body},
		{"quelle umbenennen", http.MethodPut, "/api/sources/src-fixed", `{"label":"Neu"}`},
		{"quelle entfernen", http.MethodDelete, "/api/sources/src-fixed", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(tc.method, srv.URL+tc.path, strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (ein Hinweis, kein Serverfehler)", resp.StatusCode)
			}
			var out struct {
				Error string `json:"error"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
				t.Fatal(err)
			}
			if out.Error != gate.Msg {
				t.Errorf("Grund = %q, want den Satz der Sperre verbatim", out.Error)
			}
		})
	}

	// Und die vierte Route - der Wechselrichter - antwortet unveraendert
	// GENAUSO: dieselbe Sperre darf nicht zwei Antworten haben. Hier meldet der
	// echte Katalog die Ablehnung, nicht die eingespeiste.
	fiRefuse := &fakeInverter{cat: inverter.DefaultCatalog()}
	fiRefuse.setErr = gate
	srv2 := httptest.NewServer(Handler(state.New("edge-pm2", "test"), fiRefuse, &fakePurge{},
		&fakeDespike{}, history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{},
		&fakeActiveControl{}, &fakeCalibration{}, &fakeMirror{}, &fakeOta{},
		&fakeInstallerWrite{}, &fakeOcpp{}))
	defer srv2.Close()
	resp, err := http.Post(srv2.URL+"/api/inverter", "application/json",
		strings.NewReader(`{"brand":"generic_modbus","model":"sunspec","connection":{"ip":"10.0.0.1","unit_id":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("inverter status = %d, want 400", resp.StatusCode)
	}

	// Gegenprobe (nicht vakuum): ein ECHTER Fehler bleibt ein Serverfehler.
	fs.addErr = errors.New("Platte voll")
	resp2, err := http.Post(srv.URL+"/api/sources", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusInternalServerError {
		t.Errorf("unbekannter Fehler: status = %d, want 500", resp2.StatusCode)
	}
}
