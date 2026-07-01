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
  functionGlobalContext: {},
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
