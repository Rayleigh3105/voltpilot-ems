import { describe, expect, it } from 'vitest';
import { NETTO_WORT, nettoEur } from './erloesNetto';
import { cockpitHero } from './cockpitWidgets';
import { erloesErgebnis, signedEuro } from './erloesKomposition';
import { erloeseAggregat } from './portfolioHistorie';
import type { EarningsSite, SiteEarnings } from './api';

/**
 * **P9 · EINE Zahl über die Flächen** (Erlöse-Konzept
 * `data/vp-erloese-seite-konzept-e2` §2.3 B11/B12, E9 (a)).
 *
 * Die Vektoren sind Fixtures aus dem `derived.json` des Konzepts — dieselben
 * Zahlen, mit denen die abgenommenen Mockups gerechnet sind. Jede trägt BEIDE
 * Wege zum Netto nebeneinander: `nettoErgebnisEur`/`stromkostenEur` (der
 * anlagen-scharfe Endpunkt) und `actualEur` (der mandantenweite). Der Test
 * fährt jede Fläche über ihre eigene Quelle und verlangt EINE Zahl.
 */

interface Vektor {
  id: string;
  label: string;
  now: string;
  einspeiseErloesEur: number | null;
  eigenverbrauchsWertEur: number | null;
  stromkostenEur: number;
  nettoErgebnisEur: number;
  actualEur: number;
  gesamtertragEur: number;
  savedEur: number;
  to: string;
}

const VEKTOREN: Vektor[] = [
  {
    // Der Fall aus dem Captain-Screenshot: Cockpit sagte „Verdient 64,82 €",
    // die Erlöse-Seite „+ 63,23 €" — zwei Zahlen für denselben laufenden Tag.
    id: 'dv-tag-laufend',
    label: 'Mi., 02.09.2026',
    now: '2026-09-02T12:19:00+02:00',
    einspeiseErloesEur: 26.134,
    eigenverbrauchsWertEur: 38.684,
    stromkostenEur: 1.585,
    nettoErgebnisEur: 63.233,
    actualEur: -24.549,
    gesamtertragEur: 64.818,
    savedEur: -2.67,
    to: '2026-09-02T22:00:00Z',
  },
  {
    // Negativpreis-Tag: der Einspeise-Erlös ist NEGATIV, das Netto trotzdem
    // positiv — die Zahl darf sich vom Vorzeichen ihrer Teile nicht ableiten.
    id: 'dv-praemie-ruht',
    label: 'Mo., 24.08.2026',
    now: '2026-09-02T12:19:00+02:00',
    einspeiseErloesEur: -1.42,
    eigenverbrauchsWertEur: 30.1,
    stromkostenEur: 0.98,
    nettoErgebnisEur: 27.7,
    actualEur: 2.4,
    gesamtertragEur: 28.68,
    savedEur: 6.8,
    to: '2026-08-24T22:00:00Z',
  },
  {
    // Anlage OHNE bewerteten Eigenverbrauch: der Wert fehlt (nie eine 0), die
    // beiden gemessenen Terme bleiben trotzdem stehen.
    id: 'eeg-ohne-tarif',
    label: 'Di., 01.09.2026',
    now: '2026-09-02T14:05:00+02:00',
    einspeiseErloesEur: 1.995,
    eigenverbrauchsWertEur: null,
    stromkostenEur: 1.118,
    nettoErgebnisEur: 0.877,
    actualEur: -0.877,
    gesamtertragEur: 1.995,
    savedEur: 3.4,
    to: '2026-09-01T22:00:00Z',
  },
];

/** Die Antwort des ANLAGEN-scharfen Endpunkts (trägt das Netto fertig). */
function anlage(v: Vektor): SiteEarnings {
  return {
    einspeiseErloesEur: v.einspeiseErloesEur,
    eigenverbrauchsWertEur: v.eigenverbrauchsWertEur,
    stromkostenEur: v.stromkostenEur,
    nettoErgebnisEur: v.nettoErgebnisEur,
    actualEur: v.actualEur,
    gesamtertragEur: v.gesamtertragEur,
    savedEur: v.savedEur,
    arbitrageEur: null,
    anzulegenderWertCtKwh: null,
    firstCoveredDate: null,
    peakShaving: null,
    range: 'day',
    to: v.to,
    tarifArt: 'dynamisch',
    tarifParamCtKwh: null,
    reason: null,
    coveredSlots: 96,
  } as unknown as SiteEarnings;
}

/**
 * Die Zeile des MANDANTENWEITEN Endpunkts — er trägt bewusst weder
 * Stromkosten noch Netto (`EarningsSiteDto`), sondern nur `actualEur`.
 */
function flotte(v: Vektor, id = v.id): EarningsSite {
  return {
    id,
    name: `Anlage ${id}`,
    einspeiseErloesEur: v.einspeiseErloesEur,
    eigenverbrauchsWertEur: v.eigenverbrauchsWertEur,
    gesamtertragEur: v.gesamtertragEur,
    actualEur: v.actualEur,
    savedEur: v.savedEur,
    arbitrageEur: null,
    anzulegenderWertCtKwh: null,
    peakShaving: null,
    coveredSlots: 96,
    reason: null,
    eingespeistKwh: null,
    series: [],
  } as unknown as EarningsSite;
}

describe('P9 · dieselbe Zahl im Cockpit, in der Erlöse-Welt und im Portfolio', () => {
  it.each(VEKTOREN.map((v) => [v.id, v] as const))(
    '%s: beide Endpunkt-Formen ergeben dasselbe Netto',
    (_id, v) => {
      expect(nettoEur(anlage(v))).toBeCloseTo(v.nettoErgebnisEur, 6);
      // Der Flotten-Weg rechnet über die serverseitige Identität — und landet
      // auf denselben Cent, ohne dass der Endpunkt Stromkosten nennt.
      expect(nettoEur(flotte(v))).toBeCloseTo(v.nettoErgebnisEur, 6);
    },
  );

  it.each(VEKTOREN.map((v) => [v.id, v] as const))(
    '%s: Cockpit-Held == Erlöse-Held, mit demselben Wort',
    (_id, v) => {
      const hero = cockpitHero({
        money: anlage(v),
        range: 'day',
        now: new Date(v.now),
      });
      const seite = erloesErgebnis({
        money: anlage(v),
        periodLabel: v.label,
        now: new Date(v.now),
      });

      expect(seite.nettoEur).toBeCloseTo(v.nettoErgebnisEur, 6);
      // Dieselbe Zahl, in derselben Schreibweise.
      expect(hero.money?.value).toBe(signedEuro(seite.nettoEur as number));
      expect(hero.money?.label).toContain(NETTO_WORT);
    },
  );

  it('B11: der Held wäre vor P9 eine ANDERE Zahl gewesen (nicht vakuum)', () => {
    const v = VEKTOREN[0];
    const hero = cockpitHero({ money: anlage(v), range: 'day', now: new Date(v.now) });
    // 64,82 € (Gesamtertrag) gegen 63,23 € (unterm Strich) — genau der Bruch,
    // den der Captain im Screenshot gesehen hat.
    expect(v.gesamtertragEur).not.toBeCloseTo(v.nettoErgebnisEur, 2);
    expect(hero.money?.value).not.toContain('64,82');
    expect(hero.money?.value).toContain('63,23');
    expect(hero.money?.label).not.toContain('Verdient');
  });

  it('Portfolio: die Σ ist die Summe der Anlagen-Nettos, und die Teile ergeben sie', () => {
    const zeilen = VEKTOREN.map((v, i) => flotte(v, `s${i}`));
    const a = erloeseAggregat(zeilen);

    const erwartet = VEKTOREN.reduce((n, v) => n + v.nettoErgebnisEur, 0);
    expect(a.nettoEur).toBeCloseTo(erwartet, 6);
    expect(
      (a.einspeiseEur ?? 0) + (a.eigenverbrauchEur ?? 0) - (a.stromkostenEur ?? 0),
    ).toBeCloseTo(a.nettoEur as number, 6);
    // Jede Zeile trägt genau das Netto ihrer eigenen Anlagen-Seite.
    for (const [i, v] of VEKTOREN.entries()) {
      const z = a.zeilen.find((r) => r.siteId === `s${i}`);
      expect(z?.nettoEur).toBeCloseTo(v.nettoErgebnisEur, 6);
    }
  });

  it('nie eine erfundene 0: ohne berechenbaren Zeitraum bleibt das Netto leer', () => {
    expect(nettoEur(null)).toBeNull();
    expect(
      nettoEur({ nettoErgebnisEur: null, actualEur: null, eigenverbrauchsWertEur: 12 }),
    ).toBeNull();
  });
});
