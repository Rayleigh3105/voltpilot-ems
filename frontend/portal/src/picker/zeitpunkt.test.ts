import { expect, it } from 'vitest';
import { lesen, ortszeit } from './zeitpunkt';
const zone = 'Europe/Berlin';
it('25.10.2026 02:30 ist doppelt und verlangt eine zur Ortszeit passende Wahl', () => {
  const e = { tag: '2026-10-25', zeit: '02:30', variante: null };
  const a = lesen(e, zone);
  expect(a.wert).toBeNull(); expect(a.varianten.map(v => v.label)).toEqual(['MESZ (UTC+02:00)', 'MEZ (UTC+01:00)']);
  for (const v of a.varianten) expect(lesen({ ...e, variante: v.value }, zone).wert).toBe(v.value);
  expect(lesen({ ...e, variante: '2025-10-26T02:30:00+02:00' }, zone).wert).toBeNull();
});
it.each(['2027-03-28', '2026-03-29'])('%s 02:30 existiert nicht', tag => {
  const a = lesen({ tag, zeit: '02:30', variante: null }, zone);
  expect(a.wert).toBeNull(); expect(a.fehler).toContain('gibt es an diesem Tag nicht'); expect(a.varianten).toEqual([]);
});
it('zeigt Standortzeit unabhängig von Browserzone und erhält den Versatz', () => {
  const e = ortszeit('2026-11-02T06:40:00Z', zone);
  expect(e.tag).toBe('2026-11-02'); expect(e.zeit).toBe('07:40');
  expect(lesen(e, zone).wert).toBe('2026-11-02T07:40:00+01:00');
});
it.each([{ tag: '2026-02-30', zeit: '12:00', variante: null }, { tag: '2026-02-20', zeit: '25:00', variante: null }])('rät keine ungültige Uhrzeit', e => expect(lesen(e, zone).wert).toBeNull());
