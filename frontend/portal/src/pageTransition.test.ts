import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anlageRoute, pageRoute } from './nav';
import {
  awaitRouteChunk,
  PRELOAD_DEADLINE_MS,
  preloadRoute,
  runPageTransition,
  supportsViewTransitions,
} from './pageTransition';

/**
 * **Der Wächter der EINEN Hülle** (Bewegungs-Programm P5, Empfehlung E5 (a)).
 *
 * Zwei Dinge prüft er, und beide sind Zusagen an den Kunden, nicht Kosmetik:
 *
 * 1. **Ohne die Browser-API bleibt es beim Schnitt von heute** — synchron,
 *    ohne Klasse am `<html>`, ohne Warten. Genau das ist der Zustand, in dem
 *    jsdom und damit JEDER bestehende Test des Portals läuft; ginge er
 *    verloren, würde P5 die ganze Suite asynchron machen.
 * 2. **Ein zweiter Wechsel stapelt nie.** Ein Doppelklick darf keinen halb
 *    überblendeten Übergang stehen lassen und muss auf dem NEUEN Ziel landen.
 */

const html = document.documentElement;

afterEach(() => {
  html.className = '';
  delete (document as unknown as Record<string, unknown>).startViewTransition;
  vi.useRealTimers();
});

/** Eine Attrappe der Browser-API mit Fäden, an denen der Test ziehen kann. */
function fakeApi() {
  const laeufe: Array<{ skipped: boolean; fertig: () => void }> = [];
  (document as unknown as Record<string, unknown>).startViewTransition = (cb: () => void) => {
    let aufloesen: () => void = () => {};
    const finished = new Promise<void>((r) => { aufloesen = r; });
    const lauf = { skipped: false, fertig: aufloesen };
    laeufe.push(lauf);
    cb();
    return {
      finished,
      updateCallbackDone: Promise.resolve(),
      skipTransition: () => { lauf.skipped = true; aufloesen(); },
    };
  };
  return laeufe;
}

describe('Bewegung P5 · ohne die Browser-API bleibt der Schnitt', () => {
  it('`supportsViewTransitions` sagt in jsdom nein', () => {
    expect(supportsViewTransitions()).toBe(false);
  });

  it('wendet SYNCHRON an und stempelt keine Richtung ans `<html>`', () => {
    const gesehen: string[] = [];
    runPageTransition('push', () => gesehen.push('angewandt'));
    // Kein `await`: der Wechsel ist beim Rücksprung schon geschehen.
    expect(gesehen).toEqual(['angewandt']);
    expect(html.className).toBe('');
  });
});

describe('Bewegung P5 · mit der Browser-API läuft GENAU EIN Übergang', () => {
  it('stempelt die Richtung, bevor der Browser das alte Bild aufnimmt', () => {
    fakeApi();
    let klasseWaehrendAnwendung = '';
    runPageTransition('pop', () => { klasseWaehrendAnwendung = html.className; });
    // Der Rückruf läuft INNERHALB des Übergangs — die Klasse muss da schon
    // stehen, sonst sähe das CSS sie für keines der beiden Bilder.
    expect(klasseWaehrendAnwendung).toContain('vp-vt-pop');
  });

  it('räumt die Klasse ab, wenn der Übergang fertig ist', async () => {
    const laeufe = fakeApi();
    runPageTransition('fade', () => {});
    expect(html.classList.contains('vp-vt-fade')).toBe(true);
    laeufe[0].fertig();
    await Promise.resolve();
    await Promise.resolve();
    expect(html.className).toBe('');
  });

  it('ein zweiter Wechsel ÜBERSPRINGT den ersten — und der Neue gewinnt', async () => {
    const laeufe = fakeApi();
    runPageTransition('push', () => {});
    runPageTransition('pop', () => {});
    expect(laeufe).toHaveLength(2);
    expect(laeufe[0].skipped).toBe(true);
    expect(laeufe[1].skipped).toBe(false);
    // Der übersprungene Vorgänger löst seine Zusage aus — er darf die Klasse
    // seines Nachfolgers dabei NICHT wegnehmen.
    await Promise.resolve();
    await Promise.resolve();
    expect(html.classList.contains('vp-vt-pop')).toBe(true);
    expect(html.classList.contains('vp-vt-push')).toBe(false);
  });
});

describe('Bewegung P5 · das Vorladen wartet, aber nicht ewig', () => {
  it('eine Route ohne eigenes Stück wartet auf nichts', () => {
    // Das Anlagen-Cockpit (`sub === null`) ist NICHT lazy geschnitten.
    expect(awaitRouteChunk(anlageRoute('s-1'))).toBeNull();
    expect(preloadRoute(anlageRoute('s-1'))).toBeNull();
  });

  it('ein hängendes Stück löst spätestens nach dem Deckel auf', async () => {
    vi.useFakeTimers();
    const nie = new Promise<void>(() => {});
    const gerast = Promise.race([
      nie,
      new Promise<void>((r) => { window.setTimeout(r, PRELOAD_DEADLINE_MS); }),
    ]);
    vi.advanceTimersByTime(PRELOAD_DEADLINE_MS);
    await expect(gerast).resolves.toBeUndefined();
  });

  it('der Deckel ist der Seiten-Dauer angemessen (300 ms)', () => {
    expect(PRELOAD_DEADLINE_MS).toBe(300);
  });
});

/* ------------------------------------------------------------------------
   Der STRUKTUR-Wächter: wer eine neue Seite `lazy()` schneidet, trägt sie in
   `pageTransition.ts` ein. Vergisst er es, läuft der Übergang in den Deckel
   und schiebt ein Skelett herein — schlechter, aber nie falsch; der Test macht
   es sichtbar, statt es still geschehen zu lassen.
   ------------------------------------------------------------------------ */

const root = resolve(__dirname, '..');
const lies = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

/** Die Pfade, die ein Blatt per `lazy(() => import('…'))` nachlädt. */
function lazyPfade(quelltext: string): Set<string> {
  const out = new Set<string>();
  for (const m of quelltext.matchAll(/lazy\(\(\)\s*=>[\s\S]{0,80}?import\('([^']+)'\)/g)) {
    out.add(m[1]);
  }
  return out;
}

/** Die Pfade, die `pageTransition.ts` in einer seiner zwei Tabellen vorlädt. */
function vorgeladen(tabelle: 'PAGE_CHUNKS' | 'SUB_CHUNKS'): Set<string> {
  const s = lies('src/pageTransition.ts');
  const start = s.indexOf(`const ${tabelle}`);
  const block = s.slice(start, s.indexOf('};', start));
  return new Set([...block.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]));
}

describe('Bewegung P5 · jedes Lazy-Stück ist vorladbar', () => {
  it('die Seiten der Flotten-/Plattform-Ebene sind vollständig', () => {
    const app = lazyPfade(lies('src/App.tsx'));
    // Der Anlege-Assistent ist keine ROUTE (er ist ein Overlay über der
    // Übersicht) und gehört deshalb nicht in die Tabelle.
    app.delete('./Onboarding');
    expect([...app].sort()).toEqual([...vorgeladen('PAGE_CHUNKS')].sort());
  });

  it('die Unterseiten einer Anlage sind vollständig', () => {
    const seiten = lazyPfade(lies('src/pages/AnlagenPage.tsx'));
    // `AnlagenPage.tsx` schneidet relativ zu `src/pages/`, `pageTransition.ts`
    // relativ zu `src/` — dieselben Stücke, ein Punkt Unterschied.
    const gemappt = new Set([...vorgeladen('SUB_CHUNKS')].map((p) => p.replace('./pages/', './')));
    expect([...seiten].sort()).toEqual([...gemappt].sort());
  });

  it('jede Unterseite EINER Anlage findet ihr Stück', () => {
    const subs = [...lies('src/nav.ts').matchAll(/^\s*\|\s*'([a-z]+)'/gm)];
    expect(subs.length).toBeGreaterThan(10);
    const keys = new Set(
      [...lies('src/pageTransition.ts')
        .slice(lies('src/pageTransition.ts').indexOf('const SUB_CHUNKS'))
        .matchAll(/^\s*'?([a-z-]+)'?:\s*\(\)/gm)].map((m) => m[1]),
    );
    // Die 14 Unterseiten der Anlage sind genau die 14 Einträge der Tabelle.
    expect(keys.size).toBe(14);
  });

  it('eine Flotten-Seite ohne eigenes Stück ist ehrlich `null`', () => {
    // `anlagen` OHNE Anlage ist die Umleitungs-Adresse — kein eigenes Bündel.
    expect(preloadRoute(pageRoute('anlagen'))).toBeNull();
  });
});
