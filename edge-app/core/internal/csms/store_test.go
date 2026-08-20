package csms

import (
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 8, 20, 10, 0, 0, 0, time.UTC)

// TestNormalizeAddRules pins the pairing entry: the ChargePointId is the
// identity AND a URL path segment, so it is bounded, exact and unique.
func TestNormalizeAddRules(t *testing.T) {
	ok, err := NormalizeAdd(AddRequest{ID: " SAEULE-1 ", Label: "  Hof Nord  "}, nil, t0)
	if err != nil {
		t.Fatalf("valid request refused: %v", err)
	}
	if ok.ID != "SAEULE-1" || ok.Label != "Hof Nord" {
		t.Fatalf("not trimmed: %+v", ok)
	}
	if !ok.AddedAt.Equal(t0) {
		t.Fatalf("AddedAt = %v, want the injected now", ok.AddedAt)
	}

	// An empty label falls back to the id - a nameless row on a setup surface
	// is worse than a technical one.
	unnamed, err := NormalizeAdd(AddRequest{ID: "CP2"}, nil, t0)
	if err != nil || unnamed.Label != "CP2" {
		t.Fatalf("unnamed fallback: %+v, %v", unnamed, err)
	}

	for _, bad := range []string{"", "   ", "hat leerzeichen", "mit/slash", "ümlaut", "-startet-mit-strich", strings.Repeat("x", 65)} {
		if _, err := NormalizeAdd(AddRequest{ID: bad}, nil, t0); err == nil {
			t.Fatalf("id %q was accepted", bad)
		} else if _, isVal := err.(*ValidationError); !isVal {
			t.Fatalf("id %q: want a German ValidationError, got %T", bad, err)
		}
	}

	existing := []Charger{{ID: "SAEULE-1"}}
	if _, err := NormalizeAdd(AddRequest{ID: "SAEULE-1"}, existing, t0); err == nil {
		t.Fatal("a duplicate id was accepted - the id IS the identity")
	}

	full := make([]Charger, maxChargers)
	for i := range full {
		full[i] = Charger{ID: string(rune('a'+i%26)) + strings.Repeat("z", i/26+1)}
	}
	if _, err := NormalizeAdd(AddRequest{ID: "ONE-MORE"}, full, t0); err == nil {
		t.Fatal("the allowlist is unbounded")
	}

	if _, err := NormalizeAdd(AddRequest{ID: "CP", Label: strings.Repeat("x", 121)}, nil, t0); err == nil {
		t.Fatal("an unbounded label was accepted")
	}
}

// TestStoreRoundTrip: the allowlist AND the transaction counter survive a
// restart, and a store that was never written reports so honestly.
func TestStoreRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	list, next, ok, err := s.Load()
	if err != nil || ok || len(list) != 0 {
		t.Fatalf("fresh store: list=%v ok=%v err=%v", list, ok, err)
	}
	if next != 1 {
		t.Fatalf("fresh transaction counter = %d, want 1", next)
	}

	want := []Charger{
		{ID: "B", Label: "Hof Süd", AddedAt: t0},
		{ID: "A", Label: "Hof Nord", Priority: true, AddedAt: t0},
	}
	if err := s.Save(want, 4711); err != nil {
		t.Fatalf("save: %v", err)
	}

	s2, _ := NewStore(dir)
	got, next2, ok2, err := s2.Load()
	if err != nil || !ok2 {
		t.Fatalf("reload: ok=%v err=%v", ok2, err)
	}
	if next2 != 4711 {
		t.Fatalf("transaction counter = %d, want 4711", next2)
	}
	if len(got) != 2 {
		t.Fatalf("got %d chargers", len(got))
	}
	SortChargers(got)
	if got[0].ID != "A" || !got[0].Priority || got[1].ID != "B" {
		t.Fatalf("round trip lost fields: %+v", got)
	}

	// A nil list persists as an empty list, never as JSON null.
	if err := s.Save(nil, 0); err != nil {
		t.Fatalf("save nil: %v", err)
	}
	got3, next3, _, err := s.Load()
	if err != nil {
		t.Fatalf("reload nil: %v", err)
	}
	if len(got3) != 0 {
		t.Fatalf("nil list came back as %+v", got3)
	}
	if next3 != 1 {
		t.Fatalf("a bogus counter must floor at 1, got %d", next3)
	}
}

// TestKnownStatusVocabulary: a status word we do not understand must not
// become a sentence, and the "is this connector claiming budget" question has
// exactly one answer.
func TestKnownStatusVocabulary(t *testing.T) {
	for _, s := range []string{StatusAvailable, StatusPreparing, StatusCharging,
		StatusSuspendedEV, StatusSuspendedEVSE, StatusFinishing, StatusReserved,
		StatusUnavailable, StatusFaulted} {
		if !KnownStatus(s) {
			t.Fatalf("%q should be known", s)
		}
	}
	for _, s := range []string{"", "charging", "Occupied", "SuspendedEVSEE"} {
		if KnownStatus(s) {
			t.Fatalf("%q should NOT be known", s)
		}
	}

	// A suspended session still holds its allocation: the vehicle may resume
	// within a second, and handing the power away and back is worse than
	// holding it.
	for _, s := range []string{StatusCharging, StatusSuspendedEV, StatusSuspendedEVSE} {
		if !ChargingStatus(s) {
			t.Fatalf("%q must count as a claim on the budget", s)
		}
	}
	for _, s := range []string{StatusAvailable, StatusPreparing, StatusFinishing,
		StatusReserved, StatusUnavailable, StatusFaulted, "unbekannt"} {
		if ChargingStatus(s) {
			t.Fatalf("%q must NOT count as a claim on the budget", s)
		}
	}
}

// TestEndpointRendering: the setup surface shows the FULL url including the
// ChargePointId, because that is what a station is configured with.
func TestEndpointRendering(t *testing.T) {
	s, err := New(Options{Enabled: false, DataDir: t.TempDir(), Port: 8887})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	if got, want := s.Endpoint("voltpilot-box.local"), "ws://voltpilot-box.local:8887/ocpp"; got != want {
		t.Fatalf("Endpoint = %q, want %q", got, want)
	}
	if got, want := s.EndpointFor("192.168.1.20", "SAEULE-1"), "ws://192.168.1.20:8887/ocpp/SAEULE-1"; got != want {
		t.Fatalf("EndpointFor = %q, want %q", got, want)
	}
	// An IPv6 host must stay a valid URL authority.
	if got, want := s.Endpoint("fd00::1"), "ws://[fd00::1]:8887/ocpp"; got != want {
		t.Fatalf("Endpoint(ipv6) = %q, want %q", got, want)
	}
}
