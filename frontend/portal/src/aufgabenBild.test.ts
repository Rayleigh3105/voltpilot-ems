import { describe, expect, it } from 'vitest';
import type { EnergiemanagementAufgaben, EnergiemanagementPerson, EnergiemanagementZuordnung } from './api';
import * as T from './aufgabenBild';
import { VOKABULARE, WOERTER } from './energiemanagement';

const person = (id: string, name: string, kuerzel: string) => ({ id, name, kuerzel, funktion: '', zustand: 'aktiv' as const });
const IK = person('ik', 'Ines Kaltenbach', 'IK');
const JW = person('jw', 'Jonas Wendlinger', 'JW');
const RF = person('rf', 'Robert Falk', 'RF');

const zuordnung = (aufgabe: string, p: typeof IK, z: Partial<EnergiemanagementZuordnung> = {}): EnergiemanagementZuordnung =>
  ({
    id: `${aufgabe}-${p.id}`,
    aufgabe,
    wort: WOERTER.aufgabe[aufgabe] ?? aufgabe,
    aufgabe_wortlaut: null,
    person: p,
    vertretung: null,
    gilt_ab: '2029-03-01',
    gilt_bis: null,
    zustand: 'laufend',
    entschieden_von: RF,
    begruendung: 'x',
    beleg: null,
    beschluss_kennung: null,
    beendet_begruendung: null,
    ...z,
  }) as EnergiemanagementZuordnung;

const stand = (laufend: EnergiemanagementZuordnung[], spaeter: EnergiemanagementZuordnung[] = []): EnergiemanagementAufgaben => ({
  tag: '2029-04-30',
  leitung: [RF],
  aufgaben: VOKABULARE.aufgabe.map((a) => {
    const l = laufend.filter((z) => z.aufgabe === a);
    return { aufgabe: a, wort: WOERTER.aufgabe[a] ?? a, laufend: l, satz: l.length ? null : `${WOERTER.aufgabe[a]} - keine Person festgelegt.` };
  }),
  zuordnungen: [...laufend, ...spaeter],
});

describe('Reiter „Aufgaben“ (Konzept §6.8, Entscheid 23)', () => {
  it('jede Aufgabe hat ein Kurzwort aus dem Vertrag (1.4); „weitere“ heißt wie ihr Wortlaut', () => {
    for (const a of VOKABULARE.aufgabe) expect(T.aufgabeKurz(a), a).toBe(WOERTER.aufgabe_kurz[a]);
    expect(T.aufgabeKurz('bezugsbasen')).toBe('Bezugsbasen');
    expect(T.aufgabeKurz('weitere', 'Energiedaten an die Gruppe melden')).toBe('Energiedaten an die Gruppe melden');
  });

  it('Zeilen in der Reihenfolge des Vokabulars, ohne Person sichtbar; „weitere“ nur, wenn eine läuft oder kommt', () => {
    const s = stand([zuordnung('unternehmensleitung', RF), zuordnung('energieteam', IK), zuordnung('energieteam', JW)]);
    const z = T.aufgabenZeilen(s);
    expect(z.map((x) => x.aufgabe)).toEqual(VOKABULARE.aufgabe.filter((a) => a !== 'weitere'));
    expect(z.find((x) => x.aufgabe === 'energieteam')?.personen.map((p) => p.kuerzel)).toEqual(['IK', 'JW']);
    expect(z.find((x) => x.aufgabe === 'bezugsbasen')?.ohnePerson).toMatch(/keine Person festgelegt/);
    const mitWeiterer = T.aufgabenZeilen(stand([], [zuordnung('weitere', IK, { gilt_ab: '2029-05-01', aufgabe_wortlaut: 'Melden' })]));
    expect(mitWeiterer.at(-1)).toMatchObject({ aufgabe: 'weitere', kurz: 'Weitere Aufgabe', personen: [] });
  });

  it('Status-Zeile: jede Aufgabe hat eine Person - oder wie viele keine haben', () => {
    expect(T.aufgabenStatus([{ ohnePerson: null }])).toEqual({ zeichen: 'festgehalten', text: 'jede Aufgabe hat eine Person' });
    expect(T.aufgabenStatus([{ ohnePerson: 'x' }, { ohnePerson: null }])).toEqual({ zeichen: 'offen', text: '1 Aufgabe ohne Person' });
    expect(T.aufgabenStatus([{ ohnePerson: 'x' }, { ohnePerson: 'y' }])).toMatchObject({ text: '2 Aufgaben ohne Person' });
  });

  it('am Rechner neben den Kürzeln der Name, bei mehreren die Zahl; seit wann und ab wann', () => {
    expect(T.personenWort([IK])).toBe('Ines Kaltenbach');
    expect(T.personenWort([IK, JW, RF])).toBe('3 Personen');
    expect(T.personenWort([])).toBe('');
    expect(T.seitWort({ gilt_ab: '2029-03-01', gilt_bis: null }, '2029-04-30')).toBe('seit 01.03.2029');
    expect(T.seitWort({ gilt_ab: '2029-05-01', gilt_bis: '2029-12-31' }, '2029-04-30')).toBe('ab 01.05.2029 bis 31.12.2029');
  });

  it('Personen: wer Aufgaben hat zuerst, dann wer nur vertritt, beendete zuletzt', () => {
    const personen = [
      { ...JW, funktion: 'IT-Leitung' },
      { ...person('alt', 'Alte Person', 'AP'), zustand: 'beendet' as const },
      { ...person('ph', 'Peter Hollerbach', 'PH') },
      { ...IK, funktion: 'Energiemanagement' },
    ] as EnergiemanagementPerson[];
    const s = stand([zuordnung('energieteam', IK, { vertretung: JW }), zuordnung('dokumente', IK)]);
    const z = T.personenZeilen(personen, s);
    expect(z.map((x) => [x.person.kuerzel, T.personFakt(x)])).toEqual([
      ['IK', '2 Aufgaben'],
      ['JW', 'Vertretung'],
      ['PH', ''],
      ['AP', 'beendet'],
    ]);
  });

  it('die Erklärung nimmt eine Aufgabe mit Vertretung aus den eigenen Daten', () => {
    const z = T.aufgabenZeilen(stand([zuordnung('bezugsbasen', IK, { vertretung: JW })]));
    expect(T.erklaerungAufgabe(z, '2029-04-30')).toMatchObject({
      frage: 'Was ist eine Aufgabe im Energiemanagement?',
      beiIhnen: 'Bezugsbasen: Ines Kaltenbach seit 01.03.2029, Vertretung Jonas Wendlinger.',
    });
    expect(T.erklaerungAufgabe([], '2029-04-30').beiIhnen).toBeNull();
  });
});
