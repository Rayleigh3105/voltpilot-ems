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
	"strings"
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

	// ControlEnabled is the GLOBAL inverter-control kill-switch (report §6.6).
	// Default TRUE (owner decision, vp-batctl-generic-r4): control is ON by
	// default. This is safe ONLY because the CERTIFICATION ALLOWLIST is the real
	// per-device gate: control_enabled on edge/setpoint is (ControlEnabled AND
	// ControlCertified(family)), so an UNCERTIFIED family emits control_enabled=
	// false and Layer 1 writes NOTHING. The pilot inverters (Deye hybrid_*,
	// Fronius) are deliberately NOT in ControlCertifiedFamilies, so no live
	// inverter write happens until a per-model bench pass adds the family to the
	// allowlist (CONTROL-BENCH.md). VP_CONTROL_ENABLED=false is the global stop.
	ControlEnabled bool `json:"control_enabled"`
	// ConsumerControlEnabled is the CONSUMER-control master switch
	// (Verbrauchssteuerung §19 Inkrement 5, the VP_CONSUMER_CONTROL_ENABLED
	// flag), distinct from the battery/inverter ControlEnabled above. The
	// consumer control path (the go-e consumer executor + the manual override
	// forward) is gated on (ControlEnabled AND ConsumerControlEnabled). Default
	// FALSE: with all four consumer flags off the edge never issues a consumer
	// command, so a plant behaves byte-for-byte as before this feature; the
	// runbook turns it on per plant after the pilot. VP_CONTROL_ENABLED still
	// wins as the global stop.
	ConsumerControlEnabled bool `json:"consumer_control_enabled"`
	// NativeSelfRegulationEnabled is the operator's own switch for the NATIVE
	// SELF-REGULATION (Selbstregel-Modus): in a slot the cloud marked worth
	// covering from the battery, hand the setpoint back to the inverter's own
	// self-consumption loop instead of writing a recomputed watt value every
	// 10 s (guards/nativemode.go).
	//
	// Default TRUE - an OPT-OUT, like VP_OCPP_ENABLED, and for the same reason:
	// a default-OFF flag would have to be carried into every deployment to have
	// any effect, and the documented failure mode of that pattern is that it is
	// forgotten. THE REAL GATE IS ELSEWHERE and is not weakened by this default:
	// Layer 1 refuses the native primitive unless THIS exact model+firmware
	// carries a bench certificate (edge-app/nodered/unplanned-load-native.js,
	// whose production catalog is EMPTY), and the core withdraws an intent that
	// is never confirmed. So on every device shipped today the mode simply never
	// engages, and this switch exists for the case the two gates cannot answer:
	// rolling one plant back to the proven 10-second follower without touching
	// the image, the certificate or the plan.
	NativeSelfRegulationEnabled bool `json:"native_self_regulation_enabled"`
	// ControlCertifiedFamilies is the per-model bench-certification allowlist,
	// keyed by register-map family (report §6.7). Only a selected inverter whose
	// family is listed here may ever receive a live write, AND only when
	// ControlEnabled is also true. Default "sunspec" (proven against the
	// simulator); a Deye family is added ONLY after its model is bench-verified.
	ControlCertifiedFamilies []string `json:"control_certified_families"`
	// OcppEnabled is the OCPP-Ladepunkt feature flag (VP_OCPP_ENABLED, default
	// TRUE since 2026-08-24 - a Captain decision: "Ich will das auf der Box OCPP
	// immer angeschalten ist automatisch, ohne .env brauch ich nicht". Binding a
	// charge point must not need an .env edit on the device.
	//
	// It stays an OPT-OUT, not a constant: an operator must be able to switch
	// the server off (the VP_OTA_PRUNE pattern - default on, an explicit `false`
	// wins). Setting it false is byte-for-byte the pre-feature box.
	//
	// ⚠ WHY DEFAULT-ON IS SAFE, and none of it changed with the default:
	//   - The ALLOWLIST is the gate, not this flag. An unregistered
	//     ChargePointId is refused at the WEBSOCKET UPGRADE (csms
	//     SetNewChargingStationValidationHandler) and logged loudly; no handler
	//     ever runs for it, and with an empty allowlist NOTHING is admitted.
	//   - The LAN boundary is unchanged: compose port mapping + host firewall,
	//     exactly like :8484 and the Node-RED editor (see OcppPort).
	//   - The LIVE allocation still needs ControlEnabled AND
	//     ConsumerControlEnabled. This flag only ever starts a SERVER and
	//     deposits the two PROTECTIVE profiles, which only ever REDUCE.
	//
	// It is INDEPENDENT of ControlEnabled / ConsumerControlEnabled on purpose:
	// those two gate writes to an inverter and to a consumer device; this one
	// gates a SERVER the stations dial, and its own dead-man's switch lives in
	// the OCPP charging profiles.
	OcppEnabled bool `json:"ocpp_enabled"`
	// OcppPort is the LAN port the charge points connect to
	// (ws://<box>:<port>/ocpp/<ChargePointId>). 8887 is the OCPP-J convention.
	//
	// ⚠ LAN-ONLY posture, same as :8484 and the Node-RED editor: the library
	// binds every interface, so the compose port mapping + the host firewall
	// are the boundary. The second boundary is the ID allowlist (chargers.json)
	// — an unregistered station is refused at the websocket upgrade.
	OcppPort int `json:"ocpp_port"`

	// GridChargeAllowed permits the (Deye ToU) grid-charge bit. Default FALSE =
	// EEG-compliant (an EEG plant must never grid-charge). Authoritatively the
	// site's netzladen_erlaubt flag; kept off by default on-device.
	GridChargeAllowed bool `json:"grid_charge_allowed"`

	// CalibrationMaxKw is the HARD magnitude cap for the First-Light calibration
	// step (the very first real write to a live customer battery, done BEFORE the
	// family is certified): a calibration test setpoint is capped to
	// [-CalibrationMaxKw, +CalibrationMaxKw] and then re-clamped through the guard
	// chain, so the surface can physically never command more than this. Small on
	// purpose (report §5.7 "write a SMALL value ... never write a large forced
	// value first"). VP_CALIBRATION_MAX_KW; garbage/<=0 falls back to the default.
	CalibrationMaxKw float64 `json:"calibration_max_kw"`
	// CalibrationTTL is the auto-revert window: EVERY calibration write reverts to
	// neutral (release) after this long, enforced by a controller-owned watchdog
	// even if the UI is closed or the socket drops - the write NEVER latches.
	CalibrationTTL time.Duration `json:"-"`
	// CalibrationTTLSeconds is the config-file/env form of CalibrationTTL.
	// VP_CALIBRATION_TTL_SECONDS; garbage/<=0 falls back to the default.
	CalibrationTTLSeconds int `json:"calibration_ttl_seconds"`
	// CalibrationAdminSecret gates the calibration MUTATION endpoints (arm/disarm,
	// start test, abort, corrections, certify, decertify). The :8484 surface has no
	// user model, so this is a single self-contained admin token/password read from
	// env/config; it needs no cloud and works offline. When set, the web layer rejects
	// unauthenticated calibration mutations server-side (HTTP 401) and the card prompts
	// for it; every OTHER surface and all read-only views stay open. EMPTY (the default)
	// = no gate, unchanged behaviour - so an existing device is never locked out on
	// upgrade; the owner opts in by setting VP_CALIBRATION_ADMIN_SECRET.
	// SECURITY SEAM: a broader access model (edge token vs. cloud role) is an open
	// product decision; this token is the calibration-scoped stopgap the owner asked
	// for and slots in here without touching any other endpoint.
	CalibrationAdminSecret string `json:"calibration_admin_secret"`

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

	// UnclaimConfirm is how long an enrolled device must see an UNINTERRUPTED
	// run of definitive clean-404 "not claimed" answers from a REACHABLE portal
	// before it concludes it was removed (unclaimed) in the cloud and enters
	// the honest geraet_entfernt state (pause cloud publish + buffering, keep
	// polling for a re-claim). Deliberately GENEROUS: dial errors / timeouts /
	// 5xx never count and reset the run, so a transient outage can never trip
	// it. UnclaimConfirmPolls additionally requires that many consecutive
	// clean-404 polls, whichever bound is reached LAST.
	UnclaimConfirm time.Duration `json:"-"`
	// UnclaimConfirmMinutes is the config-file/env form of UnclaimConfirm.
	UnclaimConfirmMinutes int `json:"unclaim_confirm_minutes"`
	// UnclaimConfirmPolls is the minimum number of consecutive clean-404 polls.
	UnclaimConfirmPolls int `json:"unclaim_confirm_polls"`

	// MirrorAdvertisePort is the HOST port of the Modbus-Datenspiegel as the
	// compose maps it ("${VP_MIRROR_PORT:-502}:1502") - the :8484 card shows
	// "<geraet>:<this port>" for the installer to copy. It does NOT change
	// where the mirror listens (container port, mirror.json); it only keeps
	// the displayed endpoint truthful when the operator remaps the host port.
	MirrorAdvertisePort int `json:"mirror_advertise_port"`

	// NodeRedAdminURL is the Node-RED Admin API base for E2 flow deployment
	// (e.g. "http://nodered:1880"). EMPTY = flow deployment disabled: a
	// received deployment set is verified + persisted but acked 'error' with a
	// German detail naming this setting, never silently dropped.
	NodeRedAdminURL string `json:"nodered_admin_url"`

	// FlowNodeStatusEnabled turns the additive per-flow-node status block on the
	// status heartbeat ON (Portal v3 M5 Part C). Default OFF: the block is
	// additive and feature-flagged, so an edge that does not send it simply
	// makes the portal editor fall back to channel values only - it never shows
	// a guessed node state. VP_FLOW_NODE_STATUS_ENABLED=1.
	FlowNodeStatusEnabled bool `json:"flow_node_status_enabled"`
	// NodeRedUser/NodeRedPassword are the Admin API credentials (the same
	// adminAuth the compose passes the nodered service).
	NodeRedUser     string `json:"nodered_user"`
	NodeRedPassword string `json:"nodered_password"`

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
		// The portal/api lives on the `portal.` subdomain in the real
		// deployment (docker-compose defaults + install.sh + DEPLOY.md all use
		// https://portal.voltpilot.de). The bare apex https://voltpilot.de is
		// NOT a working enrollment endpoint - shipping it as the default made a
		// device with no VP_PORTAL_BASE_URL fail to enroll. Keep this in lockstep
		// with edge-app/docker-compose.yml VP_PORTAL_BASE_URL.
		PortalBaseURL:               "https://portal.voltpilot.de",
		MQTTHost:                    "mqtt.voltpilot.de",
		MQTTPort:                    8883,
		DataDir:                     "/data",
		LocalMQTTAddr:               ":1883",
		HTTPAddr:                    ":8484",
		MaxChargeKw:                 50,
		MaxDischargeKw:              50,
		SocMinPct:                   5,
		SocMaxPct:                   95,
		BufferHours:                 48,
		SetpointIntervalSeconds:     10,
		ReconcileIntervalSeconds:    300,
		UnclaimConfirmMinutes:       20,
		UnclaimConfirmPolls:         4,
		ControlEnabled:              true, // ON by default; the certification allowlist is the per-device gate
		NativeSelfRegulationEnabled: true, // opt-out; the Layer-1 capability catalog is the real gate
		ControlCertifiedFamilies:    []string{"sunspec"},
		GridChargeAllowed:           false,
		OcppEnabled:                 true, // opt-OUT since 2026-08-24; the allowlist is the gate, not this flag
		OcppPort:                    8887,
		CalibrationMaxKw:            1.0,              // small: the first live write must be tiny (report §5.7)
		CalibrationTTLSeconds:       30,               // auto-revert to neutral fast; the write never latches
		CalibrationTTL:              30 * time.Second, // derived; Load() recomputes it from the seconds
		MirrorAdvertisePort:         502,              // lockstep with the compose mapping ${VP_MIRROR_PORT:-502}:1502
		NodeRedUser:                 "voltpilot",
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
	if cfg.UnclaimConfirmMinutes <= 0 {
		cfg.UnclaimConfirmMinutes = Defaults().UnclaimConfirmMinutes
	}
	cfg.UnclaimConfirm = time.Duration(cfg.UnclaimConfirmMinutes) * time.Minute
	if cfg.UnclaimConfirmPolls <= 0 {
		cfg.UnclaimConfirmPolls = Defaults().UnclaimConfirmPolls
	}
	if cfg.BufferHours <= 0 {
		cfg.BufferHours = Defaults().BufferHours
	}
	if len(cfg.ControlCertifiedFamilies) == 0 {
		cfg.ControlCertifiedFamilies = Defaults().ControlCertifiedFamilies
	}
	if cfg.CalibrationMaxKw <= 0 {
		cfg.CalibrationMaxKw = Defaults().CalibrationMaxKw
	}
	if cfg.CalibrationTTLSeconds <= 0 {
		cfg.CalibrationTTLSeconds = Defaults().CalibrationTTLSeconds
	}
	cfg.CalibrationTTL = time.Duration(cfg.CalibrationTTLSeconds) * time.Second
	if cfg.MirrorAdvertisePort <= 0 || cfg.MirrorAdvertisePort > 65535 {
		cfg.MirrorAdvertisePort = Defaults().MirrorAdvertisePort
	}
	return cfg, nil
}

// ControlCertified reports whether the given register-map family is on the
// bench-certification allowlist. Uncertified families are read-only regardless
// of the kill-switch. An empty family (no inverter selected yet, e.g. the dev /
// simulator path) is treated as certified: the Layer-1 control adapter still
// enforces its own per-family gate, and a real device always has a selection.
func (c Config) ControlCertified(family string) bool {
	family = strings.TrimSpace(family)
	if family == "" {
		return true
	}
	for _, f := range c.ControlCertifiedFamilies {
		if strings.EqualFold(strings.TrimSpace(f), family) {
			return true
		}
	}
	return false
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
	num("VP_UNCLAIM_CONFIRM_MINUTES", &cfg.UnclaimConfirmMinutes)
	num("VP_UNCLAIM_CONFIRM_POLLS", &cfg.UnclaimConfirmPolls)
	f64("VP_CALIBRATION_MAX_KW", &cfg.CalibrationMaxKw)
	num("VP_CALIBRATION_TTL_SECONDS", &cfg.CalibrationTTLSeconds)
	str("VP_CALIBRATION_ADMIN_SECRET", &cfg.CalibrationAdminSecret)
	num("VP_MIRROR_PORT", &cfg.MirrorAdvertisePort)
	boolEnv := func(key string, dst *bool) {
		if v := os.Getenv(key); v != "" {
			*dst = v == "1" || strings.EqualFold(v, "true")
		}
	}
	boolEnv("VP_CONTROL_ENABLED", &cfg.ControlEnabled)
	boolEnv("VP_NATIVE_SELF_REGULATION_ENABLED", &cfg.NativeSelfRegulationEnabled)
	boolEnv("VP_CONSUMER_CONTROL_ENABLED", &cfg.ConsumerControlEnabled)
	boolEnv("VP_GRID_CHARGE_ALLOWED", &cfg.GridChargeAllowed)
	boolEnv("VP_OCPP_ENABLED", &cfg.OcppEnabled)
	num("VP_OCPP_PORT", &cfg.OcppPort)
	boolEnv("VP_FLOW_NODE_STATUS_ENABLED", &cfg.FlowNodeStatusEnabled)
	str("VP_NODERED_ADMIN_URL", &cfg.NodeRedAdminURL)
	str("VP_NODERED_USER", &cfg.NodeRedUser)
	str("VP_NODERED_PASSWORD", &cfg.NodeRedPassword)
	if v := os.Getenv("VP_CONTROL_CERTIFIED_FAMILIES"); v != "" {
		var fams []string
		for _, f := range strings.Split(v, ",") {
			if f = strings.TrimSpace(f); f != "" {
				fams = append(fams, f)
			}
		}
		cfg.ControlCertifiedFamilies = fams
	}
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
