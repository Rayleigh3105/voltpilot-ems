package buffer

import (
	"fmt"
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
	base := time.Now().UTC()
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
