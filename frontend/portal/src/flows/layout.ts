/**
 * Deterministic layered auto-layout for the flow canvas (pure, unit-tested).
 * The flow-graph schema deliberately carries NO node positions
 * (additionalProperties: false) - the editor always renders the tidy
 * left-to-right layering the contract's data-flow reading implies:
 * layer = longest path from a source (feedback edges ignored), vertical
 * stacking within a layer ordered by the barycenter of predecessors.
 */
import { catalogType, type FlowDocument, type PortRef } from './model';

export const NODE_W = 176;
export const LAYER_GAP = 96;
export const ROW_GAP = 32;
export const CANVAS_PAD = 32;
/** Header + sublabel rows. */
const NODE_BASE_H = 58;
/** Extra height per port beyond the first two (ports stack vertically). */
const PORT_ROW_H = 16;

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

export interface FlowLayout {
  boxes: Map<string, NodeBox>;
  width: number;
  height: number;
}

function nodeHeight(typeId: string): number {
  const type = catalogType(typeId);
  const ports = Math.max(type?.inputs.length ?? 0, type?.outputs.length ?? 0);
  return NODE_BASE_H + Math.max(0, ports - 2) * PORT_ROW_H;
}

/** Longest-path layering, feedback edges excluded (they are back-edges). */
export function layoutFlow(doc: FlowDocument): FlowLayout {
  const ids = doc.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const forward = doc.edges.filter(
    (e) => !e.feedback && idSet.has(e.from.node) && idSet.has(e.to.node),
  );

  // Longest path from sources; cycles (a V-2 error state the editor still
  // renders) are cut by bounding iterations.
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length + 1; pass += 1) {
    let changed = false;
    for (const edge of forward) {
      const want = (layer.get(edge.from.node) ?? 0) + 1;
      if (want > (layer.get(edge.to.node) ?? 0) && want <= ids.length) {
        layer.set(edge.to.node, want);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const layers = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    const list = layers.get(l) ?? [];
    list.push(id);
    layers.set(l, list);
  }

  // Order within a layer by the mean row index of predecessors (one pass,
  // document order breaks ties - deterministic).
  const rowIndex = new Map<string, number>();
  const sortedLayers = [...layers.keys()].sort((a, b) => a - b);
  for (const l of sortedLayers) {
    const list = layers.get(l)!;
    const scored = list.map((id, i) => {
      const preds = forward.filter((e) => e.to.node === id)
        .map((e) => rowIndex.get(e.from.node))
        .filter((v): v is number => v !== undefined);
      const score = preds.length > 0
        ? preds.reduce((a, b) => a + b, 0) / preds.length
        : i;
      return { id, score, i };
    });
    scored.sort((a, b) => a.score - b.score || a.i - b.i);
    scored.forEach((s, i) => rowIndex.set(s.id, i));
    layers.set(l, scored.map((s) => s.id));
  }

  const boxes = new Map<string, NodeBox>();
  let width = CANVAS_PAD * 2 + NODE_W;
  let height = CANVAS_PAD * 2;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));
  for (const l of sortedLayers) {
    const x = CANVAS_PAD + l * (NODE_W + LAYER_GAP);
    let y = CANVAS_PAD;
    for (const id of layers.get(l)!) {
      const h = nodeHeight(nodeById.get(id)?.type ?? '');
      boxes.set(id, { id, x, y, w: NODE_W, h, layer: l });
      y += h + ROW_GAP;
    }
    width = Math.max(width, x + NODE_W + CANVAS_PAD);
    height = Math.max(height, y - ROW_GAP + CANVAS_PAD);
  }
  return { boxes, width, height: Math.max(height, 200) };
}

/**
 * Never shrink below this - a scaled-down node must stay readable. Below the
 * floor the canvas keeps its horizontal scroll instead of turning the graph
 * into unreadable confetti.
 */
export const MIN_FIT_SCALE = 0.6;

/**
 * Fit-to-width (audit E-2): the factor the canvas renders at so a graph wider
 * than its viewport still shows its last node instead of clipping it at the
 * right edge. Never magnifies (a small graph keeps its natural size), never
 * shrinks past {@link MIN_FIT_SCALE}, and an unknown/zero available width
 * (first paint, jsdom) yields 1 - so the layout is unchanged until measured.
 */
export function fitScale(contentWidth: number, availableWidth: number): number {
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return 1;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return 1;
  if (contentWidth <= availableWidth) return 1;
  return Math.max(MIN_FIT_SCALE, availableWidth / contentWidth);
}

/** Anchor point of one port on a laid-out node. */
export function portPosition(
  layout: FlowLayout,
  doc: FlowDocument,
  ref: PortRef,
  direction: 'in' | 'out',
): { x: number; y: number } | null {
  const box = layout.boxes.get(ref.node);
  const node = doc.nodes.find((n) => n.id === ref.node);
  if (!box || !node) return null;
  const type = catalogType(node.type);
  const ports = direction === 'in' ? type?.inputs : type?.outputs;
  if (!ports || ports.length === 0) return null;
  const index = Math.max(0, ports.findIndex((p) => p.name === ref.port));
  const usable = box.h - 28;
  const step = usable / (ports.length + 1);
  return {
    x: direction === 'in' ? box.x : box.x + box.w,
    y: box.y + 24 + step * (index + 1),
  };
}

/** Cubic bezier path between an output and an input anchor. */
export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dx = Math.max(40, (to.x - from.x) / 2);
  return `M${from.x},${from.y} C${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
}
