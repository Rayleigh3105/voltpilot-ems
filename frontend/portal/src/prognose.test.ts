import { describe, expect, it } from 'vitest';
import type { ForecastAccuracyPoint, ForecastModelId, ForecastModelState } from './api';
import {
  abweichung,
  KANDIDAT_EHRLICHKEIT,
  KEIN_VERGLEICH_GRUND,
  NOCH_KEINE_BEWERTUNG_GRUND,
  POLARITAET,
  VERBESSERUNG_WORT,
  direktEtikett,
  kandidatKern,
  verbesserung,
  kandidatenZeilen,
  KIND_LABELS,
  mittlereMae,
  RAHMUNG,
  skillBilanz,
  verdikt,
} from './prognose';
import { NBSP } from './format';

function punkt(
  day: string,
  model: ForecastModelId,
  kind: 'load' | 'pv',
  maeKw: number,
  skillVsBaseline: number | null = null,
): ForecastAccuracyPoint {
  return { day, model, kind, maeKw, nmaePct: null, biasKw: null, skillVsBaseline, nSlots: 96 };
}

function kandidat(p: Partial<ForecastModelState> & { model: ForecastModelId }): ForecastModelState {
  return {
    kind: 'load',
    status: 'ready',
    active: false,
    daysCollected: null,
    daysRequired: null,
    trainedAt: null,
    trainRows: null,
    featureImportance: [],
    updatedAt: null,
    ...p,
  };
}

const AKTIV = { load: 'load-persistence', pv: 'pv-physical' } as const;

describe('abweichung', () => {
  it('schreibt die Abweichung als Betrag mit geschuetzter Einheit', () => {
    expect(abweichung(0.75)).toBe(`±0,75${NBSP}kW`);
    expect(abweichung(1.357)).toBe(`±1,36${NBSP}kW`);
  });

  it('gibt fuer nichts einen Gedankenstrich, nie eine Null', () => {
    expect(abweichung(null)).toBe('—');
  });
});

describe('verdikt', () => {
  it('beantwortet die Frage der Seite: 2 Arten x Ø-Abweichung', () => {
    const acc = [
      punkt('2026-08-08', 'load-persistence', 'load', 0.7),
      punkt('2026-08-09', 'load-persistence', 'load', 0.8),
      punkt('2026-08-09', 'pv-physical', 'pv', 1.36),
    ];
    const zeilen = verdikt(acc, AKTIV);
    expect(zeilen).toHaveLength(2);
    expect(zeilen[0].art).toBe(KIND_LABELS.load);
    expect(zeilen[0].wert).toBe(`±0,75${NBSP}kW`);
    expect(zeilen[0].note).toBe('letzte 2 Tage');
    expect(zeilen[1].art).toBe(KIND_LABELS.pv);
    expect(zeilen[1].wert).toBe(`±1,36${NBSP}kW`);
    expect(zeilen[1].note).toBe('letzte 1 Tag');
  });

  it('nennt beide Arten AUCH ohne Bewertung - mit Grund statt einer Null', () => {
    const zeilen = verdikt([], AKTIV);
    expect(zeilen.map((z) => z.art)).toEqual([KIND_LABELS.load, KIND_LABELS.pv]);
    expect(zeilen.every((z) => z.wert === '—')).toBe(true);
    expect(zeilen.every((z) => z.note === 'noch keine Bewertung')).toBe(true);
  });

  it('mittelt NUR das aktive Modell, nie den Schatten-Kandidaten', () => {
    const acc = [
      punkt('2026-08-09', 'load-persistence', 'load', 1.0),
      // Der Kandidat ist deutlich besser - er darf das Verdikt nicht schoenen.
      punkt('2026-08-09', 'load-xgb', 'load', 0.1, 0.9),
    ];
    expect(verdikt(acc, AKTIV)[0].wert).toBe(`±1${NBSP}kW`);
  });

  it('nimmt die JUENGSTEN Tage, nicht die ersten', () => {
    const acc = [
      punkt('2026-08-01', 'load-persistence', 'load', 9),
      punkt('2026-08-08', 'load-persistence', 'load', 1),
      punkt('2026-08-09', 'load-persistence', 'load', 1),
    ];
    expect(verdikt(acc, AKTIV, 2)[0].wert).toBe(`±1${NBSP}kW`);
  });
});

describe('mittlereMae / skillBilanz', () => {
  it('meldet ohne Datenpunkt null statt einer Null', () => {
    expect(mittlereMae([], 'load-xgb')).toBeNull();
    expect(skillBilanz([], 'load-xgb')).toBeNull();
  });

  it('zaehlt nur bewertete Tage (skill null = keine Bewertung)', () => {
    const acc = [
      punkt('2026-08-09', 'load-xgb', 'load', 0.5, 0.3),
      punkt('2026-08-08', 'load-xgb', 'load', 0.6, -0.1),
      punkt('2026-08-07', 'load-xgb', 'load', 0.6, null),
    ];
    expect(skillBilanz(acc, 'load-xgb')).toEqual({ besser: 1, gesamt: 2 });
  });
});

describe('kandidatenZeilen', () => {
  it('macht aus einem sammelnden Kandidaten den ehrlichen Tag-Stand', () => {
    const zeilen = kandidatenZeilen(
      [kandidat({ model: 'pv-residual-xgb', kind: 'pv', status: 'collecting', daysCollected: 14, daysRequired: 21 })],
      [],
    );
    expect(zeilen[0]).toEqual({
      model: 'pv-residual-xgb',
      art: 'PV-Korrektur',
      stand: 'sammelt Daten · Tag 14/21',
      ton: 'sammelt',
    });
  });

  /**
   * `skillBilanz` bewertet die JUENGSTEN zehn Tage - die Reihenfolge der
   * Fixture ist also Teil der Aussage: `besser` beschreibt hier die letzten
   * `anzahl` Tage, nicht irgendwelche.
   */
  function letzteTage(besser: number, anzahl = 10): ForecastAccuracyPoint[] {
    return Array.from({ length: anzahl }, (_, i) =>
      punkt(
        `2026-07-${String(i + 1).padStart(2, '0')}`,
        'load-xgb',
        'load',
        0.5,
        // Die spaeten Tage (= die juengsten) tragen den Erfolg.
        i >= anzahl - besser ? 0.2 : -0.2,
      ),
    );
  }

  it('macht aus einem bewerteten Kandidaten die Quote', () => {
    const zeilen = kandidatenZeilen([kandidat({ model: 'load-xgb' })], letzteTage(8));
    expect(zeilen[0].art).toBe('Verbrauch');
    expect(zeilen[0].stand).toBe('in 8 von 10 Bewertungen genauer');
    expect(zeilen[0].ton).toBe('besser');
  });

  it('feiert eine MINDERHEIT nicht als Erfolg', () => {
    const zeilen = kandidatenZeilen([kandidat({ model: 'load-xgb' })], letzteTage(1));
    expect(zeilen[0].stand).toBe('in 1 von 10 Bewertungen genauer');
    expect(zeilen[0].ton).toBe('neutral');
  });

  it('ein Gleichstand ist noch kein "besser"', () => {
    const zeilen = kandidatenZeilen([kandidat({ model: 'load-xgb' })], letzteTage(5));
    expect(zeilen[0].ton).toBe('neutral');
  });

  it('bewertet nur die juengsten zehn Tage', () => {
    // 12 Tage, die zwei aeltesten schlecht - sie fallen aus dem Fenster.
    const zeilen = kandidatenZeilen([kandidat({ model: 'load-xgb' })], letzteTage(10, 12));
    expect(zeilen[0].stand).toBe('in 10 von 10 Bewertungen genauer');
  });

  it('erfindet ohne Bewertung KEINE Quote', () => {
    const zeilen = kandidatenZeilen([kandidat({ model: 'load-xgb' })], []);
    expect(zeilen[0].stand).toBe('rechnet mit · erste Bewertung folgt');
    expect(zeilen[0].ton).toBe('neutral');
  });

  it('ohne Kandidaten gibt es keine Zeile', () => {
    expect(kandidatenZeilen([], [])).toEqual([]);
  });
});

describe('die Rahmung ist load-bearing', () => {
  it('nennt beide Arten, das eine aktive Modell und den einen Kandidaten', () => {
    expect(RAHMUNG).toContain('2 Prognosearten');
    expect(RAHMUNG).toContain('1 aktives Modell');
    expect(RAHMUNG).toContain('höchstens 1');
  });

  it('sagt, dass ein Kandidat nichts steuert und nie automatisch wechselt', () => {
    expect(KANDIDAT_EHRLICHKEIT).toContain('beeinflussen Ihre Steuerung nicht');
    expect(KANDIDAT_EHRLICHKEIT).toContain('nie automatisch');
  });

  it('benennt die zwei Arten ueberall gleich', () => {
    expect(KIND_LABELS.load).toBe('Verbrauchsprognose (Last)');
    expect(KIND_LABELS.pv).toBe('PV-Prognose (Erzeugung)');
  });
});

describe('verbesserung (Stufe 4: die Fläche zwischen den Kurven, MIT Wort)', () => {
  it('zeichnet nur, wo der Kandidat WIRKLICH näher lag', () => {
    const v = verbesserung([1.0, 0.8, 0.5], [0.6, 0.9, 0.5]);
    expect(v.unten).toEqual([0.6, null, null]);
    expect(v.delta[0]).toBeCloseTo(0.4, 6);
    // Schlechter (0,9 > 0,8) und gleich (0,5) bekommen KEINE Fläche - sie
    // hieße sonst das Gegenteil dessen, was ihr Wort behauptet.
    expect(v.delta[1]).toBeNull();
    expect(v.delta[2]).toBeNull();
    expect(v.wort).toBe(VERBESSERUNG_WORT);
  });

  it('lässt eine Lücke eine Lücke - nie eine erfundene 0', () => {
    const v = verbesserung([1.0, null, 0.5], [null, 0.2, 0.1]);
    expect(v.unten).toEqual([null, null, 0.1]);
    expect(v.delta[0]).toBeNull();
    expect(v.delta[1]).toBeNull();
  });

  it('benennt nichts, wenn es nichts zu benennen gibt', () => {
    expect(verbesserung([0.5, 0.5], [0.9, 0.9]).wort).toBeNull();
    expect(verbesserung([], []).wort).toBeNull();
  });
});

describe('POLARITAET (die Aussage, die niemand raten soll)', () => {
  it('sagt in Worten, dass unten besser ist', () => {
    expect(POLARITAET.oben).toContain('schlechter');
    expect(POLARITAET.unten).toContain('besser');
  });
});

describe('kandidatKern (K1: abgeleitet, sonst der ehrliche Grund)', () => {
  const tage = (besser: number, gesamt: number): ForecastAccuracyPoint[] =>
    Array.from({ length: gesamt }, (_, i) =>
      punkt(`2026-08-${String(i + 1).padStart(2, '0')}`, 'load-xgb', 'load', 0.5, i < besser ? 0.2 : -0.1),
    );

  it('nennt die Bilanz und die zwei Ø-Abweichungen als Anker (K8)', () => {
    const k = kandidatKern(tage(11, 14), 'load-xgb');
    expect(k.wert).toBe('11 von 14');
    expect(k.satz).toMatch(/näher an der Wirklichkeit/);
    expect(k.ton).toBe('ok');
    // ⚠ NICHT der Ehrlichkeits-Satz: den trägt die Kandidaten-Zeile derselben
    // Seite schon, und zweimal derselbe Satz ist Rauschen.
    expect(k.anker).not.toBe(KANDIDAT_EHRLICHKEIT);
    expect(k.anker).toBeNull(); // ohne aktive Bewertungen kein erfundener Ø
  });

  it('traegt die Ø-Werte NICHT im Kopf - sie stehen an den Kurven (K2)', () => {
    // Beide Doppelungen sind hier festgenagelt: die Verdikt-Karte derselben
    // Seite nennt die Ø-Abweichung schon, die Kandidaten-Zeile den
    // Ehrlichkeits-Satz.
    expect(direktEtikett(tage(11, 14), 'load-xgb', false)).toBe(`Kandidat Ø ±0,5${NBSP}kW`);
    expect(direktEtikett([], 'load-xgb', false)).toBeNull();
    expect(
      direktEtikett(
        Array.from({ length: 3 }, (_, i) =>
          punkt(`2026-08-0${i + 1}`, 'load-persistence', 'load', 0.8),
        ),
        'load-persistence',
        true,
      ),
    ).toBe(`aktiv Ø ±0,8${NBSP}kW`);
  });

  it('feiert eine MINDERHEIT nicht als Erfolg', () => {
    expect(kandidatKern(tage(1, 12), 'load-xgb').ton).toBe('calm');
  });

  it('sagt ohne Kandidaten und ohne Bewertung den GRUND', () => {
    expect(kandidatKern(tage(3, 5), null)).toMatchObject({
      satz: null,
      grund: KEIN_VERGLEICH_GRUND,
    });
    const ohneSkill = [punkt('2026-08-01', 'load-xgb', 'load', 0.5, null)];
    expect(kandidatKern(ohneSkill, 'load-xgb')).toMatchObject({
      satz: null,
      grund: NOCH_KEINE_BEWERTUNG_GRUND,
    });
  });
});
