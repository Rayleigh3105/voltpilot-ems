/**
 * Node-RED settings for the Voltpilot-EMS edge (thin by design).
 *
 * Minimal dev settings: load flows.json, keep the editor admin UI on the
 * default port. The production edge is containerised (ARM+x86), uses mTLS MQTT
 * with an x.509 device identity, exposes NO inbound ports, and is delivered via
 * Mender OTA (A/B + rollback). See architecture section 6.
 */
module.exports = {
  flowFile: "flows.json",
  uiPort: process.env.NODE_RED_PORT || 1880,
  // Device identity + battery envelope, injected at provisioning time via env.
  // Defaults mirror the dev seed in infra/local/timescale/01-init.sql so the
  // edge runs against the local stack out of the box.
  functionGlobalContext: {
    ids: {
      tenant: process.env.VP_TENANT_ID || "00000000-0000-0000-0000-000000000001",
      site: process.env.VP_SITE_ID || "00000000-0000-0000-0000-000000000002",
      device: process.env.VP_DEVICE_ID || "00000000-0000-0000-0000-000000000003",
    },
    assetLimits: {
      capacity_kwh: Number(process.env.VP_BATT_CAPACITY_KWH || 100),
      max_charge_kw: Number(process.env.VP_BATT_MAX_CHARGE_KW || 50),
      max_discharge_kw: Number(process.env.VP_BATT_MAX_DISCHARGE_KW || 50),
      soc_min_pct: Number(process.env.VP_SOC_MIN_PCT || 10),
      soc_max_pct: Number(process.env.VP_SOC_MAX_PCT || 95),
    },
  },
  logging: {
    console: {
      level: "info",
      metrics: false,
      audit: false,
    },
  },
  // The edge only makes OUTBOUND MQTT connections; broker/identity are injected
  // via env/config at provisioning time.
  editorTheme: {
    projects: { enabled: false },
  },
};
