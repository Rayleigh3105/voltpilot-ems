package buffer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Sent telemetry is never read again, so the ring deletes a segment as soon as
// the read cursor has left it; only unsent telemetry waits for the retention
// horizon. On Edge Light the ring lives in tmpfs, where 48 h of already-sent
// samples (~17 MB) crowded out the space an update needs to unpack.

// segmentFiles lists the segment numbers actually on disk.
func segmentFiles(t *testing.T, dir string) []int {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []int
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "segment-") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "segment-"), ".jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

func appendN(t *testing.T, b *Buffer, n int, ts func(i int) time.Time) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := b.Append(ts(i), map[string]float64{"n": float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
}

// sendN publishes and acks the next n entries, as the publisher does.
func sendN(t *testing.T, b *Buffer, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		e, ok := b.Next()
		if !ok {
			t.Fatalf("entry %d of %d missing", i, n)
		}
		if err := b.Ack(e.Seq); err != nil {
			t.Fatal(err)
		}
	}
}

func writeCursor(t *testing.T, dir string, c cursor) {
	t.Helper()
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cursor.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func wantSegments(t *testing.T, b *Buffer, dir string, want []int) {
	t.Helper()
	if got := segmentFiles(t, dir); !reflect.DeepEqual(got, want) {
		t.Errorf("segment files on disk = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(b.segments, want) {
		t.Errorf("segments in memory = %v, want %v", b.segments, want)
	}
}

// Five segments, two and a bit sent: the next sample deletes the two sent
// segments; the segment the cursor sits in (sent head, unsent rest) and
// everything after it stay. Once all is sent only the tail is left.
func TestSentSegmentsAreDeletedUnsentStay(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	base := time.Now().UTC().Add(-time.Hour)
	total := segmentEntries*4 + 10 // segments 0..4, tail holds 10
	appendN(t, b, total, func(i int) time.Time { return base.Add(time.Duration(i) * time.Millisecond) })

	sent := segmentEntries*2 + 100 // cursor now inside segment 2
	sendN(t, b, sent)
	if _, err := b.Append(time.Now().UTC(), map[string]float64{"n": -1}); err != nil {
		t.Fatal(err)
	}
	wantSegments(t, b, dir, []int{2, 3, 4})
	if got, want := b.Pending(), total+1-sent; got != want {
		t.Errorf("pending = %d, want %d", got, want)
	}
	if e, ok := b.Next(); !ok || e.Seq != int64(sent) {
		t.Fatalf("first unsent entry must be seq %d, got %+v ok=%v", sent, e, ok)
	}
	if b.DataLoss() {
		t.Error("deleting sent segments is no data loss")
	}

	sendN(t, b, total+1-sent)
	if _, err := b.Append(time.Now().UTC(), map[string]float64{"n": -2}); err != nil {
		t.Fatal(err)
	}
	wantSegments(t, b, dir, []int{4})
	if got := b.Pending(); got != 1 {
		t.Errorf("pending = %d, want 1 (the sample after the drain)", got)
	}
	if e, ok := b.Next(); !ok || e.Measurements["n"] != -2 {
		t.Fatalf("sample after the drain lost: %+v ok=%v", e, ok)
	}
}

// A program that kept sent segments (every version before this change) or a
// stop before the next sample leaves them on disk; Open deletes them at once.
func TestOpenDeletesSentSegmentsLeftOnDisk(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	now := time.Now().UTC()
	total := segmentEntries*4 + 10
	appendN(t, b, total, func(int) time.Time { return now })
	sent := segmentEntries*2 + 100
	sendN(t, b, sent) // no sample afterwards: nothing deleted yet
	if got := segmentFiles(t, dir); len(got) != 5 {
		t.Fatalf("precondition: want all 5 segments on disk, got %v", got)
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}

	b2 := openT(t, dir, 48*time.Hour)
	wantSegments(t, b2, dir, []int{2, 3, 4})
	if e, ok := b2.Next(); !ok || e.Seq != int64(sent) {
		t.Fatalf("cursor lost across restart: %+v ok=%v", e, ok)
	}
	if got, want := b2.Pending(), total-sent; got != want {
		t.Errorf("pending = %d, want %d", got, want)
	}
	stored, err := b2.Append(now, map[string]float64{"n": 1})
	if err != nil {
		t.Fatal(err)
	}
	if stored.Seq != int64(total) {
		t.Errorf("seq must continue across restarts, got %d want %d", stored.Seq, total)
	}
}

// Restart in the middle of the clean-up: the cursor was flushed, the stop came
// after the first of two deletes. Open finishes the job; nothing unsent moves.
func TestRestartAfterCursorFlushMidDelete(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	now := time.Now().UTC()
	total := segmentEntries*4 + 10
	appendN(t, b, total, func(int) time.Time { return now })
	sent := segmentEntries*2 + 100
	sendN(t, b, sent)
	if err := b.Close(); err != nil { // cursor (2, 100) on disk
		t.Fatal(err)
	}
	if err := os.Remove(b.segPath(0)); err != nil { // stop after the first delete
		t.Fatal(err)
	}

	b2 := openT(t, dir, 48*time.Hour)
	wantSegments(t, b2, dir, []int{2, 3, 4})
	if e, ok := b2.Next(); !ok || e.Seq != int64(sent) {
		t.Fatalf("first unsent entry must be seq %d, got %+v ok=%v", sent, e, ok)
	}
	if got, want := b2.Pending(), total-sent; got != want {
		t.Errorf("pending = %d, want %d", got, want)
	}
}

// Power loss on a disk can keep the deletes but lose the cursor flush. The
// older cursor points into a deleted segment; Open snaps it to the oldest
// survivor. That replays the acked head of that segment (idempotent in the
// cloud) and never skips an unsent entry.
func TestRestartWithOlderCursorThanDeletes(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	now := time.Now().UTC()
	total := segmentEntries*4 + 10
	appendN(t, b, total, func(int) time.Time { return now })
	sendN(t, b, segmentEntries*2+100) // in memory: cursor (2, 100)
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	writeCursor(t, dir, cursor{ReadSeg: 1, ReadIdx: 37, Seq: int64(total)})
	for _, n := range []int{0, 1} {
		if err := os.Remove(b.segPath(n)); err != nil {
			t.Fatal(err)
		}
	}

	b2 := openT(t, dir, 48*time.Hour)
	wantSegments(t, b2, dir, []int{2, 3, 4})
	if e, ok := b2.Next(); !ok || e.Seq != int64(segmentEntries*2) {
		t.Fatalf("must resume at the head of segment 2 (seq %d), got %+v ok=%v", segmentEntries*2, e, ok)
	}
	if got, want := b2.Pending(), total-segmentEntries*2; got != want {
		t.Errorf("pending = %d, want %d", got, want)
	}
}

// No cursor flush, no delete: a segment below the in-memory cursor is only
// deleted once the cursor that marks it sent is on disk.
func TestSentSegmentsStayWhenCursorFlushFails(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	now := time.Now().UTC()
	appendN(t, b, segmentEntries*2+10, func(int) time.Time { return now })
	sendN(t, b, segmentEntries+5) // cursor in segment 1, segment 0 sent

	blocker := filepath.Join(dir, "cursor.json.tmp")
	if err := os.Mkdir(blocker, 0o755); err != nil { // os.WriteFile on it fails
		t.Fatal(err)
	}
	b.mu.Lock()
	dropped := b.dropSentLocked()
	b.mu.Unlock()
	if dropped != 0 {
		t.Fatalf("deleted %d segments without a flushed cursor", dropped)
	}
	wantSegments(t, b, dir, []int{0, 1, 2})

	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	dropped = b.dropSentLocked()
	b.mu.Unlock()
	if dropped != 1 {
		t.Fatalf("dropped = %d, want 1", dropped)
	}
	wantSegments(t, b, dir, []int{1, 2})
}

// A cursor beyond the newest segment does not describe this ring (a stop
// inside PurgeThrough, which renumbers the ring from 0, leaves that). Then
// nothing is deleted - those segments may well hold unsent entries.
func TestCursorBeyondRingDeletesNothing(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	now := time.Now().UTC()
	appendN(t, b, segmentEntries+5, func(int) time.Time { return now })
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	writeCursor(t, dir, cursor{ReadSeg: 50, ReadIdx: 0, Seq: int64(segmentEntries + 5)})

	b2 := openT(t, dir, 48*time.Hour)
	if _, err := b2.Append(now, map[string]float64{"n": 1}); err != nil {
		t.Fatal(err)
	}
	wantSegments(t, b2, dir, []int{0, 1})
}

// Cloud outage: unsent telemetry stays for the whole retention horizon (here
// 47 h old under 48 h), sent telemetry goes as soon as it is sent although it
// is just as recent, and unsent telemetry past the horizon is still evicted
// with the data-loss warning.
func TestOutageKeepsUnsentUntilHorizonSentGoesAtOnce(t *testing.T) {
	dir := t.TempDir()
	b := openT(t, dir, 48*time.Hour)
	old := time.Now().UTC().Add(-47 * time.Hour)
	outage := segmentEntries * 3
	appendN(t, b, outage, func(i int) time.Time { return old.Add(time.Duration(i) * time.Millisecond) })
	if _, err := b.Append(time.Now().UTC(), map[string]float64{"n": -1}); err != nil {
		t.Fatal(err)
	}
	wantSegments(t, b, dir, []int{0, 1, 2, 3})
	if got := b.Pending(); got != outage+1 {
		t.Errorf("pending during outage = %d, want %d", got, outage+1)
	}
	if b.DataLoss() {
		t.Error("nothing unsent is past the horizon yet")
	}

	// Cloud back: two segments and the head of the third go out, the next
	// sample deletes the two sent segments.
	sendN(t, b, segmentEntries*2+1)
	if _, err := b.Append(time.Now().UTC(), map[string]float64{"n": -2}); err != nil {
		t.Fatal(err)
	}
	wantSegments(t, b, dir, []int{2, 3})
	if b.DataLoss() {
		t.Error("deleting sent segments is no data loss")
	}
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}

	// The horizon still governs unsent telemetry: under a 46 h horizon the
	// unsent segment 2 (47 h old) is evicted and flagged as lost.
	b2 := openT(t, dir, 46*time.Hour)
	if _, err := b2.Append(time.Now().UTC(), map[string]float64{"n": -3}); err != nil {
		t.Fatal(err)
	}
	wantSegments(t, b2, dir, []int{3})
	if !b2.DataLoss() {
		t.Error("evicting unsent telemetry past the horizon must raise the data-loss flag")
	}
	if got := b2.Pending(); got != 3 {
		t.Errorf("pending = %d, want 3 (the three fresh samples in the tail)", got)
	}
}
