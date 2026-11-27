import { describe, expect, it } from 'vitest';
import type { SchaltSpur } from './consumersApi';
import { dauer, spurAnsicht } from './schaltspurAnsicht';

const basis: SchaltSpur = {
  id: 's1', deviceId: 'box', requestId: 'override:stab:s1', art: 'stop', kommando: 'setpoint_kw', wert: 0,
  ausgaenge: null, apiEingang: '2026-11-27T13:00:00.000Z', gesendet: '2026-11-27T13:00:00.040Z', zustellung: null,
  ersteMeldung: null, boxEmpfangen: null, boxEntschieden: null, boxGeschrieben: null, boxZurueckgelesen: null,
  boxGemeldet: null, boxUrteil: null, gehalten: null, grund: null, bestaetigt: null, ergebnis: 'offen',
  portalAntwortMs: null, portalSichtbarMs: null,
};

const wert = (s: SchaltSpur, label: string) => spurAnsicht(s).zeilen.find((z) => z.label === label)?.wert;

describe('dauer', () => {
  it('Millisekunden, Sekunden mit einer Stelle, Minuten', () => {
    expect(dauer(180)).toBe('180 ms');
    expect(dauer(2400)).toBe('2,4 s');
    expect(dauer(65_000)).toBe('1 min 05 s');
  });
});

describe('spurAnsicht', () => {
  it('eine Box vor der Schaltspur: API-Abschnitte und der ehrliche Hinweis', () => {
    const a = spurAnsicht({ ...basis, ersteMeldung: '2026-11-27T13:00:14.040Z', bestaetigt: '2026-11-27T13:00:14.040Z',
      ergebnis: 'bestaetigt', portalAntwortMs: 120, portalSichtbarMs: 19_800 });
    expect(a.ergebnis).toBe('bestätigt nach 19,8 s');
    expect(wert({ ...basis, ersteMeldung: '2026-11-27T13:00:14.040Z' }, 'Gesendet bis erster Herzschlag'))
      .toBe('14,0 s');
    expect(a.zeilen.find((z) => z.label === 'Box')?.wert).toContain('Software vor der Schaltspur');
    expect(wert({ ...basis }, 'API: Anfrage bis gesendet')).toBe('40 ms');
  });

  it('eine Box mit Schaltspur: ihre Schritte ab dem eigenen Empfang', () => {
    const a = spurAnsicht({ ...basis, ersteMeldung: '2026-11-27T13:00:00.400Z', boxEmpfangen: '2026-11-27T12:59:59.000Z',
      boxEntschieden: '2026-11-27T12:59:59.002Z', boxGeschrieben: '2026-11-27T12:59:59.150Z',
      boxZurueckgelesen: '2026-11-27T12:59:59.210Z', boxGemeldet: '2026-11-27T12:59:59.230Z', boxUrteil: 'written' });
    expect(a.zeilen.find((z) => z.label === 'Box (eigene Uhr, ab Empfang)')?.wert)
      .toBe('entschieden +2 ms · geschrieben +150 ms · zurückgelesen +210 ms · Herzschlag +230 ms');
  });

  it('gehalten nennt den Grund und dass nichts geschrieben wurde', () => {
    const a = spurAnsicht({ ...basis, ergebnis: 'gehalten', grund: 'guard_min_on', gehalten: '2026-11-27T13:00:01.040Z',
      boxEmpfangen: '2026-11-27T13:00:00.050Z', boxEntschieden: '2026-11-27T13:00:00.051Z',
      boxUrteil: 'held:guard_min_on' });
    expect(a.ergebnis).toBe('gehalten: Mindestlaufzeit des Geräts hält');
    expect(wert({ ...basis, gehalten: '2026-11-27T13:00:01.040Z', grund: 'guard_min_on' }, 'Gesendet bis gehalten'))
      .toBe('1,0 s · Mindestlaufzeit des Geräts hält');
    expect(a.zeilen.find((z) => z.label.startsWith('Box'))?.wert).toContain('nichts geschrieben (gehalten)');
  });

  it('nicht gesendet sagt warum, und der Titel nennt den Wunsch', () => {
    const a = spurAnsicht({ ...basis, gesendet: null, zustellung: 'publish_failed', art: 'start', ausgaenge: [1] });
    expect(wert({ ...basis, gesendet: null, zustellung: 'publish_failed' }, 'API: Anfrage bis gesendet'))
      .toBe('nicht gesendet (Zustellung abgelehnt)');
    expect(a.titel).toContain('An (Ausgänge 1)');
    expect(a.ergebnis).toBe('noch nicht bestätigt');
  });
});
