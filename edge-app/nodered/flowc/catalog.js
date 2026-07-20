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
 * info/config), never in code. There are no free code nodes (D1).
 */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const COMMANDS = ['setpoint_kw', 'on_off', 'limit_pct', 'limit_kw', 'mode'];
const HHMM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function num(v) {
  return typeof v === 'number' && isFinite(v);
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
  selfconsumption: { pv_forecast: { type: 'timeseries' }, soc: { type: 'timeseries' } },
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
        const ok = Array.isArray(p.days) && p.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (!ok) errs.push('days muss eine Liste aus 0..6 sein');
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
        days: Array.isArray(p.days) ? p.days : [],
      }, WINDOW_BODY, 1)];
    },
  },

  'vp.entity.control': {
    version: '1.0.0',
    runtimes: ['edge'],
    minPalette: '0.2.0',
    ports: {
      in: { value: { type: 'number|bool', required: true } },
      out: { result: { type: 'event' } },
    },
    validate(p) {
      const errs = [];
      if (!p || !ID_RE.test(p.entity_id || '')) errs.push('entity_id fehlt oder ist ungültig');
      if (!p || COMMANDS.indexOf(p.command) < 0) errs.push('command fehlt oder ist ungültig');
      const ttl = p && Math.floor(Number(p.ttl_s));
      if (!(ttl >= 1 && ttl <= 86400)) errs.push('ttl_s fehlt oder liegt außerhalb 1..86400');
      if (p && p.override !== undefined && typeof p.override !== 'boolean') {
        errs.push('override muss boolesch sein');
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
    ports: { in: { trigger: { type: 'bool', required: true } }, out: {} },
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

  'vp.strategy.market': strategyType('Marktoptimierung', STRATEGY_INPUTS.market),
  'vp.strategy.selfconsumption': strategyType('Eigenverbrauch', STRATEGY_INPUTS.selfconsumption),
  'vp.strategy.peakshaving': strategyType('Lastspitzenkappung', STRATEGY_INPUTS.peakshaving),
  'vp.strategy.atypical-grid': strategyType('Atypische Netznutzung', STRATEGY_INPUTS.atypicalGrid),
};

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
