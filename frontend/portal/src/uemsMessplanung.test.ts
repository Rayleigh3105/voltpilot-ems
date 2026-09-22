import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { UEMS_BEWERTUNG_SAETZE } from './glossar';
import { ortWahlen } from './messstelleDialog';
import { ahrenbergEinsaetze } from './test/bewertungFixtures';
import { ahrenbergMessabdeckung } from './test/messmittelFixtures';
import { ee8, mb1 } from './test/messplanungBuehne';
import { MB1_WORTLAUT, ms23, ms23Zeile } from './test/messplanungFixtures';
import { ortsbaumAhrenberg, ortsbaumLindach } from './test/ortsbaumFixtures';
import { ahrenbergHeute, FIXTURE_IDS } from './test/standorteFixtures';
import {
  bedarfAnfrage,
  bedarfeSortiert,
  bedarfPruefen,
  bedarfSatz,
  bedarfUnter,
  beobachtungWort,
  einsatzOptionen,
  geplantFuerText,
  groesseVorbelegung,
  kannEinloesen,
  leererBedarf,
  messbedarfAblehnung,
  nachStandort,
  restVorbelegung,
} from './uemsMessplanung';

const orte = ortWahlen(ahrenbergHeute(), { [FIXTURE_IDS.st1]: ortsbaumAhrenberg(), [FIXTURE_IDS.st2]: ortsbaumLindach() });

describe('Messplanung (AP-16 IP-20, §5.3, R5)', () => {
  it('erfassen: Wortlaut ist Pflicht, Ort/Größe/Frist optional; die Größe geht als „Wirkenergie · Bezug“', () => {
    expect(bedarfPruefen(leererBedarf('ee'))).toEqual({ wortlaut: 'Bitte beschreiben Sie, was gemessen werden soll.' });
    expect(bedarfPruefen(leererBedarf(''))).toHaveProperty('einsatz');
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: `  ${MB1_WORTLAUT} ` }))).toEqual({ wortlaut: MB1_WORTLAUT, ort: null, groesse: null, frist: null });
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: 'x', ort: 'G-1', groesse: 'Wirkenergie', richtung: 'Bezug', frist: '2027-03-31' })))
      .toEqual({ wortlaut: 'x', ort: 'G-1', groesse: 'Wirkenergie · Bezug', frist: '2027-03-31' });
  });

  it('einlösen: der Dialog liest die Größe zurück — auch den Wortlaut aus R5; Unbekanntes belegt er nicht vor', () => {
    expect(groesseVorbelegung('Wirkenergie · Bezug')).toMatchObject({ groesse: 'Wirkenergie', richtung: 'Bezug' });
    expect(groesseVorbelegung('Wirkenergie Bezug (kWh)')).toMatchObject({ groesse: 'Wirkenergie', richtung: 'Bezug' });
    expect(groesseVorbelegung('Wirkenergie')).toMatchObject({ groesse: 'Wirkenergie', richtung: '' });
    expect(groesseVorbelegung('Temperatur im Kühlraum')).toBeNull();
    expect(groesseVorbelegung(null)).toBeNull();
  });

  it('einlösen nur mit einer eingerichteten Messstelle — ein Entwurf ohne Ort löst nichts ein', () => {
    expect(kannEinloesen(ms23())).toBe(true);
    expect(kannEinloesen(ms23({ lebenszyklus: 'entwurf', fehlt: ['ort'] }))).toBe(false);
    expect(kannEinloesen(ms23({ lebenszyklus: 'archiviert' }))).toBe(false);
  });

  it('§5.7 „Messbedarf“: eingelöst durch MS-23 — keine Datenquelle seit 27.11.2026, nie eine 0', () => {
    const b = mb1({ zustand: 'eingeloest', messstelle: { id: ms23().id, kennzeichen: 'MS-23', name: 'Halle 1 Allgemein' } });
    expect(bedarfSatz(b, [ms23Zeile()])).toBe(
      'Messbedarf MB-1: Lüftung, Beleuchtung und Allgemeinstrom Halle 1 — eingelöst durch MS-23 Halle 1 Allgemein (keine Datenquelle seit 27.11.2026).',
    );
    expect(bedarfSatz(b, [ms23Zeile()])).toBe(UEMS_BEWERTUNG_SAETZE.messbedarf('MB-1', MB1_WORTLAUT, 'MS-23 Halle 1 Allgemein', 'keine Datenquelle seit 27.11.2026'));
    expect(bedarfSatz(b, [])).toBe('Messbedarf MB-1: Lüftung, Beleuchtung und Allgemeinstrom Halle 1 — eingelöst durch MS-23 Halle 1 Allgemein.');
    expect(beobachtungWort({ ...ms23Zeile(), beobachtung: { ...ms23Zeile().beobachtung!, seit: null } })).toBe('keine Datenquelle');
    expect(bedarfSatz(b, [ms23Zeile()])).not.toMatch(/\b0\b/);
    expect(bedarfSatz(mb1(), [])).toBeNull();
  });

  it('verworfen bleibt lesbar — mit Tag und Begründung, zuletzt in der Liste', () => {
    const v = mb1({ id: 'v', kennzeichen: 'MB-2', zustand: 'verworfen', begruendung: 'Zähler wirtschaftlich nicht sinnvoll', geaendert_am: '2026-12-02T10:00:00+01:00' });
    expect(bedarfSatz(v, [])).toBe('Verworfen am 02.12.2026: ‚Zähler wirtschaftlich nicht sinnvoll‘');
    const e = mb1({ id: 'e', kennzeichen: 'MB-3', zustand: 'eingeloest' });
    expect(bedarfeSortiert([v, e, mb1()]).map((b) => b.kennzeichen)).toEqual(['MB-1', 'MB-3', 'MB-2']);
  });

  it('die leise Zeile: Ort mit Namen, Größe, Frist, wer erfasst hat', () => {
    expect(bedarfUnter(mb1(), orte)).toBe('G-1 Halle 1 · Wirkenergie · Bezug · Frist 31.03.2027 · erfasst 27.11.2026 · Ines Kaltenbach');
    expect(bedarfUnter(mb1({ ort: 'X-9', groesse: null, frist: null }), orte)).toBe('X-9 · erfasst 27.11.2026 · Ines Kaltenbach');
  });

  it('Liste je Standort: G-1 gehört zu Werk Ahrenberg; ohne Ort steht eine eigene Gruppe am Ende', () => {
    const einsaetze = [...ahrenbergEinsaetze(), ee8()];
    const g = nachStandort([mb1({ id: 'o', kennzeichen: 'MB-2', ort: null }), mb1()], einsaetze, orte);
    expect(g.map((x) => [x.name, x.bedarfe.map((b) => b.bedarf.kennzeichen)])).toEqual([['Werk Ahrenberg', ['MB-1']], ['ohne Ort', ['MB-2']]]);
    expect(g[0].bedarfe[0].einsatz?.kennzeichen).toBe('EE-8');
  });

  it('aus der Rest-Zeile: der Wortlaut nennt den Rest, der Ort ist der Standort der Anlage; nur laufende Einsätze', () => {
    const an1 = ahrenbergMessabdeckung().je_ort.find((o) => o.kennzeichen === 'AN-1')!;
    const v = restVorbelegung(an1, ahrenbergHeute());
    expect(v.wortlaut).toMatch(/^Rest Halle 1: 54\.580 kWh \(39,2 % der Anlage\) — keinem Energieeinsatz zugeordnet$/);
    expect(v.ort).toBe('ST-1');
    expect(restVorbelegung(an1, null).ort).toBe('');
    const beendet = { ...ee8(), gueltig_bis: '2026-12-31' };
    expect(einsatzOptionen([ee8(), beendet]).map((o) => o.label)).toEqual(['EE-8 Gebäudetechnik Halle 1']);
  });

  it('Messstellen-Seite: „geplant für EE-8 …“ nur mit eingelöstem Bedarf', () => {
    expect(geplantFuerText(ms23Zeile())).toBe('geplant für EE-8 Gebäudetechnik Halle 1');
    expect(geplantFuerText(ms23Zeile(false))).toBeNull();
    expect(geplantFuerText({ ...ms23Zeile(), geplant_fuer_einsaetze: undefined })).toBeNull();
  });

  it('Ablehnungen der IP-19-Routen werden zum Satz mit Weg', () => {
    const a = (status: number, code: string) => new ApiError(status, 'x', { code });
    expect(messbedarfAblehnung(a(422, 'messstelle_nicht_eingerichtet'))).toMatch(/noch nicht eingerichtet/);
    expect(messbedarfAblehnung(a(409, 'messbedarf_abgeschlossen'))).toMatch(/schon eingelöst oder verworfen/);
    expect(messbedarfAblehnung(a(422, 'begruendung_fehlt'))).toMatch(/begründen/);
    expect(messbedarfAblehnung(a(403, 'recht_fehlt'))).toBe('Das dürfen Kundenadministratoren und Energiemanager.');
  });
});
