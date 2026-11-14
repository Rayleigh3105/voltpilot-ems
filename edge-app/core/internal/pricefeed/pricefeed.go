// Package pricefeed mirrors the cloud's current-spot-price downlink
// (docs/contracts/v2/mqtt-price-current.md, retained on .../v2/price) onto
// the local bus topic edge/price/current - the named price input of compiled
// customer rules (vp-feed "price_current") and, later, of the rule-language
// core.
//
// The mirror OWNS freshness. A price is current only within its slot plus a
// small publish-latency slack; when that window passes without a fresh cloud
// publish, or the cloud withdraws its retained document, the mirror publishes
// an explicit stale marker {"schema_version":"1.0","stale":true} instead of
// clearing the topic. A cleared retained message would leave the LAST payload
// standing in every subscriber that caches it (vp-feed keeps `last`), and
// silence must never read as "the price still holds" - a rule must stop
// switching on an old price, never keep going.
//
// The dispatch principle of internal/plan stands untouched: the cloud decides
// the battery schedule, and the guards only enforce. This feed exists solely
// so CUSTOMER RULES can evaluate their price conditions on a price the cloud
// delivered - the box still never derives or decides a price itself.
package pricefeed

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"time"
)

// SchemaVersion is the local payload's contract version.
const SchemaVersion = "1.0"

// Slack extends a slot's validity beyond slot_end to absorb publish latency
// of the next slot's price (the cloud publishes at the slot boundary) and
// modest clock skew - the same reasoning as plan.redeliverySlack. Past
// slot_end+Slack the price is UNKNOWN, never "the previous price".
const Slack = 5 * time.Minute

// maxSlotLength bounds a plausible price slot (PT15M or PT60M today); a
// document claiming a longer slot is malformed, not a longer-lasting price.
const maxSlotLength = 2 * time.Hour

// ErrEmpty marks the retained-clear (the cloud withdrew the document).
var ErrEmpty = errors.New("empty price payload")

// Doc is one parsed cloud price document.
type Doc struct {
	SchemaVersion string  `json:"schema_version"`
	TenantID      string  `json:"tenant_id"`
	SiteID        string  `json:"site_id"`
	DeviceID      string  `json:"device_id"`
	GeneratedAt   string  `json:"generated_at"`
	SlotStart     string  `json:"slot_start"`
	SlotEnd       string  `json:"slot_end"`
	PriceCtKwh    float64 `json:"price_ct_kwh"`
	Unit          string  `json:"unit"`
	BiddingZone   string  `json:"bidding_zone"`

	slotStart time.Time
	slotEnd   time.Time
}

// Parse validates one cloud payload. An empty payload returns ErrEmpty (the
// retained-clear); any other violation returns a speaking error and the
// document is dropped - a malformed price is no price.
func Parse(payload []byte) (*Doc, error) {
	if len(payload) == 0 {
		return nil, ErrEmpty
	}
	var d Doc
	if err := json.Unmarshal(payload, &d); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if d.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("unsupported schema_version %q", d.SchemaVersion)
	}
	if math.IsNaN(d.PriceCtKwh) || math.IsInf(d.PriceCtKwh, 0) {
		return nil, errors.New("price_ct_kwh is not a finite number")
	}
	if d.Unit != "ct/kWh" {
		return nil, fmt.Errorf("unsupported unit %q", d.Unit)
	}
	start, err := time.Parse(time.RFC3339, d.SlotStart)
	if err != nil {
		return nil, fmt.Errorf("slot_start: %w", err)
	}
	end, err := time.Parse(time.RFC3339, d.SlotEnd)
	if err != nil {
		return nil, fmt.Errorf("slot_end: %w", err)
	}
	if !end.After(start) || end.Sub(start) > maxSlotLength {
		return nil, fmt.Errorf("implausible slot %s..%s", d.SlotStart, d.SlotEnd)
	}
	d.slotStart = start
	d.slotEnd = end
	return &d, nil
}

// MatchesIdentity is the topic==payload rule of every downlink: a document
// addressed to a foreign identity is silently dropped by the caller.
func (d *Doc) MatchesIdentity(tenantID, siteID, deviceID string) bool {
	return d.TenantID == tenantID && d.SiteID == siteID && d.DeviceID == deviceID
}

// localPayload is what the mirror publishes retained on edge/price/current.
type localPayload struct {
	SchemaVersion string   `json:"schema_version"`
	PriceCtKwh    *float64 `json:"price_ct_kwh,omitempty"`
	Unit          string   `json:"unit,omitempty"`
	SlotStart     string   `json:"slot_start,omitempty"`
	SlotEnd       string   `json:"slot_end,omitempty"`
	ValidUntil    string   `json:"valid_until,omitempty"`
	BiddingZone   string   `json:"bidding_zone,omitempty"`
	Stale         bool     `json:"stale,omitempty"`
}

// Publisher publishes one retained payload on edge/price/current.
type Publisher func(payload []byte) error

// Feed is the mirror: it accepts validated cloud documents and keeps the
// local topic honest (fresh price or explicit stale marker).
type Feed struct {
	publish Publisher
	now     func() time.Time

	mu    sync.Mutex
	timer *time.Timer
	// validUntil of the price currently standing on the local topic; zero
	// while nothing fresh stands there.
	validUntil time.Time
	// staleMarked = the stale marker is the topic's current retained state.
	staleMarked bool
	// price/slotStart of the price standing on the local topic (valid while
	// validUntil is set) - read by the Steuerlogik running along.
	price     float64
	slotStart time.Time
}

// New builds a feed publishing through publish. Nothing is published until
// the first cloud document arrives - an empty topic is the same honest
// "unknown" to every subscriber (vp-feed stays "keine Daten").
func New(publish Publisher) *Feed {
	return &Feed{publish: publish, now: time.Now}
}

// newWithClock is the test seam.
func newWithClock(publish Publisher, now func() time.Time) *Feed {
	return &Feed{publish: publish, now: now}
}

// Accept mirrors one validated cloud document. An already-expired document
// (a broker redelivery of an old retained payload after a long offline
// stretch) publishes the stale marker instead of flashing an old price.
func (f *Feed) Accept(d *Doc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	validUntil := d.slotEnd.Add(Slack)
	now := f.now()
	if !validUntil.After(now) {
		f.markStaleLocked()
		return
	}
	price := d.PriceCtKwh
	raw, err := json.Marshal(localPayload{
		SchemaVersion: SchemaVersion,
		PriceCtKwh:    &price,
		Unit:          "ct/kWh",
		SlotStart:     d.SlotStart,
		SlotEnd:       d.SlotEnd,
		ValidUntil:    validUntil.UTC().Format(time.RFC3339),
		BiddingZone:   d.BiddingZone,
	})
	if err != nil {
		slog.Error("price feed: marshal failed", "err", err)
		return
	}
	if err := f.publish(raw); err != nil {
		slog.Warn("price feed: local publish failed", "err", err)
		return
	}
	f.validUntil = validUntil
	f.price, f.slotStart = price, d.slotStart
	f.staleMarked = false
	f.rearmLocked(validUntil.Sub(now))
}

// Current is the price standing on the local topic and the start of its slot;
// ok=false while no fresh price stands there (never received, expired by the
// clock, or withdrawn) - the same honest "unknown" the topic carries.
func (f *Feed) Current(now time.Time) (ctKwh float64, slotStart time.Time, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.validUntil.IsZero() || !f.validUntil.After(now) {
		return 0, time.Time{}, false
	}
	return f.price, f.slotStart, true
}

// Withdraw handles the cloud's retained-clear: the price is explicitly
// unknown from now on.
func (f *Feed) Withdraw() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.markStaleLocked()
}

// Close stops the watchdog (shutdown only; the topic keeps its last state).
func (f *Feed) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.timer != nil {
		f.timer.Stop()
		f.timer = nil
	}
}

func (f *Feed) rearmLocked(d time.Duration) {
	if f.timer != nil {
		f.timer.Stop()
	}
	f.timer = time.AfterFunc(d, f.expire)
}

func (f *Feed) expire() {
	f.mu.Lock()
	defer f.mu.Unlock()
	// A fresher document may have landed between the timer firing and the
	// lock: then the topic already carries a price that is still valid.
	if f.validUntil.After(f.now()) {
		return
	}
	f.markStaleLocked()
}

func (f *Feed) markStaleLocked() {
	if f.timer != nil {
		f.timer.Stop()
		f.timer = nil
	}
	f.validUntil = time.Time{}
	if f.staleMarked {
		return
	}
	raw, err := json.Marshal(localPayload{SchemaVersion: SchemaVersion, Stale: true})
	if err != nil {
		slog.Error("price feed: marshal of stale marker failed", "err", err)
		return
	}
	if err := f.publish(raw); err != nil {
		slog.Warn("price feed: stale marker publish failed", "err", err)
		return
	}
	f.staleMarked = true
}
