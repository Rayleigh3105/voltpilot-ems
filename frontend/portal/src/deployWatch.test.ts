import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEPLOY_CHECK_MIN_INTERVAL_MS,
  entryBundleFrom,
  fetchNewBundle,
  runningEntryBundle,
  useDeployWatch,
} from './deployWatch';

/** Ausschnitt einer echten gebauten index.html (Vite-Entry + Skelett drumherum). */
const BUILT_HTML = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-Cs5wLOiD.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-RVrZc52y.css">
</head><body><div id="root"></div></body></html>`;

function mountEntryScript(src: string): HTMLScriptElement {
  const el = document.createElement('script');
  el.setAttribute('type', 'module');
  el.setAttribute('src', src);
  document.head.appendChild(el);
  return el;
}

/** Simuliert den Tab-Wechsel, den Browser beim Ein-/Ausblenden feuern. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  sessionStorage.clear();
});

describe('entryBundleFrom', () => {
  it('findet das Entry-Bundle in einer gebauten index.html', () => {
    expect(entryBundleFrom(BUILT_HTML)).toBe('/assets/index-Cs5wLOiD.js');
  });

  it('liefert null, wenn kein Bundle referenziert ist (z. B. eine Fehlerseite)', () => {
    expect(entryBundleFrom('<html><body>502 Bad Gateway</body></html>')).toBeNull();
  });
});

describe('runningEntryBundle', () => {
  it('liest das laufende Entry-Bundle aus dem Dokument', () => {
    mountEntryScript('/assets/index-Abc123XY.js');
    expect(runningEntryBundle()).toBe('/assets/index-Abc123XY.js');
  });

  it('kommt auch mit einer absoluten src-URL zurecht', () => {
    mountEntryScript('https://portal.voltpilot.de/assets/index-Abs01234.js');
    expect(runningEntryBundle()).toBe('/assets/index-Abs01234.js');
  });

  it('liefert null im Dev-Server-Dokument (kein /assets/index-*.js)', () => {
    mountEntryScript('/src/main.tsx');
    expect(runningEntryBundle()).toBeNull();
  });
});

describe('fetchNewBundle', () => {
  it('ohne laufendes Bundle wird GAR NICHT geprüft (kein Netz-Abruf)', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchNewBundle(fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gleicher Stand -> null', async () => {
    mountEntryScript('/assets/index-Cs5wLOiD.js');
    const fetchImpl = vi.fn(async () => new Response(BUILT_HTML, { status: 200 }));
    expect(await fetchNewBundle(fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith('/', { cache: 'no-store' });
  });

  it('anderer Stand -> der neue Bundle-Pfad', async () => {
    mountEntryScript('/assets/index-OldOld01.js');
    const fetchImpl = vi.fn(async () => new Response(BUILT_HTML, { status: 200 }));
    expect(await fetchNewBundle(fetchImpl as unknown as typeof fetch)).toBe(
      '/assets/index-Cs5wLOiD.js',
    );
  });

  it('Fehlschläge sind stumm: non-2xx, Netzfehler, HTML ohne Bundle', async () => {
    mountEntryScript('/assets/index-OldOld01.js');
    const notOk = vi.fn(async () => new Response('x', { status: 502 }));
    expect(await fetchNewBundle(notOk as unknown as typeof fetch)).toBeNull();
    const throws = vi.fn(async () => {
      throw new TypeError('network down');
    });
    expect(await fetchNewBundle(throws as unknown as typeof fetch)).toBeNull();
    const noBundle = vi.fn(async () => new Response('<html>proxy error</html>', { status: 200 }));
    expect(await fetchNewBundle(noBundle as unknown as typeof fetch)).toBeNull();
  });
});

describe('useDeployWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  const tick = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('prüft frühestens nach der Mindestfrist - der Boot zählt als Prüfung', async () => {
    const check = vi.fn(async () => null);
    renderHook(() => useDeployWatch({ check, minIntervalMs: 1_000, pollMs: 200 }));
    await tick(800);
    expect(check).not.toHaveBeenCalled();
    await tick(400);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('sichtbarer Tab: meldet die neue Version, statt unter dem Kunden neu zu laden', async () => {
    const check = vi.fn(async () => '/assets/index-NeuNeu01.js');
    const reload = vi.fn();
    const { result } = renderHook(() =>
      useDeployWatch({ check, reload, minIntervalMs: 1_000, pollMs: 200 }),
    );
    expect(result.current).toBe(false);
    await tick(1_200);
    expect(result.current).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('unveränderter Stand bleibt still', async () => {
    const check = vi.fn(async () => null);
    const { result } = renderHook(() =>
      useDeployWatch({ check, minIntervalMs: 1_000, pollMs: 200 }),
    );
    await tick(3_000);
    expect(check.mock.calls.length).toBeGreaterThan(0);
    expect(result.current).toBe(false);
  });

  it('verdeckter Tab lädt still neu - je Ziel-Bundle nur EINMAL (Schleifen-Schutz)', async () => {
    const check = vi.fn(async () => '/assets/index-NeuNeu01.js');
    const reload = vi.fn();
    const { result } = renderHook(() =>
      useDeployWatch({ check, reload, minIntervalMs: 1_000, pollMs: 200 }),
    );
    setVisibility('hidden');
    await tick(1_200);
    expect(reload).toHaveBeenCalledTimes(1);
    // Der Reload hat (z. B. wegen einer kaputten Zwischenschicht) nichts
    // geändert: derselbe Befund erneut -> KEIN zweiter stiller Reload, der
    // sichtbare Hinweis übernimmt.
    await tick(1_200);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  it('Rückkehr in den Tab prüft sofort, wenn die Frist abgelaufen ist', async () => {
    const check = vi.fn(async () => null);
    // pollMs riesig: nur der visibilitychange-Auslöser kann feuern.
    renderHook(() => useDeployWatch({ check, minIntervalMs: 1_000, pollMs: 10 * 60_000 }));
    setVisibility('hidden');
    await tick(2_000);
    expect(check).not.toHaveBeenCalled();
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('räumt Takt und Listener beim Abbau ab', async () => {
    const check = vi.fn(async () => null);
    const { unmount } = renderHook(() =>
      useDeployWatch({ check, minIntervalMs: 1_000, pollMs: 200 }),
    );
    unmount();
    await tick(5_000);
    setVisibility('visible');
    expect(check).not.toHaveBeenCalled();
  });

  it('die Standard-Mindestfrist ist eine halbe Stunde', () => {
    expect(DEPLOY_CHECK_MIN_INTERVAL_MS).toBe(30 * 60 * 1000);
  });
});
