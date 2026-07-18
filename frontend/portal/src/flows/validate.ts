/**
 * Client-side flow validation - the TS twin of the api's FlowGraphValidator
 * (contract flow-graph.md §4, rules V-1..V-8 + the structural "schema" checks).
 * Runs LIVE in the editor on every edit; the server re-validates on save,
 * simulate and activation (the authoritative gate). Shared broken-flow
 * vectors in validate.test.ts mirror FlowGraphValidatorTest so the two
 * implementations cannot drift.
 */
import {
  catalogPort,
  catalogType,
  compatible,
  deriveClaims,
  supportsVersion,
  type EditorEntity,
  type FlowDocument,
  type FlowNode,
  type PortRef,
} from './model';

export interface FlowFinding {
  rule: string;
  severity: 'error' | 'warning';
  nodeIds: string[];
  edgeIds: string[];
  message: string;
}

export interface ForeignClaim {
  entityId: string;
  flowId: string;
  flowName: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PORT_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const TRIGGER_KINDS = new Set(['interval', 'value-change', 'slot-boundary', 'event']);

function error(rule: string, nodeIds: string[], edgeIds: string[], message: string): FlowFinding {
  return { rule, severity: 'error', nodeIds, edgeIds, message };
}

function typeLabel(portType: string): string {
  switch (portType) {
    case 'price':
      return 'Preisreihe';
    case 'timeseries':
      return 'Zeitreihe';
    case 'number':
      return 'Zahl';
    case 'bool':
      return 'Bedingung';
    case 'event':
      return 'Ereignis';
    case 'plan':
      return 'Wunsch/Plan';
    case 'entityRef':
      return 'Entitäts-Referenz';
    default:
      return portType;
  }
}

/** True when no finding blocks activation. */
export function isValid(findings: FlowFinding[]): boolean {
  return findings.every((f) => f.severity !== 'error');
}

/**
 * Validate one document against the catalog, the site's entity capabilities
 * and the claims of the site's OTHER active flows (client-side callers pass
 * [] - the server owns the cross-flow check at save/activation).
 */
export function validateFlow(
  doc: FlowDocument,
  entities: EditorEntity[],
  foreignClaims: ForeignClaim[] = [],
): FlowFinding[] {
  const findings: FlowFinding[] = [];
  checkShape(doc, findings);
  const nodesById = checkNodes(doc, findings);
  checkEdges(doc, findings, nodesById);
  checkRequiredInputs(doc, findings, nodesById);
  checkCycles(doc, findings, nodesById);
  checkTriggers(doc, findings, nodesById);
  checkClaims(doc, findings, entities, foreignClaims);
  checkEntityReads(doc, findings, entities);
  return findings;
}

function checkShape(doc: FlowDocument, findings: FlowFinding[]) {
  if (doc.schema_version !== '1.0') {
    findings.push(error('schema', [], [], 'schema_version muss "1.0" sein.'));
  }
  if (doc.runtime !== 'edge' && doc.runtime !== 'cloud') {
    findings.push(error('schema', [], [], 'runtime muss "edge" oder "cloud" sein.'));
  }
  if (doc.runtime === 'edge' && !doc.site_id) {
    findings.push(error('schema', [], [], 'Ein Edge-Flow braucht eine site_id.'));
  }
  if (!doc.name || !doc.name.trim()) {
    findings.push(error('schema', [], [], 'Der Flow braucht einen Namen.'));
  }
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    findings.push(error('schema', [], [],
      'Der Flow braucht mindestens einen Baustein.'));
  }
}

function checkNodes(doc: FlowDocument, findings: FlowFinding[]): Map<string, FlowNode> {
  const nodesById = new Map<string, FlowNode>();
  for (const node of doc.nodes) {
    if (!ID_PATTERN.test(node.id ?? '')) {
      findings.push(error('V-3', [node.id ?? ''], [],
        `Ungültige Baustein-ID "${node.id}".`));
      continue;
    }
    if (nodesById.has(node.id)) {
      findings.push(error('V-3', [node.id], [],
        `Baustein-ID "${node.id}" ist doppelt vergeben.`));
      continue;
    }
    nodesById.set(node.id, node);
    const type = catalogType(node.type);
    if (!type) {
      findings.push(error('V-4', [node.id], [],
        `Unbekannter Baustein-Typ "${node.type}".`));
      continue;
    }
    if (!supportsVersion(node.type, node.type_version)) {
      findings.push(error('V-4', [node.id], [],
        `Baustein "${type.label}": Version ${node.type_version} wird vom Katalog `
        + `(${type.type_version}) nicht unterstützt.`));
    }
    if (!type.runtimes.includes(doc.runtime)) {
      findings.push(error('V-8', [node.id], [],
        `Baustein "${type.label}" ist in der Laufzeit "${doc.runtime}" nicht verfügbar.`));
    }
    checkParameters(node, findings);
  }
  return nodesById;
}

function checkParameters(node: FlowNode, findings: FlowFinding[]) {
  const type = catalogType(node.type);
  if (!type) return;
  const params = node.parameters ?? {};
  for (const spec of type.parameters) {
    const value = params[spec.name];
    const label = spec.label ?? spec.name;
    if (value === undefined || value === null || value === '') {
      if (spec.required) {
        findings.push(error('V-4', [node.id], [],
          `Baustein "${type.label}": Parameter "${label}" fehlt.`));
      }
      continue;
    }
    switch (spec.kind) {
      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          findings.push(error('V-4', [node.id], [],
            `Baustein "${type.label}": Parameter "${label}" muss eine Zahl sein.`));
        } else {
          if (spec.min !== undefined && value < spec.min) {
            findings.push(error('V-4', [node.id], [],
              `Baustein "${type.label}": Parameter "${label}" muss mindestens ${spec.min} sein.`));
          }
          if (spec.max !== undefined && value > spec.max) {
            findings.push(error('V-4', [node.id], [],
              `Baustein "${type.label}": Parameter "${label}" darf höchstens ${spec.max} sein.`));
          }
        }
        break;
      }
      case 'enum': {
        if (!spec.options?.includes(String(value))) {
          findings.push(error('V-4', [node.id], [],
            `Baustein "${type.label}": Parameter "${label}" hat einen unbekannten Wert "${value}".`));
        }
        break;
      }
      case 'time': {
        if (!TIME_PATTERN.test(String(value))) {
          findings.push(error('V-4', [node.id], [],
            `Baustein "${type.label}": Parameter "${label}" muss eine Uhrzeit im Format HH:MM sein.`));
        }
        break;
      }
      default: {
        if (typeof value !== 'string') {
          findings.push(error('V-4', [node.id], [],
            `Baustein "${type.label}": Parameter "${label}" muss ein Text sein.`));
        }
      }
    }
  }
}

function resolvePort(
  ref: PortRef,
  direction: 'inputs' | 'outputs',
  nodesById: Map<string, FlowNode>,
  findings: FlowFinding[],
  edgeId: string,
) {
  const node = nodesById.get(ref.node);
  if (!node) {
    findings.push(error('V-3', [ref.node], [edgeId],
      `Verbindung verweist auf einen unbekannten Baustein "${ref.node}".`));
    return null;
  }
  if (!PORT_PATTERN.test(ref.port ?? '')) {
    findings.push(error('V-3', [ref.node], [edgeId], `Ungültiger Port-Name "${ref.port}".`));
    return null;
  }
  const type = catalogType(node.type);
  if (!type) return null; // V-4 already reported
  const port = catalogPort(node.type, direction, ref.port);
  if (!port) {
    findings.push(error('V-3', [ref.node], [edgeId],
      `Baustein "${type.label}" hat keinen ${direction === 'outputs' ? 'Ausgang' : 'Eingang'} `
      + `"${ref.port}".`));
    return null;
  }
  return port;
}

function checkEdges(
  doc: FlowDocument,
  findings: FlowFinding[],
  nodesById: Map<string, FlowNode>,
) {
  const edgeIds = new Set<string>();
  const inputTaken = new Map<string, string>();
  for (const edge of doc.edges) {
    if (!ID_PATTERN.test(edge.id ?? '') || edgeIds.has(edge.id)) {
      findings.push(error('V-3', [], [edge.id ?? ''],
        `Verbindungs-ID "${edge.id}" fehlt oder ist doppelt.`));
      continue;
    }
    edgeIds.add(edge.id);
    const fromPort = resolvePort(edge.from, 'outputs', nodesById, findings, edge.id);
    const toPort = resolvePort(edge.to, 'inputs', nodesById, findings, edge.id);
    if (!fromPort || !toPort) continue;
    if (!compatible(fromPort.type, toPort.type)) {
      findings.push(error('V-1', [edge.from.node, edge.to.node], [edge.id],
        `Verbindung nicht möglich: ${typeLabel(fromPort.type)} passt nicht auf `
        + `${typeLabel(toPort.type)}.`));
    }
    const inputKey = `${edge.to.node}#${edge.to.port}`;
    const previous = inputTaken.get(inputKey);
    if (previous) {
      findings.push(error('V-1', [edge.to.node], [previous, edge.id],
        'In einen Eingang darf nur EINE Verbindung führen.'));
    } else {
      inputTaken.set(inputKey, edge.id);
    }
  }
}

function checkRequiredInputs(
  doc: FlowDocument,
  findings: FlowFinding[],
  nodesById: Map<string, FlowNode>,
) {
  const connected = new Set(doc.edges.map((e) => `${e.to.node}#${e.to.port}`));
  for (const [nodeId, node] of nodesById) {
    const type = catalogType(node.type);
    if (!type) continue;
    for (const input of type.inputs) {
      if (input.required && !connected.has(`${nodeId}#${input.name}`)) {
        findings.push(error('V-1', [nodeId], [],
          `Baustein "${type.label}": Eingang "${input.label ?? input.name}" muss `
          + 'verbunden sein.'));
      }
    }
    if (type.requires_any_input
        && !type.requires_any_input.some((name) => connected.has(`${nodeId}#${name}`))) {
      findings.push(error('V-1', [nodeId], [],
        `Baustein "${type.label}" braucht mindestens einen verbundenen Eingang.`));
    }
  }
}

function checkCycles(
  doc: FlowDocument,
  findings: FlowFinding[],
  nodesById: Map<string, FlowNode>,
) {
  const adjacency = new Map<string, string[]>();
  for (const edge of doc.edges) {
    if (edge.feedback) continue;
    if (!nodesById.has(edge.from.node) || !nodesById.has(edge.to.node)) continue;
    const next = adjacency.get(edge.from.node) ?? [];
    next.push(edge.to.node);
    adjacency.set(edge.from.node, next);
  }
  const done = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function findCycle(node: string): string[] | null {
    if (inStack.has(node)) {
      const start = path.indexOf(node);
      return [...path.slice(start), node];
    }
    if (done.has(node)) return null;
    done.add(node);
    inStack.add(node);
    path.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = findCycle(next);
      if (cycle) return cycle;
    }
    inStack.delete(node);
    path.pop();
    return null;
  }

  for (const nodeId of nodesById.keys()) {
    const cycle = findCycle(nodeId);
    if (cycle) {
      findings.push(error('V-2', cycle, [],
        `Der Flow enthält einen Kreis (${cycle.join(' → ')}). Beabsichtigte `
        + 'Rückkopplungen brauchen eine Feedback-Verbindung.'));
      return;
    }
  }
}

function checkTriggers(
  doc: FlowDocument,
  findings: FlowFinding[],
  nodesById: Map<string, FlowNode>,
) {
  if (!Array.isArray(doc.triggers) || doc.triggers.length === 0) {
    findings.push(error('V-7', [], [], 'Der Flow braucht mindestens einen Auslöser.'));
    return;
  }
  const triggerIds = new Set<string>();
  for (const trigger of doc.triggers) {
    if (!ID_PATTERN.test(trigger.id ?? '') || triggerIds.has(trigger.id)) {
      findings.push(error('V-3', [], [],
        `Auslöser-ID "${trigger.id}" fehlt oder ist doppelt.`));
    }
    triggerIds.add(trigger.id);
    if (!TRIGGER_KINDS.has(trigger.kind)) {
      findings.push(error('V-7', [], [], `Unbekannte Auslöser-Art "${trigger.kind}".`));
      continue;
    }
    if (trigger.kind === 'interval') {
      const everyS = trigger.every_s ?? 0;
      if (everyS < 1 || everyS > 86400) {
        findings.push(error('V-7', [], [],
          'Intervall-Auslöser: every_s muss zwischen 1 und 86400 liegen.'));
      }
    }
    if (trigger.kind === 'value-change') {
      const source = trigger.source;
      const node = source ? nodesById.get(source.node) : undefined;
      const port = node && source ? catalogPort(node.type, 'outputs', source.port) : null;
      if (!port) {
        findings.push(error('V-7', source?.node ? [source.node] : [], [],
          'Wertänderungs-Auslöser: die beobachtete Quelle muss ein vorhandener '
          + 'Ausgang sein.'));
      }
      if (trigger.deadband !== undefined && trigger.deadband < 0) {
        findings.push(error('V-7', [], [],
          'Wertänderungs-Auslöser: deadband darf nicht negativ sein.'));
      }
    }
    if (trigger.kind === 'event' && !trigger.event) {
      findings.push(error('V-7', [], [], 'Ereignis-Auslöser: der Ereignisname fehlt.'));
    }
  }
}

function claimKey(nodeId: string, entityId: string, commands: string[], delegated: boolean) {
  return `${nodeId}|${entityId}|${[...commands].sort().join(',')}|${delegated}`;
}

function checkClaims(
  doc: FlowDocument,
  findings: FlowFinding[],
  entities: EditorEntity[],
  foreignClaims: ForeignClaim[],
) {
  const derived = deriveClaims(doc);

  const stored = new Set<string>();
  for (const node of doc.nodes) {
    for (const claim of node.claims ?? []) {
      stored.add(claimKey(node.id, claim.entity_id, claim.commands ?? [],
        claim.delegated === true));
    }
  }
  const expected = new Set(derived.map((c) =>
    claimKey(c.nodeId, c.entityId, c.commands, c.delegated)));
  const same = stored.size === expected.size && [...stored].every((k) => expected.has(k));
  if (!same) {
    findings.push(error('V-5', [], [],
      'Die hinterlegten Claims stimmen nicht mit den Bausteinen überein - bitte den '
      + 'Flow im Editor neu speichern.'));
  }

  const byEntity = new Map<string, string>();
  for (const claim of derived) {
    const previous = byEntity.get(claim.entityId);
    if (previous && previous !== claim.nodeId) {
      findings.push(error('V-5', [previous, claim.nodeId], [],
        `Zwei Bausteine steuern dieselbe Entität "${claim.entityId}" - pro Entität `
        + 'darf nur EIN Baustein steuern.'));
    } else {
      byEntity.set(claim.entityId, claim.nodeId);
    }
  }

  for (const claim of derived) {
    for (const foreign of foreignClaims) {
      if (foreign.entityId === claim.entityId) {
        findings.push(error('V-5', [claim.nodeId], [],
          `Die Entität "${claim.entityId}" wird bereits vom aktiven Flow `
          + `"${foreign.flowName}" gesteuert.`));
      }
    }
  }

  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const claim of derived) {
    const entity = byId.get(claim.entityId);
    if (!entity) {
      findings.push(error('V-6', [claim.nodeId], [],
        entities.length === 0
          ? 'Diese Anlage hat noch keine v2-Entitäten - bitte zuerst das '
            + 'Entitäten-Bootstrap ausführen (Plattform → Anlage).'
          : `Unbekannte Entität "${claim.entityId}".`));
      continue;
    }
    for (const command of claim.commands) {
      if (!entity.actuate.includes(command)) {
        findings.push(error('V-6', [claim.nodeId], [],
          `Die Entität "${claim.entityId}" unterstützt das Kommando "${command}" nicht.`));
      }
    }
  }
}

function checkEntityReads(
  doc: FlowDocument,
  findings: FlowFinding[],
  entities: EditorEntity[],
) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const node of doc.nodes) {
    if (node.type !== 'vp.entity.read') continue;
    const entityId = String(node.parameters?.entity_id ?? '');
    const channel = String(node.parameters?.channel ?? '');
    if (!entityId || !channel) continue; // V-4 reports the missing parameter
    const entity = byId.get(entityId);
    if (!entity) {
      findings.push(error('V-6', [node.id], [],
        entities.length === 0
          ? 'Diese Anlage hat noch keine v2-Entitäten - bitte zuerst das '
            + 'Entitäten-Bootstrap ausführen (Plattform → Anlage).'
          : `Unbekannte Entität "${entityId}".`));
    } else if (!entity.measure.includes(channel)) {
      findings.push(error('V-6', [node.id], [],
        `Die Entität "${entityId}" misst den Kanal "${channel}" nicht.`));
    }
  }
}
