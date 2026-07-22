/**
 * Portal v3 M5 Part A. The load-bearing property is NEGATIVE: a position must
 * never travel into the flow document (flowc puts the artifact's x/y inside
 * `content_hash`, so a drag that reached the document would re-deploy the
 * device on every mouse move). These vectors pin the merge, the drag maths and
 * the unknown-id drop.
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './layout';
import type { FlowDocument } from './model';
import {
  GRID,
  dragTo,
  positionsChanged,
  resolvePositions,
  sanitizePositions,
  withPosition,
} from './positions';

const DOC: FlowDocument = {
  schema_version: '1.0',
  name: 'Test',
  runtime: 'edge',
  nodes: [
    { id: 'lesen1', type: 'vp.entity.read', type_version: '1.0.0', parameters: {} },
    { id: 'schwelle1', type: 'vp.logic.threshold', type_version: '1.1.0', parameters: {} },
  ],
  edges: [
    { id: 'e1', from: { node: 'lesen1', port: 'value' }, to: { node: 'schwelle1', port: 'input' } },
  ],
  triggers: [{ id: 't1', kind: 'interval', every_s: 60 }],
};

describe('positions', () => {
  it('falls back to the deterministic auto-layout for a position-less flow', () => {
    const auto = layoutFlow(DOC);
    const merged = resolvePositions(DOC, null);
    for (const [id, box] of auto.boxes) {
      expect(merged.boxes.get(id)?.x).toBe(box.x);
      expect(merged.boxes.get(id)?.y).toBe(box.y);
    }
  });

  it('substitutes only the saved nodes and keeps the rest auto-laid-out', () => {
    const auto = layoutFlow(DOC);
    const merged = resolvePositions(DOC, { schwelle1: { x: 640, y: 320 } });
    expect(merged.boxes.get('schwelle1')).toMatchObject({ x: 640, y: 320 });
    expect(merged.boxes.get('lesen1')?.x).toBe(auto.boxes.get('lesen1')?.x);
    // The canvas grows so a node dragged right never falls out of the viewBox.
    expect(merged.width).toBeGreaterThan(640);
    expect(merged.height).toBeGreaterThan(320);
  });

  it('drops positions of unknown or malformed nodes', () => {
    const clean = sanitizePositions(DOC, {
      lesen1: { x: 10, y: 20 },
      geloescht: { x: 1, y: 1 },
      kaputt: { x: Number.NaN, y: 3 },
    } as never);
    expect(Object.keys(clean)).toEqual(['lesen1']);
  });

  it('never places a node in negative space and snaps to the grid', () => {
    expect(dragTo({ x: 100, y: 100 }, { dx: 3, dy: 3 })).toEqual({ x: 104, y: 104 });
    expect(dragTo({ x: 100, y: 100 }, { dx: -500, dy: -500 })).toEqual({ x: 8, y: 8 });
    const snapped = dragTo({ x: 0, y: 0 }, { dx: 101, dy: 99 });
    expect(snapped.x % GRID).toBe(0);
    expect(snapped.y % GRID).toBe(0);
  });

  it('withPosition is pure and positionsChanged only fires on a real change', () => {
    const before = { lesen1: { x: 8, y: 8 } };
    const after = withPosition(before, 'schwelle1', { x: 40, y: 40 });
    expect(before).toEqual({ lesen1: { x: 8, y: 8 } });
    expect(positionsChanged(before, after)).toBe(true);
    expect(positionsChanged(after, { ...after })).toBe(false);
    expect(positionsChanged(after, withPosition(after, 'lesen1', { x: 9, y: 8 }))).toBe(true);
  });

  it('the document is never touched by a layout operation', () => {
    const snapshot = JSON.stringify(DOC);
    resolvePositions(DOC, { lesen1: { x: 500, y: 500 } });
    sanitizePositions(DOC, { lesen1: { x: 1, y: 1 } });
    expect(JSON.stringify(DOC)).toBe(snapshot);
    // ...and no node object carries an x/y - the schema forbids it.
    for (const node of DOC.nodes) {
      expect(Object.keys(node)).not.toContain('x');
      expect(Object.keys(node)).not.toContain('y');
    }
  });
});
