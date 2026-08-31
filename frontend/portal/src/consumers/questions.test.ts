import { describe, expect, it } from 'vitest';
import {
  consumerHasMeasurement,
  consumerQuestions,
  moreSettings,
  standardStepCount,
  type ConsumerContext,
  type ConsumerDraft,
  type Intent,
  type Question,
  type QuestionKind,
  SG_READY_TYPE, consumerNachweis, NACHWEIS_FREIGABE,
} from './questions';

function ctx(over: Partial<ConsumerContext> = {}): ConsumerContext {
  return { controlKind: 'on_off', hasStorage: false, hasMeasurementChannel: false, ...over };
}

function draft(over: Partial<ConsumerDraft> = {}): ConsumerDraft {
  return {
    intent: null,
    conditions: [],
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

function kinds(qs: Question[]): QuestionKind[] {
  return qs.map((q) => q.kind);
}

describe('consumerQuestions', () => {
  it('yields nothing until an intent is chosen', () => {
    expect(consumerQuestions(ctx(), draft({ intent: null }))).toEqual([]);
  });

  it('a single condition shows NO UND/ODER question; a second one shows it', () => {
    const one = draft({
      intent: 'react',
      conditions: [{ signal: 'consumer.vehicle_connected', operator: 'eq', value: true }],
    });
    expect(kinds(consumerQuestions(ctx(), one))).not.toContain('combinator');

    const two = draft({
      intent: 'react',
      conditions: [
        { signal: 'consumer.vehicle_connected', operator: 'eq', value: true },
        { signal: 'storage.soc_pct', operator: 'gt', value: 80 },
      ],
    });
    expect(kinds(consumerQuestions(ctx(), two))).toContain('combinator');
  });

  it('a price condition asks which price (Börse/Bezug)', () => {
    const d = draft({
      intent: 'cheap',
      enforcement: 'must_run',
      conditions: [{ signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 }],
    });
    expect(kinds(consumerQuestions(ctx(), d))).toContain('price-basis');
  });

  it('without a storage there is neither storage order nor discharge freigabe', () => {
    const d = draft({ intent: 'react', conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }] });
    const k = kinds(consumerQuestions(ctx({ hasStorage: false }), d));
    expect(k).not.toContain('storage-relation');
    expect(k).not.toContain('storage-discharge');
  });

  it('a storage site asks both storage questions (D6 required)', () => {
    const d = draft({ intent: 'react', conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }] });
    const k = kinds(consumerQuestions(ctx({ hasStorage: true }), d));
    expect(k).toContain('storage-relation');
    expect(k).toContain('storage-discharge');
  });

  it('a Pflichtlauf shows Netzstrom as a FACT note, never an editable grid question', () => {
    const mustRun = draft({ intent: 'schedule', enforcement: 'must_run' });
    const k = kinds(consumerQuestions(ctx(), mustRun));
    expect(k).toContain('grid-allowed-note');
    expect(k).not.toContain('grid-policy');
  });

  it('a flexible/opportunistic rule offers the editable grid policy', () => {
    const flex = draft({ intent: 'deadline' });
    const k = kinds(consumerQuestions(ctx({ hasMeasurementChannel: true }), flex));
    expect(k).toContain('grid-policy');
    expect(k).not.toContain('grid-allowed-note');
  });

  it('a runtime task offers am-Stück/aufteilbar; a pure energy task does not', () => {
    const runtime = draft({ intent: 'deadline', demandMode: 'runtime' });
    expect(kinds(consumerQuestions(ctx({ hasMeasurementChannel: true }), runtime))).toContain('contiguous');

    const energy = draft({ intent: 'deadline', demandMode: 'energy' });
    const k = kinds(consumerQuestions(ctx({ hasMeasurementChannel: true }), energy));
    expect(k).toContain('energy');
    expect(k).not.toContain('contiguous');
  });

  it('a kWh goal without a measurement channel becomes the honest note (D3)', () => {
    const energy = draft({ intent: 'deadline', demandMode: 'energy' });
    const qs = consumerQuestions(ctx({ hasMeasurementChannel: false }), energy);
    expect(kinds(qs)).toContain('no-measurement-note');
    expect(kinds(qs)).not.toContain('energy');
    const note = qs.find((q) => q.kind === 'no-measurement-note');
    expect(note?.note).toBe('Ohne Messung kann VoltPilot die Erfüllung nicht nachweisen.');
  });

  it('the target question shape follows the control kind', () => {
    const d = draft({ intent: 'react', conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }] });
    expect(consumerQuestions(ctx({ controlKind: 'on_off' }), d).find((q) => q.kind === 'target')?.label)
      .toBe('Ein oder aus?');
    expect(consumerQuestions(ctx({ controlKind: 'stepped' }), d).find((q) => q.kind === 'target')?.label)
      .toBe('Auf welche Stufe?');
    expect(consumerQuestions(ctx({ controlKind: 'continuous' }), d).find((q) => q.kind === 'target')?.label)
      .toBe('Mit welcher Leistung?');
  });

  it('local-signal conditions expose a hysteresis field under "Weitere Einstellungen"', () => {
    const d = draft({ intent: 'react', conditions: [{ signal: 'storage.soc_pct', operator: 'gt', value: 80 }] });
    const more = moreSettings(ctx(), d);
    expect(kinds(more)).toContain('hysteresis');
    // A cloud-only price condition carries no hysteresis (D1).
    const price = draft({ intent: 'react', enforcement: 'must_run',
      conditions: [{ signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 }] });
    expect(kinds(moreSettings(ctx(), price))).not.toContain('hysteresis');
  });

  it('Schritt X von Y counts the standard questions dynamically', () => {
    const react = draft({ intent: 'react', enforcement: 'must_run',
      conditions: [{ signal: 'consumer.available', operator: 'eq', value: true }] });
    const withStorage = standardStepCount(ctx({ hasStorage: true }), react);
    const withoutStorage = standardStepCount(ctx({ hasStorage: false }), react);
    expect(withStorage).toBeGreaterThan(withoutStorage);
  });

  it('reachability: every capability is reachable via a standard question OR "Weitere Einstellungen"', () => {
    const reached = new Set<QuestionKind>();
    const contexts = [
      ctx({ controlKind: 'on_off', hasStorage: false, hasMeasurementChannel: false }),
      ctx({ controlKind: 'stepped', hasStorage: true, hasMeasurementChannel: true }),
      ctx({ controlKind: 'continuous', hasStorage: true, hasMeasurementChannel: true }),
    ];
    const intents: Intent[] = ['react', 'schedule', 'deadline', 'cheap'];
    for (const c of contexts) {
      for (const intent of intents) {
        for (const enforcement of ['must_run', 'opportunistic'] as const) {
          for (const demandMode of ['runtime', 'energy'] as const) {
            const d = draft({
              intent,
              enforcement,
              demandMode,
              conditions: [
                { signal: 'market.spot_price_ct_kwh', operator: 'lt', value: 5 },
                { signal: 'storage.soc_pct', operator: 'gt', value: 80 },
              ],
            });
            for (const q of consumerQuestions(c, d)) reached.add(q.kind);
          }
        }
      }
    }
    const all: QuestionKind[] = [
      'conditions', 'combinator', 'price-basis', 'target', 'recurrence', 'runtime',
      'contiguous', 'energy', 'enforcement', 'grid-policy', 'grid-allowed-note',
      'no-measurement-note', 'storage-relation', 'storage-discharge', 'hysteresis',
    ];
    for (const k of all) {
      expect(reached, `capability ${k} must be reachable`).toContain(k);
    }
  });
});

describe('consumerHasMeasurement (D3 - die Ink1-Regel folgt dem Gerät)', () => {
  it('folgt dem server-abgeleiteten Bestätigungskanal, wenn er vorliegt', () => {
    // Stufe 2: ein messender Shelly (1PM/Plug S) / eine go-e Wallbox.
    expect(consumerHasMeasurement({ type: 'heating-rod', confirmationChannel: 'power_kw' }))
      .toBe(true);
    expect(consumerHasMeasurement({ type: 'generic-load', confirmationChannel: 'energy_kwh' }))
      .toBe(true);
    // Stufe 3: ein Shelly OHNE Messung - kWh-Ziele verschwinden ehrlich,
    // obwohl der TYP heating-rod per Heuristik messen "würde".
    expect(consumerHasMeasurement({ type: 'heating-rod', confirmationChannel: 'relay_state' }))
      .toBe(false);
  });

  it('fällt ohne Kanal auf die Typ-Heuristik zurück (unbekannt ist nie "nein")', () => {
    expect(consumerHasMeasurement({ type: 'heating-rod' })).toBe(true);
    expect(consumerHasMeasurement({ type: 'wallbox', confirmationChannel: null })).toBe(true);
    expect(consumerHasMeasurement({ type: 'house-load', confirmationChannel: null })).toBe(false);
  });

  it('ein nicht messender Verbraucher bekommt statt der kWh-Frage den ehrlichen Satz', () => {
    const qs = consumerQuestions(
      ctx({ hasMeasurementChannel: consumerHasMeasurement({
        type: 'heating-rod', confirmationChannel: 'relay_state' }) }),
      draft({ intent: 'deadline', demandMode: 'energy' }),
    );
    const note = qs.find((q) => q.kind === 'no-measurement-note');
    expect(note?.note).toContain('Ohne Messung');
    expect(qs.some((q) => q.kind === 'energy')).toBe(false);
  });
});

describe('SG-Ready-Wärmepumpe: die Freigabe ist der Nachweis (P8)', () => {
  it('misst NIE - auch nicht an einem messenden Gerät', () => {
    expect(consumerHasMeasurement({ type: SG_READY_TYPE })).toBe(false);
    expect(consumerHasMeasurement({ type: SG_READY_TYPE, confirmationChannel: 'freigabe' }))
      .toBe(false);
    // ⚠ Der harte Fall: der gebundene Shelly meldet power_kw - über den Strom
    // der Wärmepumpe sagt sein potentialfreier Kontakt trotzdem nichts.
    expect(consumerHasMeasurement({ type: SG_READY_TYPE, confirmationChannel: 'power_kw' }))
      .toBe(false);
  });

  it('trägt die eigene Nachweisart, und der Kontrast bleibt unverändert', () => {
    expect(consumerNachweis({ type: SG_READY_TYPE })).toBe('freigabe');
    expect(consumerNachweis({ type: SG_READY_TYPE, confirmationChannel: 'power_kw' }))
      .toBe('freigabe');
    // Ein anderer Typ MIT dem Kanal `freigabe` (ein älterer Datensatz) liest
    // sich ebenso ehrlich - der Kanal ist die Server-Wahrheit.
    expect(consumerNachweis({ type: 'generic-load', confirmationChannel: 'freigabe' }))
      .toBe('freigabe');

    expect(consumerNachweis({ type: 'heating-rod', confirmationChannel: 'power_kw' }))
      .toBe('gemessen');
    expect(consumerNachweis({ type: 'heating-rod', confirmationChannel: 'relay_state' }))
      .toBe('angenommen');
    // ⚠ Ohne Kanal wird NICHTS behauptet, wo der Typ nichts hergibt.
    expect(consumerNachweis({ type: 'modbus-load' })).toBeNull();
    expect(consumerNachweis({ type: 'heating-rod' })).toBe('gemessen');
  });

  it('sagt, was es nachweisen kann - und was nicht', () => {
    expect(NACHWEIS_FREIGABE).toContain('nur die Freigabe');
    expect(NACHWEIS_FREIGABE).toContain('nicht den Verbrauch');
  });
});
