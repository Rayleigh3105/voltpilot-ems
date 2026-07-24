/**
 * Portal v3 · M6 — the pure derivation behind the Anlagen-Modell
 * (`docs/portal-v3/M6-komponenten.md`, concept tab 7). It turns the v2 entity
 * data into ONE picture: "so ist Ihre Anlage verschaltet." — three columns,
 * **Geräte** (physical boxes) → **Komponenten** (the roles) → **Ihre Anlage**
 * (what the cockpit makes of it).
 *
 * The customer dictionary is locked (D3): **Gerät / Komponente / Messwert**.
 * The words Entität · Messpunkt · Quelle · Mess-Einheit · Kanal never appear in
 * anything this module produces (they stay in the installer/admin panels). The
 * `komponenten.test.ts` vocabulary guard greps every produced label for them.
 *
 * Pure + framework-free (the `rollen.ts` / `topology.ts` precedent): components
 * only render what this decides. It REUSES `rollen.ts`
 * (`adoptableSources` / `sourceRoleLabel` / `suggestEntityType`) and
 * `topology.ts` (`defaultRole`) — there is no second role derivation.
 *
 * KEY facts of the current backend that shape the mapping:
 * - A Komponente = one v2 entity (its role bucket derived from its type +
 *   topology category). A hybrid inverter composes into SEVERAL entities
 *   (battery-hybrid=Speicher, grid-meter=Netzanschluss, house-load=Haus), so it
 *   feeds several components — exactly the mockup's "liefert 4 Messwerte".
 * - A Gerät = a physical box the edge REPORTS (`localSetup`), NOT the single
 *   `device` uuid every entity is bound to. The gateway inverter feeds the
 *   composed entities; an adopted source feeds its one entity.
 * - The "—" discipline is law: an unknown value stays absent, never a
 *   fabricated 0, and a component without a device link still renders.
 */
import type {
  EntityLocalSetup,
  SiteEntity,
  SiteSource,
  SiteTopology,
  TopologyEntity,
} from './api';
import { channelLabel } from './channels';
import { adoptableSources, suggestEntityType, type AdoptableSource } from './rollen';

/** The customer-facing component role buckets (the middle column). */
export type ComponentRole = 'pv' | 'storage' | 'grid' | 'house' | 'consumer';

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

/** German role labels — the customer names for the roles ("PV-Dach", …). */
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

/** One measured value a device knows about a component (the "Messwert" word). */
export interface Messwert {
  /** Plain-German label ("PV-Leistung", "Ladestand", …). */
  label: string;
  /** The raw channel identifier — kept only as a support/debug title. */
  raw: string;
}

/** One Komponente (middle column): the role the plant is thought in. */
export interface PlantComponent {
  /** The v2 entity id. */
  id: string;
  /** Customer-facing name (its own label, else a role/type default). */
  label: string;
  role: ComponentRole;
  /** One plain-German line describing what this component is/does. */
  summary: string;
  /** The device(s) that feed/host this component (edge source ids). */
  deviceIds: string[];
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
}

/** One Gerät (left column): a physical box the edge reports. */
export interface PlantDevice {
  /** The edge-reported source/inverter id. */
  id: string;
  label: string;
  brand: string | null;
  health: ComponentHealth;
  /** How many measured values it delivers across its components. */
  messwertCount: number;
  /** The components it measures / controls. */
  componentIds: string[];
  /** "verbunden · liefert N Messwerte" — the mockup's device sub-line. */
  summary: string;
}

/** One "Ihre Anlage" effect card (right column) — what the cockpit makes of it. */
export interface PlantEffect {
  key: string;
  title: string;
  summary: string;
  /** 'warn' turns the card amber (the Gesundheit card when a device is silent). */
  tone: 'plain' | 'warn';
}

/** The whole three-column model. */
export interface PlantModel {
  devices: PlantDevice[];
  components: PlantComponent[];
  /** "Neues Gerät gefunden … jetzt zuordnen" — reported but not yet assigned. */
  newlyReported: AdoptableSource[];
  effects: PlantEffect[];
}

/** Composed/pilot entity types that map to a specific customer role bucket. */
const HOUSE_LOAD_TYPE = 'house-load';
const BATTERY_HYBRID_TYPE = 'battery-hybrid';
const PRODUCER_TYPE = 'producer';
const GRID_METER_TYPE = 'grid-meter';

/** The honest note for a producer whose PV is read through the hybrid inverter. */
export const MEASURED_VIA_INVERTER = 'über den Wechselrichter gemessen';

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
        ? 'Maßgebliche Messung · § 14a überwacht'
        : 'Verbindung zum öffentlichen Netz';
    case 'house':
      return 'Ihr Verbrauch · errechnet aus PV, Netz und Speicher';
    case 'consumer':
    default:
      return control ? 'Schaltbar per Automation' : 'Verbraucher';
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

/** "verbunden · liefert N Messwerte" — the device sub-line. */
export function deviceSummary(device: { health: ComponentHealth; messwertCount: number }): string {
  const state =
    device.health === 'ok'
      ? 'verbunden'
      : device.health === 'stale'
        ? 'meldet gerade keine Daten'
        : device.health === 'never'
          ? 'noch keine Daten'
          : 'noch keine Rückmeldung';
  if (device.messwertCount <= 0) return state;
  const word = device.messwertCount === 1 ? 'Messwert' : 'Messwerte';
  return `${state} · liefert ${device.messwertCount} ${word}`;
}

/** A device label from its adopted-source name, else a role-derived fallback. */
function fallbackDeviceLabel(components: PlantComponent[]): string {
  if (components.length === 1) return components[0].label;
  // A gateway that feeds Speicher / Netz / Haus is the plant's inverter.
  if (components.some((c) => c.role === 'storage' || c.role === 'grid' || c.role === 'house')) {
    return 'Wechselrichter';
  }
  return 'Gerät';
}

/** The fixed "Ihre Anlage" effect cards; Gesundheit reflects the worst device. */
function plantEffects(devices: PlantDevice[], components: PlantComponent[]): PlantEffect[] {
  const silent = devices.find((d) => d.health !== 'ok');
  const health: PlantEffect =
    silent != null
      ? {
          key: 'gesundheit',
          title: 'Gesundheit',
          summary: `„${silent.label}“ liefert gerade keine Daten. Das Health-Zeichen oben wird gelb und nennt das Gerät. Nichts rechnet mit erfundenen Nullen.`,
          tone: 'warn',
        }
      : {
          key: 'gesundheit',
          title: 'Gesundheit',
          summary: 'Alle Geräte liefern Daten. Das Health-Zeichen oben bleibt grün.',
          tone: 'plain',
        };
  const effects: PlantEffect[] = [
    {
      key: 'cockpit',
      title: 'Cockpit & Energiefluss',
      // F5: the flow draws ONE Knoten per Komponente (kein summierter Rollen-
      // Knoten), also keine falsche Zusage mehr.
      summary:
        'Jede Komponente erscheint als eigener Knoten im Energiefluss — so sehen Sie jeden Erzeuger und Verbraucher einzeln.',
      tone: 'plain',
    },
    {
      key: 'steuerung',
      title: 'Steuerung',
      summary:
        'Profile optimieren den Speicher am maßgeblichen Netzanschluss; Automationen schalten Verbraucher wie die Wallbox.',
      tone: 'plain',
    },
    {
      key: 'historie',
      title: 'Historie',
      summary:
        'Jeder Messwert jeder Komponente hat automatisch seinen Verlauf — auch eigene Modbus-Messwerte.',
      tone: 'plain',
    },
    health,
  ];
  // IA(5): a "Datenfluss"-Erklärer, but only where it explains something — a
  // hybrid inverter that measures the plant PLUS extra producers whose PV is
  // read through it. On a plain single-inverter plant it would be noise.
  const hasHybrid = components.some((c) => c.role === 'storage');
  const hasProducer = components.some((c) => c.role === 'pv' && c.measuredVia != null);
  if (hasHybrid && hasProducer) {
    effects.unshift({
      key: 'datenfluss',
      title: 'Datenfluss',
      summary:
        'Der Wechselrichter misst Netzanschluss, Speicher, Hausverbrauch und die gesamte PV-Leistung. Weitere Erzeuger liefern ihre Leistung an den Wechselrichter — daraus errechnet VoltPilot Cockpit und Historie.',
      tone: 'plain',
    });
  }
  return effects;
}

/**
 * The three-column plant model. Pure + deterministic:
 * - components = one per v2 entity (role bucket + Messwerte + health);
 * - devices = the edge-reported physical boxes (adopted sources feed their one
 *   entity; the inverter feeds the composed/gateway entities; any leftover
 *   linked entity falls into a synthetic device so nothing measuring is
 *   orphaned);
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
  for (const t of topology?.entities ?? []) {
    const te = t as TopologyEntity;
    categoryById.set(te.id, te.category);
    topoHealthById.set(te.id, te.health);
  }
  const sourceByEdgeId = sourceReadingIndex(sources);

  const components: PlantComponent[] = entities.map((e) => {
    const role = componentRole(e.entityType, categoryById.get(e.id) ?? null);
    const control = e.control === true;
    const primary = role === 'grid' && isPrimaryGrid(e, topology);
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
    return {
      id: e.id,
      label: componentLabel(e.label, role, e.typeLabel),
      role,
      summary: componentSummary(role, control, primary),
      deviceIds: [],
      channels: componentChannels(e),
      control,
      primary,
      health,
      measuredVia,
    };
  });
  const componentById = new Map(components.map((c) => [c.id, c] as const));

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
    devices.push({ id, label, brand, componentIds, health: 'ok', messwertCount: 0, summary: '' });
  };

  // 1. Adopted sources feed their one entity.
  const adoptedById = new Map<string, EntityLocalSetup>();
  for (const l of localSetup) {
    if (l.kind === 'source' && l.adoptedEntityId != null) {
      adoptedById.set(l.adoptedEntityId, l);
      const comp = componentById.get(l.adoptedEntityId);
      linkDevice(
        l.id,
        l.label?.trim() || l.brand?.trim() || (comp ? comp.label : 'Gerät'),
        l.brand,
        comp ? [comp.id] : [],
      );
    }
  }

  // 2. The inverter (gateway) feeds the composed entities — those not adopted
  //    from a source. The first reported inverter takes them; extras get [].
  const inverters = localSetup.filter((l) => l.kind === 'inverter');
  const composed = components.filter(
    (c) => !assigned.has(c.id) && !entities.find((e) => e.id === c.id)?.edgeSourceId,
  );
  inverters.forEach((inv, i) => {
    const comps = i === 0 ? composed.map((c) => c.id) : [];
    linkDevice(inv.id, inv.label?.trim() || inv.brand?.trim() || 'Wechselrichter', inv.brand, comps);
  });

  // 3. Any still-unassigned component that has a device binding falls into a
  //    synthetic device, so every measuring component appears under a box.
  const byDeviceId = new Map<string, PlantComponent[]>();
  for (const c of components) {
    if (assigned.has(c.id)) continue;
    const deviceId = entities.find((e) => e.id === c.id)?.deviceId;
    if (deviceId == null) continue;
    const list = byDeviceId.get(deviceId) ?? [];
    list.push(c);
    byDeviceId.set(deviceId, list);
  }
  for (const [deviceId, comps] of byDeviceId) {
    linkDevice(`dev:${deviceId}`, fallbackDeviceLabel(comps), null, comps.map((c) => c.id));
  }

  // Finalise device health + Messwert count + sub-line from their components.
  for (const d of devices) {
    const comps = d.componentIds
      .map((cid) => componentById.get(cid))
      .filter((c): c is PlantComponent => c != null);
    d.health = worstHealth(comps.map((c) => c.health));
    d.messwertCount = comps.reduce((n, c) => n + c.channels.length, 0);
    d.summary = deviceSummary(d);
  }

  return {
    devices,
    components,
    newlyReported: newlyReported(localSetup, entities),
    effects: plantEffects(devices, components),
  };
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
