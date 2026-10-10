import { describe, expect, it } from 'vitest';
import { bannerTitel, stichtagAus, standAmListe } from './standAm';
import { a12Liste, A12_HEUTE } from './test/standAmFixtures';
import { ahrenbergHeute, bestandZweiAnlagen, werkLindach } from './test/standorteFixtures';

/** „Stand am …“ (UEMS AP-02 IP-13): was die Liste „Standorte“ an einem Stichtag zeigt. */

const kurzzeichen = (l: ReturnType<typeof standAmListe>) => l.eintraege.map((e) => `${e.standort.kurzzeichen}:${e.art}`);

describe('standAm', () => {
  it('Banner: der Tag deutsch geschrieben (§4.4)', () => {
    expect(bannerTitel('2027-02-15')).toBe('Sie sehen den Stand am 15.02.2027');
  });

  it('heute im Datumsfeld ist kein Stichtag — jeder andere Tag ist einer, auch einer in der Zukunft', () => {
    expect(stichtagAus(A12_HEUTE, A12_HEUTE)).toBeNull();
    expect(stichtagAus('2027-02-15', A12_HEUTE)).toBe('2027-02-15');
    expect(stichtagAus('2027-06-01', A12_HEUTE)).toBe('2027-06-01');
  });

  it('ohne Stichtag: die Liste von IP-6, samt „Noch nicht zugeordnet“', () => {
    expect(kurzzeichen(standAmListe(ahrenbergHeute(), null))).toEqual(['ST-1:standort', 'ST-2:standort']);
    expect(standAmListe(bestandZweiAnlagen(), null).nochNichtZugeordnet).toHaveLength(2);
  });

  it('A12 15.02.2027: Werk Ahrenberg Nord steht mit seinem Satz an seinem Platz', () => {
    const l = standAmListe(a12Liste('2027-02-15'), '2027-02-15');
    expect(kurzzeichen(l)).toEqual(['ST-1:standort', 'ST-2:standort', 'ST-3:gab_es_noch_nicht']);
    expect(l.eintraege[2]).toMatchObject({ satz: 'Am 15.02.2027 gab es Werk Ahrenberg Nord im Portal noch nicht.' });
  });

  it('A12 15.09.2026: kein Standort gab es — alle benannt, die Arbeitsliste von heute fehlt', () => {
    const antwort = a12Liste('2026-09-15');
    expect(antwort.nochNichtZugeordnet).not.toBeNull();
    const l = standAmListe(antwort, '2026-09-15');
    expect(l.eintraege.map((e) => (e.art === 'gab_es_noch_nicht' ? e.satz : null))).toEqual([
      'Am 15.09.2026 gab es Werk Ahrenberg im Portal noch nicht.',
      'Am 15.09.2026 gab es Werk Lindach im Portal noch nicht.',
      'Am 15.09.2026 gab es Werk Ahrenberg Nord im Portal noch nicht.',
    ]);
    expect(l.nochNichtZugeordnet).toBeNull();
  });

  it('archiviert am Stichtag: in der Gruppe mit dem Satz des Stichtags; fehlt er, spricht ihn der Vertrags-Zwilling', () => {
    const archiviert = werkLindach({ bestand: 'archiviert', bestandText: null, zustand: 'archiviert' });
    const l = standAmListe({ ...ahrenbergHeute(), stichtag: '2027-07-15', standorte: [], nichtGezeigt: [archiviert] }, '2027-07-15');
    expect(l.eintraege).toEqual([]);
    expect(l.archiviert.map((a) => a.satz)).toEqual(['Am 15.07.2027 war Werk Lindach archiviert.']);
  });
});
