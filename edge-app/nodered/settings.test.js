// S2 fail-closed guard: the Node-RED editor is a LAN-exposed admin surface,
// so settings.js must REFUSE to load without an operator-set password - an
// unset VP_NODERED_PASSWORD or the historical default "voltpilot" throws
// (Node-RED then exits instead of starting with known credentials). The
// refusal happens BEFORE any require, so it cannot be masked by a missing
// bcryptjs. Run: node --test edge-app/nodered/settings.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const SETTINGS = path.join(__dirname, "settings.js");
const ENV_KEYS = ["VP_NODERED_PASSWORD", "VP_NODERED_PASSWORD_HASH", "VP_NODERED_USER"];

// Loads settings.js fresh under exactly the given VP_* env, restoring the
// process env + require cache afterwards.
function loadSettings(env) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve(SETTINGS)];
  try {
    return require(SETTINGS);
  } finally {
    delete require.cache[require.resolve(SETTINGS)];
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("unset VP_NODERED_PASSWORD refuses to start (fail closed)", () => {
  assert.throws(() => loadSettings({}), /VP_NODERED_PASSWORD/);
});

test("the historical default password 'voltpilot' refuses to start", () => {
  assert.throws(
    () => loadSettings({ VP_NODERED_PASSWORD: "voltpilot" }),
    /voltpilot/
  );
});

test("a provided bcrypt hash is accepted verbatim (no bcryptjs needed)", () => {
  const hash = "$2a$08$abcdefghijklmnopqrstuvwxyz0123456789012345678901234";
  const settings = loadSettings({ VP_NODERED_PASSWORD_HASH: hash });
  assert.strictEqual(settings.adminAuth.users[0].password, hash);
  assert.strictEqual(settings.adminAuth.users[0].username, "voltpilot");
});

test("a real non-default password is hashed and accepted", (t) => {
  try {
    require.resolve("bcryptjs");
  } catch {
    t.skip("bcryptjs not installed in this checkout (present in the image)");
    return;
  }
  const settings = loadSettings({ VP_NODERED_PASSWORD: "ein-eigenes-passwort" });
  assert.match(settings.adminAuth.users[0].password, /^\$2[aby]\$/);
});
