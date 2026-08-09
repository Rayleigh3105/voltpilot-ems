'use strict';
/**
 * compile.js - the flow-graph -> Node-RED compiler (E2): turns a VALIDATED
 * flow-graph document (docs/contracts/v2/flow-graph.schema.json) into a
 * flow-artifact (docs/contracts/v2/flow-artifact.schema.json).
 *
 * Guarantees (flow-artifact.md §2):
 *   - only catalog node implementations: vp-palette nodes + GENERATED
 *     function nodes from fixed templates (catalog.js) - no user code paths;
 *   - deterministic output: same graph (+ same opts) -> byte-identical
 *     bundle -> identical content_hash; tab/node ids derive from
 *     (flow_id, flow_version) so a redeploy replaces instead of duplicating;
 *   - the @vp-flow ownership marker on every tab (reseed coexistence D-12);
 *   - content_hash = "sha256:" + sha256(JCS(bundle)) (canonicalize.js).
 *
 * validate() implements the compiler-relevant slice of the platform
 * validation rules (flow-graph.md §4): V-1 port types/arity, V-2 acyclic
 * modulo feedback, V-3 id/reference integrity, V-4 catalog resolution +
 * params, V-5 exclusive claims WITHIN the flow (cross-flow exclusivity is
 * activation-time platform work), V-7 trigger sanity, V-8 runtime whitelist.
 * Findings are machine-readable {rule, nodes, edges, message}.
 *
 * Compiled evaluation semantics (documented, v1): data nodes emit on change;
 * interval / slot-boundary triggers compile to inject nodes wired into every
 * triggerable data node (re-emit last value), so downstream desires re-emit
 * while values are flat; a value-change trigger writes its deadband into the
 * watched vp-entity-read node. Single-input node shapes only (the catalog is
 * designed for it), so wiring needs no port multiplexing.
 */

const { TYPES } = require('./catalog');
const { canonicalize, contentHash } = require('./canonicalize');
const crypto = require('crypto');

const COMPILER_VERSION = '1.0.0';
const MIN_CORE_VERSION = '0.1.0';
const OWNERSHIP_MARKER = '@vp-flow';
const MAX_ARTIFACT_BYTES = 262144;

class ValidationError extends Error {
  constructor(findings) {
    super('flow validation failed: ' + findings.map((f) => f.rule + ' ' + f.message).join('; '));
    this.findings = findings;
  }
}

function semverMax(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? a : b;
  }
  return a;
}

/**
 * The D-13 claim derivation - the compiler twin of the api's FlowClaims /
 * the portal's model.ts deriveClaims. Catalog templates, minus ONE structural
 * rule: an entity-control node whose `plan` input is fed by a DELEGATED
 * strategy claiming the SAME entity derives NO own claim (the strategy's
 * delegated claim covers the entity; otherwise the documented pilot chain
 * strategy -> control would V-5-conflict with itself).
 *
 * Returns a map graph-node-id -> claims[].
 */
function deriveClaims(graph) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = {};
  for (const n of nodes) byId[n.id] = n;

  const templateClaims = (n) => {
    const type = TYPES[n.type];
    if (!type || !type.claims) return [];
    return type.claims(n.parameters || {}) || [];
  };

  // Pass 1: delegated claims (strategies) - they never suppress.
  const delegatedEntities = new Set();
  for (const n of nodes) {
    for (const c of templateClaims(n)) {
      if (c.delegated === true) delegatedEntities.add(c.entity_id);
    }
  }

  const planFedByDelegated = (nodeId, entityId) => {
    if (!delegatedEntities.has(entityId)) return false;
    for (const e of edges) {
      if (!e.to || e.to.node !== nodeId || e.to.port !== 'plan') continue;
      const feeder = byId[e.from && e.from.node];
      if (!feeder) continue;
      for (const c of templateClaims(feeder)) {
        if (c.delegated === true && c.entity_id === entityId) return true;
      }
    }
    return false;
  };

  const out = {};
  for (const n of nodes) {
    out[n.id] = templateClaims(n).filter(
      (c) => c.delegated === true || !planFedByDelegated(n.id, c.entity_id));
  }
  return out;
}

/** validate returns the findings list (empty = valid). */
function validate(graph) {
  const f = [];
  const push = (rule, message, nodes, edges) =>
    f.push({ rule, message, nodes: nodes || [], edges: edges || [] });

  if (!graph || typeof graph !== 'object') {
    push('V-0', 'Dokument fehlt oder ist kein Objekt');
    return f;
  }
  if (graph.schema_version !== '1.0') push('V-0', 'schema_version muss "1.0" sein');
  if (graph.runtime !== 'edge') {
    push('V-8', 'dieser Compiler übersetzt nur runtime "edge" (Cloud-Flows laufen im Cloud-Runner)');
  }
  if (typeof graph.flow_id !== 'string' || graph.flow_id.length < 8) push('V-0', 'flow_id fehlt');
  if (!(Number.isInteger(graph.flow_version) && graph.flow_version >= 1)) push('V-0', 'flow_version fehlt');
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const triggers = Array.isArray(graph.triggers) ? graph.triggers : [];
  if (nodes.length === 0) push('V-0', 'Flow hat keine Knoten');

  const claimsByNode = deriveClaims(graph);

  // V-3 id uniqueness + V-4 catalog resolution + params.
  const byId = {};
  for (const n of nodes) {
    if (byId[n.id]) push('V-3', 'Knoten-ID doppelt: ' + n.id, [n.id]);
    byId[n.id] = n;
    const type = TYPES[n.type];
    if (!type) {
      push('V-4', 'unbekannter Katalogtyp ' + n.type, [n.id]);
      continue;
    }
    const wantMajor = String(n.type_version || '').split('.')[0];
    if (wantMajor !== type.version.split('.')[0]) {
      push('V-4', 'type_version ' + n.type_version + ' passt nicht zu Katalog ' + type.version, [n.id]);
    }
    if (graph.runtime && type.runtimes.indexOf(graph.runtime) < 0) {
      push('V-8', n.type + ' unterstützt die Laufzeit ' + graph.runtime + ' nicht', [n.id]);
    }
    for (const msg of type.validate(n.parameters || {})) {
      push('V-4', n.type + ': ' + msg, [n.id]);
    }
    // D-19: generated-only types are valid ONLY in a document the platform
    // stamped with the consumer-policy origin. The api refuses customer
    // documents carrying `origin`, so this gate cannot be forged around.
    if (n.type === 'vp.consumer.reactive'
        && !(graph.origin && graph.origin.kind === 'consumer-policy')) {
      push('V-4', n.type + ' ist der generierten Verbraucherregel vorbehalten (origin fehlt)', [n.id]);
    }
    // D-13: explicit claims must equal the catalog-derived ones.
    const expected = claimsByNode[n.id] || [];
    const declared = Array.isArray(n.claims) ? n.claims : [];
    if (canonicalize(normalizeClaims(expected)) !== canonicalize(normalizeClaims(declared))) {
      push('V-5', n.type + ': claims stimmen nicht mit den Katalog-abgeleiteten überein', [n.id]);
    }
  }

  // V-5 exclusive resources within the flow.
  const claimed = {};
  for (const n of nodes) {
    for (const c of claimsByNode[n.id] || []) {
      if (claimed[c.entity_id]) {
        push('V-5', 'Entität ' + c.entity_id + ' wird von zwei Knoten beansprucht',
          [claimed[c.entity_id], n.id]);
      } else {
        claimed[c.entity_id] = n.id;
      }
    }
  }

  // V-5 (MB-M1): two Modbus reads mapping the SAME (entity, channel) in one
  // flow would double-write one measure channel - refused like a claim clash.
  const mappedChannels = {};
  for (const n of nodes) {
    if (n.type !== 'vp.modbus.read') continue;
    const p = n.parameters || {};
    if (!p.entity_id || !p.channel) continue;
    const key = p.entity_id + '#' + p.channel;
    if (mappedChannels[key]) {
      push('V-5', 'Zwei Modbus-Lesen-Bausteine zeichnen denselben Messkanal ' + p.channel
        + ' der Entität ' + p.entity_id + ' auf', [mappedChannels[key], n.id]);
    } else {
      mappedChannels[key] = n.id;
    }
  }

  // V-1/V-3 edges: endpoint + port existence, type compatibility, in-arity.
  const seenEdge = {};
  const inbound = {};
  for (const e of edges) {
    if (seenEdge[e.id]) push('V-3', 'Kanten-ID doppelt: ' + e.id, [], [e.id]);
    seenEdge[e.id] = true;
    const from = byId[e.from && e.from.node];
    const to = byId[e.to && e.to.node];
    if (!from || !to) {
      push('V-3', 'Kante referenziert unbekannten Knoten', [], [e.id]);
      continue;
    }
    const fromType = TYPES[from.type];
    const toType = TYPES[to.type];
    if (!fromType || !toType) continue; // already a V-4 finding
    const outPort = fromType.ports.out[e.from.port];
    const inPort = toType.ports.in[e.to.port];
    if (!outPort) push('V-3', from.type + ' hat keinen Ausgang ' + e.from.port, [from.id], [e.id]);
    if (!inPort) push('V-3', to.type + ' hat keinen Eingang ' + e.to.port, [to.id], [e.id]);
    if (outPort && inPort && !typeCompatible(outPort.type, inPort.type)) {
      push('V-1', 'Porttyp ' + outPort.type + ' passt nicht auf ' + inPort.type, [from.id, to.id], [e.id]);
    }
    const key = e.to.node + '/' + e.to.port;
    if (inbound[key]) {
      push('V-1', 'mehr als eine Kante in den Eingang ' + key, [to.id], [e.id]);
    }
    inbound[key] = e;
  }

  // V-1 required inputs connected + the any-of rule (requires_any_input).
  for (const n of nodes) {
    const type = TYPES[n.type];
    if (!type) continue;
    for (const [port, spec] of Object.entries(type.ports.in)) {
      if (spec.required && !inbound[n.id + '/' + port]) {
        push('V-1', n.type + ': Pflicht-Eingang ' + port + ' ist nicht verbunden', [n.id]);
      }
    }
    const anyOf = type.requiresAnyInput;
    if (anyOf && !anyOf.some((port) => inbound[n.id + '/' + port])) {
      push('V-1', n.type + ': mindestens einer der Eingänge ' + anyOf.join('/')
        + ' muss verbunden sein', [n.id]);
    }
  }

  // V-2 acyclic modulo feedback (Kahn over non-feedback edges).
  const indeg = {};
  const adj = {};
  for (const n of nodes) {
    indeg[n.id] = 0;
    adj[n.id] = [];
  }
  for (const e of edges) {
    if (e.feedback === true) continue;
    if (!byId[e.from && e.from.node] || !byId[e.to && e.to.node]) continue;
    adj[e.from.node].push(e.to.node);
    indeg[e.to.node]++;
  }
  const queue = Object.keys(indeg).filter((id) => indeg[id] === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited++;
    for (const next of adj[id]) {
      if (--indeg[next] === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) {
    push('V-2', 'Zyklus ohne feedback-Markierung', nodes.filter((n) => indeg[n.id] > 0).map((n) => n.id));
  }

  // V-7 triggers.
  if (triggers.length === 0) push('V-7', 'mindestens ein Trigger ist erforderlich');
  const seenTrig = {};
  for (const tr of triggers) {
    if (seenTrig[tr.id]) push('V-3', 'Trigger-ID doppelt: ' + tr.id);
    seenTrig[tr.id] = true;
    switch (tr.kind) {
      case 'interval':
        if (!(Number.isInteger(tr.every_s) && tr.every_s >= 1 && tr.every_s <= 86400)) {
          push('V-7', 'interval-Trigger braucht every_s in 1..86400');
        }
        break;
      case 'value-change': {
        const src = tr.source && byId[tr.source.node];
        const type = src && TYPES[src.type];
        if (!type || !type.ports.out[tr.source.port]) {
          push('V-7', 'value-change-Trigger beobachtet keinen existierenden Ausgang');
        }
        break;
      }
      case 'slot-boundary':
      case 'event':
        break;
      default:
        push('V-7', 'unbekannte Trigger-Art ' + tr.kind);
    }
  }
  return f;
}

function normalizeClaims(claims) {
  return (claims || [])
    .map((c) => ({
      entity_id: c.entity_id,
      commands: (c.commands || []).slice().sort(),
      delegated: c.delegated === true,
    }))
    .sort((a, b) => (a.entity_id < b.entity_id ? -1 : 1));
}

function typeCompatible(from, to) {
  if (from === to) return true;
  // Declared widenings (flow-graph.md §2).
  if (from === 'price' && to === 'timeseries') return true;
  if (from === 'number' && to === 'timeseries') return true;
  // The catalog's number|bool union input (entity control's value port).
  if (to === 'number|bool') return from === 'number' || from === 'bool';
  return false;
}

/** deterministic artifact id derived from (flow_id, flow_version). */
function deriveArtifactId(flowId, flowVersion) {
  const h = crypto.createHash('sha256').update(flowId + '|' + flowVersion, 'utf8').digest('hex');
  // RFC-4122-shaped (version 4 / variant 10 bits stamped) but DERIVED, so a
  // recompile of the same (flow, version) yields the same artifact_id.
  return (
    h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' +
    h.slice(17, 20) + '-' + h.slice(20, 32)
  );
}

/**
 * compile validates and compiles; throws ValidationError on findings.
 * opts: { compiledAt?: RFC3339 string (default a fixed epoch, so compilation
 * is deterministic by default - the cloud passes the activation time) }.
 */
function compile(graph, opts) {
  opts = opts || {};
  const findings = validate(graph);
  if (findings.length > 0) throw new ValidationError(findings);

  const tabId = 'vpflow-' + graph.flow_id.slice(0, 8) + '-v' + graph.flow_version;
  const ctx = {
    tabId,
    coreId: 'cfg-vp-core', // the template's shared vp-core config node
    flowId: graph.flow_id,
    flowVersion: graph.flow_version,
    nrId: (graphNodeId) => tabId + '-' + graphNodeId,
  };

  // value-change triggers write their deadband into the watched read node.
  const extrasByNode = {};
  for (const tr of graph.triggers) {
    if (tr.kind === 'value-change' && tr.source && typeof tr.deadband === 'number') {
      extrasByNode[tr.source.node] = { deadband: tr.deadband };
    }
  }

  // Materialize nodes in DOCUMENT order (deterministic).
  const nrNodes = [];
  const anchors = {}; // graph node id -> NR node id (wiring anchor)
  for (const n of graph.nodes) {
    const compiled = TYPES[n.type].compile(ctx, n, extrasByNode[n.id]);
    anchors[n.id] = compiled[0].id;
    nrNodes.push(...compiled);
  }

  // Wires: single-input nodes, so every edge lands on the anchor's input.
  //
  // EXCEPTION - discriminating nodes (the vp.logic.and/.or combinators): a
  // Node-RED function node has one input, so a generated TAG node per incoming
  // edge stamps msg._vp_src with the GRAPH port name before the message
  // reaches the combinator. Without it two branches that carry no (or the
  // same) msg.topic collapse into one slot and the combinator computes the
  // WRONG boolean. Emitted in graph-edge document order -> deterministic.
  const wires = {};
  const nodeById = {};
  for (const n of graph.nodes) nodeById[n.id] = n;
  for (const e of graph.edges) {
    const from = anchors[e.from.node];
    const toType = TYPES[nodeById[e.to.node].type];
    let target = anchors[e.to.node];
    if (toType.discriminateInputs) {
      // The port name is a CATALOG key (validation proved the port exists), so
      // it is a whitelisted literal - never free user text in generated code.
      const port = Object.keys(toType.ports.in).find((p) => p === e.to.port);
      const tagId = tabId + '-' + e.id + '-in';
      nrNodes.push({
        id: tagId,
        type: 'function',
        z: tabId,
        name: 'Zweig ' + port,
        func: '// generiert von flowc - NICHT von Hand bearbeiten\n'
          + 'const P = ' + JSON.stringify({ port: port }) + ';\n'
          + 'msg._vp_src = P.port;\nreturn msg;',
        outputs: 1,
        noerr: 0,
        initialize: '',
        finalize: '',
        libs: [],
      });
      wires[tagId] = [target];
      target = tagId;
    }
    (wires[from] = wires[from] || []).push(target);
  }

  // Triggers: interval / slot-boundary injects wired into every triggerable
  // data node (re-emit last), in trigger document order.
  let trigIndex = 0;
  const triggerTargets = graph.nodes
    .filter((n) => TYPES[n.type].triggerable)
    .map((n) => anchors[n.id]);
  for (const tr of graph.triggers) {
    trigIndex++;
    if (triggerTargets.length === 0) break;
    if (tr.kind === 'interval') {
      const id = tabId + '-trig' + trigIndex;
      nrNodes.push({
        id,
        type: 'inject',
        z: tabId,
        name: 'alle ' + tr.every_s + ' s',
        props: [],
        repeat: String(tr.every_s),
        crontab: '',
        once: true,
        onceDelay: 1,
        topic: '',
      });
      wires[id] = triggerTargets.slice();
    } else if (tr.kind === 'slot-boundary') {
      const injectId = tabId + '-trig' + trigIndex;
      const gateId = injectId + '-gate';
      nrNodes.push({
        id: injectId,
        type: 'inject',
        z: tabId,
        name: 'Slot-Raster',
        props: [],
        repeat: '30',
        crontab: '',
        once: true,
        onceDelay: 1,
        topic: '',
      });
      nrNodes.push({
        id: gateId,
        type: 'function',
        z: tabId,
        name: 'Slot-Grenze',
        func: [
          '// generiert von flowc - NICHT von Hand bearbeiten',
          '// feuert einmal je 15-Minuten-Slotgrenze (Plattform-Slotraster).',
          'const slot = Math.floor(Date.now() / 900000);',
          'if (context.get("slot") === slot) return null;',
          'context.set("slot", slot);',
          'return msg;',
        ].join('\n'),
        outputs: 1,
        noerr: 0,
        initialize: '',
        finalize: '',
        libs: [],
      });
      wires[injectId] = [gateId];
      wires[gateId] = triggerTargets.slice();
    }
    // value-change: handled via deadband on the read node; event: reserved.
  }

  // Deterministic layout + wires stamped onto the nodes.
  let row = 0;
  for (const n of nrNodes) {
    n.x = 140 + (row % 4) * 220;
    n.y = 80 + Math.floor(row / 4) * 80;
    row++;
    if (outputsOf(n) > 0) n.wires = [wires[n.id] || []];
  }

  const tab = {
    id: tabId,
    type: 'tab',
    label: 'VP Flow: ' + graph.name + ' (v' + graph.flow_version + ')',
    info: OWNERSHIP_MARKER + ' flow_id=' + graph.flow_id + ' flow_version=' + graph.flow_version,
  };

  const bundle = {
    format: 'nodered-tabs',
    tab_ids: [tabId],
    nodered_flows: [tab, ...nrNodes],
  };

  // required_entities: union over the catalog contributions, sorted.
  const required = {};
  for (const n of graph.nodes) {
    for (const req of TYPES[n.type].requires(n.parameters || {})) {
      const bucket = (required[req.entity_id] = required[req.entity_id] || new Set());
      for (const cap of req.capabilities) bucket.add(cap);
    }
  }
  const requiredEntities = Object.keys(required)
    .sort()
    .map((id) => ({ entity_id: id, capabilities: [...required[id]].sort() }));

  let minPalette = '0.2.0';
  for (const n of graph.nodes) minPalette = semverMax(minPalette, TYPES[n.type].minPalette);

  const artifact = {
    schema_version: '1.0',
    kind: 'artifact',
    artifact_id: deriveArtifactId(graph.flow_id, graph.flow_version),
    flow_id: graph.flow_id,
    flow_version: graph.flow_version,
    runtime: 'edge',
    content_hash: contentHash(bundle),
    compiled_at: opts.compiledAt || '1970-01-01T00:00:00Z',
    compiler_version: COMPILER_VERSION,
    min_palette_version: minPalette,
    min_core_version: MIN_CORE_VERSION,
    required_entities: requiredEntities,
    bundle,
  };
  const size = Buffer.byteLength(JSON.stringify(artifact), 'utf8');
  if (size > MAX_ARTIFACT_BYTES) {
    throw new ValidationError([{ rule: 'size', nodes: [], edges: [],
      message: 'Artefakt überschreitet das Größenbudget (' + size + ' Bytes)' }]);
  }
  return artifact;
}

function outputsOf(n) {
  if (typeof n.outputs === 'number') return n.outputs;
  switch (n.type) {
    case 'vp-entity-read':
    case 'vp-feed':
    case 'vp-desired':
    case 'vp-modbus-read':
    case 'inject':
      return 1;
    default:
      return 0;
  }
}

module.exports = { compile, validate, ValidationError, COMPILER_VERSION, OWNERSHIP_MARKER };
