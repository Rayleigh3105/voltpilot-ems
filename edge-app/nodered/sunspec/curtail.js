'use strict';

/**
 * sunspec/curtail - FLEET feed-in curtailment planning for the Fronius
 * (fronius_sunspec) Erzeuger SOURCES of a site: split the plan's ONE
 * plant-level `pv_limit_kw` cap across N SunSpec inverters (Model 123
 * `WMaxLimPct`), accounting for the PV share the curtailment path cannot
 * control (the primary Deye hybrid + any non-writable source), and verify the
 * cap by EFFECT (override detection) - Fronius treats Modbus as the LOWEST
 * control priority, so a confirmed register write does NOT prove enforcement.
 *
 * This is Increment 3/3 of the Fronius control path (Increment 1 = the
 * planned-only Model-123 mapping in sunspec/model-discovery.js planCurtailment,
 * Increment 2 = the planned-only Model-124 storage mapping): the first Fronius
 * increment whose writes can go LIVE - behind the SAME two-gate discipline as
 * every control path (below), never by widening the static family allowlist.
 *
 * PURITY: like inverter-control-routing.controlRoute this module computes
 * PLANS, it never does I/O. The model-discovery module is INJECTED (`disc`) -
 * a Node-RED function node embeds both files verbatim and cannot `require`
 * (the sunspec-live.js dependency-injection precedent). The flow's
 * "PV-Abregelung" plan node carries this module via build-flows.js
 * embedModule; flows-sync.test.js pins the embed.
 *
 * SAFETY (the house rules, all enforced here):
 *   - TWO gates per unit: `controlEnabled` (the core's GLOBAL kill-switch
 *     VP_CONTROL_ENABLED, carried INSIDE the setpoint's `curtail` block - NOT
 *     the top-level `control_enabled`, which is ANDed with the PRIMARY
 *     inverter's certification and must never gate a different device) AND the
 *     PER-UNIT First-Light curtailment grant (`certified`, earned via the
 *     bounded evidence-gated test on :8484, persisted by the core, carried per
 *     source on the setpoint). The fleet allowlist
 *     (CERTIFIED_CONTROL_FAMILIES) is deliberately NOT consulted and NOT
 *     widened: fronius stays absent from it.
 *   - The ONE certification bypass is the bounded calibration test the core
 *     arms (`test` on the source entry): magnitude-bounded (80 % of current
 *     output), TTL-limited, auto-reverting via the model's NATIVE
 *     WMaxLimPct_RvrtTms. It bypasses ONLY certification - the kill-switch
 *     still wins.
 *   - Addresses are DISCOVERED, never hard-coded: every unit plan goes through
 *     disc.planCurtailment against that unit's live discovery walk. No
 *     discovery -> no plan, an honest reason, never a fabricated address.
 *   - Release discipline: an uncurtailed slot / a stale setpoint / a vanished
 *     curtail block -> WMaxLim_Ena=0 (a plant must never stay throttled
 *     because we went away), and the native revert timer is the dead-man
 *     backstop when we cannot even write (see DEFAULT_RVRT_TMS).
 *   - The adapter may only NARROW: the plant cap comes from the already
 *     guard-clamped plan; the split can only distribute or reduce it.
 */

// The native Model-123 revert timeout (s) stamped on every curtailment write.
// 60 s = ~6 ticks of slack on the core's ~10 s setpoint republish cadence
// (VP_SETPOINT_INTERVAL_SECONDS), the SAME margin as the Deye remote-mode
// watchdog default and model-discovery's DEFAULT_RVRT_TMS: a crashed core /
// broken flow / dead LAN link stops refreshing and the INVERTER ITSELF lifts
// the limit within a minute - the plant can never stay throttled by a stale
// write. Deliberately not longer (a stale limit is lost revenue), not shorter
// (a single missed tick must not flap the cap).
const DEFAULT_RVRT_TMS = 60;

// --- the REFRESH / VERIFY layer (First-Light hardening, live 2026-08-06) -----
//
// THE CHAIN THAT MUST HOLD:  REFRESH_MS  <  DEFAULT_RVRT_TMS  <  test TTL
//                             20 s       <     60 s           <   120 s
//
// Measured live at Pilsting (2× Fronius Eco 27 behind ONE Datamanager): the
// executor applied a First-Light test cap EXACTLY ONCE, so the inverter's own
// dead-man reverted the register to 100 % after 60 s - in the MIDDLE of a
// 120-s test (ist=3593 held ~60 s, then 10000 again). A cap that is written
// once is not a cap; it is a 60-second pulse.
//
// So an ACTIVE command is RE-APPLIED, and the refresh must sit well inside the
// revert window: at REFRESH_MS = 20 s a whole missed cycle still lands before
// the inverter lets go, while the executor claims the shared gateway at most
// every second ~10 s setpoint tick (the Pilsting STARVATION incident of
// 2026-07-28 is the reason a claim on every tick is not acceptable - see
// curtail-lease.js). A BOUNDED First-Light test refreshes on EVERY tick
// instead (unit.calibration): its evidence needs the register to demonstrably
// HOLD, and its claim pressure is bounded by the 120-s TTL.
const REFRESH_MS = 20000;

// The Datamanager SWALLOWS writes erratically (live 10:51: commanded 2593 =
// 25,9 %, the register read 10000 for 105 s straight; the identical run at
// 10:47 was accepted). A deviating readback therefore triggers an IMMEDIATE
// re-write - bounded, never a hot loop: at most REWRITE_MAX_ATTEMPTS writes of
// the SAME command before the executor stops writing, names the cause and
// waits REWRITE_COOLDOWN_MS before trying again.
const REWRITE_MAX_ATTEMPTS = 3;
const REWRITE_COOLDOWN_MS = 60000;

// The honest German cause for a command the device keeps discarding. It names
// the LIKELIEST reason (a Fronius-internal controller wins over Modbus, which
// is the LOWEST priority) plus the operator lever, because "Schreiben
// fehlgeschlagen" would be wrong - the write itself was accepted with a 200 OK.
const REJECTED_REASON = 'Der Wechselrichter verwirft die Begrenzung: der befohlene Wert wurde '
  + Number(REWRITE_MAX_ATTEMPTS) + '× geschrieben und jedes Mal wieder überschrieben. Vermutlich regelt '
  + 'eine Fronius-INTERNE Steuerung vor (EVU-Editor / IO-Regel "100 %", Solar.web, ein Smart Meter) - '
  + 'Modbus hat auf Fronius die NIEDRIGSTE Priorität. Bitte im Fronius-Weboberflächen-EVU-Editor die '
  + '100-%-Regel deaktivieren.';

// The Ena readback QUIRK (live: this Datamanager answers a commanded
// WMaxLim_Ena=0 permanently with 1, even with every internal controller off).
// See evaluateReadback() for the one-sided tolerance rule + its safety
// argument.
const ENA_QUIRK_NOTE = 'Die Freigabe-Kennung (WMaxLim_Ena) meldet dauerhaft 1 - ein bekanntes '
  + 'Verhalten dieser Datamanager-Firmware. Maßgeblich ist der Begrenzungswert (WMaxLimPct); '
  + 'er wurde bestätigt.';

// Override detection: how long a cap must have been applied before a measured
// power ABOVE it counts as evidence of a foreign controller (irradiance ramps
// + the inverter's WMaxLimPct_WinTms ramp need settle time), and the tolerance
// band above the cap (measurement noise / scale rounding never flags).
const DEFAULT_SETTLE_MS = 90000;
const OVERRIDE_TOL_FRAC = 0.1; // 10 % of the cap ...
const OVERRIDE_TOL_MIN_KW = 0.5; // ... but at least 0.5 kW

// A per-source measured reading older than this is not usable - neither for
// the uncontrolled-share accounting nor for override detection (mirrors the
// source freshness the core applies; 60 s = 12 read ticks).
const READING_FRESH_MS = 60000;

// The executor-owned dead-man window (mirrors inverter-control-routing's
// SETPOINT_STALE_MS / the Go plan.StaleAfter): a setpoint older than this
// means the core went silent -> hand the caps back (release), never latch.
const CURTAIL_STALE_MS = 20 * 60 * 1000;

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v);
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * unitKey - the PHYSICAL identity of one SunSpec inverter behind a (possibly
 * shared) Modbus gateway: ip:port#unit_id. The per-unit First-Light grant is
 * keyed on this (NOT the source id), so deleting + re-adding the source entry
 * never silently drops - or worse, transfers - a proof that belongs to the
 * physical inverter. MUST stay byte-identical to the Go core's
 * curtailUnitKey (internal/agent/curtail.go).
 */
function unitKey(conn) {
  const ip = (conn && typeof conn.ip === 'string') ? conn.ip.trim() : '';
  const port = Number(conn && conn.port) > 0 ? Number(conn.port) : 502;
  const unit = Number(conn && conn.unit_id) > 0 ? Number(conn.unit_id) : 1;
  return ip + ':' + port + '#' + unit;
}

/**
 * setpointStale - true when the setpoint's core timestamp is older than
 * CURTAIL_STALE_MS. Missing/unparseable ts = NOT stale (the core always stamps
 * ts; never release on a parse quirk) - the same rule as the battery path.
 */
function setpointStale(ts, nowMs) {
  if (typeof ts !== 'string' || ts === '') return false;
  const t = Date.parse(ts);
  if (!isFinite(t)) return false;
  return nowMs - t > CURTAIL_STALE_MS;
}

/**
 * splitPlantCap - distribute the plant-level curtailment budget across the
 * WRITABLE units, proportional to rated power, with a waterfall pass so a
 * unit whose proportional share exceeds its own nameplate hands the excess to
 * the others (its production cannot exceed its nameplate anyway).
 *
 *   { plantCapKw, uncontrolledKw, units: [{ id, ratedKw }] }
 *
 * Returns { budgetKw, caps: { id -> capKw } }. budgetKw = the cap minus the
 * uncontrollable share, floored at 0 (the uncontrollable PV already fills -
 * or overfills - the plant cap: the writable units are then capped to 0).
 * The invariant: sum(caps) <= budgetKw + epsilon, each cap <= its rated.
 */
function splitPlantCap(args) {
  const plantCapKw = Number(args.plantCapKw);
  const uncontrolled = isFiniteNum(args.uncontrolledKw) ? Math.max(0, args.uncontrolledKw) : 0;
  const units = Array.isArray(args.units) ? args.units.filter((u) => u && isFiniteNum(u.ratedKw) && u.ratedKw > 0) : [];
  const budgetKw = Math.max(0, (isFiniteNum(plantCapKw) ? plantCapKw : 0) - uncontrolled);
  const caps = {};
  if (!units.length) return { budgetKw: r3(budgetKw), caps };
  // Waterfall: proportional shares, clamp at rated, redistribute the clamped
  // excess over the still-unclamped units until nothing moves.
  let remaining = budgetKw;
  let open = units.slice();
  while (open.length > 0) {
    const ratedSum = open.reduce((a, u) => a + u.ratedKw, 0);
    const clamped = [];
    let consumed = 0;
    for (const u of open) {
      const share = remaining * (u.ratedKw / ratedSum);
      if (share >= u.ratedKw) {
        caps[u.id] = u.ratedKw;
        consumed += u.ratedKw;
        clamped.push(u);
      } else {
        caps[u.id] = share;
      }
    }
    if (!clamped.length) break;
    remaining -= consumed;
    open = open.filter((u) => clamped.indexOf(u) === -1);
    if (remaining <= 0) {
      for (const u of open) caps[u.id] = 0;
      break;
    }
  }
  for (const id of Object.keys(caps)) caps[id] = r3(caps[id]);
  return { budgetKw: r3(budgetKw), caps };
}

/**
 * planFleetCurtailment - the full per-tick curtailment plan for every
 * fronius_sunspec Erzeuger source, from the retained setpoint + the flow's
 * source plans + the cached per-unit discoveries + the last measured readings.
 *
 *   setpoint     the edge/setpoint message (ts, pv_limit_kw, curtail{...})
 *   plans        the flow's source_plans (sources-store output: id/role/
 *                adapter/conn); only adapter 'sunspec_live' + role
 *                'pv-generation' entries are curtailable
 *   discoveries  { unitKey -> disc.discover() result } (cached by the exec;
 *                absent = this tick cannot plan that unit - the exec walks and
 *                the NEXT tick plans, the Deye capability-probe interlock)
 *   readings     { sourceId -> { pv_kw, at } } (the flow's src_last stash)
 *   nowMs        wall clock (injected for tests)
 *   disc         the INJECTED sunspec/model-discovery module
 *
 * Returns { active, mode: 'apply'|'release'|'idle', reason, controlEnabled,
 *           budgetKw, uncontrolledKw, units: [unitPlan] } where each unitPlan
 * carries { sourceId, unitKey, label, conn, certified, test, ratedKw, capKw,
 *           writeAllowed, plan {ok, writes, readbacks, reason}, planned }.
 * `plan.writes` is EMPTY unless writeAllowed (gate above); `planned` always
 * carries the intended ops for the :8484 display + tests (bench_pending on an
 * uncertified unit, the froniusControl discipline).
 */
function planFleetCurtailment(args) {
  const sp = args.setpoint || {};
  const cur = (sp.curtail && typeof sp.curtail === 'object') ? sp.curtail : null;
  const plans = Array.isArray(args.plans) ? args.plans : [];
  const discoveries = args.discoveries || {};
  const readings = args.readings || {};
  const nowMs = isFiniteNum(args.nowMs) ? args.nowMs : Date.now();
  const disc = args.disc;

  const out = {
    active: false, mode: 'idle', reason: '', controlEnabled: false,
    budgetKw: null, uncontrolledKw: 0, units: [],
  };
  if (!cur) {
    out.reason = 'keine Abregelungs-Konfiguration am Sollwert (aelterer Core oder keine Fronius-Quellen)';
    return out;
  }
  const srcEntries = Array.isArray(cur.sources) ? cur.sources : [];
  const byId = {};
  for (const e of srcEntries) {
    if (e && typeof e.id === 'string') byId[e.id] = e;
  }
  // Curtailable = a fronius_sunspec (sunspec_live) Erzeuger source the CORE
  // also listed in the curtail block (the core's list is the gate carrier).
  const unitPlans = plans.filter((p) => p && p.adapter === 'sunspec_live'
    && p.role === 'pv-generation' && byId[p.id]);
  if (!unitPlans.length) {
    out.reason = 'keine Fronius-SunSpec-Erzeuger als Quelle konfiguriert';
    return out;
  }

  out.active = true;
  out.controlEnabled = cur.control_enabled === true;
  const stale = setpointStale(sp.ts, nowMs);
  const plantCap = isFiniteNum(sp.pv_limit_kw) && sp.pv_limit_kw >= 0 ? sp.pv_limit_kw : null;
  // pv_uncontrolled_kw is the CORE's accounting of the PV share this path can
  // never touch (the primary hybrid + non-Fronius sources), measured. Absent =
  // unknown -> 0 with the honest flag below (the split is then optimistic; the
  // plan cap still bounds the Fronius side, and the note names the gap).
  const coreUncontrolled = isFiniteNum(cur.pv_uncontrolled_kw) ? Math.max(0, cur.pv_uncontrolled_kw) : null;

  const freshPv = (id) => {
    const r = readings[id];
    if (!r || !isFiniteNum(r.pv_kw)) return null;
    if (!isFiniteNum(r.at) || nowMs - r.at > READING_FRESH_MS) return null;
    return Math.max(0, r.pv_kw);
  };

  // First pass: classify units (writable vs uncontrolled) + resolve rated.
  const rows = [];
  for (const p of unitPlans) {
    const entry = byId[p.id];
    const key = unitKey(p.conn);
    const discovery = discoveries[key] || null;
    const discRated = discovery && isFiniteNum(discovery.nameplateKw) && discovery.nameplateKw > 0
      ? discovery.nameplateKw : null;
    const cfgRated = isFiniteNum(entry.capacity_kwp) && entry.capacity_kwp > 0 ? entry.capacity_kwp : null;
    const ratedKw = discRated != null ? discRated : cfgRated;
    const certified = entry.certified === true;
    const test = (entry.test && typeof entry.test === 'object' && isFiniteNum(entry.test.cap_kw))
      ? { cap_kw: Math.max(0, entry.test.cap_kw) } : null;
    rows.push({
      p, entry, key, discovery, ratedKw, certified, test,
      hasControls: !!(discovery && discovery.ok && discovery.controls && discovery.controls.present),
    });
  }

  // A unit is WRITABLE when the kill-switch is on AND (certified OR under a
  // bounded test) AND its Model 123 is discovered AND its rated power is known
  // (the % conversion needs it). Everything else is UNCONTROLLED: its measured
  // production still fills the plant cap, so the split subtracts it.
  for (const row of rows) {
    row.writable = out.controlEnabled && (row.certified || !!row.test)
      && row.hasControls && row.ratedKw != null;
  }

  let uncontrolled = coreUncontrolled != null ? coreUncontrolled : 0;
  out.uncontrolledUnknown = coreUncontrolled == null;
  for (const row of rows) {
    // A unit under test does not follow the split (it holds its bounded test
    // cap), so its measured output counts as uncontrolled for the others -
    // like every unit the split cannot command.
    if (row.writable && !row.test) continue;
    const pv = freshPv(row.p.id);
    if (pv != null) uncontrolled += pv;
  }
  out.uncontrolledKw = r3(uncontrolled);

  const mode = stale || plantCap == null ? 'release' : 'apply';
  out.mode = mode;
  if (stale) out.reason = 'Sollwert veraltet (Core still) - Begrenzungen werden freigegeben';

  let caps = {};
  if (mode === 'apply') {
    const split = splitPlantCap({
      plantCapKw: plantCap,
      uncontrolledKw: uncontrolled,
      units: rows.filter((r) => r.writable && !r.test).map((r) => ({ id: r.p.id, ratedKw: r.ratedKw })),
    });
    out.budgetKw = split.budgetKw;
    caps = split.caps;
  }

  for (const row of rows) {
    let capKw = null;
    if (row.test && !stale) {
      capKw = row.test.cap_kw; // the bounded First-Light test cap
    } else if (mode === 'apply' && Object.prototype.hasOwnProperty.call(caps, row.p.id)) {
      capKw = caps[row.p.id];
    }
    const release = capKw == null;
    // nameplateKw: the resolved rating (discovered ?? configured kWp) - the
    // configured fallback must reach planCurtailment too, or a unit whose live
    // WRtg read failed is classified writable, joins the split, and then
    // refuses its own plan with "Nennleistung unbekannt" (float-audit §6.1).
    const plan = disc.planCurtailment({
      discovery: row.discovery,
      pvLimitKw: release ? null : capKw,
      nameplateKw: row.ratedKw,
      rvrtTms: DEFAULT_RVRT_TMS,
      // The per-connection write-form flip-back (absent = FC16, the documented
      // + proven transactional form). See planCurtailment's write-form comment.
      writeFc: row.p.conn ? row.p.conn.curtail_write_fc : undefined,
    });
    // The certification bypass is EXACTLY the bounded test (never wider); the
    // kill-switch is the outer AND on every branch.
    const writeAllowed = out.controlEnabled && (row.certified || !!row.test) && plan.ok;
    const planned = plan.ok
      ? plan.writes.map((w) => (row.certified ? { ...w } : { ...w, bench_pending: true }))
      : [];
    const unit = {
      sourceId: row.p.id,
      unitKey: row.key,
      label: typeof row.entry.label === 'string' ? row.entry.label : '',
      conn: {
        ip: row.p.conn.ip,
        port: Number(row.p.conn.port) > 0 ? Number(row.p.conn.port) : 502,
        unit_id: Number(row.p.conn.unit_id) > 0 ? Number(row.p.conn.unit_id) : 1,
      },
      certified: row.certified,
      test: row.test,
      calibration: !!row.test,
      ratedKw: row.ratedKw,
      capKw: capKw == null ? null : r3(capKw),
      mode: release ? 'release' : 'apply',
      writeAllowed,
      plan: {
        ok: plan.ok,
        reason: plan.reason,
        writes: writeAllowed ? plan.writes : [],
        readbacks: plan.ok ? plan.readbacks : [],
      },
      planned,
    };
    if (!plan.ok) {
      unit.reason = plan.reason;
    } else if (!writeAllowed) {
      unit.reason = !out.controlEnabled
        ? 'Steuerung deaktiviert (Not-Aus)'
        : 'Abregelung für diesen Wechselrichter noch nicht freigegeben';
    }
    out.units.push(unit);
  }
  return out;
}

/**
 * evaluateEnforcement - override detection by EFFECT. On Fronius, Modbus is
 * the LOWEST control priority: local settings, the display, Solar.web or a
 * Smart-Meter rule silently override a written-and-confirmed WMaxLimPct. So
 * after a settle window, a measured AC power ABOVE the commanded cap (plus a
 * noise tolerance) is surfaced as a possible foreign controller - never
 * silent, honest "possible" (a cloud passing can also mask it, which is why a
 * power BELOW the cap proves nothing and is simply 'ok').
 *
 *   { capKw, measuredKw, measuredAtMs, activeSinceMs, nowMs,
 *     settleMs?, tolFrac?, tolMinKw? }
 *
 * Returns { status: 'inactive'|'unknown'|'settling'|'ok'|'possible_override',
 *           possibleOverride, reason }.
 */
function evaluateEnforcement(args) {
  const a = args || {};
  const out = { status: 'inactive', possibleOverride: false, reason: '' };
  if (!isFiniteNum(a.capKw)) return out;
  const nowMs = isFiniteNum(a.nowMs) ? a.nowMs : Date.now();
  if (!isFiniteNum(a.activeSinceMs)) return out;
  const settle = isFiniteNum(a.settleMs) ? a.settleMs : DEFAULT_SETTLE_MS;
  if (!isFiniteNum(a.measuredKw) || !isFiniteNum(a.measuredAtMs) || nowMs - a.measuredAtMs > READING_FRESH_MS) {
    out.status = 'unknown';
    out.reason = 'kein aktueller Messwert - Wirkung der Begrenzung nicht pruefbar';
    return out;
  }
  if (nowMs - a.activeSinceMs < settle) {
    out.status = 'settling';
    return out;
  }
  const tolFrac = isFiniteNum(a.tolFrac) ? a.tolFrac : OVERRIDE_TOL_FRAC;
  const tolMin = isFiniteNum(a.tolMinKw) ? a.tolMinKw : OVERRIDE_TOL_MIN_KW;
  const tol = Math.max(tolMin, tolFrac * a.capKw);
  if (a.measuredKw > a.capKw + tol) {
    out.status = 'possible_override';
    out.possibleOverride = true;
    out.reason = 'Der Wechselrichter liefert ' + r3(a.measuredKw) + ' kW trotz Begrenzung auf '
      + r3(a.capKw) + ' kW. Möglicher Konflikt: eine lokale Einstellung, Solar.web oder ein '
      + 'Smart Meter übersteuert die Modbus-Begrenzung (Modbus hat auf Fronius die NIEDRIGSTE '
      + 'Priorität) - VoltPilot muss der einzige Controller sein.';
    return out;
  }
  out.status = 'ok';
  return out;
}

/**
 * commandSignature - the STABLE identity of what this tick wants written on a
 * unit: the mode plus every planned register value. Two ticks that want the
 * same registers share a signature, so the executor can tell "the same cap,
 * just being refreshed" from "a NEW cap" without comparing floats.
 *
 * Handles BOTH write forms: a block op (fc 16) carries `values`, a legacy
 * single-register op carries `value`. A block MUST fold in every value - if it
 * signed only its first register, a changed revert timer or a flipped enable
 * would read as "unchanged" and never be re-applied.
 *
 * Returns null when the unit has nothing to command (no plan / no ops).
 */
function commandSignature(unit) {
  if (!unit || !unit.plan || !unit.plan.ok) return null;
  const ops = (unit.plan.writes && unit.plan.writes.length) ? unit.plan.writes
    : (Array.isArray(unit.planned) ? unit.planned : []);
  if (!ops.length) return null;
  const opSig = (w) => (Array.isArray(w.values)
    ? w.values.map((v) => (Number(v) || 0) & 0xffff).join('.')
    : String((Number(w.value) || 0) & 0xffff));
  return String(unit.mode) + '|' + ops.map((w) => w.role + '=' + opSig(w)).join(',');
}

/**
 * evaluateReadback - what the FC3 readback of one unit MEANS. Not a value
 * comparison: the readback-verify discipline of the Deye path applied to
 * Model 123.
 *
 *   registers: [{ role, commanded_raw, actual_raw (null = no answer), match }]
 *
 * Returns { held, allMatch, mismatchRoles, quirkRoles, unreadRoles, quirkNote }.
 *
 * THE ENA QUIRK (live 2026-08-06, Pilsting Datamanager): this firmware answers
 * a commanded WMaxLim_Ena = 0 permanently with 1 - even after every internal
 * controller (the EVU-editor IO rule "100 %") was switched off. That made the
 * RELEASE path report `match:false` forever, which reads like a defect and is
 * none. The tolerance is deliberately ONE-SIDED:
 *
 *   commanded 0 -> actual 1  = QUIRK. The device claims MORE enforcement than
 *      we asked for, and on a release we also command WMaxLimPct = 100 %, so an
 *      enabled 100-%-limit throttles exactly nothing. Curtailment is
 *      restrict-only, so a device erring toward "enabled" can never make a
 *      plant produce more than commanded. Tolerated, recorded, never silent.
 *   commanded 1 -> actual 0  = REAL MISMATCH. We asked for the cap to be
 *      ENFORCED and the device says it is off - that is exactly the case this
 *      readback exists to catch. Never tolerated.
 *
 * The BINDING register is always WMaxLimPct: a deviation there is a mismatch
 * regardless of what the enable flag says, and `held` is false unless it was
 * actually READ (a register without an answer is not a confirmation).
 */
function evaluateReadback(unit, registers) {
  const out = {
    held: false, allMatch: false, mismatchRoles: [], quirkRoles: [], unreadRoles: [], quirkNote: '',
  };
  const regs = Array.isArray(registers) ? registers : [];
  if (!regs.length) return out;
  let sawPct = false;
  for (const r of regs) {
    if (!r || typeof r.role !== 'string') continue;
    if (r.actual_raw === null || r.actual_raw === undefined) {
      out.unreadRoles.push(r.role);
      continue;
    }
    if (r.role === 'pv_limit_pct') sawPct = true;
    if (r.match) continue;
    const cmd = (Number(r.commanded_raw) || 0) & 0xffff;
    const act = (Number(r.actual_raw) || 0) & 0xffff;
    if (r.role === 'pv_limit_enable' && cmd === 0 && act !== 0) {
      out.quirkRoles.push(r.role);
      continue;
    }
    out.mismatchRoles.push(r.role);
  }
  out.held = sawPct && out.mismatchRoles.length === 0 && out.unreadRoles.length === 0;
  out.allMatch = out.held;
  if (out.quirkRoles.length) out.quirkNote = ENA_QUIRK_NOTE;
  return out;
}

/**
 * writeDecision - does this executor tick WRITE the unit's command, and why?
 * Pure; the executor owns the state (flow context `curtail_cmd:<unitKey>`).
 *
 *   state: { sig, wroteAt, attempts, deviating, blockedSince, verifiedAt }
 *
 * Returns { write, kind, sig, reason }:
 *   'none'      nothing to command (no plan, or writing is not allowed)
 *   'first'     never applied before
 *   'changed'   a DIFFERENT command than the one last written
 *   'retry'     the last readback deviated - re-apply IMMEDIATELY (bounded)
 *   'refresh'   the same command, older than the refresh interval - RE-APPLY
 *               so the inverter's native revert timer can never fire on a live
 *               command (the "written exactly once" defect)
 *   'verify'    same command, still fresh - read it back, do not write
 *   'exhausted' REWRITE_MAX_ATTEMPTS re-writes were discarded - stop writing,
 *               name the cause (REJECTED_REASON)
 *   'cooldown'  inside REWRITE_COOLDOWN_MS after 'exhausted' - never hot-loop
 */
function writeDecision(args) {
  const a = args || {};
  const unit = a.unit || {};
  const st = a.state || {};
  const nowMs = isFiniteNum(a.nowMs) ? a.nowMs : Date.now();
  const sig = commandSignature(unit);
  const canWrite = !!(unit.plan && unit.plan.ok && unit.plan.writes && unit.plan.writes.length > 0);
  if (!canWrite || sig === null) return { write: false, kind: 'none', sig: sig, reason: '' };

  if (!(Number(st.wroteAt) > 0)) return { write: true, kind: 'first', sig: sig, reason: '' };
  if (st.sig !== sig) return { write: true, kind: 'changed', sig: sig, reason: '' };

  const blockedSince = Number(st.blockedSince) || 0;
  if (blockedSince > 0) {
    if (nowMs - blockedSince < REWRITE_COOLDOWN_MS) {
      return { write: false, kind: 'cooldown', sig: sig, reason: REJECTED_REASON };
    }
    // The cooldown is over: try the whole bounded ladder again from scratch.
    return { write: true, kind: 'changed', sig: sig, reason: '' };
  }
  if (st.deviating) {
    if ((Number(st.attempts) || 0) < REWRITE_MAX_ATTEMPTS) {
      return { write: true, kind: 'retry', sig: sig, reason: '' };
    }
    // Reached when the ladder ran out WITHOUT a verdict closing it (e.g. the
    // readback itself kept failing, so noteVerdict never opened the cooldown):
    // stop writing all the same - a bounded ladder that can be re-entered by a
    // missing answer would be no bound at all.
    return { write: false, kind: 'exhausted', sig: sig, reason: REJECTED_REASON };
  }
  // A bounded First-Light test re-applies on EVERY tick (its evidence needs
  // the register to demonstrably HOLD); a normal cap every REFRESH_MS.
  // args.refreshMs is a TEST seam (the flow's curtail_refresh_ms override, the
  // sv5_acquire_ms precedent) - never set in production.
  const refreshMs = unit.calibration ? 0
    : (isFiniteNum(a.refreshMs) && a.refreshMs >= 0 ? a.refreshMs : REFRESH_MS);
  if (nowMs - Number(st.wroteAt) >= refreshMs) return { write: true, kind: 'refresh', sig: sig, reason: '' };
  return { write: false, kind: 'verify', sig: sig, reason: '' };
}

/**
 * noteWrite - fold a performed write into the command state. A 'first' /
 * 'changed' write starts a fresh attempt ladder; every other write of the SAME
 * signature counts up (that is what bounds the re-write loop).
 */
function noteWrite(state, decision, nowMs) {
  const st = state || {};
  const d = decision || {};
  const fresh = d.kind === 'first' || d.kind === 'changed';
  const same = st.sig === d.sig;
  return {
    sig: d.sig,
    wroteAt: nowMs,
    attempts: fresh || !same ? 1 : (Number(st.attempts) || 0) + 1,
    deviating: fresh || !same ? false : !!st.deviating,
    blockedSince: fresh || !same ? 0 : (Number(st.blockedSince) || 0),
    verifiedAt: same ? (Number(st.verifiedAt) || 0) : 0,
  };
}

/**
 * noteVerdict - fold a readback verdict into the command state. A HELD
 * register clears the attempt ladder (the command is in force); a deviating
 * one arms the bounded re-write and, once the ladder is exhausted, opens the
 * cooldown so the executor states the cause instead of hammering the gateway.
 */
function noteVerdict(state, verdict, nowMs) {
  const st = state || {};
  const held = !!(verdict && verdict.held);
  if (held) {
    return {
      sig: st.sig, wroteAt: Number(st.wroteAt) || 0, attempts: 0,
      deviating: false, blockedSince: 0, verifiedAt: nowMs,
    };
  }
  const attempts = Number(st.attempts) || 0;
  let blockedSince = Number(st.blockedSince) || 0;
  if (!blockedSince && attempts >= REWRITE_MAX_ATTEMPTS) blockedSince = nowMs;
  return {
    sig: st.sig, wroteAt: Number(st.wroteAt) || 0, attempts: attempts,
    deviating: true, blockedSince: blockedSince, verifiedAt: Number(st.verifiedAt) || 0,
  };
}

module.exports = {
  DEFAULT_RVRT_TMS,
  DEFAULT_SETTLE_MS,
  OVERRIDE_TOL_FRAC,
  OVERRIDE_TOL_MIN_KW,
  READING_FRESH_MS,
  CURTAIL_STALE_MS,
  REFRESH_MS,
  REWRITE_MAX_ATTEMPTS,
  REWRITE_COOLDOWN_MS,
  REJECTED_REASON,
  ENA_QUIRK_NOTE,
  unitKey,
  setpointStale,
  splitPlantCap,
  planFleetCurtailment,
  evaluateEnforcement,
  commandSignature,
  evaluateReadback,
  writeDecision,
  noteWrite,
  noteVerdict,
};
