/**
 * AE2 adaptive energy-flow layout: the pure geometry of the real VoltPilot
 * EnergyFlow (lightning hub + soft circle nodes + grey base spoke + animated
 * coloured dashed flow spoke), driven by the AE1 topology read-model. The
 * renderer (`AdaptiveEnergyFlow.tsx`) is a thin map over this. Unit-tested in
 * adaptiveFlow.test.ts.
 *
 * **ONE circle per ROLE (owner decision A1, concept `vp-ui-pv-hist-d8`).** The
 * layout used to draw one circle per MEMBER, which produced the three defects
 * the owner tripped over on his three-inverter plant: the hybrid inverter
 * appeared TWICE (once as „Batteriespeicher · PV", once as storage), the two
 * separate Fronius producers drew empty „–" circles because they have no series
 * of their own, and the diagram grew a circle per device. Now the four roles are
 * four circles - PV-Erzeugung top, Batteriespeicher left, Hausverbrauch right,
 * Netz bottom - the geometry never grows with the device count, and the
 * composition of a role is one click away (`pvComposition.ts`), which is exactly
 * what the Anlagen-Modell page always promised.
 *
 * Visual language + palette faithfully match ae0-mockups.html renderHub - the
 * owner's hard constraint: „Das Flussdiagramm soll aber in seiner Art bleiben."
 */

import type { IconName } from '../designsystem/components/core/Icon';
import type { TopologyEntity } from './api';
import { iconFor, ROLE_META } from './adaptive';
import { deviceName } from './entityLabel';
import { fmtNum } from './format';
import type { FlowNode, Role, Topology } from './topology';

// Geometry constants (mockup renderHub proportions, scaled for readability).
const NODE_R = 30;
const HUB_R = 24;
const LEFT_INSET = 62; // x-inset of the left/right node columns
const TOP_INSET = 48; // y-inset of the top/bottom node rows
const LBL_F = 12;
const VAL_F = 12;
/** Landscape minimum of the viewBox (tablet/desktop). */
const MIN_W = 560;
const MIN_H = 340;

/**
 * V9 (Audit) — the PHONE geometry. At 375 px the landscape diamond was squeezed
 * into ~290 px of card, and because the `<svg>` is a flex item its automatic
 * minimum size kept it 440 px wide inside a clipping parent: the whole
 * Hausverbrauch node sat OFF-SCREEN with its connector running to nowhere.
 * Under {@link NARROW_MAX_PX} the layout switches to a portrait cross - a
 * narrower viewBox, tighter insets - so everything fits AND the 12 px labels
 * are not scaled into illegibility. Same nodes, same spokes, same animation;
 * only the coordinates differ (the `EnergyFlow` WIDE/NARROW precedent).
 */
export const NARROW_MAX_PX = 420;
const N_LEFT_INSET = 46;
const N_TOP_INSET = 44;
const N_MIN_W = 300;
const N_MIN_H = 384;

/**
 * Der Laden-Knoten: sein Abstand UNTER dem Haus-Knoten, und wie viel die
 * viewBox dafür wächst. Beides dieselbe Zahl - der Kreis samt Beschriftung
 * muss unten hineinpassen.
 *
 * ⚠ Die Zahl ist am Bild GEMESSEN, nicht geschätzt: der Abzweig beginnt erst
 * UNTER dem Beschriftungsblock des Hauses (`NODE_R + LBL_DY + LBL_LH` = 59)
 * und endet am oberen Rand des Laden-Kreises (`− NODE_R`). Bei 104 blieben
 * davon 15 px sichtbare Speiche - zu wenig, um als Abzweig gelesen zu werden.
 */
const CHARGING_DY = 118;
const CHARGING_LABEL = 'Laden';
/** Die Verbraucher-Hue - Laden IST Verbrauch, nur ein benannter Teil davon. */
const CHARGING_COLOR = 'var(--vp-flow-load)';
const CHARGING_SOFT = 'var(--vp-flow-load-soft)';
/** Der Abzweig ist DÜNNER als eine Hub-Speiche - er ist ein Teil, kein Anschluss. */
const CHARGING_BASE_W = 4;

/** The label block below a circle: first baseline offset + line height. */
const LBL_DY = 16;
const LBL_LH = 13;
/** Max characters per label line; a 2nd line takes the rest (then ellipsis). */
const LBL_CHARS = 16;
const LBL_MAX_LINES = 2;
/** Name lines + the optional role line - what the layout must reserve room for. */
const LBL_TOTAL_LINES = LBL_MAX_LINES + 1;

/**
 * The four node names. A role node says what it IS - a device name never
 * appears in the diagram any more, so the two surfaces cannot name the same box
 * differently (the names live in the composition details, derived once by
 * `entityLabel.deviceName`).
 */
export const ROLE_NODE_LABEL: Record<Role, string> = {
  pv: 'PV-Erzeugung',
  storage: 'Batteriespeicher',
  consumer: 'Hausverbrauch',
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

/** One rendered circle = one ROLE of the plant (never one device). */
/**
 * Die Rolle eines KREISES. Bis auf `charging` ist das die Topologie-Rolle.
 *
 * ⚠ `charging` ist BEWUSST keine Topologie-Rolle: `topology.ts` `Role` ist ein
 * VERTRAG mit Go- und Java-Zwillingen und geteilten Vektoren
 * (`topology-vectors.json`) - ihn für eine reine Anzeige-Scheibe zu weiten
 * hiesse, drei Sprachen und eine Kontrakt-Datei für etwas zu ändern, das der
 * Server (noch) gar nicht ableitet. Die echte Rolle `charging` kommt in
 * Phase 1 (Konzept §8, C2); bis dahin ist der Knoten hier ein Aufsatz aus
 * `/chargers`, und dieser Typ ist die eine Stelle, an der beides zusammenläuft.
 */
export type FlowVertexRole = Role | 'charging';

export interface FlowVertex {
  key: string;
  role: FlowVertexRole;
  x: number;
  y: number;
  /** The role's node name ("PV-Erzeugung", "Batteriespeicher", …). */
  label: string;
  /** The name wrapped for rendering BELOW the circle (never clipped). */
  labelLines: string[];
  /**
   * The short caption under the name, in the role colour: "3 Geräte" for a PV
   * role made of several inverters (the affordance for the composition
   * details), else the state word ("lädt 8,2 kW", "Einspeisung"). Its own line -
   * appended to the name the wrap would eat it.
   */
  subLabel: string | null;
  /** Untruncated "Rolle · beteiligte Geräte" for the node's `<title>` tooltip. */
  title: string;
  value: string;
  icon: IconName;
  /**
   * Die Farbe des Kreises und seiner Speiche. Sie steht AM Knoten, statt beim
   * Rendern über `ROLE_META[v.role]` nachgeschlagen zu werden - `charging` ist
   * bewusst keine Topologie-Rolle, also gibt es dort keinen Eintrag, und ein
   * Nachschlagen wäre die eine Stelle, an der der fünfte Knoten strukturell
   * nicht hineinpasst.
   */
  color: string;
  /** Die weiche Füllung des Kreises (das `--vp-flow-*-soft`-Token). */
  soft: string;
  /** Die Breite der grauen Grund-Speiche (der Abzweig ist dünner). */
  baseWidth: number;
  /** The spoke animates when the role's aggregate flow is active. */
  spokeActive: boolean;
  /** true = hub -> node (consumption / export / charge); false = node -> hub. */
  reverse: boolean;
  strokeWidth: number;
  /**
   * x the label block is centred on. Normally the circle centre; on a narrow
   * (phone) viewBox an outer column's long name would stick out past the
   * viewBox edge and be clipped ("3atteriespeicher"), so it is nudged inwards.
   */
  labelX: number;
  /**
   * V15 (Audit): where the spoke STARTS on the node side. For a node whose
   * label block lies between its circle and the hub (the top row), the line is
   * trimmed past that block, so the animated dots no longer run straight
   * through the „PV" role word. Everywhere else this is the circle centre, so
   * the geometry is unchanged.
   */
  spokeX: number;
  spokeY: number;
  /**
   * Wohin die Speiche LÄUFT. Vorgabe ist der Hub; der Laden-Knoten hängt
   * stattdessen am HAUS (E3: ein Abzweig, kein zweiter Anschluss), damit die
   * Haus-Summe „alles hinter dem Anschluss" bleibt und Flussbild, Board-Zeile
   * und Captain-Regel dieselbe Zahl sagen.
   */
  toX?: number;
  toY?: number;
  /** How many devices contribute to this role (>= 1). */
  memberCount: number;
  /**
   * **Die Verzahnung von Steuerung und Fluss** (Konzept „Die Bühne" §6.3): der
   * Speicher-Knoten trägt den Bestätigungs-Haken, sobald der Wechselrichter den
   * Fahrplan-Sollwert bestätigt hat — die Bestätigung ist damit AM Diagramm
   * ablesbar, der Bühnenfuß liefert Satz und Grund.
   *
   * Nur am Speicher, nur wenn er wirklich etwas tut (es gibt eine
   * Zustandszeile), und NUR im gesunden Zustand (`controlStrip().state ===
   * 'healthy'`) — eine Abweichung, ein abgeschalteter oder noch nicht
   * bestätigter Sollwert bekommt keinen Haken (nie eine behauptete Bestätigung).
   */
  confirmed: boolean;
  /**
   * true = a click on this circle opens the composition details. Only where
   * there is something to explain (2+ contributing devices) - a single-inverter
   * plant gets no affordance at all.
   */
  expandable: boolean;
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

/**
 * The display string inside a circle: SoC for storage, |kW| otherwise. The PV
 * node prefers the COMPOSITION total, so the number in the circle is by
 * construction the sum of the rows behind the click.
 */
function vertexValue(role: Role, node: FlowNode, pvTotalKw: number | null | undefined): string {
  if (role === 'storage' && node.soc_pct != null) return fmtNum(node.soc_pct, '%', 0);
  const kw = role === 'pv' && pvTotalKw != null ? pvTotalKw : node.value_kw;
  if (kw == null) return '–';
  return fmtNum(Math.abs(kw), 'kW', 1);
}

/**
 * The line under the node name: the composition affordance where a role is made
 * of several devices, else the state in words (the concept's "lädt 8,2 kW" /
 * "Einspeisung"). null where it would say nothing.
 */
function subLabelFor(role: Role, node: FlowNode, memberCount: number): string | null {
  if (role === 'pv') return memberCount > 1 ? `${memberCount} Geräte` : null;
  if (!node.flow_active || node.value_kw == null) return null;
  const kw = fmtNum(Math.abs(node.value_kw), 'kW', 1);
  if (role === 'storage') return node.direction === 'out' ? `lädt ${kw}` : `entlädt ${kw}`;
  if (role === 'grid') return node.direction === 'in' ? 'Bezug' : 'Einspeisung';
  return null;
}

/**
 * Der Laden-Knoten (Konzept `vp-verbraucher-cockpit-k1` §6): Σ kW der ladenden
 * Stecker und ein Wort darunter. Phase-0-Quelle ist `/chargers` - derselbe
 * Zwischenweg wie der `sources`-Rückfall der PV, und er entfällt ersatzlos,
 * sobald die Box die Ladepunkt-Leistung als Entitäts-Telemetrie publiziert.
 */
export interface ChargingNodeOpts {
  /** Σ kW der wirklich ladenden Stecker; `null` = nicht gemessen (nie eine 0). */
  kw: number | null;
  /** Das Wort unter dem Namen („lädt" / „Auto eingesteckt" / „kein Auto"). */
  wort: string | null;
  /** true = es fliesst gerade wirklich (die Speiche animiert dann). */
  aktiv: boolean;
  /** Zahl der Ladepunkte - für den `title`. */
  count: number;
}

export interface LayoutOpts {
  narrow?: boolean;
  /**
   * The PV composition's total + device count (`pvComposition.ts`). Given, the
   * PV circle shows exactly the sum of the composition rows and offers the
   * click affordance from 2 devices on.
   */
  pvTotalKw?: number | null;
  pvDeviceCount?: number | null;
  /**
   * Der Wechselrichter hat den Fahrplan-Sollwert bestätigt (`controlStrip()`
   * state `healthy`) — der Speicher-Knoten bekommt dann den Haken
   * ({@link FlowVertex.confirmed}). Additiv: ohne das Flag ist die Geometrie
   * zeichengleich zu vorher.
   */
  controlConfirmed?: boolean;
  /**
   * Der fünfte Kreis „Laden". Fehlt er, ist das Diagramm ZEICHENGLEICH zu
   * vorher - eine Anlage ohne Ladepunkt bekommt keinen Knoten und keine
   * grössere viewBox.
   */
  charging?: ChargingNodeOpts | null;
}

/**
 * Build the flow layout from the topology read-model: ONE circle per role, on
 * its fixed side. An empty topology yields no vertices (the caller falls back
 * to the v1 flow).
 */
export function layoutFlow(
  topology: Topology,
  entities: TopologyEntity[],
  opts?: LayoutOpts,
): FlowLayout {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nodes = topology.nodes;

  const narrow = opts?.narrow === true;
  const leftInset = narrow ? N_LEFT_INSET : LEFT_INSET;
  const topInset = narrow ? N_TOP_INSET : TOP_INSET;

  // The label block sits BELOW each circle, so both the viewBox height and the
  // bottom row need room for it (LBL_DY + 2 lines) - G2. With one circle per
  // role the viewBox is now CONSTANT: 1 inverter and 6 draw the same diagram.
  const labelBlock = LBL_DY + LBL_TOTAL_LINES * LBL_LH;
  const W = Math.max(narrow ? N_MIN_W : MIN_W, 2 * (leftInset + NODE_R + (narrow ? 26 : 44)));
  const H = Math.max(narrow ? N_MIN_H : MIN_H, 2 * (topInset + NODE_R + labelBlock));
  // Mit Laden-Knoten wächst die viewBox um genau eine Zeile - die Geometrie
  // der vier Rollen-Kreise bleibt dabei unverändert (der Hub sitzt weiter in
  // der Mitte der URSPRÜNGLICHEN Höhe).
  const chargingH = H + CHARGING_DY;
  const hubX = W / 2;
  const hubY = H / 2;
  const leftX = leftInset;
  const rightX = W - leftInset;
  const topY = topInset;
  // Keep the bottom row's circle AND its label block inside the viewBox.
  const bottomY = H - NODE_R - labelBlock - 6;

  const vertices: FlowVertex[] = [];

  for (const node of nodes) {
    const side = ROLE_SIDE[node.role];
    const memberCount = node.members.length;
    if (memberCount === 0) continue;
    const reverse = reverseOf(node);

    let x: number;
    let y: number;
    if (side === 'top') {
      x = hubX;
      y = topY;
    } else if (side === 'bottom') {
      x = hubX;
      y = bottomY;
    } else if (side === 'left') {
      x = leftX;
      y = hubY;
    } else {
      x = rightX;
      y = hubY;
    }
    const label = ROLE_NODE_LABEL[node.role];
    const labelLines = wrapLabel(label);
    const devices = node.members.length;
    const count = node.role === 'pv' ? (opts?.pvDeviceCount ?? devices) : devices;
    const subLabel = subLabelFor(node.role, node, count);

    // V15: only a TOP node has its label block between circle and hub - trim
    // the spoke past the lines it ACTUALLY draws (not the reserved maximum) so
    // the animated dots never cross the caption and the spoke stays as long as
    // it honestly can.
    const drawnLines = labelLines.length + (subLabel ? 1 : 0);
    const clearFor = NODE_R + LBL_DY + drawnLines * LBL_LH;
    const dx = hubX - x;
    const dy = hubY - y;
    const len = Math.hypot(dx, dy) || 1;
    const clear = side === 'top' ? Math.min(clearFor, len - 4) : 0;
    const spokeX = x + (dx / len) * clear;
    const spokeY = y + (dy / len) * clear;
    // The devices behind the role, named by the ONE shared derivation - the
    // diagram itself no longer prints a device name anywhere.
    const names = node.members
      .map((m) => {
        const e = byId.get(m.entity_id);
        return (
          deviceName({ storedLabel: m.label, typeLabel: e?.typeLabel }) ??
          ROLE_META[node.role].label
        );
      })
      .filter((v, i, arr) => arr.indexOf(v) === i);
    // Keep the label block inside the viewBox: SVG text has no wrapping or
    // clipping of its own, so a long caption on an outer column would simply be
    // cut off at the edge on a narrow (phone) layout.
    const widest = Math.max(...labelLines.map((l) => l.length), subLabel?.length ?? 0, 1);
    const half = Math.min((widest * LBL_F * 0.55) / 2, W / 2);
    const labelX = Math.max(half, Math.min(W - half, x));
    const mag = node.value_kw ?? 0;
    // Der Haken hängt an der ZUSTANDSZEILE des Speichers: ohne „lädt …" gibt es
    // nichts, was bestätigt worden wäre.
    const confirmed = node.role === 'storage' && subLabel != null && opts?.controlConfirmed === true;
    vertices.push({
      key: node.role,
      role: node.role,
      x,
      y,
      label,
      labelLines,
      labelX,
      subLabel,
      title:
        (names.length > 0 ? `${label} · ${names.join(', ')}` : label) +
        (confirmed ? ' · Sollwert bestätigt' : ''),
      value: vertexValue(node.role, node, opts?.pvTotalKw),
      icon:
        memberCount === 1
          ? iconFor(byId.get(node.members[0].entity_id)?.entityType ?? '', node.role)
          : ROLE_META[node.role].icon,
      color: ROLE_META[node.role].color,
      soft: ROLE_META[node.role].soft,
      baseWidth: 6,
      spokeActive: node.flow_active,
      reverse,
      strokeWidth: strokeWidth(mag),
      spokeX,
      spokeY,
      memberCount: count,
      confirmed,
      expandable: node.role === 'pv' && count > 1,
    });
  }

  // --- Der fünfte Kreis „Laden" (Konzept §6, E3) -----------------------------
  // Er hängt am HAUS, nicht am Hub: die Haus-Summe bleibt „alles hinter dem
  // Anschluss", und der Abzweig sagt, wie viel davon ins Auto geht. Ein
  // eigener Anschluss wäre ein Knoten AM HUB - dafür fehlt in Phase 0 das
  // Flag (Konzept §8, C1), und ein geratener zweiter Anschluss wäre eine
  // Behauptung über den Zählerschrank des Kunden.
  const laden = opts?.charging;
  const haus = vertices.find((v) => v.role === 'consumer');
  if (laden && haus) {
    // Unter dem Haus-Knoten, auf seiner Seite. Die viewBox wächst dafür genau
    // um diese eine Zeile - ohne Ladepunkt ist sie zeichengleich zu vorher.
    const y = Math.min(haus.y + CHARGING_DY, chargingH - NODE_R - labelBlock - 6);
    const label = CHARGING_LABEL;
    const labelLines = wrapLabel(label);
    const widest = Math.max(...labelLines.map((l) => l.length), laden.wort?.length ?? 0, 1);
    const half = Math.min((widest * LBL_F * 0.55) / 2, W / 2);
    // ⚠ V15 noch einmal, hier senkrecht: der Beschriftungs-Block des HAUSES
    // liegt zwischen den beiden Kreisen, also endet der Abzweig UNTER ihm -
    // sonst liefen die Laufpunkte mitten durch das Wort „Hausverbrauch".
    // Gerechnet wird mit den WIRKLICH gezeichneten Zeilen; ein späterer
    // Haus-Zusatz verkürzt den Abzweig damit von selbst, statt ihn zu queren.
    const hausLines = haus.labelLines.length + (haus.subLabel ? 1 : 0);
    const toY = Math.min(haus.y + NODE_R + LBL_DY + hausLines * LBL_LH, y - NODE_R - 2);
    vertices.push({
      key: 'charging',
      role: 'charging',
      x: haus.x,
      y,
      label,
      labelLines,
      labelX: Math.max(half, Math.min(W - half, haus.x)),
      subLabel: laden.wort,
      title: `${label} · ${laden.count} ${laden.count === 1 ? 'Ladepunkt' : 'Ladepunkte'}`,
      value: laden.kw == null ? '–' : fmtNum(Math.abs(laden.kw), 'kW', 1),
      icon: 'battery-charging',
      color: CHARGING_COLOR,
      soft: CHARGING_SOFT,
      baseWidth: CHARGING_BASE_W,
      spokeActive: laden.aktiv,
      // Verbrauch: die Bewegung läuft VOM Haus zum Auto.
      reverse: true,
      strokeWidth: Math.max(2, strokeWidth(laden.kw ?? 0) - 1),
      spokeX: haus.x,
      spokeY: y,
      // ⚠ Der Abzweig endet am HAUS, nicht am Hub (E3): die Haus-Summe bleibt
      // „alles hinter dem Anschluss", und der Abzweig sagt, wie viel davon ins
      // Auto geht. Ein eigener Anschluss wäre ein Knoten AM HUB - dafür fehlt
      // in Phase 0 das Flag (Konzept §8, C1), und ein geratener zweiter
      // Anschluss wäre eine Behauptung über den Zählerschrank des Kunden.
      toX: haus.x,
      toY,
      memberCount: laden.count,
      confirmed: false,
      // Kein Klick am Laden-Knoten: die Zusammensetzung wohnt in der Kachel
      // bzw. der Board-Zeile - ein zweites Klickziel im Fluss wäre die
      // Doppelung, die A1 gerade beseitigt hat (Konzept §6).
      expandable: false,
    });
  }

  return {
    W,
    H: laden && haus ? chargingH : H,
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
