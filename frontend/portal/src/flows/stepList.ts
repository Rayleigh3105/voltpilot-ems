/**
 * Portal v3 M5 · Part E - the PHONE read view (pure, unit-tested).
 *
 * Below 720 px an automation is a vertical STEP LIST, not a mini canvas: a
 * dragged graph on a 375 px screen is unreadable and un-editable, so the phone
 * gets the same information as a sequence of plain German sentences with the
 * same live values ("Wenn PV-Überschuss über 3,5 kW … dann Wallbox EIN").
 *
 * The order is topological over the non-feedback edges, so a step never
 * references a value that has not been read yet.
 */
import { channelLabel } from '../channels';
import { fmtNum } from '../format';
import type { LiveValuesView } from './liveValues';
import { catalogType, type EditorEntity, type FlowDocument, type FlowNode } from './model';

export type StepKind = 'daten' | 'bedingung' | 'aktion';

export interface FlowStep {
  nodeId: string;
  kind: StepKind;
  /** The German sentence, already prefixed ("Wenn …", "Dann …"). */
  text: string;
  /** The live chip for this step, when a value exists. */
  value: string | null;
  /** The device-reported state, when the edge reports one (never guessed). */
  state: string | null;
  tone: 'ok' | 'off' | 'error' | null;
}

function entityLabel(entities: EditorEntity[], id: unknown): string {
  const found = entities.find((e) => e.id === String(id ?? ''));
  return found?.label ?? String(id ?? 'Gerät');
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const COMMAND_WORDS: Record<string, string> = {
  on_off: 'einschalten',
  setpoint_kw: 'auf den berechneten Wert stellen',
  limit_kw: 'begrenzen',
  limit_pct: 'begrenzen',
  mode: 'in den gewählten Modus schalten',
};

/** The one German sentence for a node - the whole vocabulary lives here. */
export function stepSentence(node: FlowNode, entities: EditorEntity[]): { kind: StepKind; text: string } {
  const p = node.parameters ?? {};
  switch (node.type) {
    case 'vp.entity.read':
      return {
        kind: 'daten',
        text: `${channelLabel(String(p.channel ?? ''))} von „${entityLabel(entities, p.entity_id)}" ablesen`,
      };
    case 'vp.modbus.read':
      return { kind: 'daten', text: 'Messwert vom angeschlossenen Gerät ablesen' };
    case 'vp.price.current':
      return { kind: 'daten', text: 'Aktuellen Strompreis ablesen' };
    case 'vp.price.dayahead':
      return { kind: 'daten', text: 'Börsenpreise des Tages ablesen' };
    case 'vp.forecast.pv':
      return { kind: 'daten', text: 'Solar-Prognose ablesen' };
    case 'vp.logic.threshold': {
      const threshold = num(p.threshold);
      const dir = p.direction === 'below' ? 'unter' : 'über';
      return {
        kind: 'bedingung',
        text: threshold == null
          ? 'Wenn der Schwellwert erreicht ist'
          : `Wenn der Wert ${dir} ${fmtNum(threshold, 'kW')} liegt`,
      };
    }
    case 'vp.schedule.window':
      return {
        kind: 'bedingung',
        text: `Wenn es zwischen ${String(p.from ?? '--:--')} und ${String(p.to ?? '--:--')} Uhr ist`,
      };
    case 'vp.logic.and':
      return { kind: 'bedingung', text: 'Wenn BEIDE Bedingungen zutreffen' };
    case 'vp.logic.or':
      return { kind: 'bedingung', text: 'Wenn MINDESTENS EINE Bedingung zutrifft' };
    case 'vp.logic.gate':
      return { kind: 'bedingung', text: 'Wenn die Bedingung eintritt' };
    case 'vp.logic.if': {
      const then = num(p.then_value);
      return {
        kind: 'bedingung',
        text: then == null
          ? 'Dann den festgelegten Wert setzen'
          : `Dann ${fmtNum(then, 'kW')} vorgeben`,
      };
    }
    case 'vp.logic.function':
      return { kind: 'bedingung', text: 'Dann den Wert mit Ihrem eigenen Code berechnen' };
    case 'vp.entity.control': {
      const word = COMMAND_WORDS[String(p.command ?? '')] ?? 'ansteuern';
      return { kind: 'aktion', text: `Dann „${entityLabel(entities, p.entity_id)}" ${word}` };
    }
    case 'vp.notify.push':
      return {
        kind: 'aktion',
        text: `Dann benachrichtigen: „${String(p.message ?? '')}"`,
      };
    default: {
      if (node.type.startsWith('vp.strategy.')) {
        return {
          kind: 'aktion',
          text: `VoltPilot steuert „${entityLabel(entities, p.entity_id)}" nach dieser Strategie`,
        };
      }
      const type = catalogType(node.type);
      return { kind: 'daten', text: node.label ?? type?.label ?? node.type };
    }
  }
}

/** Topological order over non-feedback edges; document order breaks ties. */
export function stepOrder(doc: FlowDocument): FlowNode[] {
  const indeg = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(doc.nodes.map((n) => [n.id, []]));
  for (const e of doc.edges) {
    if (e.feedback) continue;
    if (!indeg.has(e.from.node) || !indeg.has(e.to.node)) continue;
    adj.get(e.from.node)!.push(e.to.node);
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
  }
  const out: FlowNode[] = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const queue = doc.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id)!);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 1) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  // A cycle (a validation error the editor still renders) keeps its nodes.
  for (const node of doc.nodes) if (!seen.has(node.id)) out.push(node);
  return out;
}

/**
 * The phone step list. `live` is the SAME derivation the canvas uses, so both
 * views show the same numbers - and both show no node state when the device
 * does not report one.
 */
export function stepList(
  doc: FlowDocument,
  entities: EditorEntity[] = [],
  live?: LiveValuesView | null,
): FlowStep[] {
  const chipFor = (nodeId: string): string | null => {
    if (!live) return null;
    const edge = doc.edges.find((e) => e.from.node === nodeId && live.chips[e.id] !== undefined);
    return edge ? live.chips[edge.id] : null;
  };
  return stepOrder(doc).map((node) => {
    const sentence = stepSentence(node, entities);
    const state = live?.nodeStates[node.id] ?? null;
    return {
      nodeId: node.id,
      kind: sentence.kind,
      text: sentence.text,
      value: chipFor(node.id),
      state: state?.label ?? null,
      tone: state?.tone ?? null,
    };
  });
}
