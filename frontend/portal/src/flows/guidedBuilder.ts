/**
 * The guided Wenn/Dann + Zeitplan rule builder (U3, report §4.4 rung 2): a pure
 * projection between a small, form-shaped rule model and a normal FlowDocument
 * built ONLY from catalog node types. It is a PROJECTION of the graph, not a
 * second format - "Profi-Ansicht öffnen" shows exactly this document on the
 * canvas.
 *
 * Round-trip law: `parseGuidedFlow(buildGuidedFlow(rule))` reproduces `rule`
 * (modulo ids); a document richer than the builder subset (extra nodes, a mixed
 * combinator, an unrecognised shape) returns null from parseGuidedFlow so the UI
 * opens it read-only in the Profi-Ansicht instead of silently losing structure.
 *
 * ONE emitter: customerTemplates.ts builds its two shipped templates through
 * buildGuidedFlow, so the builder subset and the templates cannot drift - both
 * are golden round-trip cases (guidedBuilder.test.ts).
 */
import {
  applyDerivedClaims,
  catalogType,
  type EditorEntity,
  type FlowDocument,
  type FlowEdge,
  type FlowNode,
  type PortRef,
} from './model';

// ---------------------------------------------------------------------------
// The rule model (what the form edits)
// ---------------------------------------------------------------------------

export type Direction = 'above' | 'below';
export type ScheduleDays = 'alle' | 'werktage' | 'wochenende';
export type Combinator = 'and' | 'or';

/** A measured channel of an entity crosses a threshold. */
export interface EntityCondition {
  kind: 'entity';
  entityId: string;
  channel: string;
  direction: Direction;
  threshold: number;
  hysteresis?: number;
}

/** The current day-ahead price (ct/kWh) crosses a threshold. */
export interface PriceCondition {
  kind: 'price';
  direction: Direction;
  threshold: number;
  hysteresis?: number;
}

/** A daily time window (local time of the site). */
export interface ScheduleCondition {
  kind: 'schedule';
  from: string;
  to: string;
  days: ScheduleDays;
}

export type GuidedCondition = EntityCondition | PriceCondition | ScheduleCondition;

/** Switch a device on/off. */
export interface OnOffAction {
  kind: 'onoff';
  entityId: string;
  ttlS: number;
}

/** Set a numeric setpoint on a device. */
export interface SetpointAction {
  kind: 'setpoint';
  entityId: string;
  value: number;
  ttlS: number;
}

/** Notify the operators. */
export interface NotifyAction {
  kind: 'notify';
  message: string;
}

export type GuidedAction = OnOffAction | SetpointAction | NotifyAction;

export interface GuidedRule {
  conditions: GuidedCondition[];
  /** How multiple conditions combine (irrelevant with exactly one condition). */
  combinator: Combinator;
  action: GuidedAction;
}

// ---------------------------------------------------------------------------
// Emitter: GuidedRule -> FlowDocument
// ---------------------------------------------------------------------------

const TTL_DEFAULT = 300;

interface Builder {
  nodes: FlowNode[];
  edges: FlowEdge[];
  counters: Record<string, number>;
}

function id(b: Builder, prefix: string): string {
  b.counters[prefix] = (b.counters[prefix] ?? 0) + 1;
  return `${prefix}${b.counters[prefix]}`;
}

function node(b: Builder, typeId: string, parameters: Record<string, unknown>): string {
  const type = catalogType(typeId);
  const nodeId = id(b, prefixOf(typeId));
  b.nodes.push({ id: nodeId, type: typeId, type_version: type?.type_version ?? '1.0.0', parameters });
  return nodeId;
}

function edge(b: Builder, from: PortRef, to: PortRef): void {
  b.edges.push({ id: id(b, 'e'), from, to });
}

function prefixOf(typeId: string): string {
  switch (typeId) {
    case 'vp.entity.read': return 'lesen';
    case 'vp.price.current': return 'preis';
    case 'vp.logic.threshold': return 'schwelle';
    case 'vp.schedule.window': return 'zeit';
    case 'vp.logic.and': return 'und';
    case 'vp.logic.or': return 'oder';
    case 'vp.logic.if': return 'wert';
    case 'vp.logic.gate': return 'wenn';
    case 'vp.entity.control': return 'steuern';
    case 'vp.notify.push': return 'melden';
    default: return 'baustein';
  }
}

/** Emit one condition and return the bool-producing output port. */
function emitCondition(b: Builder, cond: GuidedCondition): PortRef {
  if (cond.kind === 'schedule') {
    const z = node(b, 'vp.schedule.window',
      { from: cond.from, to: cond.to, days: cond.days });
    return { node: z, port: 'active' };
  }
  // entity + price both feed a threshold that yields the bool.
  let source: PortRef;
  if (cond.kind === 'entity') {
    const r = node(b, 'vp.entity.read', { entity_id: cond.entityId, channel: cond.channel });
    source = { node: r, port: 'value' };
  } else {
    const p = node(b, 'vp.price.current', {});
    source = { node: p, port: 'value' };
  }
  const params: Record<string, unknown> = { threshold: cond.threshold, direction: cond.direction };
  if (cond.hysteresis !== undefined) params.hysteresis = cond.hysteresis;
  const t = node(b, 'vp.logic.threshold', params);
  edge(b, source, { node: t, port: 'input' });
  return { node: t, port: 'result' };
}

/** Left-fold the condition bools with and/or nodes; return the combined bool. */
function combine(b: Builder, bools: PortRef[], combinator: Combinator): PortRef {
  let acc = bools[0];
  const combType = combinator === 'and' ? 'vp.logic.and' : 'vp.logic.or';
  for (let i = 1; i < bools.length; i += 1) {
    const c = node(b, combType, {});
    edge(b, acc, { node: c, port: 'a' });
    edge(b, bools[i], { node: c, port: 'b' });
    acc = { node: c, port: 'result' };
  }
  return acc;
}

/**
 * Build the FlowDocument for a rule. Claims are editor-derived; the document
 * validates clean against the client validator the moment it is built.
 */
export function buildGuidedFlow(rule: GuidedRule, name: string, siteId?: string): FlowDocument {
  const b: Builder = { nodes: [], edges: [], counters: {} };
  const bools = rule.conditions.map((c) => emitCondition(b, c));
  const combined = combine(b, bools, rule.combinator);

  const action = rule.action;
  if (action.kind === 'notify') {
    const gate = node(b, 'vp.logic.gate', {});
    edge(b, combined, { node: gate, port: 'wenn' });
    const notify = node(b, 'vp.notify.push', { message: action.message });
    edge(b, { node: gate, port: 'dann' }, { node: notify, port: 'trigger' });
  } else if (action.kind === 'setpoint') {
    const ifNode = node(b, 'vp.logic.if', { then_value: action.value });
    edge(b, combined, { node: ifNode, port: 'condition' });
    const control = node(b, 'vp.entity.control',
      { entity_id: action.entityId, command: 'setpoint_kw', ttl_s: action.ttlS });
    edge(b, { node: ifNode, port: 'value' }, { node: control, port: 'setpoint' });
  } else {
    const control = node(b, 'vp.entity.control',
      { entity_id: action.entityId, command: 'on_off', ttl_s: action.ttlS });
    edge(b, combined, { node: control, port: 'value' });
  }

  const doc: FlowDocument = {
    schema_version: '1.0',
    name,
    runtime: 'edge',
    ...(siteId ? { site_id: siteId } : {}),
    nodes: b.nodes,
    edges: b.edges,
    triggers: [{ id: 't1', kind: 'slot-boundary' }],
  };
  return applyDerivedClaims(doc);
}

// ---------------------------------------------------------------------------
// Parser: FlowDocument -> GuidedRule | null (the round-trip / subset gate)
// ---------------------------------------------------------------------------

interface Ctx {
  byId: Map<string, FlowNode>;
  /** feeder edge INTO (node, port), if exactly one. */
  feeder: (nodeId: string, port: string) => PortRef | null;
  used: Set<string>;
}

function parseLeaf(ctx: Ctx, ref: PortRef): GuidedCondition | null {
  const n = ctx.byId.get(ref.node);
  if (!n) return null;
  if (n.type === 'vp.schedule.window' && ref.port === 'active') {
    ctx.used.add(n.id);
    const p = n.parameters ?? {};
    const days = String(p.days ?? 'alle');
    if (days !== 'alle' && days !== 'werktage' && days !== 'wochenende') return null;
    return { kind: 'schedule', from: String(p.from ?? ''), to: String(p.to ?? ''), days };
  }
  if (n.type === 'vp.logic.threshold' && ref.port === 'result') {
    ctx.used.add(n.id);
    const p = n.parameters ?? {};
    const direction = p.direction === 'below' ? 'below' : 'above';
    const threshold = Number(p.threshold);
    if (!Number.isFinite(threshold)) return null;
    const hyst = p.hysteresis === undefined ? undefined : Number(p.hysteresis);
    const feeder = ctx.feeder(n.id, 'input');
    if (!feeder) return null;
    const src = ctx.byId.get(feeder.node);
    if (!src) return null;
    if (src.type === 'vp.entity.read' && feeder.port === 'value') {
      ctx.used.add(src.id);
      const sp = src.parameters ?? {};
      return {
        kind: 'entity',
        entityId: String(sp.entity_id ?? ''),
        channel: String(sp.channel ?? ''),
        direction,
        threshold,
        ...(hyst !== undefined ? { hysteresis: hyst } : {}),
      };
    }
    if (src.type === 'vp.price.current' && feeder.port === 'value') {
      ctx.used.add(src.id);
      return {
        kind: 'price',
        direction,
        threshold,
        ...(hyst !== undefined ? { hysteresis: hyst } : {}),
      };
    }
    return null;
  }
  return null;
}

/** Decompose a bool output into its leaf conditions + a uniform combinator. */
function parseBool(
  ctx: Ctx,
  ref: PortRef,
): { conditions: GuidedCondition[]; combinator: Combinator | null } | null {
  const n = ctx.byId.get(ref.node);
  if (!n) return null;
  if ((n.type === 'vp.logic.and' || n.type === 'vp.logic.or') && ref.port === 'result') {
    ctx.used.add(n.id);
    const combinator: Combinator = n.type === 'vp.logic.and' ? 'and' : 'or';
    const a = ctx.feeder(n.id, 'a');
    const bRef = ctx.feeder(n.id, 'b');
    if (!a || !bRef) return null;
    const left = parseBool(ctx, a);
    const rightLeaf = parseLeaf(ctx, bRef);
    if (!left || !rightLeaf) return null;
    if (left.combinator !== null && left.combinator !== combinator) return null; // mixed
    return { conditions: [...left.conditions, rightLeaf], combinator };
  }
  const leaf = parseLeaf(ctx, ref);
  if (!leaf) return null;
  return { conditions: [leaf], combinator: null };
}

/**
 * Parse a FlowDocument back into a GuidedRule, or null when it is outside the
 * builder-expressible subset (linear read/price/schedule -> [and/or]* ->
 * onoff/setpoint/notify). null means "open in the Profi-Ansicht read-only".
 */
export function parseGuidedFlow(doc: FlowDocument): GuidedRule | null {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const feeder = (nodeId: string, port: string): PortRef | null => {
    const edges = doc.edges.filter((e) => e.to.node === nodeId && e.to.port === port);
    return edges.length === 1 ? edges[0].from : null;
  };
  const ctx: Ctx = { byId, feeder, used: new Set() };

  // The action is the single sink: an entity.control or a notify.push.
  const controls = doc.nodes.filter((n) => n.type === 'vp.entity.control');
  const notifies = doc.nodes.filter((n) => n.type === 'vp.notify.push');
  if (controls.length + notifies.length !== 1) return null;

  let action: GuidedAction;
  let boolRef: PortRef | null;
  if (controls.length === 1) {
    const control = controls[0];
    ctx.used.add(control.id);
    const p = control.parameters ?? {};
    const entityId = String(p.entity_id ?? '');
    const ttlS = Number(p.ttl_s ?? TTL_DEFAULT);
    if (p.command === 'on_off') {
      boolRef = feeder(control.id, 'value');
      action = { kind: 'onoff', entityId, ttlS };
    } else if (p.command === 'setpoint_kw') {
      const ifRef = feeder(control.id, 'setpoint');
      if (!ifRef) return null;
      const ifNode = byId.get(ifRef.node);
      if (!ifNode || ifNode.type !== 'vp.logic.if' || ifRef.port !== 'value') return null;
      ctx.used.add(ifNode.id);
      const value = Number(ifNode.parameters?.then_value);
      if (!Number.isFinite(value)) return null;
      boolRef = feeder(ifNode.id, 'condition');
      action = { kind: 'setpoint', entityId, value, ttlS };
    } else {
      return null; // limit_kw/limit_pct/mode are not builder-expressible
    }
  } else {
    const notify = notifies[0];
    ctx.used.add(notify.id);
    const gateRef = feeder(notify.id, 'trigger');
    if (!gateRef) return null;
    const gate = byId.get(gateRef.node);
    if (!gate || gate.type !== 'vp.logic.gate' || gateRef.port !== 'dann') return null;
    ctx.used.add(gate.id);
    boolRef = feeder(gate.id, 'wenn');
    action = { kind: 'notify', message: String(notify.parameters?.message ?? '') };
  }

  if (!boolRef) return null;
  const decomposed = parseBool(ctx, boolRef);
  if (!decomposed) return null;

  // Every node must be accounted for - a stray node means a richer graph the
  // builder cannot represent (open it in the Profi-Ansicht instead).
  if (ctx.used.size !== doc.nodes.length) return null;

  return {
    conditions: decomposed.conditions,
    combinator: decomposed.combinator ?? 'and',
    action,
  };
}

/** True when the document is exactly a builder-expressible rule. */
export function isGuidedFlow(doc: FlowDocument): boolean {
  return parseGuidedFlow(doc) !== null;
}

// ---------------------------------------------------------------------------
// UI helpers for the form
// ---------------------------------------------------------------------------

/** The site's controllable on/off consumers (Wallbox / Heizstab / gen. Last). */
export function actionTargets(entities: EditorEntity[]): EditorEntity[] {
  return entities.filter(
    (e) => e.entityType !== 'battery-hybrid' && e.actuate.includes('on_off'),
  );
}

/** Entities that expose a measured channel a condition can read. */
export function readableEntities(entities: EditorEntity[]): EditorEntity[] {
  return entities.filter((e) => e.measure.length > 0);
}
