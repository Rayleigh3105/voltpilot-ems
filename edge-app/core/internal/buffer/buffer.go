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
	b := &Buffer{dir: dir, retention: retention}

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
	if err := b.saveCursorLocked(); err != nil {
		return Entry{}, err
	}
	b.evictLocked(ts)
	return e, nil
}

// evictLocked drops whole OLDEST segments whose newest entry is older than
// the retention horizon. The tail segment is never dropped.
func (b *Buffer) evictLocked(now time.Time) {
	horizon := now.Add(-b.retention)
	for len(b.segments) > 1 {
		oldest := b.segments[0]
		last, ok := lastEntry(b.segPath(oldest))
		if !ok || !last.Ts.Before(horizon) {
			return
		}
		if err := os.Remove(b.segPath(oldest)); err != nil {
			slog.Warn("buffer eviction failed", "segment", oldest, "err", err)
			return
		}
		slog.Info("buffer evicted oldest segment (retention horizon passed)",
			"segment", oldest, "newest_entry_ts", last.Ts, "retention", b.retention)
		b.segments = b.segments[1:]
		if b.readSeg < b.segments[0] {
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
		entries, err := readSegment(b.segPath(b.readSeg))
		if err != nil {
			return Entry{}, false
		}
		if b.readIdx < len(entries) {
			return entries[b.readIdx], true
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
	}
}

// Ack advances the cursor past the entry last returned by Next and persists
// the position.
func (b *Buffer) Ack() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.readIdx++
	return b.saveCursorLocked()
}

// Pending returns the number of entries buffered but not yet acked.
func (b *Buffer) Pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
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

// Close releases the append handle.
func (b *Buffer) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.writer != nil {
		err := b.writer.Close()
		b.writer = nil
		return err
	}
	return nil
}
