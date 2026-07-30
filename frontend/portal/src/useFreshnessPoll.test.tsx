import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFreshnessPoll } from './useFreshnessPoll';

/** Simuliert den Tab-Wechsel, den Browser beim Ein-/Ausblenden feuern. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useFreshnessPoll', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('frischt im Takt auf', () => {
    const poll = vi.fn();
    renderHook(() => useFreshnessPoll(poll, 30_000));
    expect(poll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(poll).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });

  it('holt bei der Rückkehr in den Tab SOFORT nach, statt aufs Intervall zu warten', () => {
    const poll = vi.fn();
    renderHook(() => useFreshnessPoll(poll, 30_000));
    // Der Tab war weg (Browser drosseln den Takt dort massiv) ...
    setVisibility('hidden');
    vi.advanceTimersByTime(5_000);
    expect(poll).not.toHaveBeenCalled();
    // ... und ist wieder da: kein Warten auf die restlichen 25 Sekunden.
    setVisibility('visible');
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('feuert beim Wegschalten NICHT', () => {
    const poll = vi.fn();
    renderHook(() => useFreshnessPoll(poll, 30_000));
    setVisibility('hidden');
    expect(poll).not.toHaveBeenCalled();
  });

  it('läuft nicht, solange sie abgeschaltet ist (z. B. Admin ohne Mandant)', () => {
    const poll = vi.fn();
    renderHook(() => useFreshnessPoll(poll, 30_000, false));
    vi.advanceTimersByTime(120_000);
    setVisibility('visible');
    expect(poll).not.toHaveBeenCalled();
  });

  it('ein neuer Callback setzt den Takt NICHT zurück', () => {
    // Sonst könnte ein häufig re-renderndes Portal das Intervall dauerhaft neu
    // starten und nie feuern - die Auffrischung wäre still tot.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useFreshnessPoll(fn, 30_000), {
      initialProps: { fn: first },
    });
    vi.advanceTimersByTime(20_000);
    rerender({ fn: second });
    vi.advanceTimersByTime(10_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('räumt Intervall und Listener beim Abbau ab', () => {
    const poll = vi.fn();
    const { unmount } = renderHook(() => useFreshnessPoll(poll, 30_000));
    unmount();
    vi.advanceTimersByTime(120_000);
    setVisibility('visible');
    expect(poll).not.toHaveBeenCalled();
  });
});
