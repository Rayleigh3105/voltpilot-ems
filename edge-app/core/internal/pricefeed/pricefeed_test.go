package pricefeed

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func doc(t *testing.T, slotStart, slotEnd time.Time, price float64) *Doc {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{
		"schema_version": "1.0",
		"tenant_id":      "t1",
		"site_id":        "s1",
		"device_id":      "d1",
		"generated_at":   slotStart.UTC().Format(time.RFC3339),
		"slot_start":     slotStart.UTC().Format(time.RFC3339),
		"slot_end":       slotEnd.UTC().Format(time.RFC3339),
		"price_ct_kwh":   price,
		"unit":           "ct/kWh",
		"bidding_zone":   "DE-LU",
	})
	d, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	return d
}

type capture struct {
	mu       sync.Mutex
	payloads []map[string]any
}

func (c *capture) publish(payload []byte) error {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.payloads = append(c.payloads, m)
	return nil
}

func (c *capture) last(t *testing.T) map[string]any {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.payloads) == 0 {
		t.Fatal("nothing published")
	}
	return c.payloads[len(c.payloads)-1]
}

func (c *capture) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.payloads)
}

func TestParseRejectsMalformed(t *testing.T) {
	cases := map[string]string{
		"empty object":   `{}`,
		"bad version":    `{"schema_version":"9.9","slot_start":"2026-11-14T11:00:00Z","slot_end":"2026-11-14T11:15:00Z","price_ct_kwh":1,"unit":"ct/kWh"}`,
		"bad unit":       `{"schema_version":"1.0","slot_start":"2026-11-14T11:00:00Z","slot_end":"2026-11-14T11:15:00Z","price_ct_kwh":1,"unit":"EUR/MWh"}`,
		"end before":     `{"schema_version":"1.0","slot_start":"2026-11-14T11:15:00Z","slot_end":"2026-11-14T11:00:00Z","price_ct_kwh":1,"unit":"ct/kWh"}`,
		"overlong slot":  `{"schema_version":"1.0","slot_start":"2026-11-14T00:00:00Z","slot_end":"2026-11-15T00:00:00Z","price_ct_kwh":1,"unit":"ct/kWh"}`,
		"price not json": `{"schema_version":"1.0","slot_start":"2026-11-14T11:00:00Z","slot_end":"2026-11-14T11:15:00Z","price_ct_kwh":"x","unit":"ct/kWh"}`,
	}
	for name, raw := range cases {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if _, err := Parse(nil); err != ErrEmpty {
		t.Errorf("empty payload: want ErrEmpty, got %v", err)
	}
}

func TestParseNegativePriceIsAPrice(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Minute)
	d := doc(t, start, start.Add(15*time.Minute), -4.2)
	if d.PriceCtKwh != -4.2 {
		t.Fatalf("price: %v", d.PriceCtKwh)
	}
	if !d.MatchesIdentity("t1", "s1", "d1") || d.MatchesIdentity("t1", "s1", "other") {
		t.Fatal("identity check broken")
	}
}

func TestAcceptMirrorsFreshPrice(t *testing.T) {
	c := &capture{}
	now := time.Date(2026, 11, 14, 11, 0, 3, 0, time.UTC)
	f := newWithClock(c.publish, func() time.Time { return now })
	defer f.Close()
	f.Accept(doc(t, now.Truncate(15*time.Minute), now.Truncate(15*time.Minute).Add(15*time.Minute), 8.4))
	p := c.last(t)
	if p["price_ct_kwh"] != 8.4 || p["unit"] != "ct/kWh" || p["stale"] != nil {
		t.Fatalf("payload: %v", p)
	}
	if p["valid_until"] != "2026-11-14T11:20:00Z" { // slot_end 11:15 + 5 min Slack
		t.Fatalf("valid_until: %v", p["valid_until"])
	}
	if p["bidding_zone"] != "DE-LU" {
		t.Fatalf("zone: %v", p["bidding_zone"])
	}
}

func TestExpiredDocumentPublishesStaleMarkerNotAPrice(t *testing.T) {
	c := &capture{}
	now := time.Date(2026, 11, 14, 11, 0, 0, 0, time.UTC)
	f := newWithClock(c.publish, func() time.Time { return now })
	defer f.Close()
	// A retained redelivery from yesterday: never flash it as current.
	f.Accept(doc(t, now.Add(-24*time.Hour), now.Add(-24*time.Hour).Add(15*time.Minute), 3.0))
	p := c.last(t)
	if p["stale"] != true || p["price_ct_kwh"] != nil {
		t.Fatalf("expected stale marker, got %v", p)
	}
	// Idempotent: a second expired doc publishes nothing new.
	f.Accept(doc(t, now.Add(-23*time.Hour), now.Add(-23*time.Hour).Add(15*time.Minute), 3.0))
	if c.count() != 1 {
		t.Fatalf("stale marker republished: %d payloads", c.count())
	}
}

func TestWatchdogMarksStaleAfterValidUntil(t *testing.T) {
	c := &capture{}
	f := New(c.publish)
	defer f.Close()
	// valid_until = start + 15 min + Slack lands on the next whole second at
	// least 300 ms ahead: the document carries RFC 3339 seconds, so a deadline
	// with a fraction would be truncated - up to a second into the past.
	bis := time.Now().Add(1300 * time.Millisecond).Truncate(time.Second)
	start := bis.Add(-15 * time.Minute).Add(-Slack)
	f.Accept(doc(t, start, start.Add(15*time.Minute), 12.0))
	if p := c.last(t); p["stale"] == true {
		t.Fatalf("fresh price immediately stale: %v", p)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if c.count() >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("watchdog never published the stale marker")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if p := c.last(t); p["stale"] != true {
		t.Fatalf("expected stale marker, got %v", p)
	}
}

func TestFreshDocumentRearmsWatchdog(t *testing.T) {
	c := &capture{}
	now := time.Date(2026, 11, 14, 11, 0, 0, 0, time.UTC)
	f := newWithClock(c.publish, func() time.Time { return now })
	defer f.Close()
	slot := now.Truncate(15 * time.Minute)
	f.Accept(doc(t, slot, slot.Add(15*time.Minute), 8.0))
	// The next slot's price arrives: the old timer must not stale-mark it.
	f.Accept(doc(t, slot.Add(15*time.Minute), slot.Add(30*time.Minute), 9.0))
	f.expire() // simulate the FIRST timer firing late
	p := c.last(t)
	if p["price_ct_kwh"] != 9.0 || p["stale"] == true {
		t.Fatalf("stale timer killed a fresher price: %v", p)
	}
}

func TestWithdrawPublishesStaleMarker(t *testing.T) {
	c := &capture{}
	now := time.Date(2026, 11, 14, 11, 0, 0, 0, time.UTC)
	f := newWithClock(c.publish, func() time.Time { return now })
	defer f.Close()
	slot := now.Truncate(15 * time.Minute)
	f.Accept(doc(t, slot, slot.Add(15*time.Minute), 8.0))
	f.Withdraw()
	p := c.last(t)
	if p["stale"] != true {
		t.Fatalf("expected stale marker, got %v", p)
	}
	raw, _ := json.Marshal(p)
	if strings.Contains(string(raw), "price_ct_kwh") {
		t.Fatalf("stale marker must carry no price: %s", raw)
	}
}

// The Steuerlogik running along reads the price through Current: the standing
// price within its validity, unknown before the first document, after
// valid_until and after a withdrawal - never a stale price.
func TestCurrentNurSolangeDerPreisGilt(t *testing.T) {
	c := &capture{}
	now := time.Date(2026, 11, 14, 11, 0, 3, 0, time.UTC)
	f := newWithClock(c.publish, func() time.Time { return now })
	defer f.Close()
	if _, _, ok := f.Current(now); ok {
		t.Fatal("no document yet: unknown")
	}
	slot := now.Truncate(15 * time.Minute)
	f.Accept(doc(t, slot, slot.Add(15*time.Minute), -1.2))
	if p, start, ok := f.Current(now); !ok || p != -1.2 || !start.Equal(slot) {
		t.Fatalf("fresh price: %v %v %v", p, start, ok)
	}
	if _, _, ok := f.Current(slot.Add(20 * time.Minute)); ok {
		t.Fatal("after valid_until (slot end + slack) the price is unknown")
	}
	f.Withdraw()
	if _, _, ok := f.Current(now); ok {
		t.Fatal("withdrawn: unknown")
	}
}
