package agent

import (
	"context"
	"encoding/json"
	"errors"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/datasourcestatus"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/shelly"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/sources"
	"time"
)

func (a *Agent) onDataSourcePoll(_ string, payload []byte) {
	var event datasourcestatus.Event
	if json.Unmarshal(payload, &event) != nil {
		return
	}
	a.dataSourceStatus.Observe(event, time.Now())
}

// Count read HTTP operations, including dialect discovery, without changing the driver.
type sourceStatusDoer struct {
	inner    shelly.Doer
	requests int
}

func (d *sourceStatusDoer) Get(ctx context.Context, url string) (int, []byte, error) {
	d.requests++
	return d.inner.Get(ctx, url)
}
func (a *Agent) observeShellySource(s sources.Source, requests, samples int, err error) {
	event := datasourcestatus.Event{ID: s.DataSourceID, Requests: &requests, Samples: samples, Failed: err != nil}
	if event.ID == "" {
		event.SourceID = s.ID
	}
	var driverError *shelly.DriverError
	if errors.As(err, &driverError) {
		event.ErrorClass = driverError.Code
	}
	a.dataSourceStatus.Observe(event, time.Now())
}
