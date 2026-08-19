package web

// HTTP-layer tests for the guided Neutral-Zeit-Test surface (Teil A,
// docs/ota-autonomie.md §3) and the shell-free Autonomie-Schalter (Teil C).

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/history"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/neutralcal"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/otaapply"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"

	"net/http/httptest"
)

// The einrichten.html page must serve the Neutral-Zeit card and the
// shell-free Autonomie-Schalter as embedded static structure - the //go:embed
// contract pinned like every other :8484 page-structure test.
func TestEinrichtenServesNeutralCardAndAutonomySwitch(t *testing.T) {
	srv, _ := newServer(t)
	resp, err := http.Get(srv.URL + "/einrichten.html")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /einrichten.html: status %d", resp.StatusCode)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	page := string(b)
	for _, want := range []string{
		`id="neutralCard"`, `id="neutralBody"`, `id="neutralErr"`,
		`id="autonomyCard"`, `id="autonomyToggle"`, `id="autonomyErr"`,
		`src="neutral.js"`,
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("einrichten.html is missing %q", want)
		}
	}
}

func newNeutralTestServer(t *testing.T, fc *fakeCalibration, fo *fakeOta) *httptest.Server {
	t.Helper()
	if fc == nil {
		fc = &fakeCalibration{}
	}
	if fo == nil {
		fo = &fakeOta{}
	}
	srv := httptest.NewServer(Handler(state.New("edge-test", "test"),
		&fakeInverter{cat: inverter.DefaultCatalog()}, &fakePurge{}, &fakeDespike{},
		history.New(10), &fakePlan{}, &fakeSources{}, &fakeTopology{}, &fakeActiveControl{},
		fc, &fakeMirror{}, fo, &fakeInstallerWrite{}))
	t.Cleanup(srv.Close)
	return srv
}

// GET /api/neutral is read-only and open even with an admin secret set.
func TestNeutralSnapshotStaysOpen(t *testing.T) {
	fc := &fakeCalibration{
		adminSecret: "geheim",
		neutralView: neutralcal.View{Available: true, Family: "hybrid_3p", TestKw: neutralcal.TestKw},
	}
	srv := newNeutralTestServer(t, fc, nil)

	resp, err := http.Get(srv.URL + "/api/neutral")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/neutral must stay open, got %d", resp.StatusCode)
	}
	var body struct {
		Neutral neutralcal.View `json:"neutral"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Neutral.Family != "hybrid_3p" {
		t.Fatalf("expected the fake view to be echoed: %+v", body.Neutral)
	}
}

// Every mutation endpoint shares the calGuard admin token, exactly like
// calibration/curtailment.
func TestNeutralMutationsShareTheCalibrationAdminGate(t *testing.T) {
	const secret = "geheim-neutral"
	fc := &fakeCalibration{adminSecret: secret}
	srv := newNeutralTestServer(t, fc, nil)

	post := func(path, tok string) *http.Response {
		t.Helper()
		req, _ := http.NewRequest("POST", srv.URL+path, strings.NewReader(`{}`))
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

	for _, path := range []string{"test", "abort", "record"} {
		resp := post("/api/neutral/"+path, "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("POST /api/neutral/%s without token: got %d, want 401", path, resp.StatusCode)
		}
	}
	if fc.neutralStarts != 0 || fc.neutralAborts != 0 || fc.neutralRecords != 0 {
		t.Fatal("an unauthenticated mutation must NOT reach the controller")
	}

	resp := post("/api/neutral/test", "falsch")
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token must be 401, got %d", resp.StatusCode)
	}

	resp = post("/api/neutral/test", secret)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("correct token should reach the controller: got %d", resp.StatusCode)
	}
	if fc.neutralStarts != 1 {
		t.Fatalf("the controller must have been called exactly once: %d", fc.neutralStarts)
	}
}

// A refused start (e.g. "Es läuft bereits ein Test") maps to 400 with the
// German message, carrying the view alongside for the card to render.
func TestNeutralStartRefusalMapsTo400(t *testing.T) {
	fc := &fakeCalibration{
		neutralErr:  &neutralcal.ValidationError{Msg: "Es läuft bereits ein Neutral-Zeit-Test."},
		neutralView: neutralcal.View{Available: true},
	}
	srv := newNeutralTestServer(t, fc, nil)

	resp, err := http.Post(srv.URL+"/api/neutral/test", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a refusal must be 400, got %d", resp.StatusCode)
	}
	var body struct {
		Error   string          `json:"error"`
		Neutral neutralcal.View `json:"neutral"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body.Error, "läuft bereits") {
		t.Fatalf("the German reason must be forwarded: %q", body.Error)
	}
	if !body.Neutral.Available {
		t.Fatal("the view must accompany the refusal so the card can still render")
	}
}

// NeutralRecord's refusal (no valid pass) also maps to 400.
func TestNeutralRecordRefusalMapsTo400(t *testing.T) {
	fc := &fakeCalibration{
		neutralErr: &neutralcal.ValidationError{Msg: "Es liegt kein bestandener, noch gültiger Nachweis vor."},
	}
	srv := newNeutralTestServer(t, fc, nil)

	resp, err := http.Post(srv.URL+"/api/neutral/record", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", resp.StatusCode)
	}
	if fc.neutralRecords != 1 {
		t.Fatal("the controller must still have been called")
	}
}

// GET /api/ota/autonomy is open; POST shares the same admin gate.
func TestOtaAutonomySwitchGetOpenPostGated(t *testing.T) {
	const secret = "geheim-autonomy"
	fc := &fakeCalibration{adminSecret: secret}
	fo := &fakeOta{autonomy: otaapply.Autonomy{Enabled: false}}
	srv := newNeutralTestServer(t, fc, fo)

	r, err := http.Get(srv.URL + "/api/ota/autonomy")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET must stay open, got %d", r.StatusCode)
	}
	var au otaapply.Autonomy
	if err := json.NewDecoder(r.Body).Decode(&au); err != nil {
		t.Fatal(err)
	}
	if au.Enabled {
		t.Fatal("expected the fake's initial state (false)")
	}

	// Without the token: refused, controller never called.
	req, _ := http.NewRequest("POST", srv.URL+"/api/ota/autonomy", strings.NewReader(`{"enabled":true}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("without token: got %d, want 401", resp.StatusCode)
	}
	if fo.lastAutonomy != nil {
		t.Fatal("an unauthenticated mutation must NOT reach the controller")
	}

	// With the token: sets the switch.
	req2, _ := http.NewRequest("POST", srv.URL+"/api/ota/autonomy", strings.NewReader(`{"enabled":true,"by":"tester"}`))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("X-VP-Calibration-Token", secret)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200", resp2.StatusCode)
	}
	if fo.lastAutonomy == nil || !*fo.lastAutonomy || fo.lastAutonomyBy != "tester" {
		t.Fatalf("the controller must have been called with (true, tester): %v %q", fo.lastAutonomy, fo.lastAutonomyBy)
	}
	var got otaapply.Autonomy
	if err := json.NewDecoder(resp2.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Enabled {
		t.Fatalf("the response must echo the new state: %+v", got)
	}
}
