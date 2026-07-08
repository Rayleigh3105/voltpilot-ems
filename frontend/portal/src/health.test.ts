import { describe, expect, it } from 'vitest';
import { healthChecklist, type HealthInput } from './health';

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
