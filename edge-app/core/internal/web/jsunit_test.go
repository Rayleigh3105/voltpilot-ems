package web

import (
	"os/exec"
	"strings"
	"testing"
)

// TestStaticJsUnitTests runs the pure-JS unit suite for the :8484 web app
// (jstest/ui.test.js) as part of `go test ./...`, so the browser-side logic is
// covered by the SAME command that covers the Go side.
//
// What it proves lives in that file: the Technikmodus default + persistence,
// that every non-ok status verdict carries a plain-German cause (the rule this
// UI is built on), the control-state branch order incl. the blocked+reason
// case, and the guided commissioning derivation for a fresh and a fully
// configured device.
//
// Skipped when node is not installed - the same posture the Docker-gated tests
// take. CI images for this repo ship node (the nodered/flowc tests need it).
func TestStaticJsUnitTests(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed - run `node --test internal/web/jstest/ui.test.js` manually")
	}
	out, err := exec.Command(node, "--test", "jstest/ui.test.js").CombinedOutput()
	if err != nil {
		t.Fatalf("static JS unit tests failed: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), "fail 0") {
		t.Fatalf("static JS unit tests reported failures:\n%s", out)
	}
}
