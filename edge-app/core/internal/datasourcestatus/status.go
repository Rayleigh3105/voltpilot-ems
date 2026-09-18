// Package datasourcestatus collects read evidence, never inferring identity from a connection.
package datasourcestatus

import (
	"encoding/json"
	"regexp"
	"sort"
	"sync"
	"time"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/entities"
)

const Topic = "edge/data-sources/poll"

var identifier = regexp.MustCompile(`^[A-Z0-9./-]{2,16}$`)

func ErrorClass(s string) string {
	switch s {
	case "unreachable", "no_answer", "invalid_response", "implausible", "fronius_api", "timeout", "layout_changed", "budget":
		return s
	}
	return ""
}

type Status struct {
	ID             string     `json:"id"`
	Health         string     `json:"health"`
	ErrorClass     string     `json:"error_class,omitempty"`
	Since          *time.Time `json:"since,omitempty"`
	ReadAt         *time.Time `json:"read_at,omitempty"`
	RequestsPerMin *int       `json:"requests_per_min"`
	SamplesPerMin  int        `json:"samples_per_min"`
}

// Event counts actual requests and accepted samples; failures may carry no known class.
type Event struct {
	ID         string    `json:"id"`
	EntityID   string    `json:"entity_id"`
	SourceID   string    `json:"source_id"`
	Ts         time.Time `json:"ts"`
	EventID    string    `json:"event_id"`
	ErrorClass string    `json:"error_class"`
	Failed     bool      `json:"failed"`
	Requests   *int      `json:"requests"`
	Samples    int       `json:"samples"`
}
type observation struct {
	at                time.Time
	requests, samples int
}
type entry struct {
	Status
	cadence       time.Duration
	lastEvent     time.Time
	window        []observation
	requestsKnown bool
	seen          map[string]time.Time
}
type Collector struct {
	mu                sync.Mutex
	entries           map[string]*entry
	entities, sources map[string]string
}

// Reconcile replaces the complete source set. Removing an assignment removes its status.
func (c *Collector) Reconcile(reg entities.Registry, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	next := map[string]*entry{}
	byEntity := map[string]string{}
	bySource := map[string]string{}
	bind := func(local, id string) {
		if existing, ok := bySource[local]; ok && existing != id {
			bySource[local] = ""
		} else {
			bySource[local] = id
		}
	}
	for _, e := range reg.Entities {
		var driver struct {
			ID       string `json:"data_source_id"`
			Interval int    `json:"interval_s"`
		}
		if json.Unmarshal(e.Driver, &driver) != nil || !identifier.MatchString(driver.ID) {
			continue
		}
		row := c.entries[driver.ID]
		if row == nil {
			since := now.UTC()
			row = &entry{Status: Status{ID: driver.ID, Health: "never", Since: &since}}
		}
		cadence := time.Duration(driver.Interval) * time.Second
		if cadence < 5*time.Second {
			cadence = 5 * time.Second
		}
		if old := next[driver.ID]; old != nil && old.cadence < cadence {
			cadence = old.cadence
		}
		row.cadence = cadence
		next[driver.ID] = row
		byEntity[e.ID] = driver.ID
		if e.Type == entities.TypeBatteryHybrid && e.EdgeSourceID == "" {
			bind("inverter", driver.ID)
		}
		if e.EdgeSourceID != "" {
			bind(e.EdgeSourceID, driver.ID)
		}
	}
	c.entries, c.entities, c.sources = next, byEntity, bySource
}
func (c *Collector) Observe(e Event, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := e.ID
	if e.EntityID != "" {
		id = c.entities[e.EntityID]
	} else if e.SourceID != "" {
		id = c.sources[e.SourceID]
	}
	row := c.entries[id]
	if row == nil || e.Samples < 0 || e.Samples > 10000 || (e.Requests != nil && (*e.Requests < 0 || *e.Requests > 10000)) {
		return
	}
	at := e.Ts.UTC()
	if at.IsZero() {
		at = now.UTC()
	}
	// Ignore delayed / replayed messages and future sender clocks.
	if at.Before(row.lastEvent) || at.After(now.Add(5*time.Second)) {
		return
	}
	if e.EventID != "" {
		if _, seen := row.seen[e.EventID]; seen {
			return
		}
		if row.seen == nil {
			row.seen = map[string]time.Time{}
		}
		row.seen[e.EventID] = at
	}
	row.lastEvent = at
	requests := 0
	if e.Requests != nil {
		requests = *e.Requests
		row.requestsKnown = true
	}
	row.window = append(row.window, observation{at, requests, e.Samples})
	failed := e.Failed || e.ErrorClass != ""
	if failed {
		if row.Health == "ok" {
			since := at
			row.Since = &since
		}
		if row.ReadAt != nil {
			row.Health = "stale"
		}
		row.ErrorClass = ErrorClass(e.ErrorClass)
	} else if e.Samples > 0 {
		row.Health, row.ErrorClass, row.Since, row.ReadAt = "ok", "", nil, &at
	}
}
func (c *Collector) Snapshot(now time.Time) []Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Status, 0, len(c.entries))
	for _, row := range c.entries {
		tolerance := 3 * row.cadence
		if tolerance < 300*time.Second {
			tolerance = 300 * time.Second
		}
		if row.Health == "ok" && row.ReadAt != nil && now.Sub(*row.ReadAt) > tolerance {
			since := row.ReadAt.Add(tolerance)
			row.Health, row.Since, row.ErrorClass = "stale", &since, ""
		}
		requests := 0
		row.SamplesPerMin = 0
		window := row.window[:0]
		for _, e := range row.window {
			if e.at.After(now.Add(-time.Minute)) {
				window = append(window, e)
				requests += e.requests
				row.SamplesPerMin += e.samples
			}
		}
		row.window = window
		for id, at := range row.seen {
			if !at.After(now.Add(-time.Minute)) {
				delete(row.seen, id)
			}
		}
		if row.requestsKnown {
			row.RequestsPerMin = &requests
		}
		out = append(out, row.Status)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
