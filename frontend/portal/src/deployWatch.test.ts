import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  DEPLOY_CHECK_MIN_INTERVAL_MS,
  INPUT_GRACE_MS,
  RESUME_CHECK_AFTER_MS,
  entryBundleFrom,
  fetchNewBundle,
  hasUnsavedInput,
  noteUserInput,
  resetUserInput,
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

/** Die bfcache-Rückkehr: `pageshow` mit `persisted`. */
function firePageShow(persisted: boolean) {
  const e = new Event('pageshow');
  Object.defineProperty(e, 'persisted', { get: () => persisted });
  window.dispatchEvent(e);
}

afterEach(() => {
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  document.body.innerHTML = '';
  sessionStorage.clear();
  resetUserInput();
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

  it('gleicher Stand -> null, und gefragt wird am Browser-Cache VORBEI', async () => {
    mountEntryScript('/assets/index-Cs5wLOiD.js');
    const fetchImpl = vi.fn(async () => new Response(BUILT_HTML, { status: 200 }));
    expect(await fetchNewBundle(fetchImpl as unknown as typeof fetch)).toBeNull();
    // `no-store` ist tragend: die Frage lautet „was liefert der Server JETZT".
    // Ein Client mit heuristisch gecachter index.html bemerkt seinen Rückstand
    // ausschliesslich dadurch.
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

describe('hasUnsavedInput', () => {
  it('eine offene Aufgabenfläche (Modal/Dialog) blockiert den stillen Reload', () => {
    document.body.innerHTML = '<div class="vp-modal" role="dialog" aria-modal="true"></div>';
    expect(hasUnsavedInput()).toBe(true);
  });

  it('eine reine ERKLÄRfläche blockiert NICHT (role=dialog ohne aria-modal)', () => {
    // Das Mehr-Blatt, das Hilfe-Panel und die Fahrplan-Erklärung tragen
    // `role="dialog"` - dort geht nichts verloren.
    document.body.innerHTML = '<div class="vp-fw-panel" role="dialog"></div>';
    expect(hasUnsavedInput()).toBe(false);
  });

  it('der Fokus in einem Eingabefeld blockiert', () => {
    document.body.innerHTML = '<input id="f" />';
    (document.getElementById('f') as HTMLInputElement).focus();
    expect(hasUnsavedInput()).toBe(true);
  });

  it('eine frische Eingabe blockiert, eine alte nicht mehr', () => {
    const t0 = 1_000_000;
    noteUserInput(t0);
    expect(hasUnsavedInput(document, t0 + INPUT_GRACE_MS - 1)).toBe(true);
    expect(hasUnsavedInput(document, t0 + INPUT_GRACE_MS + 1)).toBe(false);
  });

  it('eine ruhige Seite blockiert nicht', () => {
    document.body.innerHTML = '<main><p>Nur Anzeige</p></main>';
    expect(hasUnsavedInput()).toBe(false);
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

  it('der BOOT prüft sofort - er zählt NICHT als Prüfung', async () => {
    // Das war das zweite Loch: ein Dokument aus einer alten Schicht
    // (heuristischer Cache, Zwischenschicht, wiederhergestellter Tab) galt eine
    // halbe Stunde lang als geprüft, und eine Portal-Sitzung ist kürzer.
    const check = vi.fn(async () => null);
    renderHook(() => useDeployWatch({ check, minIntervalMs: 30 * 60_000, pollMs: 10 * 60_000 }));
    await tick(0);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('ein Dokument aus einer alten Schicht lädt beim Boot AUTOMATISCH neu', async () => {
    const check = vi.fn(async () => '/assets/index-NeuNeu01.js');
    const reload = vi.fn();
    const { result } = renderHook(() =>
      useDeployWatch({ check, reload, minIntervalMs: 30 * 60_000, pollMs: 10 * 60_000 }),
    );
    await tick(0);
    expect(reload).toHaveBeenCalledTimes(1);
    // Kein Hinweis nötig - der Tab holt sich den richtigen Stand selbst.
    expect(result.current).toBe(false);
  });

  it('SICHTBARER Tab im laufenden Takt: Hinweis statt Reload unter dem Kunden', async () => {
    const check = vi.fn(async () => '/assets/index-NeuNeu01.js');
    const reload = vi.fn();
    const { result } = renderHook(() =>
      useDeployWatch({ check, reload, minIntervalMs: 1_000, pollMs: 200, busy: () => false }),
    );
    await tick(0);
    // Der Boot-Reload ist der einzige automatische; danach ist der Kunde da.
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockClear();
    await tick(2_000);
    expect(reload).not.toHaveBeenCalled();
    expect(result.current).toBe(true);
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
    await tick(0);
    expect(reload).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    // Der Reload hat (z. B. wegen einer kaputten Zwischenschicht) nichts
    // geändert: derselbe Befund erneut -> KEIN zweiter stiller Reload, der
    // sichtbare Hinweis übernimmt.
    await tick(1_200);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(true);
  });

  it('AUFWACHEN nach echter Abwesenheit: prüfen UND automatisch übernehmen', async () => {
    // Das erste Loch: der stille Reload hing an `visibilityState === hidden`,
    // beim Zurückkommen ist er per Definition `visible` - der Zweig war vom
    // Rückkehr-Auslöser aus unerreichbar, es blieb bei der alten Ansicht.
    // Der Boot findet nichts Neues; der Deploy passiert, WÄHREND der Kunde weg
    // ist - genau die gemeldete Reihenfolge.
    let served: string | null = null;
    const check = vi.fn(async () => served);
    const reload = vi.fn();
    renderHook(() =>
      useDeployWatch({
        check,
        reload,
        // Mindestfrist RIESIG: nur die Aufwach-Regel kann hier feuern.
        minIntervalMs: 60 * 60_000,
        pollMs: 60 * 60_000,
        resumeAfterMs: 1_000,
        busy: () => false,
      }),
    );
    await tick(0);
    expect(reload).not.toHaveBeenCalled();
    check.mockClear();
    served = '/assets/index-NeuNeu01.js';
    setVisibility('hidden');
    await tick(5_000);
    expect(check).not.toHaveBeenCalled();
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ein KURZER Blick woandershin löst weder Prüfung noch Reload aus', async () => {
    const check = vi.fn(async () => '/assets/index-NeuNeu01.js');
    const reload = vi.fn();
    renderHook(() =>
      useDeployWatch({
        check,
        reload,
        minIntervalMs: 60 * 60_000,
        pollMs: 60 * 60_000,
        resumeAfterMs: 60_000,
        busy: () => false,
      }),
    );
    await tick(0);
    check.mockClear();
    reload.mockClear();
    setVisibility('hidden');
    await tick(2_000);
    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(check).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('bfcache-Rückkehr (pageshow persisted) prüft sofort und übernimmt', async () => {
    let served: string | null = null;
    const check = vi.fn(async () => served);
    const reload = vi.fn();
    renderHook(() =>
      useDeployWatch({
        check,
        reload,
        minIntervalMs: 60 * 60_000,
        pollMs: 60 * 60_000,
        busy: () => false,
      }),
    );
    await tick(0);
    check.mockClear();
    expect(reload).not.toHaveBeenCalled();
    served = '/assets/index-NeuNeu01.js';
    await act(async () => {
      firePageShow(false); // ein normaler Boot löst hier nichts aus
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(check).not.toHaveBeenCalled();
    await act(async () => {
      firePageShow(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('über ungesicherter Eingabe wird NIE automatisch neu geladen', async () => {
    const check = vi.fn(async () => '/assets/index-NeuNeu01.js');
    const reload = vi.fn();
    const { result } = renderHook(() =>
      useDeployWatch({
        check,
        reload,
        minIntervalMs: 60 * 60_000,
        pollMs: 60 * 60_000,
        busy: () => true,
      }),
    );
    await tick(0);
    expect(reload).not.toHaveBeenCalled();
    // Der sichtbare Hinweis ist der Weg - der Kunde entscheidet, wann.
    expect(result.current).toBe(true);
  });

  it('räumt Takt und Listener beim Abbau ab', async () => {
    const check = vi.fn(async () => null);
    const { unmount } = renderHook(() =>
      useDeployWatch({ check, minIntervalMs: 1_000, pollMs: 200 }),
    );
    await tick(0);
    const afterBoot = check.mock.calls.length;
    unmount();
    await tick(5_000);
    setVisibility('visible');
    firePageShow(true);
    await tick(0);
    expect(check).toHaveBeenCalledTimes(afterBoot);
  });

  it('die Konstanten: halbe Stunde Frist, eine Minute Abwesenheit, fünf Minuten Eingabe-Schonfrist', () => {
    expect(DEPLOY_CHECK_MIN_INTERVAL_MS).toBe(30 * 60 * 1000);
    expect(RESUME_CHECK_AFTER_MS).toBe(60 * 1000);
    expect(INPUT_GRACE_MS).toBe(5 * 60 * 1000);
  });
});
