package guards

import "math"

// SoC plausibility gate (drop-don't-fabricate), the core-side twin of the
// canonical Deye decoder gate socPlausible() in
// edge-app/nodered/deye/deye-decode.js (shipped for the "SoC spikes 0/100"
// prod bug): a battery State-of-Charge is physically a (0, 100] % reading - a
// real BMS never reports an exact 0 (it cuts off well above empty), so an
// exact 0 is the degraded-logger "empty answer" signature and anything outside
// the band is a misaligned/garbage frame. The agent applies this at the
// local-bus telemetry ingest, so an implausible read can never be DISPLAYED
// (dashboard tiles, live-chart ring, energy flow), never reaches the cloud
// (telemetry buffer, status heartbeat) and never steers the setpoint guards -
// regardless of which Layer-1 flow produced it (the Deye adapter gates at
// decode already; generic-Modbus or custom flows may not).
//
// The two implementations MUST stay in lockstep; TestSocPlausible pins the
// same vectors as deye-decode.test.js (the refCheckChar/EdgeRef precedent).
const (
	socPctMin = 0   // exclusive: an exact 0 is the empty-answer signature, not a real SoC
	socPctMax = 100 // inclusive: a percentage
)

// SocPlausible reports whether a soc_pct reading is physically possible.
func SocPlausible(pct float64) bool {
	return !math.IsNaN(pct) && !math.IsInf(pct, 0) && pct > socPctMin && pct <= socPctMax
}
