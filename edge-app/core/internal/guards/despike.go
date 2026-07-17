package guards

import (
	"math"
	"sync"
	"time"
)

// Despiker rejects transient garbage that the in-band plausibility gates cannot
// catch: the captain's real symptom is a channel momentarily reading e.g. 2 %
// (SoC) between two steady 94 % samples and then snapping straight back, or a
// power channel briefly reading an impossible value and reverting. Those jumps
// are physically implausible yet sit INSIDE the valid band, so the plausibility
// gates pass them. The despiker sits at the core's single local-bus ingest
// choke point (agent.onLocalTelemetry), so a gated value never reaches ANY
// downstream consumer unfiltered - dashboard tiles / energy flow (state
// snapshot), the live-chart ring (history), the cloud (store-and-forward buffer
// + status heartbeat) or the setpoint guards - regardless of which Layer-1 flow
// produced the read.
//
// # Hold-last output (continuous line, no gaps)
//
// When a channel value is rejected as a spike the despiker does NOT delete it:
// it REPLACES it with the last accepted value for that channel (in place), so
// every recorded series stays a continuous line with no holes (the captain's
// explicit requirement). There is still NO smoothing or interpolation - the
// substitute is exactly the last good reading, held flat until a real reading
// resumes or a genuinely new level is confirmed. Every gate decision is also
// reported (per-channel Drop + counters) so the operator can see the filter
// working.
//
// # One model, per-channel tuning (operator-configurable)
//
// Every gated channel uses the same rate model: a reading is "suspect" when it
// jumps more than margin + maxRatePerSec*elapsed away from the last accepted
// value. The numbers are tuned per channel and set by the operator on the
// device (see DespikeSettings / settings.go):
//
//   - SoC is integrative and cannot step fast -> a tight %-Punkte/s bound.
//   - Power channels CAN legitimately step fast (a cloud edge, a load switching
//     on) -> a generous kW/s bound, so genuine dynamics pass immediately and
//     only larger, reverting excursions are treated as suspect. A missed power
//     spike is cosmetic; a suppressed real transient is a bug, so the defaults
//     err generous and the operator tightens ("Streng") if needed.
//
// A disabled channel is never gated (its value always passes through raw).
//
// # Accept-after-confirmation (no deadlock, no lookahead)
//
// A suspect jump is dropped (held-last) but remembered as a candidate level. If
// confirmCount consecutive readings agree with that candidate, the new level is
// adopted - so a genuinely new level (a resynced BMS, a real §14a envelope
// change, a real fast power step larger than the envelope) converges instead of
// holding the stale level forever. The earlier readings that established the
// candidate stay held-last (drop-never-alter); only from the confirming sample
// on does the channel track the new level. This needs no lookahead: each sample
// is decided when it arrives.
//
// # Long gaps / reboots
//
// If the gap since the last accepted sample exceeds gapReset, the gate resets
// for that channel and accepts the reading as a fresh baseline. A device that
// reboots after hours therefore never false-rejects its first post-reboot read.
type Despiker struct {
	mu      sync.Mutex
	preset  string
	params  map[string]channelParams
	states  map[string]*channelState
	dropped int
	byChan  map[string]int
}

// Drop records one rejected channel value (for rate-limited diagnostics). Held
// is the last-good value substituted in its place.
type Drop struct {
	Channel string
	Value   float64
	Held    float64
}

type channelParams struct {
	enabled bool

	// suspect when |delta| > margin + maxRatePerSec*elapsedSeconds.
	maxRatePerSec float64
	margin        float64

	// consecutive agreeing readings needed to adopt a new level, and the gap
	// beyond which the gate resets to a fresh baseline (shared across channels).
	confirmCount int
	gapReset     time.Duration
}

// Tuning constants shared by every channel (the per-channel rate/margin come
// from the operator-set DespikeSettings).
const (
	// despikeConfirmCount: after this many consecutive agreeing readings a new
	// level is adopted (the earlier ones stay held-last).
	despikeConfirmCount = 3
	// despikeGapReset: beyond this gap the gate accepts a fresh baseline
	// (reboot / long outage), so it never false-rejects after a long silence.
	despikeGapReset = 5 * time.Minute
)

type channelState struct {
	haveLast bool
	last     float64
	lastTime time.Time

	haveCand  bool
	cand      float64
	candTime  time.Time
	candCount int
}

// NewDespiker builds a despiker with the built-in default settings.
func NewDespiker() *Despiker {
	return NewDespikerWithSettings(DefaultSettings())
}

// NewDespikerWithSettings builds a despiker with the given operator settings.
func NewDespikerWithSettings(cfg DespikeSettings) *Despiker {
	d := &Despiker{
		states: map[string]*channelState{},
		byChan: map[string]int{},
	}
	d.apply(cfg)
	return d
}

// Reconfigure applies new operator settings live (no restart). The per-channel
// running state is preserved, so continuity is not broken by a settings change;
// only the thresholds change from the next sample on.
func (d *Despiker) Reconfigure(cfg DespikeSettings) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.apply(cfg)
}

// apply installs settings into the params map. Caller holds the lock (or is the
// constructor before publication).
func (d *Despiker) apply(cfg DespikeSettings) {
	d.preset = cfg.Preset
	params := make(map[string]channelParams, len(GatedChannels))
	for _, meta := range GatedChannels {
		cs := cfg.Channels[meta.Key]
		params[meta.Key] = channelParams{
			enabled:       cs.Enabled,
			maxRatePerSec: cs.MaxRatePerSec,
			margin:        cs.Margin,
			confirmCount:  despikeConfirmCount,
			gapReset:      despikeGapReset,
		}
	}
	d.params = params
}

// Settings returns the current effective configuration (for the settings API).
func (d *Despiker) Settings() DespikeSettings {
	d.mu.Lock()
	defer d.mu.Unlock()
	channels := make(map[string]ChannelSetting, len(d.params))
	for k, p := range d.params {
		channels[k] = ChannelSetting{Enabled: p.enabled, MaxRatePerSec: p.maxRatePerSec, Margin: p.margin}
	}
	return DespikeSettings{Preset: d.preset, Channels: channels}
}

// Status returns the full settings surface (current config + per-channel
// counters + channel/preset metadata) for the settings API.
func (d *Despiker) Status() DespikeStatus {
	return DespikeStatus{
		Settings: d.Settings(),
		Counters: d.DroppedByChannel(),
		Channels: GatedChannels,
		Presets:  PresetNames,
	}
}

// Accept filters a measurement map IN PLACE at observation time now: any channel
// whose value is a rejected spike is REPLACED with that channel's last accepted
// value (hold-last: the series stays a continuous line, no gaps), and the
// rejected channels are returned (for rate-limited logging by the caller). A
// channel with no configured/enabled gate is always kept as-is. Rejections are
// counted per channel and in the running total (see DroppedTotal / DroppedByChannel).
func (d *Despiker) Accept(m map[string]float64, now time.Time) []Drop {
	d.mu.Lock()
	defer d.mu.Unlock()
	var drops []Drop
	for _, meta := range GatedChannels {
		key := meta.Key
		v, ok := m[key]
		if !ok {
			continue
		}
		p := d.params[key]
		if !p.enabled {
			continue
		}
		cs := d.states[key]
		if cs == nil {
			cs = &channelState{}
			d.states[key] = cs
		}
		if !d.acceptChannel(cs, p, v, now) {
			m[key] = cs.last // hold-last: substitute the last accepted value
			d.dropped++
			d.byChan[key]++
			drops = append(drops, Drop{Channel: key, Value: v, Held: cs.last})
		}
	}
	return drops
}

// ResetChannels forgets the accepted level + confirmation candidate of the
// given channels, so the NEXT reading baseline-accepts. Called when a channel's
// composition changed for an EXPLAINED reason (a multi-source Erzeuger/Netz
// contribution appeared or disappeared): the resulting step is configuration,
// not a device spike, and holding it - or letting an oscillating composition
// keep restarting the candidate - would freeze the displayed value.
func (d *Despiker) ResetChannels(keys ...string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, k := range keys {
		delete(d.states, k)
	}
}

// DroppedTotal is the running count of samples the despiker has rejected since
// start (cheap, exposed in the state snapshot for field diagnosis).
func (d *Despiker) DroppedTotal() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.dropped
}

// DroppedByChannel returns a copy of the per-channel rejection counts, so the
// operator can see which channel the filter is actually catching.
func (d *Despiker) DroppedByChannel() map[string]int {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make(map[string]int, len(d.byChan))
	for k, v := range d.byChan {
		out[k] = v
	}
	return out
}

// acceptChannel decides whether cur is a plausible reading for one channel,
// updating that channel's accepted level / confirmation candidate. On a reject
// (return false) cs.last holds the value to substitute.
func (d *Despiker) acceptChannel(cs *channelState, p channelParams, cur float64, now time.Time) bool {
	if !cs.haveLast {
		cs.setLast(cur, now)
		return true
	}
	elapsed := nonNeg(now.Sub(cs.lastTime))
	if elapsed >= p.gapReset {
		// Long gap / reboot: accept a fresh baseline, forget any candidate.
		cs.setLast(cur, now)
		cs.clearCand()
		return true
	}
	if !p.suspect(cs.last, cur, elapsed) {
		// Within the plausible envelope of the last accepted value.
		cs.setLast(cur, now)
		cs.clearCand()
		return true
	}
	// A suspect jump away from the accepted level. Track confirmation: if it
	// agrees with a pending candidate, count it; once confirmCount readings
	// agree, adopt the new level. Otherwise (re)start the candidate and drop.
	if cs.haveCand {
		ce := nonNeg(now.Sub(cs.candTime))
		if ce < p.gapReset && !p.suspect(cs.cand, cur, ce) {
			cs.candCount++
			cs.cand = cur
			cs.candTime = now
			if cs.candCount >= p.confirmCount {
				cs.setLast(cur, now)
				cs.clearCand()
				return true
			}
			return false
		}
	}
	cs.cand = cur
	cs.candTime = now
	cs.candCount = 1
	cs.haveCand = true
	return false
}

func (cs *channelState) setLast(v float64, t time.Time) {
	cs.haveLast = true
	cs.last = v
	cs.lastTime = t
}

func (cs *channelState) clearCand() {
	cs.haveCand = false
	cs.candCount = 0
}

// suspect reports whether cur is an implausible jump away from prev, given the
// elapsed time since prev: the allowed change is margin + maxRatePerSec*elapsed.
func (p channelParams) suspect(prev, cur float64, elapsed time.Duration) bool {
	allowed := p.margin + p.maxRatePerSec*elapsed.Seconds()
	return math.Abs(cur-prev) > allowed
}

func nonNeg(d time.Duration) time.Duration {
	if d < 0 {
		return 0
	}
	return d
}
