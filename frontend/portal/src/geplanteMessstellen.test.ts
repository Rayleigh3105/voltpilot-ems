import { describe, expect, it } from 'vitest';
import type { Messbedarf, MessbedarfOrtZiel } from './api';
import {
  eingeloestSatz,
  einloesenAbgelehntSatz,
  erfasstSatz,
  geplanteAus,
  geplanteSatz,
  geplantHinweis,
  geplantZahl,
} from './geplanteMessstellen';
import { registerEintraege, type MessstellenEbene } from './messstellen';
import { liste, marken, status, trefferSatz } from './messstellenListe';
import { ee8, mb1 } from './test/messplanungBuehne';
import { MB1_WORTLAUT } from './test/messplanungFixtures';
import { ahrenbergRegister, REGISTER_ORT_IDS } from './test/messstellenRegisterFixtures';
import { FIXTURE_IDS } from './test/standorteFixtures';

/**
 * Die geplanten Messstellen unter Messen (Konzept Auswerten a1, Entscheid 9): offene Messbedarfe an ihrem Ort in der
 * Liste, mit Einsatz, Frist und Marke - gegen das Referenzunternehmen (Register vom 20.10.2026) und EE-8/MB-1.
 */

const UNTERNEHMEN: MessstellenEbene = { art: 'unternehmen', name: 'Kunststoffwerk Ahrenberg GmbH' };
const AHRENBERG: MessstellenEbene = { art: 'standort', id: FIXTURE_IDS.st1, name: 'Werk Ahrenberg' };
const ZONE = 'Europe/Berlin';

const ziel = (kz: string, name: string, art: MessbedarfOrtZiel['art']): MessbedarfOrtZiel => ({
  id: REGISTER_ORT_IDS[kz] ?? `0e000000-0000-4000-8000-0000000001${kz.slice(2).padStart(2, '0')}`,
  art,
  kurzzeichen: kz,
  name,
  standort_id: FIXTURE_IDS.st1,
  standort_name: 'Werk Ahrenberg',
});

/** MB-1 an Halle 1 (Struktur), MB-2 ohne Ort mit überschrittener Frist, MB-3 eingelöst, MB-4 verworfen. */
function bedarfe(): Messbedarf[] {
  return [
    mb1({ ort_ziel: ziel('G-1', 'Halle 1', 'gebaeude'), messgroesse: 'Wirkenergie', richtung: 'Bezug' }),
    mb1({ id: 'mb-2', kennzeichen: 'MB-2', wortlaut: 'Druckluft-Leckage Halle 2', ort: null, groesse: null, frist: '2026-09-30' }),
    mb1({ id: 'mb-3', kennzeichen: 'MB-3', zustand: 'eingeloest', messstelle: { id: 'x', kennzeichen: 'MS-23', name: 'Halle 1 Allgemein' } }),
    mb1({ id: 'mb-4', kennzeichen: 'MB-4', zustand: 'verworfen', begruendung: 'nicht nötig' }),
  ];
}

function geplant(b = bedarfe(), ebene = UNTERNEHMEN) {
  return geplanteAus(b, { register: ahrenbergRegister().register, einsaetze: [ee8()], ebene, heute: '2026-10-20' });
}

describe('geplante Messstellen aus den Messbedarfen', () => {
  it('nur offene Bedarfe, nach Kennzeichen; der Wortlaut ist der Name, der Einsatz steht dabei', () => {
    const g = geplant();
    expect(g.map((x) => x.kennzeichen)).toEqual(['MB-1', 'MB-2']);
    expect(g[0]).toMatchObject({
      name: MB1_WORTLAUT,
      einsatz: { text: 'EE-8 Gebäudetechnik Halle 1' },
      frist: { text: 'Frist 31.03.2027', ueberschritten: false },
      unter: 'Wirkenergie · Bezug',
    });
  });

  it('der Ort ist die Gruppe der Liste: Halle 1 mit Standort; ohne Ort „Kein Ort zugeordnet“ - nie verschwunden', () => {
    const [halle1, ohne] = geplant();
    expect(halle1.ort).toMatchObject({ key: REGISTER_ORT_IDS['G-1'], titel: 'Halle 1', standort: 'Werk Ahrenberg', ordnung: '1/ST-1/G-1' });
    expect(ohne.ort).toMatchObject({ key: 'ohne-ort', titel: 'Kein Ort zugeordnet', standort: null, ordnung: '3' });
    // Am Standort steht kein Standort über dem Ort.
    expect(geplant(bedarfe(), AHRENBERG)[0].ort.standort).toBeNull();
  });

  it('ein Bedarf der Fassung vor der Struktur (nur „G-1“ als Wortlaut) steht an dem Ort, den das Register kennt', () => {
    const [alt, unbekannt] = geplant([mb1(), mb1({ id: 'mb-5', kennzeichen: 'MB-5', ort: 'G-9', groesse: null })]);
    expect(alt.ort.key).toBe(REGISTER_ORT_IDS['G-1']);
    expect(alt.unter).toBe('Wirkenergie · Bezug');
    expect(unbekannt.ort.key).toBe('ohne-ort');
    expect(unbekannt.unter).toBe('Ort „G-9“');
  });

  it('eine Frist vor dem Tag der Antwort ist überschritten - und nur dann gibt es eine Hinweiskarte', () => {
    const g = geplant();
    expect(g[1].frist).toEqual({ tag: '2026-09-30', text: 'Frist 30.09.2026 überschritten', ueberschritten: true });
    expect(geplantHinweis(g)).toEqual({
      titel: 'Druckluft-Leckage Halle 2 (MB-2) ist noch nicht eingerichtet',
      satz: 'Frist seit 30.09.2026 überschritten · Kein Ort zugeordnet',
      ton: 'warn',
      marke: 'geplant',
      schritt: 'Ansehen',
    });
    expect(geplantHinweis([g[0]])).toBeNull();
    const zwei = geplant(bedarfe().map((b) => ({ ...b, frist: '2026-09-30' })));
    expect(geplantHinweis(zwei)?.titel).toBe('2 geplante Messstellen sind noch nicht eingerichtet');
    expect(geplantHinweis(zwei)?.satz).toBe('Frist seit 30.09.2026 überschritten · Halle 1 und Kein Ort zugeordnet');
  });

  it('ein Einsatz, den die Person nicht sieht, fehlt im Satz statt zu raten', () => {
    const g = geplanteAus(bedarfe(), { register: ahrenbergRegister().register, einsaetze: [], ebene: UNTERNEHMEN, heute: '2026-10-20' });
    expect(g[0].einsatz).toBeNull();
  });

  it('Wörter: Marke, Treffer, Sätze nach Einrichten und Erfassen', () => {
    expect(geplantZahl(1)).toBe('1 geplant');
    expect(geplanteSatz(1)).toBe('1 geplante Messstelle');
    expect(geplanteSatz(2)).toBe('2 geplante Messstellen');
    expect(eingeloestSatz(mb1({ zustand: 'eingeloest', messstelle: { id: 'x', kennzeichen: 'MS-23', name: 'Halle 1 Allgemein' } }))).toBe(
      'Messbedarf MB-1 ist eingelöst - MS-23 Halle 1 Allgemein steht jetzt in der Liste.',
    );
    expect(einloesenAbgelehntSatz('Ein freigegebener Berichtsstand zitiert diesen Messbedarf (BR-2026-0002 Nr. 1) - er bleibt, wie er ist.', 'MS-23', 'MB-1')).toBe(
      'Ein freigegebener Berichtsstand zitiert diesen Messbedarf (BR-2026-0002 Nr. 1) - er bleibt, wie er ist. Die Messstelle MS-23 ist trotzdem eingerichtet und steht in der Liste; MB-1 bleibt geplant.',
    );
    expect(erfasstSatz(mb1(), UNTERNEHMEN)).toBe('Messbedarf MB-1 ist erfasst und steht als geplante Messstelle in der Liste.');
    expect(erfasstSatz(mb1({ ort_ziel: ziel('G-1', 'Halle 1', 'gebaeude') }), AHRENBERG)).toBe(
      'Messbedarf MB-1 ist erfasst und steht als geplante Messstelle in der Liste.',
    );
    expect(erfasstSatz(mb1(), AHRENBERG)).toBe(
      'Messbedarf MB-1 ist erfasst; er hat keinen Ort an diesem Standort und steht in der Liste des Unternehmens.',
    );
  });
});

describe('die Liste mit geplanten Messstellen', () => {
  const antwort = ahrenbergRegister();
  const eintraege = registerEintraege(antwort, null, { ebene: UNTERNEHMEN, zone: ZONE, zeitpunkt: antwort.zeitpunkt });
  const mit = (suche = '', marke: Parameters<typeof liste>[1]['marke'] = null, g = geplant()) =>
    liste(eintraege, { ebene: UNTERNEHMEN, zone: ZONE, zeitpunkt: antwort.zeitpunkt, suche, marke, geplante: g });

  it('die geplante steht an ihrem Ort nach den Messstellen; ohne Ort bei „Kein Ort zugeordnet“ am Ende', () => {
    const l = mit();
    const halle1 = l.gruppen.find((g) => g.titel === 'Halle 1')!;
    expect(halle1.reihen.length).toBe(2);
    expect(halle1.geplant.map((g) => g.kennzeichen)).toEqual(['MB-1']);
    const ohne = l.gruppen[l.gruppen.length - 1];
    expect(ohne).toMatchObject({ key: 'ohne-ort', gesamt: 2 });
    expect(ohne.geplant.map((g) => g.kennzeichen)).toEqual(['MB-2']);
    // Geplante zählen nicht zu den Messstellen und nicht zu den Orten der Messstellen.
    expect(l.geplant).toBe(2);
    expect(trefferSatz(l, false)).toBe(trefferSatz(mit('', null, []), false));
  });

  it('ein Ort, an dem bisher nur geplant ist, bekommt eine Gruppe an seinem Platz im Ortsbaum', () => {
    // G-6 „Lagerzelt“: ein neues Gebäude in Werk Ahrenberg, noch ohne Messstelle.
    const zelt = mb1({ ort_ziel: ziel('G-6', 'Lagerzelt', 'gebaeude'), frist: null });
    const l = mit('', null, geplant([zelt]));
    const titel = l.gruppen.map((g) => g.titel);
    const neu = titel.indexOf('Lagerzelt');
    expect(l.gruppen[neu]).toMatchObject({ reihen: [], gesamt: 0, standort: 'Werk Ahrenberg' });
    expect(titel.slice(neu - 1, neu + 2)).toEqual(['Verwaltung', 'Lagerzelt', 'Werk Lindach']);
    expect(l.orte).toBe(mit('', null, []).orte);
  });

  it('die Marke „geplant“ zeigt nur die geplanten, jede andere Marke nur Messstellen; die Suche findet sie wie Messstellen', () => {
    const nurGeplant = mit('', 'geplant');
    expect(nurGeplant.treffer).toBe(0);
    expect(nurGeplant.geplant).toBe(2);
    expect(nurGeplant.gruppen.every((g) => g.reihen.length === 0)).toBe(true);
    expect(mit('', 'ohneQuelle').geplant).toBe(0);
    expect(mit('lüftung').geplant).toBe(1);
    expect(mit('MB-2').geplant).toBe(1);
    expect(mit('EE-8').geplant).toBe(2);
    expect(mit('kein ort').gruppen.find((g) => g.key === 'ohne-ort')?.geplant).toHaveLength(1);
  });

  it('die Marke zählt die geplanten; die Hinweiskarte steht nach denen der Messstellen und ersetzt die ruhige Zeile', () => {
    const l = mit();
    expect(marken(l.reihen, 2).find((m) => m.schluessel === 'geplant')).toEqual({ schluessel: 'geplant', text: '2 geplant', ton: 'neutral', anzahl: 2 });
    expect(marken(l.reihen).some((m) => m.schluessel === 'geplant')).toBe(false);
    const ohne = status(antwort, l.reihen, { ebene: UNTERNEHMEN, zone: ZONE, stichtag: null });
    const mitKarte = status(antwort, l.reihen, { ebene: UNTERNEHMEN, zone: ZONE, stichtag: null, geplant: geplantHinweis(geplant()) });
    // Wie bei einer überfälligen Ablesung: die Karte mit Schritt tritt an die Stelle der ruhigen Lage.
    expect(ohne.hinweise.map((h) => h.ton)).toEqual(['off']);
    expect(mitKarte.zeile).toBeNull();
    expect(mitKarte.hinweise).toEqual([geplantHinweis(geplant())]);
  });
});
