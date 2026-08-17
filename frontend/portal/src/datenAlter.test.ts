import { describe, expect, it } from 'vitest';
import { STAND_PREFIX, newestTs, standLabel, standTime } from './datenAlter';

/** 17.08.2026, 17:55 Ortszeit - die Minute des belegten Herzogau-Befunds. */
const NOW = new Date(2026, 7, 17, 17, 55, 0);
const at = (h: number, m: number, day = 17) => new Date(2026, 7, day, h, m, 0).toISOString();

describe('standTime — der Messzeitpunkt als Uhrzeit', () => {
  it('nennt am selben Tag nur die Uhrzeit', () => {
    expect(standTime(at(12, 27), NOW)).toContain('12:27');
    expect(standTime(at(12, 27), NOW)).toContain('Uhr');
  });

  it('nennt an einem anderen Tag zusätzlich das Datum', () => {
    const label = standTime(at(23, 41, 16), NOW)!;
    expect(label).toContain('16.08.');
    expect(label).toContain('23:41');
  });

  it('erfindet ohne verwertbaren Zeitstempel keine Uhrzeit', () => {
    expect(standTime(null, NOW)).toBeNull();
    expect(standTime(undefined, NOW)).toBeNull();
    expect(standTime('', NOW)).toBeNull();
    expect(standTime('kein-datum', NOW)).toBeNull();
  });
});

describe('standLabel — der Ausweis erscheint erst außerhalb des Live-Fensters', () => {
  it('frisch: KEIN Ausweis (kein Dauer-Zeitstempel-Rauschen)', () => {
    expect(standLabel(at(17, 53), NOW)).toBeNull(); // 2 Min alt
    expect(standLabel(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBeNull();
    // Genau auf der Fenstergrenze zählt noch als frisch.
    expect(standLabel(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW)).toBeNull();
  });

  it('alt: der Ausweis nennt STATISCH den Messzeitpunkt (der 17:55-Fall)', () => {
    const label = standLabel(at(12, 27), NOW)!;
    expect(label.startsWith(STAND_PREFIX)).toBe(true);
    expect(label).toContain('12:27');
    // Statisch = eine Uhrzeit. Eine Dauer („vor 5 Std.") wäre in einer
    // eingefrorenen, nicht nachladenden Seite eine Lüge - die PR-279-Lehre.
    expect(label).not.toContain('vor ');
  });

  it('der Text hängt NICHT an `now` - nur die Frage, ob er erscheint', () => {
    const spaeter = new Date(NOW.getTime() + 2 * 3600_000);
    expect(standLabel(at(12, 27), spaeter)).toBe(standLabel(at(12, 27), NOW));
  });

  it('ein Zeitstempel aus der Zukunft gilt als frisch, nie als uralt', () => {
    expect(standLabel(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBeNull();
  });

  it('ohne Zeitstempel gibt es keinen Ausweis', () => {
    expect(standLabel(null, NOW)).toBeNull();
    expect(standLabel('kaputt', NOW)).toBeNull();
  });

  it('das Fenster ist überschreibbar (für Flächen mit eigener Kadenz)', () => {
    const zweiMin = new Date(NOW.getTime() - 2 * 60_000).toISOString();
    expect(standLabel(zweiMin, NOW)).toBeNull();
    expect(standLabel(zweiMin, NOW, 60_000)).toContain(STAND_PREFIX);
  });
});

describe('newestTs', () => {
  it('nimmt den jüngsten verwertbaren Zeitstempel', () => {
    expect(newestTs([at(12, 27), at(17, 54), at(9, 0)])).toBe(at(17, 54));
  });

  it('überspringt Lücken und Unsinn statt „jetzt" zu erfinden', () => {
    expect(newestTs([null, undefined, 'kaputt', at(12, 27)])).toBe(at(12, 27));
    expect(newestTs([])).toBeNull();
    expect(newestTs([null, 'kaputt'])).toBeNull();
  });
});
