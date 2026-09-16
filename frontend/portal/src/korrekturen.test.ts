import { describe, expect, it } from 'vitest';
import { aktionsGrund, datumZeit, ersatzAnfrage, formAus, lueckenZeitraum, methoden, periodenZahl, quelleDeckt, vorschauBalken } from './korrekturen';
import { korrekturQuellen, korrekturVorschau, LUECKE } from './test/korrekturFixtures';
const zone = 'Europe/Berlin';
const q = korrekturQuellen();
const f = () => ({ ...formAus(LUECKE.von, LUECKE.bis!, zone), grund: 'Box-Tausch nach Defekt; Energiekarte hat weitergezählt' });
describe('Ersatzwert-Methoden nach Lückenart', () => {
  it('a–c verteilen nur gemessenen Zuwachs, einschließlich null kWh', () => {
    expect(methoden(LUECKE, true)).toEqual(['gleichmaessig_verteilen', 'profil_vorperiode', 'profil_vergleichsquelle']);
    expect(methoden({ ...LUECKE, zuwachs: 0 }, false)).toEqual(['gleichmaessig_verteilen', 'profil_vorperiode']);
  });
  it('e–g übernehmen ohne Zuwachs, Vergleich nur mit zugeordneter Quelle', () => {
    expect(methoden({ ...LUECKE, zuwachs: null }, false)).toEqual(['wert_eingeben', 'vorperiode_uebernehmen']);
    expect(methoden(null, true)).toContain('vergleichsquelle_uebernehmen');
  });
  it.each(['counter_reset', 'device_boundary'] as const)('%s bietet d', art => expect(methoden({ ...LUECKE, art, zuwachs: null }, true)).toEqual(['ablesestand_nachtragen']));
  it('fasst eine nicht rastergenaue Lücke ein und setzt eine Grenze auf die vorherige Viertelstunde', () => {
    expect(lueckenZeitraum({ ...LUECKE, bis: '2026-11-03T16:31:00Z' }).bis).toBe('2026-11-03T16:45:00.000Z');
    expect(lueckenZeitraum({ ...LUECKE, art: 'counter_reset', von: '2026-11-03T13:15:00Z' }).von).toBe('2026-11-03T13:00:00.000Z');
  });
  it('begründet, deutsche Zahl, Beleg und ausschließlich die gewählte Methode', () => {
    const r = ersatzAnfrage({ ...f(), betrag: '2.304,0', beleg: 'Netzrechnung November 2026' }, q.quellen[0], null, zone, 'kWh', []);
    expect(r).toMatchObject({ eingabe: { betrag: 2304, einheit: 'kWh', methode: 'wert_eingeben', von: '2026-11-03T14:00:00+01:00' } });
    expect('eingabe' in r && r.eingabe).not.toHaveProperty('endstand');
  });
  it('Belegpflicht und fehlende Menge werden nicht als null kWh geschickt', () => {
    expect(ersatzAnfrage({ ...f(), betrag: '0' }, q.quellen[0], null, zone, 'kWh', [])).toMatchObject({ feld: 'beleg' });
    expect(ersatzAnfrage({ ...f(), beleg: 'Netzrechnung November' }, q.quellen[0], null, zone, 'kWh', [])).toMatchObject({ feld: 'betrag' });
  });
  it('hält verteilte Lücken vollständig und verbietet die Übernahme an ihrer Stelle', () => {
    expect(ersatzAnfrage({ ...f(), methode: 'gleichmaessig_verteilen' }, q.quellen[0], LUECKE, zone, 'kWh', [])).toMatchObject({ eingabe: { luecke_ereignis_id: LUECKE.id } });
    expect(ersatzAnfrage({ ...f(), methode: 'gleichmaessig_verteilen', bisZeit: '09:15' }, q.quellen[0], LUECKE, zone, 'kWh', [])).toMatchObject({ feld: 'vonTag' });
    expect(ersatzAnfrage(f(), q.quellen[0], LUECKE, zone, 'kWh', [])).toMatchObject({ feld: 'methode' });
  });
  it('Quellen müssen den Zeitraum decken', () => {
    expect(quelleDeckt({ ...q.quellen[0], gueltig_bis: LUECKE.von }, LUECKE.von, LUECKE.bis!)).toBe(false);
    expect(ersatzAnfrage({ ...f(), methode: 'vergleichsquelle_uebernehmen', vergleich: 'fremd' }, q.quellen[0], null, zone, 'kWh', q.quellen.slice(1))).toMatchObject({ feld: 'vergleich' });
  });
  it('Sommerzeitlücken und doppelte Uhrzeiten brauchen eine eindeutige Eingabe', () => {
    expect(datumZeit('2026-10-25T00:30:00Z', zone).zeit).toBe('02:30');
    expect(ersatzAnfrage({ ...f(), vonTag: '2026-10-25', vonZeit: '02:30' }, q.quellen[0], null, zone, 'kWh', [])).toHaveProperty('fehler');
  });
  it.each(['profil_vorperiode', 'profil_vergleichsquelle', 'vorperiode_uebernehmen', 'vergleichsquelle_uebernehmen'] as const)('%s schickt nur seinen Profilbezug', methode => {
    const verteilt = methode.startsWith('profil_');
    const r = ersatzAnfrage({ ...f(), methode, vergleich: q.quellen[1].id }, q.quellen[0], verteilt ? LUECKE : null, zone, 'kWh', q.quellen.slice(1));
    expect(r).toHaveProperty('eingabe');
    if ('eingabe' in r) {
      expect(r.eingabe.betrag).toBeUndefined();
      expect(Boolean(r.eingabe.luecke_ereignis_id)).toBe(verteilt);
      expect(Boolean(r.eingabe.vergleich_quelle_id)).toBe(methode.includes('vergleichsquelle'));
      expect(Boolean(r.eingabe.vorperiode_von)).toBe(methode.includes('vorperiode'));
    }
  });
  it('d trägt die Ablesung innerhalb der Viertelstunde, ohne eingegebene Menge', () => {
    const l = { ...LUECKE, art: 'counter_reset' as const, von: '2026-11-03T13:12:00Z', zuwachs: null };
    const z = lueckenZeitraum(l), t = datumZeit(l.von, zone);
    const r = ersatzAnfrage({ ...formAus(z.von, z.bis!, zone), methode: 'ablesestand_nachtragen', zeitTag: t.datum, zeitZeit: t.zeit,
      endstand: '6.184,90', anfangsstand: '0,00', grund: 'Protokoll Elektro Brunner' }, q.quellen[0], l, zone, 'kWh', []);
    expect(r).toMatchObject({ eingabe: { endstand: 6184.9, anfangsstand: 0, zeitpunkt: '2026-11-03T13:12:00Z' } });
  });
  it('gewählte Ereignisse behalten den eindeutigen Zeitpunkt in der doppelten Herbststunde', () => {
    const l = { ...LUECKE, von: '2026-10-25T00:30:00Z', bis: '2026-10-25T01:30:00Z' };
    const r = ersatzAnfrage({ ...formAus(l.von, l.bis, zone), methode: 'gleichmaessig_verteilen', grund: f().grund }, q.quellen[0], l, zone, 'kWh', []);
    expect(r).toMatchObject({ eingabe: { von: '2026-10-25T00:30:00.000Z', bis: '2026-10-25T01:30:00.000Z' } });
  });
  it('eine zweite Person ist ein Zustand und kein toter Knopf', () => expect(aktionsGrund({ erlaubt: false, grund: 'zweite_person_noetig' })).toContain('zweite Person'));
  it('kein Wert ist keine Null; Balken skalieren nur Serverwerte', () => {
    expect(periodenZahl(null, 'kWh')).toBe('Keine Werte'); expect(periodenZahl(0, 'kWh')).toBe('0 kWh');
    const b = vorschauBalken(korrekturVorschau().perioden); expect(b).toHaveLength(78); expect(b[0]).toMatchObject({ menge: 24, hoehe: 80 });
  });
});
