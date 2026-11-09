package layer1

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

// The registers Edge Light reads itself must be the catalog's: the cloud names
// the point, the box reads the register behind it.
func TestEinstellungsPunkteMatchTheCatalog(t *testing.T) {
	files, err := filepath.Glob(filepath.Join("..", "..", "..", "..", "catalog", "measurement-points", "dist",
		"measurement-point-catalog-*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("Katalog nicht gefunden: %v", err)
	}
	sort.Strings(files)
	raw, err := os.ReadFile(files[len(files)-1])
	if err != nil {
		t.Fatal(err)
	}
	var cat struct {
		Points []struct {
			PointKey  string `json:"point_key"`
			Family    string `json:"family"`
			ValueType string `json:"value_type"`
			Unit      string `json:"unit"`
			Address   *struct {
				Kind      string `json:"kind"`
				Registers []int  `json:"registers"`
			} `json:"address"`
		} `json:"points"`
	}
	if err := json.Unmarshal(raw, &cat); err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, p := range cat.Points {
		want, ok := einstellungsPunkte[p.PointKey]
		if !ok {
			continue
		}
		found++
		if p.Address == nil || p.Address.Kind != "modbus_holding" || len(p.Address.Registers) != 1 ||
			p.Address.Registers[0] != int(want.register) || p.Family != want.family ||
			p.ValueType != "uint16" || p.Unit != "%" {
			t.Errorf("%s: Katalog %+v, Edge Light liest %+v", p.PointKey, p, want)
		}
	}
	if found != len(einstellungsPunkte) {
		t.Fatalf("%d von %d Punkten im Katalog %s", found, len(einstellungsPunkte), files[len(files)-1])
	}
}

type busLog struct {
	mu   sync.Mutex
	msgs map[string][][]byte
}

func (r *rig) listen(topics ...string) *busLog {
	l := &busLog{msgs: map[string][][]byte{}}
	for i, topic := range topics {
		topic := topic
		if err := r.bus.Subscribe(topic, 950+i, func(_ string, p []byte) {
			l.mu.Lock()
			l.msgs[topic] = append(l.msgs[topic], append([]byte(nil), p...))
			l.mu.Unlock()
		}); err != nil {
			r.t.Fatal(err)
		}
	}
	return l
}

func (l *busLog) wait(t *testing.T, topic string, n int, within time.Duration) [][]byte {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		l.mu.Lock()
		got := l.msgs[topic]
		l.mu.Unlock()
		if len(got) >= n {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s: weniger als %d Nachrichten in %s", topic, n, within)
	return nil
}

func (l *busLog) count(topic string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.msgs[topic])
}

func (r *rig) messplan(revision int64, selections ...map[string]any) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"schema_version": "2.0", "revision": revision,
		"catalog_version": "2026.10.26.1", "selections": selections})
	if err := r.bus.Publish(measurements.LocalConfigTopic, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func TestEdgeLightReadsTheDeyeDischargeLimitAndRefusesEveryOtherPoint(t *testing.T) {
	r := newRig(t, Options{})
	l := r.listen(measurements.LocalStatusTopic, measurements.LocalSamplesTopic)
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{117: 15, 116: 30, 115: 5})
	r.selectDeye("hybrid_3p", nil)
	r.wait("edge/telemetry", 1, 5*time.Second)
	r.messplan(7,
		map[string]any{"point_key": "deye.hybrid_3p.settings.battery-low-soc", "cadence_s": 300},
		map[string]any{"point_key": "deye.hybrid_1p.settings.battery-low-soc", "cadence_s": 300},
		map[string]any{"point_key": "deye.hybrid_3p.settings.battery-shutdown-soc", "cadence_s": 300})

	var status measurements.LocalStatus
	statuses := l.wait(t, measurements.LocalStatusTopic, 1, 5*time.Second)
	if err := json.Unmarshal(statuses[len(statuses)-1], &status); err != nil {
		t.Fatal(err)
	}
	if status.Revision != 7 || strings.Join(status.Accepted, ",") != "deye.hybrid_3p.settings.battery-low-soc" {
		t.Fatalf("Status %+v", status)
	}
	grund := map[string]string{}
	for _, rj := range status.Rejected {
		grund[rj.PointKey] = rj.Reason
	}
	if grund["deye.hybrid_1p.settings.battery-low-soc"] != "binding_unavailable" ||
		grund["deye.hybrid_3p.settings.battery-shutdown-soc"] != "edge_too_old" {
		t.Fatalf("Ablehnungen %v", grund)
	}
	// The core's own status check accepts it (it wraps and forwards exactly this).
	if _, err := measurements.WrapStatus(statuses[len(statuses)-1],
		measurements.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}, "test"); err != nil {
		t.Fatalf("WrapStatus lehnt den Status ab: %v", err)
	}

	batch := l.wait(t, measurements.LocalSamplesTopic, 1, 5*time.Second)[0]
	var b struct {
		CatalogVersion  string           `json:"catalog_version"`
		AppliedRevision int64            `json:"applied_revision"`
		Samples         []map[string]any `json:"samples"`
	}
	if err := json.Unmarshal(batch, &b); err != nil {
		t.Fatal(err)
	}
	if b.CatalogVersion != "2026.10.26.1" || b.AppliedRevision != 7 || len(b.Samples) != 1 ||
		b.Samples[0]["point_key"] != "deye.hybrid_3p.settings.battery-low-soc" ||
		b.Samples[0]["raw"] != float64(15) || b.Samples[0]["decoded"] != float64(15) ||
		b.Samples[0]["quality"] != "good" {
		t.Fatalf("Lesung %s", batch)
	}
	// The core's outbox takes the batch as it is.
	dir := t.TempDir()
	box, err := measurements.OpenOutbox(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := box.Append(batch, measurements.Identity{TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID: "00000000-0000-0000-0000-000000000002", DeviceID: "00000000-0000-0000-0000-000000000003"}); err != nil {
		t.Fatalf("Outbox lehnt die Lesung ab: %v", err)
	}

	// The cadence holds: polls keep running, the setting is not read again.
	before := r.count("edge/telemetry")
	r.wait("edge/telemetry", before+3, 5*time.Second)
	if n := l.count(measurements.LocalSamplesTopic); n != 1 {
		t.Fatalf("%d Lesungen innerhalb des Takts, want 1", n)
	}
}

func TestAPercentageAbove100IsReportedAsInvalidNeverAsALimit(t *testing.T) {
	r := newRig(t, Options{})
	l := r.listen(measurements.LocalSamplesTopic)
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{117: 250})
	r.selectDeye("hybrid_3p", nil)
	r.wait("edge/telemetry", 1, 5*time.Second)
	r.messplan(1, map[string]any{"point_key": "deye.hybrid_3p.settings.battery-low-soc", "cadence_s": 300})
	var b struct {
		Samples []map[string]any `json:"samples"`
	}
	if err := json.Unmarshal(l.wait(t, measurements.LocalSamplesTopic, 1, 5*time.Second)[0], &b); err != nil {
		t.Fatal(err)
	}
	if len(b.Samples) != 1 || b.Samples[0]["quality"] != "invalid" {
		t.Fatalf("Lesung %v", b.Samples)
	}
}

func TestWithoutAPlanNothingButTheTelemetryIsRead(t *testing.T) {
	r := newRig(t, Options{})
	l := r.listen(measurements.LocalStatusTopic, measurements.LocalSamplesTopic)
	liveLV(r.sim)
	r.selectDeye("hybrid_3p", nil)
	r.wait("edge/telemetry", 3, 5*time.Second)
	if l.count(measurements.LocalStatusTopic)+l.count(measurements.LocalSamplesTopic) != 0 {
		t.Fatal("ohne Messplan darf Layer 1 weder Status noch Lesung senden")
	}
}
