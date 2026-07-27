/**
 * Pure derivation of the Anlage-Seite Gesundheits-Checklist (desktop Zone C):
 * the "ist sie gesund?" answer as a compact list - Gerät online, Fahrplan
 * aktiv, Steuerung ok, Speicher verknüpft. Each item is a plain-German label
 * plus a state (ok/warn/off) and a short detail; the component only renders it.
 * No React, no internal vocabulary. Unit-tested in health.test.ts.
 */
import type { ControlState } from './control';

export type HealthState = 'ok' | 'warn' | 'off';

export interface HealthItem {
  key: 'device' | 'plan' | 'control' | 'battery';
  label: string;
  state: HealthState;
  detail: string;
}

export interface HealthInput {
  deviceCount: number;
  onlineCount: number;
  waitingCount: number;
  /** The plan carries slots for today (the optimizer is actively planning). */
  hasPlanToday: boolean;
  /** Any plan at all exists for the site. */
  hasAnyPlan: boolean;
  /**
   * The control-strip state, or null when the site is not controllable / no
   * control signal exists (the item is then omitted).
   */
  controlState: ControlState | null;
  /** A battery asset exists but has no controlling device (silent failure). */
  batteryWithoutDevice: boolean;
  /** A battery is linked to a controlling device (the plan reaches it). */
  batteryLinked: boolean;
}

/**
 * The checklist, in priority order. Items that would be dishonest are omitted:
 * the battery row appears only when there IS a battery (linked or unlinked),
 * and the control row only when a control signal exists. Warnings sort before
 * healthy so a problem is never buried.
 */
export function healthChecklist(input: HealthInput): HealthItem[] {
  const items: HealthItem[] = [];

  // 1 · Gerät online.
  if (input.deviceCount === 0) {
    items.push({ key: 'device', label: 'Gerät', state: 'off', detail: 'noch nicht verbunden' });
  } else {
    const stale = input.deviceCount - input.onlineCount - input.waitingCount;
    if (stale > 0) {
      items.push({ key: 'device', label: 'Gerät', state: 'warn', detail: 'meldet sich nicht' });
    } else if (input.waitingCount > 0 && input.onlineCount === 0) {
      items.push({ key: 'device', label: 'Gerät', state: 'warn', detail: 'wartet auf erste Daten' });
    } else {
      items.push({
        key: 'device',
        label: input.deviceCount === 1 ? 'Gerät online' : 'Geräte online',
        state: 'ok',
        detail: input.deviceCount === 1 ? 'verbunden' : `${input.onlineCount}/${input.deviceCount} verbunden`,
      });
    }
  }

  // 2 · Fahrplan aktiv.
  if (input.hasPlanToday) {
    items.push({ key: 'plan', label: 'Fahrplan aktiv', state: 'ok', detail: 'für heute geplant' });
  } else if (input.hasAnyPlan) {
    items.push({ key: 'plan', label: 'Fahrplan', state: 'warn', detail: 'kein aktueller Plan' });
  } else {
    items.push({ key: 'plan', label: 'Fahrplan', state: 'off', detail: 'noch keiner erstellt' });
  }

  // 3 · Steuerung (only when a control signal exists).
  if (input.controlState) {
    items.push(controlItem(input.controlState));
  }

  // 4 · Speicher verknüpft (only when a battery is present at all).
  if (input.batteryWithoutDevice) {
    items.push({ key: 'battery', label: 'Speicher', state: 'warn', detail: 'keinem Gerät zugeordnet' });
  } else if (input.batteryLinked) {
    items.push({ key: 'battery', label: 'Speicher verknüpft', state: 'ok', detail: 'wird gesteuert' });
  }

  // Warnings first so a problem is visible at the top of the list.
  const rank: Record<HealthState, number> = { warn: 0, off: 1, ok: 2 };
  return items.sort((a, b) => rank[a.state] - rank[b.state]);
}

// ---------------------------------------------------------------------------
// Portal v3 · M1 — the ONE aggregated plant state for the shell's top bar
// ---------------------------------------------------------------------------

/** The three states of the shell health badge (concept tab 2). */
export type HealthBadgeState = 'ok' | 'hinweis' | 'warnung';

/** One non-OK finding, named in plain German ("Gerät: meldet sich nicht"). */
export interface HealthFinding {
  state: Exclude<HealthState, 'ok'>;
  text: string;
}

export interface HealthBadge {
  state: HealthBadgeState;
  /** The badge word itself. */
  label: string;
  /** The WORST finding, named in plain German; null = nothing to report. */
  detail: string | null;
  /**
   * EVERY current non-OK finding, worst first (`detail` is `findings[0]`).
   * A warning must be able to name its cause AND let the customer see the
   * rest in one click, so the badge carries the whole list - not just the
   * worst one hidden in a hover title.
   */
  findings: HealthFinding[];
}

/**
 * What the badge may know. Every fact is OPTIONAL and an ABSENT fact
 * contributes NOTHING — the shell composes the badge from data it already
 * holds (the "—" discipline: never invent a finding, and never claim health
 * about something that was not measured).
 */
export interface HealthBadgeInput {
  /** Device liveness of the Anlage; absent = unknown, no device finding. */
  devices?: { deviceCount: number; onlineCount: number; waitingCount: number } | null;
  /** Plan presence; absent = unknown, no Fahrplan finding. */
  plan?: { hasPlanToday: boolean; hasAnyPlan: boolean } | null;
  /** The control-strip state; absent/null = no control finding. */
  controlState?: ControlState | null;
  /** Battery link state; absent = unknown, no Speicher finding. */
  battery?: { withoutDevice: boolean; linked: boolean } | null;
  /**
   * v2 Soll/Ist drift (E1b): the device does not yet carry the current setup.
   * Absent/false = no finding — an un-migrated plant can never produce one.
   */
  entityDrift?: boolean | null;
}

/**
 * The facts only the Anlagen-Seite has measured (plan, control, battery link,
 * v2 drift). It reports them upward so the shell badge and the plant's own
 * Zustand card are ONE truth — before this the header ran on device liveness
 * alone and could disagree with the cockpit about the same Anlage.
 */
export type AnlageHealthFacts = Pick<
  HealthBadgeInput,
  'plan' | 'controlState' | 'battery' | 'entityDrift'
>;

/**
 * Value equality for the reported facts, so a re-render that measured the same
 * thing does not restate it upward (and the shell does not re-render for
 * nothing). Absent and present-but-equal are distinguished: `null` (unknown)
 * must never compare equal to a measured value.
 */
export function sameHealthFacts(a: AnlageHealthFacts, b: AnlageHealthFacts): boolean {
  const plan = (f: AnlageHealthFacts) =>
    f.plan ? `${f.plan.hasPlanToday}/${f.plan.hasAnyPlan}` : '-';
  const battery = (f: AnlageHealthFacts) =>
    f.battery ? `${f.battery.withoutDevice}/${f.battery.linked}` : '-';
  return (
    plan(a) === plan(b) &&
    battery(a) === battery(b) &&
    (a.controlState ?? null) === (b.controlState ?? null) &&
    (a.entityDrift ?? null) === (b.entityDrift ?? null)
  );
}

const BADGE_LABELS: Record<HealthBadgeState, string> = {
  ok: 'Alles in Ordnung',
  hinweis: 'Hinweis',
  warnung: 'Warnung',
};

/**
 * The aggregated plant state for the top bar: any `warn` finding makes it a
 * **Warnung**, any `off` finding a **Hinweis**, otherwise **OK**. It is
 * therefore never green while a device is silent. The detail names the worst
 * finding ("Gerät: meldet sich nicht"), so the badge says WHAT is wrong, not
 * just that something is.
 *
 * Reuses `healthChecklist` verbatim for the wording and then drops the rows
 * whose facts the caller did not supply — an empty input is honestly OK with
 * no invented detail.
 */
export function healthBadge(input?: HealthBadgeInput | null): HealthBadge {
  const facts = input ?? {};
  const items = healthChecklist({
    deviceCount: facts.devices?.deviceCount ?? 0,
    onlineCount: facts.devices?.onlineCount ?? 0,
    waitingCount: facts.devices?.waitingCount ?? 0,
    hasPlanToday: facts.plan?.hasPlanToday ?? false,
    hasAnyPlan: facts.plan?.hasAnyPlan ?? false,
    controlState: facts.controlState ?? null,
    batteryWithoutDevice: facts.battery?.withoutDevice ?? false,
    batteryLinked: facts.battery?.linked ?? false,
  }).filter((i) => {
    if (i.key === 'device') return facts.devices != null;
    if (i.key === 'plan') return facts.plan != null;
    if (i.key === 'battery') return facts.battery != null;
    return true;
  });

  const collected: HealthFinding[] = items
    .filter((i) => i.state !== 'ok')
    .map((i) => ({ state: i.state as Exclude<HealthState, 'ok'>, text: `${i.label}: ${i.detail}` }));

  if (facts.entityDrift) {
    collected.push({ state: 'off', text: 'Einstellungen: noch nicht auf dem Gerät' });
  }

  // `healthChecklist` already sorts warn before off; the drift row is appended
  // as an `off`, so a stable sort keeps warnings first either way.
  const findings = [
    ...collected.filter((f) => f.state === 'warn'),
    ...collected.filter((f) => f.state === 'off'),
  ];
  const worst = findings[0] ?? null;
  const state: HealthBadgeState = !worst ? 'ok' : worst.state === 'warn' ? 'warnung' : 'hinweis';
  return { state, label: BADGE_LABELS[state], detail: worst?.text ?? null, findings };
}

function controlItem(state: ControlState): HealthItem {
  switch (state) {
    case 'healthy':
      return { key: 'control', label: 'Steuerung ok', state: 'ok', detail: 'Sollwert bestätigt' };
    case 'mismatch':
      return { key: 'control', label: 'Steuerung', state: 'warn', detail: 'Abweichung gemeldet' };
    case 'stale':
      return { key: 'control', label: 'Steuerung', state: 'warn', detail: 'länger keine Bestätigung' };
    case 'preparing':
      return { key: 'control', label: 'Steuerung', state: 'off', detail: 'wird vorbereitet' };
    case 'off':
      return { key: 'control', label: 'Steuerung', state: 'off', detail: 'ausgeschaltet' };
    default: // pending
      return { key: 'control', label: 'Steuerung', state: 'off', detail: 'noch nicht freigegeben' };
  }
}
