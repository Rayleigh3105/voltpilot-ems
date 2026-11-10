/**
 * Shared derivation of the Anlagen-Topologie-Read-Model (AE1, contract
 * docs/contracts/v2/topology-read-model.md): the ONE pure function that turns
 * {resolved capabilities + live values} into the role-grouped hub topology the
 * adaptive energy-flow diagram (AE2) renders. This TS twin MUST stay
 * byte-identical to the Go copy (edge-app/core/internal/topology) on the shared
 * vectors (docs/contracts/v2/topology-vectors.json - the jcs-vectors
 * precedent), so the portal and the edge draw the identical picture. The portal
 * feeds this the cloud read-model's already-resolved entities + live values.
 */

/** Below this magnitude a spoke counts as idle (the live.ts 0.05 kW deadband). */
export const DEADBAND_KW = 0.05;

export const SCHEMA_VERSION = '1.0';

/**
 * Die Rollen. `charging` sind Ladepunkte HINTER dem Hausanschluss - ihre
 * Kilowatt stecken schon in der gemessenen Hauslast, der Knoten ist deshalb ein
 * ABZWEIG vom Haus und die Haus-Summe bleibt „alles hinter dem Anschluss"
 * (Konzept `vp-verbraucher-cockpit-k1` §6, E3). `charging-own` sind Säulen an
 * einem EIGENEN Netzanschluss: sie stecken NICHT in dieser Messung, hängen also
 * am Hub NEBEN dem Haus, und das Haus enthält sie nie.
 *
 * ⚠ Zwei Rollen, nicht EIN Knoten mit zwei Aufhängungen: die beiden Summen
 * werden an ZWEI VERSCHIEDENEN Anschlusspunkten gemessen, sie zu addieren wäre
 * eine Zahl mit zwei Bedeutungen.
 */
export type Role = 'pv' | 'storage' | 'consumer' | 'grid' | 'charging' | 'charging-own';

/**
 * Canonical node emission order. Die Lade-Rollen sind bewusst ANGEHÄNGT: jeder
 * vor ihnen geschriebene Vektor bleibt damit byte-gleich, weil eine Anlage ohne
 * Ladepunkt keinen der beiden Knoten ausgibt.
 */
const CANONICAL_ROLE_ORDER: Role[] = [
  'pv',
  'storage',
  'consumer',
  'grid',
  'charging',
  'charging-own',
];

/** The one channel treated as a SoC input (never a flow member). */
const SOC_CHANNEL = 'soc_pct';

/** Speist dieser Kanal eine EIGENSCHAFT des Speicher-Knotens statt seines Flusses? */
function isStorageAttribute(channel: string): boolean {
  return channel === SOC_CHANNEL;
}

/** Die Entitäts-TYPEN, die Ladepunkte sind. */
export const EV_CHARGER_TYPE = 'ev-charger';
export const WALLBOX_TYPE = 'wallbox';

/**
 * WO eine Säule hängt (Cockpit Phase 1 / C1): hinter dem Hausanschluss oder an
 * einem eigenen. `''` = nicht gesagt - gelesen als `haus`, die sichere
 * Richtung: die Hausmessung enthält sie dann, genau was das Budget-Gesetz der
 * Box ohnehin annimmt.
 */
export const CONNECTION_HAUS = 'haus';
export const CONNECTION_EIGEN = 'eigen';

/**
 * Ist dieser Entitäts-TYP ein Ladepunkt? An der Kategorie ist es nicht zu
 * erkennen: `ev-charger` und `wallbox` sind im Typkatalog beide `consumer` -
 * genau wie ein Heizstab.
 */
export function isChargingType(entityType: string): boolean {
  return entityType === EV_CHARGER_TYPE || entityType === WALLBOX_TYPE;
}

/**
 * Die Entitäts-TYPEN, die der Kunde SELBST angelegt hat (Einheitsmodell
 * Stufe 3/4, `vp-modbus-baukasten-k6`): ein freier Modbus-Sensor und - nach
 * bestandenem Schalt-Test - ein freies Modbus-Schaltgerät. Ihre Messkanäle
 * benennt der KUNDE, nicht ein Treiber, den wir geschrieben haben.
 */
export const MODBUS_GENERIC_TYPE = 'modbus-generic';
export const MODBUS_LOAD_TYPE = 'modbus-load';

/**
 * Die komponierte Haus-Last (v1→v2-Rückfüllung): Bezug + Erzeugung − Einspeisung
 * ± Speicher, „alles hinter dem Netzanschluss". Jeder andere Verbraucher-Posten
 * (ein Unterzähler, ein Heizstab) steckt physikalisch schon in diesem Wert - der
 * Knotenwert des Verbraucher-Knotens ist deshalb DIESER eine Posten, nie die
 * Summe aller (Zählerbaum-Konzept N3/R1, docs/contracts/v2/zaehlerbaum.md §3).
 */
export const HOUSE_LOAD_TYPE = 'house-load';

/**
 * Ist dieser Entitäts-TYP selbst gebaut? An der Kategorie ist es - wie beim
 * Ladepunkt - nicht zu erkennen: ein `modbus-generic` ist `meter` (er
 * deklariert keine Schreib-Fähigkeit) und ein `modbus-load` ist `consumer`,
 * also genau wie ein Netz-Zähler bzw. ein Heizstab. Deshalb muss der TYP
 * antworten.
 */
export function isSelfBuiltType(entityType: string): boolean {
  return entityType === MODBUS_GENERIC_TYPE || entityType === MODBUS_LOAD_TYPE;
}

export interface CapabilityInput {
  channel: string;
  /** Resolved role; '' = unassigned/informational (skipped). */
  role: string;
  primary: boolean;
  /** Latest live value; null = unknown (never a fabricated 0). */
  value: number | null;
}

export interface EntityInput {
  id: string;
  type: string;
  label: string;
  category: string;
  health: string;
  capabilities: CapabilityInput[];
  /**
   * Die Zählerbaum-Eltern-Entität (`haengt_an`, Konzept
   * vp-zaehlerbaum-konzept) - fehlend/`undefined` = an der Wurzel (dem
   * Netzanschluss), die Vorgabe für jede Bestandsanlage am ersten Tag.
   */
  parent_entity_id?: string;
}

export interface Input {
  entities: EntityInput[];
}

export interface FlowMember {
  entity_id: string;
  label: string;
  primary: boolean;
  value_kw?: number;
  haengt_an?: string;
}

/**
 * WOHER eine EIGENSCHAFT eines Knotens kommt. Ohne sie stünde im Speicher-Knoten
 * eine Prozentzahl, zu der niemand sagen könnte, wessen sie ist - auch wenn der
 * Ladestand von einem anderen Kandidaten stammt als die Kilowatt.
 */
export interface NodeSource {
  entity_id: string;
  label: string;
}

export interface FlowNode {
  role: Role;
  value_kw?: number;
  soc_pct?: number;
  /** WELCHE Entität den Ladestand geliefert hat. */
  soc_source?: NodeSource;
  flow_active: boolean;
  direction?: 'in' | 'out';
  members: FlowMember[];
}

export interface Topology {
  schema_version: string;
  nodes: FlowNode[];
}

/**
 * Default role for an entity TYPE + category + measure channel + charge-point
 * connection (overridable in the cloud; the edge/pilot run on defaults).
 * category is storage|producer|meter|consumer; the edge's "measure-only"
 * aliases "meter". connection is only consulted for charge points ('' = haus).
 *
 * ⚠ DER TYP WIRD ZUERST GEPRÜFT, und genau dafür gibt es den Parameter: ein
 * Ladepunkt ist Kategorie `consumer`, seine Leistung summierte sich ohne ihn
 * also in den Haus-Knoten, in dem sie schon gemessen ist - und sein `soc_pct`
 * fiele in die Speicher-Regel darunter und begänne, den Ladestand der
 * HAUSBATTERIE zu füllen (der Grund, aus dem die Box ihn nie publiziert). Beides
 * wäre eine falsche Aussage über eine Kundenanlage.
 */
export function defaultRole(
  entityType: string,
  category: string,
  channel: string,
  connection: string,
): string {
  // ⚠ Ein SELBST GEBAUTES Gerät bekommt NIE eine Energiefluss-Rolle - auch
  // nicht für einen Kanal, den es zufällig `power_kw` genannt hat. Zwei
  // unabhängige Gründe, und der erste ist eine Zusage, die die Plattform dem
  // Kunden schon gedruckt hat:
  //
  //  1. Bilanz-Ehrlichkeit (Einheitsmodell Stufe 3): „ein Selbstbau-Sensor ist
  //     ein Topologie-Knoten mit eigenen Messwerten und geht NICHT in die
  //     Energiebilanz ein" - genau das sagt der Assistent beim Anlegen.
  //  2. Ohne diesen Zweig entschied die KATEGORIE, und ein `modbus-generic`
  //     ist `meter` - ein Kanal namens `power_kw` fiel also in die
  //     Zähler-Regel und der Zisternen-/Wärmepumpen-Sensor des Kunden wurde
  //     ALS NETZANSCHLUSSPUNKT gerendert (Scout `vp-portal-box-spiegel-s2`,
  //     L5). Der Netz-Knoten darf ausschließlich aus einem echten Netz-Zähler
  //     entstehen. Ein `modbus-load` ist `consumer` und würde in den
  //     Haus-Knoten doppelt zählen, in dem er schon gemessen ist - dasselbe
  //     Argument, das die Ladepunkte aus der Verbraucher-Rolle geholt hat.
  //
  // Die Kanäle gehen dabei nicht verloren: sie behalten ihre eigenen
  // Messwerte/Verläufe. Nur die BILANZ bleibt unberührt.
  //
  // ⚠ Das ist die VORGABE; eine ausdrücklich gespeicherte Zuordnung schlägt sie
  // weiterhin (Befund L4) - bewusst: die Überschreibung gibt es für genau den
  // Fall „die Vorgabe der Plattform passt für MEINE Anlage nicht", und wer das
  // sagt, rät nicht. L5 handelte davon, dass die VORGABE eine Falschaussage war.
  if (isSelfBuiltType(entityType)) {
    return '';
  }
  if (isChargingType(entityType)) {
    switch (channel) {
      case 'power_kw':
        return connection === CONNECTION_EIGEN ? 'charging-own' : 'charging';
      case SOC_CHANNEL:
        // Der Ladestand des AUTOS - nie der der Säule und nie der der
        // Hausbatterie. Weder Fluss-Mitglied noch SoC eines anderen Knotens.
        return '';
      default:
        return '';
    }
  }
  switch (channel) {
    case 'pv_power_kw':
      return 'pv';
    case 'battery_power_kw':
    case SOC_CHANNEL:
      return 'storage';
    case 'power_kw':
      switch (category) {
        case 'storage':
          return 'storage';
        case 'producer':
          return 'pv';
        case 'consumer':
          return 'consumer';
        case 'meter':
        case 'measure-only':
          return 'grid';
      }
  }
  return '';
}

/** Zieht diese summierte Rolle VOM Hub (Richtung „out")? Haus und beide Lade-Rollen. */
function isConsuming(role: Role): boolean {
  return role === 'consumer' || role === 'charging' || role === 'charging-own';
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

interface RoleCap {
  entity: EntityInput;
  cap: CapabilityInput;
}

function member(rc: RoleCap): FlowMember {
  // Key order matches the Go FlowMember struct (entity_id, label, primary,
  // value_kw, haengt_an) so JSON.stringify is byte-identical across the two
  // twins.
  const m: FlowMember = { entity_id: rc.entity.id, label: rc.entity.label, primary: rc.cap.primary };
  if (rc.cap.value != null) m.value_kw = round3(rc.cap.value);
  if (rc.entity.parent_entity_id != null) m.haengt_an = rc.entity.parent_entity_id;
  return m;
}

/**
 * Assemble a FlowNode inserting keys in the canonical order (role, value_kw,
 * soc_pct, soc_source, flow_active, direction, members) that Go's
 * json.Marshal emits, so JSON.stringify(node) is byte-identical to the Go twin.
 */
function makeNode(
  role: Role,
  valueKw: number | undefined,
  socPct: number | undefined,
  socSource: NodeSource | undefined,
  flowActive: boolean,
  direction: 'in' | 'out' | undefined,
  members: FlowMember[],
): FlowNode {
  const n = { role } as FlowNode;
  if (valueKw !== undefined) n.value_kw = valueKw;
  if (socPct !== undefined) n.soc_pct = socPct;
  if (socSource !== undefined) n.soc_source = socSource;
  n.flow_active = flowActive;
  if (direction) n.direction = direction;
  n.members = members;
  return n;
}

/** pv / consumer: value = |Σ flow members|, direction fixed by role. */
function sumNode(role: Role, caps: RoleCap[]): FlowNode {
  const members: FlowMember[] = [];
  let sum = 0;
  let hasValue = false;
  for (const rc of caps) {
    if (isStorageAttribute(rc.cap.channel)) continue;
    members.push(member(rc));
    if (rc.cap.value != null) {
      sum += rc.cap.value;
      hasValue = true;
    }
  }
  if (!hasValue) {
    return makeNode(role, undefined, undefined, undefined, false, undefined, members);
  }
  const mag = round3(Math.abs(sum));
  const active = mag > DEADBAND_KW;
  const dir = active ? (isConsuming(role) ? 'out' : 'in') : undefined;
  return makeNode(role, mag, undefined, undefined, active, dir, members);
}

/**
 * Der Verbraucher-Knoten (Zählerbaum-Konzept N3/R1): ist eine komponierte
 * Haus-Last ({@link HOUSE_LOAD_TYPE}) unter den Mitgliedern, ist IHR Wert der
 * Knotenwert - jedes andere Mitglied (ein Unterzähler, ein Heizstab) steckt
 * schon in diesem einen Wert, eine Summe über alle zählte doppelt. Ohne eine
 * solche Haus-Last (ältere/synthetische Eingaben) bleibt die Summe aller
 * Mitglieder wie bisher ({@link sumNode}) - byte-identisch zu jedem Fall ohne
 * Haus-Mitglied.
 */
function consumerNode(role: Role, caps: RoleCap[]): FlowNode {
  const haus = caps.find((rc) => rc.entity.type === HOUSE_LOAD_TYPE);
  if (!haus) return sumNode(role, caps);
  const members = caps.map((rc) => member(rc));
  const v = haus.cap.value;
  if (v == null) {
    return makeNode(role, undefined, undefined, undefined, false, undefined, members);
  }
  const mag = round3(Math.abs(v));
  const active = mag > DEADBAND_KW;
  const dir = active ? 'out' : undefined;
  return makeNode(role, mag, undefined, undefined, active, dir, members);
}

/** storage: Σ measured battery power + SoC from the primary (else first). */
function storageNode(role: Role, caps: RoleCap[]): FlowNode {
  const members: FlowMember[] = [];
  let sum = 0;
  let hasValue = false;
  let soc: number | undefined;
  let socSource: NodeSource | undefined;
  let socPrimary = false;
  for (const rc of caps) {
    if (rc.cap.channel === SOC_CHANNEL) {
      if (rc.cap.value == null) continue;
      if (soc === undefined || (rc.cap.primary && !socPrimary)) {
        soc = round3(rc.cap.value);
        socSource = { entity_id: rc.entity.id, label: rc.entity.label };
        socPrimary = rc.cap.primary;
      }
      continue;
    }
    members.push(member(rc));
    if (rc.cap.value != null) {
      sum += rc.cap.value;
      hasValue = true;
    }
  }
  if (!hasValue) {
    return makeNode(role, undefined, soc, socSource, false, undefined, members);
  }
  const mag = round3(Math.abs(sum));
  const active = mag > DEADBAND_KW;
  // charge (+) -> hub->battery (out), discharge (-) -> battery->hub (in).
  const dir = active ? (sum > 0 ? 'out' : 'in') : undefined;
  return makeNode(role, mag, soc, socSource, active, dir, members);
}

/** grid: the maßgebliche (primary, else first) member's SIGNED value, never a sum. */
function gridNode(role: Role, caps: RoleCap[]): FlowNode {
  const members: FlowMember[] = [];
  let primaryIdx = -1;
  caps.forEach((rc, i) => {
    members.push(member(rc));
    if (primaryIdx === -1 && rc.cap.primary) primaryIdx = i;
  });
  if (primaryIdx === -1 && caps.length > 0) primaryIdx = 0;
  if (primaryIdx === -1) {
    return makeNode(role, undefined, undefined, undefined, false, undefined, members);
  }
  const v = caps[primaryIdx].cap.value;
  if (v == null) {
    return makeNode(role, undefined, undefined, undefined, false, undefined, members);
  }
  const mag = round3(Math.abs(v));
  const active = mag > DEADBAND_KW;
  // import (Bezug, +) -> in, export (-) -> out.
  const dir = active ? (v > 0 ? 'in' : 'out') : undefined;
  return makeNode(role, mag, undefined, undefined, active, dir, members);
}

/**
 * Derive the hub topology. Pure + deterministic: roles in canonical order,
 * members in input order, kW rounded to 3 decimals, absent values never
 * coerced to 0. See topology-read-model.md.
 */
export function derive(input: Input): Topology {
  const buckets = new Map<string, RoleCap[]>();
  for (const entity of input.entities) {
    for (const cap of entity.capabilities) {
      if (cap.role === '') continue;
      const list = buckets.get(cap.role);
      if (list) list.push({ entity, cap });
      else buckets.set(cap.role, [{ entity, cap }]);
    }
  }
  const nodes: FlowNode[] = [];
  for (const role of CANONICAL_ROLE_ORDER) {
    const caps = buckets.get(role);
    if (!caps) continue;
    if (role === 'grid') nodes.push(gridNode(role, caps));
    else if (role === 'storage') nodes.push(storageNode(role, caps));
    else if (role === 'consumer') nodes.push(consumerNode(role, caps));
    else nodes.push(sumNode(role, caps));
  }
  return { schema_version: SCHEMA_VERSION, nodes };
}
