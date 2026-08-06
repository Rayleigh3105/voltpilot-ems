import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWake } from './useWake';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function firePageShow(persisted: boolean) {
  const e = new Event('pageshow');
  Object.defineProperty(e, 'persisted', { get: () => persisted });
  act(() => {
    window.dispatchEvent(e);
  });
}

afterEach(() => setVisibility('visible'));

describe('useWake', () => {
  it('zählt beim Zurückkommen in den Tab hoch', () => {
    const { result } = renderHook(() => useWake());
    const start = result.current;
    setVisibility('hidden');
    expect(result.current).toBe(start);
    setVisibility('visible');
    expect(result.current).toBe(start + 1);
  });

  it('zählt bei der bfcache-Rückkehr hoch, bei einem normalen Boot nicht', () => {
    const { result } = renderHook(() => useWake());
    const start = result.current;
    firePageShow(false);
    expect(result.current).toBe(start);
    firePageShow(true);
    expect(result.current).toBe(start + 1);
  });

  it('räumt seine Listener beim Abbau ab', () => {
    const { result, unmount } = renderHook(() => useWake());
    const start = result.current;
    unmount();
    setVisibility('hidden');
    setVisibility('visible');
    firePageShow(true);
    expect(result.current).toBe(start);
  });
});
