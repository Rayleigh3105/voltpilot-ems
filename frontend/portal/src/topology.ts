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

/**
 * Die BMS-Grenzen und -Freigaben des Speicher-Knotens (P6 Speiser-Bindung).
 * Wie `soc_pct` sind sie EIGENSCHAFTEN des Speichers, nie Fluss-Mitglieder:
 * ein Ampere und ein Ja/Nein sind keine Kilowatt, und sie in `value_kw` zu
 * summieren machte aus der Speichen-Breite eine Zahl mit zwei Bedeutungen.
 */
const CHARGE_LIMIT_CHANNEL = 'charge_limit_a';
const DISCHARGE_LIMIT_CHANNEL = 'discharge_limit_a';
const CHARGE_ALLOWED_CHANNEL = 'charge_allowed';
const DISCHARGE_ALLOWED_CHANNEL = 'discharge_allowed';

/** Speist dieser Kanal eine EIGENSCHAFT des Speicher-Knotens statt seines Flusses? */
function isStorageAttribute(channel: string): boolean {
  return (
    channel === SOC_CHANNEL
    || channel === CHARGE_LIMIT_CHANNEL
    || channel === DISCHARGE_LIMIT_CHANNEL
    || channel === CHARGE_ALLOWED_CHANNEL
    || channel === DISCHARGE_ALLOWED_CHANNEL
  );
}

/** Gehört dieser Kanal in den `limits`-Block? */
function isLimitChannel(channel: string): boolean {
  return isStorageAttribute(channel) && channel !== SOC_CHANNEL;
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
 * Die SELBST ANGEBUNDENE Batterie des Kunden (P5, Konzept
 * `vp-deye-diybms-luecke-l5` §3.2b): ein DIYBMS/Seplos/JK/ESP, per MQTT
 * gelesen und Feld für Feld auf die Standard-Batteriekanäle abgebildet.
 *
 * ⚠ Sie ist Kategorie `storage` - ohne diesen Eintrag liefen ihr `soc_pct` und
 * ihr `power_kw` VON SELBST in den Speicher-Knoten, also genau die automatische
 * Bindung, die der Captain-Entscheid E6 ausschließt („nie eine
 * Namens-Heuristik"). In den Speicher-Knoten kommt sie ausschließlich über die
 * AUSDRÜCKLICHE Speiser-Bindung (P6), die als Rollen-Zuordnung gespeichert wird.
 */
export const USER_DEFINED_BATTERY_TYPE = 'user-defined-battery';

/**
 * Ist dieser Entitäts-TYP selbst gebaut? An der Kategorie ist es - wie beim
 * Ladepunkt - nicht zu erkennen: ein `modbus-generic` ist `meter` (er
 * deklariert keine Schreib-Fähigkeit) und ein `modbus-load` ist `consumer`,
 * also genau wie ein Netz-Zähler bzw. ein Heizstab. Deshalb muss der TYP
 * antworten.
 */
export function isSelfBuiltType(entityType: string): boolean {
  return (
    entityType === MODBUS_GENERIC_TYPE
    || entityType === MODBUS_LOAD_TYPE
    || entityType === USER_DEFINED_BATTERY_TYPE
  );
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
}

export interface Input {
  entities: EntityInput[];
}

export interface FlowMember {
  entity_id: string;
  label: string;
  primary: boolean;
  value_kw?: number;
}

/**
 * WOHER eine EIGENSCHAFT eines Knotens kommt. Es gibt sie, weil eine
 * Eigenschaft des Speicher-Knotens nicht vom Gerät stammen muss, dessen
 * Kilowatt der Knoten führt: die Speiser-Bindung (P6) lässt die eigene Batterie
 * des Kunden den Ladestand liefern, während der Hybrid-Wechselrichter die
 * Leistung weiter misst. Ohne sie stünde dort eine Prozentzahl, zu der niemand
 * sagen könnte, wessen sie ist - und „Ladestand von: <Batterie>" ist genau der
 * Satz, den die Bindung dem Kunden schuldet.
 */
export interface NodeSource {
  entity_id: string;
  label: string;
}

/**
 * Was das BMS des Speicher-Knotens gerade zulässt (P6). Jedes Feld ist
 * optional - ein nicht zugeordneter oder schweigender Kanal ist ABWESEND, nie
 * eine erfundene 0 (die an einer Grenze „Laden verboten" hieße) und nie ein
 * erfundenes „ja".
 *
 * Alle vier kommen aus EINER Entität (`source`): eine Ladegrenze des einen BMS
 * neben der Entladegrenze eines anderen wäre ein Block mit zwei Bedeutungen.
 */
export interface NodeLimits {
  source: NodeSource;
  charge_limit_a?: number;
  discharge_limit_a?: number;
  charge_allowed?: boolean;
  discharge_allowed?: boolean;
}

export interface FlowNode {
  role: Role;
  value_kw?: number;
  soc_pct?: number;
  /** WELCHE Entität den Ladestand geliefert hat (P6). */
  soc_source?: NodeSource;
  /** Die BMS-Hülle des Speicher-Knotens (P6); nur am Speicher, nur wenn gemeldet. */
  limits?: NodeLimits;
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
  // value_kw) so JSON.stringify is byte-identical across the two twins.
  const m: FlowMember = { entity_id: rc.entity.id, label: rc.entity.label, primary: rc.cap.primary };
  if (rc.cap.value != null) m.value_kw = round3(rc.cap.value);
  return m;
}

/**
 * Assemble a FlowNode inserting keys in the canonical order (role, value_kw,
 * soc_pct, soc_source, limits, flow_active, direction, members) that Go's
 * json.Marshal emits, so JSON.stringify(node) is byte-identical to the Go twin.
 */
function makeNode(
  role: Role,
  valueKw: number | undefined,
  socPct: number | undefined,
  socSource: NodeSource | undefined,
  limits: NodeLimits | undefined,
  flowActive: boolean,
  direction: 'in' | 'out' | undefined,
  members: FlowMember[],
): FlowNode {
  const n = { role } as FlowNode;
  if (valueKw !== undefined) n.value_kw = valueKw;
  if (socPct !== undefined) n.soc_pct = socPct;
  if (socSource !== undefined) n.soc_source = socSource;
  if (limits !== undefined) n.limits = limits;
  n.flow_active = flowActive;
  if (direction) n.direction = direction;
  n.members = members;
  return n;
}

/**
 * Die BMS-Hülle des Speicher-Knotens aus den Grenz-Kanälen EINER Entität: der
 * maßgeblichen, wenn eine so markiert ist, sonst der ersten, die einen Wert
 * trägt. Zwei BMS, deren Kappen sich zu einem Block mischen, beschrieben eine
 * Hülle, die keines von beiden hat.
 *
 * `undefined`, wenn niemand eine Grenze meldet - die ehrliche Antwort für jede
 * Anlage, deren Batterie über einen Katalog-Treiber gelesen wird: die meldet
 * keinen dieser Kanäle.
 */
function limitsOf(caps: RoleCap[]): NodeLimits | undefined {
  let owner = '';
  let label = '';
  let ownerPrimary = false;
  for (const rc of caps) {
    if (!isLimitChannel(rc.cap.channel) || rc.cap.value == null) continue;
    if (owner === '' || (rc.cap.primary && !ownerPrimary)) {
      owner = rc.entity.id;
      label = rc.entity.label;
      ownerPrimary = rc.cap.primary;
    }
  }
  if (owner === '') return undefined;
  const out: NodeLimits = { source: { entity_id: owner, label } };
  for (const rc of caps) {
    if (rc.entity.id !== owner || rc.cap.value == null) continue;
    switch (rc.cap.channel) {
      case CHARGE_LIMIT_CHANNEL:
        out.charge_limit_a = round3(rc.cap.value);
        break;
      case DISCHARGE_LIMIT_CHANNEL:
        out.discharge_limit_a = round3(rc.cap.value);
        break;
      case CHARGE_ALLOWED_CHANNEL:
        // Eine Freigabe reist als ZAHL durch die Telemetrie (der v2-Kanal-
        // Vertrag kennt nur Zahlen); alles außer 0 heißt „ja".
        out.charge_allowed = rc.cap.value !== 0;
        break;
      case DISCHARGE_ALLOWED_CHANNEL:
        out.discharge_allowed = rc.cap.value !== 0;
        break;
      default:
        break;
    }
  }
  return out;
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
    return makeNode(role, undefined, undefined, undefined, undefined, false, undefined, members);
  }
  const mag = round3(Math.abs(sum));
  const active = mag > DEADBAND_KW;
  const dir = active ? (isConsuming(role) ? 'out' : 'in') : undefined;
  return makeNode(role, mag, undefined, undefined, undefined, active, dir, members);
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
    if (isLimitChannel(rc.cap.channel)) continue;
    members.push(member(rc));
    if (rc.cap.value != null) {
      sum += rc.cap.value;
      hasValue = true;
    }
  }
  const limits = limitsOf(caps);
  if (!hasValue) {
    return makeNode(role, undefined, soc, socSource, limits, false, undefined, members);
  }
  const mag = round3(Math.abs(sum));
  const active = mag > DEADBAND_KW;
  // charge (+) -> hub->battery (out), discharge (-) -> battery->hub (in).
  const dir = active ? (sum > 0 ? 'out' : 'in') : undefined;
  return makeNode(role, mag, soc, socSource, limits, active, dir, members);
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
    return makeNode(role, undefined, undefined, undefined, undefined, false, undefined, members);
  }
  const v = caps[primaryIdx].cap.value;
  if (v == null) {
    return makeNode(role, undefined, undefined, undefined, undefined, false, undefined, members);
  }
  const mag = round3(Math.abs(v));
  const active = mag > DEADBAND_KW;
  // import (Bezug, +) -> in, export (-) -> out.
  const dir = active ? (v > 0 ? 'in' : 'out') : undefined;
  return makeNode(role, mag, undefined, undefined, undefined, active, dir, members);
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
    else nodes.push(sumNode(role, caps));
  }
  return { schema_version: SCHEMA_VERSION, nodes };
}
