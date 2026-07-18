/**
 * Flow templates + list-card derivations (pure). The pilot template is the
 * acceptance chain (Preis + PV-Prognose + Speicher lesen → Marktoptimierung →
 * Speicher steuern) and is kept in LOCKSTEP with the api's
 * FlowGraphValidatorTest.pilotFlow / FlowApiTest.pilotDocument vectors.
 */
import {
  applyDerivedClaims,
  catalogType,
  type EditorEntity,
  type FlowDocument,
} from './model';

/** An empty flow skeleton (the server stamps identity on create). */
export function emptyFlow(name: string, siteId?: string): FlowDocument {
  return {
    schema_version: '1.0',
    name,
    runtime: 'edge',
    ...(siteId ? { site_id: siteId } : {}),
    nodes: [],
    edges: [],
    triggers: [{ id: 't1', kind: 'slot-boundary' }],
  };
}

/** The site's battery-hybrid entity (the pilot template's claim target). */
export function batteryEntity(entities: EditorEntity[]): EditorEntity | null {
  return entities.find((e) => e.entityType === 'battery-hybrid') ?? null;
}

/**
 * The pilot flow for one battery entity. Claims are editor-derived: only the
 * delegated strategy claims; the plan-fed control node stays claim-free.
 */
export function pilotTemplate(
  name: string,
  batteryEntityId: string,
  siteId?: string,
): FlowDocument {
  const doc: FlowDocument = {
    schema_version: '1.0',
    name,
    runtime: 'edge',
    ...(siteId ? { site_id: siteId } : {}),
    nodes: [
      { id: 'price1', type: 'vp.price.dayahead', type_version: '1.0.0', parameters: {} },
      { id: 'pv1', type: 'vp.forecast.pv', type_version: '1.0.0', parameters: {} },
      {
        id: 'soc1',
        type: 'vp.entity.read',
        type_version: '1.0.0',
        parameters: { entity_id: batteryEntityId, channel: 'soc_pct' },
      },
      {
        id: 'strat1',
        type: 'vp.strategy.market',
        type_version: '1.0.0',
        parameters: { entity_id: batteryEntityId, speicherschonung: 'ausgewogen' },
      },
      {
        id: 'ctl1',
        type: 'vp.entity.control',
        type_version: '1.0.0',
        parameters: { entity_id: batteryEntityId, command: 'setpoint_kw', ttl_s: 180 },
      },
    ],
    edges: [
      { id: 'e1', from: { node: 'price1', port: 'prices' }, to: { node: 'strat1', port: 'price_in' } },
      { id: 'e2', from: { node: 'pv1', port: 'forecast' }, to: { node: 'strat1', port: 'pv_forecast' } },
      { id: 'e3', from: { node: 'soc1', port: 'value' }, to: { node: 'strat1', port: 'soc' } },
      { id: 'e4', from: { node: 'strat1', port: 'wunsch' }, to: { node: 'ctl1', port: 'plan' } },
    ],
    triggers: [{ id: 't1', kind: 'slot-boundary' }],
  };
  return applyDerivedClaims(doc);
}

/** The recorded dry-run of a version (flowsApi FlowSimulationSummary shape). */
export interface SimSummaryLike {
  scenario: 'voltpilot' | 'standardSpeicher';
  preisjahr?: string;
  headline?: { gesamtVorteilNettoEur?: number; voltpilotVorteilNettoEur?: number };
}

/**
 * ONE calm German sentence for a flow card's recorded simulation - which
 * scenario represents the flow and what it earned vs. ohne Speicher (net,
 * the honest currency). Null without a recorded run.
 */
export function simSummaryLine(sim: SimSummaryLike | null | undefined): string | null {
  if (!sim) return null;
  const year = sim.preisjahr ? ` ${sim.preisjahr}` : '';
  const gesamt = sim.headline?.gesamtVorteilNettoEur;
  if (gesamt == null) return `Simulation${year} abgeschlossen.`;
  const eur = `${Math.round(Math.abs(gesamt))} €`;
  const base = gesamt >= 0
    ? `Simulation${year}: +${eur}/Jahr gegenüber ohne Speicher`
    : `Simulation${year}: ${eur}/Jahr weniger als ohne Speicher`;
  if (sim.scenario === 'standardSpeicher') {
    return `${base} (Standard-Speicher-Verhalten).`;
  }
  return `${base}.`;
}

export interface ChainEntry {
  label: string;
  group: string;
}

/**
 * The mini chain of a flow card (mockup Screen 2): nodes in topological
 * order along the longest path, at most `limit` entries.
 */
export function flowChain(doc: FlowDocument, limit = 4): ChainEntry[] {
  const order = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < doc.nodes.length + 1; pass += 1) {
    let changed = false;
    for (const edge of doc.edges) {
      if (edge.feedback) continue;
      const want = (order.get(edge.from.node) ?? 0) + 1;
      if (order.has(edge.to.node) && want > (order.get(edge.to.node) ?? 0)
          && want <= doc.nodes.length) {
        order.set(edge.to.node, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const sorted = [...doc.nodes].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
  const entries: ChainEntry[] = [];
  const seenGroups = new Set<string>();
  for (const node of sorted) {
    const type = catalogType(node.type);
    if (!type) continue;
    // one representative per group keeps the chain readable
    const key = `${type.group}:${type.label}`;
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    entries.push({ label: type.label, group: type.group });
    if (entries.length >= limit) break;
  }
  return entries;
}
