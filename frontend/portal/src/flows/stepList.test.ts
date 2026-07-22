/**
 * Portal v3 M5 Part E: the phone read view. The two CUSTOMER templates are the
 * golden cases - if a template's step list stops reading like a sentence, the
 * phone view is broken for exactly the flows customers actually build.
 */
import { describe, expect, it } from 'vitest';
import { CUSTOMER_TEMPLATES } from './customerTemplates';
import { liveValues } from './liveValues';
import type { EditorEntity, FlowDocument } from './model';
import { stepList, stepOrder, stepSentence } from './stepList';

const ENTITIES: EditorEntity[] = [
  {
    id: 'wallbox-hof',
    entityType: 'wallbox',
    label: 'Wallbox Hof',
    measure: ['power_kw'],
    actuate: ['on_off', 'setpoint_kw'],
  },
  {
    id: 'grid-meter-1',
    entityType: 'grid-meter',
    label: 'Netzzähler',
    measure: ['power_kw'],
    actuate: [],
  },
  {
    id: 'heizstab',
    entityType: 'heating-rod',
    label: 'Heizstab',
    measure: [],
    actuate: ['on_off'],
  },
];

function resolveTemplate(id: string): FlowDocument {
  const template = CUSTOMER_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`unknown template ${id}`);
  const resolved = template.resolve(ENTITIES, 'site-1');
  if (!('doc' in resolved)) throw new Error(`template ${id} did not resolve: ${resolved.reason}`);
  return resolved.doc;
}

describe('stepList', () => {
  it('reads the PV-surplus wallbox template as German sentences', () => {
    const doc = resolveTemplate(CUSTOMER_TEMPLATES[0].id);
    const steps = stepList(doc, ENTITIES);
    expect(steps.length).toBe(doc.nodes.length);
    const text = steps.map((s) => s.text).join(' | ');
    expect(text).toMatch(/ablesen/);
    expect(text).toMatch(/Wenn der Wert/);
    expect(text).toMatch(/Dann „Wallbox Hof"/);
    // A data step always precedes the condition that consumes it.
    const readIdx = steps.findIndex((s) => s.kind === 'daten');
    const condIdx = steps.findIndex((s) => s.kind === 'bedingung');
    expect(readIdx).toBeLessThan(condIdx);
    // No internal vocabulary reaches the customer.
    expect(text).not.toMatch(/entity|Entität|node|Baustein-Typ|vp\./i);
  });

  it('reads the schedule template as German sentences', () => {
    const doc = resolveTemplate(CUSTOMER_TEMPLATES[1].id);
    const steps = stepList(doc, ENTITIES);
    const text = steps.map((s) => s.text).join(' | ');
    expect(text).toMatch(/Wenn es zwischen \d\d:\d\d und \d\d:\d\d Uhr ist/);
    expect(text).toMatch(/Dann „[^"]+" einschalten/);
  });

  it('carries the SAME live values the canvas shows, and no invented state', () => {
    const doc = resolveTemplate(CUSTOMER_TEMPLATES[0].id);
    const readNode = doc.nodes.find((n) => n.type === 'vp.entity.read')!;
    const live = liveValues({
      doc,
      channels: [{
        entityId: String(readNode.parameters?.entity_id),
        channel: String(readNode.parameters?.channel),
        value: -3.5,
      }],
    });
    const steps = stepList(doc, ENTITIES, live);
    const read = steps.find((s) => s.nodeId === readNode.id)!;
    expect(read.value).toMatch(/-3,5/);
    expect(steps.every((s) => s.state === null)).toBe(true);
  });

  it('keeps every node even when the graph has a cycle', () => {
    const doc: FlowDocument = {
      schema_version: '1.0',
      name: 'Zyklus',
      runtime: 'edge',
      nodes: [
        { id: 'a', type: 'vp.logic.and', type_version: '1.0.0', parameters: {} },
        { id: 'b', type: 'vp.logic.or', type_version: '1.0.0', parameters: {} },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'result' }, to: { node: 'b', port: 'a' } },
        { id: 'e2', from: { node: 'b', port: 'result' }, to: { node: 'a', port: 'a' } },
      ],
      triggers: [{ id: 't1', kind: 'interval', every_s: 60 }],
    };
    expect(stepOrder(doc).map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('names the code node without pretending to explain the code', () => {
    const sentence = stepSentence(
      { id: 'code1', type: 'vp.logic.function', type_version: '1.0.0', parameters: { code: 'x' } },
      ENTITIES,
    );
    expect(sentence.text).toMatch(/eigenen Code/);
  });
});
