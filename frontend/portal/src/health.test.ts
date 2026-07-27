import { describe, expect, it } from 'vitest';
import {
  healthBadge,
  healthChecklist,
  sameHealthFacts,
  type HealthInput,
} from './health';

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
    expect(badge).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null, findings: [] });
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
      findings: [],
    });
  });

  it('an empty / absent input is OK without an invented detail', () => {
    for (const arg of [{}, null, undefined] as const) {
      expect(healthBadge(arg)).toEqual({ state: 'ok', label: 'Alles in Ordnung', detail: null, findings: [] });
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

describe('the badge carries EVERY finding, not just the worst (portal-signal fix)', () => {
  it('lists all current findings, worst first, with detail === findings[0]', () => {
    const badge = healthBadge({
      devices: { deviceCount: 2, onlineCount: 1, waitingCount: 0 }, // stale -> warn
      plan: { hasPlanToday: false, hasAnyPlan: false }, // off
      controlState: 'pending', // off
      battery: { withoutDevice: true, linked: false }, // warn
      entityDrift: true, // off
    });
    expect(badge.state).toBe('warnung');
    // Warnings first, then the hints - so the popover reads worst-first too.
    expect(badge.findings.map((f) => f.text)).toEqual([
      'Gerät: meldet sich nicht',
      'Speicher: keinem Gerät zugeordnet',
      'Fahrplan: noch keiner erstellt',
      'Steuerung: noch nicht freigegeben',
      'Einstellungen: noch nicht auf dem Gerät',
    ]);
    expect(badge.findings.every((f) => f.state === 'warn' || f.state === 'off')).toBe(true);
    // The header's visible cause is exactly the first row of the popover.
    expect(badge.detail).toBe(badge.findings[0].text);
  });

  it('has no findings when nothing is wrong or nothing was measured', () => {
    expect(healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } }).findings)
      .toEqual([]);
    expect(healthBadge(null).findings).toEqual([]);
  });

  it('never invents a finding for a fact the caller did not supply', () => {
    // Only device data (the pre-fix header input): the Steuerung/Fahrplan/
    // Speicher rows must NOT appear, even as healthy ones.
    const badge = healthBadge({ devices: { deviceCount: 1, onlineCount: 1, waitingCount: 0 } });
    expect(badge.findings).toEqual([]);
    expect(badge.state).toBe('ok');
  });
});

describe('sameHealthFacts - unknown never equals measured', () => {
  it('is true for value-equal facts', () => {
    expect(
      sameHealthFacts(
        { plan: { hasPlanToday: true, hasAnyPlan: true }, controlState: 'healthy', battery: null },
        { plan: { hasPlanToday: true, hasAnyPlan: true }, controlState: 'healthy', battery: null },
      ),
    ).toBe(true);
  });

  it('separates absent from measured', () => {
    expect(sameHealthFacts({ battery: null }, { battery: { withoutDevice: false, linked: false } }))
      .toBe(false);
    expect(sameHealthFacts({ controlState: null }, { controlState: 'off' })).toBe(false);
    expect(sameHealthFacts({ plan: null }, { plan: { hasPlanToday: false, hasAnyPlan: false } }))
      .toBe(false);
  });
});
