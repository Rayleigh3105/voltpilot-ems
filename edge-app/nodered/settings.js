/**
 * Node-RED settings for the VoltPilot Edge-App Layer 1 (the per-customer I/O
 * layer). The editor is LAN-only and behind auth: VOLTPILOT wires the flows
 * per customer - the customer never edits them (the local device web app on
 * the core agent is the customer-facing surface).
 *
 * Editor credentials: user "voltpilot", password from VP_NODERED_PASSWORD
 * (default "voltpilot" - CHANGE IT per installation, or provide a bcrypt
 * hash directly via VP_NODERED_PASSWORD_HASH).
 */
const bcrypt = require("bcryptjs");

const passwordHash =
  process.env.VP_NODERED_PASSWORD_HASH ||
  bcrypt.hashSync(process.env.VP_NODERED_PASSWORD || "voltpilot", 8);

module.exports = {
  flowFile: "flows.json",
  uiPort: process.env.NODE_RED_PORT || 1880,

  adminAuth: {
    type: "credentials",
    users: [
      {
        username: process.env.VP_NODERED_USER || "voltpilot",
        password: passwordHash,
        permissions: "*",
      },
    ],
  },

  logging: {
    console: {
      level: "info",
      metrics: false,
      audit: false,
    },
  },

  editorTheme: {
    projects: { enabled: false },
    header: { title: "VoltPilot Edge - I/O-Flows (Service-Zugang)" },
    tours: false,
  },
};
