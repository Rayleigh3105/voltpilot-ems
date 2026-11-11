import { describe, expect, it } from 'vitest';
import type { Device } from '../api';
import { DATENSPERRE_MS, UMSCHALT_LAENGER_MS, UMSCHALT_PRUEFEN_MS, UMSCHALT_SUPPORT_MS, wegLage } from './wegLage';

const T0 = new Date('2026-11-10T12:00:00Z');

function box(partial: Partial<Device> = {}): Device {
  return {
    id: 'd1',
    siteId: 's1',
    externalRef: 'edge-k7m2xq3',
    kind: 'inverter',
    name: null,
    status: 'claimed',
    lastSeenAt: null,
    createdAt: T0.toISOString(),
    anmeldung: null,
    ...partial,
  };
}

function nach(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe('wegLage · die Szenarien aus Bericht Abschnitt 4.3/5', () => {
  it('Normal: Box startet, Chip läuft, noch kein Signal', () => {
    const lage = wegLage(box(), nach(30_000));
    expect(lage.aktiv).toBe('startet');
    expect(lage.stationen.eingesteckt).toBe('dashed');
    expect(lage.stationen.startet).toBe('active');
    expect(lage.hinweis).toBe('keiner');
    expect(lage.chipText).toBe('Startet · 0:30');
  });

  it('Anmeldung da: "Eingesteckt" gilt rückwirkend als geschehen, Station Anmeldung ist done', () => {
    const lage = wegLage(box({ anmeldung: { zuletztAngefragtAm: nach(20_000).toISOString(), schluesselAbgeholtAm: null } }), nach(25_000));
    expect(lage.stationen.eingesteckt).toBe('done');
    expect(lage.stationen.startet).toBe('done');
    expect(lage.stationen.anmeldung).toBe('done');
    expect(lage.stationen.datenverbindung).toBe('active');
    expect(lage.aktiv).toBe('datenverbindung');
    expect(lage.titel).toBe('Ihre Box ist im Internet');
    expect(lage.liefSchon).toBe(false);
  });

  it('Box steckte schon (liefSchon): Anmeldung vor dem Claim', () => {
    const lage = wegLage(
      box({ createdAt: T0.toISOString(), anmeldung: { zuletztAngefragtAm: new Date(T0.getTime() - 60_000).toISOString(), schluesselAbgeholtAm: null } }),
      nach(5_000),
    );
    expect(lage.liefSchon).toBe(true);
    expect(lage.satz).toContain('1½ Minuten');
  });

  it('Langsam aber normal: ab 3:00 ohne Signal', () => {
    const lage = wegLage(box(), nach(UMSCHALT_LAENGER_MS + 1000));
    expect(lage.hinweis).toBe('laenger');
    expect(lage.stationen.startet).toBe('active');
  });

  it('Bitte prüfen: ab 5:00 ohne Signal, Station wird zum Problem', () => {
    const lage = wegLage(box(), nach(UMSCHALT_PRUEFEN_MS + 1000));
    expect(lage.hinweis).toBe('pruefen');
    expect(lage.stationen.startet).toBe('problem');
  });

  it('Support: ab 15:00 ohne Signal', () => {
    const lage = wegLage(box(), nach(UMSCHALT_SUPPORT_MS + 1000));
    expect(lage.hinweis).toBe('support');
  });

  it('Datenverbindung gesperrt: Anmeldung da, 75s später noch kein Herzschlag', () => {
    const lage = wegLage(
      box({ anmeldung: { zuletztAngefragtAm: nach(10_000).toISOString(), schluesselAbgeholtAm: nach(10_050).toISOString() } }),
      nach(10_000 + DATENSPERRE_MS + 1000),
    );
    expect(lage.hinweis).toBe('datensperre');
    expect(lage.stationen.datenverbindung).toBe('problem');
    expect(lage.titel).toBe('Die Datenverbindung kommt nicht durch');
  });

  it('Online: erster Herzschlag da, egal wie lange es dauerte', () => {
    const lage = wegLage(
      box({ anmeldung: { zuletztAngefragtAm: nach(5_000).toISOString(), schluesselAbgeholtAm: nach(5_000).toISOString() }, lastSeenAt: nach(20_000).toISOString() }),
      nach(21_000),
    );
    expect(lage.online).toBe(true);
    expect(lage.aktiv).toBe('anlage');
    expect(Object.values(lage.stationen).every((s) => s === 'done' || s === 'active')).toBe(true);
    expect(lage.titel).toBe('Ihre Box ist online');
  });

  it('Box war online und schweigt: kein neuer Herzschlag seit über 5 Minuten', () => {
    const lage = wegLage(box({ lastSeenAt: new Date(T0.getTime() + 60_000).toISOString() }), nach(60_000 + 6 * 60_000));
    expect(lage.online).toBe(false);
    expect(lage.stale).toBe(true);
    expect(lage.titel).toContain('meldet sich gerade nicht');
  });

  it('ohne createdAt bricht die Lage nicht (Chip bei 0:00)', () => {
    const lage = wegLage(box({ createdAt: null }), nach(5000));
    expect(lage.chipText).toBe('Startet · 0:00');
  });
});
