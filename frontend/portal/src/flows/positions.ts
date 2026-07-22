/**
 * Portal v3 M5 · Part A - freely draggable node positions (pure, unit-tested).
 *
 * THE HARD RULE: a dragged position must NEVER reach the flow document or the
 * compiled artifact. The flow-graph schema is `additionalProperties: false` and
 * carries no positions, and flowc assigns the artifact bundle's x/y itself -
 * INSIDE `content_hash`. So a drag that touched the document would change the
 * hash and re-deploy the device on every mouse move. Positions are therefore a
 * PORTAL concern, stored per flow_id in their own `flow_layout` table
 * (GET/PUT .../flows/{flowId}/layout) and merged here at render time.
 *
 * `layout.ts` stays the deterministic fallback: a node without a saved position
 * gets its auto-layout slot, so a position-less flow (and every flow before
 * this milestone) renders exactly as before.
 */
import { CANVAS_PAD, layoutFlow, type FlowLayout, type NodeBox } from './layout';
import type { FlowDocument } from './model';

/** One saved node position (canvas coordinates of the node's top-left corner). */
export interface NodePosition {
  x: number;
  y: number;
}

/** The layout document persisted per flow: node id -> position. */
export type SavedPositions = Record<string, NodePosition>;

/** Drag snapping - a calm grid that also drives the canvas background. */
export const GRID = 8;
/** Nothing may be dragged into negative space (the SVG viewBox starts at 0). */
export const MIN_XY = 8;

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Keep only well-formed positions for nodes that still exist. Mirrors the
 * server-side drop of unknown ids, so a stale layout can never resurrect a
 * deleted node or push garbage into the canvas.
 */
export function sanitizePositions(
  doc: FlowDocument,
  saved: SavedPositions | null | undefined,
): SavedPositions {
  if (!saved) return {};
  const known = new Set(doc.nodes.map((n) => n.id));
  const out: SavedPositions = {};
  for (const [id, pos] of Object.entries(saved)) {
    if (!known.has(id) || !pos || !finite(pos.x) || !finite(pos.y)) continue;
    out[id] = { x: Math.max(0, pos.x), y: Math.max(0, pos.y) };
  }
  return out;
}

/**
 * The canvas layout actually rendered: the deterministic auto-layout with every
 * SAVED position substituted in. Width/height grow to cover the result (plus
 * the canvas padding), so a node dragged to the right never falls out of the
 * viewBox.
 */
export function resolvePositions(
  doc: FlowDocument,
  saved: SavedPositions | null | undefined,
): FlowLayout {
  const auto = layoutFlow(doc);
  const clean = sanitizePositions(doc, saved);
  const boxes = new Map<string, NodeBox>();
  let width = CANVAS_PAD * 2;
  let height = CANVAS_PAD * 2;
  for (const [id, box] of auto.boxes) {
    const pos = clean[id];
    const next: NodeBox = pos ? { ...box, x: pos.x, y: pos.y } : box;
    boxes.set(id, next);
    width = Math.max(width, next.x + next.w + CANVAS_PAD);
    height = Math.max(height, next.y + next.h + CANVAS_PAD);
  }
  return {
    boxes,
    width: Math.max(width, auto.width),
    height: Math.max(height, 200),
  };
}

/**
 * Where a node lands after a pointer drag: the box's ORIGIN at drag start plus
 * the pointer delta, snapped to the grid and kept inside the canvas.
 */
export function dragTo(
  origin: NodePosition,
  delta: { dx: number; dy: number },
): NodePosition {
  return {
    x: Math.max(MIN_XY, snap(origin.x + delta.dx)),
    y: Math.max(MIN_XY, snap(origin.y + delta.dy)),
  };
}

/** Apply one drag result onto the saved set (pure - never mutates). */
export function withPosition(
  saved: SavedPositions,
  nodeId: string,
  pos: NodePosition,
): SavedPositions {
  return { ...saved, [nodeId]: pos };
}

/**
 * True when the two position sets differ - the debounced save only fires on a
 * real change, so opening a flow never writes a layout.
 */
export function positionsChanged(a: SavedPositions, b: SavedPositions): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return true;
  return ka.some((id) => !b[id] || b[id].x !== a[id].x || b[id].y !== a[id].y);
}
