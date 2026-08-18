/**
 * ERKLÄRBARKEIT STUFE 2 „Die Lage" (Konzept `data/vp-warum-erklaerbar-e2` §6 +
 * §10 Stufe 2, Captain-Entscheide F1-F6; **F4: nur die Fahrplan-Seite**).
 *
 * Geprüft wird in beide Richtungen, wie schon bei Stufe 1:
 *
 * 1. **Mit den Eingaben** entsteht die Erzählung, die am 17.08.2026 gefehlt hat
 *    (Fall 3 des Konzepts: der Trüb-Morgen) - und sie nennt die Zahlen, die sie
 *    tragen.
 * 2. **Ohne sie** entsteht GAR NICHTS. Ein Tag ohne eindeutigen Bogen bekommt
 *    keinen Bogen-Satz, ein Horizont ohne Morgen keinen Ausblick, und eine
 *    Zeile ohne eine einzige abgeleitete Aussage rendert nicht.
 *
 * Alle Zeitpunkte werden aus LOKALEN Bestandteilen gebaut (`new Date(y,m,d,h)`),
 * nie aus einem UTC-Literal: die Blöcke des Bogens und die Tagesgrenze rechnen
 * in der Zeitzone des Betrachters (die `todaySlots`-Konvention des Hauses), ein
 * fest verdrahtetes `Z` machte den Test von der Zeitzone des Läufers abhängig.
 */

import { describe, expect, it } from 'vitest';

import {
  AUSBLICK_MIN_END_HOUR,
  BEDINGUNGS_SATZ,
  LAGE_QUELLE_WETTER,
  ausblickSatz,
  bogenSatz,
  lageView,
  morgenEnergie,
  speicherHalbsatz,
  tagesbogen,
  type LageSlot,
} from './fahrplanLage';
import type { CloudPoint } from './weather';

/** Der Tag, an dem der reale Fall spielte. */
const Y = 2026;
const M = 7; // August
const D = 17;

const NOW = new Date(Y, M, D, 20, 45);

function iso(day: number, hour: number, minute = 0): string {
  return new Date(Y, M, day, hour, minute).toISOString();
}

/** Eine Viertelstunde des Plans. */
function slot(over: Partial<LageSlot> & { start: string }): LageSlot {
  return { batteryKw: 0, priceEurMwh: null, ...over };
}

/**
 * Ein Tag mit MITTAGSTAL: morgens/abends teuer, mittags günstig - und der
 * Fahrplan tut dazu das Erwartete (mittags laden, morgens/abends entladen).
 */
function talTag(over: { laden?: number; entladenRand?: number; entladenMittag?: number } = {}) {
  const laden = over.laden ?? 8;
  const entladenRand = over.entladenRand ?? 6;
  const entladenMittag = over.entladenMittag ?? 0;
  const slots: LageSlot[] = [];
  for (let h = 0; h < 24; h++) {
    for (let q = 0; q < 4; q++) {
      const morgens = h >= 6 && h < 11;
      const mittags = h >= 11 && h < 16;
      const abends = h >= 16 && h < 22;
      const ct = morgens ? 20.3 : mittags ? 14.0 : abends ? 20.9 : 18.0;
      const batteryKw = mittags
        ? laden - entladenMittag
        : morgens || abends
          ? -entladenRand
          : 0;
      slots.push(slot({ start: iso(D, h, q * 15), priceEurMwh: ct * 10, batteryKw }));
    }
  }
  return slots;
}

describe('Stufe 2: der Tages-Bogen wird nur bei EINDEUTIGER Form behauptet', () => {
  it('erkennt das Mittagstal und nennt alle drei Mittelwerte', () => {
    const bogen = tagesbogen(talTag(), NOW);
    expect(bogen).not.toBeNull();
    expect(bogen?.morgenCt).toBeCloseTo(20.3, 5);
    expect(bogen?.mittagCt).toBeCloseTo(14.0, 5);
    expect(bogen?.abendCt).toBeCloseTo(20.9, 5);
    const satz = bogenSatz(bogen) as string;
    expect(satz).toContain('20,3');
    expect(satz).toContain('14,0');
    expect(satz).toContain('20,9');
  });

  it('sagt den Plan-Halbsatz nur, soweit der Fahrplan ihn wirklich trägt', () => {
    // Lädt mittags UND entlädt in die Ränder.
    const beides = bogenSatz(tagesbogen(talTag(), NOW)) as string;
    expect(beides).toContain('entlädt den Speicher in die teuren Stunden und lädt ihn mittags');
    expect(beides).toContain('am leersten');

    // Lädt mittags, entlädt aber nirgends: dann wird die Entlade-Aussage nicht
    // behauptet.
    const nurLaden = bogenSatz(tagesbogen(talTag({ entladenRand: 0 }), NOW)) as string;
    expect(nurLaden).toContain('lädt den Speicher mittags');
    expect(nurLaden).not.toContain('in die teuren Stunden');

    // Gar keine Batterie-Bewegung: nur die Preis-Beobachtung.
    const flach = talTag().map((s) => ({ ...s, batteryKw: 0 }));
    const nurPreise = bogenSatz(tagesbogen(flach, NOW)) as string;
    expect(nurPreise).toContain('am teuersten');
    expect(nurPreise).not.toContain('Der Fahrplan');
  });

  it('behauptet ohne eindeutige Form GAR NICHTS', () => {
    // Flacher Tag: die Spanne trägt keinen Bogen.
    const flach = talTag().map((s) => ({ ...s, priceEurMwh: 200 }));
    expect(tagesbogen(flach, NOW)).toBeNull();
    expect(bogenSatz(null)).toBeNull();

    // Mittags TEUER statt günstig - kein Tal, also kein Satz.
    const umgekehrt = talTag().map((s) => {
      const h = new Date(s.start).getHours();
      const mittags = h >= 11 && h < 16;
      return { ...s, priceEurMwh: mittags ? 250 : 140 };
    });
    expect(tagesbogen(umgekehrt, NOW)).toBeNull();

    // Ein Lauf ohne Preise (ältere Zeilen) trägt keinen Block.
    const ohnePreis = talTag().map((s) => ({ ...s, priceEurMwh: null }));
    expect(tagesbogen(ohnePreis, NOW)).toBeNull();

    // Ein Lauf, der erst am Abend beginnt, hat keinen Morgen-Block.
    const nurAbend = talTag().filter((s) => new Date(s.start).getHours() >= 18);
    expect(tagesbogen(nurAbend, NOW)).toBeNull();
  });

  it('liest AUSSCHLIESSLICH die Viertelstunden von heute', () => {
    // Morgen trägt ein umgekehrtes Preisbild; es darf den Bogen nicht kippen.
    const morgen = talTag().map((s) => ({
      ...s,
      start: iso(D + 1, new Date(s.start).getHours(), new Date(s.start).getMinutes()),
      priceEurMwh: 400,
    }));
    const bogen = tagesbogen([...talTag(), ...morgen], NOW);
    expect(bogen?.mittagCt).toBeCloseTo(14.0, 5);
  });
});

// ---- Der Morgen-Ausblick --------------------------------------------------

/** Die Viertelstunden von MORGEN, mit den Prognosen, mit denen geplant wurde. */
function morgenSlots(opts: { pv: number; last: number; bisStunde?: number }): LageSlot[] {
  const bis = opts.bisStunde ?? 21;
  const out: LageSlot[] = [];
  for (let h = 0; h < bis; h++) {
    for (let q = 0; q < 4; q++) {
      // PV nur tagsüber - die Nacht trägt reine Last.
      const tag = h >= 8 && h < 17;
      out.push(
        slot({
          start: iso(D + 1, h, q * 15),
          pvKw: tag ? opts.pv : 0,
          loadKw: opts.last,
        }),
      );
    }
  }
  return out;
}

/** Eine Wetter-Vorhersage für morgen mit konstanter Bewölkung. */
function wetter(cloudPct: number): CloudPoint[] {
  return Array.from({ length: 15 }, (_, i) => ({
    ts: iso(D + 1, 6 + i),
    cloudCoverPct: cloudPct,
  }));
}

describe('Stufe 2: der Morgen-Ausblick rechnet NUR mit den Plan-Eingaben', () => {
  it('summiert Überschuss und Verbrauch über den ganzen morgigen Tag', () => {
    const e = morgenEnergie(morgenSlots({ pv: 4, last: 1 }), NOW);
    // 9 Tagstunden x (4-1) kW = 27 kWh Überschuss; 21 h x 1 kW = 21 kWh Verbrauch.
    expect(e?.ueberschussKwh).toBeCloseTo(27, 5);
    expect(e?.verbrauchKwh).toBeCloseTo(21, 5);
  });

  it('schweigt, solange der Horizont die Sonnenstunden von morgen nicht abdeckt', () => {
    // Ein Mittags-Lauf kennt von morgen nur die Stunden bis Mittag - die Summe
    // daraus wäre ein halber Tag und läse sich als „morgen kaum Sonne".
    const halb = morgenSlots({ pv: 4, last: 1, bisStunde: AUSBLICK_MIN_END_HOUR - 1 });
    expect(morgenEnergie(halb, NOW)).toBeNull();
    // Und ohne Prognose-Spalten (älterer Lauf) ebenfalls nichts.
    const ohne = morgenSlots({ pv: 4, last: 1 }).map((s) => ({ ...s, pvKw: null }));
    expect(morgenEnergie(ohne, NOW)).toBeNull();
  });

  it('nennt das Wetter-WORT und die kWh NEBENEINANDER, nie eines aus dem anderen', () => {
    const trueb = ausblickSatz(morgenSlots({ pv: 0.6, last: 1 }), NOW, {
      weather: wetter(95),
    }) as string;
    expect(trueb).toContain('kaum Sonne');
    expect(trueb).toContain('Solar-Überschuss');
    // Die Zahl kommt aus dem Plan, nicht aus der Bewölkung.
    expect(trueb).toContain('erwartetem Verbrauch');

    const sonnig = ausblickSatz(morgenSlots({ pv: 12, last: 1 }), NOW, {
      weather: wetter(5),
    }) as string;
    expect(sonnig).toContain('überwiegend Sonne');
  });

  it('nennt das Wetter-Wort auch dann, wenn der Plan morgen noch nicht abdeckt', () => {
    const nurWetter = ausblickSatz([], NOW, { weather: wetter(95) }) as string;
    expect(nurWetter).toContain('kaum Sonne');
    expect(nurWetter).not.toContain('Solar-Überschuss');
  });

  it('sagt den HORIZONT-Hinweis, wenn der Fahrplan morgen gar nicht erreicht', () => {
    // Ein Vormittags-Lauf: der Horizont endet an der heutigen Mitternacht.
    const vormittag = new Date(Y, M, D, 10, 0);
    const nurHeute = [slot({ start: iso(D, 22) }), slot({ start: iso(D, 23, 45) })];
    const satz = ausblickSatz(nurHeute, vormittag, {}) as string;
    expect(satz).toContain('Börsenpreise für morgen');
  });

  it('ohne Wetter UND ohne morgigen Horizont entsteht kein Ausblick', () => {
    expect(ausblickSatz([], NOW, {})).toBeNull();
  });
});

describe('Stufe 2: der Speicher-Halbsatz hängt an den Stufe-1-Lauf-Fakten', () => {
  it('sagt „hebt auf" nur mit Anker Bezugspreis UND geringer Auffüllung', () => {
    expect(
      speicherHalbsatz({ whyTerminalAnchor: 'bezugspreis', whyRefillFreePct: 0 }),
    ).toContain('hebt seine Ladung');
    // Anker fehlt: unerreichbar.
    expect(speicherHalbsatz({ whyRefillFreePct: 0 })).toBeNull();
    // Auffüllung fehlt: unerreichbar.
    expect(speicherHalbsatz({ whyTerminalAnchor: 'bezugspreis' })).toBeNull();
    // Gar keine Lauf-Fakten (älterer Lauf): unerreichbar.
    expect(speicherHalbsatz(null)).toBeNull();
    expect(speicherHalbsatz(undefined)).toBeNull();
  });

  it('sagt bei hoher Auffüllung die Gegen-Aussage', () => {
    expect(
      speicherHalbsatz({ whyTerminalAnchor: 'einspeisewert', whyRefillFreePct: 62 }),
    ).toContain('ohnehin wieder auf');
  });

  it('schweigt im Zwischenbereich - dort ist keine der beiden Aussagen wahr', () => {
    expect(
      speicherHalbsatz({ whyTerminalAnchor: 'bezugspreis', whyRefillFreePct: 40 }),
    ).toBeNull();
  });
});

// ---- Die ganze Zeile ------------------------------------------------------

describe('Stufe 2: die Abnahme - der 17.08.-Trüb-Morgen (Konzept §6 Fall 3)', () => {
  const slots = [...talTag(), ...morgenSlots({ pv: 0.6, last: 1 })];
  const view = lageView({
    slots,
    now: NOW,
    weather: wetter(96),
    plan: { whyTerminalAnchor: 'bezugspreis', whyRefillFreePct: 0 },
  });

  it('erzählt Tages-Bogen UND Morgen-Ausblick', () => {
    expect(view).not.toBeNull();
    expect(view?.bogen).toContain('mittags am günstigsten');
    expect(view?.ausblick).toContain('kaum Sonne');
    expect(view?.ausblick).toContain('Solar-Überschuss');
    // Der Speicher-Halbsatz - die Antwort, die am 17.08. gefehlt hat.
    expect(view?.ausblick).toContain('hebt seine Ladung für die kommenden Abende auf');
  });

  it('trägt den Bedingungs-Satz und nennt beide Quellen', () => {
    expect(view?.bedingung).toBe(BEDINGUNGS_SATZ);
    expect(view?.bedingung).toContain('alle 15 Minuten');
    expect(view?.quelle).toContain(LAGE_QUELLE_WETTER);
  });

  it('nennt das Wetter NICHT als Quelle, wenn kein Wetter-Wort entstand', () => {
    const ohneWetter = lageView({ slots, now: NOW });
    expect(ohneWetter?.quelle).not.toContain(LAGE_QUELLE_WETTER);
  });
});

describe('Stufe 2: ohne belegte Aussage rendert die Zeile GAR NICHT', () => {
  it('ein Lauf ohne Preise sagt statt eines Bogens den ehrlichen Horizont-Satz', () => {
    // Er endet an der heutigen Mitternacht - also gibt es über morgen nichts zu
    // sagen, und die Zeile sagt GENAU DAS statt eines erfundenen Ausblicks.
    const nackt = talTag().map((s) => ({ ...s, priceEurMwh: null }));
    const view = lageView({ slots: nackt, now: NOW });
    expect(view?.bogen).toBeNull();
    expect(view?.ausblick).toContain('Börsenpreise für morgen');
  });

  it('ein leerer Plan ohne Wetter ergibt null', () => {
    expect(lageView({ slots: [], now: NOW })).toBeNull();
  });

  it('der Bedingungs-Satz allein trägt keine Zeile', () => {
    // Nur Wetter, kein Plan: die Zeile ENTSTEHT (das Wetter ist eine Aussage) -
    // aber ohne jede Aussage bleibt sie weg.
    expect(lageView({ slots: [], now: NOW, weather: wetter(95) })).not.toBeNull();
    expect(lageView({ slots: [], now: NOW, weather: [] })).toBeNull();
  });
});
