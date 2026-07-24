/**
 * The flow-editor canvas: a dependency-free React SVG renderer - the EnergyFlow
 * approach, scaled to a node editor.
 *
 * Portal v3 M5 (D2 "our own editor at Node-RED quality") made it INTERACTIVE:
 * nodes are dragged with pointer events (mouse AND touch, via pointer capture),
 * their positions are persisted OUTSIDE the hashed flow document (see
 * flows/positions.ts - a drag must never change `content_hash`), the canvas
 * carries a Node-RED-style grid, and live channel values ride the wires as
 * chips. Click-to-connect is unchanged (deliberately kept: the risk fallback in
 * the milestone spec forbids shipping a canvas that loses it).
 *
 * All interaction RULES live in the pure modules; this component renders and
 * reports pointer deltas.
 */
import { Fragment, useCallback, useRef, useState } from 'react';
import { useContainerWidth } from '../../useContainerWidth';
import { edgePath, fitScale, portPosition, type FlowLayout } from '../../flows/layout';
import type { LiveValuesView } from '../../flows/liveValues';
import {
  dragTo,
  resolvePositions,
  type NodePosition,
  type SavedPositions,
} from '../../flows/positions';
import {
  catalogType,
  compatible,
  nodeSubtitle,
  type EditorEntity,
  type FlowDocument,
  type PortRef,
  type PortType,
} from '../../flows/model';

/** Group hues per the EMS-v2 mockup (Screen 1 palette squares). */
const GROUP_COLOR: Record<string, string> = {
  strategie: 'var(--vp-navy-1, #1E3A5F)',
  daten: 'var(--vp-flow-home, #2196F3)',
  logik: '#78909C',
  aktion: 'var(--vp-chart-charge, #2E9E5B)',
};

/** The code node is deliberately amber - it is the one node running YOUR code. */
const CODE_NODE_COLOR = 'var(--vp-warn, #C77700)';

/** SVG text does not clip at the node rect - truncate with an ellipsis. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface CanvasSelection {
  kind: 'node' | 'edge';
  id: string;
}

export interface ConnectSource {
  ref: PortRef;
  type: PortType;
}

interface FlowCanvasProps {
  doc: FlowDocument;
  entities: EditorEntity[];
  selection: CanvasSelection | null;
  connectFrom: ConnectSource | null;
  errorNodeIds: Set<string>;
  errorEdgeIds: Set<string>;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onPortClick: (ref: PortRef, direction: 'in' | 'out', type: PortType) => void;
  onBackground: () => void;
  /** Saved node positions (M5 Part A). Absent = pure auto-layout, as before. */
  positions?: SavedPositions | null;
  /** Fired after a drag ends. Absent = the canvas is not draggable (preview). */
  onPositionChange?: (nodeId: string, pos: NodePosition) => void;
  /** Live channel chips + device-reported node states (M5 Part C). */
  live?: LiveValuesView | null;
}

export function FlowCanvas({
  doc,
  entities,
  selection,
  connectFrom,
  errorNodeIds,
  errorEdgeIds,
  onSelectNode,
  onSelectEdge,
  onPortClick,
  onBackground,
  positions,
  onPositionChange,
  live,
}: FlowCanvasProps) {
  // While dragging we keep the moving node's position locally so the render is
  // immediate; the parent gets the result once (per move) and debounces the PUT.
  const [dragging, setDragging] = useState<{ id: string; pos: NodePosition } | null>(null);
  const dragRef = useRef<{ id: string; origin: NodePosition; startX: number; startY: number } | null>(null);
  const movedRef = useRef(false);

  const effective: SavedPositions = dragging
    ? { ...(positions ?? {}), [dragging.id]: dragging.pos }
    : (positions ?? {});
  const layout: FlowLayout = resolvePositions(doc, effective);
  const draggable = onPositionChange != null;

  // Fit-to-width (audit E-2): a graph wider than its viewport was clipped at
  // the right edge ("Benachric…" on a 1440 screen). The SVG is rendered at a
  // scale (never magnifying, floored so nodes stay readable) while the viewBox
  // keeps the layout coordinate system - so a pointer delta must be divided by
  // that scale before it becomes a layout delta.
  const [wrapRef, wrapWidth] = useContainerWidth<HTMLDivElement>();
  const scale = fitScale(layout.width, wrapWidth);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const onPointerDown = useCallback(
    (nodeId: string, event: React.PointerEvent<SVGGElement>) => {
      // `button` can be absent on synthetic/touch pointer events - only a
      // real secondary button (>0) must not start a drag.
      if (!draggable || (event.button ?? 0) > 0) return;
      const box = layout.boxes.get(nodeId);
      if (!box) return;
      event.stopPropagation();
      (event.target as Element).setPointerCapture?.(event.pointerId);
      dragRef.current = {
        id: nodeId,
        origin: { x: box.x, y: box.y },
        startX: event.clientX,
        startY: event.clientY,
      };
      movedRef.current = false;
    },
    [draggable, layout],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<SVGGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const s = scaleRef.current || 1;
    const dx = (event.clientX - drag.startX) / s;
    const dy = (event.clientY - drag.startY) / s;
    if (!movedRef.current && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // a click, not a drag
    movedRef.current = true;
    setDragging({ id: drag.id, pos: dragTo(drag.origin, { dx, dy }) });
  }, []);

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (movedRef.current && dragging && onPositionChange) {
      onPositionChange(drag.id, dragging.pos);
    }
    setDragging(null);
  }, [dragging, onPositionChange]);

  return (
    <div className="vp-flowcanvas" data-testid="flow-canvas" ref={wrapRef}>
      <svg
        width={Math.round(layout.width * scale)}
        height={Math.round(layout.height * scale)}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label={`Flow-Diagramm mit ${doc.nodes.length} Bausteinen`}
        onClick={onBackground}
      >
        <defs>
          <marker
            id="vp-flow-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="#90A4AE" />
          </marker>
          <pattern id="vp-flow-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M24 0 L0 0 0 24" fill="none" stroke="currentColor" strokeWidth="1" />
          </pattern>
        </defs>

        <rect
          className="vp-flowgrid"
          x={0}
          y={0}
          width={layout.width}
          height={layout.height}
          fill="url(#vp-flow-grid)"
        />

        {doc.edges.map((edge) => {
          const from = portPosition(layout, doc, edge.from, 'out');
          const to = portPosition(layout, doc, edge.to, 'in');
          if (!from || !to) return null;
          const isSelected = selection?.kind === 'edge' && selection.id === edge.id;
          const isError = errorEdgeIds.has(edge.id);
          const chip = live?.chips[edge.id];
          return (
            <Fragment key={edge.id}>
              <path
                data-testid={`edge-${edge.id}`}
                d={edgePath(from, to)}
                className={`vp-flowedge${isSelected ? ' selected' : ''}${isError ? ' error' : ''}${edge.feedback ? ' feedback' : ''}`}
                markerEnd="url(#vp-flow-arrow)"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEdge(edge.id);
                }}
              />
              {chip !== undefined && (
                <g
                  className="vp-flowchip"
                  data-testid={`chip-${edge.id}`}
                  transform={`translate(${(from.x + to.x) / 2}, ${(from.y + to.y) / 2})`}
                >
                  <rect x={-28} y={-11} width={56} height={20} rx={10} />
                  <text x={0} y={3}>{chip}</text>
                </g>
              )}
            </Fragment>
          );
        })}

        {doc.nodes.map((node) => {
          const box = layout.boxes.get(node.id);
          const type = catalogType(node.type);
          if (!box) return null;
          const color = node.type === 'vp.logic.function'
            ? CODE_NODE_COLOR
            : GROUP_COLOR[type?.group ?? 'logik'] ?? '#78909C';
          const isSelected = selection?.kind === 'node' && selection.id === node.id;
          const isError = errorNodeIds.has(node.id);
          const isDragging = dragging?.id === node.id;
          const state = live?.nodeStates[node.id] ?? null;
          const subtitle = truncate(type ? nodeSubtitle(node, entities) : node.type, 26);
          return (
            <g
              key={node.id}
              data-testid={`node-${node.id}`}
              className={`vp-flownode${isSelected ? ' selected' : ''}${isError ? ' error' : ''}`
                + `${draggable ? ' draggable' : ''}${isDragging ? ' dragging' : ''}`}
              onPointerDown={(e) => onPointerDown(node.id, e)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onClick={(e) => {
                e.stopPropagation();
                if (movedRef.current) return; // a drag is not a selection
                onSelectNode(node.id);
              }}
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={10}
                className="vp-flownode-body"
              />
              <rect x={box.x} y={box.y + 6} width={4} height={box.h - 12} rx={2} fill={color} />
              <text x={box.x + 14} y={box.y + 20} className="vp-flownode-title">
                {truncate(node.label ?? type?.label ?? node.type, 22)}
              </text>
              <text x={box.x + 14} y={box.y + 37} className="vp-flownode-sub">
                {subtitle}
              </text>
              {state && (
                <text
                  data-testid={`state-${node.id}`}
                  x={box.x + 14}
                  y={box.y + 52}
                  className={`vp-flownode-state ${state.tone}`}
                >
                  {truncate(state.label, 24)}
                </text>
              )}

              {(type?.inputs ?? []).map((port) => {
                const pos = portPosition(layout, doc, { node: node.id, port: port.name }, 'in');
                if (!pos) return null;
                const accepts = connectFrom != null
                  && compatible(connectFrom.type, port.type)
                  && connectFrom.ref.node !== node.id;
                return (
                  <Fragment key={`in-${port.name}`}>
                    <circle
                      data-testid={`port-in-${node.id}-${port.name}`}
                      cx={pos.x}
                      cy={pos.y}
                      r={accepts ? 7 : 4.5}
                      className={`vp-flowport in${accepts ? ' accepts' : ''}${connectFrom && !accepts ? ' muted' : ''}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPortClick({ node: node.id, port: port.name }, 'in', port.type);
                      }}
                    >
                      <title>{`${port.label ?? port.name} (${port.type})`}</title>
                    </circle>
                  </Fragment>
                );
              })}

              {(type?.outputs ?? []).map((port) => {
                const pos = portPosition(layout, doc, { node: node.id, port: port.name }, 'out');
                if (!pos) return null;
                const isSource = connectFrom?.ref.node === node.id
                  && connectFrom.ref.port === port.name;
                return (
                  <circle
                    key={`out-${port.name}`}
                    data-testid={`port-out-${node.id}-${port.name}`}
                    cx={pos.x}
                    cy={pos.y}
                    r={isSource ? 7 : 4.5}
                    className={`vp-flowport out${isSource ? ' source' : ''}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPortClick({ node: node.id, port: port.name }, 'out', port.type);
                    }}
                  >
                    <title>{`${port.label ?? port.name} (${port.type})`}</title>
                  </circle>
                );
              })}
            </g>
          );
        })}

        {doc.nodes.length === 0 && (
          <text x={32} y={56} className="vp-flownode-sub">
            Fügen Sie links Bausteine hinzu, um den Flow aufzubauen.
          </text>
        )}
      </svg>
    </div>
  );
}
