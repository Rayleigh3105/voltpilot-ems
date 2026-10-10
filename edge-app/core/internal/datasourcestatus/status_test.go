package datasourcestatus

import (
	"encoding/json"
	"fmt"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestSharedVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/contracts/v2/data-source-status-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name      string
			StartedAt time.Time `json:"started_at"`
			Registry  entities.Registry
			Events    []Event
			At        time.Time
			Expected  []Status
		}
	}
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors.Cases {
		t.Run(v.Name, func(t *testing.T) {
			var c Collector
			c.Reconcile(v.Registry, v.StartedAt)
			for _, e := range v.Events {
				c.Observe(e, v.At)
			}
			got := c.Snapshot(v.At)
			if !reflect.DeepEqual(got, v.Expected) {
				t.Fatalf("got %+v; want %+v", got, v.Expected)
			}
		})
	}
}
func TestCompleteSetRenameRemovalAndMoreThanSixteen(t *testing.T) {
	now := time.Now()
	var c Collector
	var reg entities.Registry
	for i := 0; i < 20; i++ {
		reg.Entities = append(reg.Entities, entities.Entity{ID: fmt.Sprint(i), Driver: json.RawMessage(fmt.Sprintf(`{"data_source_id":"DQ-%d"}`, i))})
	}
	c.Reconcile(reg, now)
	c.Observe(Event{EntityID: "1", Samples: 2}, now)
	reg.Entities[1].Label = "new name"
	c.Reconcile(reg, now.Add(time.Second))
	if got := c.Snapshot(now); len(got) != 20 {
		t.Fatalf("truncated to %d", len(got))
	}
	if got := c.Snapshot(now)[1]; got.Health != "ok" {
		t.Fatal("rename lost history", got)
	}
	c.Reconcile(entities.Registry{}, now)
	if len(c.Snapshot(now)) != 0 {
		t.Fatal("removed source retained")
	}
	c.Observe(Event{ID: "DQ-1", Samples: 1}, now)
	if len(c.Snapshot(now)) != 0 {
		t.Fatal("unassigned source recreated")
	}
}

func TestQoSReplayDoesNotInflateRatesAndFutureTimeIsNotCurrent(t *testing.T) {
	now := time.Now().UTC()
	var c Collector
	c.Reconcile(entities.Registry{Entities: []entities.Entity{{ID: "a", Driver: json.RawMessage(`{"data_source_id":"DQ-4"}`)}}}, now)
	requests := 1
	e := Event{ID: "DQ-4", EventID: "once", Ts: now, Requests: &requests, Samples: 2}
	c.Observe(e, now)
	c.Observe(e, now)
	e.EventID = "future"
	e.Ts = now.Add(time.Hour)
	c.Observe(e, now)
	got := c.Snapshot(now)[0]
	if got.SamplesPerMin != 2 || *got.RequestsPerMin != 1 {
		t.Fatal(got)
	}
}
