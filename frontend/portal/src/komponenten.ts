/**
 * Portal v3 · M6 — the pure derivation behind the Anlagen-Modell.
 *
 * Since the approved UX rework (`data/vp-anlagenmodell-ux-w7`, **Variante A**,
 * Captain-Go 2026-07-29) the page is no longer three columns of abstraction. It
 * answers ONE question — „Kennt VoltPilot meine Anlage richtig, und woher kommt
 * jede Zahl?" — in this order:
 *
 *   1. ein Kopfsatz (Zustand in einem Satz),
 *   2. die EINE VoltPilot-Box als Vermittler, darunter die Geräte, die ihr die
 *      Messwerte liefern,
 *   3. die Komponenten in Rollen-Gruppen, **mit Live-Werten und Herkunft**,
 *   4. eine Fußzeile (Schutz-Satz + wo die Komponenten wieder auftauchen).
 *
 * Die frühere dritte Spalte („Ihre Anlage" = fünf Karten Erklärprosa) ist
 * ersatzlos aufgelöst: ihr Inhalt steckt jetzt im Kopfsatz (Zustand), im
 * Steuer-Abzeichen (Rechte) und in der Fußzeile (Verweise).
 *
 * **Captain-Korrektur (verbindlich):** eine Anlage hat genau EINE VoltPilot-Box.
 * Deye-Hybrid und die zwei Fronius sind Geräte DAHINTER, die ihr Messwerte
 * liefern - die Seite darf nie so aussehen, als gäbe es mehrere Boxen. Deshalb
 * trägt {@link edgeBoxLine} die Box als Vermittler-Zeile über der Geräte-Leiste,
 * und die Geräte hängen sichtbar an ihr.
 *
 * The customer dictionary is locked (D3): **Gerät / Komponente / Messwert**.
 * The words Entität · Messpunkt · Quelle · Mess-Einheit · Kanal never appear in
 * anything this module produces (they stay in the installer/admin panels). The
 * `komponenten.test.ts` vocabulary guard greps every produced label for them,
 * and no device name may be a raw-token join (kein „ · "-Kette, kein snake_case
 * - vp-vier-erzeuger-p9 / PR #269).
 *
 * Pure + framework-free (the `rollen.ts` / `topology.ts` precedent): components
 * only render what this decides. It REUSES `rollen.ts`
 * (`adoptableSources` / `suggestEntityType`), `entityLabel.ts` (`deviceName` -
 * die EINE Namenskette) und `pvReconcile.ts` (`reconcileProducerPv` - die EINE
 * PV-Aufteilung, die auch der Energiefluss benutzt). There is no second role,
 * name or value derivation.
 *
 * KEY facts of the current backend that shape the mapping:
 * - A Komponente = one v2 entity - PLUS the PV **aspect** of a hybrid inverter:
 *   the composed backfill mints no separate producer for the inverter's own
 *   modules, so without that aspect row a plain single-inverter plant would
 *   render NO PV at all and a multi-inverter plant's Σ would silently miss the
 *   hybrid's share (see {@link PlantComponent.aspect}).
 * - A Gerät = a physical box the edge REPORTS (`localSetup`), NOT the single
 *   `device` uuid every entity is bound to. That uuid is the VoltPilot-Box.
 * - Gerät↔Komponente is matched by PIN (`edgeSourceId` / `adoptedEntityId`,
 *   PR #272), never by order or by name. Since `vp-pin-werte-f8` that holds for
 *   the LIVE VALUES too: `reconcileProducerPv` fills a producer only from the
 *   source its own pin names.
 * - A component whose pin is PROVEN orphaned (`orphanedPin === true`) never
 *   carries a current value - its state is „nicht mehr verbunden", so a value
 *   would contradict its own row (the captain's Pilsting proof: the orphan
 *   showed 20,1 kW while the correctly pinned ghost showed "–").
 * - The "—" discipline is law: an unknown value stays absent, never a
 *   fabricated 0, and a component without a device link still renders.
 */
import type {
  Device,
  EntityLocalSetup,
  SiteEntity,
  SiteSource,
  SiteTopology,
  TopologyEntity,
} from './api';
import { deviceLiveStatus } from './api';
import { channelLabel } from './channels';
import { deviceName } from './entityLabel';
import { fmtNum } from './format';
import { reconcileProducerPv } from './pvReconcile';
import { adoptableSources, suggestEntityType, type AdoptableSource } from './rollen';

/** The customer-facing component role buckets. */
export type ComponentRole = 'pv' | 'storage' | 'grid' | 'house' | 'consumer';

/** Canonical group order on the page (the energy-flow reading order). */
export const COMPONENT_ROLE_ORDER: ComponentRole[] = [
  'pv',
  'storage',
  'grid',
  'house',
  'consumer',
];

/**
 * Live health of a device / component. `ok` / `stale` / `never` are the v2
 * entity states; **`unknown` is the H2 fix**: before it, `toHealth(undefined)`
 * returned `ok`, so on deploy day — when NO edge sends the E1b heartbeat and
 * `observed` is null for every component — every device reported a green
 * „verbunden" while the cockpit on the same plant said „Ihr Gerät meldet sich
 * nicht". A green dot on a dead device is worse than no dot, so an absent
 * report is now its own honest, grey state ("noch keine Rückmeldung").
 */
export type ComponentHealth = 'ok' | 'stale' | 'never' | 'unknown';

/** German role labels — the customer names for the roles. */
export const COMPONENT_ROLE_LABELS: Record<ComponentRole, string> = {
  pv: 'PV-Erzeugung',
  storage: 'Speicher',
  grid: 'Netzanschluss',
  house: 'Haus',
  consumer: 'Verbraucher',
};

/** Design-system Icon name per role (never emoji; the portfolio.ts precedent). */
export const COMPONENT_ROLE_ICONS: Record<ComponentRole, string> = {
  pv: 'sun',
  storage: 'battery',
  grid: 'activity',
  house: 'home',
  consumer: 'zap',
};

/** Below this magnitude a reading counts as idle (the live.ts 0.05 kW deadband). */
const DEADBAND_KW = 0.05;

/** One measured value a device knows about a component (the "Messwert" word). */
export interface Messwert {
  /** Plain-German label ("PV-Leistung", "Ladestand", …). */
  label: string;
  /** The raw channel identifier — kept only as a support/debug title. */
  raw: string;
}

/**
 * One live reading rendered on a component row.
 *
 * The magnitude is ALWAYS positive: a sign never reaches the customer, the
 * direction is a WORD (`caption`) — the portal-wide `live.ts` convention. The
 * concept mockup wrote „− 30,0 kW / Einspeisung"; the product rule wins, so we
 * render „30,0 kW / Einspeisung".
 */
export interface LiveReading {
  value: number;
  unit: 'kW' | '%';
  /** The direction/meaning word under the number, or null. */
  caption: string | null;
}

/** Which part of an entity a component represents. */
export type ComponentAspect = 'main' | 'pv';

/** One Komponente: the role the plant is thought in. */
export interface PlantComponent {
  /** Unique row id (`entityId`, or `entityId#pv` for a hybrid's own modules). */
  id: string;
  /** The v2 entity this row is derived from. */
  entityId: string;
  /** 'main' = the entity itself; 'pv' = the PV aspect of a hybrid inverter. */
  aspect: ComponentAspect;
  /** Customer-facing name (its own label, else a role/type default). */
  label: string;
  /**
   * The customer's OWN name for this component (the alias), or null when they
   * have not given one. Distinct from {@link label}, which already falls back
   * to the derivation - the rename dialog needs to tell "no name yet" from
   * "named exactly like the default" (concept `vp-entity-alias-k1`).
   */
  alias: string | null;
  /**
   * What this row is called WITHOUT an alias. The dialog shows it as the
   * placeholder (so the fallback is visible BEFORE typing) and names it in the
   * reset hint ("Ohne eigenen Namen zeigt VoltPilot wieder …").
   */
  derivedLabel: string;
  /**
   * May the customer name this row? Every real component may (including the
   * platform-composed battery / grid / house rows - a name changes neither what
   * a component is nor whether it exists).
   *
   * false ONLY for the PV ASPECT row of a hybrid: it is an aspect of another
   * component, not one of its own, so renaming it would rename its carrier and
   * silently retitle the Speicher row too. It FOLLOWS the carrier's alias
   * instead ("Solarmodule am Wechselrichter Scheune").
   */
  renameable: boolean;
  role: ComponentRole;
  /** One plain-German line describing what this component is/does. */
  summary: string;
  /** The device(s) that feed/host this component (edge source ids). */
  deviceIds: string[];
  /** „misst selbst" / „gemessen über Deye SUN-30K"; null when meaningless. */
  provenance: string | null;
  /** The live reading, or null — never a fabricated 0. */
  reading: LiveReading | null;
  /** The measured values (Messwerte) — never raw channel names in copy. */
  channels: Messwert[];
  /** Steuerbar (a controllable component — Speicher / Wallbox). */
  control: boolean;
  /** The maßgebliche (primary) grid measurement. */
  primary: boolean;
  health: ComponentHealth;
  /**
   * F1 producer caveat: a Fronius/producer component has no telemetry_v2 of its
   * OWN — its PV is measured THROUGH the hybrid inverter — so a plain health dot
   * would read „noch keine Daten" forever. This carries the honest note
   * („über den Wechselrichter gemessen") the UI shows instead, or null.
   */
  measuredVia: string | null;
  /**
   * true = the component's pinned edge source is no longer reported by the
   * device (identity churn, vp-vier-erzeuger-p9) — the UI says „nicht mehr
   * verbunden" and offers „Wieder verbinden" instead of minting a duplicate.
   * Only a PROVEN orphan (backend tri-state true) counts.
   */
  orphaned: boolean;
}

/** One Gerät: a physical box the edge reports BEHIND the VoltPilot-Box. */
export interface PlantDevice {
  /** The edge-reported source/inverter id. */
  id: string;
  label: string;
  brand: string | null;
  health: ComponentHealth;
  /** The components it measures / controls. */
  componentIds: string[];
  /** The role dots of the strip card, in canonical order. */
  roles: ComponentRole[];
  /** „Liefert Daten" — the device's state in one word. */
  state: string;
  /** „Misst Netz, Speicher, Haus und eigene PV · steuert den Speicher". */
  summary: string;
}

/** One role group of the components list, with its live headline. */
export interface RoleGroup {
  role: ComponentRole;
  label: string;
  components: PlantComponent[];
  /** „Σ 44,9 kW" / „lädt 9,3 kW" / „Einspeisung 30,0 kW"; null = nothing known. */
  headline: string | null;
  /** Honest note when the headline covers only part of the group. */
  note: string | null;
}

/** The one-sentence answer to „ist meine Anlage richtig erkannt?". */
export interface PlantHeadline {
  tone: 'ok' | 'warn';
  text: string;
}

/** The ONE VoltPilot-Box: the mediator every device hangs off. */
export interface EdgeBoxLine {
  label: string;
  health: ComponentHealth;
  /** „Verbunden · empfängt Messwerte von 3 Geräten". */
  summary: string;
}

/** The whole model the page renders. */
export interface PlantModel {
  headline: PlantHeadline;
  devices: PlantDevice[];
  components: PlantComponent[];
  /** The components grouped by role, in canonical order (empty groups dropped). */
  groups: RoleGroup[];
  /** "Neues Gerät gefunden … jetzt zuordnen" — reported but not yet assigned. */
  newlyReported: AdoptableSource[];
}

/** Composed/pilot entity types that map to a specific customer role bucket. */
const HOUSE_LOAD_TYPE = 'house-load';
const BATTERY_HYBRID_TYPE = 'battery-hybrid';
const PRODUCER_TYPE = 'producer';
const GRID_METER_TYPE = 'grid-meter';

const PV_CHANNEL = 'pv_power_kw';
const SOC_CHANNEL = 'soc_pct';
const BATTERY_CHANNEL = 'battery_power_kw';

/** The honest note for a producer whose PV is read through the hybrid inverter. */
export const MEASURED_VIA_INVERTER = 'über den Wechselrichter gemessen';

/** The customer-German guard footnote (no „Guard-Kette" — that is internal). */
export const GUARD_FOOTNOTE =
  'Umbenennen und Zuordnen sind gefahrlos: Sie ändern nur die Darstellung. Was VoltPilot ' +
  'steuern darf, entscheidet das Gerät selbst mit seinen Schutzgrenzen — erkennbar am grünen ' +
  'Abzeichen, nie an einem Namen.';

/** The badge on the one component VoltPilot may actually command. */
export const CONTROL_BADGE = 'Wird von VoltPilot gesteuert';

/** What the mediator line explains, once, in customer German. */
export const EDGE_BOX_HINT =
  'Ihre VoltPilot-Box ist die einzige Verbindung zu VoltPilot. Die Geräte darunter liefern ihr ' +
  'die Messwerte.';

/** Fallback category per entity type when no topology row is present. */
function inferCategory(entityType: string): string {
  switch (entityType) {
    case BATTERY_HYBRID_TYPE:
      return 'storage';
    case PRODUCER_TYPE:
      return 'producer';
    case GRID_METER_TYPE:
    case 'modbus-generic':
      return 'meter';
    case HOUSE_LOAD_TYPE:
      return 'consumer';
    default:
      return 'consumer';
  }
}

/**
 * The customer role bucket for an entity. The composed/pilot types map directly
 * (a house-load is "Haus", never a generic Verbraucher); everything else falls
 * to its topology category (the SAME buckets `topology.defaultRole` uses).
 */
export function componentRole(entityType: string, category: string | null): ComponentRole {
  switch (entityType) {
    case HOUSE_LOAD_TYPE:
      return 'house';
    case BATTERY_HYBRID_TYPE:
      return 'storage';
    case PRODUCER_TYPE:
      return 'pv';
    case GRID_METER_TYPE:
      return 'grid';
  }
  switch (category ?? inferCategory(entityType)) {
    case 'storage':
      return 'storage';
    case 'producer':
      return 'pv';
    case 'meter':
    case 'measure-only':
      return 'grid';
    case 'consumer':
    default:
      return 'consumer';
  }
}

/**
 * The customer-facing name of a component: its own label, else the role default
 * (a Verbraucher keeps its type label so a Wallbox reads "Wallbox", not
 * "Verbraucher").
 */
export function componentLabel(
  label: string | null,
  role: ComponentRole,
  typeLabel: string,
): string {
  const own = label?.trim();
  if (own) return own;
  if (role === 'consumer' && typeLabel.trim()) return typeLabel.trim();
  return COMPONENT_ROLE_LABELS[role];
}

/** One plain-German line describing a component's function. */
function componentSummary(role: ComponentRole, control: boolean, primary: boolean): string {
  switch (role) {
    case 'pv':
      return 'Erzeugt Solarstrom';
    case 'storage':
      return control ? 'Speichert Strom · steuerbar durch VoltPilot' : 'Speichert Strom';
    case 'grid':
      return primary
        ? 'Maßgebliche Messung — hier zählen Bezug und Einspeisung'
        : 'Verbindung zum öffentlichen Netz';
    case 'house':
      return 'Errechnet aus PV, Netz und Speicher — braucht kein eigenes Messgerät';
    case 'consumer':
    default:
      return control ? 'Schaltbar per Regel' : 'Verbraucher';
  }
}

/** Worst-wins device/component health (any stale → amber, else never → grey). */
const HEALTH_RANK: Record<ComponentHealth, number> = {
  ok: 0,
  unknown: 1,
  never: 2,
  stale: 3,
};

function worstHealth(items: ComponentHealth[]): ComponentHealth {
  let worst: ComponentHealth = 'ok';
  for (const h of items) {
    if (HEALTH_RANK[h] > HEALTH_RANK[worst]) worst = h;
  }
  return worst;
}

/**
 * The ONE health mapping of the customer surfaces (H2) — shared with the
 * Komponenten-Board (`livePuls.ts`) and the Verlauf rail (`verlauf.ts`) so a
 * dot can never mean two different things.
 *
 * **Only a literal `ok` is green.** Anything the backend does not (yet) report
 * — `undefined`, `null`, the honest `syncStatus: "unreported"`, an unknown
 * future word — becomes `unknown`, NOT `ok`. Fail-open on health is a lie.
 */
export function toComponentHealth(raw: string | null | undefined): ComponentHealth {
  if (raw === 'stale' || raw === 'never' || raw === 'ok') return raw;
  return 'unknown';
}

/** The measured values (Messwerte) an entity reports. */
function componentChannels(entity: SiteEntity): Messwert[] {
  const seen = new Set<string>();
  const out: Messwert[] = [];
  for (const m of entity.capabilities?.measure ?? []) {
    if (seen.has(m.channel)) continue;
    seen.add(m.channel);
    out.push({ label: channelLabel(m.channel), raw: m.channel });
  }
  return out;
}

/** Per-source PV presence, keyed by the edge source id (SiteEntity.edgeSourceId). */
interface SourceReading {
  hasReading: boolean;
  health: ComponentHealth;
}

/**
 * Index the reported measurement points (`/sources`) by their edge source id, so
 * a producer entity (linked via `edgeSourceId`) can learn whether its PV is
 * actually flowing right now. Grid meters / consumers are irrelevant here.
 */
function sourceReadingIndex(sources: SiteSource[] | null | undefined): Map<string, SourceReading> {
  const idx = new Map<string, SourceReading>();
  for (const s of sources ?? []) {
    if (s.role === 'grid-meter' || s.role === 'consumer') continue;
    idx.set(s.sourceId, {
      hasReading: s.pvKw != null && s.health !== 'never',
      health: s.health === 'stale' ? 'stale' : s.health === 'ok' ? 'ok' : 'unknown',
    });
  }
  return idx;
}

/** A customer-safe role word for a reported-but-unassigned source (no "Quelle"). */
function reportedRoleLabel(role: string | null): string {
  switch (role) {
    case 'pv-generation':
      return 'PV-Erzeuger';
    case 'grid-meter':
      return 'Netz-Zähler';
    case 'consumer':
      return 'Verbraucher';
    default:
      return 'Gerät';
  }
}

/**
 * The reported-but-unassigned devices — "Neues Gerät gefunden … jetzt zuordnen".
 * Reuses `rollen.adoptableSources` (kind='source', not yet adopted) and then
 * drops anything an entity already claims via `edgeSourceId` (belt-and-braces)
 * and re-labels the role customer-safe (never "Energiequelle").
 */
export function newlyReported(
  localSetup: EntityLocalSetup[],
  entities: SiteEntity[],
): AdoptableSource[] {
  const claimed = new Set(
    entities.map((e) => e.edgeSourceId).filter((s): s is string => s != null),
  );
  return adoptableSources(localSetup)
    .filter((s) => !claimed.has(s.id))
    .map((s) => ({ ...s, roleLabel: reportedRoleLabel(s.role) }));
}

/** One re-connect candidate for a reported-but-unassigned source. */
export interface ReconnectCandidate {
  entityId: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Bereinigung: Zuordnung ändern + Komponente löschen (vp-bereinigung-ui-k3)
// ---------------------------------------------------------------------------

/**
 * The two entity types the PLATFORM composes and maintains — the battery/hybrid
 * inverter and the derived house consumption. They carry no device pin, they are
 * the plant's Grundausstattung, and the server refuses to re-pin or delete them.
 * Offering either action on them would be a button that can only ever fail.
 */
export const PLATFORM_COMPONENT_TYPES = ['battery-hybrid', 'house-load'] as const;

/** What a customer may do with one component row. */
export interface ComponentActions {
  /** „Zuordnung ändern" — pick which reported device feeds this component. */
  canRepin: boolean;
  /** „Komponente löschen" — remove the adopted component outright. */
  canDelete: boolean;
}

/**
 * Which cleanup actions a component offers, mirroring the server guards ONE to
 * one (`SiteEntityAdoptController`): the PV aspect of a hybrid is not an entity
 * of its own, the platform-composed types are untouchable, and only a component
 * that actually carries a device pin can be deleted (a composed grid meter /
 * house load has none and IS the plant's base).
 *
 * This is the fix for the captain's dead end: before it, the ONLY way back was
 * the „Wieder verbinden"-Dialog of a NEWLY reported device — and on a fully
 * pinned plant (Pilsting) there is no such device, so nothing was reachable.
 */
export function componentActions(
  component: PlantComponent,
  entity: SiteEntity | undefined,
): ComponentActions {
  if (component.aspect !== 'main' || entity == null) return { canRepin: false, canDelete: false };
  if ((PLATFORM_COMPONENT_TYPES as readonly string[]).includes(entity.entityType)) {
    return { canRepin: false, canDelete: false };
  }
  return { canRepin: true, canDelete: entity.edgeSourceId != null };
}

/** One device a component can be assigned to („Zuordnung ändern"). */
export interface AssignChoice {
  /** The edge source id — the pin the server writes. */
  sourceId: string;
  /** The device name through the ONE `deviceName` chain. */
  label: string;
  /** „21,2 kW" — what this device measures right now, or null. */
  valueLabel: string | null;
  health: ComponentHealth;
  /** The component this device currently feeds, or null when it is free. */
  heldByLabel: string | null;
  /** true = this is the component's CURRENT assignment. */
  current: boolean;
}

/** Does a reported role fit this entity type? (the server's `requireRoleFit`). */
function sourceFitsType(sourceRole: string | null, entityType: string): boolean {
  if (sourceRole == null || sourceRole === '') return true;
  switch (sourceRole) {
    case 'pv-generation':
      return entityType === PRODUCER_TYPE;
    case 'grid-meter':
      return entityType === GRID_METER_TYPE;
    case 'consumer':
      return componentRole(entityType, null) === 'consumer';
    default:
      return true;
  }
}

/** The live reading a reported device carries, per its role. */
function sourceValueLabel(source: SiteSource | undefined): string | null {
  if (!source) return null;
  const v =
    source.role === 'grid-meter'
      ? source.powerKw
      : source.role === 'consumer'
        ? source.loadKw
        : source.pvKw;
  return v == null ? null : fmtNum(round1(Math.abs(v)), 'kW');
}

/**
 * The devices this component can be assigned to — every CURRENTLY reported
 * device whose role fits, each with its own live value and, when it is already
 * taken, the component that holds it (so a swap is a decision, not a surprise).
 *
 * A device the report no longer carries is deliberately absent: the server
 * refuses a blind pin (422), so offering it would be a button that fails.
 */
export function assignChoices(
  component: PlantComponent,
  entities: SiteEntity[],
  localSetup: EntityLocalSetup[],
  sources?: SiteSource[] | null,
): AssignChoice[] {
  const entity = entities.find((e) => e.id === component.entityId);
  if (!entity) return [];
  const sourceById = new Map((sources ?? []).map((s) => [s.sourceId, s] as const));
  const holderBySource = new Map<string, SiteEntity>();
  for (const e of entities) {
    if (e.edgeSourceId != null) holderBySource.set(e.edgeSourceId, e);
  }
  const out: AssignChoice[] = [];
  for (const l of localSetup) {
    if (l.kind !== 'source') continue;
    if (!sourceFitsType(l.role, entity.entityType)) continue;
    const holder = holderBySource.get(l.id);
    const src = sourceById.get(l.id);
    out.push({
      sourceId: l.id,
      label:
        deviceName({ edgeLabel: l.label, brand: l.brand, model: l.model }) ??
        reportedRoleLabel(l.role),
      valueLabel: sourceValueLabel(src),
      health: src ? toComponentHealth(src.health) : 'unknown',
      heldByLabel:
        holder == null || holder.id === entity.id
          ? null
          : componentLabel(holder.label, componentRole(holder.entityType, null), holder.typeLabel),
      current: entity.edgeSourceId === l.id,
    });
  }
  return out;
}

/** The choice a component is currently assigned to, or null (orphaned/unpinned). */
export function currentChoice(choices: AssignChoice[]): AssignChoice | null {
  return choices.find((c) => c.current) ?? null;
}

/**
 * The consequence sentence of picking an already-taken device: BOTH assignments
 * move in ONE step (the server swaps them inside one transaction, so the
 * customer can never strand half-way).
 *
 * The second wording is load-bearing: when this component's own device is gone
 * (the orphan case), the other component is RELEASED rather than handed a dead
 * assignment — moving the defect would be the worse outcome, and the sentence
 * says exactly what happens.
 */
export function swapNote(choice: AssignChoice, own: AssignChoice | null): string | null {
  if (choice.heldByLabel == null || choice.current) return null;
  return own
    ? `„${choice.heldByLabel}“ übernimmt im Gegenzug „${own.label}“ — beides wird in einem Schritt getauscht.`
    : `„${choice.heldByLabel}“ ist danach keinem Gerät mehr zugeordnet und zeigt keinen Wert, bis Sie ihm eines zuweisen.`;
}

/** What deleting a component does, in plain German — the confirm dialog's text. */
export interface DeleteConsequences {
  lines: string[];
  /** „Die hinterlegten 9,8 kWp …" — only when a nameplate hangs on the total. */
  kwpNote: string | null;
}

/**
 * The consequence list of „Komponente löschen". It names the freed device,
 * because the customer's next step is exactly that: the device comes back as
 * „Neues Gerät gefunden" and can be assigned to the RIGHT component.
 *
 * `deviceLabel` is the CURRENTLY REPORTED device (null for an orphan, whose
 * device is gone). The freed-device promise is made only then — telling the
 * owner of an orphan that a vanished device will reappear would be a lie.
 */
export function deleteConsequences(
  component: PlantComponent,
  entity: SiteEntity | undefined,
  deviceLabel: string | null,
): DeleteConsequences {
  const lines = [
    `„${component.label}“ verschwindet aus Ihrer Anlage — im Cockpit, in der Historie und in der Steuerung.`,
    'Bereits aufgezeichnete Werte dieser Komponente werden nicht mehr angezeigt.',
  ];
  if (entity?.edgeSourceId != null && deviceLabel) {
    lines.push(
      `Das Gerät „${deviceLabel}“ wird wieder frei und erscheint danach als „Neues Gerät gefunden“.`,
    );
  }
  const kwp = entity?.capacityKwp;
  const kwpNote =
    kwp == null || kwp === 0
      ? null
      : `Die hinterlegten ${fmtNum(kwp, 'kWp')} werden von der Gesamtleistung Ihrer Anlage abgezogen.`;
  return { lines, kwpNote };
}

/**
 * Existing components a newly reported source most likely IS (vp-vier-
 * erzeuger-p9): entities whose pin is PROVEN orphaned (their old source id
 * vanished — the delete+re-add churn) and whose type matches what the source
 * would be adopted as. The Zuordnen dialog leads with „Wieder verbinden" for
 * these — re-adopting would mint a duplicate (the Pilsting ghost).
 */
export function reconnectCandidates(
  source: AdoptableSource,
  entities: SiteEntity[],
): ReconnectCandidate[] {
  const type = source.suggestedType ?? suggestEntityType(source.role, source.brand);
  if (!type) return [];
  return entities
    .filter((e) => e.orphanedPin === true && e.entityType === type)
    .map((e) => ({
      entityId: e.id,
      label: componentLabel(e.label, componentRole(e.entityType, null), e.typeLabel),
    }));
}

/** The device's state in one plain word (never a Messwert count). */
export function deviceState(health: ComponentHealth): string {
  switch (health) {
    case 'ok':
      return 'Liefert Daten';
    case 'stale':
      return 'Meldet sich gerade nicht';
    case 'never':
      return 'Wartet auf die ersten Daten';
    default:
      return 'Noch keine Rückmeldung';
  }
}

/** The role word used when listing what a device measures. */
const ROLE_MEASURE_WORD: Record<ComponentRole, string> = {
  pv: 'PV',
  storage: 'Speicher',
  grid: 'Netz',
  house: 'Haus',
  consumer: 'Verbraucher',
};

/** „a, b und c" — a German enumeration. */
function joinDe(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} und ${words[words.length - 1]}`;
}

/**
 * What a device does, in verbs instead of counts (concept Teil 6): „Misst seine
 * PV-Leistung" / „Misst Netz, Speicher, Haus und eigene PV · steuert den
 * Speicher". A device without a single component says so honestly.
 */
export function deviceSummary(components: PlantComponent[]): string {
  if (components.length === 0) return 'Noch keiner Komponente zugeordnet';
  const controlled = components.filter((c) => c.control);
  const controls =
    controlled.length === 0
      ? ''
      : ` · steuert ${
          controlled.length === 1 && controlled[0].role === 'storage'
            ? 'den Speicher'
            : joinDe(controlled.map((c) => c.label))
        }`;
  if (components.length === 1) {
    const only = components[0];
    // One component that VoltPilot also commands reads as one sentence, never
    // „Misst X · steuert X".
    const verb = only.control ? 'Misst und steuert' : 'Misst';
    switch (only.role) {
      case 'pv':
        return `${verb} seine PV-Leistung`;
      case 'storage':
        return `${verb} den Speicher`;
      case 'grid':
        return `${verb} den Netzanschluss`;
      case 'house':
        return `${verb} den Hausverbrauch`;
      default:
        return `${verb} ${only.label}`;
    }
  }
  const words: string[] = [];
  for (const role of COMPONENT_ROLE_ORDER) {
    const inRole = components.filter((c) => c.role === role);
    if (inRole.length === 0) continue;
    // A hybrid's own modules are „eigene PV" - it does not measure the separate
    // inverters, only what hangs on itself.
    const ownPvOnly = role === 'pv' && inRole.every((c) => c.aspect === 'pv');
    words.push(ownPvOnly ? 'eigene PV' : ROLE_MEASURE_WORD[role]);
  }
  return `Misst ${joinDe(words)}${controls}`;
}

/** The role dots of a device card, in canonical order, each role once. */
function deviceRoles(components: PlantComponent[]): ComponentRole[] {
  return COMPONENT_ROLE_ORDER.filter((r) => components.some((c) => c.role === r));
}

/** A device label fallback derived from what it feeds. */
function fallbackDeviceLabel(components: PlantComponent[]): string {
  if (components.length === 1) return components[0].label;
  // A gateway that feeds Speicher / Netz / Haus is the plant's inverter.
  if (components.some((c) => c.role === 'storage' || c.role === 'grid' || c.role === 'house')) {
    return 'Wechselrichter';
  }
  return 'Gerät';
}

/**
 * The ONE VoltPilot-Box line (Captain-Korrektur): the mediator every reported
 * device hangs off. Without a claimed device it returns null — nothing is
 * invented. Several claimed boxes are counted honestly rather than collapsed
 * into a singular that would be a lie.
 */
export function edgeBoxLine(
  devices: Device[] | null | undefined,
  reportedDeviceCount: number,
  now: Date = new Date(),
): EdgeBoxLine | null {
  const list = devices ?? [];
  if (list.length === 0) return null;
  const healths = list.map((d) => {
    const status = deviceLiveStatus(d, now);
    return status === 'online' ? 'ok' : status === 'stale' ? 'stale' : 'never';
  }) as ComponentHealth[];
  const health = worstHealth(healths);
  const name = (d: Device): string => d.name?.trim() || d.externalRef;
  const label =
    list.length === 1 ? `VoltPilot-Box ${name(list[0])}` : `${list.length} VoltPilot-Boxen`;
  const state =
    health === 'ok'
      ? 'Verbunden'
      : health === 'stale'
        ? 'Meldet sich gerade nicht'
        : 'Wartet auf die ersten Daten';
  const feed =
    reportedDeviceCount === 0
      ? 'noch kein Gerät gemeldet'
      : reportedDeviceCount === 1
        ? 'empfängt Messwerte von 1 Gerät'
        : `empfängt Messwerte von ${reportedDeviceCount} Geräten`;
  return { label, health, summary: `${state} · ${feed}` };
}

/** n × „Komponente"/„Gerät" with the right German plural. */
function countWord(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The Kopfsatz — Job 1 („richtig erkannt?") answered in one line. Amber the
 * moment a device is not delivering, and it NAMES that device (the same
 * mechanic as the cockpit status sentence / `composeFleetSentence`).
 */
export function plantHeadline(devices: PlantDevice[], components: PlantComponent[]): PlantHeadline {
  const base = `VoltPilot kennt Ihre Anlage als ${countWord(
    components.length,
    'Komponente',
    'Komponenten',
  )}, gemessen von ${countWord(devices.length, 'Gerät', 'Geräten')}`;
  if (devices.length === 0) {
    return {
      tone: 'warn',
      text: 'Noch kein Gerät gemeldet — sobald sich eines meldet, erscheint hier Ihre Anlage.',
    };
  }
  const silent = devices.find((d) => d.health !== 'ok');
  if (!silent) return { tone: 'ok', text: `${base} — alle liefern Daten.` };
  const why =
    silent.health === 'stale'
      ? 'meldet sich gerade nicht'
      : silent.health === 'never'
        ? 'wartet auf die ersten Daten'
        : 'hat sich noch nicht zurückgemeldet';
  return { tone: 'warn', text: `${base}. „${silent.label}“ ${why}.` };
}

/** The live value + direction word for one component. */
function readingFor(
  role: ComponentRole,
  caps: Map<string, number>,
  pvKw: number | null,
): LiveReading | null {
  switch (role) {
    case 'pv': {
      const v = pvKw ?? caps.get(PV_CHANNEL) ?? null;
      return v == null ? null : { value: round1(Math.max(0, v)), unit: 'kW', caption: null };
    }
    case 'storage': {
      const soc = caps.get(SOC_CHANNEL);
      if (soc != null) return { value: round1(soc), unit: '%', caption: 'geladen' };
      const p = caps.get(BATTERY_CHANNEL);
      if (p == null) return null;
      return { value: round1(Math.abs(p)), unit: 'kW', caption: batteryWord(p) };
    }
    case 'grid': {
      const p = caps.get('power_kw') ?? caps.get('grid_power_kw');
      if (p == null) return null;
      return { value: round1(Math.abs(p)), unit: 'kW', caption: gridWord(p) };
    }
    case 'house': {
      const p = caps.get('load_kw') ?? caps.get('power_kw');
      return p == null ? null : { value: round1(Math.abs(p)), unit: 'kW', caption: null };
    }
    case 'consumer':
    default: {
      const p = caps.get('power_kw');
      return p == null ? null : { value: round1(Math.abs(p)), unit: 'kW', caption: null };
    }
  }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function gridWord(p: number): string {
  if (p > DEADBAND_KW) return 'Bezug';
  if (p < -DEADBAND_KW) return 'Einspeisung';
  return 'ausgeglichen';
}

function batteryWord(p: number): string {
  if (p > DEADBAND_KW) return 'lädt';
  if (p < -DEADBAND_KW) return 'entlädt';
  return 'hält die Ladung';
}

/**
 * The group headline: the number the customer checks the cockpit against. It is
 * ALWAYS the sum of what the group actually shows — a component without a value
 * is counted in `note`, never as a 0 (so „21,2 + 23,5 + 0,2 = 44,9" holds).
 */
function groupHeadline(
  role: ComponentRole,
  components: PlantComponent[],
  batteryKw: number | null,
): { headline: string | null; note: string | null } {
  const missing = components.filter((c) => c.reading == null).length;
  const note =
    missing === 0
      ? null
      : `${countWord(missing, 'Komponente', 'Komponenten')} ohne aktuellen Wert`;
  if (role === 'storage') {
    if (batteryKw == null) return { headline: null, note };
    const word = batteryWord(batteryKw);
    return {
      headline:
        word === 'hält die Ladung' ? word : `${word} ${fmtNum(Math.abs(batteryKw), 'kW')}`,
      note,
    };
  }
  const kw = components
    .filter((c) => c.reading?.unit === 'kW')
    .map((c) => c.reading as LiveReading);
  if (kw.length === 0) return { headline: null, note };
  if (role === 'grid') {
    // A grid group reads as ONE connection point: the maßgebliche measurement
    // leads, and its direction word carries the sign.
    const lead = components.find((c) => c.primary && c.reading != null) ?? components.find((c) => c.reading != null);
    const r = lead?.reading as LiveReading | undefined;
    if (!r) return { headline: null, note };
    return {
      headline: r.caption === 'ausgeglichen' ? r.caption : `${r.caption} ${fmtNum(r.value, 'kW')}`,
      note,
    };
  }
  const sum = round1(kw.reduce((s, r) => s + r.value, 0));
  const prefix = kw.length > 1 ? 'Σ ' : '';
  return { headline: `${prefix}${fmtNum(sum, 'kW')}`, note };
}

/** Group the components by role, in canonical order; empty groups are dropped. */
export function roleGroups(components: PlantComponent[], batteryKw: number | null): RoleGroup[] {
  const out: RoleGroup[] = [];
  for (const role of COMPONENT_ROLE_ORDER) {
    // Devices of their own come first; a hybrid's own modules ("Solarmodule am
    // …") close the group - the reading order of the concept, and stable
    // (Array.sort is stable, so the backend's entity order survives inside each
    // block).
    const inRole = components
      .filter((c) => c.role === role)
      .sort((a, b) => (a.aspect === b.aspect ? 0 : a.aspect === 'main' ? -1 : 1));
    if (inRole.length === 0) continue;
    const { headline, note } = groupHeadline(role, inRole, role === 'storage' ? batteryKw : null);
    out.push({ role, label: COMPONENT_ROLE_LABELS[role], components: inRole, headline, note });
  }
  return out;
}

/**
 * The plant model. Pure + deterministic:
 * - components = one per v2 entity + the PV aspect of a hybrid inverter;
 * - devices = the edge-reported physical boxes BEHIND the VoltPilot-Box
 *   (adopted sources feed their one entity, matched by PIN; the inverter feeds
 *   the composed entities; any leftover linked entity falls into a synthetic
 *   device so nothing measuring is orphaned);
 * - newlyReported = reported-but-unassigned sources ("Neues Gerät gefunden").
 */
export function plantModel(
  entities: SiteEntity[],
  topology: SiteTopology | null,
  localSetup: EntityLocalSetup[],
  sources?: SiteSource[] | null,
): PlantModel {
  const categoryById = new Map<string, string>();
  // F1: the topology entity's `health` is telemetry_v2 liveness — the SAME
  // signal the Cockpit reads. Health from real data presence, not the edge
  // `observed` echo (which is empty-by-construction for composed/adopted
  // entities → false „noch keine Daten" on every migrated plant).
  const topoHealthById = new Map<string, string>();
  const capsById = new Map<string, Map<string, number>>();
  for (const t of topology?.entities ?? []) {
    const te = t as TopologyEntity;
    categoryById.set(te.id, te.category);
    topoHealthById.set(te.id, te.health);
    const caps = new Map<string, number>();
    for (const c of te.capabilities) {
      if (c.value != null) caps.set(c.channel, c.value);
    }
    capsById.set(te.id, caps);
  }
  const sourceByEdgeId = sourceReadingIndex(sources);

  // The per-device PV split: the SAME reconciliation the energy flow uses, so
  // the Anlagen-Modell can never disagree with the cockpit's PV number. On a
  // backend that already publishes PV per entity this is a no-op.
  const pvByEntity = new Map<string, number>();
  if (topology) {
    // Pin-based, never positional: the entities carry `edgeSourceId` /
    // `orphanedPin`, which is the ONLY link between a component and the edge
    // device that measures it.
    const resolved = reconcileProducerPv(topology, sources, entities);
    const pvNode = resolved.topology.nodes.find((n) => n.role === 'pv');
    for (const m of pvNode?.members ?? []) {
      if (m.value_kw != null) pvByEntity.set(m.entity_id, m.value_kw);
    }
  }

  const components: PlantComponent[] = [];
  for (const e of entities) {
    const role = componentRole(e.entityType, categoryById.get(e.id) ?? null);
    const control = e.control === true;
    const primary = role === 'grid' && isPrimaryGrid(e, topology);
    const caps = capsById.get(e.id) ?? new Map<string, number>();
    // Honesty rule (vp-pin-werte-f8): a PROVEN orphan says „nicht mehr mit
    // einem gemeldeten Gerät verbunden" — a current value next to that word
    // would contradict the row itself, so it carries none at any role.
    const orphaned = e.orphanedPin === true;
    // Prefer the topology (telemetry_v2) liveness; fall back to the edge echo
    // only when no topology row exists (v1/un-migrated site).
    let health = toComponentHealth(topoHealthById.get(e.id) ?? e.observed?.health);
    let measuredVia: string | null = null;
    // Producer caveat: a producer has NO telemetry_v2 of its own (its PV is
    // measured through the hybrid inverter), so topology liveness reads `never`.
    // Say so honestly — and go green when /sources proves it IS delivering —
    // instead of the blanket „noch keine Daten".
    if (role === 'pv' && e.entityType === PRODUCER_TYPE && health !== 'ok') {
      measuredVia = MEASURED_VIA_INVERTER;
      const src = e.edgeSourceId != null ? sourceByEdgeId.get(e.edgeSourceId) : undefined;
      if (src?.hasReading) health = src.health;
    }
    components.push({
      id: e.id,
      entityId: e.id,
      aspect: 'main',
      label: componentLabel(e.label, role, e.typeLabel),
      alias: e.label?.trim() ? e.label.trim() : null,
      derivedLabel: componentLabel(null, role, e.typeLabel),
      renameable: true,
      role,
      summary: componentSummary(role, control, primary),
      deviceIds: [],
      provenance: null,
      reading: orphaned
        ? null
        : readingFor(role, caps, role === 'pv' ? (pvByEntity.get(e.id) ?? null) : null),
      channels: componentChannels(e),
      control,
      primary,
      health,
      measuredVia,
      orphaned,
    });
    // The PV ASPECT of a hybrid inverter: the composed backfill mints no own
    // producer for the modules hanging on the inverter itself, so without this
    // row a plain single-inverter plant would show no PV at all and a
    // multi-inverter plant's Σ would silently miss the inverter's share.
    if (role !== 'pv' && measuresPv(e, capsById.get(e.id))) {
      components.push({
        id: `${e.id}#pv`,
        entityId: e.id,
        aspect: 'pv',
        label: 'Solarmodule',
        // An aspect of the hybrid, not a component of its own: it FOLLOWS the
        // carrier's name (composed below) and carries no pencil.
        alias: null,
        derivedLabel: 'Solarmodule',
        renameable: false,
        role: 'pv',
        summary: componentSummary('pv', false, false),
        deviceIds: [],
        provenance: null,
        reading: orphaned ? null : readingFor('pv', caps, pvByEntity.get(e.id) ?? null),
        channels: [{ label: channelLabel(PV_CHANNEL), raw: PV_CHANNEL }],
        control: false,
        primary: false,
        health,
        measuredVia: null,
        orphaned: false,
      });
    }
  }
  const componentById = new Map(components.map((c) => [c.id, c] as const));
  const componentsOfEntity = (entityId: string): PlantComponent[] =>
    components.filter((c) => c.entityId === entityId);

  const devices: PlantDevice[] = [];
  const assigned = new Set<string>();

  const linkDevice = (
    id: string,
    label: string,
    brand: string | null,
    componentIds: string[],
  ): void => {
    for (const cid of componentIds) {
      componentById.get(cid)?.deviceIds.push(id);
      assigned.add(cid);
    }
    devices.push({
      id,
      label,
      brand,
      componentIds,
      health: 'ok',
      roles: [],
      state: '',
      summary: '',
    });
  };

  // 1. Adopted sources feed their one entity, matched by PIN in BOTH directions
  //    (the entity's `edgeSourceId` and the reported item's `adoptedEntityId`,
  //    PR #272) — never by order or by name. The device NAME goes through the
  //    ONE `entityLabel.deviceName` chain (operator name > brand + short model)
  //    - never the raw stored string (the Pilsting "fronius_sunspec · …" bug).
  const pinnedEntityBySource = new Map<string, string>();
  for (const e of entities) {
    if (e.edgeSourceId != null) pinnedEntityBySource.set(e.edgeSourceId, e.id);
  }
  for (const l of localSetup) {
    if (l.kind !== 'source') continue;
    const entityId = pinnedEntityBySource.get(l.id) ?? l.adoptedEntityId;
    if (entityId == null) continue;
    const comps = componentsOfEntity(entityId);
    linkDevice(
      l.id,
      deviceName({ edgeLabel: l.label, brand: l.brand, model: l.model }) ??
        (comps[0] ? comps[0].label : 'Gerät'),
      l.brand,
      comps.map((c) => c.id),
    );
  }

  // 2. The inverter (gateway) feeds the composed entities — those not adopted
  //    from a source. The first reported inverter takes them; extras get [].
  const inverters = localSetup.filter((l) => l.kind === 'inverter');
  const composed = components.filter(
    (c) => !assigned.has(c.id) && !entities.find((e) => e.id === c.entityId)?.edgeSourceId,
  );
  inverters.forEach((inv, i) => {
    const comps = i === 0 ? composed.map((c) => c.id) : [];
    linkDevice(
      inv.id,
      deviceName({ edgeLabel: inv.label, brand: inv.brand, model: inv.model }) ?? 'Wechselrichter',
      inv.brand,
      comps,
    );
  });

  // 3. Any still-unassigned component that has a device binding falls into a
  //    synthetic device, so every measuring component appears under a box.
  const byDeviceId = new Map<string, PlantComponent[]>();
  for (const c of components) {
    if (assigned.has(c.id)) continue;
    // A PROVEN orphan has no reported device — inventing a synthetic box for it
    // would contradict the row's own „nicht mehr verbunden" (vp-vier-erzeuger-p9).
    if (c.orphaned) continue;
    const deviceId = entities.find((e) => e.id === c.entityId)?.deviceId;
    if (deviceId == null) continue;
    const list = byDeviceId.get(deviceId) ?? [];
    list.push(c);
    byDeviceId.set(deviceId, list);
  }
  for (const [deviceId, comps] of byDeviceId) {
    linkDevice(`dev:${deviceId}`, fallbackDeviceLabel(comps), null, comps.map((c) => c.id));
  }

  // Finalise device health + the verb sub-line from their components.
  const deviceLabelById = new Map(devices.map((d) => [d.id, d.label] as const));
  for (const d of devices) {
    const comps = d.componentIds
      .map((cid) => componentById.get(cid))
      .filter((c): c is PlantComponent => c != null);
    d.health = worstHealth(comps.map((c) => c.health));
    d.roles = deviceRoles(comps);
    d.state = deviceState(d.health);
    d.summary = deviceSummary(comps);
  }

  // Herkunft is a chip, not a riddle: every component says where its number
  // comes from. A device measuring ITSELF (an adopted 1:1 box) says so; a
  // composed one names the box it is read through.
  for (const c of components) {
    const label = c.deviceIds.length > 0 ? deviceLabelById.get(c.deviceIds[0]) : undefined;
    if (c.aspect === 'pv') {
      // The concept's „Solarmodule am Deye SUN-30K" — the modules of THAT box.
      // It FOLLOWS the carrier's alias: once the customer calls their hybrid
      // „Wechselrichter Scheune", this row must say so too, or the same box
      // would carry two names one row apart.
      const carrier = entities.find((e) => e.id === c.entityId)?.label?.trim();
      const on = carrier || label;
      if (on) {
        c.label = `Solarmodule am ${on}`;
        c.derivedLabel = c.label;
      }
    }
    if (c.role === 'house' || label == null) {
      c.provenance = null;
      continue;
    }
    const ownBox =
      c.aspect === 'main' && entities.find((e) => e.id === c.entityId)?.edgeSourceId != null;
    c.provenance = ownBox ? 'misst selbst' : `gemessen über ${label}`;
  }

  // The storage group's headline is the battery's POWER (the row shows SoC).
  let batteryKw: number | null = null;
  for (const c of components) {
    if (c.role !== 'storage') continue;
    const p = capsById.get(c.entityId)?.get(BATTERY_CHANNEL);
    if (p == null) continue;
    batteryKw = (batteryKw ?? 0) + p;
  }

  return {
    headline: plantHeadline(devices, components),
    devices,
    components,
    groups: roleGroups(components, batteryKw),
    newlyReported: newlyReported(localSetup, entities),
  };
}

/** True when a non-PV entity ALSO measures PV (a hybrid inverter's own modules). */
function measuresPv(entity: SiteEntity, caps: Map<string, number> | undefined): boolean {
  if (caps?.has(PV_CHANNEL)) return true;
  return (entity.capabilities?.measure ?? []).some((m) => m.channel === PV_CHANNEL);
}

/** True when this entity carries the maßgebliche (primary) grid capability. */
function isPrimaryGrid(entity: SiteEntity, topology: SiteTopology | null): boolean {
  const t = topology?.entities.find((e) => e.id === entity.id);
  if (!t) return false;
  return t.capabilities.some((c) => c.role === 'grid' && c.primary);
}

// Re-export the suggestion helper so the assign dialog derives the guided type
// through the SAME rollen.ts truth (no second suggestion logic).
export { suggestEntityType };
