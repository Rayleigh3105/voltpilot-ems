package agent

// The `update` block the agent folds into every heartbeat (OTA Stufe 0).
//
// The whole value of Stufe 0 is that "veraltet" becomes WELL-DEFINED, and that
// rests on the cloud's release register ordering by release_seq. A device that
// invented a sequence number, a target or a last-known-good would corrupt
// exactly that - so these tests are mostly about what must NOT be there.

import (
	"encoding/json"
	"testing"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
)

func TestUpdateSummaryReportsTheStampedVersionAndNothingItCannotKnow(t *testing.T) {
	a := &Agent{}
	u := a.updateSummary()
	if u == nil {
		t.Fatal("the update block must ride EVERY heartbeat in Stufe 0")
	}
	if u.Backend != cloud.UpdateBackendCompose {
		t.Fatalf("backend = %q, want the compose apply backend", u.Backend)
	}
	if u.State != cloud.UpdateStateIdle {
		t.Fatalf("state = %q - Stufe 0 applies nothing, so anything but idle claims an "+
			"activity that does not exist", u.State)
	}
	// Verbatim: an existing build is stamped with a bare 12-char commit SHA,
	// and reformatting it here would invent a release tag.
	if u.Current != Version {
		t.Fatalf("current = %q, want the stamped version verbatim (%q)", u.Current, Version)
	}
	if u.CurrentSeq != nil || u.TargetSeq != nil {
		t.Fatal("a sequence number is the CLOUD register's ordering - the device must never guess one")
	}
	if u.Target != "" || u.Channel != "" {
		t.Fatal("there is no target assignment on the device before Stufe 2")
	}
	if u.LastKnownGood != "" {
		t.Fatal("a box that never applied an update has no last-known-good; claiming the " +
			"current version as one would fabricate a rollback target")
	}
	if u.Reason != "" {
		t.Fatal("idle carries no reason")
	}
}

// The omitempty wire shape: the absent fields must not appear as empty strings
// either - the cloud stores what it receives, and "" is not the same statement
// as "not reported".
func TestUpdateSummaryWireShapeOmitsWhatIsUnknown(t *testing.T) {
	raw, err := json.Marshal((&Agent{}).updateSummary())
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, absent := range []string{"current_seq", "target", "target_seq", "channel",
		"reason", "last_known_good"} {
		if _, ok := got[absent]; ok {
			t.Fatalf("%s must be omitted, got %v", absent, got[absent])
		}
	}
	for _, present := range []string{"backend", "state", "current"} {
		if _, ok := got[present]; !ok {
			t.Fatalf("%s must always be present, payload: %s", present, raw)
		}
	}
}
