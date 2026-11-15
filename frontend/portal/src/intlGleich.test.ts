import { describe, expect, it } from 'vitest';
import { eur, eurAmount, fmtNum, ortsUhrzeit, stellenFormat } from './format';
import { periodLabel } from './anlage';
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

  it('stellenFormat gleich toLocaleString - auch wie die alten Schreibweisen von ct, kWh, Prozent und Leitungsplan', () => {
    for (const v of ZAHLEN) {
      for (const stellen of [0, 1, 2, 3]) {
        expect(stellenFormat(stellen).format(v), `${v}/${stellen}`)
          .toBe(v.toLocaleString('de-DE', { minimumFractionDigits: stellen, maximumFractionDigits: stellen }));
      }
      // `pctFmt` (fahrplanWhy) nannte nur die Obergrenze; Untergrenze 0 ist dieselbe Vorgabe.
      expect(stellenFormat(0).format(v)).toBe(v.toLocaleString('de-DE', { maximumFractionDigits: 0 }));
      // `spurTitel` (Leitungsplan) baute je Aufruf einen `Intl.NumberFormat` mit beiden Grenzen.
      expect(stellenFormat(1).format(v))
        .toBe(new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(v));
    }
  });

  it('ortsUhrzeit gleich toLocaleTimeString in Ortszeit - in mehreren Zonen, nach Umstellen von TZ und an den Zeitumstellungen', () => {
    const vorher = process.env.TZ;
    const momente = ['2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
      '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T06:00:00Z',
      '2026-04-05T14:59:00Z', '2026-04-05T15:00:00Z', '2026-07-07T21:59:59.999Z', '2026-07-07T22:00:00Z',
      '2026-12-31T23:00:00Z', '2026-01-01T00:00:00Z', '2026-06-15T12:07:00Z'];
    try {
      // Halbe und Dreiviertelstunden (Indien, Nepal), halbstündige Sommerzeit (Lord Howe), Süd- und Nordhalbkugel.
      for (const tz of ['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Australia/Lord_Howe',
        'Pacific/Chatham', 'UTC', 'Europe/Berlin']) {
        process.env.TZ = tz;
        for (const iso of momente) {
          const d = new Date(iso);
          expect(ortsUhrzeit(d), `${tz} ${iso}`).toBe(d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
        }
      }
      // Die Umstellung greift wirklich (sonst prüfte die Schleife nur eine Zone): Nepal liegt 5:45 vor UTC.
      process.env.TZ = 'Asia/Kathmandu';
      expect(ortsUhrzeit(new Date('2026-06-15T12:07:00Z'))).toBe('17:52');
      const kaputt = new Date('kaputt');
      expect(ortsUhrzeit(kaputt)).toBe(kaputt.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }));
    } finally {
      process.env.TZ = vorher;
    }
  });

  it('periodLabel gleich der alten Schreibweise über toLocaleDateString', () => {
    const ZONE = 'Europe/Berlin';
    const tag = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: ZONE });
    const alt = (range: string, at: Date, now: Date) => {
      const thisYear = tag(now).slice(0, 4);
      const atYear = at.toLocaleDateString('en-CA', { timeZone: ZONE, year: 'numeric' });
      switch (range) {
        case 'day':
          return tag(at) === tag(now) ? 'Heute' : at.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', timeZone: ZONE });
        case 'month': {
          const name = at.toLocaleDateString('de-DE', { month: 'long', timeZone: ZONE });
          return atYear === thisYear ? name : `${name} ${atYear}`;
        }
        case 'year':
          return atYear;
        default:
          return 'Gesamt';
      }
    };
    const nows = ['2026-11-15T10:00:00Z', '2026-12-31T23:30:00Z', '2027-01-01T00:30:00Z'];
    const ats = ['2026-11-15T10:00:00Z', '2026-11-14T23:30:00Z', '2025-07-01T00:00:00Z', '2026-12-31T22:59:59Z',
      '2026-12-31T23:00:00Z', '2026-03-29T01:00:00Z', 'kaputt'];
    for (const n of nows) {
      for (const a of ats) {
        for (const range of ['day', 'month', 'year', 'all'] as const) {
          const now = new Date(n);
          const at = new Date(a);
          expect(periodLabel(range, at, now), `${range} ${a} / ${n}`).toBe(alt(range, at, now));
        }
      }
    }
  });
});
