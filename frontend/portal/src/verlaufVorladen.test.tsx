import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * Das Leerlauf-Vorladen (Performance-Runde vp-perf2-portal, Idee 4): Verlauf und echarts (≈ 250 kB gz) kamen auf
 * jeder Anlagenseite spätestens nach 4 s - am Telefon mitten im ersten Bild und im Live-Takt, auch bei Kunden, die
 * den Verlauf nie öffnen. Jetzt: Leerlauf ohne Frist, am Telefon erst nach der ersten Bedienung.
 */
const { stuecke } = vi.hoisted(() => ({ stuecke: [] as string[] }));
vi.mock('./pageChunks', () => {
  const holen = (n: string) => () => {
    stuecke.push(n);
    return Promise.resolve({});
  };
  return {
    SUB_CHUNK: { messwerte: holen('messwerte'), erloese: holen('erloese') },
    CHART_CHUNK: { energie: holen('chart-energie'), erloese: holen('chart-erloese') },
  };
});

import { useImLeerlaufLaden, useVerlaufVorladen } from './verlaufVorladen';

type Leerlauf = { cb: () => void; opts: unknown };
let leerlauf: Leerlauf[] = [];
let telefon = false;
let aktiviert = false;

beforeEach(() => {
  stuecke.length = 0;
  leerlauf = [];
  telefon = false;
  aktiviert = false;
  vi.stubGlobal('requestIdleCallback', (cb: () => void, opts?: unknown) => leerlauf.push({ cb, opts }));
  vi.stubGlobal('cancelIdleCallback', (id: number) => {
    leerlauf[id - 1] = { cb: () => undefined, opts: null };
  });
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: telefon && q.includes('max-width'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ hasBeenActive: aktiviert }) });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { userActivation?: unknown }).userActivation;
});

const leerlaufAusloesen = () => act(() => { for (const l of leerlauf.splice(0)) l.cb(); });

describe('useVerlaufVorladen', () => {
  it('am Desktop: im Leerlauf, ohne Frist', () => {
    renderHook(() => useVerlaufVorladen(true));
    expect(leerlauf).toHaveLength(1);
    expect(leerlauf[0].opts).toBeUndefined();
    expect(stuecke).toEqual([]);
    leerlaufAusloesen();
    expect(stuecke).toEqual(['messwerte', 'erloese', 'chart-energie', 'chart-erloese']);
  });

  it('am Telefon: nichts vor der ersten Bedienung, danach im Leerlauf', () => {
    telefon = true;
    renderHook(() => useVerlaufVorladen(true));
    expect(leerlauf).toHaveLength(0);
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(leerlauf).toHaveLength(1);
    leerlaufAusloesen();
    expect(stuecke).toHaveLength(4);
    // Die Horcher sind weg: eine zweite Bedienung stößt nichts mehr an.
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    expect(leerlauf).toHaveLength(0);
  });

  it('am Telefon nach einem Tippen in diesem Tab (etwa um hierher zu kommen): gleich im Leerlauf', () => {
    telefon = true;
    aktiviert = true;
    renderHook(() => useVerlaufVorladen(true));
    expect(leerlauf).toHaveLength(1);
  });

  it('am Telefon verlassen vor der ersten Bedienung: lädt nie', () => {
    telefon = true;
    const { unmount } = renderHook(() => useVerlaufVorladen(true));
    unmount();
    act(() => { window.dispatchEvent(new Event('keydown')); });
    expect(leerlauf).toHaveLength(0);
    expect(stuecke).toEqual([]);
  });

  it('nie bei Datensparsamkeit', () => {
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
    try {
      renderHook(() => useVerlaufVorladen(true));
      expect(leerlauf).toHaveLength(0);
    } finally {
      delete (navigator as { connection?: unknown }).connection;
    }
  });
});

describe('useImLeerlaufLaden (Geräte-Assistent im Aufbau)', () => {
  it('wartet auch am Telefon nicht auf eine Bedienung - nur auf den Leerlauf', () => {
    telefon = true;
    const laden = vi.fn();
    renderHook(() => useImLeerlaufLaden(laden, true));
    expect(leerlauf).toHaveLength(1);
    leerlaufAusloesen();
    expect(laden).toHaveBeenCalledTimes(1);
  });

  it('ohne requestIdleCallback (Safari): nach 2 s', () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('requestIdleCallback', undefined);
      const laden = vi.fn();
      renderHook(() => useImLeerlaufLaden(laden, true));
      vi.advanceTimersByTime(1999);
      expect(laden).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(laden).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
