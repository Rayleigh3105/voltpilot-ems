package agent

import (
	"encoding/json"
	"testing"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
)

func TestDelayedPrimaryTelemetryDoesNotInventFreshSourceReading(t *testing.T) {
	a := newGateTestAgent(t)
	now := time.Now().UTC()
	a.dataSourceStatus.Reconcile(entities.Registry{Entities: []entities.Entity{{
		ID: "primary", Type: entities.TypeBatteryHybrid,
		Driver: json.RawMessage(`{"data_source_id":"DQ-4"}`),
	}}}, now)
	readAt := now.Add(-10 * time.Minute).Truncate(time.Second)
	feedPrimaryAt(a, readAt, 1, 2, 3, 50)
	got := a.dataSourceStatus.Snapshot(now)[0]
	if got.Health != "stale" || got.ReadAt == nil || !got.ReadAt.Equal(readAt) || got.SamplesPerMin != 0 {
		t.Fatalf("delayed primary sample became fresh: %+v", got)
	}
}

func TestSourcePollBusAndShellyFeedSameCollector(t *testing.T) {
	a := &Agent{}
	now := time.Now()
	a.dataSourceStatus.Reconcile(entities.Registry{Entities: []entities.Entity{{ID: "e", EdgeSourceID: "src-a", Driver: json.RawMessage(`{"data_source_id":"DQ-4"}`)}}}, now)
	a.onDataSourcePoll("edge/data-sources/poll", []byte(`{"source_id":"src-a","event_id":"1","requests":2,"samples":3}`))
	got := a.dataSourceStatus.Snapshot(time.Now())[0]
	if got.Health != "ok" || got.ReadAt == nil || *got.RequestsPerMin != 2 {
		t.Fatal(got)
	}
	a.observeShellySource(sources.Source{DataSourceID: "DQ-4"}, 1, 0, &shelly.DriverError{Code: "unreachable"})
	got = a.dataSourceStatus.Snapshot(time.Now())[0]
	if got.Health != "stale" || got.ErrorClass != "unreachable" || got.Since == nil || *got.RequestsPerMin != 3 {
		t.Fatal(got)
	}
	a.onDataSourcePoll("edge/data-sources/poll", []byte(`{"id":"DQ-99","samples":1}`))
	if len(a.dataSourceStatus.Snapshot(time.Now())) != 1 {
		t.Fatal("unknown source admitted")
	}
}
