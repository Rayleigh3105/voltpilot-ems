// Unit tests for the PURE parts of the :8484 web app.
//
// Run:  node --test edge-app/core/internal/web/jstest/
// Offline, dependency-free, no browser. The static/*.js files are plain
// browser IIFEs (`(function (global) { ... })(window)`), so we load each one
// into a fresh `vm` context with a minimal window/document/localStorage stub
// and then exercise what it hangs off `window` - the same technique
// edge-app/nodered/flows-sync.test.js uses for the flow function nodes.
//
// VM-REALM GOTCHA (the flows-sync.test.js lesson): values built inside the vm
// carry that realm's Object/Array prototypes, so deepStrictEqual against outer
// values fails. Compare scalars, or JSON round-trip first.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const STATIC = path.join(__dirname, "..", "static");

// A localStorage stub: `blocked: true` models private mode / a disabled store,
// where every access throws (technik.js must degrade to "off", never crash).
function fakeStorage(initial, blocked) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem(k) {
      if (blocked) throw new Error("storage disabled");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (blocked) throw new Error("storage disabled");
      map.set(k, String(v));
    },
    _map: map
  };
}

function fakeDocument() {
  const classes = new Set();
  return {
    readyState: "complete",
    documentElement: {
      classList: {
        toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
        contains(name) { return classes.has(name); },
        _set: classes
      }
    },
    getElementById() { return null; },
    createElement() { return { style: {}, setAttribute() {}, appendChild() {} }; },
    addEventListener() {},
    querySelector() { return null; }
  };
}

// load runs one or more static/*.js files in ONE fresh context and returns the
// window object they attached themselves to.
function load(files, opts) {
  opts = opts || {};
  const win = {
    document: opts.document === null ? undefined : (opts.document || fakeDocument()),
    localStorage: opts.localStorage === undefined ? fakeStorage({}) : opts.localStorage,
    Intl,
    Date,
    Math,
    JSON,
    isNaN,
    setTimeout,
    addEventListener() {},
    dispatchEvent() {},
    isSecureContext: false
  };
  win.window = win;
  const ctx = vm.createContext(win);
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(STATIC, f), "utf8"), ctx, { filename: f });
  }
  return win;
}

/* ============================ Technikmodus ============================ */

test("Technikmodus is OFF on a fresh browser and survives a reload", () => {
  const store = fakeStorage({});
  const win = load(["technik.js"], { localStorage: store });
  const T = win.VPTechnik;

  // (a) fresh browser: nothing stored -> OFF, and nothing was written just by
  //     looking at it.
  assert.strictEqual(T.read(store), false, "default must be OFF");
  assert.strictEqual(T.enabled(), false);
  assert.strictEqual(win.document.documentElement.classList.contains("tech-on"), false);
  assert.strictEqual(store._map.size, 0, "reading must not write");

  // (b) the installer flips it once...
  T.set(true);
  assert.strictEqual(T.enabled(), true);
  assert.strictEqual(win.document.documentElement.classList.contains("tech-on"), true);
  assert.strictEqual(store._map.get(T.KEY), "1");

  // (c) ...and a page change / reload (a NEW context on the SAME store) keeps it.
  const win2 = load(["technik.js"], { localStorage: store });
  assert.strictEqual(win2.VPTechnik.enabled(), true, "must persist across pages");
  assert.strictEqual(win2.document.documentElement.classList.contains("tech-on"), true);

  // (d) turning it off persists too.
  win2.VPTechnik.set(false);
  assert.strictEqual(store._map.get(T.KEY), "0");
  assert.strictEqual(load(["technik.js"], { localStorage: store }).VPTechnik.enabled(), false);
});

test("Technikmodus degrades to OFF when storage is unavailable", () => {
  const blocked = fakeStorage({}, true);
  const win = load(["technik.js"], { localStorage: blocked });
  assert.strictEqual(win.VPTechnik.read(blocked), false);
  assert.doesNotThrow(() => win.VPTechnik.set(true), "a blocked store must never throw");
  assert.strictEqual(win.VPTechnik.enabled(), true, "the mode still applies, it just does not persist");
});

/* ======================= status.js: the CAUSE rule ======================= */

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
const iso = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

function statusFor(state) {
  return load(["status.js"]).VPStatus.derive(state, NOW);
}

const HEALTHY = {
  pairing_state: "verbunden",
  cloud_connected: true,
  inverter: { configured: true, label: "Deye SUN-30K" },
  inverter_link: "up",
  last_telemetry: iso(5),
  mode: "fahrplan"
};

test("status: a healthy plant says so and names what makes it healthy", () => {
  const v = statusFor(HEALTHY);
  assert.strictEqual(v.tone, "ok");
  assert.strictEqual(v.title, "Alles in Ordnung");
  assert.match(v.detail, /Anlage läuft/);
  assert.match(v.detail, /Portal verbunden/);
  assert.match(v.detail, /Fahrplan aktiv/);
  assert.strictEqual(v.cause, "", "an ok verdict has nothing to explain");
});

test("status: EVERY problem verdict carries a plain-German cause", () => {
  const cases = [
    ["no inverter", { ...HEALTHY, inverter: null }],
    ["never delivered", { ...HEALTHY, last_telemetry: undefined }],
    ["stale data", { ...HEALTHY, last_telemetry: iso(600) }],
    ["portal unreachable", { ...HEALTHY, pairing_state: "portal_nicht_erreichbar" }],
    ["key conflict", { ...HEALTHY, pairing_state: "schluessel_konflikt" }],
    ["removed in cloud", { ...HEALTHY, pairing_state: "geraet_entfernt" }],
    ["device error", { ...HEALTHY, pairing_state: "geraet_fehler" }],
    ["buffer overrun", { ...HEALTHY, cloud_connected: false, buffer_data_loss: true }],
    ["cloud down", { ...HEALTHY, cloud_connected: false, buffer_pending: 42 }],
    ["control blocked", { ...HEALTHY, control: { blocked: true, reason: "Nennleistung unbekannt." } }],
    ["control mismatch", {
      ...HEALTHY,
      control: { all_match: false, registers: [{ role: "battery_power", match: false }] }
    }]
  ];
  for (const [name, state] of cases) {
    const v = statusFor(state);
    assert.notStrictEqual(v.tone, "ok", `${name}: must not read as ok`);
    assert.ok(v.cause && v.cause.length > 20, `${name}: must name a cause, got ${JSON.stringify(v.cause)}`);
    assert.ok(v.title && v.title.length > 0, `${name}: must have a headline`);
  }
});

test("status: a blocked control plan repeats the core's own reason verbatim", () => {
  const reason = "Die Leistungsskalierung des Wechselrichters ist unbekannt.";
  const v = statusFor({ ...HEALTHY, control: { blocked: true, reason } });
  assert.strictEqual(v.cause, reason, "the cause must be the core's reason, not a paraphrase");
});

test("status: a stale reading beats a cloud outage (root cause first)", () => {
  const v = statusFor({ ...HEALTHY, last_telemetry: iso(3600), cloud_connected: false });
  assert.match(v.title, /Messwerte/);
});

/* ============ control.js: state layer vs. register layer ============ */

function controlFor(state) {
  return load(["control.js"]).VPControl.deriveState(state);
}

test("control: a blocked plan states its reason and shows NO register table", () => {
  const d = controlFor({
    inverter: { configured: true, label: "Deye" },
    control_certified: true,
    control_enabled: true,
    control: { blocked: true, reason: "Nennleistung unbekannt - bitte Modell prüfen." }
  });
  assert.strictEqual(d.text, "Nennleistung unbekannt - bitte Modell prüfen.");
  assert.strictEqual(d.chip.label, "angehalten");
  assert.strictEqual(d.showTable, false, "there is nothing to show, so the reason must carry it");
});

test("control: the branch order is unchanged (uncertified wins over blocked)", () => {
  const d = controlFor({
    inverter: { configured: true },
    control_certified: false,
    control: { blocked: true, reason: "irgendwas" }
  });
  assert.match(d.title, /noch nicht freigegeben/);
});

test("control: kill-switch off is stated before 'waiting for a readback'", () => {
  const d = controlFor({
    inverter: { configured: true }, control_certified: true, control_enabled: false
  });
  assert.match(d.title, /ausgeschaltet/);
  assert.match(d.text, /Not-Aus/);
});

test("control: a confirmed readback reads as steering, a mismatch names why", () => {
  const regs = [{ role: "battery_power", commanded_kw: -5, actual_kw: -5, match: true, addr: 1109 }];
  const ok = controlFor({
    inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: { all_match: true, registers: regs, source: "schedule" }
  });
  assert.strictEqual(ok.chip.tone, "ok");
  assert.strictEqual(ok.showTable, true);
  assert.strictEqual(ok.banner, null);

  const bad = controlFor({
    inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: { all_match: false, registers: regs, source: "schedule", possible_conflict: true }
  });
  assert.strictEqual(bad.chip.tone, "warn");
  assert.ok(bad.text.length > 40, "a mismatch must explain itself");
  assert.strictEqual(bad.banner, bad.text, "the banner repeats the same reason, never a different one");
});

test("control: an uncertified device WITH calibration evidence keeps its table", () => {
  const d = controlFor({
    inverter: { configured: true }, control_certified: false, control_enabled: true,
    control: { all_match: true, source: "calibration", registers: [{ role: "battery_power", match: true, addr: 1109 }] }
  });
  assert.strictEqual(d.calibrating, true);
  assert.strictEqual(d.showTable, true);
});

/* ================= commissioning.js: the guided flow ================= */

function stepsFor(state, sourceCount) {
  return load(["commissioning.js"]).VPCommissioning.derive(state, sourceCount || 0, NOW);
}

test("commissioning: a fresh device out of the box", () => {
  // Exactly what /api/state reports on a device that has just booted: nothing
  // configured, nothing delivered, the reference still withheld server-side.
  const res = stepsFor({
    pairing_state: "warte_auf_beanspruchung",
    cloud_connected: false,
    inverter: null,
    inverter_link: "",
    claim_unlocked: false
  });
  const [inv, src, portal, mess] = res.steps;

  assert.strictEqual(inv.state, "todo");
  assert.ok(inv.cause.includes("keine Messwerte"), inv.cause);
  assert.ok(inv.action && inv.action.href === "#wechselrichter");

  assert.strictEqual(src.state, "todo", "sources cannot be judged before the inverter works");

  assert.strictEqual(portal.state, "todo");
  assert.ok(portal.cause.includes("Referenz-ID"), "the lock must explain WHY it is locked");
  assert.strictEqual(portal.action, null, "a locked step offers no shortcut past the gate");

  assert.strictEqual(mess.state, "todo");
  assert.strictEqual(res.doneCount, 0);
  assert.strictEqual(res.activeNum, 1);
  assert.strictEqual(res.allDone, false);
});

test("commissioning: the progress counter names the OPEN step, not done+1", () => {
  // Inverter + sources + measurements fine, only the portal claim is missing:
  // three of four are done, but the step the operator must act on is 3.
  const res = stepsFor({
    pairing_state: "warte_auf_beanspruchung", cloud_connected: false,
    inverter: { configured: true, label: "Deye" }, inverter_link: "up",
    last_telemetry: iso(6), claim_unlocked: true
  }, 2);
  assert.strictEqual(res.doneCount, 3);
  assert.strictEqual(res.activeNum, 3, "'Schritt 4 von 4' while step 3 is open would be a lie");
  assert.strictEqual(res.allDone, false);
});

test("commissioning: a fully configured, running plant is all done and recedes", () => {
  const res = stepsFor({
    pairing_state: "verbunden",
    cloud_connected: true,
    inverter: { configured: true, label: "Deye SUN-30K" },
    inverter_link: "up",
    last_telemetry: iso(4),
    claim_unlocked: true
  }, 3);
  const [inv, src, portal, mess] = res.steps;

  assert.strictEqual(inv.state, "done");
  assert.ok(inv.detail.includes("Deye SUN-30K"));
  assert.strictEqual(src.state, "done");
  assert.ok(src.detail.includes("3"), src.detail);
  assert.strictEqual(portal.state, "done");
  assert.strictEqual(mess.state, "done");

  assert.strictEqual(res.doneCount, 4);
  assert.strictEqual(res.activeNum, null);
  assert.strictEqual(res.allDone, true, "all four done -> the block recedes to one green line");
  for (const s of res.steps) {
    assert.strictEqual(s.cause, "", `${s.key}: a done step must not nag`);
  }
});

test("commissioning: a single-inverter plant needs no sources and is NOT blocked by it", () => {
  const res = stepsFor({
    pairing_state: "verbunden", cloud_connected: true,
    inverter: { configured: true, label: "Fronius Eco" }, inverter_link: "up",
    last_telemetry: iso(10), claim_unlocked: true
  }, 0);
  assert.strictEqual(res.steps[1].state, "done");
  assert.ok(res.steps[1].cause.includes("Normalfall"), "it must say why zero is fine");
  assert.strictEqual(res.allDone, true);
});

test("commissioning: the honest in-between states name their cause", () => {
  // Inverter configured but silent -> step 1 active, and the portal step stays
  // locked because the SERVER withheld the reference (claim_unlocked=false).
  const silent = stepsFor({
    pairing_state: "warte_auf_beanspruchung", cloud_connected: false,
    inverter: { configured: true, label: "Deye SUN-30K" }, inverter_link: "down",
    claim_unlocked: false
  });
  assert.strictEqual(silent.steps[0].state, "active");
  assert.ok(silent.steps[0].cause.includes("antwortet nicht"), silent.steps[0].cause);
  assert.strictEqual(silent.steps[2].state, "todo");

  // Claimed, delivering, but the data went stale -> step 4 is BLOCKED and says
  // how long ago the last value came.
  const stale = stepsFor({
    pairing_state: "verbunden", cloud_connected: true,
    inverter: { configured: true, label: "Deye" }, inverter_link: "up",
    last_telemetry: iso(3 * 3600), claim_unlocked: true
  }, 1);
  assert.strictEqual(stale.steps[3].state, "blocked");
  assert.ok(stale.steps[3].cause.includes("Stunden"), stale.steps[3].cause);
  assert.strictEqual(stale.allDone, false);

  // Claimed but the cloud link dropped -> step 3 is active with the reason,
  // never a silent green tick.
  const offline = stepsFor({
    pairing_state: "cloud_getrennt", cloud_connected: false,
    inverter: { configured: true, label: "Deye" }, inverter_link: "up",
    last_telemetry: iso(5), claim_unlocked: true
  }, 1);
  assert.strictEqual(offline.steps[2].state, "active");
  assert.ok(offline.steps[2].cause.length > 20);
});
