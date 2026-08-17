package agent

// „Grenzen & Wächter" Stufe 0 / Vierer #4 - the DEVICE'S OWN feed-in limit.
//
// WHY: at Anlage Herzogau the Deye held an installer cap of 33,0 kW in register
// 0x00E7 while 70 kW were configured in the portal. Nobody looked, so the
// discrepancy survived two investigation rounds (scout vp-herzogau-runde2-m6 §3
// K1 / §7 point 4). Now the box reads that one register - and only reads it.
//
// ⚠ ONE SOCKET LAW, and it is why this file has no I/O at all: the register is
// appended to the Node-RED poll's EXISTING sequential read plan (at most once a
// day, see DEYE_EXPORT_LIMIT in edge-app/nodered/inverter-routing.js) and
// arrives here inside the retained `edge/registers/raw` message the poll already
// publishes for the Modbus mirror. So there is NO new TCP path, NO new local-bus
// topic, NO new palette node and NO extra poll cadence - just one more reader of
// bytes that were already on the bus.

import (
	"log/slog"
	"math"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/inverter"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/mirror"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/state"
)

// noteDeviceExportLimit decodes the device's own feed-in limit out of one raw
// register message, when the poll carried it.
//
// It stays silent (returns nil) in every case where the value cannot be
// TRUSTED, and each of those is an honesty rule rather than defensiveness:
//   - no inverter selected, or a family whose register map has no feed-in cap we
//     may read (the hybrid_1p case: there the register IS our own discharge
//     lever, so reading it back would report OUR command as the device's limit);
//   - the poll did not carry the register in this cycle (the normal case - it
//     rides along at most once a day);
//   - the block reported a read error (a failed read is not a limit of 0).
//
// nil therefore means "we do not know", never "the device has no limit", and the
// previous value is left standing until a real read replaces it.
func (a *Agent) noteDeviceExportLimit(ts time.Time, unit int, blocks []mirror.RawBlock) *state.DeviceExportLimitInfo {
	a.invMu.Lock()
	family := ""
	wantUnit := 1
	if a.inv != nil {
		family = a.inv.Family
		if a.inv.Connection.MbSlaveID > 0 {
			wantUnit = a.inv.Connection.MbSlaveID
		}
	}
	a.invMu.Unlock()

	reg, ok := inverter.ExportLimitRegisterFor(family)
	if !ok {
		return nil
	}
	// A raw message carries its own unit; a block read from ANOTHER slave says
	// nothing about the inverter we selected.
	if unit != 0 && unit != wantUnit {
		return nil
	}
	for _, b := range blocks {
		if b.Err != "" {
			continue // a failed read is not a limit
		}
		idx := reg.Addr - b.Start
		if idx < 0 || idx >= len(b.Regs) {
			continue
		}
		kw := reg.DecodeExportLimitKw(b.Regs[idx])
		if kw < 0 || kw > deviceExportLimitMaxKw {
			// A grid connection point beyond this is a decode defect, not a
			// plant - and the number reaches the customer as a sentence about
			// their inverter.
			slog.Warn("device export limit out of range; ignored",
				"register", reg.Label, "raw", b.Regs[idx], "kw", kw)
			continue
		}
		if ts.IsZero() {
			ts = time.Now().UTC()
		}
		return &state.DeviceExportLimitInfo{
			LimitKw:  math.Round(kw*1000) / 1000,
			Register: reg.Label,
			ReadAt:   ts,
		}
	}
	return nil
}

// deviceExportLimitMaxKw bounds a plausible feed-in limit at a grid connection
// point. Deliberately generous (a large commercial park), but finite: the value
// becomes a customer sentence ("Ihr Wechselrichter begrenzt … auf X kW").
const deviceExportLimitMaxKw = 100_000
