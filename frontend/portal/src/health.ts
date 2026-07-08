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
