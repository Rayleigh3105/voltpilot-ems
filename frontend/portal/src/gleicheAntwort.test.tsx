import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { gleichOderNeu, useTaktZustand } from './gleicheAntwort';

/** Unveränderte Takt-Antworten behalten (Performance-Runde vp-perf2-portal, Idee 3). */
describe('gleichOderNeu', () => {
  it('behält bei gleichem Inhalt das alte Objekt', () => {
    const alt = { budget: null, chargers: [] as unknown[] };
    expect(gleichOderNeu(alt, { budget: null, chargers: [] })).toBe(alt);
  });

  it('nimmt das neue, sobald sich eine Zahl, ein Zeitstempel oder ein Text unterscheidet', () => {
    const alt = { live: { ts: '2026-11-14T08:00:00Z', pvKw: 3.4 } };
    const neueZeit = { live: { ts: '2026-11-14T08:00:10Z', pvKw: 3.4 } };
    const neuerWert = { live: { ts: '2026-11-14T08:00:00Z', pvKw: 3.5 } };
    expect(gleichOderNeu(alt, neueZeit)).toBe(neueZeit);
    expect(gleichOderNeu(alt, neuerWert)).toBe(neuerWert);
  });

  it('Lücke und Wert: null ersetzt einen Wert, ein Wert ersetzt null - unbekannt ist keine Null', () => {
    const wert = { checkedAt: 'x' };
    expect(gleichOderNeu<typeof wert | null>(wert, null)).toBeNull();
    expect(gleichOderNeu<typeof wert | null>(null, wert)).toBe(wert);
    expect(gleichOderNeu<{ wert: number | null }>({ wert: 0 }, { wert: null })).toEqual({ wert: null });
  });
});

describe('useTaktZustand', () => {
  it('rendert bei einer inhaltlich gleichen Antwort nicht neu, bei einer neuen schon', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useTaktZustand<{ ts: string } | null>(null);
    });
    act(() => result.current[1]({ ts: 'a' }));
    const erste = result.current[0];
    const nachErster = renders;
    act(() => result.current[1]({ ts: 'a' }));
    expect(renders).toBe(nachErster);
    expect(result.current[0]).toBe(erste);
    act(() => result.current[1]({ ts: 'b' }));
    expect(renders).toBe(nachErster + 1);
    expect(result.current[0]).toEqual({ ts: 'b' });
  });
});
