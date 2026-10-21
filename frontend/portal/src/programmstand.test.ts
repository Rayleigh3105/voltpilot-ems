import { describe, expect, it } from 'vitest';
import { programmstandGrund, programmstandZeile, type Programmstand } from './programmstand';

/** UEMS EZ-16: die Sätze zum Programmstand — den Vergleich macht der Server (`erzeuger/Programmstand`). */
const ALT: Programmstand = {
  zustand: 'aelter',
  ist: 2605,
  ist_text: '26.05',
  soll: 2610,
  soll_text: '26.10',
  soll_quelle: 'bibliothek',
  gemessen_am: '2026-10-21T10:00:00Z',
  warnen: true,
};

describe('programmstand', () => {
  it('ein alter Stand sagt, welcher läuft und welcher erwartet ist', () => {
    expect(programmstandZeile(ALT)).toEqual({
      wert: '26.05 · älter als erwartet',
      hinweis: 'Fährt einen alten Stand (26.05, erwartet 26.10).',
      ton: 'warn',
    });
    expect(programmstandGrund(ALT)).toEqual([
      'Programm',
      'Die Anlagensteuerung fährt einen alten Stand (26.05, erwartet 26.10).',
    ]);
  });

  it('aktuell ohne Hinweis und ohne Grund im Blatt', () => {
    const aktuell: Programmstand = { ...ALT, zustand: 'aktuell', ist: 2610, ist_text: '26.10', warnen: false };
    expect(programmstandZeile(aktuell)).toEqual({ wert: '26.10 · aktuell', hinweis: null, ton: 'ok' });
    expect(programmstandGrund(aktuell)).toBeNull();
  });

  it('unbekannt ist nie ein Stand und nie 0', () => {
    const unbekannt: Programmstand = { ...ALT, zustand: 'unbekannt', ist: null, ist_text: null, gemessen_am: null, warnen: false };
    expect(programmstandZeile(unbekannt)).toEqual({ wert: 'nicht gelesen', hinweis: null, ton: 'neutral' });
    expect(programmstandGrund(unbekannt)).toBeNull();
    expect(programmstandGrund(null)).toBeNull();
    expect(programmstandGrund(undefined)).toBeNull();
  });
});
