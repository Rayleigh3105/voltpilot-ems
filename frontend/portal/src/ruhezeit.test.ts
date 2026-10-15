import { describe, expect, it } from 'vitest';
import { ruhezeitEndeFallsAktiv, type RuhezeitRegeln } from './ruhezeit';

const BERLIN = 'Europe/Berlin';

// Alle Zeitpunkte als UTC gebaut und über den bekannten Winter-Versatz (UTC+1, Oktober 2026 ist
// noch Sommerzeit UTC+2 bis zum letzten Sonntag im Oktober) in Berliner Ortszeit umgerechnet, damit
// der Test selbst keine Bibliothek braucht.
function berlinSommer(monat: number, tag: number, stunde: number, minute: number): Date {
  // UTC+2 im Oktober 2026 bis zur Umstellung (25.10.2026).
  return new Date(Date.UTC(2026, monat - 1, tag, stunde - 2, minute));
}

describe('ruhezeitEndeFallsAktiv', () => {
  const nachtfenster: RuhezeitRegeln = { werktags: { von: '22:00', bis: '07:00' } };

  it('ist nachts aktiv und endet morgens', () => {
    // Montag, 19.10.2026, 23:30 Ortszeit.
    const jetzt = berlinSommer(10, 19, 23, 30);
    const ende = ruhezeitEndeFallsAktiv(nachtfenster, BERLIN, jetzt);
    expect(ende).not.toBeNull();
    expect(ende?.getTime()).toBe(berlinSommer(10, 20, 7, 0).getTime());
  });

  it('ist mittags nicht aktiv', () => {
    const jetzt = berlinSommer(10, 20, 12, 0);
    expect(ruhezeitEndeFallsAktiv(nachtfenster, BERLIN, jetzt)).toBeNull();
  });

  it('bleibt im selben, gestern begonnenen Fenster bis zum Morgen', () => {
    // Dienstag 03:00 - das Fenster begann Montag 22 Uhr.
    const jetzt = berlinSommer(10, 20, 3, 0);
    const ende = ruhezeitEndeFallsAktiv(nachtfenster, BERLIN, jetzt);
    expect(ende?.getTime()).toBe(berlinSommer(10, 20, 7, 0).getTime());
  });

  it('wochenende "ganz" deckt Samstag und Sonntag als EIN Fenster ab', () => {
    // 17./18.10.2026 (Sa/So) liegen beide klar vor der Zeitumstellung am 25.10.2026 - der
    // Hilfsbaustein `berlinSommer` setzt einen festen Sommerzeit-Versatz voraus.
    const regeln: RuhezeitRegeln = { wochenende: 'ganz' };
    const samstag = berlinSommer(10, 17, 10, 0);
    const endeSamstag = ruhezeitEndeFallsAktiv(regeln, BERLIN, samstag);
    expect(endeSamstag?.getTime()).toBe(berlinSommer(10, 19, 0, 0).getTime());
    // Sonntag, 23 Uhr - dasselbe Fenster.
    const sonntag = berlinSommer(10, 18, 23, 0);
    const endeSonntag = ruhezeitEndeFallsAktiv(regeln, BERLIN, sonntag);
    expect(endeSonntag?.getTime()).toBe(berlinSommer(10, 19, 0, 0).getTime());
  });

  it('ohne Wochenende-Angabe ist Samstag ruhig (kein Fenster)', () => {
    const samstagMittag = berlinSommer(10, 17, 14, 0);
    expect(ruhezeitEndeFallsAktiv(nachtfenster, BERLIN, samstagMittag)).toBeNull();
  });

  it('leere Regeln sind nie aktiv', () => {
    expect(ruhezeitEndeFallsAktiv({}, BERLIN, new Date())).toBeNull();
  });

  it('ein Fenster ohne Überspannung gilt an einem Werktag', () => {
    const regeln: RuhezeitRegeln = { werktags: { von: '06:00', bis: '18:00' } };
    const vormittag = berlinSommer(10, 21, 10, 0); // Mittwoch
    const ende = ruhezeitEndeFallsAktiv(regeln, BERLIN, vormittag);
    expect(ende?.getTime()).toBe(berlinSommer(10, 21, 18, 0).getTime());
    const abend = berlinSommer(10, 21, 19, 0);
    expect(ruhezeitEndeFallsAktiv(regeln, BERLIN, abend)).toBeNull();
  });

  it('die Grenze ist einschließlich Start und ausschließlich Ende', () => {
    const regeln: RuhezeitRegeln = { werktags: { von: '22:00', bis: '23:00' } };
    const start = berlinSommer(10, 19, 22, 0);
    const ende = berlinSommer(10, 19, 23, 0);
    expect(ruhezeitEndeFallsAktiv(regeln, BERLIN, start)).not.toBeNull();
    expect(ruhezeitEndeFallsAktiv(regeln, BERLIN, ende)).toBeNull();
  });
});
