import { describe, expect, it } from 'vitest';
import type { Bilanz } from './api';
import {
  ANTEIL_WORT,
  ANTWORT,
  HERKUNFT_UNVOLLSTAENDIG,
  HILFE_NEGATIV,
  HILFE_NEGATIV_VERBRAUCH,
  KARTE_WORT,
  KEIN_UNTERZAEHLER,
  REST_ANGELEGT,
  STELLUNG_GEAENDERT,
  ausloeserText,
  ausserhalbSatz,
  darf,
  energiebilanzBild,
  energiebilanzHash,
  kennzeichenTeile,
  hatHauptzaehler,
  hauptzaehlerTitel,
  liveBild,
  mitEnergiebilanz,
  restAngelegtSatz,
  restHerkunft,
  standortDerAnlage,
  zeitraumAus,
  type BilanzKontext,
  type EnergiebilanzBild,
  type TagBild,
  type ZeileBild,
} from './anlageEnergiebilanz';
import { prozentText } from './bewertung';
import { dez } from './dez';
import { anlageSurface } from './surface';
import { ahrenbergBilanz } from './test/bilanzFixtures';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import faelle from './test/oberflaechenFaelle.json';
import { FIXTURE_IDS } from './test/standorteFixtures';
import { BERECHNET_DIFFERENZ, KEINE_WERTE } from './uemsBilanz';
import { zahl } from './uemsErgebnis';
import { nenner, prozent } from './uemsBewertung';
import { OHNE_HAUPTZAEHLER } from './uemsOberflaechen';

/**
 * UEMS AP-13 IP-8 (= AP-10 IP-14; Konzept Auswerten a1 §6.9) - die Energiebilanz je Anlage gegen die Referenzfälle O5–O8
 * und die Regeln der Fläche: Antwortsatz zuerst, jede Menge aus der Route, „ohne eigenen Zähler“ immer, Anteile nur aus dem
 * Zwilling der Bewertung (dieselbe Zahl wie die Bewertung), Speicher-Anteile als zwei Zeilen, „mindestens …“ und „—“ ohne
 * Wert, Live-Zeile nur mit Zahl, Abschnitte untereinander.
 */

const { an1, an2, an3, st1 } = FIXTURE_IDS;
const NBSP = String.fromCharCode(160);
const t = (s: string | null) => (s ?? '').split(NBSP).join(' ');
const ARTEN = new Map(ahrenbergRegister().register.map((z) => [z.kennzeichen, z.art]));
const ctx = (heute = '2026-11-05'): BilanzKontext => ({ heute, arten: ARTEN });
const fall = (id: string) => (faelle as unknown as { faelle: { id: string; erwartet: Record<string, unknown> }[] }).faelle.find((f) => f.id === id)!;

const zeilen = (b: EnergiebilanzBild, h = 0, ab = 0, tag = 0): ZeileBild[] => b.hauptzaehler[h].abschnitte[ab].tage[tag].zeilen;
const zeile = (z: ZeileBild[], art: ZeileBild['art']) => z.find((x) => x.art === art)!;
const tag0 = (b: EnergiebilanzBild): TagBild => b.hauptzaehler[0].abschnitte[0].tage[0];
const karte = (b: EnergiebilanzBild) => tag0(b).karte.map((k) => [k.wort, t(k.zahl)]);
const alleTexte = (b: EnergiebilanzBild): string =>
  t(JSON.stringify(b, (k, v) => (k === 'balken' || k === 'key' ? undefined : v)));

describe('O5 · B1 - Energiebilanz Halle 2, Oktober 2026', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01'), ctx());
  const z = zeilen(b);

  it('zeigt Zufluss · Zugeordnet · Nicht zugeordnet - ohne Abfluss, weil Halle 2 keinen hat', () => {
    expect(z.map((x) => x.art)).toEqual(['zufluss', 'zugeordnet', 'rest']);
    expect(z.map((x) => t(x.zahl))).toEqual(['36.900 kWh', '33.100 kWh', '3.800 kWh']);
    expect(b.zeitraum).toBe('Oktober 2026');
    expect(b.zone).toBe('Europe/Berlin');
    expect(b.hauptzaehler[0].titel).toBe('Hauptzähler Netzbezug Halle 2 (MS-10)');
  });

  it('Konzept a1 §6.9: Antwort zuerst, drei Zeilen der Karte und der Zwei-Teile-Balken', () => {
    const tag = tag0(b);
    expect(tag.einfach).toBe(true);
    expect(t(tag.antwort.satz)).toBe('89,7 % des Bezugs messen eigene Zähler; 3.800 kWh laufen ohne eigenen Zähler.');
    expect(karte(b)).toEqual([
      [KARTE_WORT.bezug, '36.900 kWh'],
      ['durch 4 Zähler erfasst', '33.100 kWh'],
      [KARTE_WORT.ohne, '3.800 kWh'],
    ]);
    // Die Breiten sind die Anteile des Zwillings - dieselbe Zahl, die die Bewertung als „x % der Anlage“ nennt.
    expect(tag.balken).toEqual({ erfasst: '89.7', ohne: '10.3' });
    expect(tag.balken?.ohne).toBe(prozent(dez('3800'), dez('36900')));
    // „berechnet (Differenz)“ steht in „Woraus gerechnet“, nicht unter der Zeile.
    expect(tag.karte.find((k) => k.art === 'ohne')?.unter).toEqual([]);
  });

  it('nennt die Herkunft je Zeile (O5 erwartet): gemessen · MS-10, gemessen · 4 Unterzähler, berechnet (Differenz) · MS-15', () => {
    expect(zeile(z, 'zufluss').woerter).toEqual(['gemessen']);
    expect(zeile(z, 'zufluss').teile.map((x) => x.name)).toEqual(['Netzbezug Halle 2 (MS-10, Hauptzähler)']);
    expect(zeile(z, 'zugeordnet').woerter).toEqual(['gemessen']);
    expect(zeile(z, 'zugeordnet').teile).toHaveLength(4);
    const rest = zeile(z, 'rest');
    expect(rest.wort).toBe('Ohne eigenen Zähler');
    expect(rest.woerter).toEqual([BERECHNET_DIFFERENZ]);
    expect(rest.zusatz).toBe('Halle 2 nicht zugeordnet (MS-15)');
    for (const kz of (fall('O5').erwartet.zeilen as string[]).flatMap((satz) => /(MS-\d+)/.exec(satz)?.[1] ?? [])) {
      expect(alleTexte(b)).toContain(kz);
    }
  });

  it('öffnet die Herkunfts-Karte des Rests (AP-10 §5.6): Fassung, Verteilung an 4300, Rechenzeitpunkt, Version, Eingänge mit Version', () => {
    const h = zeile(z, 'rest').herkunft;
    expect(h.zeilen[0]).toBe(`${BERECHNET_DIFFERENZ} · Formel: Fassung 1`);
    expect(h.zeilen).toContain('verteilt 100 % an Kostenstelle 4300');
    expect(h.zeilen).toContain('Version 1');
    expect(h.zeilen.some((x) => x.startsWith('berechnet am '))).toBe(true);
    expect(h.eingaenge.map(t)).toContain('Netzbezug Halle 2 (MS-10) · Hinein · gemessen · 36.900 kWh · vollständig · Version 1');
    expect(h.eingaenge).toHaveLength(5);
    // Die gemessenen Zeilen tragen ihre Eingänge ebenfalls mit Version.
    expect(zeile(z, 'zugeordnet').herkunft.eingaenge.every((x) => x.endsWith('Version 1'))).toBe(true);
  });

  it('je Unterzähler Menge und Anteil am Bezug (Zwilling `prozent`), nach Menge absteigend - keine Zahl am Balken', () => {
    const teile = tag0(b).unterzaehler;
    expect(teile.map((x) => t(x.zahl))).toEqual((fall('O5').erwartet.anteils_balken_kwh as number[]).map((n) => t(zahl(n, 'kWh', 'monat'))));
    expect(teile.map((x) => t(x.anteil))).toEqual(['60,7 % des Bezugs', '16,5 % des Bezugs', '9,5 % des Bezugs', '3,0 % des Bezugs']);
    for (const [i, kwh] of [22400, 6100, 3500, 1100].entries()) {
      expect(t(teile[i].anteil)).toBe(`${t(prozentText(prozent(dez(String(kwh)), dez('36900'))))} des Bezugs`);
    }
    expect(teile.map((x) => x.nurName)).toEqual(teile.map((x) => x.name.replace(` (${x.kennzeichen})`, '')));
    // Die Zeilen der Route tragen keine Prozentzahl; der Balken selbst hat kein Etikett (O5: keine Prozentzahl AM Balken).
    for (const x of z) expect(`${x.zahl} ${x.woerter.join(' ')} ${x.zusatz ?? ''}`).not.toMatch(/%/);
    expect(fall('O5').erwartet.prozentzahl_am_balken).toBe(false);
  });
});

describe('O6 - Halle 1 mit Abfluss und den Speicher-Anteilen als zwei Zeilen', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an1, 'monat', '2026-10-01'), ctx());
  const z = zeilen(b);

  it('zeigt die Summen der Route (O6 erwartet)', () => {
    expect(z.map((x) => x.art)).toEqual(['zufluss', 'abfluss', 'zugeordnet', 'rest']);
    expect(z.map((x) => t(x.zahl))).toEqual(['150.400 kWh', '11.020 kWh', '84.800 kWh', '54.580 kWh']);
    expect(zeile(z, 'zufluss').teile).toHaveLength(3);
    expect(zeile(z, 'abfluss').teile).toHaveLength(2);
    expect(zeile(z, 'zugeordnet').teile).toHaveLength(4);
    expect(zeile(z, 'rest').zusatz).toBe('Halle 1 + Verwaltung nicht zugeordnet (MS-09)');
    expect(b.hauptzaehler[0].restMessstelle?.text).toBe('geführt als Messstelle Halle 1 + Verwaltung nicht zugeordnet (MS-09)');
    expect(b.hauptzaehler[0].restMessstelle?.sprung?.hash).toBe('#/portfolio/messstellen/MS-09?periode=2026-10');
  });

  it('mit Erzeugung, Speicher und Einspeisung ist das Ganze der Verbrauch in der Anlage - der Nenner der Bewertung', () => {
    const tag = tag0(b);
    expect(tag.einfach).toBe(false);
    expect(karte(b)).toEqual([
      [KARTE_WORT.verbrauch, '139.380 kWh'],
      ['durch 4 Zähler erfasst', '84.800 kWh'],
      [KARTE_WORT.ohne, '54.580 kWh'],
    ]);
    expect(t(tag.karte[0].unter[0])).toBe('was hineinkommt (150.400 kWh) minus was hinausgeht (11.020 kWh)');
    // Derselbe Wert wie die Bewertung mit Abgabe und Laden getrennt (AP-16 nenner): 150.400 − 3.120 − 7.900.
    expect(nenner([{ kennung: 'AN-1', hauptzaehler: true, zufluss: '150400', abgabe: '3120', laden: '7900' }]).wert).toBe('139380');
    expect(t(tag.antwort.satz)).toBe('60,8 % des Verbrauchs messen eigene Zähler; 54.580 kWh laufen ohne eigenen Zähler.');
    expect(tag.balken).toEqual({ erfasst: '60.8', ohne: '39.2' });
    expect(tag.unterzaehler.every((x) => x.anteil?.endsWith(' des Verbrauchs'))).toBe(true);
  });

  it('Speicher entladen steht im Zufluss, Speicher laden im Abfluss - nie saldiert (800 kWh erscheint nirgends)', () => {
    const entladen = zeile(z, 'zufluss').teile.find((x) => x.kennzeichen === 'MS-04')!;
    const laden = zeile(z, 'abfluss').teile.find((x) => x.kennzeichen === 'MS-04')!;
    expect(t(entladen.zahl)).toBe('7.100 kWh');
    expect(entladen.woerter).toContain(ANTEIL_WORT.negativ);
    expect(t(laden.zahl)).toBe('7.900 kWh');
    expect(laden.woerter).toContain(ANTEIL_WORT.positiv);
    expect(alleTexte(b)).not.toMatch(/[^.\d]800 kWh/);
    expect(fall('O6').erwartet.speicher_saldiert).toBe(false);
  });
});

/**
 * UEMS AP-13 IP-11 (D1/D2): die Bilanz-Zeilen bekommen ihre Kanten. Ein Unterzähler führt auf seine
 * Messstellen-Seite MIT der Periode DIESER Bilanz; die Herkunft nennt je Eingang seine eigene Version;
 * das Ziel einer Verteilung ist die Kostenstellen-Karte.
 */
describe('AP-13 IP-11 - die Sprünge der Bilanz-Zeilen', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an1, 'monat', '2026-10-01'), ctx());
  const z = zeilen(b);

  it('jeder Unterzähler führt auf seine Seite - mit der Periode der Bilanz, nicht der der Leiste', () => {
    const teile = zeile(z, 'zugeordnet').teile;
    expect(teile.length).toBeGreaterThan(0);
    for (const t of teile) expect(t.sprung?.hash).toBe(`#/portfolio/messstellen/${t.kennzeichen}?periode=2026-10`);
  });

  it('jeder Eingang der Bilanz IST eine Messstelle - auch „AZ-2“ und „HZ-1“ springen auf ihre Seite', () => {
    const roh = structuredClone(ahrenbergBilanz(an2, 'monat', '2026-10-01'));
    const w = roh.hauptzaehler[0].abschnitte[0].werte[0];
    w.eingaenge = w.eingaenge.map((e) => (e.messstelle === 'MS-11' ? { ...e, messstelle: 'AZ-2' } : e));
    const teil = tag0(energiebilanzBild(roh, ctx())).unterzaehler.find((x) => x.kennzeichen === 'AZ-2');
    expect(teil?.sprung?.hash).toBe('#/portfolio/messstellen/AZ-2?periode=2026-10');
  });

  it('die Kennzeichen eines Eingangs (Ablesezeitraum, „ab …“) stehen in „Woraus gerechnet“, nicht in der Reihe', () => {
    const roh = structuredClone(ahrenbergBilanz(an2, 'monat', '2026-10-01'));
    const w = roh.hauptzaehler[0].abschnitte[0].werte[0];
    const satz = 'Ablesezeitraum 01.10. 00:00 – 01.11. 00:00 (Zuordnung durch den Kunden)';
    w.eingaenge = w.eingaenge.map((e) => (e.messstelle === 'MS-11' ? { ...e, kennzeichen: [satz] } : e));
    const tag = tag0(energiebilanzBild(roh, ctx()));
    expect(tag.unterzaehler.find((x) => x.kennzeichen === 'MS-11')?.woerter).toEqual([]);
    expect(zeile(tag.zeilen, 'zugeordnet').herkunft.eingaenge.find((e) => e.includes('(MS-11)'))).toContain(satz);
  });

  it('ein Tag schneidet sich anders als ein Monat - der Schlüssel der Periode kommt aus der ANTWORT', () => {
    const tag = energiebilanzBild(ahrenbergBilanz(an2, 'tag', '2026-11-04'), ctx());
    const teil = zeilen(tag).flatMap((x) => x.teile)[0];
    expect(teil.sprung?.hash).toBe(`#/portfolio/messstellen/${teil.kennzeichen}?periode=2026-11-04`);
  });

  it('die Herkunft nennt je Eingang SEINE Version; jede Zeile bleibt zeichengleich ihr Satz', () => {
    const h = zeile(z, 'zugeordnet').herkunft;
    expect(h.eingaengeStuecke.map((teile) => teile.map((t) => t.text).join(''))).toEqual(h.eingaenge);
    const spruenge = h.eingaengeStuecke.flat().filter((t) => t.sprung !== null);
    expect(spruenge.length).toBe(h.eingaenge.length);
    for (const t of spruenge) expect(t.sprung?.hash).toContain('periode=2026-10');
  });

  it('das Ziel einer Verteilung ist die Kostenstellen-Karte - die Zahl im Satz wird der Sprung (D1)', () => {
    const lindach = ahrenbergBilanz(an3, 'tag', '2026-10-18');
    const w = lindach.hauptzaehler[0].abschnitte[0].werte[0];
    const terme = lindach.hauptzaehler[0].abschnitte[0].terme;
    const satz = { ...w.rest.herkunft!.satz!, verteilung: { fassung: 1, ziel: '4200', anteil_prozent: '60' } };
    const h = restHerkunft({ satz, fehlt: [] }, w.eingaenge, terme, 'tag', 'Europe/Berlin', {
      ...ctx(),
      periode: { art: 'tag', am: '2026-10-18' },
    });
    const zeile = h.zeilenStuecke.find((teile) => teile.some((t) => t.text === '4200'))!;
    expect(zeile.find((t) => t.text === '4200')?.sprung?.hash).toBe(
      '#/portfolio/messstellen?reiter=kostenstellen&periode=tag&am=2026-10-18&kostenstelle=4200',
    );
    // Auch hier: der Satz bleibt zeichengleich der, der er war.
    expect(h.zeilenStuecke.map((teile) => teile.map((t) => t.text).join(''))).toEqual(h.zeilen);
  });

  it('ohne Periode im Kontext trägt der Sprung keine - er zeigt dann die neueste, nie eine falsche', () => {
    const lindach = ahrenbergBilanz(an3, 'tag', '2026-10-18');
    const w = lindach.hauptzaehler[0].abschnitte[0].werte[0];
    const terme = lindach.hauptzaehler[0].abschnitte[0].terme;
    const h = restHerkunft(w.rest.herkunft!, w.eingaenge, terme, 'tag', 'Europe/Berlin', ctx());
    const sprung = h.eingaengeStuecke.flat().find((t) => t.sprung !== null);
    expect(sprung?.sprung?.hash).not.toContain('periode=');
  });
});

describe('O7 - „mindestens … (MS-14 fehlt)“ und „— keine Werte“ am 04.11.2026', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an2, 'tag', '2026-11-04'), ctx());
  const z = zeilen(b);

  it('die Summe mit Lücke heißt „mindestens“ und nennt den fehlenden Eingang - wörtlich `anzeige` der Route', () => {
    const u = zeile(z, 'zugeordnet');
    expect(t(u.zahl)).toBe('mindestens 1.055 kWh (MS-14 fehlt)');
    expect(u.woerter).toContain('unvollständig');
    expect(u.ton).toBe('warn');
  });

  it('die Differenz mit Lücke ist „— keine Werte“, nie 145 kWh', () => {
    const rest = zeile(z, 'rest');
    expect(rest.zahl).toBe('—');
    expect(rest.woerter).toContain(KEINE_WERTE);
    expect(rest.zusatz).toBe('(MS-14 fehlt)');
    expect(rest.ton).toBe('off');
    expect(alleTexte(b)).not.toMatch(/145 kWh/);
    expect(fall('O7').erwartet.wert_145_gezeigt).toBe(false);
  });

  it('MS-14 ohne Wert steht am Ende, ohne Anteil - nie als 0', () => {
    const teile = tag0(b).unterzaehler;
    const ms14 = teile[teile.length - 1];
    expect(ms14.kennzeichen).toBe('MS-14');
    expect(ms14.keineWerte).toBe(true);
    expect(ms14.anteil).toBeNull();
    expect(ms14.zahl).toBe('—');
    expect(teile.filter((x) => !x.keineWerte).map((x) => t(x.zahl))).toEqual(['740 kWh', '200 kWh', '115 kWh']);
  });

  it('mehr als zwei fehlende Zähler als Anzahl, kein Wert überhaupt als eigener Satz', () => {
    const roh = structuredClone(ahrenbergBilanz(an2, 'tag', '2026-11-04'));
    const w = roh.hauptzaehler[0].abschnitte[0].werte[0];
    Object.assign(w.rest, { fehlend: ['MS-12', 'MS-13', 'MS-14'] });
    expect(t(tag0(energiebilanzBild(roh, ctx())).antwort.satz)).toBe(
      'Für 04.11.2026 fehlen Werte von 3 Zählern - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
    );
    w.eingaenge = w.eingaenge.map((e) => ({ ...e, menge: null }));
    expect(t(tag0(energiebilanzBild(roh, ctx())).antwort.satz)).toBe(
      'Für 04.11.2026 liegt von keinem Zähler dieser Anlage ein Wert vor - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
    );
    expect(tag0(energiebilanzBild(roh, ctx())).kennzeichen).toEqual(['MS-10', 'MS-11', 'MS-12', 'MS-13', 'MS-14']);
  });

  it('die Antwort nennt, was fehlt; kein Balken, kein Anteil', () => {
    const tag = tag0(b);
    expect(t(tag.antwort.satz)).toBe(
      'Für 04.11.2026 fehlen Werte von Ladepunkt Parkplatz Halle 2 (MS-14) - darum bleibt offen, wie viel ohne eigenen Zähler läuft.',
    );
    expect(tag.antwort.ton).toBe('off');
    expect(tag.balken).toBeNull();
    expect(karte(b)[2]).toEqual([KARTE_WORT.ohne, '—']);
    expect(tag.karte[2].unter).toEqual(['(MS-14 fehlt)', KEINE_WERTE]);
  });
});

describe('O8 - die Live-Zeile nur mit Zahl und Stand', () => {
  it('„jetzt 1,6 kW ohne eigenen Zähler · Stand 10:15“ - dieselbe Zahl und derselbe Stand wie O8', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-09-01'), ctx('2026-10-20'));
    expect(t(fall('O8').erwartet.live as string)).toContain('1,6 kW');
    expect(t(b.hauptzaehler[0].live?.text ?? null)).toBe('jetzt 1,6 kW ohne eigenen Zähler · Stand 10:15');
  });

  it('ein veralteter Term macht keine Zeile - nie die Teilsumme 12,6 kW, nie ein Gerätegrund in der Antwort', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-09-01', { live: 'veraltet' }), ctx('2026-10-20'));
    expect(b.hauptzaehler[0].live).toBeNull();
    expect(alleTexte(b)).not.toMatch(/12,6/);
    for (const grund of ['kein_geraet', 'kein_wert', 'veraltet'] as const) {
      expect(liveBild({ wert: null, einheit: 'kW', unvollstaendig: true, fehlende: [{ term: 'MS-12', grund }], stand: null }, 'Europe/Berlin', ctx())).toBeNull();
    }
  });

  it('an einem anderen Tag steht der Stand mit Datum', () => {
    const gestern = liveBild({ wert: 2, einheit: 'kW', unvollstaendig: false, fehlende: [], stand: '2026-11-04T09:30:00Z' }, 'Europe/Berlin', ctx());
    expect(t(gestern?.text ?? null)).toBe('jetzt 2,0 kW ohne eigenen Zähler · Stand 04.11.2026 10:30');
  });
});

describe('„nicht zugeordnet“ ist eine Aussage - die Zeile steht immer', () => {
  const mitRest = (menge: number, kundensatz: string, kennzeichen: string[]): Bilanz => {
    const b = structuredClone(ahrenbergBilanz(an2, 'monat', '2026-10-01'));
    Object.assign(b.hauptzaehler[0].abschnitte[0].werte[0].rest, { menge, kundensatz, kennzeichen });
    return b;
  };

  it('auch mit 0 kWh', () => {
    const b = energiebilanzBild(mitRest(0, '0 kWh sind keiner Messstelle zugeordnet', [BERECHNET_DIFFERENZ, 'nicht zugeordnet']), ctx());
    const r = zeile(zeilen(b), 'rest');
    expect(t(r.zahl)).toBe('0 kWh');
    expect(r.ton).toBe('ok');
    expect(r.woerter).toEqual([BERECHNET_DIFFERENZ]);
    expect(tag0(b).antwort.satz).toBe(ANTWORT.alles.replace('{ganz}', 'Bezug'));
  });

  it('negativ mit dem Satz der Route und dem Hilfe-Satz ohne Ursache - kein Balken', () => {
    const satz = `Messwerte passen nicht zusammen (${zahl(-5, 'kWh', 'monat')})`;
    const b = energiebilanzBild(mitRest(-5, satz, [BERECHNET_DIFFERENZ, 'unplausibel (negativ)']), ctx());
    const r = zeile(zeilen(b), 'rest');
    expect(r.zahl).toBe(zahl(-5, 'kWh', 'monat'));
    expect(r.ton).toBe('warn');
    expect(r.saetze).toEqual([satz, HILFE_NEGATIV]);
    expect(tag0(b).antwort).toEqual({ satz: HILFE_NEGATIV, ton: 'warn' });
    expect(tag0(b).balken).toBeNull();
    expect(tag0(b).karte[2].unter).toEqual(['unplausibel (negativ)', satz]);
  });

  it('mit Erzeugung und Speicher vergleicht der Hilfe-Satz mit dem Verbrauch in der Anlage, nicht mit dem Hauptzähler', () => {
    // Review r3 zu #1419: Hauptzähler 140.000 + PV 3.300 + Speicher entladen 7.100 − Abfluss 11.020 = 139.380 kWh
    // Verbrauch; die Unterzähler zählen 139.500 kWh - weniger als der Hauptzähler, aber 120 kWh mehr als der Verbrauch.
    const roh = structuredClone(ahrenbergBilanz(an1, 'monat', '2026-10-01'));
    const w = roh.hauptzaehler[0].abschnitte[0].werte[0];
    const satz = `Messwerte passen nicht zusammen (${zahl(-120, 'kWh', 'monat')})`;
    Object.assign(w.zugeordnet, { menge: 139500, anzeige: null });
    Object.assign(w.rest, { menge: -120, kundensatz: satz, kennzeichen: [BERECHNET_DIFFERENZ, 'unplausibel (negativ)'] });
    const b = energiebilanzBild(roh, ctx());
    expect(tag0(b).einfach).toBe(false);
    expect(tag0(b).karte[0].wort).toBe(KARTE_WORT.verbrauch);
    expect(tag0(b).antwort).toEqual({ satz: HILFE_NEGATIV_VERBRAUCH, ton: 'warn' });
    expect(zeile(zeilen(b), 'rest').saetze).toEqual([satz, HILFE_NEGATIV_VERBRAUCH]);
    expect(tag0(b).karte[2].unter).toEqual(['unplausibel (negativ)', satz]);
    expect(alleTexte(b)).not.toContain(HILFE_NEGATIV);
  });

  it('ohne Unterzähler läuft alles ohne eigenen Zähler - der Balken ist ganz grau', () => {
    const roh = structuredClone(ahrenbergBilanz(an2, 'monat', '2026-10-01'));
    const w = roh.hauptzaehler[0].abschnitte[0].werte[0];
    w.eingaenge = w.eingaenge.filter((e) => e.rolle !== 'zugeordnet');
    Object.assign(w.zugeordnet, { menge: null, zustand: null, mit_werten: 0, gesamt: 0, fehlend: [], kennzeichen: [], anzeige: null });
    Object.assign(w.rest, { menge: 36900 });
    const b = energiebilanzBild(roh, ctx());
    expect(t(tag0(b).antwort.satz)).toBe('Kein Unterzähler misst einen Teil des Bezugs: alle 36.900 kWh laufen ohne eigenen Zähler.');
    expect(tag0(b).balken).toEqual({ erfasst: '0.0', ohne: '100.0' });
    expect(tag0(b).karte[1]).toMatchObject({ wort: KARTE_WORT.erfasst.keiner, zahl: '—', unter: [KEIN_UNTERZAEHLER] });
    expect(tag0(b).unterzaehler).toEqual([]);
  });

  it('eine Rolle, deren Eingänge ALLE fehlen, zeigt einen Strich - nie „mindestens 0 kWh“', () => {
    const b = structuredClone(ahrenbergBilanz(an2, 'tag', '2026-11-04'));
    Object.assign(b.hauptzaehler[0].abschnitte[0].werte[0].zufluss, { menge: 0, zustand: KEINE_WERTE, mit_werten: 0, fehlend: ['MS-10'], anzeige: `mindestens ${zahl(0, 'kWh', 'tag')} (MS-10 fehlt)` });
    const z = zeile(zeilen(energiebilanzBild(b, ctx())), 'zufluss');
    expect(z.zahl).toBe('—');
    expect(z.zusatz).toBe('(MS-10 fehlt)');
    expect(z.ton).toBe('off');
  });
});

describe('Stellungswechsel - Abschnitte untereinander, Tag für Tag, nie zusammengerechnet', () => {
  const tag = ahrenbergBilanz(an2, 'tag', '2026-11-04');
  const w = tag.hauptzaehler[0].abschnitte[0].werte[0];
  const ab = tag.hauptzaehler[0].abschnitte[0];
  const wechsel: Bilanz = {
    ...tag,
    periode: 'monat',
    am: '2026-10-01',
    von: '2026-10-01',
    bis: '2026-10-31',
    hauptzaehler: [
      {
        ...tag.hauptzaehler[0],
        stellung_geaendert: true,
        abschnitte: [
          { ...ab, von: '2026-10-01', bis: '2026-10-02', raster: 'tag', werte: [{ ...w, von: '2026-10-01', bis: '2026-10-01' }, { ...w, von: '2026-10-02', bis: '2026-10-02' }] },
          { ...ab, von: '2026-10-03', bis: '2026-10-31', raster: 'tag', terme: ab.terme.filter((x) => x.messstelle !== 'MS-14'), werte: [{ ...w, von: '2026-10-03', bis: '2026-10-03' }] },
        ],
      },
    ],
  };
  const b = energiebilanzBild(wechsel, ctx());

  it('nennt den Wechsel und legt die Abschnitte mit ihren Tagen untereinander', () => {
    const hz = b.hauptzaehler[0];
    expect(hz.hinweis).toBe(STELLUNG_GEAENDERT);
    expect(hz.abschnitte.map((x) => x.titel)).toEqual(['01.10.–02.10.2026', '03.10.–31.10.2026']);
    expect(hz.abschnitte[0].tage.map((x) => x.titel)).toEqual(['01.10.2026', '02.10.2026']);
    expect(hz.abschnitte[0].tage.every((x) => x.kompakt && x.zeilen.length === 3 && x.karte.length === 3)).toBe(true);
    // Keine Zeile über den ganzen Monat: jede Zahl gehört genau einem Tag.
    expect(hz.abschnitte.flatMap((x) => x.tage).map((x) => t(zeile(x.zeilen, 'zufluss').zahl))).toEqual(['1.200 kWh', '1.200 kWh', '1.200 kWh']);
  });
});

describe('Titel des Hauptzählers', () => {
  it('nie zweimal „Hauptzähler“ - trägt der Name das Wort schon, steht es nicht davor', () => {
    expect(hauptzaehlerTitel('Hauptzähler Halle 1', 'HZ-1')).toBe('Hauptzähler Halle 1 (HZ-1)');
    expect(hauptzaehlerTitel('Netzbezug Halle 2', 'MS-10')).toBe('Hauptzähler Netzbezug Halle 2 (MS-10)');
    expect(hauptzaehlerTitel(null, 'MS-10')).toBe('Hauptzähler MS-10');
  });
});

describe('Leerzustand, Reiter und laufender Zeitraum', () => {
  it('ohne Hauptzähler: Leerzustand Z4, kein Reiter', () => {
    const ohne = ahrenbergBilanz(an2, 'monat', '2026-10-01', { ohneHauptzaehler: true });
    const b = energiebilanzBild(ohne, ctx());
    expect(b.leer).toBe(OHNE_HAUPTZAEHLER);
    expect(b.hauptzaehler).toEqual([]);
    expect(hatHauptzaehler(ohne)).toBe(false);
    const surface = anlageSurface({ entities: [], config: { plantKind: 'eigenverbrauch' } });
    expect(mitEnergiebilanz(surface, ohne)).toBe(surface);
    expect(mitEnergiebilanz(surface, null)).toBe(surface);
    expect(mitEnergiebilanz(surface, ahrenbergBilanz(an2)).energiebilanz).toBe(true);
  });

  it('ein laufender Zeitraum zeigt keine Zahl, sondern den Satz; ein künftiger sagt, dass es noch keine Werte gibt', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-11-01'), ctx('2026-11-05'));
    expect(b.laeuft).toBe('November 2026 läuft noch - die Bilanz steht, sobald der Monat abgeschlossen ist.');
    expect(energiebilanzBild(ahrenbergBilanz(an2, 'jahr', '2026-01-01'), ctx('2026-11-05')).laeuft).toBe(
      '2026 läuft noch - die Bilanz steht, sobald das Jahr abgeschlossen ist.',
    );
    expect(energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2029-03-01'), ctx('2026-11-05')).laeuft).toBe(
      'März 2029 hat noch nicht begonnen - dafür gibt es noch keine Werte.',
    );
    expect(energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01'), ctx('2026-11-05')).laeuft).toBeNull();
  });

  it('ohne Register-Art steht kein Herkunfts-Wort - nie geraten', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01'), { heute: '2026-11-05', arten: new Map() });
    expect(zeile(zeilen(b), 'zufluss').woerter).toEqual([]);
  });

  it('der Zeitraum steht in der Adresse; ohne ihn der letzte gebildete Monat', () => {
    expect(energiebilanzHash(an2, 'tag', '2026-11-04')).toBe(`#/anlage/${an2}/energiebilanz?periode=tag&am=2026-11-04`);
    expect(zeitraumAus(`#/anlage/${an2}/energiebilanz?periode=tag&am=2026-11-04`, '2026-11-05')).toEqual({ periode: 'tag', am: '2026-11-04' });
    expect(zeitraumAus(`#/anlage/${an2}/energiebilanz?periode=jahr&am=2025-06-17`, '2026-11-05')).toEqual({ periode: 'jahr', am: '2025-01-01' });
    expect(zeitraumAus(`#/anlage/${an2}/energiebilanz`, '2026-11-05')).toEqual({ periode: 'monat', am: '2026-10-01' });
    expect(zeitraumAus(`#/anlage/${an2}/energiebilanz?periode=woche&am=kaputt`, '2026-11-05')).toEqual({ periode: 'monat', am: '2026-10-01' });
  });
});

describe('Rest anlegen - nur mit Recht (AP-03 IP-6: die Route trägt `messstelle.formel`)', () => {
  it('ohne Rest-Messstelle schlägt die Route „Rest anlegen“ vor; die Herkunft ist dann nicht vollständig', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01', { restVorschlag: true }), ctx());
    const hz = b.hauptzaehler[0];
    expect(hz.vorschlag?.name).toBe('Werk Ahrenberg – Halle 2 nicht zugeordnet');
    expect(hz.vorschlag?.satz).toBe(
      'Als Messstelle „Werk Ahrenberg – Halle 2 nicht zugeordnet“ bekommt dieser Teil eine eigene Zeile in Verbrauch und lässt sich einem Bereich zuordnen.',
    );
    expect(hz.restMessstelle).toBeNull();
    const rest = zeile(zeilen(b), 'rest');
    expect(t(rest.zahl)).toBe('3.800 kWh');
    expect(rest.zusatz).toBeNull();
    expect(rest.herkunft.zeilen).toEqual([BERECHNET_DIFFERENZ, HERKUNFT_UNVOLLSTAENDIG]);
  });

  it('fragt das Recht am Standort der Anlage; unbekannt heißt noch kein Knopf, nicht abrufbar heißt die Route entscheidet', () => {
    const funktionen = ahrenbergFunktionen();
    expect(standortDerAnlage(funktionen, an2)).toBe(st1);
    expect(standortDerAnlage(null, an2)).toBeNull();
    const rechte = { standorte: new Map([[st1, ['messstelle.formel']]]), unternehmen: [] };
    expect(darf(rechte, st1, 'messstelle.formel')).toBe(true);
    expect(darf(rechte, FIXTURE_IDS.st2, 'messstelle.formel')).toBe(false);
    expect(darf(rechte, null, 'messstelle.formel')).toBe(true);
    expect(darf(undefined, st1, 'messstelle.formel')).toBe(false);
    expect(darf(null, st1, 'messstelle.formel')).toBe(true);
  });

  it('meldet, was geschah - ein zweiter Klick legt nie einen zweiten Rest an', () => {
    expect(restAngelegtSatz(true, 'MS-0023', 'Halle 2 nicht zugeordnet')).toBe(REST_ANGELEGT.replace('{kennzeichen}', 'MS-0023').replace('{name}', 'Halle 2 nicht zugeordnet'));
    expect(restAngelegtSatz(false, 'MS-15', null)).toBe('MS-15 „MS-15“ gab es schon.');
  });
});

describe('Herkunfts-Karte mit Versionen', () => {
  const b = ahrenbergBilanz(an3, 'tag', '2026-10-18');
  const w = b.hauptzaehler[0].abschnitte[0].werte[0];
  const terme = b.hauptzaehler[0].abschnitte[0].terme;

  it('Lindach am 18.10.2026: 100 − 60 − 30 = 10 kWh aus der Route', () => {
    expect(t(zeile(zeilen(energiebilanzBild(b, ctx())), 'rest').zahl)).toBe('10 kWh');
  });

  it('Version 2 nennt ihren Auslöser in Worten, nie die Werkstatt-Form', () => {
    const satz = { ...w.rest.herkunft!.satz!, version: 2, ausloeser: 'correction MS-17 2026-10-18 Version 2' };
    const h = restHerkunft({ satz, fehlt: [] }, w.eingaenge, terme, 'tag', 'Europe/Berlin', ctx());
    expect(h.zeilen).toContain('Version 2 · korrigiert: MS-17 (18.10.2026)');
    expect(h.zeilen.join(' ')).not.toMatch(/correction/);
    expect(ausloeserText('substitute MS-14 2026-11 Version 3')).toBe('mit Ersatzwert: MS-14 (November 2026)');
    expect(ausloeserText('etwas anderes')).toBeNull();
    expect(ausloeserText(null)).toBeNull();
  });
});

describe('AP-07 IP-18b Summen-Wächter - geteilter Punkt im Abschnitt', () => {
  it('nennt zwei Messstellen am selben Register der Box als Satz; ohne Fund kein Satz und keine Zahl anders', () => {
    const ohne = ahrenbergBilanz(an2, 'monat', '2026-10-01');
    const mit = structuredClone(ohne);
    mit.hauptzaehler[0].abschnitte[0].geteilte_register = [
      { rolle: 'zugeordnet', register: 'sunspec.model_203.totwhimp', messstellen: ['MS-12', 'MS-13'] },
    ];
    const vorher = energiebilanzBild(ohne, ctx());
    const nachher = energiebilanzBild(mit, ctx());
    expect(vorher.hauptzaehler[0].abschnitte[0].geteilt).toEqual([]);
    expect(nachher.hauptzaehler[0].abschnitte[0].geteilt).toEqual([
      'MS-12 und MS-13 hängen am selben Register der VoltPilot-Box.',
    ]);
    expect(nachher.hauptzaehler[0].abschnitte[0].tage).toEqual(vorher.hauptzaehler[0].abschnitte[0].tage);
    expect(alleTexte(nachher)).not.toContain('sunspec');
  });
});

describe('Konzept Auswerten a1, Befund 3 - Abzweige außerhalb der Bilanz werden benannt', () => {
  const namen = new Map([
    ['MS-20', 'Spritzguss'],
    ['AZ-2', 'Zähler Montage'],
  ]);

  it('nennt einen oder mehrere Abzweige mit Namen und Kennzeichen; ohne Abzweig kein Satz', () => {
    expect(ausserhalbSatz([], { namen })).toBeNull();
    expect(ausserhalbSatz(['MS-20'], { namen })?.satz).toBe(
      '1 Zähler hängt als Abzweig neben dem Hauptzähler und zählt hier nicht mit: Spritzguss (MS-20).',
    );
    // Ohne Namen im Register steht nur das Kennzeichen - nie geraten.
    expect(ausserhalbSatz(['MS-20', 'AZ-2', 'AZ-9'], { namen })?.satz).toBe(
      '3 Zähler hängen als Abzweig neben dem Hauptzähler und zählen hier nicht mit: Spritzguss (MS-20), Zähler Montage (AZ-2), AZ-9.',
    );
  });

  it('teilt den Satz an den Kennzeichen, damit „AZ-8“ nie am Bindestrich umbricht', () => {
    const bild = ausserhalbSatz(['AZ-8', 'MS-20'], { namen: new Map([['AZ-8', 'Zähler Gebäudetechnik']]) });
    expect(bild?.teile.map((t) => t.text).join('')).toBe(bild?.satz);
    expect(bild?.teile.filter((t) => t.kennzeichen).map((t) => t.text)).toEqual(['AZ-8', 'MS-20']);
    // Nur ganze Kennzeichen: „MS-2“ zerschneidet „MS-20“ nicht, gleich in welcher Reihenfolge; Sonderzeichen sind keine Muster.
    expect(kennzeichenTeile('a MS-20 b MS-2 c (X.1)', ['MS-2', 'MS-20', 'X.1'])).toEqual([
      { text: 'a ', kennzeichen: false },
      { text: 'MS-20', kennzeichen: true },
      { text: ' b ', kennzeichen: false },
      { text: 'MS-2', kennzeichen: true },
      { text: ' c (', kennzeichen: false },
      { text: 'X.1', kennzeichen: true },
      { text: ')', kennzeichen: false },
    ]);
    expect(kennzeichenTeile('XA1', ['X.1'])).toEqual([{ text: 'XA1', kennzeichen: false }]);
    expect(kennzeichenTeile('MS-20', ['MS-2']).filter((t) => t.kennzeichen)).toEqual([]);
  });

  it('trägt den Satz in den Abschnitt der Bilanz, aus dem Feld `ausserhalb` der Route', () => {
    const roh = ahrenbergBilanz(an2, 'monat', '2026-10-01');
    expect(energiebilanzBild(roh, ctx()).hauptzaehler[0].abschnitte[0].ausserhalb).toBeNull();
    roh.hauptzaehler[0].abschnitte[0].ausserhalb = ['MS-20'];
    expect(energiebilanzBild(roh, { ...ctx(), namen }).hauptzaehler[0].abschnitte[0].ausserhalb?.satz).toBe(
      '1 Zähler hängt als Abzweig neben dem Hauptzähler und zählt hier nicht mit: Spritzguss (MS-20).',
    );
  });
});
