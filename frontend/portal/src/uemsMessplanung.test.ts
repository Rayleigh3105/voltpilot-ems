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
  bearbeitenVorbelegung,
  bedarfAnfrage,
  bedarfeSortiert,
  bedarfPruefen,
  bedarfSatz,
  bedarfUnter,
  beobachtungWort,
  einloesenVorbelegung,
  einsatzOptionen,
  geplantFuerText,
  groesseVorbelegung,
  kannEinloesen,
  leererBedarf,
  messbedarfAblehnung,
  nachStandort,
  ortText,
  protokollZeilen,
  restVorbelegung,
} from './uemsMessplanung';

const orte = ortWahlen(ahrenbergHeute(), { [FIXTURE_IDS.st1]: ortsbaumAhrenberg(), [FIXTURE_IDS.st2]: ortsbaumLindach() });
const g1 = orte.find((o) => o.kurzzeichen === 'G-1')!;
/** Ein strukturierter Ort an einem anderen Standort, als der Wortlaut vermuten ließe — die Struktur gewinnt. */
const ziel = { id: 'o-g2', art: 'gebaeude' as const, kurzzeichen: 'G-2', name: 'Werkhalle Lindach', standort_id: 'st-2', standort_name: 'Werkhalle Lindach' };

describe('Messplanung (AP-16 IP-20, §5.3, R5)', () => {
  it('erfassen: Wortlaut ist Pflicht, Ort/Größe/Frist optional; die Größe geht als „Wirkenergie · Bezug“', () => {
    expect(bedarfPruefen(leererBedarf('ee'))).toEqual({ wortlaut: 'Bitte beschreiben Sie, was gemessen werden soll.' });
    expect(bedarfPruefen(leererBedarf(''))).toHaveProperty('einsatz');
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: `  ${MB1_WORTLAUT} ` }))).toEqual({
      wortlaut: MB1_WORTLAUT, ort: null, groesse: null, frist: null, ort_id: null, messgroesse: null, richtung: null,
    });
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: 'x', ort: 'G-1', groesse: 'Wirkenergie', richtung: 'Bezug', frist: '2027-03-31' }), orte))
      .toEqual({ wortlaut: 'x', ort: 'G-1', groesse: 'Wirkenergie · Bezug', frist: '2027-03-31', ort_id: g1.id, messgroesse: 'Wirkenergie', richtung: 'Bezug' });
  });

  it('AP-16 P1: die Struktur geht mit — Ort als ID aus den Ortsbäumen, Größe und Richtung aus dem Katalog', () => {
    const st1 = orte.find((o) => o.kurzzeichen === 'ST-1')!;
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: 'x', ort: 'ST-1', groesse: 'Wirkleistung' }), orte)).toMatchObject({
      ort: 'ST-1', ort_id: st1.id, groesse: 'Wirkleistung', messgroesse: 'Wirkleistung', richtung: null,
    });
    // Kennen die Ortsbäume das Kurzzeichen (noch) nicht, geht der Wortlaut ohne ID — der Server lehnt nichts Erfundenes ab.
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: 'x', ort: 'X-9' }), orte)).toMatchObject({ ort: 'X-9', ort_id: null });
    // Ein alter Wortlaut, den kein Picker abbildet, bleibt beim Bearbeiten stehen.
    expect(bedarfAnfrage(leererBedarf('ee', { wortlaut: 'x', ortWortlaut: 'Halle 2', groesseWortlaut: 'Wärme' }), orte)).toMatchObject({
      ort: 'Halle 2', groesse: 'Wärme', ort_id: null, messgroesse: null,
    });
  });

  it('AP-16 P1: mit Struktur liest die Anzeige `ort_ziel` und die Katalog-Größe; ohne bleibt der Wortlaut führend', () => {
    const b = mb1({ ort: 'B-1', groesse: 'frei', ort_ziel: ziel, messgroesse: 'Wirkenergie', richtung: 'Abgabe' });
    expect(ortText(b, [])).toBe('G-2 Werkhalle Lindach');
    expect(bedarfUnter(b, [])).toBe('G-2 Werkhalle Lindach · Wirkenergie · Abgabe · Frist 31.03.2027 · erfasst 27.11.2026 · Ines Kaltenbach');
    expect(ortText(mb1(), orte)).toBe('G-1 Halle 1');
    expect(ortText(mb1({ ort: 'Halle 2' }), orte)).toBe('Halle 2');
    expect(ortText(mb1({ ort: null }), orte)).toBeNull();
  });

  it('AP-16 P1: Bearbeiten belegt aus der Struktur vor; ein Bestand nur mit Wortlaut über Ortsbäume und Katalog, Unerkanntes bleibt Wortlaut', () => {
    expect(bearbeitenVorbelegung(mb1({ ort_ziel: ziel, messgroesse: 'Wirkenergie', richtung: 'Abgabe' }), [])).toMatchObject({
      einsatzId: mb1().energieeinsatz_id, wortlaut: MB1_WORTLAUT, ort: 'G-2', groesse: 'Wirkenergie', richtung: 'Abgabe', frist: '2027-03-31',
    });
    const alt = bearbeitenVorbelegung(mb1(), orte);
    expect(alt).toMatchObject({ ort: 'G-1', groesse: 'Wirkenergie', richtung: 'Bezug' });
    expect(alt.ortWortlaut).toBeUndefined();
    const frei = bearbeitenVorbelegung(mb1({ ort: 'Halle 2', groesse: 'Temperatur im Kühlraum', frist: null }), orte);
    expect(frei).toMatchObject({ ort: '', groesse: '', frist: '', ortWortlaut: 'Halle 2', groesseWortlaut: 'Temperatur im Kühlraum' });
    expect(bedarfAnfrage(frei, orte)).toMatchObject({ ort: 'Halle 2', groesse: 'Temperatur im Kühlraum', ort_id: null, messgroesse: null });
  });

  it('AP-16 P1: Einlösen belegt den Messstellen-Dialog aus der Struktur vor, sonst aus dem Wortlaut', () => {
    expect(einloesenVorbelegung(mb1({ ort_ziel: ziel, messgroesse: 'Wirkenergie', richtung: 'Abgabe' }))).toMatchObject({
      ort: 'G-2', hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Abgabe' },
    });
    expect(einloesenVorbelegung(mb1())).toMatchObject({ ort: 'G-1', hauptgroesse: { groesse: 'Wirkenergie', richtung: 'Bezug' } });
  });

  it('AP-16 P1: das Protokoll als Zeilen — Art, Zeit, Person und beim Bearbeiten je geändertem Feld vorher → nachher', () => {
    const akteur = mb1().akteur;
    const z = protokollZeilen([
      { id: 1, art: 'erfasst', alt: null, neu: { wortlaut: 'a', ort: 'G-1' }, akteur, zeit: '2026-11-27T08:30:00Z' },
      { id: 2, art: 'bearbeitet', alt: { wortlaut: 'a', ort: 'G-1', groesse: null, frist: null }, neu: { wortlaut: 'a', ort: 'G-2', groesse: 'Wirkenergie', frist: '2027-01-31' }, akteur, zeit: '2026-11-28T09:15:00Z' },
      { id: 3, art: 'verworfen', alt: null, neu: null, akteur, zeit: '2026-11-29T09:15:00Z' },
    ]);
    expect(z.map((x) => [x.art, x.wann, x.wer])).toEqual([
      ['erfasst', '27.11.2026, 09:30', 'Ines Kaltenbach'],
      ['bearbeitet', '28.11.2026, 10:15', 'Ines Kaltenbach'],
      ['verworfen', '29.11.2026, 10:15', 'Ines Kaltenbach'],
    ]);
    expect(z[1].aenderungen).toEqual(['Ort: „G-1“ → „G-2“', 'Größe: — → „Wirkenergie“', 'Frist: — → 31.01.2027']);
    expect(z[0].aenderungen).toEqual([]);
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

  it('AP-16 P1: mit Struktur nennt `ort_ziel` den Standort (auch ohne Ortsbäume); ein Ort ohne Standort heute steht unter „ohne Ort“', () => {
    const einsaetze = [...ahrenbergEinsaetze(), ee8()];
    const lindach = mb1({ id: 'l', kennzeichen: 'MB-3', ort: 'G-1', ort_ziel: ziel });
    const heimatlos = mb1({ id: 'h', kennzeichen: 'MB-4', ort_ziel: { ...ziel, standort_id: null, standort_name: null } });
    const g = nachStandort([lindach, heimatlos, mb1()], einsaetze, []);
    expect(g.map((x) => [x.name, x.bedarfe.map((b) => b.bedarf.kennzeichen)])).toEqual([['Werkhalle Lindach', ['MB-3']], ['ohne Ort', ['MB-1', 'MB-4']]]);
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
    expect(messbedarfAblehnung(a(422, 'ort_unbekannt'))).toMatch(/Diesen Ort gibt es nicht mehr/);
    expect(messbedarfAblehnung(a(422, 'groesse_ungueltig'))).toMatch(/kennt der Katalog nicht/);
    expect(messbedarfAblehnung(new ApiError(409, 'Dieser Messbedarf ist Beleg in BER-1 Stand 1.', { code: 'berichts_belege' }))).toBe(
      'Dieser Messbedarf ist Beleg in BER-1 Stand 1.',
    );
  });
});
