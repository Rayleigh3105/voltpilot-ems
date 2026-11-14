import { describe, expect, it } from 'vitest';
import type { Device } from './api';
import { SIGNAL_SCHWACH_WARNUNG_MS, verbindungsStand, warZuletztWlan } from './boxVerbindung';

const T0 = new Date('2026-11-14T12:00:00Z');

describe('boxVerbindung · verbindungsStand (Konzept vp-edge-light-wlan-s5, E1=B)', () => {
  it('Kabel: nie schwach, egal was signalDbm sagt', () => {
    expect(verbindungsStand({ linkKind: 'kabel', signalDbm: -90, linkWeakSince: T0.toISOString() }, T0))
      .toEqual({ art: 'kabel', schwach: false });
  });

  it('unbekannt (fehlend oder null): weder Kabel noch WLAN', () => {
    expect(verbindungsStand({ linkKind: undefined, signalDbm: null, linkWeakSince: null }, T0).art).toBeNull();
    expect(verbindungsStand({ linkKind: null, signalDbm: null, linkWeakSince: null }, T0).art).toBeNull();
  });

  it('WLAN ohne linkWeakSince: gut, kein einzelner Ausreißer behauptet', () => {
    expect(verbindungsStand({ linkKind: 'wlan', signalDbm: -80, linkWeakSince: null }, T0))
      .toEqual({ art: 'wlan', schwach: false });
  });

  it('WLAN, schwach seit WENIGER als der Warnschwelle: noch kein einzelner Ausreißer wird zur Warnung', () => {
    const seit = new Date(T0.getTime() - (SIGNAL_SCHWACH_WARNUNG_MS - 1000)).toISOString();
    expect(verbindungsStand({ linkKind: 'wlan', signalDbm: -75, linkWeakSince: seit }, T0).schwach).toBe(false);
  });

  it('WLAN, schwach seit MEHR als der Warnschwelle: jetzt eine Warnung', () => {
    const seit = new Date(T0.getTime() - (SIGNAL_SCHWACH_WARNUNG_MS + 1000)).toISOString();
    expect(verbindungsStand({ linkKind: 'wlan', signalDbm: -75, linkWeakSince: seit }, T0).schwach).toBe(true);
  });

  it('genau an der Schwelle zählt schon als schwach (>=)', () => {
    const seit = new Date(T0.getTime() - SIGNAL_SCHWACH_WARNUNG_MS).toISOString();
    expect(verbindungsStand({ linkKind: 'wlan', signalDbm: -75, linkWeakSince: seit }, T0).schwach).toBe(true);
  });
});

describe('boxVerbindung · warZuletztWlan', () => {
  const box = (over: Partial<Device> = {}): Device => ({
    id: 'd1', siteId: 's1', externalRef: 'edge-k7m2xq3', kind: 'edge', name: null,
    status: 'claimed', lastSeenAt: null, createdAt: null, ...over,
  });

  it('wahr nur bei linkKind "wlan"', () => {
    expect(warZuletztWlan(box({ linkKind: 'wlan' }))).toBe(true);
    expect(warZuletztWlan(box({ linkKind: 'kabel' }))).toBe(false);
    expect(warZuletztWlan(box({ linkKind: null }))).toBe(false);
    expect(warZuletztWlan(box())).toBe(false);
  });
});
