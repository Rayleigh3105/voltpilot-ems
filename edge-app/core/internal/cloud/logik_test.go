package cloud

import "testing"

// The logik block rides the status heartbeat only while a logic runs along;
// without one the heartbeat stays byte for byte what it was.
func TestLogikBlockImHerzschlag(t *testing.T) {
	sink := startStatusSink(t)
	link := connectedLink(t, sink, "v")
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, StatusExtension{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := sink.last(t)["logik"]; ok {
		t.Fatal("no logic, no block")
	}
	ein, stufe := true, 0
	sum := &LogikSummary{Laeufe: []LogikLauf{{
		FlowID: "f", FlowVersion: 2, ContentHash: "sha256:x", Name: "Wärmepumpe", Zustand: "mitlaufend",
		Seit: "2026-11-14T10:00:00Z", Tag: "2026-11-14",
		Geraete: map[string]LogikGeraet{"wp": {EntityID: "e1", Wunsch: &LogikStand{Ein: &ein},
			Ist: &LogikStand{Stufe: &stufe}, VerglichenS: 60, AbweichendS: 60, LaengsteAbweichungS: 60, WunschWechsel: 1}},
		Wechsel: []LogikWechsel{{Nr: 1, T: "2026-11-14T10:20:00Z", Geraet: "wp", Was: "wunsch",
			Neu: &LogikStand{Ein: &ein}, Andere: &LogikStand{Stufe: &stufe}}},
	}}}
	if err := link.PublishStatus("default", nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, StatusExtension{Logik: sum}); err != nil {
		t.Fatal(err)
	}
	block, ok := sink.last(t)["logik"].(map[string]any)
	if !ok {
		t.Fatal("logik block missing")
	}
	lauf := block["laeufe"].([]any)[0].(map[string]any)
	wp := lauf["geraete"].(map[string]any)["wp"].(map[string]any)
	ist := wp["ist"].(map[string]any)
	if lauf["zustand"] != "mitlaufend" || lauf["flow_version"] != 2.0 || wp["abweichend_s"] != 60.0 ||
		ist["stufe"] != 0.0 || lauf["wechsel"].([]any)[0].(map[string]any)["was"] != "wunsch" {
		t.Fatalf("wire: %v", block)
	}
	if _, ok := lauf["lage"]; ok {
		t.Fatal("no Lage yet, no field")
	}
}
