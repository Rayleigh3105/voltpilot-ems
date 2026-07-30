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
    control: { all_match: false, registers: regs, source: "schedule", possible_conflict: true, mismatch_roles: ["max_sell_power"] }
  });
  assert.strictEqual(bad.chip.tone, "warn");
  assert.ok(bad.text.length > 40, "a mismatch must explain itself");
  // ONE message, ONE place (live Pilsting 2026-07-28): the reason lives in `text`
  // only - the extra banner used to render the SAME paragraph twice on one card.
  assert.strictEqual(bad.banner, null, "no duplicated in-card banner");
  assert.match(bad.stateKey, /^mismatch:max_sell_power$/, "keyed by the mismatching registers");
});

// --- the FLAP fix (live Pilsting, 2026-07-30) ---------------------------------
//
// The card reads the CORE's debounced `confirm` state, so a single deviating
// readback cycle - and a cycle the inverter never answered at all - is not a
// warning. `confirm` absent = an older core, then the pre-fix reading applies
// (proven by the test above, which sends no `confirm`).
test("control: a flickering cycle keeps the confirmed state AND its 'seit' stamp", () => {
  const regs = [{ role: "remote_watchdog", commanded_raw: 60, actual_raw: 57, match: true, verdict: "held" }];
  const base = { inverter: { configured: true }, control_certified: true, control_enabled: true };
  const held = controlFor({ ...base, control: { confirm: "held", all_match: true, registers: regs, source: "schedule" } });
  const checking = controlFor({
    ...base,
    control: { confirm: "checking", all_match: true, mismatch_cycles: 1, registers: regs, source: "schedule" },
  });
  assert.strictEqual(checking.chip.tone, "ok", "one deviating cycle is noise, not a fault");
  assert.strictEqual(checking.stateKey, held.stateKey, "and the 'Zustand seit' stamp must not move");
});

test("control: no answer from the inverter is its OWN calm state, never 'nicht übernommen'", () => {
  // The live shape: every register unread, actual_raw null, all_match null.
  const regs = [
    { role: "remote_watchdog", commanded_raw: 60, actual_raw: null, match: false, verdict: "unread" },
    { role: "remote_mode", commanded_raw: 1, actual_raw: null, match: false, verdict: "unread" },
  ];
  const d = controlFor({
    inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: {
      confirm: "no_answer", all_match: null, registers: regs, source: "schedule",
      unread_roles: ["remote_watchdog", "remote_mode"], unconfirmed_cycles: 7,
    },
  });
  assert.strictEqual(d.chip.tone, "warn", "sustained silence is visible");
  assert.ok(!/nicht übernommen|hält den Sollwert nicht/.test(d.text),
    "but it must NOT claim the inverter refused the setpoint: " + d.text);
  assert.match(d.text, /antwortet|Bestätigung/, "it names the real cause");
  assert.strictEqual(d.stateKey, "no-answer");
  assert.strictEqual(d.showTable, true, "the register evidence stays available");
});

test("status hero: an unanswered readback says 'keine Bestätigung', a confirmed refusal says 'übernimmt nicht'", () => {
  const regs = [{ role: "remote_mode", commanded_raw: 1, actual_raw: null, match: false, verdict: "unread" }];
  const silent = statusFor({ ...HEALTHY, control: { confirm: "no_answer", all_match: null, registers: regs } });
  assert.strictEqual(silent.tone, "warn");
  assert.match(silent.title, /Keine Bestätigung/);
  assert.ok(!/übernimmt den Sollwert nicht/.test(silent.title + silent.cause), "no false accusation");
  assert.match(silent.cause, /Steuerung & Bestätigung/, "and it points at the ONE full explanation");

  const flicker = statusFor({ ...HEALTHY, control: { confirm: "checking", all_match: true, mismatch_cycles: 1, registers: regs } });
  assert.strictEqual(flicker.tone, "ok", "a single deviating cycle must not raise the hero");

  const real = statusFor({ ...HEALTHY, control: { confirm: "not_held", all_match: false, mismatch_roles: ["remote_mode"], registers: regs } });
  assert.strictEqual(real.tone, "warn");
  assert.match(real.title, /übernimmt den Sollwert nicht/);
  assert.match(real.cause, /remote_mode/);
});

test("groups: only a CONFIRMED control problem opens the Steuerung group", () => {
  const G = groupsApi();
  const regs = [{ role: "remote_mode", commanded_raw: 1, actual_raw: null, match: false, verdict: "unread" }];
  const base = { inverter: { configured: true }, control_certified: true, control_enabled: true };
  assert.strictEqual(
    G.steuerungSummary({ ...base, control: { confirm: "checking", all_match: true, mismatch_cycles: 1, registers: regs } }).problemKey,
    null, "a flicker never opens the group",
  );
  assert.strictEqual(
    G.steuerungSummary({ ...base, control: { confirm: "no_answer", all_match: null, registers: regs } }).problemKey,
    "no_answer", "sustained silence has its own key (one message, not a mismatch claim)",
  );
  assert.match(
    G.steuerungSummary({ ...base, control: { confirm: "not_held", all_match: false, mismatch_roles: ["remote_mode"], registers: regs } }).problemKey,
    /^mismatch:remote_mode$/,
  );
});

test("control: every derived state carries a stable stateKey for the 'seit' stamp", () => {
  const keys = [
    controlFor({ inverter: { configured: false } }),
    controlFor({ inverter: { configured: true }, control_certified: false }),
    controlFor({ inverter: { configured: true }, control_certified: true, control_enabled: false }),
    controlFor({ inverter: { configured: true }, control_certified: true, control_enabled: true,
      control: { blocked: true, reason: "Steuerpfad noch unbestätigt", registers: [] } }),
    controlFor({ inverter: { configured: true }, control_certified: true, control_enabled: true }),
    controlFor({ inverter: { configured: true }, control_certified: true, control_enabled: true,
      control: { all_match: true, registers: [{ role: "battery_power", match: true, addr: 1109 }], source: "schedule" } }),
  ].map((d) => d.stateKey);
  assert.ok(keys.every((k) => typeof k === "string" && k.length > 0), "every branch is keyed: " + JSON.stringify(keys));
  assert.strictEqual(new Set(keys).size, keys.length, "distinct states have distinct keys");
  // a DIFFERENT blocked reason is a DIFFERENT state (its own 'seit'), the same one is not
  const b1 = controlFor({ inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: { blocked: true, reason: "A", registers: [] } });
  const b2 = controlFor({ inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: { blocked: true, reason: "B", registers: [] } });
  assert.notStrictEqual(b1.stateKey, b2.stateKey);
});

test("control: trackStateSince keeps the FIRST-seen time while the state holds (no 10s slideshow)", () => {
  const track = load(["control.js"]).VPControl.trackStateSince;
  let rec = track(null, "mismatch:max_sell_power", 1000);
  assert.strictEqual(rec.key, "mismatch:max_sell_power");
  assert.strictEqual(rec.at, 1000);
  // the same state re-derived on every ~10 s readback tick: the record (and thus
  // the rendered "Zustand seit …") does not move - the SAME object comes back.
  for (let t = 2000; t <= 60000; t += 10000) {
    const next = track(rec, "mismatch:max_sell_power", t);
    assert.strictEqual(next, rec, "an unchanged state never re-stamps");
  }
  // a state CHANGE re-stamps once
  const changed = track(rec, "ok", 70000);
  assert.strictEqual(changed.key, "ok");
  assert.strictEqual(changed.at, 70000);
});

test("status: the hero mismatch is a short pointer, not the card's full paragraph", () => {
  const d = statusFor({ ...HEALTHY, control: {
    registers: [{ role: "max_sell_power", match: false, addr: 143 }],
    all_match: false, possible_conflict: true, mismatch_roles: ["max_sell_power"],
    conflict_reason: "Der Wechselrichter hält den geschriebenen Sollwert nicht (max_sell_power). Möglicher Konflikt: die eigene Smart-Steuerung des Wechselrichters oder ein zweites EMS könnte gegensteuern - VoltPilot muss der einzige Controller sein."
  } });
  assert.strictEqual(d.tone, "warn");
  assert.match(d.cause, /max_sell_power/, "the cause NAMES the register that is not held");
  assert.match(d.cause, /Steuerung & Bestätigung/, "and points at the ONE full explanation");
  assert.ok(!/einzige Controller/.test(d.cause), "the full conflict paragraph lives on the card only");
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

/* ============ groups.js: the four Einrichten accordion groups ============ */

function groupsApi() {
  return load(["groups.js"]).VPGroups;
}

// The steady state of a fully commissioned, healthy plant - what the reworked
// page must render as exactly four QUIET rows.
const G_STATE = {
  server_now_ms: NOW,
  pairing_state: "verbunden",
  cloud_connected: true,
  inverter: { configured: true, label: "Deye SUN-30K" },
  inverter_connected: true,
  last_telemetry: iso(5),
  control_certified: true,
  control_enabled: true,
  control: { all_match: true, registers: [{ role: "battery_power", match: true, addr: 1109 }], source: "schedule" },
  curtail_units: [{ source_id: "u1", certified: false }],
  mode: "fahrplan"
};
const G_SOURCES = [
  { id: "s1", role: "pv-generation", label: "Fronius Anlage", capacity_kwp: 40 },
  { id: "s2", role: "pv-generation", label: "Fronius WR 2", capacity_kwp: 30 }
];
const G_OK = { s1: "ok", s2: "ok" };

test("groups: a healthy plant is four quiet rows - nothing auto-opens", () => {
  const G = groupsApi();

  const anlage = G.anlageSummary(G_STATE, G_SOURCES, G_OK, NOW);
  assert.strictEqual(anlage.tone, "ok");
  assert.match(anlage.text, /Deye SUN-30K/);
  assert.match(anlage.text, /2 Erzeuger/);
  assert.match(anlage.text, /70 kWp/);
  assert.match(anlage.text, /alle liefern/);
  assert.strictEqual(anlage.problemKey, null);

  const st = G.steuerungSummary(G_STATE);
  assert.strictEqual(st.text, "Batterie freigegeben · Abregelung nicht freigegeben");
  assert.strictEqual(st.problemKey, null);

  const dfOff = G.datenfreigabeSummary({ enabled: false }, "192.168.0.10");
  assert.strictEqual(dfOff.text, "Aus");
  assert.strictEqual(dfOff.tone, "off");
  const dfOn = G.datenfreigabeSummary({ enabled: true, running: true, advertise_port: 502 }, "192.168.0.10");
  assert.strictEqual(dfOn.text, "An · 192.168.0.10:502 · nur Lesen");
  assert.strictEqual(dfOn.tone, "ok");
  assert.strictEqual(dfOn.problemKey, null);

  const adv = G.erweitertSummary();
  assert.match(adv.text, /Daten löschen/);
  assert.strictEqual(adv.problemKey, null);

  // No problem key anywhere -> no group opens itself. Healthy = all closed.
  for (const sum of [anlage, st, dfOn, adv]) {
    assert.strictEqual(G.shouldAutoOpen(null, sum.problemKey), false);
  }
});

test("groups: a source that stops delivering turns Anlage amber and opens it ONCE", () => {
  const G = groupsApi();
  const warn = G.anlageSummary(G_STATE, G_SOURCES, { s1: "ok", s2: "warn" }, NOW);
  assert.strictEqual(warn.tone, "warn");
  assert.match(warn.text, /Fronius WR 2: keine aktuellen Daten/);
  assert.ok(warn.problemKey, "a stopped source is a problem the group must open for");

  // The problem appears -> open. The SAME standing problem re-derived on every
  // poll tick never re-opens a group the operator closed; a DIFFERENT one does.
  assert.strictEqual(G.shouldAutoOpen(null, warn.problemKey), true);
  assert.strictEqual(G.shouldAutoOpen(warn.problemKey, warn.problemKey), false);
  const other = G.anlageSummary(G_STATE, G_SOURCES, { s1: "warn", s2: "ok" }, NOW);
  assert.strictEqual(G.shouldAutoOpen(warn.problemKey, other.problemKey), true);

  // A stale PRIMARY inverter is a problem too.
  const staleInv = G.anlageSummary({ ...G_STATE, last_telemetry: iso(600) }, [], {}, NOW);
  assert.strictEqual(staleInv.tone, "warn");
  assert.ok(staleInv.problemKey);
});

test("groups: waiting for first data is calm - never an alarm, never auto-open", () => {
  const G = groupsApi();
  const pending = G.anlageSummary(G_STATE, G_SOURCES, { s1: "ok", s2: "pending" }, NOW);
  assert.strictEqual(pending.tone, "off");
  assert.match(pending.text, /wartet auf Daten/);
  assert.strictEqual(pending.problemKey, null);

  // Nothing configured yet: the guided flow leads the page; the group stays a
  // quiet pointer instead of a second nagging voice.
  const unconfigured = G.anlageSummary({ inverter: null }, [], {}, NOW);
  assert.strictEqual(unconfigured.tone, "off");
  assert.strictEqual(unconfigured.problemKey, null);
});

test("groups: the Steuerung row carries release facts + dot - the warning message lives ONCE, on the card, with its seit stamp", () => {
  const G = groupsApi();
  const mismatch = {
    ...G_STATE,
    control: {
      all_match: false, source: "schedule", possible_conflict: true,
      mismatch_roles: ["max_sell_power"],
      registers: [{ role: "max_sell_power", match: false, addr: 143 }]
    }
  };
  const sum = G.steuerungSummary(mismatch);
  assert.strictEqual(sum.tone, "warn");
  assert.match(sum.problemKey, /^mismatch:max_sell_power$/);
  // The row must NOT duplicate the warning paragraph (one message, one place).
  assert.ok(!/Sollwert|Abweichung|Konflikt/.test(sum.text), sum.text);
  assert.match(sum.text, /Batterie freigegeben/);

  // The ONE message: control.js's derived card text, stamped stable by
  // trackStateSince ("Zustand seit HH:MM") - pinned in the control tests above.
  const VPC = load(["control.js"]).VPControl;
  const card = VPC.deriveState(mismatch);
  assert.ok(card.text.length > 40, "the card carries the full reason");
  assert.strictEqual(card.stateKey, "mismatch:max_sell_power");
  const rec = VPC.trackStateSince(null, card.stateKey, 1000);
  assert.strictEqual(VPC.trackStateSince(rec, card.stateKey, 99999), rec,
    "the seit stamp holds while the state holds");

  // A blocked plan opens the group; the reason itself stays on the card.
  const blocked = G.steuerungSummary({ ...G_STATE, control: { blocked: true, reason: "Nennleistung unbekannt." } });
  assert.match(blocked.problemKey, /^blocked:/);
  assert.ok(!blocked.text.includes("Nennleistung"), "the reason renders on the card, not the row");

  // Non-release is a NORMAL state (read-only sites): quiet, never auto-open.
  const readOnly = G.steuerungSummary({ ...G_STATE, control_certified: false, control: null });
  assert.strictEqual(readOnly.text, "Batterie nicht freigegeben · Abregelung nicht freigegeben");
  assert.strictEqual(readOnly.problemKey, null);

  // A running calibration is named (the operator armed it deliberately).
  const cal = G.steuerungSummary({ ...G_STATE, mode: "kalibrierung" });
  assert.match(cal.text, /Kalibrierung läuft/);
});

test("groups: a curtailment override/blocked unit opens Steuerung", () => {
  const G = groupsApi();
  const override = G.steuerungSummary({
    ...G_STATE,
    curtail_units: [{ source_id: "u1", certified: true, possible_override: true }]
  });
  assert.strictEqual(override.tone, "warn");
  assert.match(override.problemKey, /^curtail-override:/);
  assert.match(override.text, /Abregelung freigegeben/);
});

test("groups: only a mirror ERROR opens Datenfreigabe", () => {
  const G = groupsApi();
  const err = G.datenfreigabeSummary({ enabled: true, error: "listen tcp :1502: in use" }, "10.0.0.5");
  assert.strictEqual(err.tone, "warn");
  assert.ok(err.problemKey);
  const starting = G.datenfreigabeSummary({ enabled: true, running: false }, "10.0.0.5");
  assert.strictEqual(starting.problemKey, null, "a transient start is not an alarm");
});

test("groups: legacy deep-link anchors map into their owning group", () => {
  const G = groupsApi();
  assert.strictEqual(G.groupForAnchor("wechselrichter"), "anlage");
  assert.strictEqual(G.groupForAnchor("quellen"), "anlage");
  assert.strictEqual(G.groupForAnchor("steuerung"), "steuerung");
  assert.strictEqual(G.groupForAnchor("datenfreigabe"), "datenfreigabe");
  assert.strictEqual(G.groupForAnchor("messwerte"), "erweitert");
  assert.strictEqual(G.groupForAnchor("portal"), null, "the pairing block is not inside the accordion");
});

/* ============ control.js: PV curtailment (Fronius) state layer ============ */

function curtailFor(state) {
  return load(["control.js"]).VPControl.deriveCurtail(state);
}

test("curtail: no units -> section absent (older build / no Fronius sources)", () => {
  assert.strictEqual(curtailFor({}), null);
  assert.strictEqual(curtailFor({ curtail_units: [] }), null);
});

test("curtail: observed-only units state the honesty sentence (planned is not executed)", () => {
  const d = curtailFor({
    curtail_units: [{ source_id: "src-1", unit_key: "k1", applied: false, mode: "apply", certified: false }]
  });
  assert.strictEqual(d.tone, "muted");
  assert.match(d.title, /noch nicht freigegeben/);
  assert.match(d.text, /NICHT ausgeführt/);
});

test("curtail: an applied + confirmed cap reads as active curtailment with the summed kW", () => {
  const d = curtailFor({
    curtail_units: [
      { source_id: "a", unit_key: "k1", applied: true, mode: "apply", cap_kw: 8.2, all_match: true },
      { source_id: "b", unit_key: "k2", applied: true, mode: "apply", cap_kw: 9.8, all_match: true }
    ]
  });
  assert.strictEqual(d.tone, "ok");
  assert.match(d.title, /begrenzt die PV-Einspeisung/);
  assert.match(d.text, /18,0\s*kW/);
});

test("curtail: a possible override names the CAUSE in normal mode and wins over everything", () => {
  const d = curtailFor({
    curtail_units: [
      { source_id: "a", unit_key: "k1", applied: true, mode: "apply", cap_kw: 8, all_match: true },
      {
        source_id: "b", unit_key: "k2", applied: true, mode: "apply", cap_kw: 9, all_match: true,
        possible_override: true, enforcement_status: "possible_override",
        override_reason: "Der Wechselrichter liefert 20 kW trotz Begrenzung auf 9 kW."
      }
    ]
  });
  assert.strictEqual(d.tone, "warn");
  assert.match(d.title, /Override/);
  assert.match(d.text, /trotz Begrenzung/);
});

test("curtail: released units read calm, a blocked unit surfaces its reason", () => {
  const rel = curtailFor({
    curtail_units: [{ source_id: "a", unit_key: "k1", applied: true, mode: "release", all_match: true }]
  });
  assert.strictEqual(rel.tone, "muted");
  assert.match(rel.title, /Keine PV-Begrenzung aktiv/);

  const blocked = curtailFor({
    curtail_units: [{ source_id: "a", unit_key: "k1", blocked: true, reason: "Gateway nicht erreichbar" }]
  });
  assert.strictEqual(blocked.tone, "warn");
  assert.match(blocked.text, /Gateway nicht erreichbar/);
});
