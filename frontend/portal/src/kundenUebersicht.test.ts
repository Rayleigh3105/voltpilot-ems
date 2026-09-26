import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket, OverviewSite } from './api';
import { standText, statusZeile, tagesKurve, ueberAnlagen, uebersichtBloecke } from './kundenUebersicht';

function eimer(start: Date, pv: number, load: number): HistoryBucket {
  return {
    start: start.toISOString(),
    pvKwh: pv,
    loadKwh: load,
    gridImportKwh: 0,
    gridExportKwh: 0,
    batteryChargeKwh: 0,
    batteryDischargeKwh: 0,
    socMinPct: null,
    socMaxPct: null,
    socLastPct: null,
    priceEurMwh: null,
    costEur: null,
  };
}

function hist(buckets: HistoryBucket[]): History {
  return {
    range: 'day',
    from: '',
    to: '',
    bucketMinutes: 15,
    buckets,
    totals: {} as History['totals'],
    protocol: [],
    plan: [],
  };
}

describe('tagesKurve', () => {
  const t = (h: number, m = 0) => new Date(2026, 8, 10, h, m);

  it('summiert je Viertelstunde in kW — und lässt eine Lücke, wo eine Anlage fehlt', () => {
    const k = tagesKurve(
      [
        { siteId: 'a', name: 'A', history: hist([eimer(t(10), 1, 0.5), eimer(t(10, 15), 1, 0.5)]) },
        { siteId: 'b', name: 'B', history: hist([eimer(t(10), 0.5, 0.25)]) },
        { siteId: 'c', name: 'C', history: hist([]) },
      ],
      t(10, 20),
    )!;
    expect(k.pv[40]).toBe(6);
    expect(k.load[40]).toBe(3);
    // 10:15 fehlt bei B → keine Teilsumme, eine Lücke.
    expect(k.pv[41]).toBeNull();
    expect(k.jetzt).toBe(41);
    expect(k.max).toBe(6);
  });

  it('ohne Werte gibt es keine Kurve', () => {
    expect(tagesKurve([{ siteId: 'a', name: 'A', history: hist([]) }], t(12))).toBeNull();
  });
});

describe('uebersichtBloecke', () => {
  const canonical = ['flotten-status', 'erloese', 'speicher', 'pv-jetzt', 'anlagen'];
  it('folgt der Standard-Reihenfolge, auch wenn ein Baustein des Blocks nicht verfügbar ist', () => {
    expect(uebersichtBloecke(['flotten-status', 'speicher', 'pv-jetzt', 'anlagen'], ['flotten-status', 'speicher', 'pv-jetzt', 'anlagen'], canonical)).toEqual(['heute', 'jetzt', 'anlagen']);
  });
  it('blendet einen Block aus, dessen verfügbare Bausteine alle ausgeblendet sind', () => {
    expect(uebersichtBloecke(['erloese', 'anlagen'], ['erloese', 'pv-jetzt', 'anlagen'], canonical)).toEqual(['heute', 'anlagen']);
  });
  it('übernimmt eine umgestellte Reihenfolge', () => {
    expect(uebersichtBloecke(['anlagen', 'pv-jetzt', 'erloese'], ['erloese', 'pv-jetzt', 'anlagen'], canonical)).toEqual(['anlagen', 'jetzt', 'heute']);
  });
});

describe('Statuszeile und Wörter', () => {
  const site = (over: Partial<OverviewSite>): OverviewSite =>
    ({ id: 'x', name: 'X', deviceCount: 1, onlineCount: 1, waitingCount: 0, lastSeenAt: null, live: null, ...over }) as OverviewSite;
  const now = new Date('2026-09-10T10:00:00Z');

  it('grün mit der Zahl der Anlagen', () => {
    expect(statusZeile([site({}), site({ id: 'y' })], now)).toEqual({ ton: 'ok', text: 'Alles in Ordnung · 2 Anlagen', zielId: null });
  });

  it('nennt die Anlage, die Aufmerksamkeit braucht, und verlinkt sie', () => {
    const z = statusZeile(
      [site({}), site({ id: 'w', name: 'Werkstatt', onlineCount: 0, lastSeenAt: '2026-09-10T09:15:00Z' })],
      now,
    );
    expect(z.ton).toBe('warn');
    expect(z.text).toMatch(/^Werkstatt meldet sich .*nicht$/);
    expect(z.zielId).toBe('w');
  });

  it('spricht über „beide", „alle" oder „x von y" Anlagen', () => {
    expect(ueberAnlagen(2, 2)).toBe('beide Anlagen');
    expect(ueberAnlagen(3, 3)).toBe('alle 3 Anlagen');
    expect(ueberAnlagen(2, 3)).toBe('2 von 3 Anlagen');
    expect(standText('2026-09-10T09:59:40Z', now)).toBe('Stand: gerade eben');
    expect(standText('2026-09-10T09:55:00Z', now)).toBe('Stand: vor 5 Min.');
  });
});
