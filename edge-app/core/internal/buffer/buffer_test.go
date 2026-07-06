package buffer

import (
	"fmt"
	"os"
	"testing"
	"time"
)

func openT(t *testing.T, dir string, retention time.Duration) *Buffer {
	t.Helper()
	b, err := Open(dir, retention)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b
}

func TestReplayOrderingAndOriginalTimestamps(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	base := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 5; i++ {
		if _, err := b.Append(base.Add(time.Duration(i)*time.Second), map[string]float64{"power_kw": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 5; i++ {
		e, ok := b.Next()
		if !ok {
			t.Fatalf("entry %d missing", i)
		}
		if !e.Ts.Equal(base.Add(time.Duration(i) * time.Second)) {
			t.Errorf("entry %d: original ts lost: %v", i, e.Ts)
		}
		if e.Seq != int64(i) {
			t.Errorf("entry %d: seq %d", i, e.Seq)
		}
		if e.Measurements["power_kw"] != float64(i) {
			t.Errorf("entry %d: payload mixed up", i)
		}
		if err := b.Ack(); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := b.Next(); ok {
		t.Error("drained buffer must report empty")
	}
}

func TestUnackedEntryIsRedelivered(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	ts := time.Now().UTC()
	_, _ = b.Append(ts, map[string]float64{"soc_pct": 50})
	e1, _ := b.Next()
	e2, _ := b.Next() // no Ack in between -> same entry again (at-least-once)
	if e1.Seq != e2.Seq {
		t.Errorf("un-acked entry must be redelivered: %d vs %d", e1.Seq, e2.Seq)
	}
}

func TestCursorAndSeqSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	base := time.Now().UTC()
	for i := 0; i < 3; i++ {
		_, _ = b.Append(base.Add(time.Duration(i)*time.Second), map[string]float64{"n": float64(i)})
	}
	if _, ok := b.Next(); !ok {
		t.Fatal("missing entry")
	}
	_ = b.Ack() // consumed entry 0
	_ = b.Close()

	// Restart: cursor at entry 1, seq counter continues at 3.
	b2 := openT(t, dir, 48*time.Hour)
	e, ok := b2.Next()
	if !ok || e.Measurements["n"] != 1 {
		t.Fatalf("cursor lost across restart: %+v ok=%v", e, ok)
	}
	stored, err := b2.Append(base.Add(time.Hour), map[string]float64{"n": 99})
	if err != nil {
		t.Fatal(err)
	}
	if stored.Seq != 3 {
		t.Errorf("seq must continue monotonically across restarts, got %d", stored.Seq)
	}
	if got := b2.Pending(); got != 3 {
		t.Errorf("pending after restart: got %d, want 3", got)
	}
}

func TestSegmentRotationKeepsOrder(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	base := time.Now().UTC()
	n := segmentEntries + 10 // force a rotation
	for i := 0; i < n; i++ {
		_, _ = b.Append(base.Add(time.Duration(i)*time.Second), map[string]float64{"n": float64(i)})
	}
	for i := 0; i < n; i++ {
		e, ok := b.Next()
		if !ok {
			t.Fatalf("entry %d missing after rotation", i)
		}
		if e.Seq != int64(i) {
			t.Fatalf("order broken at %d: seq %d", i, e.Seq)
		}
		_ = b.Ack()
	}
}

func TestEvictionOldestFirst(t *testing.T) {
	b := openT(t, t.TempDir(), time.Hour)
	old := time.Now().UTC().Add(-3 * time.Hour)
	// Fill one whole old segment plus a bit of a second.
	for i := 0; i < segmentEntries+5; i++ {
		if _, err := b.Append(old.Add(time.Duration(i)*time.Millisecond), map[string]float64{"n": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	// A fresh append triggers eviction of the over-horizon oldest segment.
	if _, err := b.Append(time.Now().UTC(), map[string]float64{"n": -1}); err != nil {
		t.Fatal(err)
	}
	// The first surviving entry must be from the SECOND segment (the oldest
	// full segment was dropped as a whole).
	e, ok := b.Next()
	if !ok {
		t.Fatal("buffer empty after eviction")
	}
	if e.Seq < int64(segmentEntries) {
		t.Errorf("oldest segment should be gone; first entry seq %d", e.Seq)
	}
	if p := b.Pending(); p != 6 {
		t.Errorf("pending after eviction: got %d, want 6", p)
	}
}

func TestRetentionKeepsRecentEntries(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	now := time.Now().UTC()
	for i := 0; i < 10; i++ {
		_, _ = b.Append(now.Add(-time.Duration(i)*time.Hour), map[string]float64{"n": float64(i)})
	}
	if p := b.Pending(); p != 10 {
		t.Errorf("recent entries must survive: %d", p)
	}
}

func TestPendingCountsAcrossSegments(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	now := time.Now().UTC()
	n := segmentEntries*2 + 7
	for i := 0; i < n; i++ {
		_, _ = b.Append(now, map[string]float64{"n": float64(i)})
	}
	if p := b.Pending(); p != n {
		t.Errorf("pending: got %d, want %d", p, n)
	}
	for i := 0; i < 10; i++ {
		if _, ok := b.Next(); !ok {
			t.Fatal(fmt.Sprintf("entry %d missing", i))
		}
		_ = b.Ack()
	}
	if p := b.Pending(); p != n-10 {
		t.Errorf("pending after acks: got %d, want %d", p, n-10)
	}
}

// A long outage that overruns the retention horizon drops the oldest,
// never-published entries. That data loss must be observable (DataLoss) so the
// UI can warn instead of the pending count silently plateauing - and the flag
// must clear again once the backlog drains.
func TestDataLossFlagOnEvictionAndClearsOnDrain(t *testing.T) {
	b := openT(t, t.TempDir(), time.Nanosecond)
	if b.DataLoss() {
		t.Fatal("fresh buffer must not report data loss")
	}
	// Entries are stamped in the PAST relative to the wall clock: eviction is
	// driven by the core clock (G3), not the sample ts, so a 1ns retention drops
	// the oldest segment the read cursor is still inside = real loss.
	base := time.Now().UTC().Add(-time.Hour)
	// Fill past one whole segment (monotonic timestamps) without ever acking, so
	// eviction drops a segment the read cursor is still inside = real loss.
	for i := 0; i < segmentEntries+2; i++ {
		if _, err := b.Append(base.Add(time.Duration(i)*time.Millisecond), map[string]float64{"power_kw": 1}); err != nil {
			t.Fatal(err)
		}
	}
	if !b.DataLoss() {
		t.Fatal("expected data-loss flag after evicting un-published entries")
	}
	// Drain the surviving backlog -> the flag clears.
	for {
		if _, ok := b.Next(); !ok {
			break
		}
		if err := b.Ack(); err != nil {
			t.Fatal(err)
		}
	}
	if b.DataLoss() {
		t.Error("data-loss flag should clear once the backlog fully drains")
	}
}

// Draining a backlog must parse each segment ONCE (serving entries from an
// in-memory cache), not once per entry (the former O(n^2) drain). See G1.
func TestSegmentParsedOncePerDrain(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	now := time.Now().UTC()
	n := segmentEntries*2 + 3 // three segments: two full + a partial tail
	for i := 0; i < n; i++ {
		if _, err := b.Append(now, map[string]float64{"n": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	before := b.parseCount
	for i := 0; i < n; i++ {
		if _, ok := b.Next(); !ok {
			t.Fatalf("entry %d missing", i)
		}
		if err := b.Ack(); err != nil {
			t.Fatal(err)
		}
	}
	parses := b.parseCount - before
	if parses > len(b.segments) {
		t.Errorf("expected at most one parse per segment (%d segments), got %d parses draining %d entries",
			len(b.segments), parses, n)
	}
}

// Eviction must not stall behind an unreadable (empty/corrupt) oldest segment:
// it drops that segment and keeps enforcing retention on the rest. See G3.
func TestEvictionDropsUnreadableOldestSegment(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, time.Hour)
	old := time.Now().UTC().Add(-3 * time.Hour)
	// Two full old segments + a fresh tail entry.
	for i := 0; i < segmentEntries*2; i++ {
		if _, err := b.Append(old.Add(time.Duration(i)*time.Millisecond), map[string]float64{"n": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	// Corrupt the oldest segment (truncate to empty) so lastEntry returns ok=false.
	if err := os.Truncate(b.segPath(b.segments[0]), 0); err != nil {
		t.Fatal(err)
	}
	// A fresh append triggers eviction; the empty oldest segment must be dropped
	// AND the second (over-horizon) segment evicted behind it.
	if _, err := b.Append(time.Now().UTC(), map[string]float64{"n": -1}); err != nil {
		t.Fatal(err)
	}
	for _, n := range b.segments {
		if n < 2 {
			t.Errorf("over-horizon segments (incl. the unreadable one) should be gone; still have segment %d", n)
		}
	}
}

func TestPurgeThroughDropsOldKeepsNewAndSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	base := time.Date(2026, 7, 6, 10, 0, 0, 0, time.UTC)
	// Ten entries; ack the first two (already published), leave eight pending.
	for i := 0; i < 10; i++ {
		if _, err := b.Append(base.Add(time.Duration(i)*time.Minute), map[string]float64{"power_kw": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if _, ok := b.Next(); !ok {
			t.Fatal("expected entry")
		}
		if err := b.Ack(); err != nil {
			t.Fatal(err)
		}
	}

	// Purge through minute 6: pending entries 2..6 drop, 7..9 survive.
	dropped, err := b.PurgeThrough(base.Add(6 * time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 5 {
		t.Fatalf("dropped = %d, want 5", dropped)
	}
	if got := b.Pending(); got != 3 {
		t.Fatalf("pending = %d, want 3", got)
	}
	// Survivors replay in order with their ORIGINAL timestamps + sequence.
	for i := 7; i < 10; i++ {
		e, ok := b.Next()
		if !ok {
			t.Fatalf("survivor %d missing", i)
		}
		if !e.Ts.Equal(base.Add(time.Duration(i) * time.Minute)) {
			t.Errorf("survivor %d: ts %v", i, e.Ts)
		}
		if e.Seq != int64(i) {
			t.Errorf("survivor %d: seq %d", i, e.Seq)
		}
		if err := b.Ack(); err != nil {
			t.Fatal(err)
		}
	}

	// The sequence counter keeps counting monotonically after a purge, and the
	// purged state survives a restart (nothing purged reappears).
	if _, err := b.Append(base.Add(time.Hour), map[string]float64{"power_kw": 1}); err != nil {
		t.Fatal(err)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	b2 := openT(t, dir, 48*time.Hour)
	if got := b2.Pending(); got != 1 {
		t.Fatalf("pending after restart = %d, want 1", got)
	}
	e, ok := b2.Next()
	if !ok || e.Seq != 10 {
		t.Fatalf("post-purge entry: ok=%v seq=%d, want seq 10", ok, e.Seq)
	}
}

func TestPurgeThroughEverythingLeavesCleanEmptyBuffer(t *testing.T) {
	b := openT(t, t.TempDir(), 48*time.Hour)
	now := time.Now().UTC()
	for i := 0; i < 700; i++ { // spans multiple segments (rotation at 512)
		if _, err := b.Append(now.Add(-time.Duration(700-i)*time.Second), map[string]float64{"power_kw": 1}); err != nil {
			t.Fatal(err)
		}
	}
	dropped, err := b.PurgeThrough(now)
	if err != nil {
		t.Fatal(err)
	}
	if dropped != 700 {
		t.Fatalf("dropped = %d, want 700", dropped)
	}
	if got := b.Pending(); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
	if _, ok := b.Next(); ok {
		t.Fatal("purged buffer must be empty")
	}
	// Idempotent: purging again is a harmless no-op.
	if again, err := b.PurgeThrough(now); err != nil || again != 0 {
		t.Fatalf("second purge: dropped=%d err=%v", again, err)
	}
	// And the buffer still accepts + replays new data normally.
	if _, err := b.Append(now.Add(time.Second), map[string]float64{"power_kw": 2}); err != nil {
		t.Fatal(err)
	}
	if e, ok := b.Next(); !ok || e.Measurements["power_kw"] != 2 {
		t.Fatalf("new entry after purge: ok=%v e=%+v", ok, e)
	}
}
