package measurements

import (
	"encoding/json"
	"testing"
)

func mustMerge(t *testing.T, m *StatusMerger, raw string) LocalStatus {
	t.Helper()
	out, err := m.Merge([]byte(raw))
	if err != nil {
		t.Fatalf("Merge(%s): %v", raw, err)
	}
	var s LocalStatus
	if err := json.Unmarshal(out, &s); err != nil {
		t.Fatalf("Merge result unmarshal: %v", err)
	}
	return s
}

// The exact defect firstmate flagged on PR #1886: layer1's settings reader
// walks the whole plan and refuses an unrecognized point with "edge_too_old"
// before the Fühler reader, which owns that point, reports it accepted. The
// merged document must show it accepted - a working point must never read
// as "abgelehnt" just because an unrelated reader saw it first.
func TestMergeAcceptedFromOneReaderWinsOverEarlierRejectionFromAnother(t *testing.T) {
	m := NewStatusMerger()
	layer1Status := `{"revision":5,"applied_at":"2026-11-14T12:00:00Z","accepted":[],` +
		`"rejected":[{"point_key":"shelly.gen2plus.temperature[100].tc","reason":"edge_too_old"}]}`
	fuehlerStatus := `{"revision":5,"applied_at":"2026-11-14T12:00:01Z",` +
		`"accepted":["shelly.gen2plus.temperature[100].tc"],"rejected":[]}`

	s1 := mustMerge(t, m, layer1Status)
	if len(s1.Accepted) != 0 || len(s1.Rejected) != 1 || s1.Rejected[0].Reason != "edge_too_old" {
		t.Fatalf("after layer1 alone = %+v", s1)
	}
	s2 := mustMerge(t, m, fuehlerStatus)
	if len(s2.Rejected) != 0 {
		t.Fatalf("rejected = %+v, want none - the owner's acceptance must clear it", s2.Rejected)
	}
	if len(s2.Accepted) != 1 || s2.Accepted[0] != "shelly.gen2plus.temperature[100].tc" {
		t.Fatalf("accepted = %+v", s2.Accepted)
	}
}

// The same merge, in the OPPOSITE arrival order - the result must not depend
// on which reader happens to publish first.
func TestMergeOrderIndependent(t *testing.T) {
	m := NewStatusMerger()
	layer1Status := `{"revision":9,"applied_at":"2026-11-14T12:00:00Z","accepted":[],` +
		`"rejected":[{"point_key":"shelly.gen2plus.input[100].state","reason":"edge_too_old"}]}`
	fuehlerStatus := `{"revision":9,"applied_at":"2026-11-14T12:00:01Z",` +
		`"accepted":["shelly.gen2plus.input[100].state"],"rejected":[]}`

	mustMerge(t, m, fuehlerStatus)
	final := mustMerge(t, m, layer1Status)
	if len(final.Rejected) != 0 || len(final.Accepted) != 1 {
		t.Fatalf("final = %+v, want the earlier acceptance to still stand", final)
	}
}

// Two readers' DISJOINT points both survive the merge - the common case
// (each reader owns different points of the same revision).
func TestMergeKeepsDisjointContributionsFromBothReaders(t *testing.T) {
	m := NewStatusMerger()
	layer1Status := `{"revision":3,"applied_at":"2026-11-14T12:00:00Z",` +
		`"accepted":["deye.hybrid_1p.settings.battery-low-soc"],` +
		`"rejected":[{"point_key":"sunspec.something","reason":"unknown_point"}]}`
	fuehlerStatus := `{"revision":3,"applied_at":"2026-11-14T12:00:01Z",` +
		`"accepted":["shelly.gen1.external_sensor[0].ext_temperature.0.tc"],"rejected":[]}`

	mustMerge(t, m, layer1Status)
	final := mustMerge(t, m, fuehlerStatus)
	if len(final.Accepted) != 2 {
		t.Fatalf("accepted = %+v, want both readers' points kept", final.Accepted)
	}
	if len(final.Rejected) != 1 || final.Rejected[0].PointKey != "sunspec.something" {
		t.Fatalf("rejected = %+v, want the still-unowned point kept", final.Rejected)
	}
}

// A NEWER revision starts a fresh merge: a stale accepted/rejected entry
// from the superseded plan must never leak into the new one.
func TestMergeNewerRevisionResetsThePreviousOne(t *testing.T) {
	m := NewStatusMerger()
	mustMerge(t, m, `{"revision":1,"applied_at":"2026-11-14T12:00:00Z",`+
		`"accepted":["p.old"],"rejected":[]}`)
	final := mustMerge(t, m, `{"revision":2,"applied_at":"2026-11-14T12:00:01Z",`+
		`"accepted":["p.new"],"rejected":[]}`)
	if len(final.Accepted) != 1 || final.Accepted[0] != "p.new" {
		t.Fatalf("accepted = %+v, want only the new revision's point", final.Accepted)
	}
}

// An OLDER revision arriving after a newer one is already merging (a
// straggling reader that had not yet caught up) is refused, not silently
// folded into the newer merge.
func TestMergeRefusesStaleRevision(t *testing.T) {
	m := NewStatusMerger()
	mustMerge(t, m, `{"revision":5,"applied_at":"2026-11-14T12:00:00Z",`+
		`"accepted":["p.a"],"rejected":[]}`)
	if _, err := m.Merge([]byte(`{"revision":4,"applied_at":"2026-11-14T12:00:01Z",` +
		`"accepted":["p.b"],"rejected":[]}`)); err == nil {
		t.Fatal("expected a stale-revision error")
	}
}

// A rejection naming one component of a shared point (EntityID set) is kept
// distinct from a whole-point rejection or acceptance of the same point_key
// - the existing per-component shape (Rejection.EntityID) must survive the
// merge unchanged.
func TestMergeKeepsPerComponentRejectionDistinctFromWholePoint(t *testing.T) {
	m := NewStatusMerger()
	status := `{"revision":1,"applied_at":"2026-11-14T12:00:00Z",` +
		`"accepted":["shared.point"],` +
		`"rejected":[{"point_key":"shared.point","reason":"binding_unavailable",` +
		`"entity_id":"11111111-1111-1111-1111-111111111111"}]}`
	final := mustMerge(t, m, status)
	if len(final.Accepted) != 1 || len(final.Rejected) != 1 {
		t.Fatalf("final = %+v", final)
	}
	if final.Rejected[0].EntityID == "" {
		t.Fatalf("rejected[0] = %+v, want the component's entity_id kept", final.Rejected[0])
	}
}

func TestMergeRejectsUnparseableStatus(t *testing.T) {
	m := NewStatusMerger()
	if _, err := m.Merge([]byte(`not json`)); err == nil {
		t.Fatal("expected an error for unparseable input")
	}
	if _, err := m.Merge([]byte(`{"revision":0,"accepted":[],"rejected":[]}`)); err == nil {
		t.Fatal("expected an error for revision 0")
	}
}

// Confidence that marshalLocked's output is itself a valid LocalStatus the
// existing WrapStatus accepts unchanged - the caller always pipes Merge's
// result through WrapStatus next.
func TestMergeResultSurvivesWrapStatus(t *testing.T) {
	m := NewStatusMerger()
	merged, err := m.Merge([]byte(`{"revision":2,"applied_at":"2026-11-14T12:00:00Z",` +
		`"accepted":["p.a"],"rejected":[{"point_key":"p.b","reason":"edge_too_old"}]}`))
	if err != nil {
		t.Fatalf("Merge: %v", err)
	}
	if _, err := WrapStatus(merged, Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}, "2026.11.14.1"); err != nil {
		t.Fatalf("WrapStatus(merged): %v", err)
	}
}
