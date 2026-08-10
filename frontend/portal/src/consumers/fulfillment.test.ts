import { describe, expect, it } from 'vitest';
import {
  consumerStrip,
  fulfilmentSummary,
  overrideLine,
  sofortAktionen,
  startConsequences,
  taskLine,
  type FulfilmentTask,
  type ManualOverride,
  type StripConsumer,
} from './fulfillment';
import type { ConsumerRuntimeStatus } from './status';

function task(over: Partial<FulfilmentTask>): FulfilmentTask {
  return {
    requirementId: 'r',
    periodStart: '2026-08-10T00:00:00Z',
    deadline: '2026-08-10T22:00:00Z',
    state: 'pending',
    atRisk: false,
    ...over,
  };
}

describe('taskLine', () => {
  it('shows a runtime goal as min / min with the state word', () => {
    const l = taskLine(task({ state: 'fulfilled', requiredRuntimeSeconds: 3600, actualRuntimeSeconds: 5400 }));
    expect(l.text).toBe('Erfüllt');
    expect(l.progress).toBe('90 / 60 min');
    expect(l.tone).toBe('ok');
  });

  it('labels ASSUMED energy honestly, never "gemessen"', () => {
    const l = taskLine(task({ energyConfirmation: 'assumed', requiredEnergyKwh: 8, actualEnergyKwh: 4.5 }));
    expect(l.confirmation).toBe('angenommen (Nennleistung × Zeit)');
    expect(l.progress).toBe('4,5 / 8,0 kWh');
  });

  it('measured energy reads "gemessen"', () => {
    expect(taskLine(task({ energyConfirmation: 'measured' })).confirmation).toBe('gemessen');
  });

  it('a missed or at-risk task tones warn', () => {
    expect(taskLine(task({ state: 'missed' })).tone).toBe('warn');
    expect(taskLine(task({ state: 'running', atRisk: true })).tone).toBe('warn');
  });

  it('an unknown state word claims no text (never a guess)', () => {
    expect(taskLine(task({ state: 'weird_word' })).text).toBe('');
  });

  it('no goal → empty progress + no fabricated confirmation', () => {
    const l = taskLine(task({ requiredRuntimeSeconds: null, requiredEnergyKwh: null }));
    expect(l.progress).toBe('');
    expect(l.confirmation).toBe('');
  });
});

describe('fulfilmentSummary', () => {
  it('is empty (no headline) without recurring tasks', () => {
    expect(fulfilmentSummary({ tasks: [] }).headline).toBe('');
    expect(fulfilmentSummary(null).headline).toBe('');
  });

  it('leads with missed, then at-risk, then all-fulfilled', () => {
    expect(fulfilmentSummary({ tasks: [task({ state: 'missed' })] }).headline)
      .toBe('1 Aufgabe nicht erreicht');
    expect(fulfilmentSummary({ tasks: [task({ state: 'running', atRisk: true })] }).headline)
      .toBe('1 Frist gefährdet');
    expect(fulfilmentSummary({ tasks: [task({ state: 'fulfilled' }), task({ state: 'fulfilled' })] }).headline)
      .toBe('Alle Aufgaben erfüllt');
    expect(fulfilmentSummary({ tasks: [task({ state: 'fulfilled' }), task({ state: 'pending' })] }).headline)
      .toBe('1 von 2 Aufgaben erfüllt');
  });
});

describe('overrideLine', () => {
  const now = new Date('2026-08-10T20:00:00Z');
  it('names a running start override until its end time', () => {
    const o: ManualOverride = {
      entityId: 'e', kind: 'start', targetCommand: 'on_off', endsAt: '2026-08-10T20:30:00Z',
    };
    const line = overrideLine(o, now);
    expect(line?.text).toContain('gestartet bis');
    expect(line?.tone).toBe('warn');
  });

  it('is null for an expired override (never revived)', () => {
    const o: ManualOverride = {
      entityId: 'e', kind: 'stop', targetCommand: 'on_off', endsAt: '2026-08-10T19:00:00Z',
    };
    expect(overrideLine(o, now)).toBeNull();
    expect(overrideLine(null, now)).toBeNull();
  });
});

describe('sofortAktionen', () => {
  it('offers start+stop for a connected consumer, resume when an override runs', () => {
    expect(sofortAktionen({ connected: true, hasOverride: false })).toEqual(['start', 'stop']);
    expect(sofortAktionen({ connected: true, hasOverride: true })).toEqual(['resume']);
  });
  it('offers nothing for an unconnected consumer', () => {
    expect(sofortAktionen({ connected: false, hasOverride: false })).toEqual([]);
  });
});

describe('startConsequences', () => {
  it('names the effective power + the grid hint before acting', () => {
    const c = startConsequences(11);
    expect(c[0]).toContain('11,0 kW');
    expect(c[1]).toContain('Netz');
    expect(c.join(' ')).toContain('gespeicherte Regel bleibt unverändert');
  });
  it('degrades honestly without a known power', () => {
    expect(startConsequences(null)[0]).toContain('wirksamen Leistung');
  });
});

describe('consumerStrip', () => {
  const consumers: StripConsumer[] = [
    { id: 'a', name: 'Wallbox', ratedPowerKw: 11, connection: 'connected' },
    { id: 'b', name: 'Heizstab', ratedPowerKw: 3, connection: 'connected' },
  ];
  function st(over: Partial<ConsumerRuntimeStatus>): ConsumerRuntimeStatus {
    return { entityId: 'a', state: 'ready', reportedAt: '2026-08-10T20:00:00Z', ...over };
  }

  it('returns null without consumers (cockpit byte-identical to before)', () => {
    expect(consumerStrip([], [])).toBeNull();
    expect(consumerStrip(null, [])).toBeNull();
  });

  it('sums the measured powers and counts running/disturbed', () => {
    const v = consumerStrip(consumers, [
      st({ entityId: 'a', state: 'running_optimized', actualKw: 3 }),
      st({ entityId: 'b', state: 'running_forced', actualKw: 2.2 }),
    ])!;
    expect(v.sumKw).toBeCloseTo(5.2, 5);
    expect(v.running).toBe(2);
    expect(v.disturbed).toBe(0);
    expect(v.rows[0].text).toBe('Läuft · von VoltPilot geplant');
  });

  it('leaves the measured power null (never 0) for a consumer with no reading', () => {
    const v = consumerStrip(consumers, [st({ entityId: 'a', state: 'running_optimized', actualKw: 4 })])!;
    expect(v.rows[1].actualKw).toBeNull();
    expect(v.sumKw).toBeCloseTo(4, 5); // only the reporting one contributes
  });

  it('sum is null when nothing is measured', () => {
    expect(consumerStrip(consumers, [])!.sumKw).toBeNull();
  });

  it('counts a disturbed consumer (offline / unconfirmed)', () => {
    const v = consumerStrip(consumers, [
      st({ entityId: 'a', state: 'offline' }),
      st({ entityId: 'b', state: 'running_optimized', actualKw: 1, confirmed: false }),
    ])!;
    expect(v.disturbed).toBe(2);
  });
});
