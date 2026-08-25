package agent

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"

	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/cloud"
	"git.tecmaxx.de/mamotec/voltpilot-ems/edge-app/core/internal/measurements"
)

// onMeasurementConfig is the cloud-to-local desired-state bridge. Persistence
// precedes the retained local publish; Node-RED therefore sees either the old
// complete plan or the new complete plan, never a partially applied selection.
func (a *Agent) onMeasurementConfig(payload []byte) {
	a.measurementMu.Lock()
	defer a.measurementMu.Unlock()
	cfg, err := measurements.ParseConfig(payload, a.measurementIdentity, a.measurementRevision)
	if err != nil {
		if err.Error() != "stale revision" {
			slog.Warn("measurement config rejected", "err", err)
		}
		return
	}
	tmp := filepath.Join(a.Cfg.DataDir, "measurement-config.json.tmp")
	path := filepath.Join(a.Cfg.DataDir, "measurement-config.json")
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		slog.Error("measurement config persist failed", "err", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		slog.Error("measurement config atomic replace failed", "err", err)
		return
	}
	if err := a.Bus.Publish(measurements.LocalConfigTopic, payload, true); err != nil {
		slog.Error("measurement config local publish failed", "err", err)
		return
	}
	a.measurementRevision, a.measurementConfig = cfg.Revision, append([]byte(nil), payload...)
}

func (a *Agent) onMeasurementStatus(_ string, payload []byte) {
	a.measurementMu.Lock()
	id := a.measurementIdentity
	a.measurementMu.Unlock()
	raw, err := measurements.WrapStatus(payload, id, Version)
	if err != nil {
		slog.Warn("local measurement status rejected", "err", err)
		return
	}
	// A status produced during a WAN outage must not disappear. Persist the
	// already identity-bound cloud envelope before attempting transport; the
	// connection callback republishes it retained after every reconnect.
	tmp := filepath.Join(a.Cfg.DataDir, "measurement-status.json.tmp")
	path := filepath.Join(a.Cfg.DataDir, "measurement-status.json")
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		slog.Warn("measurement status persist failed", "err", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		slog.Warn("measurement status atomic replace failed", "err", err)
		return
	}
	a.linkMu.Lock()
	link := a.link
	a.linkMu.Unlock()
	if link == nil || !link.Connected() {
		return
	} // retained config is replayed; Node-RED re-acks.
	if err := link.PublishMeasurementConfigStatus(raw); err != nil {
		slog.Warn("measurement status publish failed", "err", err)
	}
}

func (a *Agent) republishMeasurementStatus(link *cloud.Link) {
	raw, err := os.ReadFile(filepath.Join(a.Cfg.DataDir, "measurement-status.json"))
	if os.IsNotExist(err) {
		return
	}
	if err != nil {
		slog.Warn("stored measurement status unreadable", "err", err)
		return
	}
	if err := link.PublishMeasurementConfigStatus(raw); err != nil {
		slog.Warn("stored measurement status reconnect publish failed", "err", err)
	}
}

func (a *Agent) onMeasurementSamples(_ string, payload []byte) {
	a.measurementMu.Lock()
	id := a.measurementIdentity
	a.measurementMu.Unlock()
	if id.DeviceID == "" {
		return
	}
	if _, err := a.measurementOutbox.Append(payload, id); err != nil {
		slog.Warn("local measurement batch rejected", "err", err)
		return
	}
	a.kick()
}

func (a *Agent) setMeasurementIdentity(tenant, site, device string) {
	a.measurementMu.Lock()
	a.measurementIdentity = measurements.Identity{TenantID: tenant, SiteID: site, DeviceID: device}
	stored := append([]byte(nil), a.measurementConfig...)
	a.measurementMu.Unlock()
	if len(stored) == 0 || a.Bus == nil {
		return
	}
	var identity struct {
		TenantID string `json:"tenant_id"`
		SiteID   string `json:"site_id"`
		DeviceID string `json:"device_id"`
	}
	if json.Unmarshal(stored, &identity) == nil && identity.TenantID == tenant && identity.SiteID == site && identity.DeviceID == device {
		if err := a.Bus.Publish(measurements.LocalConfigTopic, stored, true); err != nil {
			slog.Warn("measurement config boot republish failed", "err", err)
		}
	}
}
