import { describe, expect, it } from 'vitest';
import { quellenDerMessstellenBuehne } from './messstelleQuellenFixtures';
import { MS_IDS } from './messstelleSeiteFixtures';
import { FIXTURE_IDS } from './standorteFixtures';

describe('Quellen-Antwort der Messstellen-Bühnen', () => {
  it('liefert MS-10 aus Halle 2 samt Quelle, ohne einen Zählerstand zu erfinden', () => {
    const q = quellenDerMessstellenBuehne(MS_IDS.ms10, '2026-11-21T09:20:00+01:00');
    expect(q.kennzeichen).toBe('MS-10');
    expect(q.groessen[0].fuehrend).toMatchObject({ anlage: FIXTURE_IDS.an2, geraet: { geraet: 'GR-7', einbau: 'C-1' }, letzter_wert: null });
    expect(q.quellen).toHaveLength(1);
  });

  it('lässt MS-21 ohne Datenquelle', () => {
    const q = quellenDerMessstellenBuehne(MS_IDS.ms21, '2026-11-04T12:00:00+01:00');
    expect(q.quellen).toEqual([]);
    expect(q.groessen[0]).toMatchObject({ groesse: 'Volumen', fuehrend: null });
  });

  it('bewahrt die Lücke zwischen Z-5a und Z-5b und zeigt keinen späteren Wert', () => {
    const luecke = quellenDerMessstellenBuehne(MS_IDS.ms06, '2026-11-18T10:43:00+01:00');
    expect(luecke.groessen[0].fuehrend).toBeNull();
    expect(luecke.quellen.map((q) => q.status)).toEqual(['beendet', 'geplant']);
    expect(luecke.quellen.map((q) => q.letzter_wert)).toEqual([null, null]);
    const danach = quellenDerMessstellenBuehne(MS_IDS.ms06, '2026-11-18T10:47:00+01:00');
    expect(danach.groessen[0].fuehrend).toMatchObject({ geraet: { einbau: 'Z-5b' }, letzter_wert: null });
  });

  it('weist eine unbekannte Messstelle zurück', () => {
    expect(() => quellenDerMessstellenBuehne('unbekannt', '2026-11-21T09:20:00+01:00')).toThrow('Messstelle der Bühne fehlt');
  });
});
