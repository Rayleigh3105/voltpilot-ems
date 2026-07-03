// Package config loads the core agent configuration.
//
// Precedence: environment variables > config file (JSON) > defaults.
// The design goal is "kinderleicht": a device with NO configuration at all
// boots with sensible defaults, generates a persistent reference and shows it
// in the local web app; the only thing a customer ever needs is that
// reference.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config is the full agent configuration. JSON field names double as the
// config-file schema; every field has a VP_* environment override.
type Config struct {
	// PortalBaseURL is the HTTPS base of the VoltPilot portal/api used for
	// first-boot enrollment (POST /api/v1/enrollment/{ref}/csr + poll).
	PortalBaseURL string `json:"portal_base_url"`
	// MQTTHost/MQTTPort are the DEFAULT cloud broker endpoint. The enrollment
	// response carries the authoritative host/port; these are the fallback
	// (and what pre-enrollment UI copy shows).
	MQTTHost string `json:"mqtt_host"`
	MQTTPort int    `json:"mqtt_port"`
	// Ref is the device reference (Edge-Referenz). Empty = the agent
	// generates a persistent one on first boot and stores it in the data dir.
	Ref string `json:"ref"`
	// DataDir holds identity, certs, the telemetry buffer and the cached plan.
	DataDir string `json:"data_dir"`

	// LocalMQTTAddr is the listen address of the embedded local bus that
	// Layer 1 (Node-RED) connects to.
	LocalMQTTAddr string `json:"local_mqtt_addr"`
	// HTTPAddr is the listen address of the local web app + health endpoint.
	HTTPAddr string `json:"http_addr"`

	// Guard limits. Per-customer wiring sets the real battery values; the
	// defaults mirror the dev seed battery so a demo setup behaves sanely.
	MaxChargeKw    float64 `json:"max_charge_kw"`
	MaxDischargeKw float64 `json:"max_discharge_kw"`
	SocMinPct      float64 `json:"soc_min_pct"`
	SocMaxPct      float64 `json:"soc_max_pct"`

	// BufferHours bounds the on-disk telemetry ring buffer (oldest-first
	// eviction beyond this horizon).
	BufferHours int `json:"buffer_hours"`

	// SetpointInterval is how often the current setpoint is recomputed and
	// re-published on the local bus (the slot boundary is always hit).
	SetpointInterval time.Duration `json:"-"`
	// SetpointIntervalSeconds is the config-file/env form of SetpointInterval.
	SetpointIntervalSeconds int `json:"setpoint_interval_seconds"`

	// ReconcileInterval is how often an enrolled device re-checks its identity
	// against the portal while connected, so a re-claim (which mints a new
	// device row id and re-issues the certificate) is adopted automatically
	// instead of the edge publishing under a stale device_id forever.
	ReconcileInterval time.Duration `json:"-"`
	// ReconcileIntervalSeconds is the config-file/env form of ReconcileInterval.
	ReconcileIntervalSeconds int `json:"reconcile_interval_seconds"`

	// Dev-only escape hatches (mirrors tools/edge-simulator): a fixed
	// identity skips enrollment, and a plain-MQTT cloud URL skips mTLS.
	// NEVER set these on a customer device.
	DevTenantID string `json:"dev_tenant_id"`
	DevSiteID   string `json:"dev_site_id"`
	DevDeviceID string `json:"dev_device_id"`
	DevCloudURL string `json:"dev_cloud_url"`
	DevInsecure bool   `json:"dev_insecure"`
}

// Defaults returns the built-in configuration.
func Defaults() Config {
	return Config{
		PortalBaseURL:            "https://voltpilot.de",
		MQTTHost:                 "mqtt.voltpilot.de",
		MQTTPort:                 8883,
		DataDir:                  "/data",
		LocalMQTTAddr:            ":1883",
		HTTPAddr:                 ":8484",
		MaxChargeKw:              50,
		MaxDischargeKw:           50,
		SocMinPct:                5,
		SocMaxPct:                95,
		BufferHours:              48,
		SetpointIntervalSeconds:  10,
		ReconcileIntervalSeconds: 300,
	}
}

// Load builds the effective config: defaults, overlaid by the JSON config
// file (path from VP_CONFIG, default <no file>), overlaid by VP_* env vars.
func Load() (Config, error) {
	cfg := Defaults()

	path := os.Getenv("VP_CONFIG")
	if path == "" {
		// Convention: a config.json inside the data dir (if present) is
		// picked up without any env needed.
		if dd := os.Getenv("VP_DATA_DIR"); dd != "" {
			path = dd + "/config.json"
		} else {
			path = cfg.DataDir + "/config.json"
		}
		if _, err := os.Stat(path); err != nil {
			path = ""
		}
	}
	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return cfg, fmt.Errorf("config file %s: %w", path, err)
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			return cfg, fmt.Errorf("config file %s: %w", path, err)
		}
	}

	applyEnv(&cfg)

	if cfg.SetpointIntervalSeconds <= 0 {
		cfg.SetpointIntervalSeconds = Defaults().SetpointIntervalSeconds
	}
	cfg.SetpointInterval = time.Duration(cfg.SetpointIntervalSeconds) * time.Second
	if cfg.ReconcileIntervalSeconds <= 0 {
		cfg.ReconcileIntervalSeconds = Defaults().ReconcileIntervalSeconds
	}
	cfg.ReconcileInterval = time.Duration(cfg.ReconcileIntervalSeconds) * time.Second
	if cfg.BufferHours <= 0 {
		cfg.BufferHours = Defaults().BufferHours
	}
	return cfg, nil
}

func applyEnv(cfg *Config) {
	str := func(key string, dst *string) {
		if v := os.Getenv(key); v != "" {
			*dst = v
		}
	}
	num := func(key string, dst *int) {
		if v := os.Getenv(key); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				*dst = n
			}
		}
	}
	f64 := func(key string, dst *float64) {
		if v := os.Getenv(key); v != "" {
			if n, err := strconv.ParseFloat(v, 64); err == nil {
				*dst = n
			}
		}
	}
	str("VP_PORTAL_BASE_URL", &cfg.PortalBaseURL)
	str("VP_MQTT_HOST", &cfg.MQTTHost)
	num("VP_MQTT_PORT", &cfg.MQTTPort)
	str("VP_REF", &cfg.Ref)
	str("VP_DATA_DIR", &cfg.DataDir)
	str("VP_LOCAL_MQTT_ADDR", &cfg.LocalMQTTAddr)
	str("VP_HTTP_ADDR", &cfg.HTTPAddr)
	f64("VP_MAX_CHARGE_KW", &cfg.MaxChargeKw)
	f64("VP_MAX_DISCHARGE_KW", &cfg.MaxDischargeKw)
	f64("VP_SOC_MIN_PCT", &cfg.SocMinPct)
	f64("VP_SOC_MAX_PCT", &cfg.SocMaxPct)
	num("VP_BUFFER_HOURS", &cfg.BufferHours)
	num("VP_SETPOINT_INTERVAL_SECONDS", &cfg.SetpointIntervalSeconds)
	num("VP_RECONCILE_INTERVAL_SECONDS", &cfg.ReconcileIntervalSeconds)
	str("VP_DEV_TENANT_ID", &cfg.DevTenantID)
	str("VP_DEV_SITE_ID", &cfg.DevSiteID)
	str("VP_DEV_DEVICE_ID", &cfg.DevDeviceID)
	str("VP_DEV_CLOUD_URL", &cfg.DevCloudURL)
	if v := os.Getenv("VP_DEV_INSECURE"); v == "1" || v == "true" {
		cfg.DevInsecure = true
	}
}

// DevIdentity reports whether a full dev identity is configured (all three
// UUIDs) - in that case enrollment is skipped entirely.
func (c Config) DevIdentity() bool {
	return c.DevTenantID != "" && c.DevSiteID != "" && c.DevDeviceID != ""
}
