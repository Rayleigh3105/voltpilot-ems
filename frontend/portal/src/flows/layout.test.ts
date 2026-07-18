/** Deterministic layered auto-layout over the pilot flow. */
import { describe, expect, it } from 'vitest';
import { edgePath, layoutFlow, portPosition } from './layout';
import { pilotTemplate } from './templates';

describe('layoutFlow', () => {
  it('layers the pilot left to right (sources → strategy → control)', () => {
    const doc = pilotTemplate('Pilot', 'batt-main');
    const layout = layoutFlow(doc);
    const layer = (id: string) => layout.boxes.get(id)!.layer;
    expect(layer('price1')).toBe(0);
    expect(layer('pv1')).toBe(0);
    expect(layer('soc1')).toBe(0);
    expect(layer('strat1')).toBe(1);
    expect(layer('ctl1')).toBe(2);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('never overlaps nodes within a layer', () => {
    const doc = pilotTemplate('Pilot', 'batt-main');
    const layout = layoutFlow(doc);
    const boxes = [...layout.boxes.values()];
    for (const a of boxes) {
      for (const b of boxes) {
        if (a.id === b.id || a.layer !== b.layer) continue;
        const overlap = a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} vs ${b.id}`).toBe(false);
      }
    }
  });

  it('survives a cyclic (invalid) document without hanging', () => {
    const doc = pilotTemplate('Pilot', 'batt-main');
    doc.edges.push({ id: 'back', from: { node: 'ctl1', port: 'plan' }, to: { node: 'price1', port: 'x' } });
    const layout = layoutFlow(doc);
    expect(layout.boxes.size).toBe(doc.nodes.length);
  });

  it('port positions anchor on the node edges; edgePath is a bezier', () => {
    const doc = pilotTemplate('Pilot', 'batt-main');
    const layout = layoutFlow(doc);
    const out = portPosition(layout, doc, { node: 'price1', port: 'prices' }, 'out')!;
    const box = layout.boxes.get('price1')!;
    expect(out.x).toBe(box.x + box.w);
    expect(out.y).toBeGreaterThan(box.y);
    expect(out.y).toBeLessThan(box.y + box.h);
    const inPos = portPosition(layout, doc, { node: 'strat1', port: 'price_in' }, 'in')!;
    expect(inPos.x).toBe(layout.boxes.get('strat1')!.x);
    expect(edgePath(out, inPos)).toMatch(/^M[\d.]+,[\d.]+ C/);
  });
});
