package mirror

import (
	"sort"
	"time"
)

// Auto-learn caps. The worst-case load the learned set can put on the
// Solarman socket is bounded by construction: the Node-RED poll reads at most
// ONE learned block (≤ MaxLearnedBlockSize registers = one FC3 round trip)
// per 5-s cycle, round-robin over at most MaxLearnedBlocks blocks, AFTER the
// primary blocks, inside the same sv5 lock that always yields to control
// writes - so consumer behavior can never widen the socket occupancy beyond
// that one extra round trip per cycle.
const (
	// MaxLearnedBlocks bounds the learned want set (LRU-evicted beyond it).
	MaxLearnedBlocks = 8
	// MaxLearnedBlockSize bounds one learned block; wider consumer reads are
	// split. 64 registers keep the extra FC3 round trip small and let the 8
	// blocks cover up to 512 scattered registers.
	MaxLearnedBlockSize = 64
	// ControlRegFirst/Last is the Deye remote-mode control window (registers
	// 1100-1121, 0x044C-0x0461). It is READABLE on the mirror - served from
	// the control readbacks our write path already reads every ~10 s - but it
	// must NEVER enter the learned want set: the mirror adds no poll traffic
	// for it, and a consumer can never make our poll touch the dead-man
	// watchdog block.
	ControlRegFirst = 1100
	ControlRegLast  = 1121
)

func overlapsControlWindow(start, count int) bool {
	return start <= ControlRegLast && start+count-1 >= ControlRegFirst
}

// learnedBlock is one auto-learned register range with its LRU timestamp.
type learnedBlock struct {
	Block
	lastAsk time.Time
}

// learner tracks which uncached register ranges consumers asked for. It
// coalesces adjacent/overlapping wants into blocks (merged span ≤
// MaxLearnedBlockSize), caps the set at MaxLearnedBlocks and LRU-evicts what
// stops being asked. Not concurrency-safe - the Server serializes access.
type learner struct {
	blocks []learnedBlock
}

// note records a consumer want for [start, start+count). Ranges overlapping
// the control window are trimmed around it (the window itself is never
// learned); ranges wider than MaxLearnedBlockSize are split. Returns true
// when the learned set changed (the caller persists + republishes it then).
func (l *learner) note(start, count int, now time.Time) bool {
	changed := false
	for _, part := range splitAroundControlWindow(start, count) {
		for s := part.Start; s < part.End(); s += MaxLearnedBlockSize {
			c := part.End() - s
			if c > MaxLearnedBlockSize {
				c = MaxLearnedBlockSize
			}
			if l.noteOne(s, c, now) {
				changed = true
			}
		}
	}
	return changed
}

// splitAroundControlWindow removes the control window from a want range.
func splitAroundControlWindow(start, count int) []Block {
	if !overlapsControlWindow(start, count) {
		return []Block{{Start: start, Count: count}}
	}
	var out []Block
	if start < ControlRegFirst {
		out = append(out, Block{Start: start, Count: ControlRegFirst - start})
	}
	if end := start + count; end > ControlRegLast+1 {
		out = append(out, Block{Start: ControlRegLast + 1, Count: end - (ControlRegLast + 1)})
	}
	return out
}

func (l *learner) noteOne(start, count int, now time.Time) bool {
	// Already fully covered by an existing block: just refresh its LRU stamp.
	for i := range l.blocks {
		b := &l.blocks[i]
		if start >= b.Start && start+count <= b.End() {
			b.lastAsk = now
			return false
		}
	}
	// Merge with a block when the combined span stays within the size cap -
	// that packs a consumer's scattered single-register reads (the typical
	// Loxone sensor tree) into few contiguous blocks instead of thrashing the
	// block cap.
	for i := range l.blocks {
		b := &l.blocks[i]
		lo := min(b.Start, start)
		hi := max(b.End(), start+count)
		// Never merge into a span that would cover the control window (the two
		// flanks of a straddling read must stay separate blocks).
		if hi-lo <= MaxLearnedBlockSize && !overlapsControlWindow(lo, hi-lo) {
			if b.Start != lo || b.End() != hi {
				b.Start = lo
				b.Count = hi - lo
				b.lastAsk = now
				l.compact(now)
				return true
			}
		}
	}
	l.blocks = append(l.blocks, learnedBlock{Block: Block{Start: start, Count: count}, lastAsk: now})
	// Over the cap: evict the least-recently-asked block.
	for len(l.blocks) > MaxLearnedBlocks {
		oldest := 0
		for i := range l.blocks {
			if l.blocks[i].lastAsk.Before(l.blocks[oldest].lastAsk) {
				oldest = i
			}
		}
		l.blocks = append(l.blocks[:oldest], l.blocks[oldest+1:]...)
	}
	return true
}

// compact re-merges blocks that grew into each other after a merge.
func (l *learner) compact(now time.Time) {
	sort.Slice(l.blocks, func(i, j int) bool { return l.blocks[i].Start < l.blocks[j].Start })
	out := l.blocks[:0]
	for _, b := range l.blocks {
		if n := len(out); n > 0 {
			prev := &out[n-1]
			if b.Start <= prev.End() && max(prev.End(), b.End())-prev.Start <= MaxLearnedBlockSize {
				if b.End() > prev.End() {
					prev.Count = b.End() - prev.Start
				}
				if b.lastAsk.After(prev.lastAsk) {
					prev.lastAsk = b.lastAsk
				}
				continue
			}
		}
		out = append(out, b)
	}
	l.blocks = out
}

// touch refreshes the LRU stamp of every learned block overlapping the served
// range, so blocks a consumer keeps reading are never evicted.
func (l *learner) touch(start, count int, now time.Time) {
	for i := range l.blocks {
		b := &l.blocks[i]
		if b.Start <= start+count-1 && b.End()-1 >= start {
			b.lastAsk = now
		}
	}
}

// drop removes every learned block overlapping [start, start+count).
// Returns true when the set changed.
func (l *learner) drop(start, count int) bool {
	out := l.blocks[:0]
	changed := false
	for _, b := range l.blocks {
		if b.Start <= start+count-1 && b.End()-1 >= start {
			changed = true
			continue
		}
		out = append(out, b)
	}
	l.blocks = out
	return changed
}

// set replaces the learned set (used to seed from persisted settings).
func (l *learner) set(blocks []Block, now time.Time) {
	l.blocks = l.blocks[:0]
	for _, b := range blocks {
		l.blocks = append(l.blocks, learnedBlock{Block: b, lastAsk: now})
	}
}

// list returns the learned blocks in address order (stable for publish +
// persist).
func (l *learner) list() []Block {
	out := make([]Block, 0, len(l.blocks))
	for _, b := range l.blocks {
		out = append(out, b.Block)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}
