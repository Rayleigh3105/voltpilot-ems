/**
 * Pure, unit-tested derivations for the "Geräte & Entitäten" surface (E1b).
 * The cloud registry is the Soll (what VoltPilot configured), the edge reports
 * its Ist back in the status heartbeat; drift is SURFACED here in plain German,
 * never silently resolved. Components only render what these functions decide.
 */
import type {
  EntityObserved,
  EntitySyncStatus,
  SiteEntities,
  SiteEntity,
} from './api';

/** One sync verdict rendered as a badge: tone + short + long copy. */
export interface SyncVerdict {
  tone: 'ok' | 'warn' | 'off' | 'pending';
  label: string;
  detail: string;
}

/**
 * The per-entity drift verdict, plain German. The five backend statuses map
 * onto four badge tones - "in sync" is the only green one; everything else is
 * an honest "not yet / not reported" state, never hidden.
 */
export function syncVerdict(status: EntitySyncStatus): SyncVerdict {
  switch (status) {
    case 'in_sync':
      return {
        tone: 'ok',
        label: 'Aktiv',
        detail: 'Das Gerät nutzt die aktuelle Konfiguration.',
      };
    case 'pending':
      return {
        tone: 'pending',
        label: 'Wird übernommen',
        detail: 'Die Konfiguration wurde geändert und erreicht das Gerät in Kürze.',
      };
    case 'missing_on_device':
      return {
        tone: 'warn',
        label: 'Noch nicht am Gerät',
        detail: 'Das Gerät ist online, hat diese Entität aber noch nicht übernommen.',
      };
    case 'unreported':
      return {
        tone: 'off',
        label: 'Keine Rückmeldung',
        detail: 'Das Gerät hat noch keinen Zustand gemeldet.',
      };
    case 'never_pushed':
    default:
      return {
        tone: 'off',
        label: 'Nicht ausgerollt',
        detail: 'Diese Anlage wurde noch nicht an das Gerät übertragen.',
      };
  }
}

/** True when the edge-Ist disagrees with the cloud-Soll and the customer
 *  should see a drift hint (a pending change or a not-yet-applied entity). */
export function hasDrift(status: EntitySyncStatus): boolean {
  return status === 'pending' || status === 'missing_on_device';
}

/** Health of the entity's live telemetry, plain German (null = no data yet). */
export function healthLabel(observed: EntityObserved | null): string {
  if (!observed) return 'Noch keine Daten';
  switch (observed.health) {
    case 'ok':
      return 'Liefert Daten';
    case 'stale':
      return 'Keine aktuellen Daten';
    case 'never':
    default:
      return 'Noch keine Daten';
  }
}

/** Health dot tone for the entity card. */
export function healthTone(observed: EntityObserved | null): 'ok' | 'warn' | 'off' {
  if (!observed || observed.health === 'never') return 'off';
  return observed.health === 'ok' ? 'ok' : 'warn';
}

/** The measure channels declared for an entity (for the read-only card). */
export function measureChannels(entity: SiteEntity): string[] {
  return (entity.capabilities?.measure ?? []).map((m) => m.channel);
}

/** The actuate commands declared for an entity. */
export function actuateCommands(entity: SiteEntity): string[] {
  return (entity.capabilities?.actuate ?? []).map((a) => a.command);
}

/** The contract's open channel vocabulary (CHANNEL_RE, edge-entity §2). */
const CHANNEL_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Parse a comma/space/newline-separated measure-channel list (the MB-M1
 * modbus-generic drawer editor, e.g. "leistung_kw, wasser_temp_c"). Returns
 * the deduplicated channel names, or null when any entry violates the open
 * channel vocabulary (klein geschrieben, Buchstaben/Ziffern/Unterstrich).
 * An empty input yields [].
 */
export function parseChannelList(text: string): string[] | null {
  const parts = text.split(/[\s,;]+/).filter((p) => p.length > 0);
  const channels: string[] = [];
  for (const part of parts) {
    if (!CHANNEL_PATTERN.test(part)) return null;
    if (!channels.includes(part)) channels.push(part);
  }
  return channels;
}

const GUARD_LIMIT_LABELS: Record<string, string> = {
  max_charge_kw: 'Max. Ladeleistung',
  max_discharge_kw: 'Max. Entladeleistung',
  soc_min_pct: 'Min. Ladestand',
  soc_max_pct: 'Max. Ladestand',
  max_generation_kw: 'Max. Erzeugung',
  max_consumption_kw: 'Max. Leistung',
  charge_from_grid_allowed: 'Netzladen erlaubt',
};

/** One guard limit rendered as a read-only label/value pair (German). */
export interface GuardRow {
  label: string;
  value: string;
}

/** The guard-config limits + failsafe as read-only rows for the card. */
export function guardRows(entity: SiteEntity): GuardRow[] {
  const rows: GuardRow[] = [];
  const limits = entity.guards?.limits ?? {};
  for (const [key, raw] of Object.entries(limits)) {
    const label = GUARD_LIMIT_LABELS[key] ?? key;
    if (typeof raw === 'boolean') {
      rows.push({ label, value: raw ? 'ja' : 'nein' });
    } else {
      const unit = key.endsWith('_pct') ? ' %' : ' kW';
      rows.push({ label, value: `${raw}${unit}` });
    }
  }
  const behavior = entity.guards?.failsafe?.behavior;
  if (behavior) {
    rows.push({ label: 'Rückfallverhalten', value: FAILSAFE_LABELS[behavior] ?? behavior });
  }
  return rows;
}

const FAILSAFE_LABELS: Record<string, string> = {
  'self-consumption': 'Eigenverbrauch',
  off: 'Aus',
  release: 'Freigeben',
  'measure-only': 'Nur messen',
};

/** German label for a failsafe behavior (used in the admin editor too). */
export function failsafeLabel(behavior: string): string {
  return FAILSAFE_LABELS[behavior] ?? behavior;
}

/** True when NO entities exist yet (drives the empty state). */
export function isEmpty(data: SiteEntities): boolean {
  return data.entities.length === 0 && data.localSetup.length === 0;
}

/**
 * The one-line fleet-style summary for the section header: how many entities,
 * how many are live, and whether any drift is pending. Null = empty (the
 * caller shows an empty state instead).
 */
export function entitiesSummary(data: SiteEntities): string | null {
  if (data.entities.length === 0) return null;
  const live = data.entities.filter((e) => e.observed?.health === 'ok').length;
  const drifting = data.entities.filter((e) => hasDrift(e.syncStatus)).length;
  const parts = [`${data.entities.length} ${data.entities.length === 1 ? 'Entität' : 'Entitäten'}`];
  parts.push(`${live} liefern Daten`);
  if (drifting > 0) {
    parts.push(`${drifting} wird noch übernommen`);
  }
  return parts.join(' · ');
}
