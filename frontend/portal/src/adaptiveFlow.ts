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
import { iconFor, ROLE_META } from './adaptive';
import { fmtNum } from './format';
import type { FlowNode, Role, Topology } from './topology';

// Geometry constants (mockup renderHub proportions, scaled for readability).
const NODE_R = 30;
const HUB_R = 24;
const LEFT_INSET = 62; // x-inset of the left/right node columns
const TOP_INSET = 48; // y-inset of the top/bottom node rows
const COL_GAP = 158; // horizontal spacing between top/bottom siblings
// Vertical spacing between left/right siblings. Must clear the two label lines
// that now sit BELOW each circle (NODE_R + 2 lines) before the next circle.
const ROW_GAP = 112;
const LBL_F = 12;
const VAL_F = 12;

/** The label block below a circle: first baseline offset + line height. */
const LBL_DY = 16;
const LBL_LH = 13;
/** Max characters per label line; a 2nd line takes the rest (then ellipsis). */
const LBL_CHARS = 16;
const LBL_MAX_LINES = 2;
/** Name lines + the optional role line - what the layout must reserve room for. */
const LBL_TOTAL_LINES = LBL_MAX_LINES + 1;

/** Short role words used to tell two circles of the SAME device apart. */
const ROLE_SHORT: Record<Role, string> = {
  pv: 'PV',
  storage: 'Speicher',
  consumer: 'Verbraucher',
  grid: 'Netz',
};

/**
 * Wrap a display name into at most {@link LBL_MAX_LINES} lines of ~
 * {@link LBL_CHARS} characters, breaking on spaces where possible. SVG `<text>`
 * has no CSS wrapping/ellipsis, so this is done here; the untruncated name
 * always stays available as the node's `title`.
 */
export function wrapLabel(
  label: string,
  chars = LBL_CHARS,
  maxLines = LBL_MAX_LINES,
): string[] {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= chars || cur === '') {
      cur = next;
    } else {
      lines.push(cur);
      cur = w;
    }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  // A single word longer than the line budget still has to be cut somewhere.
  const out = lines.slice(0, maxLines).map((l) => (l.length > chars + 4 ? `${l.slice(0, chars + 3)}…` : l));
  const consumed = out.join(' ');
  if (consumed.replace(/…$/, '').length < label.trim().length && out.length === maxLines) {
    const last = out[maxLines - 1];
    out[maxLines - 1] = last.endsWith('…') ? last : `${last.slice(0, Math.max(1, chars - 1))}…`;
  }
  return out;
}

/** One rendered circle (one entity's contribution to a role). */
export interface FlowVertex {
  key: string;
  role: Role;
  x: number;
  y: number;
  /**
   * The full display name, role-disambiguated when the SAME name would appear
   * on two circles (a hybrid inverter contributes to PV *and* Speicher - two
   * identical "Batteriespeicher…" circles were indistinguishable, G2).
   */
  label: string;
  /** The NAME wrapped for rendering BELOW the circle (never clipped inside it). */
  labelLines: string[];
  /**
   * The disambiguating role word, rendered as its own short line under the
   * name - never appended to the name, where the wrap would eat it. null when
   * the name is already unique on this diagram.
   */
  roleTag: string | null;
  /** Untruncated "Name · Rolle" for the node's `<title>` tooltip. */
  title: string;
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
  /** y-offset of the first label line relative to the circle centre. */
  lblDy: number;
  /** Line height of the label block. */
  lblLh: number;
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

  // The label block sits BELOW each circle, so both the viewBox height and the
  // bottom row need room for it (LBL_DY + 2 lines) - G2.
  const labelBlock = LBL_DY + LBL_TOTAL_LINES * LBL_LH;
  const W = Math.max(560, (cols - 1) * COL_GAP + 2 * (LEFT_INSET + NODE_R + 44));
  const H = Math.max(
    340,
    (rows - 1) * ROW_GAP + 2 * (TOP_INSET + NODE_R + labelBlock),
  );
  const hubX = W / 2;
  const hubY = H / 2;
  const leftX = LEFT_INSET;
  const rightX = W - LEFT_INSET;
  const topY = TOP_INSET;
  // Keep the bottom row's circle AND its label block inside the viewBox.
  const bottomY = H - NODE_R - labelBlock - 6;

  const vertices: FlowVertex[] = [];

  // A display name that would appear on more than one circle gets its role
  // appended - two "Batteriespeicher …" circles (PV share + Speicher) must
  // read differently for the customer (G2).
  const nameCount = new Map<string, number>();
  for (const node of nodes) {
    for (const m of node.members) {
      const entity = byId.get(m.entity_id);
      const base =
        (m.label && m.label.trim()) || entity?.typeLabel || ROLE_META[node.role].label;
      nameCount.set(base, (nameCount.get(base) ?? 0) + 1);
    }
  }

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
      const base = (m.label && m.label.trim()) || entity?.typeLabel || ROLE_META[node.role].label;
      const ambiguous = (nameCount.get(base) ?? 0) > 1;
      const roleTag = ambiguous ? ROLE_SHORT[node.role] : null;
      const label = roleTag ? `${base} · ${roleTag}` : base;
      const mag = m.value_kw ?? node.value_kw ?? 0;
      vertices.push({
        key: `${m.entity_id}:${node.role}:${i}`,
        role: node.role,
        x,
        y,
        label,
        labelLines: wrapLabel(base),
        roleTag,
        title: `${base} · ${ROLE_META[node.role].label}`,
        value: vertexValue(node.role, node, m.value_kw),
        icon: iconFor(entity?.entityType ?? '', node.role),
        spokeActive: node.flow_active,
        reverse,
        strokeWidth: strokeWidth(mag),
      });
    });
  }

  return {
    W,
    H,
    hubX,
    hubY,
    hubR: HUB_R,
    nodeR: NODE_R,
    lblF: LBL_F,
    valF: VAL_F,
    lblDy: LBL_DY,
    lblLh: LBL_LH,
    vertices,
  };
}
