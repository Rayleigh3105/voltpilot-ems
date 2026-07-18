package flowdeploy

import (
	"encoding/json"
	"os"
	"testing"
)

// The SHARED vector file pinned by both this Go consumer and the JS compiler
// (edge-app/nodered/flowc/canonicalize.test.js) - the two implementations
// must produce byte-identical canonical forms (the refCheckChar lockstep
// precedent). Moving the file breaks both suites deliberately.
const jcsVectorFile = "../../../nodered/flowc/jcs-vectors.json"

func TestCanonicalizeSharedVectors(t *testing.T) {
	raw, err := os.ReadFile(jcsVectorFile)
	if err != nil {
		t.Fatalf("shared jcs vectors unreadable: %v", err)
	}
	var doc struct {
		Cases []struct {
			Name      string `json:"name"`
			Input     string `json:"input"`
			Canonical string `json:"canonical"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Cases) < 15 {
		t.Fatalf("vector file suspiciously small: %d cases", len(doc.Cases))
	}
	for _, c := range doc.Cases {
		got, err := Canonicalize([]byte(c.Input))
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if string(got) != c.Canonical {
			t.Errorf("%s:\n got  %q\n want %q", c.Name, got, c.Canonical)
		}
	}
}

func TestCanonicalizeRefusesGarbage(t *testing.T) {
	for _, bad := range []string{"", "{", `{"a":1} trailing`, `{"a":NaN}`} {
		if _, err := Canonicalize([]byte(bad)); err == nil {
			t.Errorf("input %q must be refused", bad)
		}
	}
}

func TestContentHashShape(t *testing.T) {
	h, err := ContentHash([]byte(`{"b":1,"a":2}`))
	if err != nil {
		t.Fatal(err)
	}
	h2, err := ContentHash([]byte("{ \"a\": 2, \"b\": 1 }"))
	if err != nil {
		t.Fatal(err)
	}
	if h != h2 {
		t.Fatal("equivalent documents must hash identically")
	}
	if len(h) != len("sha256:")+64 || h[:7] != "sha256:" {
		t.Fatalf("hash shape wrong: %s", h)
	}
}
