'use strict';
/**
 * catalog.js - the initial VoltPilot node catalog the flowc compiler resolves
 * flow-graph node instances against (contract: docs/contracts/v2/
 * flow-graph.md §1; catalog ownership E2/E4). Each type declares:
 *
 *   version     - the catalog type's semver (type_version compatibility is
 *                 checked on the MAJOR)
 *   runtimes    - where instances may run (V-8)
 *   minPalette  - the @voltpilot/node-red-vp-palette floor its compiled form
 *                 needs (max over used types -> artifact min_palette_version)
 *   ports       - in/out port name -> {type, required} (V-1/V-3)
 *   triggerable - the node accepts a trigger input (interval/slot-boundary
 *                 injects wire into it)
 *   validate    - params validation, returns German finding strings
 *   requires    - required_entities contribution [{entity_id, capabilities}]
 *   claims      - the EXPECTED claims derived from params (checked against
 *                 the document's explicit claims, D-13)
 *   compile     - materialize Node-RED nodes; first node = the wiring anchor
 *
 * SECURITY: compiled function nodes carry ONLY whitelisted, generated code -
 * fixed templates parameterized exclusively through a JSON literal of
 * strictly validated values (finite numbers, enum strings). User-supplied
 * text (labels, messages) only ever lands in DATA properties (name/label/
 * info/config), never in code.
 *
 * ONE scoped exception, logged as decision D-16 (docs/contracts/v2/README.md,
 * amending flow-graph.md §6): `vp.logic.function` carries CUSTOMER JavaScript.
 * It is still never concatenated into control flow - the source text is
 * embedded as a JSON string LITERAL and the generated wrapper compiles it with
 * `new Function`, inside a CPU/time WATCHDOG, in a scope where `net`/`http`/
 * `https`/`require`/`global` are shadowed to undefined. Its device effects
 * leave through vp-desired -> arbitration -> the guard chain like every other
 * node, so customer code can only ever WISH.
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const COMMANDS = ['setpoint_kw', 'on_off', 'limit_pct', 'limit_kw', 'mode'];
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// The `host` param kind (MB-M1): an IPv4 literal or RFC-1123 hostname, <=253
// chars - the SAME rule as the api FlowGraphValidator / portal validate.ts.
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function num(v) {
  return typeof v === 'number' && isFinite(v);
}

function validHost(v) {
  return typeof v === 'string' && v.length >= 1 && v.length <= 253 && HOST_RE.test(v);
}

// The editor represents a schedule window's day set as the enum
// alle/werktage/wochenende (api + portal catalogs); WINDOW_BODY runs on a
// day-number array (0=So..6=Sa). Map the enum here so an editor-produced
// schedule flow compiles; a raw 0..6 array is still accepted (backward compat).
function scheduleDays(days) {
  if (days === 'werktage') return [1, 2, 3, 4, 5];
  if (days === 'wochenende') return [0, 6];
  if (Array.isArray(days)) return days;
  return []; // 'alle' or absent = every day
}

// literal() guards every value interpolated into generated code: only finite
// numbers, booleans and WHITELIST-validated strings pass, serialized as a
// JSON literal (JSON is a JS expression subset; U+2028/2029 escaped).
function literal(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// fnNode builds a generated function node from a fixed template.
function fnNode(ctx, node, name, params, body, outputs) {
  return {
    id: ctx.nrId(node.id),
    type: 'function',
    z: ctx.tabId,
    name: name,
    func: '// generiert von flowc - NICHT von Hand bearbeiten\n' +
      'const P = ' + literal(params) + ';\n' + body,
    outputs: outputs,
    noerr: 0,
    initialize: '',
    finalize: '',
    libs: [],
  };
}

const THRESHOLD_BODY = [
  'let on = context.get("on") || false;',
  'const v = Number(msg.payload);',
  'if (!isFinite(v)) return null;',
  'if (P.direction === "below") {',
  '  if (v < P.threshold) on = true;',
  '  else if (v > P.threshold + P.hysteresis) on = false;',
  '} else {',
  '  if (v > P.threshold) on = true;',
  '  else if (v < P.threshold - P.hysteresis) on = false;',
  '}',
  'context.set("on", on);',
  'msg.payload = on;',
  'return msg;',
].join('\n');

const IF_BODY = [
  'const cond = !!msg.payload;',
  'if (cond) { msg.payload = P.then_value; return msg; }',
  'if (P.has_else) { msg.payload = P.else_value; return msg; }',
  'return null;',
].join('\n');

// vp.logic.gate: rising-edge trigger (bool -> event). Fires ONLY on the
// false->true transition, so it feeds vp.notify.push once per event instead of
// on every truthy sample. Distinct from vp.logic.if (bool -> number): the gate
// emits the message as an EVENT, it does not pick a value.
const GATE_BODY = [
  'const cond = !!msg.payload;',
  'const prev = context.get("on") || false;',
  'context.set("on", cond);',
  'if (cond && !prev) return msg;',
  'return null;',
].join('\n');

// vp.logic.and / vp.logic.or: boolean combinators (two bool inputs -> one bool
// out) so the guided Wenn/Dann builder can wire compound conditions
// ("PV-Überschuss UND Zeitfenster"). A Node-RED function node has ONE input, so
// compile.js wires both branches onto the same anchor and stamps a COMPILE-TIME
// per-edge discriminator (msg._vp_src = the graph port name) through a
// generated tag node - see compile.js DISCRIMINATOR_BODY.
//
// Keying on that discriminator instead of msg.topic is load-bearing: two
// vp.schedule.window branches carry NO topic at all (and two reads of the same
// entity+channel carry the SAME topic), so the former `msg.topic || "_"` key
// collapsed both branches into ONE slot and the conjunction was not degraded
// but WRONG (a two-window AND read `true` while only one window was active).
// An untagged message cannot be attributed and is dropped, and AND only holds
// once EVERY declared port has been seen true.
function combinatorBody(op) {
  return [
    'const key = typeof msg._vp_src === "string" ? msg._vp_src : "";',
    'if (P.ports.indexOf(key) < 0) return null;',
    'const seen = context.get("seen") || {};',
    'seen[key] = !!msg.payload;',
    'context.set("seen", seen);',
    'msg.payload = P.ports.' + op + '(function (p) { return seen[p] === true; });',
    'delete msg._vp_src;',
    'return msg;',
  ].join('\n');
}

const AND_BODY = combinatorBody('every');
const OR_BODY = combinatorBody('some');

// vp.logic.function (D-16): the sandboxed CUSTOMER code node. Two independent
// guards make it safe to hand to a customer:
//
//  1. The WATCHDOG. The emitted Node-RED function node carries `timeout`
//     (seconds) - Node-RED runs the script through `vm` with that timeout, so
//     even a synchronous endless loop is ABORTED by the runtime, never a silent
//     hang. The in-body deadline check below is the second half: it turns a
//     slow-but-finishing run into a red node status + node.error instead of a
//     quietly degrading flow.
//  2. NO NETWORK / NO SANDBOX ESCAPE. The user source is embedded as DATA
//     (P.code, a JSON string literal) and compiled with `new Function`, whose
//     parameter list SHADOWS every handle that could reach outside the node -
//     net/http/https/require/global/globalThis/process plus the Node-RED
//     sandbox objects (flow/context/env/RED/node). We pass only `wert` and
//     `msg`, so all of them are `undefined` inside the customer's scope.
//
// The code text is never concatenated into this control flow, so it cannot
// close the wrapper and continue outside it. Device effects still leave through
// vp-desired -> arbitration -> the guard chain: this node can only ever wish.
const FUNCTION_BODY = [
  'let fn = context.get("vp_fn");',
  'if (!fn) {',
  '  try {',
  '    fn = new Function("wert", "msg", "net", "http", "https", "require", "global",',
  '      "globalThis", "process", "flow", "context", "env", "RED", "node",',
  '      "\\"use strict\\";\\n" + P.code);',
  '    context.set("vp_fn", fn);',
  '  } catch (e) {',
  '    node.status({ fill: "red", shape: "dot", text: "Code fehlerhaft" });',
  '    node.error("Funktion (Code): " + e.message, msg);',
  '    return null;',
  '  }',
  '}',
  'const t0 = Date.now();',
  'let out;',
  'try {',
  '  out = fn(Number(msg.payload), msg);',
  '} catch (e) {',
  '  node.status({ fill: "red", shape: "dot", text: "Fehler" });',
  '  node.error("Funktion (Code): " + e.message, msg);',
  '  return null;',
  '}',
  'if (Date.now() - t0 > P.timeout_ms) {',
  '  node.status({ fill: "red", shape: "dot", text: "Zeitlimit" });',
  '  node.error("Funktion (Code): Zeitlimit von " + P.timeout_ms + " ms ueberschritten", msg);',
  '  return null;',
  '}',
  'if (out === undefined || out === null) { node.status({ fill: "grey", shape: "ring", text: "-" }); return null; }',
  'node.status({ fill: "green", shape: "dot", text: String(out) });',
  'msg.payload = out;',
  'return msg;',
].join('\n');

const WINDOW_BODY = [
  '// Zeitfenster in LOKALER Geraetezeit; Tage 0=So..6=Sa (leer = alle).',
  'const now = new Date();',
  'const hm = now.getHours() * 60 + now.getMinutes();',
  'const from = P.from_h * 60 + P.from_m, to = P.to_h * 60 + P.to_m;',
  'let active = from <= to ? (hm >= from && hm < to) : (hm >= from || hm < to);',
  'if (P.days.length > 0 && P.days.indexOf(now.getDay()) < 0) active = false;',
  'msg.payload = active;',
  'return msg;',
].join('\n');

const STRATEGY_BODY = [
  '// Strategie-Knoten: die Entitaet ist an die Cloud-Co-Optimierung',
  '// DELEGIERT (plan-execution-ownership.md). Der Plan kommandiert sie als',
  '// Klasse "market"; auf dem Geraet entsteht hier bewusst KEIN Wunsch.',
  'return null;',
].join('\n');

// Per-strategy input ports. The api flow-catalog (flowcatalog/catalog.json) is
// authoritative for the editor + FlowGraphValidator; flowc mirrors the input
// set each strategy declares there so any validator-accepted flow also
// compiles (peakshaving/atypical-grid take only `soc`, market adds price + PV).
// All strategies emit the delegated `wunsch` plan output.
const STRATEGY_INPUTS = {
  market: {
    price_in: { type: 'price' },
    pv_forecast: { type: 'timeseries' },
    soc: { type: 'timeseries' },
  },
  peakshaving: { soc: { type: 'timeseries' } },
  atypicalGrid: { soc: { type: 'timeseries' } },
};

const TYPES = {
  'vp.entity.read': {
    version: '1.0.0',
    runtimes: ['edge'],
    minPalette: '0.2.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { value: { type: 'number' } } },
    validate(p) {
      const errs = [];
      if (!p || !ID_RE.test(p.entity_id || '')) errs.push('entity_id fehlt oder ist ungültig');
      if (!p || !CHANNEL_RE.test(p.channel || '')) errs.push('channel fehlt oder ist ungültig');
      return errs;
    },
    requires(p) {
      return [{ entity_id: p.entity_id, capabilities: ['measure:' + p.channel] }];
    },
    claims() {
      return [];
    },
    compile(ctx, node, extras) {
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-entity-read',
        z: ctx.tabId,
        name: node.label || 'Entität lesen',
        core: ctx.coreId,
        entity: node.parameters.entity_id,
        channel: node.parameters.channel,
        deadband: extras && num(extras.deadband) ? extras.deadband : 0,
      }];
    },
  },

  'vp.price.dayahead': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { prices: { type: 'price' } } },
    validate(p) {
      if (p && p.zone !== undefined && ['DE-LU', 'AT', 'CH'].indexOf(p.zone) < 0) {
        return ['zone muss DE-LU, AT oder CH sein'];
      }
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-feed',
        z: ctx.tabId,
        name: node.label || 'Strompreis',
        core: ctx.coreId,
        feed: 'prices',
      }];
    },
  },

  'vp.price.current': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { value: { type: 'number' } } },
    validate(p) {
      if (p && p.zone !== undefined && ['DE-LU', 'AT', 'CH'].indexOf(p.zone) < 0) {
        return ['zone muss DE-LU, AT oder CH sein'];
      }
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-feed',
        z: ctx.tabId,
        name: node.label || 'Aktueller Strompreis',
        core: ctx.coreId,
        feed: 'price_current',
      }];
    },
  },

  'vp.forecast.pv': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { forecast: { type: 'timeseries' } } },
    validate() {
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-feed',
        z: ctx.tabId,
        name: node.label || 'PV-Prognose',
        core: ctx.coreId,
        feed: 'pv_forecast',
      }];
    },
  },

  'vp.logic.threshold': {
    version: '1.1.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    ports: { in: { input: { type: 'number', required: true } }, out: { result: { type: 'bool' } } },
    validate(p) {
      const errs = [];
      if (!p || !num(p.threshold)) errs.push('threshold fehlt oder ist keine Zahl');
      if (p && p.hysteresis !== undefined && !(num(p.hysteresis) && p.hysteresis >= 0)) {
        errs.push('hysteresis muss eine Zahl >= 0 sein');
      }
      if (!p || ['above', 'below'].indexOf(p.direction) < 0) errs.push('direction muss above oder below sein');
      return errs;
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      const p = node.parameters;
      return [fnNode(ctx, node, node.label || 'Schwellwert', {
        threshold: p.threshold,
        hysteresis: num(p.hysteresis) ? p.hysteresis : 0,
        direction: p.direction,
      }, THRESHOLD_BODY, 1)];
    },
  },

  'vp.logic.if': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    ports: { in: { condition: { type: 'bool', required: true } }, out: { value: { type: 'number' } } },
    validate(p) {
      const errs = [];
      if (!p || !num(p.then_value)) errs.push('then_value fehlt oder ist keine Zahl');
      if (p && p.else_value !== undefined && !num(p.else_value)) errs.push('else_value muss eine Zahl sein');
      return errs;
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      const p = node.parameters;
      return [fnNode(ctx, node, node.label || 'Wenn/Dann', {
        then_value: p.then_value,
        has_else: p.else_value !== undefined,
        else_value: num(p.else_value) ? p.else_value : 0,
      }, IF_BODY, 1)];
    },
  },

  'vp.logic.gate': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    ports: { in: { wenn: { type: 'bool', required: true } }, out: { dann: { type: 'event' } } },
    validate() {
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [fnNode(ctx, node, node.label || 'Wenn/Dann', {}, GATE_BODY, 1)];
    },
  },

  'vp.logic.and': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    // discriminateInputs: compile.js inserts a per-edge tag node before this
    // node so the body can tell branch `a` from branch `b` (see AND_BODY).
    discriminateInputs: true,
    ports: {
      in: { a: { type: 'bool', required: true }, b: { type: 'bool', required: true } },
      out: { result: { type: 'bool' } },
    },
    validate() {
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [fnNode(ctx, node, node.label || 'Und', { ports: ['a', 'b'] }, AND_BODY, 1)];
    },
  },

  'vp.logic.or': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    discriminateInputs: true,
    ports: {
      in: { a: { type: 'bool', required: true }, b: { type: 'bool', required: true } },
      out: { result: { type: 'bool' } },
    },
    validate() {
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [fnNode(ctx, node, node.label || 'Oder', { ports: ['a', 'b'] }, OR_BODY, 1)];
    },
  },

  // The sandboxed customer code node (D-16) - see FUNCTION_BODY above for the
  // two guards (Node-RED `timeout` watchdog + shadowed network/sandbox handles).
  // runtime EDGE ONLY: the cloud never executes customer code.
  'vp.logic.function': {
    version: '1.0.0',
    runtimes: ['edge'],
    minPalette: '0.2.0',
    ports: { in: { in: { type: 'number', required: true } }, out: { out: { type: 'number' } } },
    validate(p) {
      const errs = [];
      const code = p && p.code;
      if (typeof code !== 'string' || code.trim().length === 0) {
        errs.push('code fehlt');
      } else if (code.length > 4000) {
        errs.push('code ist länger als 4000 Zeichen');
      }
      if (p && p.timeout_ms !== undefined
          && !(Number.isInteger(p.timeout_ms) && p.timeout_ms >= 1 && p.timeout_ms <= 500)) {
        errs.push('timeout_ms muss 1..500 sein');
      }
      return errs;
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      const p = node.parameters || {};
      const timeoutMs = Number.isInteger(p.timeout_ms) ? p.timeout_ms : 100;
      const fn = fnNode(ctx, node, node.label || 'Funktion (Code)',
        { code: p.code, timeout_ms: timeoutMs }, FUNCTION_BODY, 1);
      // Node-RED's function node `timeout` is in SECONDS and is enforced by the
      // runtime's vm - this is the half that can abort a runaway loop.
      fn.timeout = timeoutMs / 1000;
      return [fn];
    },
  },

  'vp.schedule.window': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { active: { type: 'bool' } } },
    validate(p) {
      const errs = [];
      if (!p || !HHMM_RE.test(p.from || '')) errs.push('from fehlt oder ist nicht HH:MM');
      if (!p || !HHMM_RE.test(p.to || '')) errs.push('to fehlt oder ist nicht HH:MM');
      if (p && p.days !== undefined) {
        const enumOk = ['alle', 'werktage', 'wochenende'].indexOf(p.days) >= 0;
        const arrayOk = Array.isArray(p.days)
          && p.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (!enumOk && !arrayOk) errs.push('days muss alle/werktage/wochenende oder eine Liste aus 0..6 sein');
      }
      return errs;
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      const p = node.parameters;
      return [fnNode(ctx, node, node.label || 'Zeitplan', {
        from_h: Number(p.from.slice(0, 2)),
        from_m: Number(p.from.slice(3)),
        to_h: Number(p.to.slice(0, 2)),
        to_m: Number(p.to.slice(3)),
        days: scheduleDays(p.days),
      }, WINDOW_BODY, 1)];
    },
  },

  // The action sink. Its INPUT SET mirrors the api flow-catalog exactly
  // (flowcatalog/catalog.json): `value` (Ein/Aus), `setpoint` (a numeric
  // series - the guided "Sollwert setzen" rule wires vp.logic.if.value here)
  // and `plan` (the DELEGATED strategy wunsch of the pilot chain / the AE7
  // starter templates). None is individually required; at least one must be
  // connected (requiresAnyInput, the api's `requires_any_input`).
  // Compilation collapses ALL of them onto the ONE vp-desired anchor - the
  // palette node publishes whatever payload reaches it, so no per-port
  // materialization is needed.
  'vp.entity.control': {
    version: '1.0.0',
    runtimes: ['edge'],
    minPalette: '0.2.0',
    requiresAnyInput: ['value', 'setpoint', 'plan'],
    ports: {
      in: {
        value: { type: 'bool' },
        setpoint: { type: 'timeseries' },
        plan: { type: 'plan' },
      },
      out: {},
    },
    validate(p) {
      const errs = [];
      if (!p || !ID_RE.test(p.entity_id || '')) errs.push('entity_id fehlt oder ist ungültig');
      if (!p || COMMANDS.indexOf(p.command) < 0) errs.push('command fehlt oder ist ungültig');
      const ttl = p && Math.floor(Number(p.ttl_s));
      if (!(ttl >= 1 && ttl <= 86400)) errs.push('ttl_s fehlt oder liegt außerhalb 1..86400');
      // D-19: the D-5 override lever is RESERVED for the generated consumer
      // artifact (vp.consumer.reactive stamps it from must_run). A catalog flow
      // carrying it - even override:false - is refused, so no customer document
      // can ever outrank the market plan through this node.
      if (p && p.override !== undefined) {
        errs.push('override ist der generierten Verbraucherregel vorbehalten');
      }
      return errs;
    },
    requires(p) {
      return [{ entity_id: p.entity_id, capabilities: ['actuate:' + p.command] }];
    },
    claims(p) {
      return [{ entity_id: p.entity_id, commands: [p.command] }];
    },
    compile(ctx, node) {
      const p = node.parameters;
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-desired',
        z: ctx.tabId,
        name: node.label || 'Entität steuern',
        core: ctx.coreId,
        entity: p.entity_id,
        command: p.command,
        ttl_s: Math.floor(Number(p.ttl_s)),
        override: p.override === true,
        flowId: ctx.flowId,
        flowVersion: ctx.flowVersion,
        nodeId: node.id,
      }];
    },
  },

  'vp.notify.push': {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    // Input is an EVENT (fed by vp.logic.gate's rising edge), matching the api
    // + portal catalogs. A bare bool cannot reach this input: the editor-side
    // FlowGraphValidator forbids bool -> event, so a notification is always
    // wired Schwellwert -> Wenn/Dann (gate) -> Benachrichtigung.
    ports: { in: { trigger: { type: 'event', required: true } }, out: {} },
    validate(p) {
      if (!p || typeof p.message !== 'string' || p.message.length < 1 || p.message.length > 200) {
        return ['message fehlt oder ist länger als 200 Zeichen'];
      }
      return [];
    },
    requires() {
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node) {
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-notify',
        z: ctx.tabId,
        name: node.label || 'Benachrichtigung',
        core: ctx.coreId,
        message: node.parameters.message,
      }];
    },
  },

  // vp.modbus.read (MB-M1): the generic Modbus-TCP register READ - the
  // catalog-scoped power-user escape hatch of flow-graph.md §6 (decision
  // D-15: transport-level parameters allowed ONLY in the vp.modbus.* domain,
  // runtime-edge-only, read free). Compiles to the DATA-ONLY vp-modbus-read
  // palette node (0.3.0) - no generated code, the whitelisted-codegen stance
  // is untouched. The register count is DERIVED from data_type (1 or 2
  // words); an optional {entity_id, channel} mapping additionally records
  // each reading as edge-entity telemetry, which `requires` then verifies
  // against the device's applied registry (measure:<channel>).
  'vp.modbus.read': {
    version: '1.0.0',
    runtimes: ['edge'],
    minPalette: '0.3.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { value: { type: 'number' } } },
    validate(p) {
      const errs = [];
      if (!p) p = {};
      if (!validHost(p.host)) errs.push('Geräteadresse fehlt oder ist keine gültige IP/Hostname');
      if (p.port !== undefined && !(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)) {
        errs.push('port muss 1..65535 sein');
      }
      if (p.unit_id !== undefined && !(Number.isInteger(p.unit_id) && p.unit_id >= 0 && p.unit_id <= 255)) {
        errs.push('unit_id muss 0..255 sein');
      }
      if (p.register_kind !== undefined && ['holding', 'input'].indexOf(p.register_kind) < 0) {
        errs.push('register_kind muss holding oder input sein');
      }
      if (!(Number.isInteger(p.address) && p.address >= 0 && p.address <= 65535)) {
        errs.push('address fehlt oder liegt außerhalb 0..65535');
      }
      if (p.data_type !== undefined
          && ['u16', 's16', 'u32', 's32', 'float32'].indexOf(p.data_type) < 0) {
        errs.push('data_type ist unbekannt');
      }
      if (p.word_order !== undefined && ['big', 'little'].indexOf(p.word_order) < 0) {
        errs.push('word_order muss big oder little sein');
      }
      if (p.scale !== undefined && !num(p.scale)) errs.push('scale muss eine Zahl sein');
      if (p.offset !== undefined && !num(p.offset)) errs.push('offset muss eine Zahl sein');
      if (p.min_read_interval_s !== undefined
          && !(Number.isInteger(p.min_read_interval_s)
            && p.min_read_interval_s >= 1 && p.min_read_interval_s <= 3600)) {
        errs.push('min_read_interval_s muss 1..3600 sein');
      }
      // Entity mapping: both-or-neither (a channel without an entity - or the
      // reverse - records nowhere and is a config mistake, not a default).
      const hasEntity = p.entity_id !== undefined && p.entity_id !== '';
      const hasChannel = p.channel !== undefined && p.channel !== '';
      if (hasEntity !== hasChannel) {
        errs.push('entity_id und channel gehören zusammen - beide angeben oder beide leer lassen');
      }
      if (hasEntity && !ID_RE.test(p.entity_id)) errs.push('entity_id ist ungültig');
      if (hasChannel && !CHANNEL_RE.test(p.channel)) errs.push('channel ist ungültig');
      return errs;
    },
    requires(p) {
      if (p && p.entity_id && p.channel) {
        return [{ entity_id: p.entity_id, capabilities: ['measure:' + p.channel] }];
      }
      return [];
    },
    claims() {
      return [];
    },
    compile(ctx, node, extras) {
      const p = node.parameters || {};
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-modbus-read',
        z: ctx.tabId,
        name: node.label || 'Modbus lesen',
        core: ctx.coreId,
        host: p.host,
        port: Number.isInteger(p.port) ? p.port : 502,
        unit_id: Number.isInteger(p.unit_id) ? p.unit_id : 1,
        register_kind: p.register_kind === 'input' ? 'input' : 'holding',
        address: p.address,
        data_type: typeof p.data_type === 'string' && p.data_type ? p.data_type : 'u16',
        word_order: p.word_order === 'little' ? 'little' : 'big',
        scale: num(p.scale) ? p.scale : 1,
        offset: num(p.offset) ? p.offset : 0,
        min_read_interval_s: Number.isInteger(p.min_read_interval_s) ? p.min_read_interval_s : 5,
        entity: p.entity_id || '',
        channel: p.channel || '',
        deadband: extras && num(extras.deadband) ? extras.deadband : 0,
      }];
    },
  },

  // vp.modbus.switch (Einheitsmodell Stufe 4): the GENERATED-ONLY switch
  // executor of a self-built Modbus device. There is deliberately no free
  // Modbus WRITE building block - this node exists only after the per-device
  // release (guided switch test + the customer's confirmation of the physical
  // effect), and the api is its single author. `generatedOrigin` makes
  // compile.js refuse it in any document that is not the device's own
  // origin-stamped flow.
  //
  // It writes ONE register: either the two released on/off constants, or a
  // value inside the released min/max clamp with the released scale/offset. It
  // lives in the SAME flow as that device's read nodes and shares their
  // per-target queue - never a second TCP path to one device.
  'vp.modbus.switch': {
    version: '1.0.0',
    label: 'Schalter (generiert)',
    runtimes: ['edge'],
    minPalette: '0.7.0',
    generatedOrigin: 'modbus-device',
    ports: { in: {}, out: {} },
    validate(p) {
      const errs = [];
      if (!p || typeof p !== 'object') return ['Parameter fehlen'];
      if (typeof p.entity_id !== 'string' || !p.entity_id) errs.push('entity_id fehlt');
      const kind = p.kind;
      if (kind !== 'on_off' && kind !== 'setpoint') errs.push('kind muss on_off oder setpoint sein');
      if (typeof p.host !== 'string' || !p.host.trim()) errs.push('host fehlt');
      if (!Number.isInteger(p.address) || p.address < 0 || p.address > 65535) {
        errs.push('address muss 0..65535 sein');
      }
      const fc = Number(p.fc);
      if (fc !== 5 && fc !== 6 && fc !== 16) errs.push('fc muss 5, 6 oder 16 sein');
      const reg16 = (v, name) => {
        if (!Number.isInteger(v) || v < 0 || v > 65535) errs.push(name + ' muss 0..65535 sein');
      };
      if (kind === 'on_off') {
        reg16(p.on_value, 'on_value');
        reg16(p.off_value, 'off_value');
        if (fc === 5 && ![0, 1].includes(p.on_value)) errs.push('eine Spule kennt nur 0 und 1');
        if (fc === 5 && ![0, 1].includes(p.off_value)) errs.push('eine Spule kennt nur 0 und 1');
      } else if (kind === 'setpoint') {
        if (fc === 5) errs.push('ein Sollwert braucht ein Register, keine Spule');
        if (!num(p.min_value) || !num(p.max_value) || !num(p.safe_value)) {
          errs.push('ein Sollwert braucht min_value, max_value und safe_value');
        } else if (p.min_value > p.max_value) {
          errs.push('min_value darf nicht groesser als max_value sein');
        }
        if (p.scale !== undefined && (!num(p.scale) || p.scale === 0)) {
          errs.push('scale muss eine Zahl ungleich 0 sein');
        }
      }
      return errs;
    },
    // The switch WRITES to its entity, so it claims it - the V-5 exclusive
    // control claim is what stops a second rule from fighting over the device.
    requires(p) {
      if (p && p.entity_id) {
        return [{ entity_id: p.entity_id, capabilities: [p.kind === 'setpoint' ? 'actuate:setpoint_kw' : 'actuate:on_off'] }];
      }
      return [];
    },
    claims(p) {
      if (!p || !p.entity_id) return [];
      return [{ entity_id: p.entity_id, commands: [p.kind === 'setpoint' ? 'setpoint_kw' : 'on_off'] }];
    },
    compile(ctx, node) {
      const p = node.parameters || {};
      const out = {
        id: ctx.nrId(node.id),
        type: 'vp-modbus-switch',
        z: ctx.tabId,
        name: node.label || 'Schalter',
        core: ctx.coreId,
        entity_id: p.entity_id,
        kind: p.kind === 'setpoint' ? 'setpoint' : 'on_off',
        host: p.host,
        port: Number.isInteger(p.port) ? p.port : 502,
        unit_id: Number.isInteger(p.unit_id) ? p.unit_id : 1,
        fc: Number(p.fc),
        address: p.address,
        scale: num(p.scale) ? p.scale : 1,
        offset: num(p.offset) ? p.offset : 0,
      };
      // Only the fields the released kind really has travel: a setpoint node
      // carrying an on_value would suggest a constant nobody released.
      if (out.kind === 'on_off') {
        out.on_value = p.on_value;
        out.off_value = p.off_value;
      } else {
        out.min_value = p.min_value;
        out.max_value = p.max_value;
        out.safe_value = p.safe_value;
      }
      if (Number.isInteger(p.readback_address)) out.readback_address = p.readback_address;
      if (Number.isInteger(p.watchdog_address)) {
        out.watchdog_address = p.watchdog_address;
        out.watchdog_value = Number.isInteger(p.watchdog_value) ? p.watchdog_value : 0;
      }
      return [out];
    },
  },

  'vp.strategy.market': strategyType('Marktoptimierung', STRATEGY_INPUTS.market),
  'vp.strategy.peakshaving': strategyType('Lastspitzenkappung', STRATEGY_INPUTS.peakshaving),
  'vp.strategy.atypical-grid': strategyType('Atypische Netznutzung', STRATEGY_INPUTS.atypicalGrid),

  // vp.mqtt.read (P5 Ebene 1, Konzept vp-deye-diybms-luecke-l5 §3.2b): the
  // GENERATED-ONLY MQTT read of a self-connected battery. The api's
  // UserDefinedBatteryFlowCompiler is its single author (`generatedOrigin`
  // makes compile.js refuse it in any document that is not the device's own
  // origin-stamped flow) - there is deliberately no free MQTT block yet: the
  // field-mapping UI with its live preview is a later package (P5d), and a
  // free block whose aggregate semantics no editor can render would be a
  // promise the product does not keep.
  //
  // ONE node per device, never one per channel: a single broker connection
  // serves every mapping, and two mappings on the same topic filter share one
  // subscription (the "never a second path to one device" discipline). It
  // compiles to the DATA-ONLY vp-mqtt-read palette node (0.10.0) - no
  // generated code, the whitelisted-codegen stance is untouched.
  'vp.mqtt.read': {
    version: '1.0.0',
    label: 'MQTT lesen (generiert)',
    runtimes: ['edge'],
    minPalette: '0.10.0',
    generatedOrigin: 'mqtt-device',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: { value: { type: 'number' } } },
    validate(p) {
      return validateMqttRead(p);
    },
    // Every mapped channel must be DECLARED by the entity - the same rule
    // vp.modbus.read follows, so a mapping onto a channel the battery does not
    // measure is refused before it can record nowhere.
    requires(p) {
      if (!p || !p.entity_id || !Array.isArray(p.mappings)) return [];
      const caps = [];
      for (const m of p.mappings) {
        if (m && typeof m.channel === 'string' && CHANNEL_RE.test(m.channel)) {
          caps.push('measure:' + m.channel);
        }
      }
      return caps.length ? [{ entity_id: p.entity_id, capabilities: caps }] : [];
    },
    // A read node never claims: it drives no actuation.
    claims() {
      return [];
    },
    compile(ctx, node) {
      const p = node.parameters || {};
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-mqtt-read',
        z: ctx.tabId,
        name: node.label || 'MQTT lesen',
        core: ctx.coreId,
        host: p.host,
        port: Number.isInteger(p.port) ? p.port : 1883,
        entity: p.entity_id,
        mappings: normalizeMqttMappings(p.mappings),
      }];
    },
  },

  // vp.soc.derive (P5b Ebene 2, Konzept vp-deye-diybms-luecke-l5 §3.2b): the
  // GENERATED-ONLY SoC DERIVATION of a self-connected battery. It takes the
  // standard battery channels a level-1 source just delivered (today
  // vp.mqtt.read, tomorrow an HTTP read type) and turns them into ONE state of
  // charge - taken over directly, computed from the OCV curve, or counted from
  // charge - published as ordinary telemetry together with its ORIGIN
  // (soc_source_code), so cloud, optimizer and portal read it like any other
  // SoC and the history keeps the source of the time.
  //
  // It hangs on an EDGE from the read node, never on the trigger (triggerable
  // is false, and that is load-bearing): the tick hits the SOURCE, and this
  // node computes on what the source just sent. Fired by the tick itself it
  // would compute on the PREVIOUS tick's values, and the order of two
  // simultaneously fired nodes is nothing to build a state of charge on.
  //
  // Same origin kind as vp.mqtt.read: the api's UserDefinedBatteryFlowCompiler
  // is the single author of both, and neither is a free editor block while the
  // mapping/curve UI (P5d) is still to come.
  'vp.soc.derive': {
    version: '1.0.0',
    label: 'Ladestand ableiten (generiert)',
    runtimes: ['edge'],
    minPalette: '0.11.0',
    generatedOrigin: 'mqtt-device',
    triggerable: false,
    ports: {
      in: { channels: { type: 'number', required: true } },
      out: { value: { type: 'number' } },
    },
    validate(p) {
      return validateSocDerive(p);
    },
    // The node PRODUCES soc_pct + soc_source_code, so the entity must declare
    // them - the honesty mirror of vp.mqtt.read's rule: a derivation whose
    // result the battery does not declare would record nowhere.
    requires(p) {
      if (!p || !p.entity_id) return [];
      return [{
        entity_id: p.entity_id,
        capabilities: ['measure:soc_pct', 'measure:soc_source_code'],
      }];
    },
    // A derivation never claims: it drives no actuation.
    claims() {
      return [];
    },
    compile(ctx, node) {
      const p = node.parameters || {};
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-soc-derive',
        z: ctx.tabId,
        name: node.label || 'Ladestand',
        core: ctx.coreId,
        entity: p.entity_id,
        method: p.method,
        prefer_direct: p.prefer_direct !== false,
        hold_s: Number.isInteger(p.hold_s) ? p.hold_s : SOC_DEFAULT_HOLD_S,
        inputs: normalizeSocInputs(p.inputs),
        params: normalizeSocParams(p.params),
      }];
    },
  },

  // vp.consumer.reactive (D-19, Verbrauchssteuerung Inkrement 4 §13.2): the
  // GENERATED-ONLY reactive consumer-policy node. The cloud policy compiler is
  // its single author (compile.js refuses it in a document without the
  // server-stamped consumer-policy origin); it never appears in the editor
  // palette (api/portal catalogs mark it generated:true). It compiles to ONE
  // vp-consumer-policy palette node (0.5.0) that evaluates the compiled spec
  // locally - three-state logic (unknown NEVER starts), per-signal max_age_s
  // freshness, hysteresis via reset_value, precomputed UTC price windows (D1:
  // after the last window the condition is `unknown`) and an off-delay
  // debounce on ending - and, while active, publishes a desired with the SAME
  // shape as vp-desired, with `override` stamped from must_run (D-5 boost,
  // short continuously renewed TTL; the core's 4-h cap holds).
  'vp.consumer.reactive': {
    version: '1.0.0',
    generatedOrigin: 'consumer-policy',
    runtimes: ['edge'],
    minPalette: '0.5.0',
    triggerable: true,
    ports: { in: { trigger: { type: 'event' } }, out: {} },
    validate(p) {
      return validateReactiveSpec(p);
    },
    requires(p) {
      return [{ entity_id: p.entity_id, capabilities: ['actuate:' + p.command] }];
    },
    claims(p) {
      return [{ entity_id: p.entity_id, commands: [p.command] }];
    },
    compile(ctx, node) {
      const p = node.parameters;
      return [{
        id: ctx.nrId(node.id),
        type: 'vp-consumer-policy',
        z: ctx.tabId,
        name: node.label || 'Verbraucherregel',
        core: ctx.coreId,
        entity: p.entity_id,
        command: p.command,
        ttl_s: Math.floor(Number(p.ttl_s)),
        renew_s: Math.floor(Number(p.renew_s)),
        off_delay_s: Math.floor(Number(p.off_delay_s)),
        requirements: p.requirements,
        flowId: ctx.flowId,
        flowVersion: ctx.flowVersion,
        nodeId: node.id,
      }];
    },
  },
};

// --- vp.mqtt.read mapping validation (P5 Ebene 1). Der ZWILLING der
// Cloud-Regel (services/api .../batteries/UserDefinedBatteryDefinition.java)
// und der Laufzeit (vp-palette/lib/mqtt-mapping.js): dieselben Vokabulare,
// dieselben Schranken. Wer eines aendert, aendert alle drei - sonst nimmt der
// Compiler an, was die Box verwirft, oder umgekehrt.
const MQTT_AGGREGATES = ['last', 'min', 'max', 'sum', 'avg', 'count'];
const MQTT_VALUE_TYPES = ['number', 'bool'];
// Ein Wahrheitswert kennt nur last/min/max: min ist das konservative UND,
// max das ODER. Die SUMME von Freigaben ist keine Freigabe, und ein Mittel
// von 0,5 waere eine Zahl, die kein Geraet je gemeldet hat.
const MQTT_BOOL_AGGREGATES = ['last', 'min', 'max'];
const MQTT_MAX_MAPPINGS = 16;
const MQTT_MAX_TOPIC = 200;
const MQTT_MAX_PATH = 200;
const MQTT_MIN_STALE_S = 5;
const MQTT_MAX_STALE_S = 86400;
const MQTT_DEFAULT_STALE_S = 300;
// Ein Wertepfad ist punkt-getrennt; `__proto__` & Co. sind ueberall verboten
// (Prototyp-Vergiftung - dieselbe Regel wie vp-feed.topicFor).
const MQTT_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}(\.[A-Za-z0-9_][A-Za-z0-9_-]{0,63})*$/;
const MQTT_FORBIDDEN_SEGMENTS = ['__proto__', 'constructor', 'prototype'];

// Ein MQTT-Filter: `+` steht fuer GENAU ein Segment, `#` nur als letztes.
function validTopicFilter(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > MQTT_MAX_TOPIC) return false;
  if (v.indexOf(' ') >= 0) return false;
  const parts = v.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === '#') {
      if (i !== parts.length - 1) return false;
    } else if (seg.indexOf('#') >= 0 || (seg.indexOf('+') >= 0 && seg !== '+')) {
      return false;
    }
  }
  return true;
}

function validValuePath(v) {
  if (v === undefined || v === null || v === '') return true; // Nutzlast IST der Wert
  if (typeof v !== 'string' || v.length > MQTT_MAX_PATH) return false;
  if (!MQTT_PATH_RE.test(v)) return false;
  return v.split('.').every((seg) => MQTT_FORBIDDEN_SEGMENTS.indexOf(seg) < 0);
}

function validateMqttRead(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['Parameter fehlen'];
  if (!ID_RE.test(p.entity_id || '')) errs.push('entity_id fehlt oder ist ungueltig');
  if (!validHost(p.host)) errs.push('Broker-Adresse fehlt oder ist keine gueltige IP/Hostname');
  if (p.port !== undefined && !(Number.isInteger(p.port) && p.port >= 1 && p.port <= 65535)) {
    errs.push('port muss 1..65535 sein');
  }
  const list = p.mappings;
  if (!Array.isArray(list) || list.length === 0) {
    errs.push('mappings fehlt - ohne Feld-Zuordnung entsteht kein Messwert');
    return errs;
  }
  if (list.length > MQTT_MAX_MAPPINGS) {
    errs.push('hoechstens ' + MQTT_MAX_MAPPINGS + ' Zuordnungen je Geraet');
  }
  const seen = {};
  list.forEach((m, i) => {
    const where = 'Zuordnung ' + (i + 1) + ': ';
    if (!m || typeof m !== 'object') {
      errs.push(where + 'ist leer');
      return;
    }
    if (!CHANNEL_RE.test(m.channel || '')) {
      errs.push(where + 'channel fehlt oder ist ungueltig');
    } else if (Object.prototype.hasOwnProperty.call(seen, m.channel)) {
      errs.push(where + 'der Kanal "' + m.channel + '" ist schon zugeordnet');
    } else {
      seen[m.channel] = true;
    }
    if (!validTopicFilter(m.topic)) errs.push(where + 'topic fehlt oder ist kein gueltiger Filter');
    if (!validValuePath(m.path)) errs.push(where + 'path ist kein gueltiger Wertepfad');
    if (m.aggregate !== undefined && MQTT_AGGREGATES.indexOf(m.aggregate) < 0) {
      errs.push(where + 'aggregate ist unbekannt');
    }
    if (m.value_type !== undefined && MQTT_VALUE_TYPES.indexOf(m.value_type) < 0) {
      errs.push(where + 'value_type muss number oder bool sein');
    } else if (m.value_type === 'bool' && m.aggregate !== undefined
        && MQTT_BOOL_AGGREGATES.indexOf(m.aggregate) < 0) {
      errs.push(where + 'ein Ja/Nein-Wert kennt nur last, min oder max');
    }
    if (m.scale !== undefined && (!num(m.scale) || m.scale === 0)) {
      errs.push(where + 'scale muss eine Zahl ungleich 0 sein');
    }
    if (m.offset !== undefined && !num(m.offset)) errs.push(where + 'offset muss eine Zahl sein');
    if (m.sentinel !== undefined && m.sentinel !== null && !num(m.sentinel)) {
      errs.push(where + 'sentinel muss eine Zahl sein');
    }
    if (m.stale_s !== undefined && !(Number.isInteger(m.stale_s)
        && m.stale_s >= MQTT_MIN_STALE_S && m.stale_s <= MQTT_MAX_STALE_S)) {
      errs.push(where + 'stale_s muss ' + MQTT_MIN_STALE_S + '..' + MQTT_MAX_STALE_S + ' sein');
    }
  });
  return errs;
}

// Die kompilierte Form ist VOLLSTAENDIG: jede Vorgabe steht ausgeschrieben im
// Artefakt. Danach raet auf der Box niemand mehr an einer Vorgabe herum - und
// eine geaenderte Vorgabe waere sonst eine stille Verhaltensaenderung auf
// jeder schon ausgerollten Batterie.
function normalizeMqttMappings(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    const out = {
      channel: m.channel,
      topic: m.topic,
      path: typeof m.path === 'string' ? m.path : '',
      aggregate: MQTT_AGGREGATES.indexOf(m.aggregate) >= 0 ? m.aggregate : 'last',
      value_type: m.value_type === 'bool' ? 'bool' : 'number',
      scale: num(m.scale) ? m.scale : 1,
      offset: num(m.offset) ? m.offset : 0,
      stale_s: Number.isInteger(m.stale_s) ? m.stale_s : MQTT_DEFAULT_STALE_S,
    };
    if (num(m.sentinel)) out.sentinel = m.sentinel;
    if (Array.isArray(m.true_values)) out.true_values = m.true_values.slice();
    if (Array.isArray(m.false_values)) out.false_values = m.false_values.slice();
    return out;
  });
}

// --- vp.soc.derive validation (P5b Ebene 2). Der ZWILLING der Cloud-Regel
// (services/api .../components/UserDefinedBatteryDefinition.checkSoc) und der
// Laufzeit (vp-palette/lib/soc-derivation.js): dieselben Methoden, dieselben
// Schranken, dieselbe Kurven-Regel. Wer eines aendert, aendert alle drei.
const SOC_METHODS = ['direct', 'ocv_curve', 'coulomb'];
const SOC_INPUT_ROLES = ['soc', 'cell_min', 'cell_max', 'voltage', 'current', 'power'];
const SOC_INPUT_DEFAULTS = {
  soc: 'soc_pct',
  cell_min: 'cell_min_mv',
  cell_max: 'cell_max_mv',
  voltage: 'voltage_v',
  current: 'current_a',
  power: 'power_kw',
};
const SOC_MIN_CURVE_POINTS = 2;
const SOC_MAX_CURVE_POINTS = 64;
const SOC_MIN_CELL_V = 0.5;
const SOC_MAX_CELL_V = 5.0;
const SOC_DEFAULT_HOLD_S = 900;
const SOC_MIN_HOLD_S = 60;
const SOC_MAX_HOLD_S = 86400;
const SOC_DEFAULT_ROUND_PCT = 0.1;
const SOC_MAX_ROUND_PCT = 5.0;
const SOC_MAX_CELLS = 1024;
const SOC_MAX_CAPACITY_KWH = 10000;

// Eine Kennlinie STEIGT. Eine, die bei hoeherer Spannung einen kleineren
// Ladestand nennt, beschreibt keine Lithium-Zelle - sie ist ein Tippfehler, der
// stillschweigend einen falschen Ladestand ausgerechnet haette.
function validSocCurve(raw, where, errs) {
  if (!Array.isArray(raw)) {
    errs.push(where + ' ist keine Kennlinie');
    return false;
  }
  if (raw.length < SOC_MIN_CURVE_POINTS || raw.length > SOC_MAX_CURVE_POINTS) {
    errs.push(where + ' braucht ' + SOC_MIN_CURVE_POINTS + '..' + SOC_MAX_CURVE_POINTS
      + ' Stuetzpunkte');
    return false;
  }
  const pts = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2 || !num(p[0]) || !num(p[1])) {
      errs.push(where + ': ein Stuetzpunkt braucht Spannung und Ladestand');
      return false;
    }
    if (p[0] < SOC_MIN_CELL_V || p[0] > SOC_MAX_CELL_V) {
      errs.push(where + ': Zellspannung ausserhalb ' + SOC_MIN_CELL_V + '..' + SOC_MAX_CELL_V);
      return false;
    }
    if (p[1] < 0 || p[1] > 100) {
      errs.push(where + ': Ladestand ausserhalb 0..100');
      return false;
    }
    pts.push([p[0], p[1]]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] === pts[i - 1][0]) {
      errs.push(where + ': die Zellspannung ' + pts[i][0] + ' V steht zweimal');
      return false;
    }
    if (pts[i][1] < pts[i - 1][1]) {
      errs.push(where + ': eine Kennlinie faellt nicht mit steigender Spannung');
      return false;
    }
  }
  return true;
}

function validateSocDerive(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['Parameter fehlen'];
  if (!ID_RE.test(p.entity_id || '')) errs.push('entity_id fehlt oder ist ungueltig');
  if (SOC_METHODS.indexOf(p.method) < 0) {
    errs.push('method muss ' + SOC_METHODS.join('/') + ' sein');
    return errs;
  }
  if (p.hold_s !== undefined && !(Number.isInteger(p.hold_s)
      && p.hold_s >= SOC_MIN_HOLD_S && p.hold_s <= SOC_MAX_HOLD_S)) {
    errs.push('hold_s muss ' + SOC_MIN_HOLD_S + '..' + SOC_MAX_HOLD_S + ' sein');
  }
  const inputs = p.inputs && typeof p.inputs === 'object' ? p.inputs : {};
  for (const role of Object.keys(inputs)) {
    if (SOC_INPUT_ROLES.indexOf(role) < 0) {
      errs.push('unbekannter Eingang: ' + role);
    } else if (!CHANNEL_RE.test(inputs[role] || '')) {
      errs.push('Eingang ' + role + ' nennt keinen gueltigen Kanal');
    }
  }
  const params = p.params && typeof p.params === 'object' ? p.params : {};
  if (params.curve_charge !== undefined) {
    validSocCurve(params.curve_charge, 'curve_charge', errs);
  }
  if (params.curve_discharge !== undefined) {
    validSocCurve(params.curve_discharge, 'curve_discharge', errs);
  }
  if (params.cells_in_series !== undefined && !(Number.isInteger(params.cells_in_series)
      && params.cells_in_series >= 1 && params.cells_in_series <= SOC_MAX_CELLS)) {
    errs.push('cells_in_series muss 1..' + SOC_MAX_CELLS + ' sein');
  }
  if (params.round_pct !== undefined && !(num(params.round_pct) && params.round_pct > 0
      && params.round_pct <= SOC_MAX_ROUND_PCT)) {
    errs.push('round_pct muss > 0 und <= ' + SOC_MAX_ROUND_PCT + ' sein');
  }
  if (params.capacity_kwh !== undefined && !(num(params.capacity_kwh)
      && params.capacity_kwh > 0 && params.capacity_kwh <= SOC_MAX_CAPACITY_KWH)) {
    errs.push('capacity_kwh muss > 0 und <= ' + SOC_MAX_CAPACITY_KWH + ' sein');
  }
  if (params.efficiency_pct !== undefined && !(num(params.efficiency_pct)
      && params.efficiency_pct > 0 && params.efficiency_pct <= 100)) {
    errs.push('efficiency_pct muss > 0 und <= 100 sein');
  }
  if (params.nominal_voltage_v !== undefined && !(num(params.nominal_voltage_v)
      && params.nominal_voltage_v > 0 && params.nominal_voltage_v <= 1500)) {
    errs.push('nominal_voltage_v muss > 0 und <= 1500 sein');
  }
  if (params.anchor !== undefined) {
    const a = params.anchor;
    if (!a || typeof a !== 'object' || !num(a.soc_pct) || a.soc_pct < 0 || a.soc_pct > 100) {
      errs.push('anchor.soc_pct muss 0..100 sein');
    }
  }

  // Die EHRLICHKEITSREGEL, die diese Stufe traegt: kein Ladestand ohne Eingang.
  // Sie steht hier ein zweites Mal, weil ein ausgerolltes Dokument nie darauf
  // bauen darf, dass es sauber erzeugt wurde.
  if (p.method === 'ocv_curve' && !Array.isArray(params.curve_charge)) {
    errs.push('ocv_curve ohne curve_charge - eine Kennlinie ohne Stuetzpunkte rechnet nichts');
  }
  if (p.method === 'coulomb') {
    if (!num(params.capacity_kwh)) {
      errs.push('coulomb ohne capacity_kwh - ohne Kapazitaet zaehlt niemand');
    }
    // Ob der ANKER-Ersatz da ist (ein zugeordnetes soc_pct), sieht nur die
    // Cloud: flowc kennt die Feld-Zuordnung des Lese-Knotens nicht, und ein
    // Verbot, das hier raten muesste, waere schlechter als keines. Die Regel
    // steht deshalb vollstaendig in UserDefinedBatteryDefinition.checkSoc.
  }
  return errs;
}

// Die kompilierte Form ist VOLLSTAENDIG: jede Vorgabe steht ausgeschrieben im
// Artefakt (dieselbe Regel wie bei den MQTT-Zuordnungen).
function normalizeSocInputs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const role of SOC_INPUT_ROLES.slice().sort()) {
    out[role] = typeof src[role] === 'string' && src[role] !== ''
      ? src[role] : SOC_INPUT_DEFAULTS[role];
  }
  return out;
}

function normalizeSocParams(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = {
    conservative_min: p.conservative_min !== false,
    round_pct: num(p.round_pct) && p.round_pct > 0 ? p.round_pct : SOC_DEFAULT_ROUND_PCT,
  };
  if (Array.isArray(p.curve_charge)) out.curve_charge = p.curve_charge.map((q) => q.slice());
  if (Array.isArray(p.curve_discharge)) {
    out.curve_discharge = p.curve_discharge.map((q) => q.slice());
  }
  if (Number.isInteger(p.cells_in_series)) out.cells_in_series = p.cells_in_series;
  if (num(p.capacity_kwh)) out.capacity_kwh = p.capacity_kwh;
  if (num(p.efficiency_pct)) out.efficiency_pct = p.efficiency_pct;
  if (num(p.nominal_voltage_v)) out.nominal_voltage_v = p.nominal_voltage_v;
  if (p.anchor && typeof p.anchor === 'object' && num(p.anchor.soc_pct)) {
    out.anchor = { soc_pct: p.anchor.soc_pct };
    if (typeof p.anchor.at === 'string' && p.anchor.at !== '') out.anchor.at = p.anchor.at;
  }
  if (p.recalibrate && typeof p.recalibrate === 'object') {
    const r = {};
    if (num(p.recalibrate.full_cell_mv) && num(p.recalibrate.full_soc_pct)) {
      r.full_cell_mv = p.recalibrate.full_cell_mv;
      r.full_soc_pct = p.recalibrate.full_soc_pct;
    }
    if (num(p.recalibrate.empty_cell_mv) && num(p.recalibrate.empty_soc_pct)) {
      r.empty_cell_mv = p.recalibrate.empty_cell_mv;
      r.empty_soc_pct = p.recalibrate.empty_soc_pct;
    }
    if (Object.keys(r).length > 0) out.recalibrate = r;
  }
  return out;
}

// --- vp.consumer.reactive spec validation (shared shape with the cloud
// policy compiler and the vp-consumer-policy runtime; reactive-eval.js is the
// evaluation twin). Limits mirror the consumer-policy contract (§10).
const REACTIVE_COMMANDS = ['on_off', 'setpoint_kw', 'mode'];
const REACTIVE_OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'ne'];
const REACTIVE_SOURCES = ['site', 'entity'];
const MAX_REQUIREMENTS = 32;
const MAX_TREE_DEPTH = 4;
const MAX_TREE_NODES = 24;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateReactiveSpec(p) {
  const errs = [];
  if (!p) return ['parameters fehlen'];
  if (!ID_RE.test(p.entity_id || '')) errs.push('entity_id fehlt oder ist ungültig');
  if (REACTIVE_COMMANDS.indexOf(p.command) < 0) errs.push('command fehlt oder ist ungültig');
  const ttl = Math.floor(Number(p.ttl_s));
  if (!(ttl >= 1 && ttl <= 86400)) errs.push('ttl_s fehlt oder liegt außerhalb 1..86400');
  const renew = Math.floor(Number(p.renew_s));
  if (!(renew >= 1 && renew <= 3600)) errs.push('renew_s fehlt oder liegt außerhalb 1..3600');
  if (errs.length === 0 && renew * 2 > ttl) {
    errs.push('renew_s muss höchstens die halbe ttl_s sein (sonst reißt die Erneuerungskette)');
  }
  const offDelay = Math.floor(Number(p.off_delay_s));
  if (!(offDelay >= 0 && offDelay <= 3600)) errs.push('off_delay_s fehlt oder liegt außerhalb 0..3600');
  if (!Array.isArray(p.requirements) || p.requirements.length < 1
      || p.requirements.length > MAX_REQUIREMENTS) {
    errs.push('requirements fehlt oder ist leer');
    return errs;
  }
  const seenIds = {};
  for (const req of p.requirements) {
    if (!req || typeof req !== 'object') {
      errs.push('requirement ist kein Objekt');
      continue;
    }
    if (!ID_RE.test(req.id || '')) errs.push('requirement.id fehlt oder ist ungültig');
    else if (seenIds[req.id]) errs.push('requirement.id doppelt: ' + req.id);
    else seenIds[req.id] = true;
    if (typeof req.must_run !== 'boolean') errs.push('requirement.must_run fehlt');
    if (!validReactiveValue(p.command, req.value)) {
      errs.push('requirement.value passt nicht zum command ' + p.command);
    }
    const counter = { nodes: 0 };
    validateConditionTree(req.condition, 1, counter, errs);
    if (counter.nodes > MAX_TREE_NODES) errs.push('condition hat zu viele Elemente');
  }
  return errs;
}

function validReactiveValue(command, v) {
  switch (command) {
    case 'on_off':
      return typeof v === 'boolean';
    case 'setpoint_kw':
      return num(v) && v >= 0;
    case 'mode':
      return typeof v === 'string' && v.length >= 1 && v.length <= 64;
    default:
      return false;
  }
}

function validateConditionTree(cond, depth, counter, errs) {
  counter.nodes++;
  if (!cond || typeof cond !== 'object') {
    errs.push('condition fehlt oder ist kein Objekt');
    return;
  }
  if (depth > MAX_TREE_DEPTH) {
    errs.push('condition ist zu tief verschachtelt');
    return;
  }
  const groups = ['all', 'any', 'not', 'windows', 'signal']
    .filter((k) => cond[k] !== undefined);
  if (groups.length !== 1) {
    errs.push('condition muss genau eines von all/any/not/windows/signal tragen');
    return;
  }
  if (Array.isArray(cond.all) || Array.isArray(cond.any)) {
    const list = cond.all || cond.any;
    if (list.length < 1) errs.push('leere Bedingungsgruppe');
    for (const child of list) validateConditionTree(child, depth + 1, counter, errs);
    return;
  }
  if (cond.not !== undefined) {
    validateConditionTree(cond.not, depth + 1, counter, errs);
    return;
  }
  if (cond.windows !== undefined) {
    // Precompiled UTC windows (D1). Chronological, non-overlapping pairs.
    if (!Array.isArray(cond.windows) || cond.windows.length < 1) {
      errs.push('windows fehlt oder ist leer');
      return;
    }
    let last = null;
    for (const w of cond.windows) {
      if (!Array.isArray(w) || w.length !== 2
          || !ISO_RE.test(String(w[0])) || !ISO_RE.test(String(w[1]))) {
        errs.push('window muss ein [von, bis]-Paar aus RFC-3339-Zeitstempeln sein');
        return;
      }
      const from = Date.parse(w[0]);
      const to = Date.parse(w[1]);
      if (!(from < to)) errs.push('window: von muss vor bis liegen');
      if (last !== null && from < last) errs.push('windows müssen chronologisch und überlappungsfrei sein');
      last = to;
    }
    return;
  }
  // Local signal leaf.
  if (typeof cond.signal !== 'string' || cond.signal.length === 0) {
    errs.push('signal fehlt');
    return;
  }
  if (REACTIVE_SOURCES.indexOf(cond.source) < 0) errs.push('signal.source muss site oder entity sein');
  if (!CHANNEL_RE.test(cond.channel || '')) errs.push('signal.channel fehlt oder ist ungültig');
  if (REACTIVE_OPS.indexOf(cond.op) < 0) errs.push('signal.op ist unbekannt');
  if (!(num(cond.value) || typeof cond.value === 'boolean')) errs.push('signal.value fehlt');
  if (cond.reset_value !== undefined && !num(cond.reset_value)) errs.push('signal.reset_value muss eine Zahl sein');
  if (!(Number.isInteger(cond.max_age_s) && cond.max_age_s >= 1 && cond.max_age_s <= 86400)) {
    errs.push('signal.max_age_s fehlt oder liegt außerhalb 1..86400 (ein lokales Signal ohne Frische-Fenster startet nie ehrlich)');
  }
}

// strategyType: a strategy node DELEGATES its entity to the cloud
// co-optimizer (claims delegated:true); on the edge its compiled form is a
// deliberate no-op - the plan commands the entity as class 'market'
// (plan-execution-ownership.md). The claim still reserves the exclusive
// resource and the artifact still REQUIRES the actuate capability. Peak-shaving
// executes as the PS-3 edge peak guard driven by the v1 plan's
// grid_import_limit_kw / peak_reserve_soc_pct fields - never re-implemented here.
function strategyType(label, inputs) {
  return {
    version: '1.0.0',
    runtimes: ['edge', 'cloud'],
    minPalette: '0.2.0',
    ports: { in: inputs, out: { wunsch: { type: 'plan' } } },
    validate(p) {
      if (!p || !ID_RE.test(p.entity_id || '')) return ['entity_id fehlt oder ist ungültig'];
      return [];
    },
    requires(p) {
      return [{ entity_id: p.entity_id, capabilities: ['actuate:setpoint_kw'] }];
    },
    claims(p) {
      return [{ entity_id: p.entity_id, commands: ['setpoint_kw'], delegated: true }];
    },
    compile(ctx, node) {
      return [fnNode(ctx, node, node.label || label, {}, STRATEGY_BODY, 1)];
    },
  };
}

module.exports = { TYPES, ID_RE, CHANNEL_RE, COMMANDS };
