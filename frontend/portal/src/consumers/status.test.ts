/**
 * The pure reason_code/state → text table of the consumer live status
 * (Inkrement 3, D9: "Das Portal übersetzt reason_codes über eine reine,
 * getestete TS-Tabelle; keine Oberfläche durchsucht deutsche Sätze").
 */
import { describe, expect, it } from 'vitest';
import {
  CONSUMER_REASON_TEXT,
  CONSUMER_STATE_TEXT,
  consumerStatusLine,
  NOT_CONFIRMED_TEXT,
  STATUS_UNKNOWN_TEXT,
} from './status';

const entry = (over: Partial<Parameters<typeof consumerStatusLine>[0] & object> = {}) => ({
  entityId: 'e1',
  state: 'running_optimized',
  reportedAt: '2026-08-10T12:00:00Z',
  ...over,
});

describe('consumerStatusLine', () => {
  it('renders the §14.13 state sentence with the mapped reason', () => {
    const line = consumerStatusLine(entry({ state: 'waiting', reasonCode: 'guard_min_off' }));
    expect(line.text).toBe('Wartet auf passenden Zeitpunkt');
    expect(line.reason).toBe('Mindestpause des Geräts');
    expect(line.unconfirmed).toBe(false);
  });

  it('without evidence claims nothing: the unknown sentence', () => {
    expect(consumerStatusLine(undefined).text).toBe(STATUS_UNKNOWN_TEXT);
    expect(consumerStatusLine(null).text).toBe(STATUS_UNKNOWN_TEXT);
  });

  it('an unknown state WORD claims nothing (never a guessed text)', () => {
    const line = consumerStatusLine(entry({ state: 'turbo_mode' }));
    expect(line.text).toBe(STATUS_UNKNOWN_TEXT);
    expect(line.reason).toBe('');
  });

  it('an unknown reason word maps to no reason text', () => {
    const line = consumerStatusLine(entry({ reasonCode: 'weil_halt' }));
    expect(line.reason).toBe('');
    expect(line.text).toBe('Läuft · von VoltPilot geplant');
  });

  it('confirmed=false flags the execution disclaimer; absent claims nothing', () => {
    expect(consumerStatusLine(entry({ confirmed: false })).unconfirmed).toBe(true);
    expect(consumerStatusLine(entry({ confirmed: null })).unconfirmed).toBe(false);
    expect(consumerStatusLine(entry({})).unconfirmed).toBe(false);
    expect(NOT_CONFIRMED_TEXT).toBe('Ausführung nicht bestätigt');
  });

  it('tones: running ok, holds/limits warn, idle off', () => {
    expect(consumerStatusLine(entry({ state: 'running_forced' })).tone).toBe('ok');
    expect(consumerStatusLine(entry({ state: 'clamped' })).tone).toBe('warn');
    expect(consumerStatusLine(entry({ state: 'waiting' })).tone).toBe('off');
    expect(consumerStatusLine(entry({ confirmed: false })).tone).toBe('warn');
  });

  it('a device-started deadline run reads honestly (Increment 6)', () => {
    const line = consumerStatusLine({
      entityId: 'pump-1', state: 'running_optimized',
      reasonCode: 'flex_deadline_fallback', actualKw: 2.2, confirmed: true,
      reportedAt: '2026-08-10T21:00:00Z',
    });
    expect(line.text).toBe('Läuft · von VoltPilot geplant');
    expect(line.reason).toBe('Vom Gerät gestartet, damit die Frist hält');
    expect(line.tone).toBe('ok');
  });

  it('every §14.13 state and every §15 reason has a customer text', () => {
    // The ingest whitelist and this table must cover the same vocabulary -
    // a word the api stores but the portal cannot say would strand the
    // customer with an empty line.
    const states = ['disconnected', 'offline', 'ready', 'running_forced',
      'running_optimized', 'waiting', 'fulfilled', 'clamped', 'missed', 'unknown'];
    for (const s of states) {
      expect(CONSUMER_STATE_TEXT[s], `state ${s}`).toBeTruthy();
    }
    const reasons = ['vehicle_connected', 'fixed_window', 'price_below_threshold',
      'soc_above_threshold', 'flex_deadline', 'flex_deadline_fallback',
      'optimizer_selected_low_cost',
      'consumer_first', 'storage_first', 'guard_rated_power', 'guard_grid_limit',
      'device_offline', 'readback_mismatch', 'signal_stale',
      'guard_min_on', 'guard_min_off', 'guard_max_starts', 'guard_ramp',
      'guard_phase_switch', 'plan_stale'];
    for (const r of reasons) {
      expect(CONSUMER_REASON_TEXT[r], `reason ${r}`).toBeTruthy();
    }
  });
});
