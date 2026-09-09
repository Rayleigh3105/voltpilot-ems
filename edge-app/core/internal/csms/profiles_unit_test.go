package csms

import (
	"testing"
	"time"
)

var pt0 = time.Date(2026, 8, 20, 13, 24, 0, 0, time.UTC)

// TestThePermanentProfilesNeverExpireAndTheLiveOneAlways is the dead man's
// switch expressed as an invariant of the profile BUILDERS, so it cannot be
// broken by an edit somewhere else: what protects a customer when we die must
// not expire, and what we command while alive must.
func TestThePermanentProfilesNeverExpireAndTheLiveOneAlways(t *testing.T) {
	max := MaxProfile(240, pt0)
	def := DefaultProfile(15, pt0)
	live := TxProfile(1, 4711, 41, pt0, 0)

	if max.Duration != 0 || def.Duration != 0 {
		t.Fatalf("a permanent profile must never expire: max=%v default=%v", max.Duration, def.Duration)
	}
	if live.Duration <= 0 {
		t.Fatal("the live profile MUST expire - that expiry is the whole fail-safe")
	}
	if live.Duration != TxProfileDuration {
		t.Fatalf("live duration = %v, want the default %v", live.Duration, TxProfileDuration)
	}
	if max.Purpose != PurposeMax || def.Purpose != PurposeTxDefault || live.Purpose != PurposeTx {
		t.Fatalf("purposes: %q %q %q", max.Purpose, def.Purpose, live.Purpose)
	}
	if live.TransactionID != 4711 {
		t.Fatalf("the live profile must name its transaction, got %d", live.TransactionID)
	}
}

// TestProfileIdsAreUniquePerConnector: a SetChargingProfile carrying a known
// id REPLACES that profile, so two connectors sharing an id would overwrite
// each other's limit - one car would silently inherit the other's.
func TestProfileIdsAreUniquePerConnector(t *testing.T) {
	seen := map[int]string{ProfileIDMax: "max", ProfileIDTxDefault: "default"}
	for c := 1; c <= 16; c++ {
		id := TxProfileID(c)
		if what, clash := seen[id]; clash {
			t.Fatalf("connector %d's profile id %d collides with %s", c, id, what)
		}
		seen[id] = "connector " + string(rune('0'+c%10))
	}
}

// TestANegativeLimitIsNeverCommanded: a negative limit is not a thing, and
// what a station would make of it is anyone's guess.
func TestANegativeLimitIsNeverCommanded(t *testing.T) {
	for _, p := range []ChargingProfile{
		MaxProfile(-5, pt0), DefaultProfile(-1, pt0), TxProfile(1, 1, -41, pt0, 0),
	} {
		if p.LimitKw != 0 {
			t.Fatalf("%s carried %v kW", p.Purpose, p.LimitKw)
		}
	}
}

// TestSameAsIgnoresTheRefreshTimestamp: every refresh carries a new start
// time, so comparing it would make every profile look changed and the
// station's store would be hammered pointlessly.
func TestSameAsIgnoresTheRefreshTimestamp(t *testing.T) {
	a := TxProfile(1, 4711, 41, pt0, 0)
	b := TxProfile(1, 4711, 41, pt0.Add(30*time.Second), 0)
	if !a.SameAs(b) {
		t.Fatal("a refresh of the same limit must compare equal")
	}
	if a.SameAs(TxProfile(1, 4711, 41.5, pt0, 0)) {
		t.Fatal("a different limit must compare unequal")
	}
	if a.SameAs(TxProfile(2, 4711, 41, pt0, 0)) {
		t.Fatal("a different connector must compare unequal")
	}
	if a.SameAs(TxProfile(1, 4712, 41, pt0, 0)) {
		t.Fatal("a different transaction must compare unequal")
	}
}

// TestCapabilitiesRefuseRatherThanGuess pins the parser's judgement calls,
// each of which was a decision.
func TestCapabilitiesRefuseRatherThanGuess(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]string
		usable bool
	}{
		{"watts", map[string]string{KeyAllowedChargingRateUnit: "W"}, true},
		{"the spelt-out form", map[string]string{KeyAllowedChargingRateUnit: "Power"}, true},
		{"both units offered", map[string]string{KeyAllowedChargingRateUnit: "Current,Power"}, true},
		{"amperes only (wiring checked at commissioning)", map[string]string{KeyAllowedChargingRateUnit: "Current"}, true},
		{"a nonsense unit", map[string]string{KeyAllowedChargingRateUnit: "Furlongs"}, false},
		// ⚠ The key is OPTIONAL in OCPP 1.6 and plenty of firmware omits it
		// while happily taking watt limits. Reading the omission as "cannot"
		// would make the feature refuse most of the field; the station's own
		// SetChargingProfile answer stays the real verdict.
		{"the key is missing entirely", map[string]string{}, true},
		{"the key is empty", map[string]string{KeyAllowedChargingRateUnit: "  "}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := ParseCapabilities(tc.values, nil)
			got, why := c.Usable()
			if got != tc.usable {
				t.Fatalf("usable = %v (%q), want %v", got, why, tc.usable)
			}
			if !got && why == "" {
				t.Fatal("refused without saying why")
			}
		})
	}

	// An UNREAD capability is not an absent one - and it says so.
	var unread Capabilities
	if ok, why := unread.Usable(); ok || why == "" {
		t.Fatalf("unread capabilities: ok=%v why=%q", ok, why)
	}

	// The optional numeric keys default to 0 = "not reported", never to a
	// made-up ceiling.
	c := ParseCapabilities(map[string]string{
		KeyMaxStackLevel: "8", KeyMaxPeriods: "not a number",
	}, []string{KeyMaxProfilesInstalled})
	if c.MaxStackLevel != 8 || c.MaxPeriods != 0 || c.MaxProfiles != 0 {
		t.Fatalf("numeric keys: %+v", c)
	}
	if len(c.Unknown) != 1 || c.Unknown[0] != KeyMaxProfilesInstalled {
		t.Fatalf("unknown keys not kept: %+v", c.Unknown)
	}
}

// TestCompareReadbackHasThreeAnswers - because they cause three different
// actions, and "silence" must never look like "ok" (the PR-280 lesson).
func TestCompareReadbackHasThreeAnswers(t *testing.T) {
	kw := func(v float64) *float64 { return &v }

	v, _ := CompareReadback(41, CompositeSchedule{Accepted: true, LimitKw: kw(41)}, 0)
	if v != ReadbackOK {
		t.Fatalf("exact match = %q", v)
	}
	// A station rounding to whole watts must not read as a mismatch.
	v, _ = CompareReadback(41, CompositeSchedule{Accepted: true, LimitKw: kw(41.001)}, 0)
	if v != ReadbackOK {
		t.Fatalf("rounding = %q", v)
	}
	v, note := CompareReadback(41, CompositeSchedule{Accepted: true, LimitKw: kw(15)}, 0)
	if v != ReadbackMismatch || note == "" {
		t.Fatalf("mismatch = %q / %q", v, note)
	}
	v, note = CompareReadback(41, CompositeSchedule{Accepted: false}, 0)
	if v != ReadbackUnknown || note == "" {
		t.Fatalf("refused report = %q / %q", v, note)
	}
	v, note = CompareReadback(41, CompositeSchedule{Accepted: true}, 0)
	if v != ReadbackUnknown || note == "" {
		t.Fatalf("no schedule reported = %q / %q", v, note)
	}
	// A commanded 0 (a pause) that reads back as 0 is a MATCH, not an absence.
	if v, _ := CompareReadback(0, CompositeSchedule{Accepted: true, LimitKw: kw(0)}, 0); v != ReadbackOK {
		t.Fatalf("a confirmed pause = %q", v)
	}
}
