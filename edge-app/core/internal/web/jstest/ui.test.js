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
  Object.assign(win, opts.extra || {});
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

// --- the REASON line (price-aware in-slot trim, 2026-07-30) -------------------
//
// "Fahrplan-Sollwert 10,8 kW -> bestätigt 10,8 kW" reads like a stubborn order.
// When the device deliberately holds the charge at the measured surplus, the card
// must SAY so in normal mode - and it must never look like a refused write.
function trimFor(state) {
  return load(["control.js"]).VPControl.deriveTrim(state);
}

test("control: an active trim names the deliberate limitation with both numbers", () => {
  const d = trimFor({ trim: { active: true, planned_kw: 10.8, surplus_kw: 7.7 } });
  assert.ok(d, "an active limitation must produce a reason line");
  assert.match(d.text, /7,7 kW/, "it names what the charge is held at: " + d.text);
  assert.match(d.text, /10,8 kW/, "and what the Fahrplan wanted: " + d.text);
  assert.match(d.text, /bewusste Begrenzung/, "and that it is deliberate: " + d.text);
  assert.ok(!/nicht übernommen|Abweichung/.test(d.text),
    "a limitation must never read as a failed write: " + d.text);
});

test("control: no trim -> no reason line (the card reads exactly as before)", () => {
  assert.strictEqual(trimFor({}), null);
  assert.strictEqual(trimFor({ trim: null }), null);
  assert.strictEqual(trimFor({ trim: { active: false } }), null,
    "an inactive limitation claims nothing");
});

test("control: a trim without a known surplus still names the cause", () => {
  const d = trimFor({ trim: { active: true, planned_kw: 10.8 } });
  assert.ok(d);
  assert.match(d.text, /teurer/, "the cause is always stated: " + d.text);
  assert.ok(!/undefined|NaN/.test(d.text), "and never a broken number: " + d.text);
});

test("control: a trimmed setpoint keeps the healthy CONFIRMED state", () => {
  // The trimmed value is what gets written, so the readback matches it - the
  // state must stay "VoltPilot steuert die Anlage", with the reason underneath.
  const regs = [{ role: "battery_power", commanded_raw: 7700, commanded_kw: 7.7, actual_raw: 7700, actual_kw: 7.7, match: true, verdict: "held" }];
  const state = {
    inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: { confirm: "held", all_match: true, registers: regs, source: "schedule" },
    trim: { active: true, planned_kw: 10.8, surplus_kw: 7.7 },
  };
  const d = controlFor(state);
  assert.strictEqual(d.chip.tone, "ok");
  assert.strictEqual(d.showNow, true, "the reason is only shown where a setpoint is shown");
  assert.ok(trimFor(state), "and the reason line is there");
});

// --- the REASON line, discharge side (in-slot load following, 2026-07-30) ----
//
// The night half of the same defect: "-4,3 kW angeordnet, -4,3 kW bestätigt"
// while the house draws 7,1 kW and the difference is bought. When the device
// raises the discharge to the measured house load, the card must SAY so - and it
// must never look like a refused write either.
function followFor(state) {
  return load(["control.js"]).VPControl.deriveFollow(state);
}

test("control: an active load following names the deliberate correction with both numbers", () => {
  const d = followFor({
    follow: { active: true, direction: "deepen", planned_kw: -4.332, deficit_kw: 7.087 },
  });
  assert.ok(d, "an active correction must produce a reason line");
  assert.match(d.text, /7,1 kW/, "it names what is being covered: " + d.text);
  assert.match(d.text, /4,3 kW/, "and what the Fahrplan had planned: " + d.text);
  assert.match(d.text, /Entladung angehoben/, "and WHICH WAY it corrected: " + d.text);
  assert.match(d.text, /bewusste Nachführung/, "and that it is deliberate: " + d.text);
  assert.ok(!/nicht übernommen|Abweichung/.test(d.text),
    "a correction must never read as a failed write: " + d.text);
  assert.ok(!/-4,3|−4,3/.test(d.text),
    "the planned value is named as a magnitude, not a raw signed number: " + d.text);
});

test("control: the limiting direction says so, and names the giveaway as the cause", () => {
  // Pilsting 23:12: -6,7 kW planned into a 5,1 kW house -> 1,4 kW verschenkt.
  const d = followFor({
    follow: { active: true, direction: "reduce", planned_kw: -6.7, deficit_kw: 5.1 },
  });
  assert.ok(d, "an active correction must produce a reason line");
  assert.match(d.text, /Entladung begrenzt/, "it names the direction: " + d.text);
  assert.match(d.text, /5,1 kW/, "what the house draws: " + d.text);
  assert.match(d.text, /6,7 kW/, "and what the Fahrplan had planned: " + d.text);
  assert.match(d.text, /Netz/, "the cause is the giveaway, not an import: " + d.text);
  assert.match(d.text, /bewusste Nachführung/, "and that it is deliberate: " + d.text);
  assert.ok(!/teurer als die gespeicherte Energie/.test(d.text),
    "limiting must not borrow the raising direction's cause: " + d.text);
  assert.ok(!/nicht übernommen|Abweichung/.test(d.text),
    "a correction must never read as a failed write: " + d.text);
});

test("control: an unknown direction claims none", () => {
  const d = followFor({ follow: { active: true, planned_kw: -4.332, deficit_kw: 7.087 } });
  assert.ok(d);
  assert.ok(!/angehoben|begrenzt/.test(d.text),
    "never claim a direction the device did not report: " + d.text);
  assert.match(d.text, /bewusste Nachführung/, "but still name the correction: " + d.text);
});

test("control: no load following -> no reason line", () => {
  assert.strictEqual(followFor({}), null);
  assert.strictEqual(followFor({ follow: null }), null);
  assert.strictEqual(followFor({ follow: { active: false } }), null,
    "an inactive correction claims nothing");
});

test("control: a load following without a known deficit still names the cause", () => {
  const d = followFor({ follow: { active: true, planned_kw: -4.332 } });
  assert.ok(d);
  assert.match(d.text, /teurer/, "the cause is always stated: " + d.text);
  assert.ok(!/undefined|NaN/.test(d.text), "and never a broken number: " + d.text);
});

test("control: a followed setpoint keeps the healthy CONFIRMED state", () => {
  // The followed value is what gets written, so the readback matches it - the
  // state must stay healthy, with the reason underneath. Both directions: a
  // LIMITED discharge is a deliberate correction just like a raised one and must
  // never surface as "Sollwert nicht übernommen" either.
  for (const follow of [
    { active: true, direction: "deepen", planned_kw: -4.332, deficit_kw: 7.087 },
    { active: true, direction: "reduce", planned_kw: -6.7, deficit_kw: 5.1 },
  ]) {
    const kw = follow.deficit_kw * -1;
    const regs = [{ role: "battery_power", commanded_raw: Math.round(kw * 100), commanded_kw: kw, actual_raw: Math.round(kw * 100), actual_kw: kw, match: true, verdict: "held" }];
    const state = {
      inverter: { configured: true }, control_certified: true, control_enabled: true,
      control: { confirm: "held", all_match: true, registers: regs, source: "schedule" },
      follow: follow,
    };
    const d = controlFor(state);
    assert.strictEqual(d.chip.tone, "ok", follow.direction + ": the state stays healthy");
    assert.strictEqual(d.showNow, true, "the reason is only shown where a setpoint is shown");
    assert.ok(followFor(state), "and the reason line is there");
  }
});

// --- the REASON line, charge side RAISING (surplus absorption, 2026-08-02) ---
//
// The morning half of the same defect: "0,0 kW angeordnet, 0,0 kW bestätigt"
// while 23,9 kW of PV meets a 4,3-kW-Haus and 16,6 kW leaves the site at a
// NEGATIVE price, with the battery at 7 % SoC. When the device raises the charge
// to the measured surplus, the card must SAY so - a setpoint far ABOVE the
// Fahrplan value with no reason next to it reads as a defect too.
function absorbFor(state) {
  return load(["control.js"]).VPControl.deriveAbsorb(state);
}

test("control: an active absorption names the deliberate correction with both numbers", () => {
  const d = absorbFor({ absorb: { active: true, planned_kw: 0, surplus_kw: 19.6 } });
  assert.ok(d, "an active correction must produce a reason line");
  assert.match(d.text, /19,6 kW/, "it names what is being stored: " + d.text);
  assert.match(d.text, /0,0 kW/, "and what the Fahrplan had planned: " + d.text);
  assert.match(d.text, /Ladung angehoben/, "and WHICH WAY it corrected: " + d.text);
  assert.match(d.text, /bewusste Nachf\u00fchrung/, "and that it is deliberate: " + d.text);
  assert.ok(!/nicht \u00fcbernommen|Abweichung/.test(d.text),
    "a correction must never read as a failed write: " + d.text);
});

test("control: no absorption -> no reason line (the card reads exactly as before)", () => {
  assert.strictEqual(absorbFor({}), null);
  assert.strictEqual(absorbFor({ absorb: null }), null);
  assert.strictEqual(absorbFor({ absorb: { active: false } }), null,
    "an inactive correction claims nothing");
});

test("control: an absorption without a known surplus still names the cause", () => {
  const d = absorbFor({ absorb: { active: true, planned_kw: 0 } });
  assert.ok(d);
  assert.match(d.text, /mehr wert/, "the cause is always stated: " + d.text);
  assert.ok(!/undefined|NaN/.test(d.text), "and never a broken number: " + d.text);
});

test("control: an absorbed setpoint keeps the healthy CONFIRMED state", () => {
  // The raised value is what gets written, so the readback matches it - the
  // state must stay healthy, with the reason underneath.
  const regs = [{ role: "battery_power", commanded_raw: 1960, commanded_kw: 19.6, actual_raw: 1960, actual_kw: 19.6, match: true, verdict: "held" }];
  const state = {
    inverter: { configured: true }, control_certified: true, control_enabled: true,
    control: { confirm: "held", all_match: true, registers: regs, source: "schedule" },
    absorb: { active: true, planned_kw: 0, surplus_kw: 19.6 },
  };
  const d = controlFor(state);
  assert.strictEqual(d.chip.tone, "ok");
  assert.strictEqual(d.showNow, true, "the reason is only shown where a setpoint is shown");
  assert.ok(absorbFor(state), "and the reason line is there");
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

/* ============ consequences.js: die Nebenwirkungs-Regel (E3) ============ */
//
// Die Regel: eine Aktion, die ANDERSWO einen freigegebenen/bestätigten/
// aufgezeichneten Zustand entwertet, nennt diese Folge VORHER. Getestet wird
// deshalb beides - dass die Folge genannt wird, UND dass ohne Folge kein
// Dialog entsteht (ein Dialog ohne Wirkung wäre Lärm, einer mit erfundener
// Wirkung eine Lüge).

function consequences() {
  return load(["consequences.js"]).VPConsequences;
}

// Der Zustand eines freigegebenen, frisch bewiesenen Wechselrichters -
// genau die Lage, in der die Korrektur am meisten wegnimmt.
const CAL_CERTIFIED = {
  family: "hybrid_3p",
  certified: true,
  device_certified: true,
  sign_confirmed: true,
  scale_confirmed: true,
  write_readback_ok: true,
  evidence_valid: true,
};

test("E3: eine Kalibrier-Korrektur nennt die Rücknahme der Freigabe VORHER", () => {
  const C = consequences();
  const msg = C.calibrationCorrection(CAL_CERTIFIED, "Steuer-Vorzeichen umkehren");

  assert.ok(msg, "eine entwertende Korrektur muss eine Rückfrage bauen");
  // Die Aktion wird beim Namen genannt ...
  assert.match(msg, /Steuer-Vorzeichen umkehren/);
  // ... die konkrete Folge ausgesprochen ...
  assert.match(msg, /Steuerungs-Freigabe .* wird zurückgenommen/);
  // ... und was das für die ANLAGE heißt (das war der teure Teil von Wunde 2).
  assert.match(msg, /Fahrplan steuert diesen Wechselrichter dann nicht mehr/);
  // ... plus der Weg zurück und die eigentliche Frage.
  assert.match(msg, /erneut bestätigen und freigeben/);
  assert.match(msg, /Fortfahren\?/);
});

test("E3: die Korrektur nennt ALLE drei Folgen, die der Server wirklich auslöst", () => {
  const C = consequences();
  const keys = C.calibrationCorrectionEffects(CAL_CERTIFIED).map((e) => e.key);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(keys)),
    ["freigabe", "bestaetigungen", "testergebnis"]);
});

test("E3: ohne Freigabe wird KEINE Rücknahme behauptet - nur was wirklich passiert", () => {
  const C = consequences();
  // Bestätigt, aber nie freigegeben: die Haken fallen, die Freigabe nicht.
  const msg = C.calibrationCorrection(
    { sign_confirmed: true, evidence_valid: true }, "Mess-Vorzeichen der Batterie umkehren");
  assert.ok(msg);
  assert.match(msg, /Bestätigungen für Vorzeichen und Skala werden zurückgesetzt/);
  assert.match(msg, /Ergebnis des letzten Testlaufs wird verworfen/);
  assert.doesNotMatch(msg, /Freigabe/, "eine nie erteilte Freigabe darf nicht genannt werden");
});

test("E3: entwertet die Korrektur nichts, gibt es KEINE Rückfrage", () => {
  const C = consequences();
  // Frisch scharfgeschaltet: nichts freigegeben, nichts bestätigt, kein
  // gültiges Ergebnis -> die Korrektur speichert nur einen Verbindungswert.
  assert.strictEqual(C.calibrationCorrection({ armed: true }, "Leistungsskalierung ×10 (HV)"), null);
  assert.strictEqual(C.calibrationCorrection(null, "x"), null);
});

test("E3: ask() führt nur aus, wenn bestätigt wird - Abbrechen ändert nichts", () => {
  const win = load(["consequences.js"]);
  const C = win.VPConsequences;

  win.confirm = () => false;
  assert.strictEqual(C.ask("Fortfahren?"), false, "Abbrechen muss die Aktion stoppen");

  win.confirm = () => true;
  assert.strictEqual(C.ask("Fortfahren?"), true);

  // Ohne Text (nichts wird entwertet) wird gar nicht erst gefragt ...
  let asked = 0;
  win.confirm = () => { asked++; return false; };
  assert.strictEqual(C.ask(null), true, "ohne Folge läuft die Aktion unverändert durch");
  assert.strictEqual(asked, 0);

  // ... und ohne verfügbares confirm wird nie blockiert (Kiosk/Test).
  delete win.confirm;
  assert.strictEqual(C.ask("Fortfahren?"), true);
});

test("E3: 'Freigabe zurücknehmen' nennt die Folge für die Anlage, nicht nur sich selbst", () => {
  const C = consequences();
  const msg = C.calibrationDecertify(CAL_CERTIFIED);
  assert.ok(msg);
  assert.match(msg, /nur-lesend/);
  assert.match(msg, /Fahrplan steuert diesen Wechselrichter dann nicht mehr/);
  // Ehrlich: die Bestätigungen überleben diese Aktion (anders als bei der Korrektur).
  assert.match(msg, /Bestätigungen bleiben erhalten/);
  // Nicht freigegeben -> nichts zu nehmen -> keine Rückfrage.
  assert.strictEqual(C.calibrationDecertify({ certified: false }), null);
});

test("E3: die Abregelungs-Rücknahme sagt, dass der Fahrplan dann nicht mehr abregelt", () => {
  const C = consequences();
  const msg = C.curtailDecertify({ source_id: "src-1", label: "Fronius WR1", certified: true });
  assert.ok(msg);
  assert.match(msg, /Fronius WR1/);
  assert.match(msg, /nicht mehr abregeln/);
  assert.match(msg, /negativen Strompreisen/);
  assert.strictEqual(C.curtailDecertify({ source_id: "src-1", certified: false }), null);
});

test("E3: eine Quelle mit Abregelungs-Freigabe nennt beim Entfernen BEIDE Folgen", () => {
  const C = consequences();
  const src = { id: "src-1", label: "Fronius WR1", role: "pv-generation" };
  const units = [{ source_id: "src-1", certified: true }];

  const withRelease = C.sourceRemoval(src, units);
  assert.match(withRelease, /Gesamt-PV/, "die Rollen-Folge bleibt erhalten");
  assert.match(withRelease, /Abregelungs-Freigabe .* verfällt/);

  // Ohne Freigabe bleibt es beim reinen Rollen-Satz - nichts wird erfunden.
  const plain = C.sourceRemoval(src, [{ source_id: "src-1", certified: false }]);
  assert.match(plain, /Gesamt-PV/);
  assert.doesNotMatch(plain, /Abregelungs-Freigabe/);
  // Auch ohne Abregel-Modul (units unbekannt) darf nichts behauptet werden.
  assert.doesNotMatch(C.sourceRemoval(src, undefined), /Abregelungs-Freigabe/);

  // Die anderen Rollen behalten ihre eigene, wahre Folge.
  assert.match(C.sourceRemoval({ id: "g", role: "grid-meter" }, []), /Speicher-Wechselrichter gemessen/);
  assert.match(C.sourceRemoval({ id: "c", role: "consumer" }, []), /nicht mehr mitgemessen/);
});

test("E3: ein Modellwechsel sagt, dass die Freigabe nicht mitwandert", () => {
  const C = consequences();
  const msg = C.inverterChange(
    CAL_CERTIFIED,
    { family: "hybrid_3p", connection: { power_scale: 10 } },
    { family: "hybrid_1p", connection: { power_scale: 10 } }
  );
  assert.ok(msg);
  assert.match(msg, /Für das neue Modell besteht hier noch keine Freigabe/);
  assert.match(msg, /Fahrplan steuert diesen Wechselrichter dann nicht mehr/);
  // Es wird NICHT behauptet, die alte Freigabe würde gelöscht - sie gilt weiter
  // für das bisherige Modell.
  assert.doesNotMatch(msg, /zurückgenommen/);
});

test("E3: geänderte Steuerwerte sagen ehrlich 'Freigabe bleibt, Nachweis veraltet'", () => {
  const C = consequences();
  const msg = C.inverterChange(
    CAL_CERTIFIED,
    { family: "hybrid_3p", connection: { power_scale: 1, invert_control_sign: false } },
    { family: "hybrid_3p", connection: { power_scale: 10, invert_control_sign: false } }
  );
  assert.ok(msg);
  assert.match(msg, /Freigabe bleibt bestehen/);
  assert.match(msg, /nicht mehr belegt/);
  assert.match(msg, /erneut testen/);
  assert.doesNotMatch(msg, /wird zurückgenommen/, "der Server nimmt hier nichts zurück");
});

test("E3: ohne Freigabe und ohne Steuerwert-Änderung fragt das Formular nicht", () => {
  const C = consequences();
  const same = { family: "hybrid_3p", connection: { power_scale: 10, ip: "192.168.0.28" } };
  // (a) nicht freigegeben -> nie eine Rückfrage, egal was sich ändert.
  assert.strictEqual(
    C.inverterChange({ certified: false }, same, { family: "hybrid_1p", connection: {} }), null);
  // (b) freigegeben, aber nur ein NICHT steuerrelevantes Feld geändert.
  assert.strictEqual(
    C.inverterChange(CAL_CERTIFIED, same,
      { family: "hybrid_3p", connection: { power_scale: 10, ip: "192.168.0.99" } }), null);
  // (c) freigegeben und nichts geändert.
  assert.strictEqual(C.inverterChange(CAL_CERTIFIED, same, same), null);
});

test("E3: leer und fehlend sind derselbe Wert - ein Select erzeugt keine Geister-Rückfrage", () => {
  const C = consequences();
  // Der Server liefert Zahlen, die Selects Strings; "" und undefined heißen
  // beide "nicht gesetzt". Keiner der Fälle ist eine Änderung.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(C.changedControlKeys({ power_scale: 10 }, { power_scale: "10" }))), []);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(C.changedControlKeys({ control_write_fc: "" }, {}))), []);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(C.changedControlKeys({ invert_control_sign: false }, {}))), []);
  // Eine echte Änderung wird erkannt.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(C.changedControlKeys({ invert_control_sign: false }, { invert_control_sign: true }))),
    ["invert_control_sign"]);
});

/* ====== calibration.js: die Regel ist VERDRAHTET, nicht nur formuliert ====== */
//
// Wunde 2 saß in der VERDRAHTUNG, nicht im Text: der Knopf POSTete sofort.
// Diese Tests fahren deshalb den echten calibration.js-Klickpfad gegen ein
// DOM-Stub und prüfen die drei Zusicherungen des Inkrements:
//   Dialog erscheint mit Folgen-Text · Abbrechen ändert nichts · Bestätigen führt aus.

// Ein generisches Element - reicht für alles, was render()/init() anfassen.
function el(id) {
  const handlers = {};
  return {
    id,
    hidden: false, checked: false, disabled: false, value: "",
    textContent: "", innerHTML: "",
    style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, scrollIntoView() {}, focus() {},
    querySelector() { return el(id + "-child"); },
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    fire(type) { (handlers[type] || []).forEach((fn) => fn.call(this, {})); },
    _handlers: handlers,
  };
}

// Drives the REAL calibration.js: returns the window plus the recorded POSTs.
function calibrationCard(cal, confirmAnswer) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, el(id));
    return nodes.get(id);
  };
  const scale1 = el("scale1"); scale1.dataset.scale = "1"; scale1.textContent = "×1 (LV)";
  const scale10 = el("scale10"); scale10.dataset.scale = "10"; scale10.textContent = "×10 (HV)";

  const posts = [];
  const doc = {
    readyState: "complete",
    documentElement: { classList: { toggle() {}, contains() { return false; } } },
    getElementById: get,
    createElement: () => el("new"),
    querySelectorAll: (sel) => (sel === ".cal-scale-btn" ? [scale1, scale10] : []),
    querySelector: () => null,
    addEventListener() {},
  };
  const confirms = [];
  const win = load(["consequences.js", "calibration.js"], {
    document: doc,
    extra: {
      setInterval() {},
      confirm(msg) { confirms.push(msg); return confirmAnswer; },
      fetch(url, init) {
        if (init && init.method === "POST") posts.push({ url, body: JSON.parse(init.body || "{}") });
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ calibration: cal }),
        });
      },
    },
  });
  return { win, posts, confirms, get, scale10 };
}

// Let the init-time GET /api/calibration land so lastCal is the real snapshot.
const settle = () => new Promise((r) => setTimeout(r, 0));

test("E3 verdrahtet: Abbrechen an einer Kalibrier-Korrektur ändert NICHTS", async () => {
  const c = calibrationCard(CAL_CERTIFIED, false);
  await settle();
  const before = c.posts.length;

  c.get("calInvert").fire("click");
  c.get("calBattInvert").fire("click");
  c.scale10.fire("click");
  await settle();

  assert.strictEqual(c.posts.length, before, "kein einziger POST nach Abbrechen");
  assert.strictEqual(c.confirms.length, 3, "jede der drei Korrekturen fragt nach");
  // Und jede Rückfrage nennt wirklich die Folge - nicht bloß "Sicher?".
  for (const msg of c.confirms) {
    assert.match(msg, /Steuerungs-Freigabe .* wird zurückgenommen/);
    assert.match(msg, /Fahrplan steuert diesen Wechselrichter dann nicht mehr/);
  }
  // Die Rückfrage nennt die Aktion beim Namen, auch die Skalierungs-Knöpfe.
  assert.match(c.confirms[2], /×10 \(HV\)/);
});

test("E3 verdrahtet: Bestätigen führt die Korrektur unverändert aus", async () => {
  const c = calibrationCard(CAL_CERTIFIED, true);
  await settle();
  const before = c.posts.length;

  c.get("calInvert").fire("click");
  c.scale10.fire("click");
  await settle();

  const done = c.posts.slice(before);
  assert.strictEqual(done.length, 2);
  assert.strictEqual(done[0].url, "/api/calibration/correction");
  assert.strictEqual(done[0].body.invert_control_sign, true, "der bisherige Wert wird gekippt");
  assert.strictEqual(done[1].body.power_scale, 10);
});

test("E3 verdrahtet: ohne Freigabe/Beweis läuft die Korrektur ohne Rückfrage durch", async () => {
  // Frisch scharfgeschaltet: die Korrektur entwertet nachweislich nichts.
  const c = calibrationCard({ family: "hybrid_3p", armed: true, available: true }, false);
  await settle();
  const before = c.posts.length;

  c.get("calInvert").fire("click");
  await settle();

  assert.strictEqual(c.confirms.length, 0, "ein Dialog ohne Folge wäre Lärm");
  assert.strictEqual(c.posts.length - before, 1, "die Aktion läuft unverändert durch");
});

test("E3 verdrahtet: 'Freigabe zurücknehmen' fragt vorher und respektiert Abbrechen", async () => {
  const no = calibrationCard(CAL_CERTIFIED, false);
  await settle();
  let before = no.posts.length;
  no.get("calDecertify").fire("click");
  await settle();
  assert.strictEqual(no.posts.length, before, "Abbrechen nimmt keine Freigabe zurück");
  assert.match(no.confirms[0], /nur-lesend/);

  const yes = calibrationCard(CAL_CERTIFIED, true);
  await settle();
  before = yes.posts.length;
  yes.get("calDecertify").fire("click");
  await settle();
  assert.strictEqual(yes.posts[before].url, "/api/calibration/decertify");
});

test("E3 verdrahtet: die NICHT entwertenden Bedienelemente fragen nie", async () => {
  const c = calibrationCard(CAL_CERTIFIED, false);
  await settle();
  const before = c.posts.length;

  c.get("calArm").fire("change");     // scharfschalten
  c.get("calCharge").fire("click");   // Test starten
  c.get("calAbort").fire("click");    // Test abbrechen
  c.get("calSign").fire("change");    // Haken setzen
  c.get("calCertify").fire("click");  // freigeben
  await settle();

  assert.strictEqual(c.confirms.length, 0, "nur entwertende Aktionen fragen nach");
  assert.strictEqual(c.posts.length - before, 5, "alle fünf laufen unverändert durch");
});

test("E3: eine Freigabe aus der VoltPilot-Konfiguration wird NICHT als Rücknahme behauptet", () => {
  const C = consequences();
  // `certified` ist die VEREINIGUNG aus flottenweiter Allowlist und der auf
  // diesem Gerät erteilten First-Light-Freigabe. Die Korrektur entfernt nur die
  // zweite Hälfte - live nachgemessen: mit VP_CONTROL_CERTIFIED_FAMILIES blieb
  // `certified` nach der Korrektur wahr. Ein Dialog, der hier die Rücknahme
  // verspricht, wäre also schlicht falsch.
  const envOnly = { family: "sunspec", certified: true, device_certified: false, sign_confirmed: true };

  const msg = C.calibrationCorrection(envOnly, "Steuer-Vorzeichen umkehren");
  assert.ok(msg, "die Bestätigungen fallen weiterhin - das wird gesagt");
  assert.match(msg, /Bestätigungen für Vorzeichen und Skala/);
  assert.doesNotMatch(msg, /Freigabe/, "keine Rücknahme behaupten, die nicht eintritt");

  // "Freigabe zurücknehmen" kann eine Allowlist-Freigabe nicht zurücknehmen -
  // der Dialog sagt genau das, statt eine ausbleibende Wirkung zu versprechen.
  const dec = C.calibrationDecertify(envOnly);
  assert.ok(dec);
  assert.match(dec, /nicht von diesem Gerät/);
  assert.match(dec, /bleibt steuerbar/);
  assert.doesNotMatch(dec, /nur-lesend/);

  // Und das Wechselrichter-Formular behauptet über eine Allowlist-Freigabe
  // nichts - ob sie das neue Modell abdeckt, ist von hier aus nicht entscheidbar.
  assert.strictEqual(
    C.inverterChange(envOnly, { family: "sunspec", connection: {} },
      { family: "hybrid_3p", connection: {} }), null);
});
