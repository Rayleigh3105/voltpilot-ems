import { describe, it, expect } from 'vitest';
import { strahlView } from './fahrplanStrahl';
import type { FilmRow, FilmView } from './fahrplanFilm';
import type { SlotRole } from './fahrplanWhy';

// UTC-ISO-Grenzen, damit die ms-Zerlegung von `strahlView` deterministisch ist
// (die deutschen Beschriftungen sind zonenabhaengig - darauf wird NICHT geprueft,
// nur auf Proportionen, Anzahl und `nowPct`, die reine Absolut-ms-Arithmetik sind).
function row(
  phaseIndex: number,
  role: SlotRole,
  label: string,
  fromMs: number,
  toMs: number,
  extra: Partial<FilmRow> = {},
): FilmRow {
  return {
    phaseIndex,
    role,
    kind: 'laden',
    now: false,
    done: false,
    label,
    time: 'irrelevant',
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    sub: null,
    eur: null,
    einkauf: false,
    duty: null,
    ...extra,
  };
}

const H = 3_600_000;
// Ein fester UTC-Anker; der Tag ist [0, 24h).
const T0 = Date.UTC(2026, 5, 15, 0, 0, 0);

function view(today: FilmRow[], past: FilmRow[] = []): FilmView {
  return { past, today, tomorrow: [], tomorrowSummary: null, empty: null };
}

describe('strahlView', () => {
  it('gibt ohne Phasen null zurueck', () => {
    expect(strahlView(view([]), new Date(T0))).toBeNull();
  });

  it('gibt bei entarteter Spanne null zurueck', () => {
    // Eine einzige Phase der Laenge 0.
    const v = view([row(0, 'warten', 'Ruhe', T0 + 6 * H, T0 + 6 * H)]);
    expect(strahlView(v, new Date(T0))).toBeNull();
  });

  it('breitet die Segmente proportional zur Dauer aus', () => {
    // 6h laden | 12h ruhe | 6h entladen ueber [0, 24h).
    const v = view([
      row(0, 'pv_speichern', 'Sonne speichern', T0, T0 + 6 * H),
      row(1, 'warten', 'Ruhe', T0 + 6 * H, T0 + 18 * H),
      row(2, 'verkaufen', 'Verkaufen', T0 + 18 * H, T0 + 24 * H),
    ]);
    const s = strahlView(v, new Date(T0 + 12 * H))!;
    expect(s).not.toBeNull();
    expect(s.segments).toHaveLength(3);

    expect(s.segments[0].leftPct).toBeCloseTo(0, 5);
    expect(s.segments[0].widthPct).toBeCloseTo(25, 5); // 6/24
    expect(s.segments[1].leftPct).toBeCloseTo(25, 5);
    expect(s.segments[1].widthPct).toBeCloseTo(50, 5); // 12/24
    expect(s.segments[2].leftPct).toBeCloseTo(75, 5);
    expect(s.segments[2].widthPct).toBeCloseTo(25, 5); // 6/24

    // Luecken- und ueberlappungsfrei: linke Kante + Breite == naechste linke Kante.
    expect(s.segments[0].leftPct + s.segments[0].widthPct).toBeCloseTo(s.segments[1].leftPct, 5);
    expect(s.segments[1].leftPct + s.segments[1].widthPct).toBeCloseTo(s.segments[2].leftPct, 5);
  });

  it('spannt die Achse ueber Vergangenheit UND heute, Morgen bleibt aussen', () => {
    const v: FilmView = {
      past: [row(0, 'guenstig_laden', 'Netzladen', T0, T0 + 6 * H, { done: true })],
      today: [row(1, 'warten', 'Ruhe', T0 + 6 * H, T0 + 24 * H, { now: true })],
      tomorrow: [row(2, 'verkaufen', 'Verkaufen', T0 + 30 * H, T0 + 36 * H)],
      tomorrowSummary: 'Morgen · 1 weitere Phase',
      empty: null,
    };
    const s = strahlView(v, new Date(T0 + 12 * H))!;
    // Genau die zwei Phasen von past+today, keine von morgen.
    expect(s.segments.map((x) => x.phaseIndex)).toEqual([0, 1]);
    // Die vergangene Phase traegt `done`.
    expect(s.segments[0].done).toBe(true);
    // Die laufende traegt `now`.
    expect(s.segments[1].now).toBe(true);
  });

  it('markiert `big` ab der Mindestbreite, schmale Segmente nicht', () => {
    // 23h ruhe (breit) + 1h entladen (~4,2%, schmal) ueber [0, 24h).
    const v = view([
      row(0, 'warten', 'Ruhe', T0, T0 + 23 * H),
      row(1, 'verkaufen', 'Verkaufen', T0 + 23 * H, T0 + 24 * H),
    ]);
    const s = strahlView(v, new Date(T0))!;
    expect(s.segments[0].big).toBe(true);
    expect(s.segments[1].big).toBe(false);
  });

  it('setzt nowPct nur, solange jetzt im gezeigten Tag liegt', () => {
    const v = view([row(0, 'warten', 'Ruhe', T0, T0 + 24 * H)]);
    // Mitte des Tages -> 50%.
    expect(strahlView(v, new Date(T0 + 12 * H))!.nowPct).toBeCloseTo(50, 5);
    // Genau am Anfang -> 0%.
    expect(strahlView(v, new Date(T0))!.nowPct).toBeCloseTo(0, 5);
    // Nach dem Ende -> null (kein Marker).
    expect(strahlView(v, new Date(T0 + 25 * H))!.nowPct).toBeNull();
    // Vor dem Anfang -> null.
    expect(strahlView(v, new Date(T0 - H))!.nowPct).toBeNull();
  });

  it('legt je vorkommende Rolle GENAU eine Legenden-Zeile an, mit dem ersten Wort', () => {
    const v = view([
      row(0, 'pv_speichern', 'Sonne speichern', T0, T0 + 6 * H),
      row(1, 'warten', 'Ruhe', T0 + 6 * H, T0 + 12 * H),
      row(2, 'pv_speichern', 'Sonne speichern (2)', T0 + 12 * H, T0 + 18 * H),
      row(3, 'warten', 'Ruhe (2)', T0 + 18 * H, T0 + 24 * H),
    ]);
    const s = strahlView(v, new Date(T0))!;
    // Vier Segmente, aber nur zwei Rollen -> zwei Legenden-Zeilen.
    expect(s.segments).toHaveLength(4);
    expect(s.legende).toEqual([
      { role: 'pv_speichern', label: 'Sonne speichern' },
      { role: 'warten', label: 'Ruhe' },
    ]);
  });

  it('reicht das Wort UND den Euro-Beitrag ans Segment durch', () => {
    const v = view([
      row(0, 'verkaufen', 'Verkaufen', T0, T0 + 24 * H, { eur: '+2,80 €', time: '0-24 Uhr' }),
    ]);
    const s = strahlView(v, new Date(T0))!;
    expect(s.segments[0].label).toBe('Verkaufen');
    expect(s.segments[0].eur).toBe('+2,80 €');
    expect(s.segments[0].time).toBe('0-24 Uhr');
  });

  it('legt Stundenmarken STRIKT innerhalb der Achse an', () => {
    const v = view([row(0, 'warten', 'Ruhe', T0, T0 + 24 * H)]);
    const s = strahlView(v, new Date(T0))!;
    expect(s.ticks.length).toBeGreaterThan(0);
    for (const t of s.ticks) {
      expect(t.atPct).toBeGreaterThan(0);
      expect(t.atPct).toBeLessThan(100);
    }
  });
});
