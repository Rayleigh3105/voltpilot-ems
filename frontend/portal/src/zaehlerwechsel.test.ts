import { describe, expect, it } from 'vitest';
import { ablesestandWert, ableseEinheit, wechselAbzeichen, wechselBerichtsfolge, wechselEingabe, wechselFolgen, wechselMarken, wechselPruefen, wechselZeit } from './zaehlerwechsel';
import { wechselAntwort, wechselKanaele, WECHSEL_AM, WECHSEL_JETZT } from './test/zaehlerwechselFixtures';

describe('Zählerwechsel: Tatsachen statt Verbrauchsrechnung', () => {
  it('liest den AP-09-IP-10-Übergabefall 1.234,5', () => expect(ablesestandWert('1.234,5')).toBe(1234.5));
  it('spricht Zeitpunkt, beide Einbauten, Endstand und Rückwirkung der Antwort wörtlich', () => {
    const saetze = wechselFolgen(wechselAntwort(), 'Europe/Berlin');
    expect(saetze).toContain('Zählerwechsel am 18.11.2026 10:40: Z-5a → Z-5b');
    expect(saetze).toContain('Z-5a: Endstand 1.083.415,2 kWh.');
    expect(saetze).toContain('Z-5b: Anfangsstand 0 kWh.');
    expect(saetze).toContain('Eintrag: rückwirkend (25 min).');
    expect(saetze.join(' ')).not.toMatch(/53.100|55.100|7 min|Berichte/);
  });
  it('benutzt geänderte Serverfakten und behauptet keine fehlende Marke oder Ablesung', () => {
    const v = wechselAntwort();
    v.bindungen[0].beendet.endstand = null;
    v.marken = 0; v.einstellungen = [];
    v.geraet.neu.einbau = 'Z-5c';
    v.rueckwirkung = { art: 'angekuendigt', minuten: 10, abzeichen: null };
    const saetze = wechselFolgen(v, 'Europe/Berlin').join(' ');
    expect(saetze).toContain('Z-5a → Z-5c');
    expect(saetze).toContain('Eintrag: angekündigt.');
    expect(saetze).toContain('nicht in allen Komponenten-Verläufen');
    expect(saetze).not.toMatch(/Endstand|rückwirkend|Einstellungen wurden/);
  });
  it('spricht nur gespeicherte Wechselmarken über den Ereignissatz', () => {
    const e = { revision: 1, effectiveAt: WECHSEL_AM, createdAt: WECHSEL_JETZT, fromValue: 'Z-5a', toValue: 'Z-5b', eventType: 'device_replaced' };
    expect(wechselMarken([e, e, { ...e, eventType: 'family_changed' }], 'Europe/Berlin'))
      .toEqual(['Zählerwechsel am 18.11.2026 10:40: Z-5a → Z-5b']);
    expect(wechselMarken([{ ...e, toValue: null }], 'Europe/Berlin')).toEqual([]);
  });
  it('A3: ursprüngliche Ankündigung bleibt neben der Berichtigung lesbar', () => {
    const vorher = '2026-11-18T10:00:00+01:00';
    const e = { revision: 1, effectiveAt: vorher, createdAt: '2026-11-10T09:00:00+01:00',
      fromValue: 'Z-5a', toValue: 'Z-5b', eventType: 'device_replaced' };
    const korrektur = { ...e, eventType: 'edited', fromValue: vorher, toValue: WECHSEL_AM,
      effectiveAt: WECHSEL_AM, note: 'Zeitpunkt berichtigt: 10:00 → 10:40' };
    expect(wechselMarken([e, korrektur], 'Europe/Berlin')).toEqual([
      'Zeitpunkt berichtigt: 18.11.2026 10:00 → 18.11.2026 10:40',
      'Zählerwechsel am 18.11.2026 10:00: Z-5a → Z-5b',
    ]);
  });
  it('zeigt Rückwirkung und angekündigt aus dem Vertragszwilling', () => {
    expect(wechselAbzeichen(WECHSEL_AM, WECHSEL_JETZT)).toBe('rückwirkend (25 min)');
    expect(wechselAbzeichen(WECHSEL_JETZT, WECHSEL_AM)).toBe('angekündigt');
  });
  it('nennt für A2 die abgeschlossenen Tagesberichte zwischen Wirkung und spätem Eintrag', () => {
    expect(wechselBerichtsfolge(WECHSEL_AM, '2026-11-20T09:00:00+01:00', 'Europe/Berlin'))
      .toBe('Berichte mit dem 18.–20.11.: Tagesberichte 18./19.11. (Berichtsentwurf).');
    expect(wechselBerichtsfolge(WECHSEL_AM, WECHSEL_JETZT, 'Europe/Berlin')).toBeNull();
  });
  it('nimmt die Standortzone, einschließlich nicht vorhandener und doppelter Stunde', () => {
    expect(wechselEingabe(WECHSEL_JETZT, 'America/New_York')).toMatchObject({ datum: '2026-11-18', uhrzeit: '05:05' });
    expect(wechselZeit('2026-11-18', '10:40', 'America/New_York')).toEqual({ iso: '2026-11-18T10:40:00-05:00' });
    expect(wechselZeit('2026-03-29', '02:30', 'Europe/Berlin')).toHaveProperty('fehler');
    expect(wechselZeit('2026-10-25', '02:30', 'Europe/Berlin')).toHaveProperty('fehler');
  });
  it('übernimmt keine alte Seriennummer und sendet Ablesestände nur mit einer eindeutigen Einheit', () => {
    const e = wechselEingabe(WECHSEL_JETZT, 'Europe/Berlin');
    expect(wechselPruefen(e, 'Europe/Berlin', null).body).toMatchObject({ neues_geraet: { seriennummer: null }, endstand_vorgaenger: null });
    e.endstand = '1.083.415,2'; e.anfangsstand = '0,0';
    expect(wechselPruefen(e, 'Europe/Berlin', 'kWh').body).toMatchObject({ endstand_vorgaenger: { wert: 1083415.2, einheit: 'kWh' }, anfangsstand: { wert: 0, einheit: 'kWh' } });
    expect(wechselPruefen(e, 'Europe/Berlin', null).body).toBeNull();
    expect(ableseEinheit(wechselKanaele().messkanaele)).toBe('kWh');
    expect(ableseEinheit([...wechselKanaele().messkanaele, ...wechselKanaele().messkanaele])).toBeNull();
  });
  it('prüft das Einbau-Kennzeichen wie die vorhandene Route', () => {
    const e = wechselEingabe(WECHSEL_JETZT, 'Europe/Berlin');
    expect(wechselPruefen({ ...e, kennzeichen: 'Z-5b_2' }, 'Europe/Berlin', null).body).not.toBeNull();
    expect(wechselPruefen({ ...e, kennzeichen: '-Z5' }, 'Europe/Berlin', null).body).toBeNull();
    expect(wechselPruefen({ ...e, kennzeichen: 'Ä5' }, 'Europe/Berlin', null).body).toBeNull();
  });
  it.each(['-1', 'keine Zahl'])('weist unzulässigen Stand %s zurück', endstand => {
    const e = { ...wechselEingabe(WECHSEL_JETZT, 'Europe/Berlin'), endstand };
    expect(wechselPruefen(e, 'Europe/Berlin', 'kWh').fehler.endstand).toBeTruthy();
  });
});
