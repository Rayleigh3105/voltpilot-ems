import { describe, expect, it } from 'vitest';
import { buildPolicyDocument, policySentence, reviewFacts, type BuildOptions } from './policy';
import type { ConsumerContext, ConsumerDraft } from './questions';
import { validatePolicy, isValid } from './validate';
import type { ControlProfileSnapshot } from './types';

const PROFILE: ControlProfileSnapshot = { control_kind: 'on_off', rated_power_kw: 3 };

function opts(over: Partial<BuildOptions> = {}): BuildOptions {
  return {
    entityId: 'heater-01',
    requirementId: 'r-1',
    ctx: { controlKind: 'on_off', hasStorage: false, hasMeasurementChannel: false },
    controlProfile: PROFILE,
    name: 'Heizstab',
    ...over,
  };
}

function draft(over: Partial<ConsumerDraft> = {}): ConsumerDraft {
  return {
    intent: 'react',
    conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }],
    combinator: 'and',
    recurrence: { days: 'daily', from: '13:00', to: '14:00' },
    demandMode: 'runtime',
    runtimeMinutes: 60,
    energyKwh: null,
    contiguous: true,
    target: { kind: 'on_off', value: true },
    enforcement: 'must_run',
    gridEnergyPolicy: 'allow',
    storageRelation: 'consumer_first',
    allowStorageDischarge: false,
    ...over,
  };
}

describe('buildPolicyDocument', () => {
  it('projects a reactive OR rule and validates clean', () => {
    const d = draft({
      intent: 'react',
      enforcement: 'must_run',
      combinator: 'or',
      conditions: [
        { signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 },
        { signal: 'storage.soc_pct', operator: 'gt', value: 80, resetValue: 75, maxAgeS: 30 },
      ],
    });
    const doc = buildPolicyDocument(d, opts());
    expect(isValid(validatePolicy(doc))).toBe(true);
    const r = doc.requirements[0];
    expect(r.kind).toBe('reactive');
    expect(r).not.toHaveProperty('grid_energy_policy'); // must_run omits it
    expect(r.condition).toEqual({
      any: [
        { signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 },
        { signal: 'storage.soc_pct', operator: 'gt', value: 80, reset_value: 75, max_age_s: 30 },
      ],
    });
  });

  it('never puts hysteresis on a cloud signal (D1)', () => {
    const d = draft({
      intent: 'react',
      conditions: [{ signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5, resetValue: 4, maxAgeS: 30 }],
    });
    const doc = buildPolicyDocument(d, opts());
    expect(doc.requirements[0].condition).toEqual({ signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 });
    expect(isValid(validatePolicy(doc))).toBe(true);
  });

  it('a fixed_window must_run rule carries recurrence and validates', () => {
    const d = draft({ intent: 'schedule', enforcement: 'must_run' });
    const doc = buildPolicyDocument(d, opts());
    expect(doc.requirements[0].kind).toBe('fixed_window');
    expect(doc.requirements[0].recurrence).toEqual({ days: 'daily', from: '13:00', to: '14:00' });
    expect(isValid(validatePolicy(doc))).toBe(true);
  });

  it('a flexible task is required_by_deadline with a demand', () => {
    const d = draft({ intent: 'deadline', demandMode: 'runtime', runtimeMinutes: 60, contiguous: true });
    const doc = buildPolicyDocument(d, opts({ ctx: { controlKind: 'on_off', hasStorage: false, hasMeasurementChannel: true } }));
    const r = doc.requirements[0];
    expect(r.kind).toBe('flexible_task');
    expect(r.enforcement).toBe('required_by_deadline');
    expect(r.demand).toEqual({ runtime_minutes: 60, contiguous: true });
    expect(isValid(validatePolicy(doc))).toBe(true);
  });

  it('a non-must_run rule carries the chosen grid policy; a storage site carries the discharge flag', () => {
    const d = draft({ intent: 'cheap', gridEnergyPolicy: 'forbid', allowStorageDischarge: true });
    const doc = buildPolicyDocument(d, opts({ ctx: { controlKind: 'on_off', hasStorage: true, hasMeasurementChannel: false } }));
    const r = doc.requirements[0];
    expect(r.grid_energy_policy).toBe('forbid');
    expect(r.allow_storage_discharge).toBe(true);
    expect(isValid(validatePolicy(doc))).toBe(true);
  });
});

describe('policySentence (matches the document)', () => {
  it('renders the §14.5 heater example sentence', () => {
    const d = draft({
      intent: 'react',
      enforcement: 'must_run',
      combinator: 'or',
      conditions: [
        { signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 },
        { signal: 'storage.soc_pct', operator: 'gt', value: 80 },
      ],
      allowStorageDischarge: false,
    });
    const doc = buildPolicyDocument(d, opts({ ctx: { controlKind: 'on_off', hasStorage: true, hasMeasurementChannel: false } }));
    const s = policySentence(doc, 'Heizstab');
    expect(s).toContain('Wenn der Börsenpreis unter 5 ct/kWh liegt oder der Speicher-Ladestand über 80 % liegt, schaltet VoltPilot Heizstab ein.');
    expect(s).toContain('Netzstrom ist erlaubt.');
    expect(s).toContain('Der Speicher darf dafür nicht entladen werden.');
    expect(s).toContain('Geräteschutz und Netzvorgaben bleiben wirksam.');
  });

  it('a flexible task carries the honest connection-loss note (§14.7)', () => {
    const d = draft({ intent: 'deadline', demandMode: 'runtime', runtimeMinutes: 60 });
    const doc = buildPolicyDocument(d, opts({ ctx: { controlKind: 'on_off', hasStorage: false, hasMeasurementChannel: true } }));
    expect(policySentence(doc, 'Stallpumpe')).toContain('Bei Verbindungsausfall kann diese Aufgabe entfallen.');
  });

  it('a wallbox percent target reads as a charge sentence', () => {
    const d = draft({
      intent: 'react',
      enforcement: 'must_run',
      conditions: [{ signal: 'consumer.vehicle_connected', operator: 'eq', value: true, maxAgeS: 20 }],
      target: { kind: 'percent', value: 100 },
    });
    const doc = buildPolicyDocument(d, opts({ entityId: 'wallbox-01', controlProfile: { control_kind: 'continuous', rated_power_kw: 11 } }));
    const s = policySentence(doc, 'Wallbox');
    expect(s).toContain('Wenn das Fahrzeug verbunden ist, betreibt VoltPilot Wallbox mit 100 %.');
  });
});

describe('reviewFacts (§14.7)', () => {
  it('names every auto-set fact incl. the not-activated state', () => {
    const d = draft({ intent: 'schedule', enforcement: 'must_run' });
    const doc = buildPolicyDocument(d, opts());
    const facts = reviewFacts(doc, 'Heizstab');
    const labels = facts.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['Verbraucher', 'Regel', 'Netzstrom', 'Aktivierung']));
    expect(facts.find((f) => f.label === 'Netzstrom')?.value).toBe('Netzstrom ist erlaubt.');
    expect(facts.find((f) => f.label === 'Aktivierung')?.value).toContain('Steuerung noch nicht aktiviert');
  });
});
