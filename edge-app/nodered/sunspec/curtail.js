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

module.exports = {
  DEFAULT_RVRT_TMS,
  DEFAULT_SETTLE_MS,
  OVERRIDE_TOL_FRAC,
  OVERRIDE_TOL_MIN_KW,
  READING_FRESH_MS,
  CURTAIL_STALE_MS,
  unitKey,
  setpointStale,
  splitPlantCap,
  planFleetCurtailment,
  evaluateEnforcement,
};
