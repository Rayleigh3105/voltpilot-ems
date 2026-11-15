import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTaktUhr } from './useTaktUhr';

/** Wie oft rendert die Uhr, und was zeigt sie? (Performance-Runde vp-perf3-portal-takt) */
function uhr() {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useTaktUhr(5_000);
  });
  return { hook, renders: () => renders, now: () => hook.result.current.now.getTime() };
}

describe('useTaktUhr', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.parse('2026-11-15T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('tickt ohne Takt alle tickMs', () => {
    const u = uhr();
    const start = u.now();
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(u.now() - start).toBe(5_000);
    act(() => { vi.advanceTimersByTime(5_000); });
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(u.now() - start).toBe(15_000);
    expect(u.renders()).toBe(1 + 3);
  });

  it('setzt aus, solange ein Takt unterwegs ist, und geht MIT seiner Antwort weiter', () => {
    const u = uhr();
    act(() => { vi.advanceTimersByTime(4_990); });
    const vorher = u.renders();
    // Der Takt beginnt 10 ms vor dem Tick: der Tick zeichnete sonst die alten Daten neu.
    act(() => { u.hook.result.current.taktBeginn(); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(u.renders()).toBe(vorher);
    // Die Antwort: eine Übergabe, die Uhr steht auf der Antwortzeit.
    act(() => { u.hook.result.current.taktEnde(); });
    expect(u.renders()).toBe(vorher + 1);
    expect(u.now()).toBe(Date.now());
    // Der nächste Tick kommt tickMs nach der Antwort, nicht nach dem alten Raster.
    act(() => { vi.advanceTimersByTime(4_999); });
    expect(u.renders()).toBe(vorher + 1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(u.renders()).toBe(vorher + 2);
  });

  it('bleibt die Antwort aus, tickt die Uhr nach höchstens einem ausgesetzten Tick weiter', () => {
    const u = uhr();
    act(() => { vi.advanceTimersByTime(4_990); });
    act(() => { u.hook.result.current.taktBeginn(); });
    const start = u.now();
    act(() => { vi.advanceTimersByTime(10_000); });
    // Tick bei 5 s ausgesetzt (Takt erst 10 ms alt), Tick bei 10 s wieder da.
    expect(u.now() - start).toBe(10_000);
  });

  it('stand die Uhr still (verdeckter Tab), stellt der Taktbeginn sie sofort', () => {
    const u = uhr();
    vi.setSystemTime(Date.now() + 120_000);
    const vorher = u.renders();
    act(() => { u.hook.result.current.taktBeginn(); });
    expect(u.renders()).toBe(vorher + 1);
    expect(u.now()).toBe(Date.now());
  });

  it('eine eben getickte Uhr stellt der Taktbeginn nicht', () => {
    const u = uhr();
    act(() => { vi.advanceTimersByTime(5_000); });
    const vorher = u.renders();
    act(() => { u.hook.result.current.taktBeginn(); });
    expect(u.renders()).toBe(vorher);
  });
});
