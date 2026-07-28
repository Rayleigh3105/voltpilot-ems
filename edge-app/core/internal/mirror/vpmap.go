package mirror

import (
	"math"
	"time"
)

// The VoltPilot standard map (unit ID 100): a FROZEN, brand-agnostic register
// image sourced from the gated composite channels every plant has - the same
// numbers the local dashboard and the cloud see. Growth is additive-only
// (append registers, bump the schema version); existing registers never move.
//
//	Addr  Register                Type  Notes
//	 0    map magic 0x5650 ("VP") u16   consumer sanity check
//	 1    schema version = 1     u16   frozen; additive-only growth
//	 2    data age, seconds      u16   0xFFFF = no data yet
//	 3    quality                u16   0 = ok, 1 = stale, 2 = no data
//	 4-5  PV power, W            s32   >= 0
//	 6-7  house load, W          s32   the standard house consumption
//	 8-9  grid power, W          s32   + import / - export
//	10-11 battery power, W       s32   + charge / - discharge
//	12    SoC, 0.1 %             u16   0xFFFF absent
//	13-14 grid limit (§14a), W   s32   absent unless reported
//
// Absent channels carry SunSpec-style not-implemented sentinels
// (0x8000_0000 for s32, 0xFFFF for u16) - never a fabricated 0. Staleness is
// surfaced IN the map (age + quality registers) instead of failing the read,
// so a consumer can see freshness without special handling.
const (
	// VPUnit is the Modbus unit ID of the VoltPilot standard map.
	VPUnit = 100
	// VPMapSize is the number of registers in schema v1 (addresses 0..14).
	VPMapSize = 15

	vpMagic   = 0x5650 // "VP"
	vpVersion = 1

	// Quality register values.
	vpQualityOK     = 0
	vpQualityStale  = 1
	vpQualityNoData = 2

	// Not-implemented sentinels (SunSpec convention).
	sentinelU16 = 0xFFFF
	sentinelS32 = int32(math.MinInt32) // 0x8000_0000
)

// Composite is the gated composite site reading feeding the VP map. A nil
// channel is ABSENT (encoded as its sentinel), never coerced to 0.
type Composite struct {
	PvKw        *float64
	LoadKw      *float64
	GridKw      *float64
	BattKw      *float64
	SocPct      *float64
	GridLimitKw *float64
}

// vpImage renders the 15-register VP map from the composite reading. ts is
// the reading's observation time (zero = no data yet).
func vpImage(c Composite, ts time.Time, staleAfter time.Duration, now time.Time) [VPMapSize]uint16 {
	var img [VPMapSize]uint16
	img[0] = vpMagic
	img[1] = vpVersion

	if ts.IsZero() {
		img[2] = sentinelU16
		img[3] = vpQualityNoData
	} else {
		age := now.Sub(ts)
		if age < 0 {
			age = 0
		}
		secs := int64(age / time.Second)
		if secs >= sentinelU16 {
			secs = sentinelU16 - 1
		}
		img[2] = uint16(secs)
		if age > staleAfter {
			img[3] = vpQualityStale
		} else {
			img[3] = vpQualityOK
		}
	}

	putS32 := func(addr int, kw *float64) {
		v := sentinelS32
		if kw != nil && !math.IsNaN(*kw) && !math.IsInf(*kw, 0) {
			w := math.Round(*kw * 1000)
			// Clamp into the s32 value range, keeping clear of the sentinel.
			if w > math.MaxInt32 {
				w = math.MaxInt32
			}
			if w < math.MinInt32+1 {
				w = math.MinInt32 + 1
			}
			v = int32(w)
		}
		u := uint32(v)
		img[addr] = uint16(u >> 16)
		img[addr+1] = uint16(u)
	}
	putS32(4, c.PvKw)
	putS32(6, c.LoadKw)
	putS32(8, c.GridKw)
	putS32(10, c.BattKw)

	img[12] = sentinelU16
	if c.SocPct != nil && !math.IsNaN(*c.SocPct) && !math.IsInf(*c.SocPct, 0) {
		soc := math.Round(*c.SocPct * 10)
		if soc < 0 {
			soc = 0
		}
		if soc > 1000 {
			soc = 1000
		}
		img[12] = uint16(soc)
	}
	putS32(13, c.GridLimitKw)
	return img
}
