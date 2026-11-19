package layer1

import (
	"encoding/json"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/localbus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/solarmanv5"
)

// The Modbus data mirror (edge-app/MODBUS-SPIEGEL.md) on Edge Light: the Go
// twin of the Deye tab's mirror nodes behind the same local-bus pair -
//
//   - edge/registers/want (retained, core -> Layer 1): the mirror's learned
//     want set; the poll appends AT MOST ONE of its blocks per cycle
//     (round-robin, after the primary blocks, in the same logger session) -
//     the router's merge in build-flows.js
//   - edge/registers/raw (retained, Layer 1 -> core): the raw blocks the poll
//     read this cycle, byte-faithful ("Registerbloecke -> Datenspiegel"); the
//     core's mirror serves them to the house network, and reads the Deye's own
//     feed-in limit out of them (agent.onRegistersRaw)
//
// A consumer of the mirror never touches the logger: everything it gets rode
// along in the poll the box makes anyway.

// The router's caps on the want set (defense in depth on top of the core's
// own): at most 8 blocks considered, each at most 64 registers, and the
// control window 1100-1121 is never polled.
const (
	spiegelMaxBloecke  = 8
	spiegelMaxAnzahl   = 64
	spiegelSteuerVon   = 1100
	spiegelSteuerBis   = 1121
	exportLimitAbstand = 24 * time.Hour // EXPORT_LIMIT_INTERVAL_MS
)

type spiegelBlock struct {
	start, count int
}

// onRegistersWant takes the retained want set (vp-register-want parse():
// structure only; an empty payload clears it).
func (r *Runtime) onRegistersWant(_ string, payload []byte) {
	var blocks []spiegelBlock
	if len(payload) > 0 {
		var doc struct {
			Blocks []map[string]any `json:"blocks"`
		}
		if json.Unmarshal(payload, &doc) != nil || doc.Blocks == nil {
			r.log.Warn("edge/registers/want: unbrauchbare Wunschliste verworfen")
			return
		}
		for _, b := range doc.Blocks {
			start, ok1 := b["start"].(float64)
			count, ok2 := b["count"].(float64)
			if !ok1 || !ok2 || start != float64(int(start)) || count != float64(int(count)) ||
				start < 0 || start > 0xffff || count < 1 || start+count > 0x10000 {
				continue
			}
			blocks = append(blocks, spiegelBlock{start: int(start), count: int(count)})
		}
	}
	r.spiegelMu.Lock()
	r.spiegelWant = blocks
	if len(blocks) == 0 {
		r.spiegelRR = 0
	}
	r.spiegelMu.Unlock()
	r.log.Info("Datenspiegel: Wunschliste uebernommen", "bloecke", len(blocks))
}

// gelernterBlock is the ONE learned block of this cycle, or nil.
func (r *Runtime) gelernterBlock() *spiegelBlock {
	r.spiegelMu.Lock()
	defer r.spiegelMu.Unlock()
	var ok []spiegelBlock
	for _, b := range r.spiegelWant {
		if len(ok) >= spiegelMaxBloecke {
			break
		}
		if b.start <= spiegelSteuerBis && b.start+b.count-1 >= spiegelSteuerVon {
			continue
		}
		ok = append(ok, spiegelBlock{start: b.start, count: min(b.count, spiegelMaxAnzahl)})
	}
	if len(ok) == 0 {
		return nil
	}
	i := r.spiegelRR % len(ok)
	r.spiegelRR = i + 1
	return &ok[i]
}

// exportLimitFaellig is the router's daily export-limit read: the family's own
// feed-in-cap register (inverter.ExportLimitRegisterFor), at most once per 24 h
// per logger. The time is taken at the ATTEMPT - a failure is tried again
// tomorrow, and the surface says "unknown" until then.
func (r *Runtime) exportLimitFaellig(family, addr string, now time.Time) (uint16, bool) {
	reg, ok := inverter.ExportLimitRegisterFor(family)
	if !ok {
		return 0, false
	}
	r.spiegelMu.Lock()
	defer r.spiegelMu.Unlock()
	last, seen := r.exportLimitAt[addr]
	if seen && !now.Before(last) && now.Sub(last) < exportLimitAbstand {
		return 0, false
	}
	r.exportLimitAt[addr] = now
	return uint16(reg.Addr), true
}

// solarmanLeseplan is the poll's read plan for this cycle: the family's blocks,
// the daily export-limit register when due, and at most one learned block.
//
// The learned block goes LAST and is optional (it never fails the poll). The
// flow appends the export-limit read after it; here it goes before, because a
// learned block that times out ends the Go session (a late reply would be read
// as the next block's answer) and must not cost the export-limit read.
func (r *Runtime) solarmanLeseplan(p *solarmanPlan, now time.Time) (reads []solarmanv5.ReadSpec, learned int) {
	reads = append([]solarmanv5.ReadSpec(nil), p.Reads...)
	if reg, ok := r.exportLimitFaellig(p.Decode.Family, p.Addr, now); ok {
		reads = append(reads, solarmanv5.ReadSpec{Start: reg, Count: 1})
	}
	learned = -1
	if b := r.gelernterBlock(); b != nil {
		learned = len(reads)
		reads = append(reads, solarmanv5.ReadSpec{Start: uint16(b.start), Count: uint16(b.count), Optional: true})
	}
	return reads, learned
}

// rawBlock is one block on edge/registers/raw.
type rawBlock struct {
	Start   int      `json:"start"`
	Regs    []uint16 `json:"regs"`
	Learned bool     `json:"learned,omitempty"`
	Count   int      `json:"count,omitempty"`
	Error   string   `json:"error,omitempty"`
}

// publishRaw sends the blocks of one successful poll retained: optional and
// learned blocks carry their count, a failed one its error and no words. ts
// is the POLL time - the mirror's staleness guard keys on it.
func (r *Runtime) publishRaw(p *solarmanPlan, reads []solarmanv5.ReadSpec, learned int, blocks []solarmanv5.Block, now time.Time) {
	out := make([]rawBlock, 0, len(blocks))
	for i, b := range blocks {
		rb := rawBlock{Start: int(b.Start), Regs: b.Regs}
		if rb.Regs == nil {
			rb.Regs = []uint16{}
		}
		if i < len(reads) && reads[i].Optional {
			rb.Count = int(reads[i].Count)
			rb.Learned = i == learned
			if b.Err != nil {
				rb.Regs, rb.Error = []uint16{}, b.Err.Error()
			}
		}
		out = append(out, rb)
	}
	unit := int(p.Slave)
	if unit == 0 {
		unit = 1
	}
	raw, _ := json.Marshal(struct {
		Ts     string     `json:"ts"`
		Unit   int        `json:"unit"`
		Blocks []rawBlock `json:"blocks"`
	}{isoMillis(now), unit, out})
	if err := r.bus.Publish(localbus.TopicRegistersRaw, raw, true); err != nil {
		r.log.Warn("Rohregister nicht auf den lokalen Bus", "err", err)
	}
}
