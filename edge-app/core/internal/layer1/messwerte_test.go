package layer1

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/messwerte"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

// The measurement library end to end over the real local bus: the plan in,
// the status and the batches out, read from simulated devices.

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

// messplan publishes a plan for the box's catalog version.
func (r *rig) messplan(revision int64, selections ...map[string]any) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"schema_version": "2.0", "revision": revision,
		"catalog_version": messwerte.KatalogVersion(), "selections": selections})
	if err := r.bus.Publish(measurements.LocalConfigTopic, raw, true); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) entitaet(id, typ, pin, datenquelle string) {
	r.t.Helper()
	raw, _ := json.Marshal(map[string]any{"entity_id": id, "entity_type": typ, "edge_source_id": pin,
		"driver": map[string]any{"data_source_id": datenquelle}})
	if err := r.bus.Publish("edge/entities/"+id+"/config", raw, true); err != nil {
		r.t.Fatal(err)
	}
}

type batch struct {
	CatalogVersion  string           `json:"catalog_version"`
	AppliedRevision int64            `json:"applied_revision"`
	Samples         []map[string]any `json:"samples"`
}

func TestEdgeLightReadsCatalogPointsOfTheDeyeThroughTheLibrary(t *testing.T) {
	r := newRig(t, Options{})
	l := r.listen(measurements.LocalStatusTopic, measurements.LocalSamplesTopic)
	liveLV(r.sim)
	r.sim.Set(map[uint16]uint16{117: 15, 115: 5})
	r.selectDeye("hybrid_3p", nil)
	r.wait("edge/telemetry", 1, 5*time.Second)
	r.messplan(7,
		map[string]any{"point_key": "deye.hybrid_3p.settings.battery-low-soc", "cadence_s": 300},
		map[string]any{"point_key": "deye.hybrid_3p.settings.battery-shutdown-soc", "cadence_s": 300},
		map[string]any{"point_key": "gibt.es.nicht", "cadence_s": 300})

	var status measurements.LocalStatus
	statuses := l.wait(t, measurements.LocalStatusTopic, 1, 5*time.Second)
	if err := json.Unmarshal(statuses[len(statuses)-1], &status); err != nil {
		t.Fatal(err)
	}
	if status.Revision != 7 || len(status.Accepted) != 2 || len(status.Rejected) != 1 ||
		status.Rejected[0].PointKey != "gibt.es.nicht" || status.Rejected[0].Reason != "unknown_point" {
		t.Fatalf("Status %+v", status)
	}
	if _, err := measurements.WrapStatus(statuses[len(statuses)-1],
		measurements.Identity{TenantID: "t", SiteID: "s", DeviceID: "d"}, "test"); err != nil {
		t.Fatalf("WrapStatus lehnt den Status ab: %v", err)
	}

	raw := l.wait(t, measurements.LocalSamplesTopic, 1, 5*time.Second)[0]
	var b batch
	if err := json.Unmarshal(raw, &b); err != nil {
		t.Fatal(err)
	}
	werte := map[string]float64{}
	for _, s := range b.Samples {
		if s["quality"] != "good" {
			t.Fatalf("Lesung %s", raw)
		}
		werte[s["point_key"].(string)] = s["decoded"].(float64)
	}
	if b.CatalogVersion != messwerte.KatalogVersion() || b.AppliedRevision != 7 ||
		werte["deye.hybrid_3p.settings.battery-low-soc"] != 15 || werte["deye.hybrid_3p.settings.battery-shutdown-soc"] != 5 {
		t.Fatalf("Lesung %s", raw)
	}
	box, err := measurements.OpenOutbox(t.TempDir(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := box.Append(raw, measurements.Identity{TenantID: "00000000-0000-0000-0000-000000000001",
		SiteID: "00000000-0000-0000-0000-000000000002", DeviceID: "00000000-0000-0000-0000-000000000003"}); err != nil {
		t.Fatalf("Outbox lehnt die Lesung ab: %v", err)
	}
	// The cadence holds while the polls keep running, and the library never
	// opens a second socket next to the poll on the one-client logger.
	before := r.count("edge/telemetry")
	r.wait("edge/telemetry", before+3, 5*time.Second)
	if n := l.count(measurements.LocalSamplesTopic); n != 1 {
		t.Fatalf("%d Lesungen innerhalb des Takts, want 1", n)
	}
	if n := r.sim.RefusedConnections(); n != 0 {
		t.Fatalf("%d Verbindungen abgewiesen", n)
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
	var b batch
	if err := json.Unmarshal(l.wait(t, measurements.LocalSamplesTopic, 1, 5*time.Second)[0], &b); err != nil {
		t.Fatal(err)
	}
	if len(b.Samples) != 1 || b.Samples[0]["quality"] != "invalid" || b.Samples[0]["decoded"] != nil {
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

// A component bound to a source is read over THAT source's connection: a free
// register over Modbus TCP, a go-e point over HTTP - each with the receipt of
// its own data source.
func TestTheLibraryReadsBoundComponentsOverTheirOwnConnection(t *testing.T) {
	modbus := startHuaweiSim(t, map[uint16]uint16{100: 0xffff, 101: 0xfc18})
	goe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/status" || req.URL.Query().Get("filter") != "acp" {
			http.Error(w, "falsche Anfrage", http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"acp":true}`))
	}))
	defer goe.Close()
	gu, _ := url.Parse(goe.URL)
	gport, _ := strconv.Atoi(gu.Port())
	mhost, mport := modbus.addr()

	r := newRig(t, Options{Poll: time.Hour, FirstPoll: time.Hour})
	l := r.listen(measurements.LocalStatusTopic, measurements.LocalSamplesTopic, datasourcestatus.Topic)
	if err := r.bus.Publish(sources.TopicConfig, sourcesConfig(
		map[string]any{"id": "src-zaehler", "role": "grid-meter", "communication": "modbus_tcp", "family": "sunspec",
			"connection": map[string]any{"ip": mhost, "port": mport, "unit_id": 1}},
		map[string]any{"id": "src-goe", "role": "consumer", "communication": "goe_http_api", "family": "goe_http_api",
			"connection": map[string]any{"ip": "127.0.0.1", "port": gport}},
	), true); err != nil {
		t.Fatal(err)
	}
	r.entitaet("zaehler-1", "grid-meter", "src-zaehler", "DQ-Z")
	r.entitaet("wallbox-1", "wallbox", "src-goe", "DQ-G")
	time.Sleep(200 * time.Millisecond)
	r.messplan(3,
		map[string]any{"point_key": "custom.leistung", "cadence_s": 60, "entity_id": "zaehler-1",
			"definition": map[string]any{"sourceKind": "modbus_holding", "address": 100, "widthBits": 32,
				"valueType": "int32", "signed": true, "endian": "big", "scale": 0.1}},
		map[string]any{"point_key": "goe.api_v2.acp", "cadence_s": 3600, "entity_id": "wallbox-1"})

	var status measurements.LocalStatus
	statuses := l.wait(t, measurements.LocalStatusTopic, 1, 5*time.Second)
	_ = json.Unmarshal(statuses[len(statuses)-1], &status)
	if len(status.Accepted) != 2 {
		t.Fatalf("Status %+v", status)
	}
	got := map[string]map[string]any{}
	deadline := time.Now().Add(5 * time.Second)
	for len(got) < 2 && time.Now().Before(deadline) {
		l.mu.Lock()
		for _, raw := range l.msgs[measurements.LocalSamplesTopic] {
			var b batch
			_ = json.Unmarshal(raw, &b)
			for _, s := range b.Samples {
				got[s["point_key"].(string)] = s
			}
		}
		l.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	if s := got["custom.leistung"]; s == nil || s["decoded"] != -100.0 || s["raw"] != "fffffc18" || s["entity_id"] != "zaehler-1" {
		t.Fatalf("freies Register ueber Modbus TCP (-1000 * 0,1): %v", s)
	}
	if s := got["goe.api_v2.acp"]; s == nil || s["decoded"] != true || s["entity_id"] != "wallbox-1" {
		t.Fatalf("go-e ueber HTTP: %v", s)
	}
	quellen := map[string]bool{}
	for _, raw := range l.wait(t, datasourcestatus.Topic, 2, 5*time.Second) {
		var ev map[string]any
		_ = json.Unmarshal(raw, &ev)
		quellen[ev["id"].(string)] = true
	}
	if !quellen["DQ-Z"] || !quellen["DQ-G"] {
		t.Fatalf("Lese-Belege je Datenquelle: %v", quellen)
	}
}

// A SunSpec point is model-relative: the library walks the inverter's model
// chain first and reads the point at the discovered base - over the lane the
// poll uses, so the one-client device never sees two connections.
func TestTheLibraryDiscoversTheSunSpecModelsBeforeItReads(t *testing.T) {
	bild := schrammKaco(t, 0)
	sim := startHuaweiSim(t, bild)
	r := newRig(t, Options{Poll: 200 * time.Millisecond})
	l := r.listen(measurements.LocalStatusTopic, measurements.LocalSamplesTopic)
	host, port := sim.addr()
	raw, _ := json.Marshal(kacoSunSpecSel(host, port, nil))
	if err := r.bus.Publish("edge/inverter/config", raw, true); err != nil {
		t.Fatal(err)
	}
	r.wait("edge/telemetry", 1, 5*time.Second)
	r.messplan(4, map[string]any{"point_key": "sunspec.model_103.a", "cadence_s": 60})

	var status measurements.LocalStatus
	statuses := l.wait(t, measurements.LocalStatusTopic, 1, 5*time.Second)
	_ = json.Unmarshal(statuses[len(statuses)-1], &status)
	if len(status.Accepted) != 1 || len(status.Rejected) != 0 {
		t.Fatalf("Status %+v", status)
	}
	// Model 1 (header at 40002, 66 words) puts model 103 at base 40072; A is
	// its offset 2.
	if bild[40070] != 103 {
		t.Fatalf("Testbild: Modell 103 nicht an 40070 (%d)", bild[40070])
	}
	var b batch
	_ = json.Unmarshal(l.wait(t, measurements.LocalSamplesTopic, 1, 5*time.Second)[0], &b)
	if len(b.Samples) != 1 || b.Samples[0]["raw"] != float64(bild[40074]) || b.Samples[0]["decoded"] != nil {
		t.Fatalf("A an der erkannten Basis, roh ohne Skalierung (A_SF kennt die Laufzeit nicht): %v", b.Samples)
	}
	if n := sim.refused.Load(); n != 0 {
		t.Fatalf("%d zweite Verbindungen neben dem Poll", n)
	}
}

// The Shelly add-on sensors are the core's own points: Layer 1 neither reads
// nor judges them, so the core's verdict stands alone in the merged status.
func TestTheLibraryLeavesTheCoreOwnedShellySensorsToTheCore(t *testing.T) {
	r := newRig(t, Options{})
	l := r.listen(measurements.LocalStatusTopic)
	liveLV(r.sim)
	r.selectDeye("hybrid_3p", nil)
	r.messplan(5,
		map[string]any{"point_key": "shelly.gen2plus.temperature[*].tc", "cadence_s": 60, "entity_id": "heizstab-1"},
		map[string]any{"point_key": "deye.hybrid_3p.settings.battery-low-soc", "cadence_s": 300})
	var status measurements.LocalStatus
	statuses := l.wait(t, measurements.LocalStatusTopic, 1, 5*time.Second)
	_ = json.Unmarshal(statuses[len(statuses)-1], &status)
	if len(status.Accepted) != 1 || status.Accepted[0] != "deye.hybrid_3p.settings.battery-low-soc" || len(status.Rejected) != 0 {
		t.Fatalf("Status %+v", status)
	}
}
