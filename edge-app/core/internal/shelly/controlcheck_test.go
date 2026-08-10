package shelly

// D11 control-check tests: the value-identical off-write runs ONLY while the
// relay is off; a running heat cycle is read-only + honestly named; capability
// facts (gen/metering) ride every answered check.

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestControlCheckWritesOnlyWhileRelayOff(t *testing.T) {
	f := &fakeGen2{metering: true}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	out := ControlCheck(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
	if !out.OK || out.Skipped || out.ErrorCode != "" {
		t.Fatalf("off-relay check must run + pass: %+v", out)
	}
	if out.Gen != Gen2 || out.Metering == nil || !*out.Metering {
		t.Fatalf("capability facts missing: %+v", out)
	}
	if !strings.Contains(out.Message, "Relais blieb aus") {
		t.Fatalf("honest wording missing: %q", out.Message)
	}
	f.mu.Lock()
	calls, on := f.setCalls, f.on
	f.mu.Unlock()
	if calls != 1 || on {
		t.Fatalf("exactly one value-identical off write expected (calls=%d on=%v)", calls, on)
	}
}

func TestControlCheckSkipsWhileRelayOn(t *testing.T) {
	f := &fakeGen1{metering: false, on: true}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	out := ControlCheck(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
	if out.OK || !out.Skipped || out.ErrorCode != "" {
		t.Fatalf("on-relay check must skip, not fail: %+v", out)
	}
	if !strings.Contains(out.Message, "eingeschaltet") || !strings.Contains(out.Message, "übersprungen") {
		t.Fatalf("honest skip wording missing: %q", out.Message)
	}
	if out.Metering == nil || *out.Metering {
		t.Fatalf("capability facts must still ride the skip: %+v", out)
	}
	f.mu.Lock()
	calls, on := f.setCalls, f.on
	f.mu.Unlock()
	if calls != 0 || !on {
		t.Fatalf("a running relay must NEVER be written (calls=%d on=%v)", calls, on)
	}
}

func TestControlCheckClassifiesFailures(t *testing.T) {
	f := &fakeGen2{authEn: true}
	srv := httptest.NewServer(f.handler())
	defer srv.Close()
	out := ControlCheck(context.Background(), httpDoer{srv.Client()}, cfgFor(t, srv))
	if out.OK || out.ErrorCode != ErrInvalidResponse || !strings.Contains(out.Message, "passwortgeschützt") {
		t.Fatalf("auth refusal not honest: %+v", out)
	}
	cfg := cfgFor(t, srv)
	srv.Close()
	out = ControlCheck(context.Background(), httpDoer{srv.Client()}, cfg)
	if out.OK || out.ErrorCode != ErrUnreachable {
		t.Fatalf("dead device must be unreachable: %+v", out)
	}
}
