/**
 * Flow-editor domain model (E3a): the flow-graph contract document types
 * (docs/contracts/v2/flow-graph.md + .schema.json), the node catalog types,
 * pure edit operations (add/remove node/edge, set parameter) and the D-13
 * claim derivation - the TS twin of the api's FlowClaims (shared vectors pin
 * both, the EdgeRef precedent). Components only render; every rule lives
 * here or in validate.ts.
 *
 * The catalog itself is the SYNCED COPY src/flows/catalog.json of the api's
 * flowcatalog/catalog.json (single source served at /api/v1/admin/flow-catalog);
 * catalog.sync.test.ts guards the two against drift.
 */
import rawCatalog from './catalog.json';

// ---------------------------------------------------------------------------
// Contract document types
// ---------------------------------------------------------------------------

export interface PortRef {
  node: string;
  port: string;
}

export interface FlowEdge {
  id: string;
  from: PortRef;
  to: PortRef;
  feedback?: boolean;
}

export interface FlowClaim {
  entity_id: string;
  commands: string[];
  delegated?: boolean;
}

export interface FlowNode {
  id: string;
  type: string;
  type_version: string;
  label?: string;
  parameters?: Record<string, unknown>;
  claims?: FlowClaim[];
}

export type TriggerKind = 'interval' | 'value-change' | 'slot-boundary' | 'event';

export interface FlowTrigger {
  id: string;
  kind: TriggerKind;
  every_s?: number;
  source?: PortRef;
  deadband?: number;
  event?: string;
}

export interface FlowDocument {
  schema_version: '1.0';
  flow_id?: string;
  flow_version?: number;
  name: string;
  description?: string;
  runtime: 'edge' | 'cloud';
  site_id?: string;
  tenant_id?: string;
  lifecycle?: string;
  /**
   * D-19: provenance marker of a GENERATED flow (today: derived from a
   * consumer policy). SERVER-STAMPED ONLY - the flow save API refuses
   * customer documents carrying it; the portal opens the owning
   * Regelbaukasten instead of the free editor.
   */
  origin?: FlowOrigin;
  nodes: FlowNode[];
  edges: FlowEdge[];
  triggers: FlowTrigger[];
}

export interface FlowOrigin {
  kind: 'consumer-policy';
  policy_id: string;
  policy_version: number;
  entity_id: string;
}

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

export type PortType =
  | 'number'
  | 'bool'
  | 'timeseries'
  | 'price'
  | 'plan'
  | 'event'
  | 'entityRef';

export interface CatalogPort {
  name: string;
  type: PortType;
  label?: string;
  unit?: string;
  required?: boolean;
}

export interface CatalogParam {
  name: string;
  kind: string;
  label?: string;
  required?: boolean;
  options?: string[];
  optionLabels?: Record<string, string>;
  default?: unknown;
  min?: number;
  max?: number;
  help?: string;
  entityTypes?: string[];
  /** Max source length of a `code` param (the sandboxed code node, D-16). */
  maxLength?: number;
}

export interface CatalogClaimTemplate {
  entity_parameter: string;
  commands?: string[];
  command_parameter?: string;
  delegated?: boolean;
}

export type CatalogGroup = 'strategie' | 'daten' | 'logik' | 'aktion';

export interface CatalogType {
  type: string;
  type_version: string;
  label: string;
  description?: string;
  group: CatalogGroup;
  // AE7 node governance (docs/contracts/v2/usage-profile.md §3): true = a
  // market-/grid-near strategy node that needs VoltPilot enablement per site
  // (Arbitrage/Peak/atyp. NN). Absent/false = freely usable.
  gated?: boolean;
  /**
   * Audit N-1: false = the CUSTOMER surfaces must not offer this node because
   * the platform cannot keep its promise end to end yet (the notification has
   * no delivery channel; the Wenn/Dann gate's only sink is that node). The type
   * stays in the catalog - existing flows keep validating and running, and the
   * technical (platform-admin) layer keeps it for diagnosis. Absent = visible.
   */
  customer_visible?: boolean;
  /**
   * D-19: true = the type exists ONLY in platform-GENERATED documents (the
   * consumer-policy compiler); no palette ever offers it, and the validator
   * refuses it in a document without the consumer-policy origin.
   */
  generated?: boolean;
  runtimes: string[];
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  parameters: CatalogParam[];
  requires_any_input?: string[];
  claim_template?: CatalogClaimTemplate;
  hint?: string;
}

export interface NodeCatalog {
  catalog_version: string;
  types: CatalogType[];
}

export const catalog: NodeCatalog = rawCatalog as unknown as NodeCatalog;

const TYPES_BY_ID = new Map(catalog.types.map((t) => [t.type, t]));

export function catalogType(typeId: string): CatalogType | null {
  return TYPES_BY_ID.get(typeId) ?? null;
}

/**
 * Audit N-1: may a CUSTOMER surface offer this node type? Absent flag = yes
 * (the default for every node); an explicit `customer_visible:false` marks a
 * node whose promise the platform cannot keep yet, so it is offered only in
 * the technical layer. Never a gate - it hides an OFFER, and an existing flow
 * that already carries the node keeps validating, compiling and running.
 */
export function customerVisible(type: Pick<CatalogType, 'customer_visible'>): boolean {
  return type.customer_visible !== false;
}

/** The node types the customer palette/builder must not offer (N-1). */
export function diagnosticOnlyTypes(): string[] {
  return catalog.types.filter((t) => !customerVisible(t)).map((t) => t.type);
}

export function catalogPort(
  typeId: string,
  direction: 'inputs' | 'outputs',
  portName: string,
): CatalogPort | null {
  const type = catalogType(typeId);
  return type?.[direction].find((p) => p.name === portName) ?? null;
}

/**
 * Port type compatibility per contract §2: equal, plus the two declared
 * widenings price→timeseries and number→timeseries. Nothing else.
 */
export function compatible(from: PortType, to: PortType): boolean {
  return (
    from === to ||
    (from === 'price' && to === 'timeseries') ||
    (from === 'number' && to === 'timeseries')
  );
}

/** Same-major, catalog >= requested (semver) - the V-4 version rule. */
export function supportsVersion(typeId: string, requested: string): boolean {
  const type = catalogType(typeId);
  if (!type) return false;
  const have = parseSemver(type.type_version);
  const want = parseSemver(requested);
  if (!have || !want || have[0] !== want[0]) return false;
  if (have[1] !== want[1]) return have[1] > want[1];
  return have[2] >= want[2];
}

export function parseSemver(version: string): [number, number, number] | null {
  const parts = version.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0], nums[1], nums[2]];
}

// ---------------------------------------------------------------------------
// The site's entity view (from GET /api/v1/admin/sites/{id}/v2-entities)
// ---------------------------------------------------------------------------

/** One registry entity as the editor needs it (capability sets + labels). */
export interface EditorEntity {
  id: string;
  entityType: string;
  label: string;
  measure: string[];
  actuate: string[];
}

export function entityLabel(entities: EditorEntity[], entityId: string): string {
  return entities.find((e) => e.id === entityId)?.label ?? entityId;
}

// ---------------------------------------------------------------------------
// Claim derivation (D-13) - the TS twin of the api's FlowClaims
// ---------------------------------------------------------------------------

export interface DerivedClaim {
  nodeId: string;
  entityId: string;
  commands: string[];
  delegated: boolean;
}

function templateClaim(node: FlowNode): DerivedClaim | null {
  const type = catalogType(node.type);
  const template = type?.claim_template;
  if (!template) return null;
  const entityId = String(node.parameters?.[template.entity_parameter] ?? '');
  if (!entityId) return null;
  let commands: string[] = [];
  if (template.commands) {
    commands = [...template.commands];
  } else if (template.command_parameter) {
    const command = String(node.parameters?.[template.command_parameter] ?? '');
    if (!command) return null;
    commands = [command];
  }
  if (commands.length === 0) return null;
  return { nodeId: node.id, entityId, commands, delegated: template.delegated === true };
}

/**
 * Derive the claim set of a document. ONE structural rule beyond the catalog
 * templates: an entity-control node whose `plan` input is fed by a DELEGATED
 * strategy claiming the SAME entity derives NO own claim (the strategy's
 * delegated claim covers the entity - the pilot chain would otherwise
 * conflict with itself under V-5).
 */
export function deriveClaims(doc: FlowDocument): DerivedClaim[] {
  const claims: DerivedClaim[] = [];
  const delegatedByEntity = new Set<string>();
  for (const node of doc.nodes) {
    const claim = templateClaim(node);
    if (claim?.delegated) {
      claims.push(claim);
      delegatedByEntity.add(claim.entityId);
    }
  }
  for (const node of doc.nodes) {
    const claim = templateClaim(node);
    if (!claim || claim.delegated) continue;
    if (planFedByDelegated(doc, node, claim.entityId, delegatedByEntity)) continue;
    claims.push(claim);
  }
  return claims;
}

function planFedByDelegated(
  doc: FlowDocument,
  node: FlowNode,
  entityId: string,
  delegatedByEntity: Set<string>,
): boolean {
  if (!delegatedByEntity.has(entityId)) return false;
  for (const edge of doc.edges) {
    if (edge.to.node !== node.id || edge.to.port !== 'plan') continue;
    const feeder = doc.nodes.find((n) => n.id === edge.from.node);
    if (!feeder) continue;
    const feederClaim = templateClaim(feeder);
    if (feederClaim?.delegated && feederClaim.entityId === entityId) return true;
  }
  return false;
}

/** Stamp the derived claims onto the document (what the editor stores). */
export function applyDerivedClaims(doc: FlowDocument): FlowDocument {
  const derived = deriveClaims(doc);
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      const own = derived.filter((c) => c.nodeId === node.id);
      const { claims: _drop, ...rest } = node;
      if (own.length === 0) return rest;
      return {
        ...rest,
        claims: own.map((c) => ({
          entity_id: c.entityId,
          commands: c.commands,
          ...(c.delegated ? { delegated: true } : {}),
        })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Pure edit operations (every editor mutation goes through these)
// ---------------------------------------------------------------------------

function freshId(prefix: string, taken: Set<string>): string {
  for (let i = 1; ; i += 1) {
    const candidate = `${prefix}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const ID_PREFIX: Record<string, string> = {
  'vp.price.dayahead': 'preis',
  'vp.price.current': 'preisjetzt',
  'vp.forecast.pv': 'prognose',
  'vp.entity.read': 'lesen',
  'vp.logic.threshold': 'schwelle',
  'vp.schedule.window': 'zeitplan',
  'vp.logic.gate': 'wenn',
  'vp.logic.if': 'wert',
  'vp.logic.and': 'und',
  'vp.logic.or': 'oder',
  'vp.logic.function': 'code',
  'vp.modbus.read': 'modbus',
  'vp.strategy.market': 'markt',
  'vp.entity.control': 'steuern',
  'vp.notify.push': 'melden',
};

/** Add a node of a catalog type with parameter defaults. */
export function addNode(doc: FlowDocument, typeId: string): FlowDocument {
  const type = catalogType(typeId);
  if (!type) return doc;
  const taken = new Set(doc.nodes.map((n) => n.id));
  const parameters: Record<string, unknown> = {};
  for (const param of type.parameters) {
    if (param.default !== undefined) parameters[param.name] = param.default;
  }
  const node: FlowNode = {
    id: freshId(ID_PREFIX[typeId] ?? 'baustein', taken),
    type: type.type,
    type_version: type.type_version,
    parameters,
  };
  return applyDerivedClaims({ ...doc, nodes: [...doc.nodes, node] });
}

/** Remove a node plus every edge/trigger referencing it. */
export function removeNode(doc: FlowDocument, nodeId: string): FlowDocument {
  return applyDerivedClaims({
    ...doc,
    nodes: doc.nodes.filter((n) => n.id !== nodeId),
    edges: doc.edges.filter((e) => e.from.node !== nodeId && e.to.node !== nodeId),
    triggers: doc.triggers.filter((t) => t.source?.node !== nodeId),
  });
}

/**
 * Connect an output to an input. Replaces an existing edge into the same
 * input (one edge per input, V-1) - the editor never produces that error.
 */
export function addEdge(doc: FlowDocument, from: PortRef, to: PortRef): FlowDocument {
  const taken = new Set(doc.edges.map((e) => e.id));
  const kept = doc.edges.filter(
    (e) => !(e.to.node === to.node && e.to.port === to.port),
  );
  const edge: FlowEdge = { id: freshId('v', taken), from, to };
  return applyDerivedClaims({ ...doc, edges: [...kept, edge] });
}

export function removeEdge(doc: FlowDocument, edgeId: string): FlowDocument {
  return applyDerivedClaims({
    ...doc,
    edges: doc.edges.filter((e) => e.id !== edgeId),
  });
}

/** Set one parameter (empty string clears it). Claims re-derive. */
export function setParam(
  doc: FlowDocument,
  nodeId: string,
  name: string,
  value: unknown,
): FlowDocument {
  return applyDerivedClaims({
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      const parameters = { ...(node.parameters ?? {}) };
      if (value === '' || value === undefined || value === null) {
        delete parameters[name];
      } else {
        parameters[name] = value;
      }
      return { ...node, parameters };
    }),
  });
}

// ---------------------------------------------------------------------------
// Display derivation
// ---------------------------------------------------------------------------

/** One short German sub-line for the canvas node (key parameters). */
export function nodeSubtitle(node: FlowNode, entities: EditorEntity[]): string {
  const type = catalogType(node.type);
  if (!type) return node.type;
  const params = node.parameters ?? {};
  const parts: string[] = [];
  for (const param of type.parameters) {
    const value = params[param.name];
    if (value === undefined || value === '') continue;
    if (param.kind === 'entityRef') {
      parts.push(entityLabel(entities, String(value)));
    } else if (param.kind === 'enum') {
      parts.push(param.optionLabels?.[String(value)] ?? String(value));
    } else if (param.name === 'channel') {
      parts.push(String(value));
    } else if (param.kind === 'number') {
      parts.push(`${param.label ?? param.name}: ${value}`);
    } else if (param.kind === 'time') {
      parts.push(String(value));
    }
  }
  return parts.slice(0, 2).join(' · ');
}

/** The lifecycle rail state (Entwurf → Simuliert → Aktiv). */
export function lifecycleSteps(lifecycle: string): Array<{
  label: string;
  state: 'done' | 'live' | 'open';
}> {
  const order = ['draft', 'simulated', 'active'];
  const labels = ['Entwurf', 'Simuliert', 'Aktiv'];
  const index = order.indexOf(lifecycle);
  return labels.map((label, i) => ({
    label,
    state: i < index ? 'done' : i === index ? 'live' : 'open',
  }));
}

export function lifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case 'draft':
      return 'Entwurf';
    case 'simulated':
      return 'Simuliert';
    case 'active':
      return 'Aktiv';
    case 'retired':
      return 'Stillgelegt';
    default:
      return lifecycle;
  }
}
