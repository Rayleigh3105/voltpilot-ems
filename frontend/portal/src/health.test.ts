import { describe, expect, it } from 'vitest';
import { healthBadge, healthChecklist, type HealthInput } from './health';

function input(over: Partial<HealthInput>): HealthInput {
  return {
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    hasPlanToday: true,
    hasAnyPlan: true,
    controlState: 'healthy',
    batteryWithoutDevice: false,
    batteryLinked: true,
    ...over,
  };
}

function byKey(items: ReturnType<typeof healthChecklist>, key: string) {
  return items.find((i) => i.key === key)!;
}

describe('healthChecklist', () => {
  it('a fully healthy plant reads all-ok', () => {
    const items = healthChecklist(input({}));
    expect(items.map((i) => i.key)).toEqual(
      expect.arrayContaining(['device', 'plan', 'control', 'battery']),
    );
    expect(items.every((i) => i.state === 'ok')).toBe(true);
    expect(byKey(items, 'device').label).toBe('Gerät online');
  });

  it('a silent device warns and sorts to the top', () => {
    const items = healthChecklist(input({ onlineCount: 0, deviceCount: 1 }));
    expect(items[0].key).toBe('device');
    expect(items[0].state).toBe('warn');
  });

  it('a battery without a device warns', () => {
    const items = healthChecklist(input({ batteryWithoutDevice: true, batteryLinked: false }));
    const b = byKey(items, 'battery');
    expect(b.state).toBe('warn');
    expect(b.detail).toContain('zugeordnet');
  });

  it('omits the battery row when there is no battery at all', () => {
    const items = healthChecklist(input({ batteryWithoutDevice: false, batteryLinked: false }));
    expect(items.find((i) => i.key === 'battery')).toBeUndefined();
  });

  it('omits the control row when there is no control signal', () => {
    const items = healthChecklist(input({ controlState: null }));
    expect(items.find((i) => i.key === 'control')).toBeUndefined();
  });

  it('a plan that is not current today warns; no plan at all is off', () => {
    expect(byKey(healthChecklist(input({ hasPlanToday: false, hasAnyPlan: true })), 'plan').state).toBe(
      'warn',
    );
    expect(byKey(healthChecklist(input({ hasPlanToday: false, hasAnyPlan: false })), 'plan').state).toBe(
      'off',
    );
  });

  it('maps a preparing control state to an honest off row', () => {
    const c = byKey(healthChecklist(input({ controlState: 'preparing' })), 'control');
    expect(c.state).toBe('off');
    expect(c.detail).toContain('vorbereitet');
  });
});

describe('healthBadge - the ONE aggregated plant state (v3 M1)', () => {
  it('is green only when every KNOWN fact is healthy', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 },
      plan: { hasPlanToday: true, hasAnyPlan: true },
      controlState: 'healthy',
      battery: { withoutDevice: false, linked: true },
    });
    expect(badge).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null });
  });

  it('goes to WARNUNG while a device is silent, and names the finding', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 0, waitingCount: 0 },
      plan: { hasPlanToday: true, hasAnyPlan: true },
    });
    expect(badge.state).toBe('warnung');
    expect(badge.label).toBe('Warnung');
    expect(badge.detail).toBe('Gerät: meldet sich nicht');
  });

  it('a warning beats a hinweis (the worst finding wins)', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 0, waitingCount: 0 },
      plan: { hasPlanToday: false, hasAnyPlan: false },
      battery: { withoutDevice: true, linked: false },
    });
    expect(badge.state).toBe('warnung');
    expect(badge.detail).toBe('Gerät: meldet sich nicht');
  });

  it('a missing plan alone is a HINWEIS, not a warning', () => {
    const badge = healthBadge({ plan: { hasPlanToday: false, hasAnyPlan: false } });
    expect(badge.state).toBe('hinweis');
    expect(badge.label).toBe('Hinweis');
    expect(badge.detail).toBe('Fahrplan: noch keiner erstellt');
  });

  it('an unknown fact contributes NOTHING (never an invented finding)', () => {
    // Devices unknown -> no device row, even though a "0 devices" default
    // would otherwise read as "noch nicht verbunden".
    expect(healthBadge({ plan: { hasPlanToday: true, hasAnyPlan: true } }).state).toBe('ok');
    // Battery unknown -> no Speicher row.
    expect(healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } })).toEqual({
      state: 'ok',
      label: 'Alles in Ordnung',
      detail: null,
    });
  });

  it('an empty / absent input is OK without an invented detail', () => {
    for (const arg of [{}, null, undefined] as const) {
      expect(healthBadge(arg)).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null });
    }
  });

  it('surfaces v2 Soll/Ist drift as a hinweis when it is known', () => {
    const badge = healthBadge({
      devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 },
      entityDrift: true,
    });
    expect(badge.state).toBe('hinweis');
    expect(badge.detail).toBe('Einstellungen: noch nicht auf dem Gerät');
    // Absent/false drift (an un-migrated plant) can never produce a finding.
    expect(healthBadge({ entityDrift: false }).state).toBe('ok');
    expect(healthBadge({ entityDrift: null }).detail).toBeNull();
  });

  it('reports a still-waiting device honestly', () => {
    const badge = healthBadge({ devices: { deviceCount: 1, onlineCount: 0, waitingCount: 1 } });
    expect(badge.state).toBe('warnung');
    expect(badge.detail).toBe('Gerät: wartet auf erste Daten');
  });

  it('reports a plant without any device as a hinweis', () => {
    const badge = healthBadge({ devices: { deviceCount: 0, onlineCount: 0, waitingCount: 0 } });
    expect(badge.state).toBe('hinweis');
    expect(badge.detail).toBe('Gerät: noch nicht verbunden');
  });
});
