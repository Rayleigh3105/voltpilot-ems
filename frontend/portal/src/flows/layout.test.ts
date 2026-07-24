/** Deterministic layered auto-layout over the pilot flow. */
import { describe, expect, it } from 'vitest';
import { MIN_FIT_SCALE, edgePath, fitScale, layoutFlow, portPosition } from './layout';
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

/**
 * Audit E-2: at 1440 the third node was clipped at the right edge of the canvas
 * viewport ("Benachric…") because the SVG was rendered at its full layout width
 * inside a narrower box. `fitScale` is the pure half of the fix.
 */
describe('fitScale (audit E-2)', () => {
  it('shrinks a graph that is wider than its viewport', () => {
    expect(fitScale(1000, 800)).toBe(0.8);
    expect(fitScale(1000, 700)).toBe(0.7);
  });

  it('never magnifies a graph that already fits', () => {
    expect(fitScale(400, 1200)).toBe(1);
    expect(fitScale(1200, 1200)).toBe(1);
  });

  it('never shrinks past the readability floor (scroll takes over)', () => {
    expect(fitScale(4000, 200)).toBe(MIN_FIT_SCALE);
  });

  it('is a no-op until the container has been measured', () => {
    expect(fitScale(1000, 0)).toBe(1);
    expect(fitScale(1000, Number.NaN)).toBe(1);
    expect(fitScale(0, 500)).toBe(1);
  });

  it('keeps the whole pilot graph inside a real editor viewport', () => {
    const layout = layoutFlow(pilotTemplate('Pilot', 'batt-main'));
    const viewport = 760; // the canvas column at 1440 with palette + inspector
    const scale = fitScale(layout.width, viewport);
    expect(layout.width * scale).toBeLessThanOrEqual(viewport + 0.001);
  });
});
