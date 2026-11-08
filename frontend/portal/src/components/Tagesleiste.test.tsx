import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { History, HistoryBucket } from '../api';
import { tagAus } from '../tagesleiste';
import { Tagesleiste } from './Tagesleiste';

const now = new Date(2026, 8, 10, 12, 0);
const mitternacht = new Date(2026, 8, 10, 0, 0).getTime();
const iso = (i: number) => new Date(mitternacht + i * 15 * 60000).toISOString();

/** Ein Betrieb, der das Ziel (8 kW) gut hält: Netzbezug 2 kW, Sonne 4 kW, Verbrauch 6 kW - alles unter dem Ziel. */
function tag() {
  const buckets: HistoryBucket[] = Array.from({ length: 48 }, (_, i) => ({
    start: iso(i), pvKwh: 1, loadKwh: 1.5, gridImportKwh: 0.5, gridExportKwh: 0, batteryChargeKwh: 0, batteryDischargeKwh: 0,
    socMinPct: null, socMaxPct: null, socLastPct: null, priceEurMwh: null, costEur: null,
  }));
  const history = { range: 'day', from: iso(0), to: iso(96), bucketMinutes: 15, buckets, totals: {} as History['totals'], protocol: [], plan: [] } as History;
  return tagAus(history, null, now);
}

describe('Tagesleiste, Lastspitze', () => {
  it('das Ziel steht mit Luft unter dem oberen Rand: „Ziel“ ganz lesbar, die Linie unter „Netzbezug“', () => {
    const t = tag();
    const { container } = render(<Tagesleiste tag={t} betrieb="spitze" q={t.jetzt} heute={false} zielKw={8} onQ={() => {}} />);
    const text = (wort: string) => [...container.querySelectorAll('text.vp-tl-lbl')].find((e) => e.textContent === wort)!;
    const linie = container.querySelector('line[stroke-dasharray="5 3"]')!;
    const zielY = Number(text('Ziel').getAttribute('y'));
    const titelY = Number(text('Netzbezug').getAttribute('y'));
    const linieY = Number(linie.getAttribute('y1'));
    // Schrift 10 px: rund 8 px über der Grundlinie, 3 px darunter (das „g“).
    expect(zielY - 8).toBeGreaterThanOrEqual(0);
    expect(linieY).toBeGreaterThanOrEqual(titelY + 3);
    // Der Netzbezug bleibt unter der Linie (größeres y), wie gemessen.
    const kurve = container.querySelector('path[fill="none"]')!.getAttribute('d')!;
    const ys = [...kurve.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThan(linieY);
  });
});
