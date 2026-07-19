package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"VP_CONFIG", "VP_PORTAL_BASE_URL", "VP_MQTT_HOST", "VP_MQTT_PORT", "VP_REF",
		"VP_DATA_DIR", "VP_LOCAL_MQTT_ADDR", "VP_HTTP_ADDR", "VP_MAX_CHARGE_KW",
		"VP_MAX_DISCHARGE_KW", "VP_SOC_MIN_PCT", "VP_SOC_MAX_PCT", "VP_BUFFER_HOURS",
		"VP_SETPOINT_INTERVAL_SECONDS", "VP_DEV_TENANT_ID", "VP_DEV_SITE_ID",
		"VP_DEV_DEVICE_ID", "VP_DEV_CLOUD_URL", "VP_DEV_INSECURE",
		"VP_CONTROL_ENABLED", "VP_GRID_CHARGE_ALLOWED", "VP_CONTROL_CERTIFIED_FAMILIES",
		"VP_RECONCILE_INTERVAL_SECONDS", "VP_UNCLAIM_CONFIRM_MINUTES", "VP_UNCLAIM_CONFIRM_POLLS",
	} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
}

func TestDefaults(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PortalBaseURL != "https://portal.voltpilot.de" {
		t.Errorf("portal default: %q", cfg.PortalBaseURL)
	}
	if cfg.MQTTHost != "mqtt.voltpilot.de" || cfg.MQTTPort != 8883 {
		t.Errorf("mqtt default: %s:%d", cfg.MQTTHost, cfg.MQTTPort)
	}
	if cfg.DataDir != "/data" || cfg.LocalMQTTAddr != ":1883" || cfg.HTTPAddr != ":8484" {
		t.Errorf("addr defaults: %+v", cfg)
	}
	if cfg.SocMinPct != 5 || cfg.SocMaxPct != 95 || cfg.MaxChargeKw != 50 || cfg.MaxDischargeKw != 50 {
		t.Errorf("guard defaults: %+v", cfg)
	}
	if cfg.BufferHours != 48 {
		t.Errorf("buffer default: %d", cfg.BufferHours)
	}
	if cfg.SetpointInterval != 10*time.Second {
		t.Errorf("setpoint interval default: %v", cfg.SetpointInterval)
	}
	if cfg.Ref != "" || cfg.DevIdentity() {
		t.Errorf("no ref / dev identity by default")
	}
}

func TestConfigFileThenEnvPrecedence(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(`{
		"portal_base_url": "https://portal.example.com",
		"ref": "VP-FILE-0001",
		"max_charge_kw": 11,
		"buffer_hours": 24
	}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VP_CONFIG", path)
	t.Setenv("VP_MAX_CHARGE_KW", "7.5") // env beats file

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PortalBaseURL != "https://portal.example.com" || cfg.Ref != "VP-FILE-0001" || cfg.BufferHours != 24 {
		t.Errorf("file values not applied: %+v", cfg)
	}
	if cfg.MaxChargeKw != 7.5 {
		t.Errorf("env must beat file: %v", cfg.MaxChargeKw)
	}
	if cfg.MQTTHost != "mqtt.voltpilot.de" {
		t.Errorf("untouched defaults must survive: %v", cfg.MQTTHost)
	}
}

func TestDataDirConfigFileConvention(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"ref":"aus-datadir"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VP_DATA_DIR", dir)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Ref != "aus-datadir" {
		t.Errorf("data-dir config.json not picked up: %q", cfg.Ref)
	}
	if cfg.DataDir != dir {
		t.Errorf("data dir env: %q", cfg.DataDir)
	}
}

func TestDevIdentity(t *testing.T) {
	clearEnv(t)
	t.Setenv("VP_DEV_TENANT_ID", "t")
	t.Setenv("VP_DEV_SITE_ID", "s")
	cfg, _ := Load()
	if cfg.DevIdentity() {
		t.Error("partial dev identity must not count")
	}
	t.Setenv("VP_DEV_DEVICE_ID", "d")
	cfg, _ = Load()
	if !cfg.DevIdentity() {
		t.Error("full dev identity must count")
	}
}

// The confirmed-unclaim knobs default GENEROUSLY (20 min / 4 polls) so a
// transient portal blip can never read as "device removed"; env overrides work
// and garbage/zero falls back to the defaults.
func TestUnclaimConfirmDefaultsAndEnv(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UnclaimConfirm != 20*time.Minute || cfg.UnclaimConfirmPolls != 4 {
		t.Errorf("unclaim-confirm defaults: %v / %d polls", cfg.UnclaimConfirm, cfg.UnclaimConfirmPolls)
	}

	t.Setenv("VP_UNCLAIM_CONFIRM_MINUTES", "45")
	t.Setenv("VP_UNCLAIM_CONFIRM_POLLS", "9")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UnclaimConfirm != 45*time.Minute || cfg.UnclaimConfirmPolls != 9 {
		t.Errorf("unclaim-confirm env override: %v / %d polls", cfg.UnclaimConfirm, cfg.UnclaimConfirmPolls)
	}

	// Zero/negative cannot disable the guard - it falls back to the defaults.
	t.Setenv("VP_UNCLAIM_CONFIRM_MINUTES", "0")
	t.Setenv("VP_UNCLAIM_CONFIRM_POLLS", "-1")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.UnclaimConfirm != 20*time.Minute || cfg.UnclaimConfirmPolls != 4 {
		t.Errorf("zero/negative must fall back to defaults: %v / %d polls", cfg.UnclaimConfirm, cfg.UnclaimConfirmPolls)
	}
}

func TestInvalidConfigFileFails(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	_ = os.WriteFile(path, []byte(`{nope`), 0o644)
	t.Setenv("VP_CONFIG", path)
	if _, err := Load(); err == nil {
		t.Error("malformed config file must fail loudly")
	}
}

func TestControlDefaultsOffAndCertifiedAllowlist(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ControlEnabled {
		t.Fatal("ControlEnabled must default false (kill-switch off)")
	}
	if cfg.GridChargeAllowed {
		t.Fatal("GridChargeAllowed must default false (EEG-compliant)")
	}
	if !cfg.ControlCertified("sunspec") {
		t.Fatal("sunspec must be certified by default")
	}
	if cfg.ControlCertified("hybrid_3p") {
		t.Fatal("Deye hybrid_3p must NOT be certified by default")
	}
	// An empty family (no selection / sim path) is treated as certified; the
	// Layer-1 adapter still enforces its own gate.
	if !cfg.ControlCertified("") {
		t.Fatal("empty family should be certified (dev/sim path)")
	}
}

func TestControlEnvOverrides(t *testing.T) {
	clearEnv(t)
	t.Setenv("VP_CONTROL_ENABLED", "true")
	t.Setenv("VP_GRID_CHARGE_ALLOWED", "1")
	t.Setenv("VP_CONTROL_CERTIFIED_FAMILIES", "sunspec, hybrid_3p")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.ControlEnabled || !cfg.GridChargeAllowed {
		t.Fatalf("env bools not applied: %+v", cfg)
	}
	if !cfg.ControlCertified("hybrid_3p") {
		t.Fatal("hybrid_3p should be certified after the env override")
	}
	if !cfg.ControlCertified("sunspec") {
		t.Fatal("sunspec should remain certified")
	}
	if cfg.ControlCertified("micro") {
		t.Fatal("micro should not be certified")
	}
}
