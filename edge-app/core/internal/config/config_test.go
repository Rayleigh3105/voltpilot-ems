package config

import (
	"os"
	"path/filepath"
	"reflect"
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
		"VP_CALIBRATION_MAX_KW", "VP_CALIBRATION_TTL_SECONDS",
		"VP_OCPP_ENABLED", "VP_OCPP_PORT",
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

func TestCalibrationDefaultsAndEnv(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// The First-Light calibration envelope: a SMALL magnitude cap + a SHORT
	// auto-revert TTL. Both must default to safe values with no config.
	if cfg.CalibrationMaxKw != 1.0 {
		t.Errorf("calibration max default: %v (want 1.0 kW)", cfg.CalibrationMaxKw)
	}
	if cfg.CalibrationTTL != 30*time.Second {
		t.Errorf("calibration ttl default: %v (want 30s)", cfg.CalibrationTTL)
	}

	t.Setenv("VP_CALIBRATION_MAX_KW", "0.5")
	t.Setenv("VP_CALIBRATION_TTL_SECONDS", "15")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CalibrationMaxKw != 0.5 || cfg.CalibrationTTL != 15*time.Second {
		t.Errorf("calibration env override: %v / %v", cfg.CalibrationMaxKw, cfg.CalibrationTTL)
	}

	// Zero/negative/garbage cannot widen or disable the envelope - it falls back
	// to the safe defaults (a calibration write is never unbounded).
	t.Setenv("VP_CALIBRATION_MAX_KW", "0")
	t.Setenv("VP_CALIBRATION_TTL_SECONDS", "-5")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CalibrationMaxKw != 1.0 || cfg.CalibrationTTL != 30*time.Second {
		t.Errorf("zero/negative must fall back to safe defaults: %v / %v", cfg.CalibrationMaxKw, cfg.CalibrationTTL)
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

func TestControlDefaultsOnButAllowlistIsThePerDeviceGate(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	// ON by default (owner decision). Safe ONLY because the certification allowlist
	// is the real per-device gate (checked below): control_enabled on edge/setpoint
	// is ControlEnabled AND ControlCertified(family), so an uncertified family never
	// writes even with the global switch on.
	if !cfg.ControlEnabled {
		t.Fatal("ControlEnabled must default TRUE (owner decision; the allowlist gates per device)")
	}
	if cfg.GridChargeAllowed {
		t.Fatal("GridChargeAllowed must default false (EEG-compliant)")
	}
	if !cfg.ControlCertified("sunspec") {
		t.Fatal("sunspec must be certified by default")
	}
	// THE safety spine: the pilot Deye family must stay OUT of the allowlist, so no
	// live Deye write happens despite control being ON by default.
	if cfg.ControlCertified("hybrid_3p") {
		t.Fatal("Deye hybrid_3p must NOT be certified by default (no live inverter write)")
	}
	if cfg.ControlCertified("hybrid_1p") {
		t.Fatal("Deye hybrid_1p must NOT be certified by default")
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

// ⚠ DER EINMAL-SCHREIBPFAD HAT KEIN FLAG MEHR (Captain-Korrektur 20.08.2026).
// Es gibt keine Armierung je Box, also darf auch keine Umgebungsvariable ihn
// wieder schliessen: eine Box, die "VP_INSTALLER_WRITE_ENABLED=false" gesetzt
// hat, verhaelt sich zeichengleich wie jede andere. Der plattformweite Hebel
// ist der Cloud-Not-Aus (voltpilot.register-write.enabled am api), die Tore
// sind Betreiber-Kennwort, Identitaet, Fenster, LAN-Whitelist,
// Selbstkonflikt-Sperre und Einmaligkeit.
func TestTheOneShotWritePathHasNoEnvironmentSwitchLeft(t *testing.T) {
	clearEnv(t)
	for _, v := range []string{"false", "FALSE", "0", "true", "ja"} {
		t.Setenv("VP_INSTALLER_WRITE_ENABLED", v)
		cfg, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		// Es gibt kein Feld mehr, das der Wert treffen koennte; der Beweis ist,
		// dass die geladene Konfiguration byte-gleich zu der ohne die Variable
		// bleibt.
		os.Unsetenv("VP_INSTALLER_WRITE_ENABLED")
		bare, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(cfg, bare) {
			t.Fatalf("%q must change nothing, got a different config", v)
		}
	}
}

// Der Ladepunkt-Server ist seit dem 24.08.2026 per Vorgabe AN (Captain-Order:
// "Ich will das auf der Box OCPP immer angeschalten ist automatisch, ohne .env
// brauch ich nicht") - und er bleibt ein OPT-OUT, kein Zwang: ein Betreiber
// muss ihn abschalten koennen.
//
// ⚠ Der Zugangs-Zaun war nie dieser Schalter, sondern die FREIGABELISTE: eine
// nicht eingetragene Kennung wird schon beim Websocket-Upgrade abgewiesen, und
// eine frische Box hat eine LEERE Liste. Die LEBENDE Zuteilung braucht
// weiterhin zusaetzlich VP_CONTROL_ENABLED und VP_CONSUMER_CONTROL_ENABLED -
// daran aendert die Vorgabe nichts, und genau das nagelt dieser Test fest.
func TestOcppDefaultsOnAndStaysAnOptOut(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.OcppEnabled {
		t.Fatal("der Ladepunkt-Server muss ohne jede .env laufen")
	}
	if cfg.OcppPort != 8887 {
		t.Fatalf("ocpp port default: %d", cfg.OcppPort)
	}
	// Die zwei Tore der LEBENDEN Zuteilung sind unberuehrt: der
	// Verbraucher-Schalter bleibt per Vorgabe AUS.
	if cfg.ConsumerControlEnabled {
		t.Fatal("die lebende Zuteilung darf durch die OCPP-Vorgabe nicht scharf werden")
	}

	t.Setenv("VP_OCPP_ENABLED", "false")
	off, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if off.OcppEnabled {
		t.Fatal("ein ausdrueckliches false muss gewinnen - sonst waere es kein Opt-out")
	}
}
