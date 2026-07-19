/**
 * AE2 adaptive energy-flow layout: the pure geometry that generalises the real
 * VoltPilot EnergyFlow (lightning hub + soft circle nodes + grey base spoke +
 * animated coloured dashed flow spoke) from the fixed 4 nodes to N nodes derived
 * from the AE1 topology read-model. Role groups sit on four sides (producers
 * top, storage left, consumers right, grid bottom); each ENTITY that contributes
 * to a role gets its own circle, and the animated spoke's direction encodes the
 * topology flow sign. The renderer (`AdaptiveEnergyFlow.tsx`) is a thin map over
 * this. Unit-tested in adaptiveFlow.test.ts.
 *
 * Visual language + palette faithfully match ae0-mockups.html renderHub.
 */

import type { IconName } from '../designsystem/components/core/Icon';
import type { TopologyEntity } from './api';
import { iconFor, ROLE_META, truncate } from './adaptive';
import { fmtNum } from './format';
import type { FlowNode, Role, Topology } from './topology';

// Geometry constants (mockup renderHub proportions, scaled for readability).
const NODE_R = 30;
const HUB_R = 24;
const LEFT_INSET = 62; // x-inset of the left/right node columns
const TOP_INSET = 48; // y-inset of the top/bottom node rows
const COL_GAP = 148; // horizontal spacing between top/bottom siblings
const ROW_GAP = 82; // vertical spacing between left/right siblings
const LBL_F = 12;
const VAL_F = 11;

/** One rendered circle (one entity's contribution to a role). */
export interface FlowVertex {
  key: string;
  role: Role;
  x: number;
  y: number;
  label: string;
  value: string;
  icon: IconName;
  /** The spoke animates when the role's aggregate flow is active. */
  spokeActive: boolean;
  /** true = hub -> node (consumption / export / charge); false = node -> hub. */
  reverse: boolean;
  strokeWidth: number;
}

export interface FlowLayout {
  W: number;
  H: number;
  hubX: number;
  hubY: number;
  hubR: number;
  nodeR: number;
  lblF: number;
  valF: number;
  vertices: FlowVertex[];
}

/** The four sides, in the order the four roles occupy them. */
type Side = 'top' | 'left' | 'right' | 'bottom';
const ROLE_SIDE: Record<Role, Side> = {
  pv: 'top',
  storage: 'left',
  consumer: 'right',
  grid: 'bottom',
};

function strokeWidth(magnitude: number): number {
  return Math.max(2.5, Math.min(7, 2.5 + Math.abs(magnitude) * 0.7));
}

/**
 * The node's direction, mirroring the customer's existing 4-node EnergyFlow:
 * topology direction 'in' (flows into the hub - PV, import, discharge) animates
 * node -> hub (`reverse=false`); 'out' (hub -> node - load, export, charge)
 * animates `reverse=true`.
 */
function reverseOf(node: FlowNode): boolean {
  return node.direction === 'out';
}

/** The display string inside a circle: SoC for storage, |kW| otherwise. */
function vertexValue(role: Role, node: FlowNode, memberKw: number | undefined): string {
  if (role === 'storage' && node.soc_pct != null) return fmtNum(node.soc_pct, '%', 0);
  if (memberKw == null) return '–';
  return fmtNum(Math.abs(memberKw), 'kW', 1);
}

/**
 * Build the flow layout from the topology read-model. Roles map to fixed sides;
 * each role node's members become circles spread along that side. An empty
 * topology yields no vertices (the caller falls back to the v1 flow).
 */
export function layoutFlow(topology: Topology, entities: TopologyEntity[]): FlowLayout {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nodes = topology.nodes;
  const bySide = (s: Side): FlowNode | undefined =>
    nodes.find((n) => ROLE_SIDE[n.role] === s);

  const count = (s: Side): number => bySide(s)?.members.length ?? 0;
  const cols = Math.max(count('top'), count('bottom'), 1);
  const rows = Math.max(count('left'), count('right'), 1);

  const W = Math.max(520, (cols - 1) * COL_GAP + 2 * (LEFT_INSET + NODE_R + 40));
  const H = Math.max(300, (rows - 1) * ROW_GAP + 2 * (TOP_INSET + NODE_R + 34));
  const hubX = W / 2;
  const hubY = H / 2;
  const leftX = LEFT_INSET;
  const rightX = W - LEFT_INSET;
  const topY = TOP_INSET;
  const bottomY = H - TOP_INSET;

  const vertices: FlowVertex[] = [];

  for (const node of nodes) {
    const side = ROLE_SIDE[node.role];
    const n = node.members.length;
    if (n === 0) continue;
    const reverse = reverseOf(node);
    node.members.forEach((m, i) => {
      const spread = i - (n - 1) / 2;
      let x: number;
      let y: number;
      if (side === 'top') {
        x = hubX + spread * COL_GAP;
        y = topY;
      } else if (side === 'bottom') {
        x = hubX + spread * COL_GAP;
        y = bottomY;
      } else if (side === 'left') {
        x = leftX;
        y = hubY + spread * ROW_GAP;
      } else {
        x = rightX;
        y = hubY + spread * ROW_GAP;
      }
      const entity = byId.get(m.entity_id);
      const label = (m.label && m.label.trim()) || entity?.typeLabel || ROLE_META[node.role].label;
      const mag = m.value_kw ?? node.value_kw ?? 0;
      vertices.push({
        key: `${m.entity_id}:${node.role}:${i}`,
        role: node.role,
        x,
        y,
        label: truncate(label),
        value: vertexValue(node.role, node, m.value_kw),
        icon: iconFor(entity?.entityType ?? '', node.role),
        spokeActive: node.flow_active,
        reverse,
        strokeWidth: strokeWidth(mag),
      });
    });
  }

  return { W, H, hubX, hubY, hubR: HUB_R, nodeR: NODE_R, lblF: LBL_F, valF: VAL_F, vertices };
}
