package flowdeploy

// A Steuerlogik bundle (format steuerlogik) goes to the logic runtime on both
// box kinds - never to Node-RED and never to the Edge Light consumer-rule
// twin; its hash covers the logic text exactly, key order included.

import (
	"strings"
	"testing"
)

type fakeLogik struct {
	refuse string
	calls  [][]Artifact
}

func (f *fakeLogik) Annehmbar(a Artifact) (bool, string) {
	if f.refuse != "" {
		return false, f.refuse
	}
	return true, ""
}

func (f *fakeLogik) Angleichen(a []Artifact) error {
	f.calls = append(f.calls, append([]Artifact(nil), a...))
	return nil
}

func (f *fakeLogik) last() []Artifact {
	if len(f.calls) == 0 {
		return nil
	}
	return f.calls[len(f.calls)-1]
}

const tLogikID = "7a7b7c7d-1111-4222-8333-444455556666"

// logikArtifact builds a steuerlogik artifact with a correct content hash.
func logikArtifact(t *testing.T, version int, logic string, mutate func(map[string]any)) map[string]any {
	t.Helper()
	return makeArtifact(t, version, func(a map[string]any) {
		a["flow_id"] = tLogikID
		a["required_entities"] = []any{}
		bundle := map[string]any{"format": FormatSteuerlogik, "logic": logic,
			"site": map[string]any{"timezone": "Europe/Berlin", "latitude": 48.1, "longitude": 11.6}}
		if mutate != nil {
			mutate(bundle)
		}
		hash, err := ContentHash(mustJSON(t, bundle))
		if err != nil {
			t.Fatal(err)
		}
		a["bundle"] = bundle
		a["content_hash"] = hash
	})
}

const tLogic = `{"logic":1,"name":"Probe","states":{"b":{},"a":{}}}`

func TestSteuerlogikGehtAnDenKernNichtAnNodeRed(t *testing.T) {
	nr := newFakeNR()
	dep := newDeployer(t, nr)
	lg := &fakeLogik{}
	dep.SetLogikLaufzeit(lg)
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 1, nil), logikArtifact(t, 3, tLogic, nil)))
	if st, d := ackOf(t, dep, tLogikID); st != "active" {
		t.Fatalf("steuerlogik ack = %s (%s)", st, d)
	}
	if st, _ := ackOf(t, dep, tFlowID); st != "active" {
		t.Fatalf("nodered ack = %s", st)
	}
	got := lg.last()
	if len(got) != 1 || got[0].FlowID != tLogikID || got[0].FlowVersion != 3 || got[0].Bundle.Logic != tLogic ||
		got[0].Bundle.Site == nil || got[0].Bundle.Site.Timezone != "Europe/Berlin" || *got[0].Bundle.Site.Latitude != 48.1 {
		t.Fatalf("logic runtime got %+v", got)
	}
	for id := range nr.tabIDs() {
		if strings.Contains(id, tLogikID) {
			t.Fatalf("a logic must never become a Node-RED tab: %s", id)
		}
	}
	// A withdrawn logic stops at once: the runtime converges on the empty set.
	dep.HandleDeployment(makeDeployment(t, makeArtifact(t, 1, nil)))
	if got := lg.last(); len(got) != 0 {
		t.Fatalf("withdrawn logic still handed over: %+v", got)
	}
	dep.HandleDeployment(nil)
	if got := lg.last(); len(got) != 0 {
		t.Fatalf("cleared set still handed over: %+v", got)
	}
}

// Edge Light: no Node-RED, the consumer-rule twin as local runtime - the
// logic still goes to the core, never to the twin.
func TestSteuerlogikAufEdgeLight(t *testing.T) {
	dep := newDeployer(t, nil)
	lokal := &fakeLokal{version: "0.5.0"}
	dep.SetLokaleLaufzeit(lokal)
	lg := &fakeLogik{}
	dep.SetLogikLaufzeit(lg)
	dep.HandleDeployment(makeDeployment(t, logikArtifact(t, 1, tLogic, nil)))
	if st, d := ackOf(t, dep, tLogikID); st != "active" {
		t.Fatalf("ack = %s (%s)", st, d)
	}
	if len(lg.last()) != 1 || len(lokal.last()) != 0 {
		t.Fatalf("logic %d, lokal %d", len(lg.last()), len(lokal.last()))
	}
}

func TestSteuerlogikAblehnungen(t *testing.T) {
	cases := []struct {
		name   string
		art    func(t *testing.T) map[string]any
		logik  *fakeLogik
		state  string
		detail string
	}{
		{"box ohne Kern", func(t *testing.T) map[string]any { return logikArtifact(t, 1, tLogic, nil) },
			nil, "unsupported", "Steuerlogik läuft auf dieser Box nicht"},
		{"Kern liest die Logik nicht", func(t *testing.T) map[string]any { return logikArtifact(t, 1, tLogic, nil) },
			&fakeLogik{refuse: "Logik nicht lesbar: x"}, "error", "Logik nicht lesbar: x"},
		{"leere Logik", func(t *testing.T) map[string]any { return logikArtifact(t, 1, "", nil) },
			&fakeLogik{}, "error", "Bundle-Format nicht unterstützt oder leer"},
		{"Logik neben Tabs", func(t *testing.T) map[string]any {
			return logikArtifact(t, 1, tLogic, func(b map[string]any) { b["tab_ids"] = []any{"x"} })
		}, &fakeLogik{}, "error", "Bundle-Format nicht unterstützt oder leer"},
		{"Reihenfolge geändert, Hash alt", func(t *testing.T) map[string]any {
			a := logikArtifact(t, 1, tLogic, nil)
			a["bundle"].(map[string]any)["logic"] = `{"logic":1,"name":"Probe","states":{"a":{},"b":{}}}`
			return a
		}, &fakeLogik{}, "error", "content_hash stimmt nicht mit dem Bundle überein"},
		{"unbekanntes Feld im Bündel", func(t *testing.T) map[string]any {
			return logikArtifact(t, 1, tLogic, func(b map[string]any) { b["extra"] = true })
		}, &fakeLogik{}, "error", "content_hash stimmt nicht mit dem Bundle überein"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dep := newDeployer(t, newFakeNR())
			if c.logik != nil {
				dep.SetLogikLaufzeit(c.logik)
			}
			dep.HandleDeployment(makeDeployment(t, c.art(t)))
			st, d := ackOf(t, dep, tLogikID)
			if st != c.state || d != c.detail {
				t.Fatalf("ack = %s (%s), want %s (%s)", st, d, c.state, c.detail)
			}
			if c.logik != nil && len(c.logik.last()) != 0 {
				t.Fatalf("refused logic handed over: %+v", c.logik.last())
			}
		})
	}
}

// A Node-RED bundle may not smuggle the logic fields.
func TestNodeRedBuendelOhneLogikfelder(t *testing.T) {
	dep := newDeployer(t, newFakeNR())
	art := makeArtifact(t, 1, func(a map[string]any) {
		b := a["bundle"].(map[string]any)
		b["logic"] = tLogic
		hash, _ := ContentHash(mustJSON(t, b))
		a["content_hash"] = hash
	})
	dep.HandleDeployment(makeDeployment(t, art))
	if st, _ := ackOf(t, dep, tFlowID); st != "error" {
		t.Fatalf("ack = %s", st)
	}
}
