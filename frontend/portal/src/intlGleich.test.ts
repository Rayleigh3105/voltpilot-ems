import { describe, expect, it } from 'vitest';
import { eur, eurAmount, fmtNum } from './format';
import { berlinDay } from './fleet';
import { todaySlots } from './schedule';
import { uhrzeit } from './steuerungZeitraum';

/**
 * Die Formatierer der heißen Pfade des Cockpits stehen seit der Performance-Runde vp-perf2-portal EINMAL bereit
 * (`Intl.NumberFormat`/`Intl.DateTimeFormat`) statt je Aufruf über `toLocaleString`. Die Ausgabe darf sich dabei um
 * kein Zeichen ändern - hier gegen die alte Schreibweise gehalten, mit Rundungs-, Vorzeichen- und Zeitumstellungsfällen.
 */
const ZAHLEN = [0, -0, 1.005, -1.585, 2.5, 0.1 + 0.2, 1234567.891, -98765.4321, 1e-9, -1e-9, 12.345, NaN, Infinity];

describe('gleiche Ausgabe wie toLocaleString', () => {
  it('eur und eurAmount', () => {
    for (const v of ZAHLEN) {
      expect(eur(v), String(v)).toBe(v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      expect(eurAmount(v)).toBe(`${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
    }
  });

  it('fmtNum mit 0 bis 4 Stellen, mit und ohne Einheit', () => {
    const alt = (v: number, unit: string, digits: number) => {
      const n = `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
      return unit ? `${n} ${unit}` : n;
    };
    for (const v of ZAHLEN) {
      for (const digits of [0, 1, 2, 3, 4]) {
        expect(fmtNum(v, 'kW', digits), `${v}/${digits}`).toBe(alt(v, 'kW', digits));
        expect(fmtNum(v, '', digits)).toBe(alt(v, '', digits));
      }
    }
    expect(fmtNum(3.45, 'kW')).toBe(alt(3.45, 'kW', 1));
    expect(fmtNum(null, 'kW')).toBe('-');
  });

  it('berlinDay und uhrzeit (Berliner Zeit), auch an den Zeitumstellungen und für ungültige Zeitpunkte', () => {
    const momente = ['2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-24T22:30:00Z', '2026-10-25T00:59:00Z',
      '2026-10-25T01:00:00Z', '2026-12-31T23:00:00Z', '2026-07-07T21:59:59.999Z', '2026-07-07T22:00:00Z'];
    for (const iso of momente) {
      const d = new Date(iso);
      expect(berlinDay(d), iso).toBe(d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }));
      expect(uhrzeit(iso), iso).toBe(d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }));
    }
    expect(berlinDay(new Date('kaputt'))).toBe(new Date('kaputt').toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }));
    expect(uhrzeit('kaputt')).toBeNull();
  });

  it('todaySlots wählt dieselben Slots wie der Vergleich über toDateString - auch am Tag der Zeitumstellung', () => {
    const alt = <T extends { start: string }>(slots: T[], now: Date) => slots.filter((s) => new Date(s.start).toDateString() === now.toDateString());
    for (const tag of ['2026-03-29', '2026-07-07', '2026-10-25']) {
      const beginn = Date.parse(`${tag}T00:00:00Z`) - 36 * 3_600_000;
      const slots = Array.from({ length: 4 * 24 * 3 }, (_, i) => ({ start: new Date(beginn + i * 900_000).toISOString() }));
      slots.push({ start: 'kaputt' });
      for (const stunde of [0, 1, 2, 3, 12, 23]) {
        const now = new Date(`${tag}T${String(stunde).padStart(2, '0')}:30:00`);
        expect(todaySlots(slots, now), `${tag} ${stunde}`).toEqual(alt(slots, now));
      }
    }
  });
});
