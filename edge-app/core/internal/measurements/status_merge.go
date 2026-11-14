package measurements

// Steuerlogik-Konzept Stufe 1 follow-up (firstmate review of PR #1886): more
// than one local reader now judges the SAME retained plan revision - on Edge
// Light, layer1's settings reader walks every selection and refuses whatever
// is not in its own small table (reason "edge_too_old"), while the new
// Shelly add-on sensor reader separately judges its own point-key templates.
// Each publishes its OWN LocalStatus to the one retained LocalStatusTopic;
// without a merge, onMeasurementStatus stored and forwarded WHICHEVER one
// arrived last, so a working Fühler point could show "abgelehnt" in the
// portal (or flip between accepted/rejected) purely by publish timing.
//
// A reader may only judge points that belong to it - so wherever two readers
// both mention the same point_key, the ACCEPTANCE wins: the point's actual
// owner reading it successfully must never be shadowed by an unrelated
// reader's blanket "I don't know this point" refusal picked up while it was
// walking the whole plan.

import (
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

// StatusMerger combines the partial LocalStatus documents several
// independent local readers publish for one plan revision into the single
// document stored and forwarded to the cloud. Not safe for concurrent Merge
// calls from outside the agent's own serialized bus-handler dispatch; it
// holds its own lock regardless, so a caller never has to reason about it.
type StatusMerger struct {
	mu       sync.Mutex
	revision int64
	applied  time.Time
	accepted map[string]bool
	// rejected is keyed by point_key + "\x00" + entity_id (entity_id empty
	// for a whole-point refusal) - the same shape Rejection.EntityID already
	// distinguishes.
	rejected map[string]Rejection
}

// NewStatusMerger returns an empty merger, one per Agent (like every other
// per-device local cache this package's callers keep).
func NewStatusMerger() *StatusMerger {
	return &StatusMerger{accepted: map[string]bool{}, rejected: map[string]Rejection{}}
}

// Merge folds one reader's LocalStatus into the running merge for its
// revision and returns the combined document's raw bytes - NOT yet the
// cloud envelope; the caller still runs the result through WrapStatus, so
// every existing structural invariant (pattern, closed reason vocabulary,
// point budget) is still checked exactly once, on the merged whole.
//
// A status for an OLDER revision than the one already merging is refused
// (the newer plan already supersedes it, same rule the reconnect-republish
// path already relies on elsewhere). A NEWER revision starts a fresh merge -
// every reader re-publishes its verdict whenever the plan changes, so the
// merge is never missing a reader's contribution after a revision bump.
func (m *StatusMerger) Merge(payload []byte) ([]byte, error) {
	var in LocalStatus
	if err := json.Unmarshal(payload, &in); err != nil {
		return nil, err
	}
	if in.Revision < 1 {
		return nil, errors.New("measurements: status merge: invalid revision")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	switch {
	case in.Revision > m.revision:
		m.revision = in.Revision
		m.accepted = map[string]bool{}
		m.rejected = map[string]Rejection{}
	case in.Revision < m.revision:
		return nil, errors.New("measurements: status merge: stale revision")
	}
	m.applied = in.AppliedAt
	for _, key := range in.Accepted {
		m.accepted[key] = true
		// The point's owner just accepted it: an earlier WHOLE-point
		// refusal of the same point_key from a different reader is now
		// wrong and must not survive the merge. A PER-COMPONENT refusal
		// (EntityID set) stays - the existing contract already lets a point
		// be accepted for its other components while one is refused.
		delete(m.rejected, key+"\x00")
	}
	for _, r := range in.Rejected {
		if r.EntityID == "" && m.accepted[r.PointKey] {
			continue // this point already has an owner that reads it whole
		}
		m.rejected[r.PointKey+"\x00"+r.EntityID] = r
	}
	return m.marshalLocked()
}

func (m *StatusMerger) marshalLocked() ([]byte, error) {
	accepted := make([]string, 0, len(m.accepted))
	for key := range m.accepted {
		accepted = append(accepted, key)
	}
	sort.Strings(accepted)
	rejected := make([]Rejection, 0, len(m.rejected))
	for _, r := range m.rejected {
		rejected = append(rejected, r)
	}
	sort.Slice(rejected, func(i, j int) bool {
		if rejected[i].PointKey != rejected[j].PointKey {
			return rejected[i].PointKey < rejected[j].PointKey
		}
		return rejected[i].EntityID < rejected[j].EntityID
	})
	return json.Marshal(LocalStatus{Revision: m.revision, AppliedAt: m.applied,
		Accepted: accepted, Rejected: rejected})
}
