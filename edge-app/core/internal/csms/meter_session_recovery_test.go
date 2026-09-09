package csms

import (
	"bytes"
	"os"
	"testing"
	"time"
)

func recoveryServer(t *testing.T, dir string, now time.Time) *Server {
	t.Helper()
	s, err := New(Options{Enabled: true, DataDir: dir, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.List()) == 0 {
		if _, err := s.Add(AddRequest{ID: "CP"}); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func TestMeasurandsHaveIndependentOrderedClocks(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	s := recoveryServer(t, t.TempDir(), now)
	power, energy, soc, wrong := 11.0, 2.0, 50.0, 90.0
	s.onMeterSample("CP", 1, MeterReading{PowerKw: &power}, now, now, nil)
	s.onMeterSample("CP", 1, MeterReading{EnergyKwh: &energy, SocPct: &soc}, now.Add(time.Minute), now.Add(time.Minute), nil)
	for _, sampled := range []time.Time{now.Add(-time.Second), now, now.Add(2 * time.Minute)} {
		s.onMeterSample("CP", 1, MeterReading{PowerKw: &wrong}, sampled, now, nil)
	}
	c, _ := s.Snapshot().ChargerByID("CP")
	con := c.ConnectorByID(1)
	if *con.PowerKw != power || !con.MeteredAt.Equal(now) || !con.EnergyMeasuredAt.Equal(now.Add(time.Minute)) || !con.SocMeasuredAt.Equal(now.Add(time.Minute)) {
		t.Fatalf("independent measurement clocks violated: %+v", con)
	}
}

func TestRecoveryRequiresFreshMatchingTransactionAndPersistsPseudonym(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().UTC().Truncate(time.Second)
	s := recoveryServer(t, dir, now)
	id := s.onStartTransaction("CP", 1, "PRIVATE-CARD", 1200, now)
	if duplicate := s.onStartTransaction("CP", 1, "PRIVATE-CARD", 1200, now); duplicate != id {
		t.Fatalf("duplicate ID %d != %d", duplicate, id)
	}
	before, _ := s.Snapshot().ChargerByID("CP")
	raw, err := os.ReadFile(s.store.Path())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("PRIVATE-CARD")) || bytes.Contains(raw, []byte("id_tag")) {
		t.Fatal("plaintext card persisted")
	}
	s = recoveryServer(t, dir, now)
	s.onStatus("CP", 1, StatusCharging, "NoError", now)
	power := 11.0
	wrong := id + 1
	for _, tc := range []struct {
		tx      *int
		sampled time.Time
	}{{nil, now}, {&wrong, now}, {&id, now.Add(-time.Hour)}, {&id, now.Add(time.Hour)}} {
		s.onMeterSample("CP", 1, MeterReading{PowerKw: &power}, tc.sampled, now, tc.tx)
		c, _ := s.Snapshot().ChargerByID("CP")
		if len(c.ActiveConnectors()) != 0 {
			t.Fatal("unconfirmed session claims power")
		}
	}
	s.onMeterSample("CP", 1, MeterReading{PowerKw: &power}, now, now, &id)
	c, _ := s.Snapshot().ChargerByID("CP")
	if len(c.ActiveConnectors()) != 1 || c.Connectors[0].Session.TagRef != before.Connectors[0].Session.TagRef || c.Connectors[0].Session.MeterStartWh != 1200 {
		t.Fatalf("recovery: %+v", c)
	}
	// Duplicate stops and a further reboot must not resurrect the session.
	s.onStopTransaction("CP", id, now)
	s.onStopTransaction("CP", id, now)
	s = recoveryServer(t, dir, now)
	c, _ = s.Snapshot().ChargerByID("CP")
	if len(c.Connectors) != 0 {
		t.Fatal("stopped session restored")
	}
}

func TestStartIsNotAcknowledgedWithoutDurableState(t *testing.T) {
	now := time.Now().UTC()
	s := recoveryServer(t, t.TempDir(), now)
	if err := os.Remove(s.store.Path()); err != nil {
		t.Fatal(err)
	}
	// A directory at the target makes rename fail even under root.
	if err := os.Mkdir(s.store.Path(), 0700); err != nil {
		t.Fatal(err)
	}
	if id := s.onStartTransaction("CP", 1, "CARD", 0, now); id != 0 {
		t.Fatal("non-durable transaction acknowledged")
	}
	c, _ := s.Snapshot().ChargerByID("CP")
	if c.ConnectorByID(1).Session != nil {
		t.Fatal("failed start retained live state")
	}
}
