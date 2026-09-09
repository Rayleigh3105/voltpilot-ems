import { describe, it, expect } from 'vitest';
import { initialOcppControl, withOcppLimit, ocppReadiness, type OcppControlView } from './ocppControl';

const now = Date.parse('2026-09-09T12:00:00Z');
function view(): OcppControlView {
  return { desired: { ...initialOcppControl(), revision: 3 }, observed: [{ deviceId: 'box', reportedAt: new Date(now).toISOString(),
    state: { revision: 3, enabled: true, authorization_mode: 'free', seen_tags: [], stations: [{ id: 'CP', connected: true,
      capabilities_read: true, profiles_accepted: true, connectors: [{ id: 1, reconciling: false, fresh_power: true, power_kw: 0,
        power_at: new Date(now).toISOString(), readback: 'ok', readback_at: new Date(now).toISOString() }] }] } }] };
}
const facts = (v: OcppControlView) => Object.fromEntries(ocppReadiness(v, 'CP', 1, now, 'box'));

describe('OCPP customer evidence', () => {
  it('distinguishes measured zero, absent power and old/future evidence', () => {
    const v = view(); expect(facts(v)['Leistungsmessung']).toBe('aktuell');
    const con = v.observed[0].state.stations[0].connectors[0];
    for (const timestamp of [undefined, new Date(now - 31_000).toISOString(), new Date(now + 1).toISOString()]) {
      con.power_at = timestamp; expect(facts(v)['Leistungsmessung']).toBe('fehlt oder veraltet');
    }
    v.observed[0].reportedAt = new Date(now - 91_000).toISOString();
    expect(facts(v)['Verbindung']).toBe('nicht aktuell bestätigt');
    expect(facts(v)['Transaktion']).toBe('nicht aktuell gemeldet');
  });
  it('does not claim a saved request has reached the box', () => {
    const v = view(); v.desired!.revision++;
    expect(facts(v)['Konfiguration']).toBe('Übernahme noch nicht bestätigt');
    v.observed[0].state.rejected_revision = 4;
    v.observed[0].state.rejection_reason = 'Stecker noch belegt';
    expect(facts(v)['Konfiguration']).toBe('Stecker noch belegt');
  });
  it('does not borrow confirmation from another box', () => {
    const v = view(); v.observed[0].deviceId = 'other';
    expect(facts(v)['Schutzprofile']).toBe('nicht bestätigt');
  });
  it('keeps restart reconciliation visible', () => {
    const v = view(); v.observed[0].state.stations[0].connectors[0].reconciling = true;
    expect(facts(v)['Transaktion']).toBe('Wiederanlauf wird abgeglichen');
  });
});

describe('bounded customer limits', () => {
  it('accepts a pause and decimal commas, replaces only the selected connector', () => {
    const p = withOcppLimit(initialOcppControl(), 'CP', 1, '7,4', '60', now);
    const next = withOcppLimit(p, 'CP', 2, '0', '1440', now);
    expect(next.limits.map((l) => l.limit_kw)).toEqual([7.4, 0]);
    expect(Date.parse(next.limits[1].expires_at) - now).toBe(86_400_000);
    const replaced = withOcppLimit(next, 'CP', 1, '3', '10', now);
    expect(replaced.limits).toHaveLength(2); expect(p.limits[0].limit_kw).toBe(7.4);
  });
  it.each([['', '60'], ['-1', '60'], ['Infinity', '60'], ['5', '0'], ['5', '1441']])('rejects power=%s duration=%s', (kw, minutes) => {
    expect(() => withOcppLimit(initialOcppControl(), 'CP', 1, kw, minutes, now)).toThrow();
  });
});
