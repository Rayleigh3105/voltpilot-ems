import { describe, expect, it } from 'vitest';
import type { KostenstelleEnergie, KostenstelleEnergiePeriode, MessstelleRegisterZeile, MessstelleVerteilung, MessstelleWerte, ProzessMessstellen } from './api';
import * as MODUL from './kostenstellenUebersicht';
import {
  ABLESUNG_OHNE_TAGESWERT,
  ALLE_NICHT_ABRUFBAR,
  DOPPELT_HINWEIS,
  DOPPELT_TITEL,
  NICHT_ABRUFBAR,
  NOCH_KEINE_MESSSTELLE_KLEIN,
  OHNE_KOSTENSTELLE,
  hervorAus,
  kostenstelleBeispiel,
  kostenstellenBild,
  kostenstellenImZeitraum,
  ohneUmbruchVorZahl,
  periodeKurz,
  prozessBeispiel,
  prozessKennzeichen,
  prozesseBild,
  reiterAus,
  reiterDa,
  reiterHash,
  setzenDoppeltBild,
  type EnergieAntwort,
  type KarteBild,
  type KostenstellenBild,
  type WerteAntwort,
  type ZuordnungAntwort,
} from './kostenstellenUebersicht';
import { parseRoute } from './nav';
import { ahrenbergKostenstelleEnergie, ahrenbergProzessMessstellen, ahrenbergProzessSummeWerte, F12_TAG } from './test/kostenstellenFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import { kostenstellenAhrenberg, prozesseAhrenberg } from './test/messstelleSeiteFixtures';
import faelle from './test/oberflaechenFaelle.json';
import { sprungziel } from './uemsOberflaechen';

/**
 * Die Reiter „Kostenstellen“ und „Prozesse“ (UEMS AP-13 IP-9; Neubau nach dem Messen-Konzept m1 §6.6/§6.7) gegen den
 * Fall O9 aus `test/oberflaechenFaelle.json` und das Referenzunternehmen (`test/kostenstellenFixtures.ts`): je
 * Kostenstelle die Summe der Route mit Posten und Herkunft („ganz“, „30 % von …“), „Ohne Kostenstelle“ statt „nicht
 * verteilt“, KEINE Gesamtsumme und KEIN Satz darüber, die Warnung vor doppelter Zählung mit Weg, Ablesezähler ohne
 * Tageswert ehrlich; je Prozess die Messstellen, die ihn messen, mit Wert.
 */

type Fall = { id: string; schritte: string[]; erwartet: Record<string, unknown>; gegeben: Record<string, unknown> };
const O9 = (faelle as unknown as { faelle: Fall[] }).faelle.find((f) => f.id === 'O9') as Fall;

const KATALOG = kostenstellenAhrenberg();
const REGISTER = ahrenbergRegister().register;
/** Die Anzeige mit gewöhnlichem Leerzeichen statt des geschützten vor der Einheit. */
const n = (s: string): string => s.replace(/\u00a0/g, ' ');

function antworten(periode: KostenstelleEnergiePeriode, am: string): Map<string, EnergieAntwort> {
  return new Map(kostenstellenImZeitraum(KATALOG, periode, am).map((k) => [k.id, ahrenbergKostenstelleEnergie(k.id, periode, am)]));
}

/** Die Werte-Route einer Messstelle mit EINEM Schritt (für „von 15.900 kWh“ und die Reihen „Ohne Kostenstelle“). */
function werteVon(kennzeichen: string, menge: number | null, von = '2026-10-01', bis = '2026-10-31'): MessstelleWerte {
  const w = ahrenbergProzessSummeWerte('MS-20', 'monat', von, bis);
  return {
    ...w,
    messstelle: { ...w.messstelle, kennzeichen },
    werte: [{ ...w.werte[0], menge, zustand: menge === null ? 'keine Werte' : 'vollständig' }],
  };
}

const bild = (periode: KostenstelleEnergiePeriode, am: string, extra: Partial<Parameters<typeof kostenstellenBild>[0]> = {}): KostenstellenBild =>
  kostenstellenBild({ katalog: KATALOG, antworten: antworten(periode, am), register: REGISTER, werte: new Map(), periode, am, ...extra });
const oktober = (extra: Partial<Parameters<typeof kostenstellenBild>[0]> = {}) => bild('monat', '2026-10-01', extra);
const karte = (b: KostenstellenBild, kz: string): KarteBild => {
  const k = b.karten.find((x) => x.kennzeichen === kz);
  if (!k) throw new Error(`keine Karte ${kz}`);
  return k;
};
const posten = (k: KarteBild) => k.posten.map((p) => [p.kennzeichen, n(p.zahl), n(p.herkunft)]);

describe('Kostenstellen: je Karte die Summe der Route mit Posten und Herkunft (O9, Konzept §6.6)', () => {
  it('ruft je Kostenstelle, die im Oktober besteht, genau einmal - fünf Karten; Zone und Stand einmal am Fuß', () => {
    const b = oktober();
    expect(b.karten.map((k) => k.kennzeichen)).toEqual(['4100', '4200', '4300', '9000', '9100']);
    expect(O9.schritte[5]).toContain('5 lebende im Oktober');
    expect(b.fuss).toBe('Zeiten: Europe/Berlin · Stand 01.11.2026 00:15');
    expect(b.zeitraum).toBe('Oktober 2026');
    expect(b.wertSpalte).toBe('Oktober 2026');
  });

  it('O9: 4200 Montage - Summe 14.470 kWh „vollständig“, Posten mit Herkunft; „von …“ nur mit der Menge der Werte-Route', () => {
    const ohneWerte = karte(oktober(), '4200');
    expect(ohneWerte.summe).toEqual({ zahl: '14.470', einheit: 'kWh', marke: { text: 'vollständig', ton: 'ok' }, getrennt: false });
    expect(posten(ohneWerte)).toEqual([
      ['MS-12', '6.100 kWh', 'ganz'],
      ['MS-18', '3.600 kWh', 'ganz · ab 15.10.2026'],
      ['MS-07', '4.770 kWh', '30 %'],
    ]);
    // Die Menge von MS-07 im Oktober (Referenzwelt: 15.900 kWh) kommt aus der Werte-Route, nie aus Anteil × Posten.
    expect(O9.gegeben.ms07_anteile_summe).toBe(15900);
    const mit = karte(oktober({ werte: new Map<string, WerteAntwort>([['MS-07', werteVon('MS-07', 15900)]]) }), '4200');
    expect(posten(mit)[2]).toEqual(['MS-07', '4.770 kWh', '30 % von 15.900 kWh']);
    // Die Wörter, die die Herkunft schon sagt („verteilt (30 % von MS-07)“), stehen nicht noch einmal.
    expect(mit.posten.every((p) => p.woerter.every((w) => !w.startsWith('verteilt')))).toBe(true);
    for (const p of mit.posten) {
      expect(p.sprung?.hash).toBe(`#/portfolio/messstellen/${p.id}?periode=2026-10`);
      expect(parseRoute(p.sprung?.hash ?? '').messstelleId).toBe(p.id);
    }
    const ziffern = (s: string) => s.replace(/[^0-9]/g, '');
    expect(String(O9.erwartet.karte_4200)).toContain('14 470');
    expect(ziffern(mit.summe?.zahl ?? '')).toBe('14470');
  });

  it('O9: 4100 Spritzguss - die Warnung der Route mit Weg zur Messstelle, „zählt doppelt“ statt „vollständig“, keine Zahl ändert sich', () => {
    const k = karte(oktober(), '4100');
    expect(k.summe?.zahl).toBe('183.460');
    expect(k.summe?.marke).toBeNull();
    expect(k.doppelt?.marke).toBe('zählt doppelt');
    expect(k.doppelt?.saetze).toEqual([
      'MS-06 ist bereits in MS-20 enthalten',
      'MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)',
      'MS-11 ist bereits in MS-20 enthalten',
    ]);
    expect(k.doppelt?.pruefen.map((x) => x.text)).toEqual(['Verteilung von MS-06 prüfen', 'Verteilung von MS-07 prüfen', 'Verteilung von MS-11 prüfen']);
    expect(k.doppelt?.pruefen.every((x) => x.sprung?.hash.startsWith('#/portfolio/messstellen/'))).toBe(true);
    expect(posten(k).find(([kz]) => kz === 'MS-20')?.[2]).toBe('berechnet · ganz');
    const mit = ahrenbergKostenstelleEnergie(k.id, 'monat', '2026-10-01');
    const ohne: KostenstelleEnergie = { ...mit, doppelzaehlung: { enthalten: [], nicht_pruefbar: [] } };
    const ohneBild = kostenstellenBild({ katalog: KATALOG, antworten: new Map([[k.id, ohne]]), register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-10-01' });
    const zahlen = (x: KarteBild) => [x.summe?.zahl, ...x.posten.map((p) => p.zahl)];
    expect(zahlen(karte(ohneBild, '4100'))).toEqual(zahlen(k));
    expect(karte(ohneBild, '4100').doppelt).toBeNull();
    expect(karte(ohneBild, '4100').summe?.marke).toEqual({ text: 'vollständig', ton: 'ok' });
  });

  it('die Warnung steht auch am Posten, der schon in der Summe steckt - mit seinem Anteil; Teil-Zeiträume nennen ihre Tage', () => {
    const k = karte(oktober(), '4100');
    expect(Object.fromEntries(k.posten.map((p) => [p.kennzeichen, p.doppelt]))).toEqual({
      'MS-06': ['MS-06 ist bereits in MS-20 enthalten'],
      'MS-08': [],
      'MS-11': ['MS-11 ist bereits in MS-20 enthalten'],
      'MS-07': ['MS-07 ist bereits in MS-20 enthalten (Anteil 70 %)'],
      'MS-20': [],
    });
    expect(karte(oktober(), '4200').doppelt).toBeNull();
    const mit = ahrenbergKostenstelleEnergie(KATALOG[0].id, 'monat', '2026-10-01');
    const teil: KostenstelleEnergie = {
      ...mit,
      doppelzaehlung: { enthalten: [{ ...mit.doppelzaehlung.enthalten[0], zeitraeume: [{ von: '2026-10-15', bis: '2026-10-31' }] }], nicht_pruefbar: [] },
    };
    const b = kostenstellenBild({ katalog: KATALOG, antworten: new Map([[KATALOG[0].id, teil]]), register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-10-01' });
    expect(karte(b, '4100').doppelt?.saetze).toEqual(['MS-06 ist bereits in MS-20 enthalten (15.10.2026–31.10.2026)']);
  });

  it('KEINE Summe über Kostenstellen - und kein Satz darüber: das Bild hat dafür kein Feld, das Modul keine Funktion', () => {
    const b = oktober();
    expect(O9.erwartet.summe_ueber_kostenstellen).toBe(false);
    expect(Object.keys(b).sort()).toEqual(
      ['ablesung', 'alleFehler', 'alleZugeordnet', 'fuss', 'karten', 'leer', 'ohne', 'ohneMengen', 'vorherBeendet', 'wertSpalte', 'zeitraum'].sort(),
    );
    const text = n(JSON.stringify(b));
    for (const gesamt of ['264.110', '272.810', '614.110', '632.130']) expect(text).not.toContain(gesamt);
    expect(text).not.toMatch(/Gesamtsumme|Summe aller|insgesamt|nicht summierbar/i);
    expect(Object.keys(MODUL).filter((name) => /gesamt|alle.?summe|summe.?alle|keine_?summe/i.test(name))).toEqual([]);
    expect(bild('monat', '2026-09-01').leer).toBe('In diesem Zeitraum besteht keine Kostenstelle.');
  });

  it('„Ohne Kostenstelle“: die Messstellen des Registers ohne Posten in einer Kostenstelle - Hauptzähler zuerst, Wert aus der Werte-Route', () => {
    const b = oktober({ werte: new Map<string, WerteAntwort>([['MS-01', werteVon('MS-01', 128400)], ['MS-02', 'fehler']]) });
    expect(b.ohne?.titel).toBe(OHNE_KOSTENSTELLE.titel);
    expect(b.ohne?.anzahl).toBe('8 Messstellen');
    expect(b.ohne?.reihen.map((r) => r.kennzeichen)).toEqual(['MS-01', 'MS-02', 'MS-10', 'MS-16', 'MS-03', 'MS-04', 'MS-19', 'MS-22']);
    const [ms01, ms02, ms10] = b.ohne?.reihen ?? [];
    expect(ms01.wert).toEqual({ zahl: '128.400\u00a0kWh', zustand: 'vollständig', ton: 'gut', fehler: false });
    expect(ms01.wann).toBe('Okt 2026');
    expect(ms02.wert.fehler).toBe(true);
    expect(ms10.wert.zahl).toBeNull();
    expect(ms01.woher).toBe('automatisch vom Gerät');
    // Eine Aussage über die Zuordnung, keine Menge: das Bild trägt keine Summe der Reihen.
    expect(JSON.stringify(b.ohne)).not.toMatch(/summe/i);
    // Erst, wenn ALLE Kostenstellen geantwortet haben und das Register da ist.
    const a = antworten('monat', '2026-10-01');
    a.set(KATALOG[0].id, null);
    expect(kostenstellenBild({ katalog: KATALOG, antworten: a, register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-10-01' }).ohne).toBeNull();
    expect(oktober({ register: null }).ohne).toBeNull();
    // Gehört jede Messstelle einer Kostenstelle, steht das ruhig da - und nur dann.
    const zugeordnet = REGISTER.filter((z) => !(b.ohne?.reihen ?? []).some((r) => r.id === z.id));
    const alle = oktober({ register: zugeordnet });
    expect(alle.ohne).toBeNull();
    expect(alle.alleZugeordnet).toBe(true);
    expect(b.alleZugeordnet).toBe(false);
  });

  it('Ablesezähler ohne Tageswert (bis „Ablesezeiträume verteilen“): EIN ruhiger Satz statt Strichen ohne Grund', () => {
    const k = KATALOG.find((x) => x.kennzeichen === '4200')!;
    const roh = ahrenbergKostenstelleEnergie(k.id, 'monat', '2026-11-01');
    const ohneTag = (b: KostenstelleEnergie['gemessen']) => ({ ...b, posten: b.posten.map((p) => ({ ...p, tage: p.tage.map((t) => ({ ...t, grund: 'kein_tageswert' })) })) });
    const antwort: KostenstelleEnergie = { ...roh, gemessen: ohneTag(roh.gemessen), verteilt: ohneTag(roh.verteilt) };
    const ms12 = REGISTER.find((z) => z.kennzeichen === 'MS-12')!;
    const abgelesen: MessstelleRegisterZeile = { ...ms12, quelle: { ...ms12.quelle, stand: 'ablesung', fuehrend: null } };
    const register = REGISTER.map((z) => (z.id === ms12.id ? abgelesen : z));
    const b = kostenstellenBild({ katalog: [k], antworten: new Map([[k.id, antwort]]), register, werte: new Map(), periode: 'monat', am: '2026-11-01' });
    expect(b.ablesung).toEqual({ titel: 'Für November 2026 noch keine Werte.', satz: ABLESUNG_OHNE_TAGESWERT.satz });
    expect(karte(b, '4200').summe?.zahl).toBe('—');
    expect(karte(b, '4200').summe?.marke).toBeNull();
    // Ein Gerät ohne Tageswert ist kein Ablesezähler - dann kein Satz über Ablesungen.
    expect(kostenstellenBild({ katalog: [k], antworten: new Map([[k.id, antwort]]), register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-11-01' }).ablesung).toBeNull();
    // Liefert die Route die Menge (Oktober), verschwindet der Satz von selbst.
    expect(oktober().ablesung).toBeNull();
  });

  it('F12: „gültig bis 31.12.2026“ an 9000 - im Januar 2027 vor dem Zeitraum beendet; 9010 noch ohne Messstelle', () => {
    const dezember = bild('monat', '2026-12-01');
    expect(karte(dezember, '9000').gueltig).toBe('gültig bis 31.12.2026');
    expect(karte(dezember, '4100').gueltig).toBeNull();
    expect(dezember.vorherBeendet).toBeNull();
    const januar = bild('monat', '2027-01-01');
    expect(januar.karten.map((k) => k.kennzeichen)).toEqual(['4100', '4200', '4300', '9010', '9020', '9100']);
    expect(januar.vorherBeendet).toBe('Vor diesem Zeitraum beendet: 9000 Infrastruktur (Druckluft, Kühlung, PV) (gültig bis 31.12.2026)');
    expect(karte(januar, '9010').ohneZuordnung).toBe(true);
    expect(karte(januar, '9010').summe).toBeNull();
    expect(karte(bild('jahr', '2026-01-01'), '4100').gueltig).toBe('gültig ab 01.10.2026');
    expect(F12_TAG).toBe('2027-01-15');
  });

  it('9100: verschiedene Größen - je Größe eine Zahl der Route, getrennt, nie zusammengezählt', () => {
    const k = karte(oktober(), '9100');
    expect(k.summe).toEqual({ zahl: '8.700\u00a0kWh · 1.240,0\u00a0m³', einheit: null, marke: null, getrennt: true });
    expect(posten(k).find(([kz]) => kz === 'MS-21')).toEqual(['MS-21', '1.240,0 m³', 'ganz']);
  });

  it('ohne Werte steht der Strich, keine Marke - nie eine 0', () => {
    const k = karte(bild('monat', '2026-11-01'), '4200');
    expect(k.summe).toEqual({ zahl: '—', einheit: null, marke: null, getrennt: false });
    expect(k.posten.map((p) => [p.zahl, p.zustand])).toEqual([['—', null], ['—', null], ['—', null]]);
    expect(JSON.stringify(k)).not.toMatch(/"0 kWh|"0\\u00a0kWh/);
  });

  it('eine Kostenstelle, die nicht abrufbar ist, sagt es - die anderen stehen; alle nicht abrufbar ist eine Karte', () => {
    const a = antworten('monat', '2026-10-01');
    const k4200 = KATALOG.find((k) => k.kennzeichen === '4200')?.id as string;
    a.set(k4200, 'fehler');
    const b = kostenstellenBild({ katalog: KATALOG, antworten: a, register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-10-01' });
    expect(karte(b, '4200').fehler).toBe(NICHT_ABRUFBAR);
    expect(karte(b, '4100').posten).toHaveLength(5);
    expect(b.alleFehler).toBe(false);
    expect(b.ohne).toBeNull();
    const alle = new Map(kostenstellenImZeitraum(KATALOG, 'monat', '2026-10-01').map((k) => [k.id, 'fehler' as const]));
    expect(kostenstellenBild({ katalog: KATALOG, antworten: alle, register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-10-01' }).alleFehler).toBe(true);
    expect(ALLE_NICHT_ABRUFBAR).toBe('Die Kostenstellen sind gerade nicht abrufbar.');
    const unterwegs = kostenstellenBild({ katalog: KATALOG, antworten: new Map(), register: REGISTER, werte: new Map(), periode: 'monat', am: '2026-10-01' });
    expect(unterwegs.karten.every((k) => k.laedt)).toBe(true);
    expect(unterwegs.fuss).toBeNull();
  });

  it('ohne Recht auf Mengen: nur die Köpfe und EIN Satz - keine Lage, kein „Ohne Kostenstelle“', () => {
    const b = oktober({ ohneMengen: 'Die Mengen sehen nur …' });
    expect(b.ohneMengen).toBe('Die Mengen sehen nur …');
    expect(b.karten.every((k) => !k.laedt && k.summe === null && k.posten.length === 0)).toBe(true);
    expect(b.ohne).toBeNull();
    expect(b.fuss).toBeNull();
  });

  it('das Beispiel des Aufklappers kommt aus den eigenen Kostenstellen - die erste anteilig geteilte Messstelle', () => {
    expect(kostenstelleBeispiel(antworten('monat', '2026-10-01'))).toEqual({
      messstelle: 'MS-07 Druckluft Kompressoren K1+K2',
      teile: [
        { kostenstelle: '4100 Spritzguss', anteil: '70' },
        { kostenstelle: '4200 Montage', anteil: '30' },
      ],
    });
    expect(kostenstelleBeispiel(new Map())).toBeNull();
  });
});

describe('Prozesse zeigen ihre Messstellen (Konzept §6.7, Entscheid 4)', () => {
  const KAT = prozesseAhrenberg();
  const zuordnungen = (f: (id: string) => ZuordnungAntwort = (id) => ahrenbergProzessMessstellen(id, '2026-10-01')) =>
    new Map<string, ZuordnungAntwort>(KAT.map((p) => [p.id, f(p.id)]));
  const pb = (z = zuordnungen(), werte: ReadonlyMap<string, WerteAntwort> = new Map()) =>
    prozesseBild({ katalog: KAT, zuordnungen: z, werte, register: REGISTER, periode: 'monat', am: '2026-10-01' });

  it('eine Prozess-Summe hat Vorrang: P-1 „zusammengerechnet in MS-20“ mit 88.630 kWh und Sprung; ohne Messstelle der Weg', () => {
    const werte = new Map<string, WerteAntwort>([['MS-20', ahrenbergProzessSummeWerte('MS-20', 'monat', '2026-10-01', '2026-10-31')]]);
    expect(prozessKennzeichen(zuordnungen())).toEqual(['MS-20']);
    const b = pb(zuordnungen(), werte);
    expect(b.anzahl).toBe(`${KAT.length} Prozesse`);
    const [p1, p2] = b.reihen;
    expect(p1.quelle).toBe('zusammengerechnet in MS-20 Prozess Spritzguss gesamt');
    expect(n(p1.wert?.zahl ?? '')).toBe('88.630 kWh');
    expect(p1.ton).toBe('gut');
    expect(p1.zustand).toBe('vollständig');
    expect(p1.sprung?.hash).toMatch(/^#\/portfolio\/messstellen\/[^?]+\?periode=2026-10$/);
    expect(p1.hinweise).toEqual([
      'Hinweis: Die Summe „Prozess Spritzguss gesamt“ (MS-20) enthält 70 % von Druckluft Kompressoren K1+K2 (MS-07) über Verteilung 4100. MS-07 gehört zu Druckluft (P-3). Die Bewertung zählt Druckluft dort.',
    ]);
    expect(p2).toMatchObject({ zuordnen: true, zustand: NOCH_KEINE_MESSSTELLE_KLEIN, quelle: null, wert: null, ton: 'still' });
    expect(Object.keys(b).sort()).toEqual(['anzahl', 'leer', 'reihen', 'standort', 'vorherBeendet', 'wertSpalte', 'zeitraum'].sort());
    expect(n(JSON.stringify(b))).not.toMatch(/nicht summierbar|Keine Prozess-Summe/);
  });

  it('gemessene Messstellen ohne Summe stehen einzeln, nie addiert; eine zweite Zählung sagt „auch bei … gezählt“', () => {
    const ms = (kz: string) => {
      const z = REGISTER.find((x) => x.kennzeichen === kz)!;
      return { id: z.id, kennzeichen: kz, name: z.name ?? kz };
    };
    const antwort = (id: string, gemessen: ReturnType<typeof ms>[]): ProzessMessstellen => ({
      prozess: { id, kennzeichen: KAT.find((p) => p.id === id)!.kennzeichen, name: KAT.find((p) => p.id === id)!.name },
      am: '2026-10-01',
      gemessen,
      berechnet: [],
      hinweise: [],
    });
    const z = zuordnungen((id) => (id === KAT[0].id ? antwort(id, [ms('MS-06'), ms('MS-11')]) : id === KAT[1].id ? antwort(id, [ms('MS-11')]) : antwort(id, [])));
    const werte = new Map<string, WerteAntwort>([['MS-06', werteVon('MS-06', 55100)], ['MS-11', werteVon('MS-11', 22400)]]);
    const [p1, p2] = pb(z, werte).reihen;
    expect(p1.quelle).toBe('2 Messstellen, einzeln');
    expect(p1.wert).toBeNull();
    expect(p1.sprung).toBeNull();
    expect(p1.teile.map((t) => [t.kennzeichen, n(t.wert.zahl ?? '')])).toEqual([['MS-06', '55.100 kWh'], ['MS-11', '22.400 kWh']]);
    expect(JSON.stringify(p1)).not.toContain('77.500');
    expect(p2.quelle).toBe('gemessen von MS-11 Spritzguss SG07–SG10');
    expect(p2.auch).toBe(`auch bei ${KAT[0].name} gezählt`);
    expect(p1.auch).toBeNull();
    expect(p1.unter).toBe('Werk Ahrenberg');
  });

  it('unterwegs, nicht abrufbar, Teil-Prozess und das Beispiel des Aufklappers', () => {
    const katalog = prozesseAhrenberg();
    katalog[3] = { ...katalog[3], eltern: { id: katalog[0].id, kennzeichen: 'P-1' } };
    const z = new Map<string, ZuordnungAntwort>(katalog.map((p, i) => [p.id, i === 1 ? 'fehler' : null]));
    const b = prozesseBild({ katalog, zuordnungen: z, werte: new Map(), register: REGISTER, periode: 'monat', am: '2026-10-01' });
    expect(b.reihen[0].laedt).toBe(true);
    expect(b.reihen[1]).toMatchObject({ fehler: true, laedt: false, zustand: 'Die Prozesse sind gerade nicht abrufbar.' });
    expect(b.reihen[3].unter).toBe('Teil von P-1 Spritzguss');
    expect(prozessBeispiel(pb())).toEqual([KAT[0].name]);
    expect(prozessBeispiel(b)).toEqual(katalog.slice(0, 3).map((p) => p.name));
  });
});

describe('Anzeige', () => {
  it('der Zeitraum kurz neben der Zahl; Namen brechen nie vor einer Zahl um', () => {
    expect(periodeKurz('monat', '2026-09-01')).toBe('Sep 2026');
    expect(periodeKurz('jahr', '2025-01-01')).toBe('2025');
    expect(ohneUmbruchVorZahl('Gebäudetechnik Halle 1')).toBe('Gebäudetechnik Halle\u00a01');
  });
});

describe('UEMS AP-13 IP-9 · Reiter und Adresse', () => {
  it('die Reiter erscheinen nur mit Inhalt - ohne Kostenstelle und Prozess bleibt das Register zeichengleich', () => {
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

describe('setzenDoppeltBild — der Hinweis nach dem Setzen einer Verteilung (Folge PR 1127)', () => {
  const K4100 = { id: 'k-4100', kennzeichen: '4100' };
  const K4200 = { id: 'k-4200', kennzeichen: '4200' };
  const anteil = (k: { id: string; kennzeichen: string }, prozent: string) => ({
    id: `a-${k.kennzeichen}`,
    kostenstelle: k,
    name: k.kennzeichen,
    anteil_prozent: prozent,
    gueltig_ab: '2026-11-01',
    gueltig_bis: null,
    endet_mit_kostenstelle: false,
  });
  const enthalten = (teil: string, summe: string) => ({
    teil,
    summe,
    umfang: 'ganz' as const,
    kette: [summe, teil],
    zeitraeume: [{ von: '2026-11-01', bis: '2026-11-01' }],
    satz: `${teil} ist bereits in ${summe} enthalten`,
  });
  const antwort = (kennzeichen: string, doppelzaehlung?: MessstelleVerteilung['doppelzaehlung']): MessstelleVerteilung => ({
    messstelle_id: 'ms',
    kennzeichen,
    am: null,
    zustand: null,
    anteile: [anteil(K4100, '70'), anteil(K4200, '30')],
    ...(doppelzaehlung === undefined ? {} : { doppelzaehlung }),
  });

  it('ohne Befund null: Feld fehlt, leer, oder nur Einträge ohne Satz', () => {
    expect(setzenDoppeltBild(antwort('MS-06'))).toBeNull();
    expect(setzenDoppeltBild(antwort('MS-06', []))).toBeNull();
    expect(setzenDoppeltBild(antwort('MS-06', [{ kostenstelle: K4200, am: '2026-11-01', enthalten: [], nicht_pruefbar: [] }]))).toBeNull();
  });

  it('der Satz der Route, der Anteil nur hinter der gesetzten Messstelle, je Kostenstelle mit Namen und Tag', () => {
    const bild = setzenDoppeltBild(
      antwort('MS-20', [
        { kostenstelle: K4100, am: '2026-11-01', enthalten: [enthalten('MS-06', 'MS-20'), enthalten('MS-20', 'MS-21')], nicht_pruefbar: [] },
        {
          kostenstelle: K4200,
          am: '2026-11-01',
          enthalten: [],
          nicht_pruefbar: [{ messstelle: 'MS-22', grund: 'formel_kreis', kette: ['MS-22', 'MS-22'], satz: 'Ob MS-22 doppelt zählt, ist nicht prüfbar.' }],
        },
      ]),
      { 'k-4100': 'Spritzguss' },
    );
    expect(bild).toEqual({
      titel: DOPPELT_TITEL,
      gespeichert: 'Die Verteilung ist gespeichert.',
      kostenstellen: [
        { id: 'k-4100', kopf: 'Kostenstelle 4100 Spritzguss ab 01.11.2026', saetze: ['MS-06 ist bereits in MS-20 enthalten', 'MS-20 ist bereits in MS-21 enthalten (Anteil 70 %)'] },
        { id: 'k-4200', kopf: 'Kostenstelle 4200 ab 01.11.2026', saetze: ['Ob MS-22 doppelt zählt, ist nicht prüfbar.'] },
      ],
      hinweis: DOPPELT_HINWEIS,
    });
  });

  it('100 % trägt keinen Anteil; nur „nicht prüfbar“ trägt keinen Hinweis auf doppelte Mengen', () => {
    const voll = { ...antwort('MS-06'), anteile: [anteil(K4100, '100.00')] };
    expect(setzenDoppeltBild({ ...voll, doppelzaehlung: [{ kostenstelle: K4100, am: '2026-11-01', enthalten: [enthalten('MS-06', 'MS-20')], nicht_pruefbar: [] }] })?.kostenstellen[0].saetze).toEqual([
      'MS-06 ist bereits in MS-20 enthalten',
    ]);
    const kreis = setzenDoppeltBild(
      antwort('MS-06', [{ kostenstelle: K4100, am: '2026-11-01', enthalten: [], nicht_pruefbar: [{ messstelle: 'MS-06', grund: 'haengt_an_kreis', kette: ['MS-06'], satz: 'nicht prüfbar' }] }]),
    );
    expect(kreis?.hinweis).toBeNull();
  });
});
