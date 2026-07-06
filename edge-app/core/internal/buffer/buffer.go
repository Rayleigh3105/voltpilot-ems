// Package buffer is the store-and-forward telemetry buffer: a bounded
// on-disk ring of measurement entries.
//
// Telemetry from Layer 1 is ALWAYS appended here first; a publisher drains
// it oldest-first and acknowledges each entry only after the cloud broker
// confirmed the QoS1 publish. On a cloud outage the buffer simply grows; on
// reconnect the backlog replays in order with the ORIGINAL timestamps (the
// cloud ingest is idempotent per (device, time), so a redelivery is a no-op).
//
// Layout: segmented JSONL files (segment-<n>.jsonl) under the buffer dir,
// rotated by entry count; a cursor.json persists the read position and the
// monotonic per-device sequence counter across restarts. Eviction drops the
// OLDEST whole segments once their newest entry falls outside the retention
// horizon (default 48h), with a clear log line.
package buffer

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Entry is one buffered telemetry sample. Identity is deliberately NOT
// stored: it is stamped at publish time (a device may buffer telemetry
// before enrollment has assigned its identity).
type Entry struct {
	Ts           time.Time          `json:"ts"`
	Seq          int64              `json:"seq"`
	Measurements map[string]float64 `json:"measurements"`
}

const segmentEntries = 512 // rotate after this many entries per file

// cursorSaveInterval bounds how many acks pass between cursor.json flushes.
// Persisting the read cursor on EVERY ack turned a backlog drain into tens of
// thousands of tmp-write+rename syscalls; because redelivery is idempotent per
// (device, time) on the writer side, a crash mid-batch just replays the last
// <interval> already-published entries harmlessly. Close() always flushes, so a
// clean shutdown loses nothing.
const cursorSaveInterval = 64

// Buffer is safe for concurrent use.
type Buffer struct {
	mu        sync.Mutex
	dir       string
	retention time.Duration

	segments []int // sorted segment numbers present on disk
	tailN    int   // number of entries in the newest segment
	seq      int64 // next sequence number

	readSeg int // cursor: segment number
	readIdx int // cursor: entries already acked within readSeg

	// cacheSeg/cacheEntries memoize the parsed contents of the segment the read
	// cursor currently sits in, so Next() serves entries from memory instead of
	// re-reading and re-parsing the whole segment file per entry (the former
	// O(n^2) drain). The cache is invalidated when the cursor leaves the segment
	// (cacheSeg != readSeg) and when Append writes into the cached segment.
	cacheSeg     int // segment number cached in cacheEntries; -1 = none
	cacheEntries []Entry
	parseCount   int // observability/tests: segment parses performed by Next

	acksSinceSave int // acks since the last cursor flush (see cursorSaveInterval)

	// lostData is set when eviction discarded entries that had NOT yet been
	// published (the read cursor was still inside the dropped segment), i.e. a
	// long outage overran the retention horizon and telemetry is being lost. It
	// is cleared once the backlog fully drains again. Surfaced to the UI so the
	// silently-plateauing pending count grows an honest "oldest values are being
	// discarded" warning.
	lostData bool

	writer *os.File
}

type cursor struct {
	ReadSeg int   `json:"read_seg"`
	ReadIdx int   `json:"read_idx"`
	Seq     int64 `json:"seq"`
}

// Open loads (or initializes) the buffer under dir.
func Open(dir string, retention time.Duration) (*Buffer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	b := &Buffer{dir: dir, retention: retention, cacheSeg: -1}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, "segment-") && strings.HasSuffix(name, ".jsonl") {
			n, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(name, "segment-"), ".jsonl"))
			if err == nil {
				b.segments = append(b.segments, n)
			}
		}
	}
	sort.Ints(b.segments)

	if raw, err := os.ReadFile(filepath.Join(dir, "cursor.json")); err == nil {
		var c cursor
		if json.Unmarshal(raw, &c) == nil {
			b.readSeg, b.readIdx, b.seq = c.ReadSeg, c.ReadIdx, c.Seq
		}
	}
	if len(b.segments) == 0 {
		b.segments = []int{0}
		b.readSeg = 0
		b.readIdx = 0
	} else {
		b.tailN = countLines(b.segPath(b.segments[len(b.segments)-1]))
		// If the cursor points before the oldest surviving segment (evicted
		// while down), snap it forward.
		if b.readSeg < b.segments[0] {
			b.readSeg = b.segments[0]
			b.readIdx = 0
		}
	}
	return b, nil
}

func (b *Buffer) segPath(n int) string {
	return filepath.Join(b.dir, fmt.Sprintf("segment-%09d.jsonl", n))
}

func countLines(path string) int {
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		n++
	}
	return n
}

// Append stores one sample, assigning the next monotonic sequence number,
// and returns the stored entry. Eviction of over-horizon segments happens
// here.
func (b *Buffer) Append(ts time.Time, measurements map[string]float64) (Entry, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	e := Entry{Ts: ts.UTC(), Seq: b.seq, Measurements: measurements}
	raw, err := json.Marshal(e)
	if err != nil {
		return Entry{}, err
	}

	tail := b.segments[len(b.segments)-1]
	if b.tailN >= segmentEntries {
		if b.writer != nil {
			b.writer.Close()
			b.writer = nil
		}
		tail++
		b.segments = append(b.segments, tail)
		b.tailN = 0
	}
	if b.writer == nil {
		f, err := os.OpenFile(b.segPath(tail), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return Entry{}, err
		}
		b.writer = f
	}
	if _, err := b.writer.Write(append(raw, '\n')); err != nil {
		return Entry{}, err
	}
	b.tailN++
	b.seq++
	// The reader may be sitting in the tail segment we just extended; drop the
	// stale cache so Next re-reads the new entry.
	if b.cacheSeg == tail {
		b.cacheSeg = -1
		b.cacheEntries = nil
	}
	if err := b.saveCursorLocked(); err != nil {
		return Entry{}, err
	}
	b.evictLocked()
	return e, nil
}

// evictLocked drops whole OLDEST segments whose newest entry is older than
// the retention horizon. The tail segment is never dropped. The horizon is
// computed from the core's WALL CLOCK (time.Now), never from an incoming
// sample's timestamp: a misconfigured Layer-1 clock stamping far-future
// timestamps must not jump the horizon forward and drop still-unpublished
// telemetry.
func (b *Buffer) evictLocked() {
	horizon := time.Now().UTC().Add(-b.retention)
	for len(b.segments) > 1 {
		oldest := b.segments[0]
		last, ok := lastEntry(b.segPath(oldest))
		if ok && !last.Ts.Before(horizon) {
			// Newest entry is still within the horizon; keep it and everything
			// newer.
			return
		}
		// Either the segment is over-horizon, or its last entry is unreadable
		// (empty/corrupt): drop it either way so eviction can't stall behind a
		// bad segment and let the buffer grow unbounded.
		if err := os.Remove(b.segPath(oldest)); err != nil {
			slog.Warn("buffer eviction failed", "segment", oldest, "err", err)
			return
		}
		if ok {
			slog.Info("buffer evicted oldest segment (retention horizon passed)",
				"segment", oldest, "newest_entry_ts", last.Ts, "retention", b.retention)
		} else {
			slog.Warn("buffer dropped unreadable oldest segment", "segment", oldest)
		}
		b.segments = b.segments[1:]
		if b.readSeg < b.segments[0] {
			// The read cursor was still inside the dropped segment: these
			// entries were never published - real data loss.
			b.lostData = true
			slog.Warn("buffer dropped un-published telemetry (outage exceeded retention horizon)",
				"segment", oldest, "retention", b.retention)
			b.readSeg = b.segments[0]
			b.readIdx = 0
			_ = b.saveCursorLocked()
		}
	}
}

func lastEntry(path string) (Entry, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Entry{}, false
	}
	defer f.Close()
	var lastLine string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if len(sc.Bytes()) > 0 {
			lastLine = sc.Text()
		}
	}
	if lastLine == "" {
		return Entry{}, false
	}
	var e Entry
	if json.Unmarshal([]byte(lastLine), &e) != nil {
		return Entry{}, false
	}
	return e, true
}

// Next returns the oldest un-acked entry, or ok=false when the buffer is
// fully drained. It does NOT advance the cursor - call Ack after the cloud
// confirmed the publish.
func (b *Buffer) Next() (Entry, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for {
		if b.cacheSeg != b.readSeg {
			entries, err := readSegment(b.segPath(b.readSeg))
			if err != nil {
				return Entry{}, false
			}
			b.cacheSeg = b.readSeg
			b.cacheEntries = entries
			b.parseCount++
		}
		if b.readIdx < len(b.cacheEntries) {
			return b.cacheEntries[b.readIdx], true
		}
		// Segment drained; move to the next one if it exists.
		next := -1
		for _, n := range b.segments {
			if n > b.readSeg {
				next = n
				break
			}
		}
		if next == -1 {
			return Entry{}, false
		}
		b.readSeg = next
		b.readIdx = 0
		// cacheSeg != readSeg now, so the next loop iteration re-reads.
	}
}

// Ack advances the cursor past the entry last returned by Next and persists
// the position. Once the backlog fully drains, any prior data-loss warning is
// cleared (the outage is over and the buffer is healthy again).
func (b *Buffer) Ack() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.readIdx++
	if b.lostData && b.pendingLocked() == 0 {
		// State change worth persisting immediately (and rare).
		b.lostData = false
		return b.saveCursorLocked()
	}
	// Persist the cursor only periodically: a redelivery of the last few acked
	// entries is a harmless no-op on the idempotent writer, so we trade a bit of
	// replay-on-crash for far fewer syscalls during a large backlog drain.
	b.acksSinceSave++
	if b.acksSinceSave >= cursorSaveInterval {
		return b.saveCursorLocked()
	}
	return nil
}

// Pending returns the number of entries buffered but not yet acked.
func (b *Buffer) Pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pendingLocked()
}

func (b *Buffer) pendingLocked() int {
	total := 0
	for _, n := range b.segments {
		if n < b.readSeg {
			continue
		}
		c := countLines(b.segPath(n))
		if n == b.readSeg {
			c -= b.readIdx
			if c < 0 {
				c = 0
			}
		}
		total += c
	}
	return total
}

// DataLoss reports whether the buffer is currently discarding un-published
// telemetry because a long outage overran the retention horizon. It clears once
// the backlog drains again (see Ack).
func (b *Buffer) DataLoss() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.lostData
}

// PurgeThrough drops every buffered entry observed AT or BEFORE t - the
// device-local half of a data purge ("Datenaufzeichnungen löschen", contract
// docs/contracts/mqtt-data-purge.schema.json): after the cloud deleted the
// device's history, replaying old buffered samples must not resurrect it.
// Entries observed AFTER t (recorded after the purge instant) survive with
// their original sequence numbers and replay normally; already-acked entries
// are discarded outright (they only await eviction anyway). The sequence
// counter keeps counting monotonically. Returns how many un-published entries
// were dropped. Idempotent - purging an empty buffer is a no-op.
func (b *Buffer) PurgeThrough(t time.Time) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Collect the un-acked survivors (observed after t), oldest-first.
	var survivors []Entry
	dropped := 0
	for _, n := range b.segments {
		if n < b.readSeg {
			continue
		}
		entries, err := readSegment(b.segPath(n))
		if err != nil {
			return 0, err
		}
		if n == b.readSeg && b.readIdx <= len(entries) {
			entries = entries[b.readIdx:]
		}
		for _, e := range entries {
			if e.Ts.After(t) {
				survivors = append(survivors, e)
			} else {
				dropped++
			}
		}
	}

	// Wipe the ring and rebuild it from the survivors alone.
	if b.writer != nil {
		b.writer.Close()
		b.writer = nil
	}
	for _, n := range b.segments {
		if err := os.Remove(b.segPath(n)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	b.segments = []int{0}
	b.tailN = 0
	b.readSeg = 0
	b.readIdx = 0
	b.cacheSeg = -1
	b.cacheEntries = nil
	b.lostData = false
	if len(survivors) > 0 {
		f, err := os.OpenFile(b.segPath(0), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return 0, err
		}
		w := bufio.NewWriter(f)
		for _, e := range survivors {
			raw, err := json.Marshal(e)
			if err != nil {
				f.Close()
				return 0, err
			}
			if _, err := w.Write(append(raw, '\n')); err != nil {
				f.Close()
				return 0, err
			}
		}
		if err := w.Flush(); err != nil {
			f.Close()
			return 0, err
		}
		if err := f.Close(); err != nil {
			return 0, err
		}
		b.tailN = len(survivors)
	}
	if err := b.saveCursorLocked(); err != nil {
		return 0, err
	}
	slog.Info("buffer purged", "dropped", dropped, "kept", len(survivors), "through", t.UTC())
	return dropped, nil
}

func readSegment(path string) ([]Entry, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Entry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		if len(sc.Bytes()) == 0 {
			continue
		}
		var e Entry
		if json.Unmarshal(sc.Bytes(), &e) == nil {
			out = append(out, e)
		}
	}
	return out, nil
}

func (b *Buffer) saveCursorLocked() error {
	b.acksSinceSave = 0
	raw, err := json.Marshal(cursor{ReadSeg: b.readSeg, ReadIdx: b.readIdx, Seq: b.seq})
	if err != nil {
		return err
	}
	tmp := filepath.Join(b.dir, "cursor.json.tmp")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(b.dir, "cursor.json"))
}

// Close flushes the read cursor (see cursorSaveInterval) and releases the
// append handle.
func (b *Buffer) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	cursorErr := b.saveCursorLocked()
	var writerErr error
	if b.writer != nil {
		writerErr = b.writer.Close()
		b.writer = nil
	}
	if writerErr != nil {
		return writerErr
	}
	return cursorErr
}
