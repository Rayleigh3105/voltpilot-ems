/**
 * The flow-editor canvas: a dependency-free React SVG renderer over the pure
 * layered auto-layout (src/flows/layout.ts) - the EnergyFlow approach, scaled
 * to a node editor. The schema carries NO positions (additionalProperties:
 * false), so the layout is always the deterministic layering; connecting is
 * click-to-connect (click an output port, compatible inputs light up, click
 * one) - no drag wiring needed for the MVP. All interaction handlers live in
 * the page; this component only renders.
 */
import { Fragment } from 'react';
import {
  CANVAS_PAD,
  edgePath,
  layoutFlow,
  portPosition,
} from '../../flows/layout';
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
}: FlowCanvasProps) {
  const layout = layoutFlow(doc);

  return (
    <div className="vp-flowcanvas" data-testid="flow-canvas">
      <svg
        width={layout.width}
        height={layout.height}
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
        </defs>

        {doc.edges.map((edge) => {
          const from = portPosition(layout, doc, edge.from, 'out');
          const to = portPosition(layout, doc, edge.to, 'in');
          if (!from || !to) return null;
          const isSelected = selection?.kind === 'edge' && selection.id === edge.id;
          const isError = errorEdgeIds.has(edge.id);
          return (
            <path
              key={edge.id}
              data-testid={`edge-${edge.id}`}
              d={edgePath(from, to)}
              className={`vp-flowedge${isSelected ? ' selected' : ''}${isError ? ' error' : ''}${edge.feedback ? ' feedback' : ''}`}
              markerEnd="url(#vp-flow-arrow)"
              onClick={(e) => {
                e.stopPropagation();
                onSelectEdge(edge.id);
              }}
            />
          );
        })}

        {doc.nodes.map((node) => {
          const box = layout.boxes.get(node.id);
          const type = catalogType(node.type);
          if (!box) return null;
          const color = GROUP_COLOR[type?.group ?? 'logik'] ?? '#78909C';
          const isSelected = selection?.kind === 'node' && selection.id === node.id;
          const isError = errorNodeIds.has(node.id);
          const subtitle = truncate(type ? nodeSubtitle(node, entities) : node.type, 26);
          return (
            <g
              key={node.id}
              data-testid={`node-${node.id}`}
              className={`vp-flownode${isSelected ? ' selected' : ''}${isError ? ' error' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
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
          <text x={CANVAS_PAD} y={CANVAS_PAD + 24} className="vp-flownode-sub">
            Fügen Sie links Bausteine hinzu, um den Flow aufzubauen.
          </text>
        )}
      </svg>
    </div>
  );
}
