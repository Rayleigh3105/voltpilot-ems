import { describe, expect, it } from 'vitest';
import type { Bilanz } from './api';
import {
  ANTEIL_WORT,
  HERKUNFT_UNVOLLSTAENDIG,
  HILFE_NEGATIV,
  LIVE_GRUND,
  REST_ANGELEGT,
  STELLUNG_GEAENDERT,
  ausloeserText,
  darf,
  energiebilanzBild,
  energiebilanzHash,
  hatHauptzaehler,
  liveBild,
  mitEnergiebilanz,
  restAngelegtSatz,
  restHerkunft,
  standortDerAnlage,
  zeitraumAus,
  type BilanzKontext,
  type EnergiebilanzBild,
  type ZeileBild,
} from './anlageEnergiebilanz';
import { UEMS_NOCH_NICHT_GERECHNET_SATZ } from './glossar';
import { anlageSurface } from './surface';
import { ahrenbergBilanz } from './test/bilanzFixtures';
import { ahrenbergFunktionen } from './test/funktionenFixtures';
import { ahrenbergRegister } from './test/messstellenRegisterFixtures';
import faelle from './test/oberflaechenFaelle.json';
import { FIXTURE_IDS } from './test/standorteFixtures';
import { BERECHNET_DIFFERENZ, KEINE_WERTE } from './uemsBilanz';
import { zahl } from './uemsErgebnis';
import { OHNE_HAUPTZAEHLER } from './uemsOberflaechen';

/**
 * UEMS AP-13 IP-8 (= AP-10 IP-14) — die Energiebilanz je Anlage gegen die Referenzfälle O5–O8 (B1/B2) und die Regeln
 * der Fläche: jede Zahl aus der Route, „nicht zugeordnet“ immer, Speicher-Anteile als zwei Zeilen, Balken ohne
 * Prozentzahl, „mindestens …“ und „— keine Werte“, Live-Zeile mit Stand und Grund, Abschnitte untereinander.
 */

const { an1, an2, an3, st1 } = FIXTURE_IDS;
const NBSP = String.fromCharCode(160);
const t = (s: string | null) => (s ?? '').split(NBSP).join(' ');
const ARTEN = new Map(ahrenbergRegister().register.map((z) => [z.kennzeichen, z.art]));
const ctx = (heute = '2026-11-05'): BilanzKontext => ({ heute, arten: ARTEN });
const fall = (id: string) => (faelle as unknown as { faelle: { id: string; erwartet: Record<string, unknown> }[] }).faelle.find((f) => f.id === id)!;

const zeilen = (b: EnergiebilanzBild, h = 0, ab = 0, tag = 0): ZeileBild[] => b.hauptzaehler[h].abschnitte[ab].tage[tag].zeilen;
const zeile = (z: ZeileBild[], art: ZeileBild['art']) => z.find((x) => x.art === art)!;
const alleTexte = (b: EnergiebilanzBild): string =>
  t(JSON.stringify(b, (k, v) => (k === 'balken' || k === 'key' ? undefined : v)));

describe('O5 · B1 — Energiebilanz Halle 2, Oktober 2026', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01'), ctx());
  const z = zeilen(b);

  it('zeigt Zufluss · Zugeordnet · Nicht zugeordnet — ohne Abfluss, weil Halle 2 keinen hat', () => {
    expect(z.map((x) => x.art)).toEqual(['zufluss', 'zugeordnet', 'rest']);
    expect(z.map((x) => t(x.zahl))).toEqual(['36.900 kWh', '33.100 kWh', '3.800 kWh']);
    expect(b.zeitraum).toBe('Oktober 2026');
    expect(b.zone).toBe('Zeiten in Europe/Berlin');
    expect(b.hauptzaehler[0].titel).toBe('Hauptzähler Netzbezug Halle 2 (MS-10)');
  });

  it('nennt die Herkunft je Zeile (O5 erwartet): gemessen · MS-10, gemessen · 4 Unterzähler, berechnet (Differenz) · MS-15', () => {
    expect(zeile(z, 'zufluss').woerter).toEqual(['gemessen']);
    expect(zeile(z, 'zufluss').zusatz).toBe('Netzbezug Halle 2 (MS-10, Hauptzähler)');
    expect(zeile(z, 'zugeordnet').woerter).toEqual(['gemessen']);
    expect(zeile(z, 'zugeordnet').zusatz).toBe('4 Unterzähler');
    const rest = zeile(z, 'rest');
    expect(rest.wort).toBe('Nicht zugeordnet');
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
    expect(h.eingaenge.map(t)).toContain('Netzbezug Halle 2 (MS-10) · Zufluss · gemessen · 36.900 kWh · vollständig · Version 1');
    expect(h.eingaenge).toHaveLength(5);
    // Die gemessenen Zeilen tragen ihre Eingänge ebenfalls mit Version.
    expect(zeile(z, 'zugeordnet').herkunft.eingaenge.every((x) => x.endsWith('Version 1'))).toBe(true);
  });

  it('B2 — je Unterzähler ein Balken in kWh gegen den Zufluss, keine Prozentzahl', () => {
    const teile = zeile(z, 'zugeordnet').teile;
    expect(teile.map((x) => t(x.zahl))).toEqual((fall('O5').erwartet.anteils_balken_kwh as number[]).map((n) => t(zahl(n, 'kWh', 'monat'))));
    expect(teile.map((x) => x.balken)).toEqual([22400 / 36900, 6100 / 36900, 3500 / 36900, 1100 / 36900]);
    for (const teil of teile) expect(`${teil.name} ${teil.zahl} ${teil.woerter.join(' ')}`).not.toMatch(/%/);
    for (const x of z) expect(`${x.zahl} ${x.woerter.join(' ')} ${x.zusatz ?? ''}`).not.toMatch(/%/);
    expect(fall('O5').erwartet.prozentzahl_am_balken).toBe(false);
  });
});

describe('O6 — Halle 1 mit Abfluss und den Speicher-Anteilen als zwei Zeilen', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an1, 'monat', '2026-10-01'), ctx());
  const z = zeilen(b);

  it('zeigt die Summen der Route (O6 erwartet)', () => {
    expect(z.map((x) => x.art)).toEqual(['zufluss', 'abfluss', 'zugeordnet', 'rest']);
    expect(z.map((x) => t(x.zahl))).toEqual(['150.400 kWh', '11.020 kWh', '84.800 kWh', '54.580 kWh']);
    expect(zeile(z, 'zufluss').teile).toHaveLength(3);
    expect(zeile(z, 'abfluss').teile).toHaveLength(2);
    expect(zeile(z, 'zugeordnet').zusatz).toBe('4 Unterzähler');
    expect(zeile(z, 'rest').zusatz).toBe('Halle 1 + Verwaltung nicht zugeordnet (MS-09)');
  });

  it('Speicher entladen steht im Zufluss, Speicher laden im Abfluss — nie saldiert (800 kWh erscheint nirgends)', () => {
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
describe('AP-13 IP-11 — die Sprünge der Bilanz-Zeilen', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an1, 'monat', '2026-10-01'), ctx());
  const z = zeilen(b);

  it('jeder Unterzähler führt auf seine Seite — mit der Periode der Bilanz, nicht der der Leiste', () => {
    const teile = zeile(z, 'zugeordnet').teile;
    expect(teile.length).toBeGreaterThan(0);
    for (const t of teile) expect(t.sprung?.hash).toBe(`#/portfolio/messstellen/${t.kennzeichen}?periode=2026-10`);
  });

  it('ein Tag schneidet sich anders als ein Monat — der Schlüssel der Periode kommt aus der ANTWORT', () => {
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

  it('das Ziel einer Verteilung ist die Kostenstellen-Karte — die Zahl im Satz wird der Sprung (D1)', () => {
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

  it('ohne Periode im Kontext trägt der Sprung keine — er zeigt dann die neueste, nie eine falsche', () => {
    const lindach = ahrenbergBilanz(an3, 'tag', '2026-10-18');
    const w = lindach.hauptzaehler[0].abschnitte[0].werte[0];
    const terme = lindach.hauptzaehler[0].abschnitte[0].terme;
    const h = restHerkunft(w.rest.herkunft!, w.eingaenge, terme, 'tag', 'Europe/Berlin', ctx());
    const sprung = h.eingaengeStuecke.flat().find((t) => t.sprung !== null);
    expect(sprung?.sprung?.hash).not.toContain('periode=');
  });
});

describe('O7 — „mindestens … (MS-14 fehlt)“ und „— keine Werte“ am 04.11.2026', () => {
  const b = energiebilanzBild(ahrenbergBilanz(an2, 'tag', '2026-11-04'), ctx());
  const z = zeilen(b);

  it('die Summe mit Lücke heißt „mindestens“ und nennt den fehlenden Eingang — wörtlich `anzeige` der Route', () => {
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

  it('MS-14 bekommt keinen Balken, sondern das Wort — keine Null-Länge', () => {
    const teile = zeile(z, 'zugeordnet').teile;
    const ms14 = teile.find((x) => x.kennzeichen === 'MS-14')!;
    expect(ms14.keineWerte).toBe(true);
    expect(ms14.balken).toBeNull();
    expect(ms14.zahl).toBe('—');
    expect(teile.filter((x) => x.balken !== null).map((x) => t(x.zahl))).toEqual(['740 kWh', '200 kWh', '115 kWh']);
  });
});

describe('O8 — die Live-Zeile mit Stand und Grund-Satz', () => {
  it('„jetzt: 1,6 kW nicht zugeordnet · Stand 10:15“', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-09-01'), ctx('2026-10-20'));
    expect(t(b.hauptzaehler[0].live.text)).toBe((fall('O8').erwartet.live as string).split(NBSP).join(' '));
    expect(t(b.hauptzaehler[0].live.text)).toBe('jetzt: 1,6 kW nicht zugeordnet · Stand 10:15');
  });

  it('ein veralteter Term macht einen Strich mit dem Namen — nie die Teilsumme 12,6 kW', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-09-01', { live: 'veraltet' }), ctx('2026-10-20'));
    expect(b.hauptzaehler[0].live.text).toBe('jetzt: — · Ladepunkt Parkplatz Halle 2 meldet sich gerade nicht');
    expect(b.hauptzaehler[0].live.ton).toBe('off');
    expect(fall('O8').erwartet.live_veraltet).toBe('— · Ladepunkt Parkplatz Halle 2 meldet sich gerade nicht');
  });

  it('je Grund der Route ein Satz — kein_geraet · kein_wert · veraltet; an einem anderen Tag mit Datum', () => {
    const terme = ahrenbergBilanz(an2).hauptzaehler[0].abschnitte[0].terme;
    const live = (grund: 'kein_geraet' | 'kein_wert' | 'veraltet') =>
      liveBild({ wert: null, einheit: 'kW', unvollstaendig: true, fehlende: [{ term: 'MS-12', grund }], stand: null }, terme, 'Europe/Berlin', ctx()).text;
    expect(live('kein_geraet')).toBe(`jetzt: — · ${LIVE_GRUND.kein_geraet.replace('{name}', 'Montage Linie M1')}`);
    expect(live('kein_wert')).toBe('jetzt: — · Montage Linie M1 hat noch keinen Wert');
    expect(live('veraltet')).toBe('jetzt: — · Montage Linie M1 meldet sich gerade nicht');
    const gestern = liveBild({ wert: 2, einheit: 'kW', unvollstaendig: false, fehlende: [], stand: '2026-11-04T09:30:00Z' }, terme, 'Europe/Berlin', ctx());
    expect(t(gestern.text)).toBe('jetzt: 2,0 kW nicht zugeordnet · Stand 04.11.2026 10:30');
  });
});

describe('„nicht zugeordnet“ ist eine Aussage — die Zeile steht immer', () => {
  const mitRest = (menge: number, kundensatz: string, kennzeichen: string[]): Bilanz => {
    const b = structuredClone(ahrenbergBilanz(an2, 'monat', '2026-10-01'));
    Object.assign(b.hauptzaehler[0].abschnitte[0].werte[0].rest, { menge, kundensatz, kennzeichen });
    return b;
  };

  it('auch mit 0 kWh', () => {
    const r = zeile(zeilen(energiebilanzBild(mitRest(0, '0 kWh sind keiner Messstelle zugeordnet', [BERECHNET_DIFFERENZ, 'nicht zugeordnet']), ctx())), 'rest');
    expect(t(r.zahl)).toBe('0 kWh');
    expect(r.ton).toBe('ok');
    expect(r.woerter).toEqual([BERECHNET_DIFFERENZ]);
  });

  it('negativ mit dem Satz der Route und dem Hilfe-Satz ohne Ursache', () => {
    const satz = `Messwerte passen nicht zusammen (${zahl(-5, 'kWh', 'monat')})`;
    const r = zeile(zeilen(energiebilanzBild(mitRest(-5, satz, [BERECHNET_DIFFERENZ, 'unplausibel (negativ)']), ctx())), 'rest');
    expect(r.zahl).toBe(zahl(-5, 'kWh', 'monat'));
    expect(r.ton).toBe('warn');
    expect(r.saetze).toEqual([satz, HILFE_NEGATIV]);
  });

  it('eine Rolle, deren Eingänge ALLE fehlen, zeigt einen Strich — nie „mindestens 0 kWh“', () => {
    const b = structuredClone(ahrenbergBilanz(an2, 'tag', '2026-11-04'));
    Object.assign(b.hauptzaehler[0].abschnitte[0].werte[0].zufluss, { menge: 0, zustand: KEINE_WERTE, mit_werten: 0, fehlend: ['MS-10'], anzeige: `mindestens ${zahl(0, 'kWh', 'tag')} (MS-10 fehlt)` });
    const z = zeile(zeilen(energiebilanzBild(b, ctx())), 'zufluss');
    expect(z.zahl).toBe('—');
    expect(z.zusatz).toBe('(MS-10 fehlt)');
    expect(z.ton).toBe('off');
  });
});

describe('Stellungswechsel — Abschnitte untereinander, Tag für Tag, nie zusammengerechnet', () => {
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
    expect(hz.abschnitte[0].tage.every((x) => x.kompakt && x.zeilen.length === 3)).toBe(true);
    // Keine Zeile über den ganzen Monat: jede Zahl gehört genau einem Tag.
    expect(hz.abschnitte.flatMap((x) => x.tage).map((x) => t(zeile(x.zeilen, 'zufluss').zahl))).toEqual(['1.200 kWh', '1.200 kWh', '1.200 kWh']);
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

  it('ein laufender Zeitraum zeigt keine Zahl, sondern den Satz — die Live-Zeile bleibt', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-11-01'), ctx('2026-11-05'));
    expect(b.laeuft).toBe(UEMS_NOCH_NICHT_GERECHNET_SATZ);
    expect(energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01'), ctx('2026-11-05')).laeuft).toBeNull();
  });

  it('ohne Register-Art steht kein Herkunfts-Wort — nie geraten', () => {
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

describe('Rest anlegen — nur mit Recht (AP-03 IP-6: die Route trägt `messstelle.formel`)', () => {
  it('ohne Rest-Messstelle schlägt die Route „Rest anlegen“ vor; die Herkunft ist dann nicht vollständig', () => {
    const b = energiebilanzBild(ahrenbergBilanz(an2, 'monat', '2026-10-01', { restVorschlag: true }), ctx());
    const hz = b.hauptzaehler[0];
    expect(hz.vorschlag?.name).toBe('Werk Ahrenberg – Halle 2 nicht zugeordnet');
    expect(hz.vorschlag?.satz).toBe('Für „nicht zugeordnet“ gibt es noch keine eigene Messstelle. Vorschlag: „Werk Ahrenberg – Halle 2 nicht zugeordnet“ anlegen.');
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

  it('meldet, was geschah — ein zweiter Klick legt nie einen zweiten Rest an', () => {
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

describe('AP-07 IP-18b Summen-Wächter — geteilter Punkt im Abschnitt', () => {
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
