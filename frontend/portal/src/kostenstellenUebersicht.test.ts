import { describe, expect, it } from 'vitest';
import type { KostenstelleEnergie, KostenstelleEnergiePeriode } from './api';
import * as MODUL from './kostenstellenUebersicht';
import {
  ALLE_NICHT_ABRUFBAR,
  GRUND_SATZ,
  KEINE_SUMME,
  NICHT_ABRUFBAR,
  NICHT_VERTEILT_TITEL,
  PROZESSE_KEINE_SUMME,
  PROZESS_SUMME_OHNE,
  berechnete,
  hervorAus,
  kostenstellenBild,
  kostenstellenImZeitraum,
  prozessSummen,
  prozesseBild,
  reiterAus,
  reiterDa,
  reiterHash,
  type EnergieAntwort,
  type KarteBild,
  type KostenstellenBild,
  type WerteAntwort,
} from './kostenstellenUebersicht';
import { parseRoute } from './nav';
import { ahrenbergKostenstelleEnergie, ahrenbergMessstelleProzesse, ahrenbergProzessSummeWerte, F12_TAG } from './test/kostenstellenFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { kostenstellenAhrenberg, prozesseAhrenberg } from './test/messstelleSeiteFixtures';
import faelle from './test/oberflaechenFaelle.json';
import { sprungziel } from './uemsOberflaechen';

/**
 * UEMS AP-13 IP-9 (= AP-10 IP-15, Listen-Teil) gegen den Fall O9 aus `test/oberflaechenFaelle.json` und die Kostenstellen
 * des Referenzunternehmens (`test/kostenstellenFixtures.ts`): 4200 9 700 · 4 770 · 14 470, 4100 mit Warnung, „nicht
 * verteilt“ einmal, KEINE Gesamtsumme — mit dem Satz, warum —, „gültig bis“ an 9000 (F12), Prozess-Summe MS-20.
 */

type Fall = { id: string; schritte: string[]; erwartet: Record<string, unknown> };
const O9 = (faelle as unknown as { faelle: Fall[] }).faelle.find((f) => f.id === 'O9') as Fall;

const KATALOG = kostenstellenAhrenberg();
/** Die Anzeige mit gewöhnlichem Leerzeichen statt des geschützten vor der Einheit. */
const n = (s: string): string => s.replace(/ /g, ' ');

function antworten(periode: KostenstelleEnergiePeriode, am: string): Map<string, EnergieAntwort> {
  return new Map(kostenstellenImZeitraum(KATALOG, periode, am).map((k) => [k.id, ahrenbergKostenstelleEnergie(k.id, periode, am)]));
}
const bild = (periode: KostenstelleEnergiePeriode, am: string): KostenstellenBild =>
  kostenstellenBild(KATALOG, antworten(periode, am), periode, am);
const oktober = () => bild('monat', '2026-10-01');
const karte = (b: KostenstellenBild, kz: string): KarteBild => {
  const k = b.karten.find((x) => x.kennzeichen === kz);
  if (!k) throw new Error(`keine Karte ${kz}`);
  return k;
};
const zahlen = (k: KarteBild) => k.bloecke.map((b) => `${b.wort} ${n(b.zahl)}`);

describe('UEMS AP-13 IP-9 · Kostenstellen nebeneinander (O9, E8 = A, B6)', () => {
  it('ruft je Kostenstelle, die im Oktober besteht, genau einmal — fünf Karten, 9010/9020 beginnen erst 2027', () => {
    const b = oktober();
    expect(b.karten.map((k) => k.kennzeichen)).toEqual(['4100', '4200', '4300', '9000', '9100']);
    expect(O9.schritte[5]).toContain('5 lebende im Oktober');
    expect(b.zone).toBe('Zeiten in Europe/Berlin');
    expect(b.stand).toBe('berechnet am 01.11.2026 00:15');
    expect(b.zeitraum).toBe('Oktober 2026');
  });

  it('O9: 4200 Montage gemessen 9 700 · verteilt 4 770 · berechnet — · Summe 14 470 kWh, jeder Posten ein Sprung', () => {
    const k = karte(oktober(), '4200');
    expect(zahlen(k)).toEqual(['gemessen 9.700 kWh', 'verteilt 4.770 kWh', 'berechnet —', 'Summe 14.470 kWh']);
    const ziffern = (s: string) => s.replace(/kWh/g, '').replace(/[\s. ]/g, '');
    expect(ziffern(zahlen(k).join(' · '))).toBe(ziffern(String(O9.erwartet.karte_4200)));
    // „berechnet —“ hat keinen Posten — kein Satz „keine Messstelle zugeordnet“ an einer Kostenstelle mit Zuordnungen.
    expect(k.saetze).toEqual([]);
    const [gemessen, verteilt] = k.bloecke;
    expect(gemessen.posten.map((p) => [p.kennzeichen, n(p.zahl), p.spanne])).toEqual([
      ['MS-12', '6.100 kWh', null],
      ['MS-18', '3.600 kWh', 'ab 15.10.2026'],
    ]);
    expect(verteilt.posten[0].woerter).toEqual(['verteilt (30 % von MS-07)']);
    for (const p of [...gemessen.posten, ...verteilt.posten]) {
      expect(p.sprung?.hash).toBe(`#/portfolio/messstellen/${p.id}?periode=2026-10`);
      expect(parseRoute(p.sprung?.hash ?? '').messstelleId).toBe(p.id);
    }
  });

  it('O9: 4100 Spritzguss mit der Doppelzählungs-Warnung als Zeile — und die Warnung ändert keine Zahl', () => {
    const k = karte(oktober(), '4100');
    expect(zahlen(k)).toEqual(['gemessen 83.700 kWh', 'verteilt 11.130 kWh', 'berechnet 88.630 kWh', 'Summe 183.460 kWh']);
    expect(k.doppelt?.titel).toBe(String(O9.erwartet.karte_4100_warnung).split(':')[0]);
    expect(k.doppelt?.saetze).toEqual([
      'MS-06 ist bereits in MS-20 enthalten',
      'MS-07 ist bereits in MS-20 enthalten',
      'MS-11 ist bereits in MS-20 enthalten',
    ]);
    const mit = ahrenbergKostenstelleEnergie(k.id, 'monat', '2026-10-01');
    const ohne: KostenstelleEnergie = { ...mit, doppelzaehlung: { enthalten: [], nicht_pruefbar: [] } };
    const ohneBild = kostenstellenBild(KATALOG, new Map([[k.id, ohne]]), 'monat', '2026-10-01');
    expect(karte(ohneBild, '4100').bloecke).toEqual(k.bloecke);
    expect(karte(ohneBild, '4100').doppelt).toBeNull();
    // Nur eine Warnung mit enthaltenen Posten sagt, dass die Summe doppelt zählt; ein Kreis ist nur „nicht prüfbar“.
    const kreis: KostenstelleEnergie = {
      ...mit,
      doppelzaehlung: { enthalten: [], nicht_pruefbar: [{ messstelle: 'MS-20', grund: 'formel_kreis', kette: ['MS-20', 'MS-20'], satz: 'Ob MS-20 … nicht prüfbar' }] },
    };
    expect(karte(kostenstellenBild(KATALOG, new Map([[k.id, kreis]]), 'monat', '2026-10-01'), '4100').doppelt).toEqual({
      titel: 'Doppelt gezählt',
      saetze: ['Ob MS-20 … nicht prüfbar'],
      hinweis: null,
    });
  });

  it('eine Warnung für einen Teil des Zeitraums nennt ihre Tage', () => {
    const k = KATALOG[0];
    const mit = ahrenbergKostenstelleEnergie(k.id, 'monat', '2026-10-01');
    const teil: KostenstelleEnergie = {
      ...mit,
      doppelzaehlung: { enthalten: [{ ...mit.doppelzaehlung.enthalten[0], zeitraeume: [{ von: '2026-10-15', bis: '2026-10-31' }] }], nicht_pruefbar: [] },
    };
    expect(karte(kostenstellenBild(KATALOG, new Map([[k.id, teil]]), 'monat', '2026-10-01'), '4100').doppelt?.saetze).toEqual([
      'MS-06 ist bereits in MS-20 enthalten (15.10.2026–31.10.2026)',
    ]);
  });

  it('„nicht verteilt“ steht EINMAL über allen Karten — aus einer Antwort, gehört keiner, ohne eigene Zahl', () => {
    const b = oktober();
    expect(O9.erwartet.nicht_verteilt_block).toBe('einmal, gehört keiner');
    expect(b.nichtVerteilt?.posten.map((p) => p.kennzeichen)).toEqual(['MS-01', 'MS-02', 'MS-03', 'MS-10', 'MS-16', 'MS-19', 'MS-22']);
    expect(b.nichtVerteilt?.anzahl).toBe('7 Messstellen');
    expect(b.nichtVerteilt?.unter).toBe('gehört keiner Kostenstelle und steht in keiner Summe');
    // Das Wort der Überschrift wird an den Posten nicht wiederholt, und keine Karte trägt den Block.
    expect(b.nichtVerteilt?.posten.every((p) => p.woerter.length === 0)).toBe(true);
    expect(JSON.stringify(b.karten)).not.toMatch(/nicht verteilt/i);
    expect(JSON.stringify(b).split(NICHT_VERTEILT_TITEL)).toHaveLength(2);
    // Fünf Antworten tragen denselben Block — gezeigt wird er einmal, auch wenn die erste Kostenstelle nicht abrufbar ist.
    const a = antworten('monat', '2026-10-01');
    a.set(KATALOG[0].id, 'fehler');
    expect(kostenstellenBild(KATALOG, a, 'monat', '2026-10-01').nichtVerteilt?.posten).toHaveLength(7);
  });

  it('KEINE Summe über Kostenstellen: der Satz steht wörtlich — und nirgends steht doch eine Gesamtsumme', () => {
    const b = oktober();
    const zitate = [...O9.schritte[3].matchAll(/„([^“]*)“/g)].map((m) => m[1]);
    expect(zitate.at(-1)).toBe(KEINE_SUMME);
    expect(KEINE_SUMME).toBe('Die Kostenstellen sind nicht summierbar — nicht verteilte Mengen gehören keiner.');
    expect(O9.erwartet.summe_ueber_kostenstellen).toBe(false);
    expect(b.keineSumme).toBe(KEINE_SUMME);
    // Das Bild hat kein Feld für eine Zahl über Karten — nur diese Schlüssel.
    expect(Object.keys(b).sort()).toEqual(
      ['alleFehler', 'karten', 'keineSumme', 'leer', 'nichtVerteilt', 'vorherBeendet', 'stand', 'zeitraum', 'zone'].sort(),
    );
    // Keine Zahl im Bild ist die Summe der Karten-Summen (mit oder ohne 9100, mit oder ohne „nicht verteilt“).
    const text = n(JSON.stringify(b));
    for (const gesamt of ['264.110', '272.810', '614.110', '632.130']) expect(text).not.toContain(gesamt);
    expect(text).not.toMatch(/Gesamtsumme|Summe aller|insgesamt/i);
    // Und das Modul hat keine Funktion, die sie bilden könnte.
    expect(Object.keys(MODUL).filter((name) => /gesamt|alle.?summe|summe.?alle/i.test(name))).toEqual([]);
    // Ohne Kostenstelle im Zeitraum kein Satz — es gäbe nichts, das jemand summieren wollte.
    expect(bild('monat', '2026-09-01').keineSumme).toBeNull();
    expect(bild('monat', '2026-09-01').leer).toBe('In diesem Zeitraum besteht keine Kostenstelle.');
  });

  it('F12: „gültig bis 31.12.2026“ an 9000 — im Januar 2027 vor dem Zeitraum beendet, MS-03 bleibt „nicht verteilt“', () => {
    const dezember = bild('monat', '2026-12-01');
    expect(karte(dezember, '9000').gueltig).toBe('gültig bis 31.12.2026');
    expect(karte(dezember, '4100').gueltig).toBeNull();
    expect(dezember.vorherBeendet).toBeNull();

    const januar = bild('tag', F12_TAG);
    expect(januar.karten.map((k) => k.kennzeichen)).toEqual(['4100', '4200', '4300', '9010', '9020', '9100']);
    expect(januar.vorherBeendet).toBe('Vor diesem Zeitraum beendet: 9000 Infrastruktur (Druckluft, Kühlung, PV) (gültig bis 31.12.2026)');
    expect(karte(januar, '9010').saetze).toEqual([GRUND_SATZ.keine_zuordnung]);
    expect(zahlen(karte(januar, '9010'))).toEqual(['gemessen —', 'verteilt —', 'berechnet —', 'Summe —']);
    expect(januar.nichtVerteilt?.posten.map((p) => [p.kennzeichen, n(p.zahl)])).toEqual([['MS-03', '480 kWh']]);
    expect(januar.nichtVerteilt?.anzahl).toBe('1 Messstelle');
    // Im Monat, in dem sie beginnt, sagt 9010 nichts über ihren Beginn — am 15.01. auch nicht.
    expect(karte(januar, '9010').gueltig).toBeNull();
    expect(karte(bild('jahr', '2027-01-01'), '9010').gueltig).toBeNull();
    expect(karte(bild('jahr', '2026-01-01'), '4100').gueltig).toBe('gültig ab 01.10.2026');
  });

  it('9100: verschiedene Größen — je Größe eine Zahl der Route, der Satz einmal, keine Zahl erfunden', () => {
    const k = karte(oktober(), '9100');
    const gemessen = k.bloecke[0];
    expect(gemessen.zahl).toBe('—');
    expect(gemessen.summen.map(n)).toEqual(['8.700 kWh (Wirkenergie)', '1.240,0 m³ (Volumen)']);
    expect(k.bloecke[3].summen.map(n)).toEqual(['8.700 kWh (Wirkenergie)', '1.240,0 m³ (Volumen)']);
    expect(k.saetze).toEqual([GRUND_SATZ.groessen_gemischt]);
  });

  it('ohne Werte steht der Strich mit „keine Werte“ — nie eine 0', () => {
    const k = karte(bild('monat', '2026-11-01'), '4200');
    expect(zahlen(k)).toEqual(['gemessen —', 'verteilt —', 'berechnet —', 'Summe —']);
    expect(k.bloecke.map((b) => b.zustand)).toEqual(['keine Werte', 'keine Werte', null, 'keine Werte']);
    expect(JSON.stringify(k)).not.toMatch(/"0 kWh|"0 kWh/);
  });

  it('eine Kostenstelle, die nicht abrufbar ist, sagt es — die anderen stehen; alle nicht abrufbar ist ein Satz', () => {
    const a = antworten('monat', '2026-10-01');
    const k4200 = KATALOG.find((k) => k.kennzeichen === '4200')?.id as string;
    a.set(k4200, 'fehler');
    const b = kostenstellenBild(KATALOG, a, 'monat', '2026-10-01');
    expect(karte(b, '4200').fehler).toBe(NICHT_ABRUFBAR);
    expect(karte(b, '4100').bloecke).toHaveLength(4);
    expect(b.alleFehler).toBe(false);
    const alle = new Map(kostenstellenImZeitraum(KATALOG, 'monat', '2026-10-01').map((k) => [k.id, 'fehler' as const]));
    expect(kostenstellenBild(KATALOG, alle, 'monat', '2026-10-01').alleFehler).toBe(true);
    expect(ALLE_NICHT_ABRUFBAR).toBe('Die Kostenstellen sind gerade nicht abrufbar.');
    const unterwegs = kostenstellenBild(KATALOG, new Map(), 'monat', '2026-10-01');
    expect(unterwegs.karten.every((k) => k.laedt)).toBe(true);
    expect(unterwegs.nichtVerteilt).toBeNull();
    expect(unterwegs.stand).toBeNull();
  });
});

describe('UEMS AP-13 IP-9 · Prozesse mit ihrer Prozess-Summe (MS-20)', () => {
  const register = ahrenbergRegister().register;
  const zuordnungen = new Map(berechnete(register).map((z) => [z.id, ahrenbergMessstelleProzesse(z.id)]));

  it('fragt nur die berechneten Messstellen nach ihren Prozessen — MS-20 gehört zu P-1', () => {
    expect(berechnete(register).map((z) => z.kennzeichen)).toEqual(['MS-09', 'MS-15', 'MS-19', 'MS-20', 'MS-22']);
    const summen = prozessSummen(register, zuordnungen, 'monat', '2026-10-01');
    expect([...summen.entries()].map(([id, zs]) => [prozesseAhrenberg().find((p) => p.id === id)?.kennzeichen, zs.map((z) => z.kennzeichen)])).toEqual([
      ['P-1', ['MS-20']],
    ]);
    // Vor dem 01.10.2026 gehört MS-20 zu keinem Prozess.
    expect(prozessSummen(register, zuordnungen, 'monat', '2026-09-01').size).toBe(0);
  });

  it('P-1 Spritzguss: Prozess-Summe MS-20 88 630 kWh mit Sprung; die anderen sagen, dass es keine gibt; keine Summe über Prozesse', () => {
    const summen = prozessSummen(register, zuordnungen, 'monat', '2026-10-01');
    const werte = new Map<string, WerteAntwort>([['MS-20', ahrenbergProzessSummeWerte('MS-20', 'monat', '2026-10-01', '2026-10-31')]]);
    const b = prozesseBild(prozesseAhrenberg(), summen, werte, 'monat', '2026-10-01');
    expect(b.keineSumme).toBe(PROZESSE_KEINE_SUMME);
    expect(b.karten.map((p) => p.kennzeichen)).toEqual(['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6']);
    const p1 = b.karten[0];
    expect(p1.summen.map((s) => [s.kennzeichen, s.name, s.zahl && n(s.zahl)])).toEqual([['MS-20', 'Prozess Spritzguss gesamt', '88.630 kWh']]);
    expect(p1.summen[0].sprung?.hash).toBe(`#/portfolio/messstellen/${p1.summen[0].id}?periode=2026-10`);
    expect(p1.ohneSumme).toBeNull();
    expect(b.karten.slice(1).every((p) => p.ohneSumme === PROZESS_SUMME_OHNE && p.summen.length === 0)).toBe(true);
    expect(PROZESS_SUMME_OHNE).toBe('Keine Prozess-Summe: sie ist eine berechnete Messstelle, die diesem Prozess zugeordnet ist.');
    expect(Object.keys(b).sort()).toEqual(['karten', 'keineSumme', 'laedt', 'leer', 'vorherBeendet', 'zeitraum'].sort());
  });

  it('solange die Zuordnungen fehlen, sagt keine Karte „keine Prozess-Summe“; ein Unterprozess nennt seinen Prozess', () => {
    const katalog = prozesseAhrenberg();
    katalog[3] = { ...katalog[3], eltern: { id: katalog[0].id, kennzeichen: 'P-1' } };
    const b = prozesseBild(katalog, null, new Map(), 'monat', '2026-10-01');
    expect(b.laedt).toBe(true);
    expect(b.karten.every((p) => p.ohneSumme === null)).toBe(true);
    expect(b.karten[3].teilVon).toBe('Teil von P-1 Spritzguss');
    const ohneWert = prozesseBild(katalog, prozessSummen(register, zuordnungen, 'monat', '2026-10-01'), new Map([['MS-20', 'fehler' as const]]), 'monat', '2026-10-01');
    expect(ohneWert.karten[0].summen[0]).toMatchObject({ zahl: '—', hinweis: 'Der Wert ist gerade nicht abrufbar.' });
  });
});

describe('UEMS AP-13 IP-9 · Reiter und Adresse', () => {
  it('die Reiter erscheinen nur mit Inhalt — ohne Kostenstelle und Prozess bleibt das Register zeichengleich', () => {
    expect(reiterDa(0, 0)).toEqual([]);
    expect(reiterDa(7, 6)).toEqual(['liste', 'kostenstellen', 'prozesse']);
    expect(reiterDa(7, 0)).toEqual(['liste', 'kostenstellen']);
    expect(reiterDa(0, 6)).toEqual(['liste', 'prozesse']);
    // „Messstellen“ heißt schon der Reiter der Welt — die Liste heißt anders (Playwright sucht Reiter nach Teilwort).
    expect(Object.values(MODUL.REITER_WORT).some((w) => /Messstellen/.test(w))).toBe(false);
  });

  it('die Adresse hält Reiter und Zeitraum; ein Sprung auf eine Kostenstelle öffnet ihren Reiter', () => {
    const hash = reiterHash('kostenstellen', { periode: 'monat', am: '2026-10-01' });
    expect(hash).toBe('#/portfolio/messstellen?reiter=kostenstellen&periode=monat&am=2026-10-01');
    expect(parseRoute(hash)).toMatchObject({ page: 'portfolio-messstellen' });
    expect(parseRoute(hash).messstelleId).toBeUndefined();
    expect(reiterAus(hash)).toBe('kostenstellen');
    expect(reiterAus('#/portfolio/messstellen?reiter=etwas')).toBe('liste');
    expect(reiterHash('liste', { periode: 'monat', am: '2026-10-01' })).toBe('#/portfolio/messstellen');
    const s = sprungziel({ art: 'kostenstelle', kennzeichen: '4200', periode: 'monat', am: '2026-10-01' });
    expect(reiterAus(s?.hash ?? '')).toBe('kostenstellen');
    expect(hervorAus(s?.hash ?? '')).toBe('4200');
  });
});
