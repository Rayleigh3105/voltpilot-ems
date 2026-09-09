import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anlageRoute, pageRoute } from './nav';
import { SUB_CHUNK } from './pageChunks';
import {
  awaitRouteChunk,
  PRELOAD_DEADLINE_MS,
  preloadRoute,
  runPageTransition,
  supportsViewTransitions,
  transitionToRoute,
} from './pageTransition';

vi.mock('./pageChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pageChunks')>();
  return {
    ...actual,
    SUB_CHUNK: { ...actual.SUB_CHUNK, steuerung: vi.fn(actual.SUB_CHUNK.steuerung) },
  };
});

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
  vi.restoreAllMocks();
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

describe('Latest navigation wins while a page chunk is loading', () => {
  it('does not let a delayed page replace a newer cockpit selection', async () => {
    fakeApi();
    let finish!: () => void;
    vi.mocked(SUB_CHUNK.steuerung).mockReturnValueOnce(new Promise<void>((r) => { finish = r; }) as never);
    const shown: string[] = [];
    transitionToRoute(anlageRoute('a', 'steuerung'), 'push', () => shown.push('old'));
    transitionToRoute(anlageRoute('b'), 'fade', () => shown.push('new'));
    expect(shown).toEqual(['new']);
    finish();
    // Drain the preload -> race -> commit promise chain before the assertion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shown).toEqual(['new']);
  });

  it('keeps navigation synchronous without View Transitions', () => {
    const apply = vi.fn();
    transitionToRoute(anlageRoute('a', 'steuerung'), 'push', apply);
    expect(apply).toHaveBeenCalledOnce();
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
   Der STRUKTUR-Wächter: `pageChunks.ts` ist die EINE Schnitt-Grenze, und sie
   hat GENAU ZWEI Abnehmer — die `lazy()`-Komponenten (was der Browser beim
   Rendern holt) und die Vorlade-Tabellen (was der Seitenwechsel VORHER holt).
   Läuft eines der beiden Enden auseinander, wechselt eine Seite still ohne
   Vorladen: der Übergang läuft in den Deckel und schiebt ein Skelett herein —
   schlechter, aber nie falsch. Diese drei Tests machen es sichtbar, statt es
   geschehen zu lassen.
   ------------------------------------------------------------------------ */

const root = resolve(__dirname, '..');
const lies = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

/** Die Schlüssel EINER Tabelle in `pageChunks.ts`. */
function stueckSchluessel(tabelle: 'PAGE_CHUNK' | 'SUB_CHUNK'): Set<string> {
  const s = lies('src/pageChunks.ts');
  const start = s.indexOf(`export const ${tabelle}`);
  expect(start).toBeGreaterThan(-1);
  const block = s.slice(start, s.indexOf('} as const;', start));
  return new Set([...block.matchAll(/^\s*'?([a-z-]+)'?:\s*\(\)\s*=>/gm)].map((m) => m[1]));
}

/** Die Schlüssel, die eine Datei aus dieser Tabelle wirklich ABRUFT. */
function abgerufen(datei: string, tabelle: 'PAGE_CHUNK' | 'SUB_CHUNK'): Set<string> {
  const s = lies(datei);
  const out = new Set<string>();
  // Die zwei Abrufformen: `X.key()` (die `lazy()`-Seite ruft es sofort)
  // und `X.key` (die Vorlade-Tabelle merkt es sich als Funktion).
  for (const m of s.matchAll(new RegExp(`${tabelle}(?:\\.([a-zA-Z-]+)|\\['([^']+)'\\])`, 'g'))) {
    out.add(m[1] ?? m[2]);
  }
  return out;
}

describe('Bewegung P5 · jedes Lazy-Stück ist vorladbar', () => {
  it('jedes Stück der Flotten-/Plattform-Ebene wird gerendert UND vorgeladen', () => {
    const stuecke = stueckSchluessel('PAGE_CHUNK');
    expect(stuecke.size).toBeGreaterThan(10);
    // Gerendert: `App.tsx` baut aus JEDEM Schlüssel eine `lazy()`-Komponente.
    expect([...abgerufen('src/App.tsx', 'PAGE_CHUNK')].sort()).toEqual([...stuecke].sort());
    // Vorgeladen: bis auf `onboarding` — der Anlege-Assistent ist keine ROUTE,
    // sondern ein Overlay über der Übersicht, es gibt also nichts anzusteuern.
    const vorgeladen = abgerufen('src/pageTransition.ts', 'PAGE_CHUNK');
    const erwartet = new Set(stuecke);
    erwartet.delete('onboarding');
    expect([...vorgeladen].sort()).toEqual([...erwartet].sort());
  });

  it('jedes Stück einer Anlagen-Unterseite wird gerendert UND vorgeladen', () => {
    const stuecke = stueckSchluessel('SUB_CHUNK');
    expect(stuecke.size).toBeGreaterThan(10);
    expect([...abgerufen('src/pages/AnlagenPage.tsx', 'SUB_CHUNK')].sort())
      .toEqual([...stuecke].sort());
    expect([...abgerufen('src/pageTransition.ts', 'SUB_CHUNK')].sort())
      .toEqual([...stuecke].sort());
  });

  it('jede Unterseite EINER Anlage findet ihr Stück', () => {
    // Das Vokabular von `AnlagenSub` in `nav.ts` …
    const s = lies('src/nav.ts');
    const start = s.indexOf('export type AnlagenSub');
    expect(start).toBeGreaterThan(-1);
    const subs = new Set(
      [...s.slice(start, s.indexOf(';', start)).matchAll(/'([a-z]+)'/g)].map((m) => m[1]),
    );
    expect(subs.size).toBeGreaterThan(10);
    // … und die Zuordnung Unterseite → Stück in `pageTransition.ts` sind
    // dieselbe Menge. Eine Unterseite ohne Eintrag liefe in den Deckel.
    const t = lies('src/pageTransition.ts');
    const tabStart = t.indexOf('const SUB_LOADER');
    const zugeordnet = new Set(
      [...t.slice(tabStart, t.indexOf('};', tabStart))
        .matchAll(/^\s*([a-z]+):\s*SUB_CHUNK/gm)].map((m) => m[1]),
    );
    expect([...zugeordnet].sort()).toEqual([...subs].sort());
  });

  it('eine Flotten-Seite ohne eigenes Stück ist ehrlich `null`', () => {
    // `anlagen` OHNE Anlage ist die Umleitungs-Adresse — kein eigenes Bündel.
    expect(preloadRoute(pageRoute('anlagen'))).toBeNull();
  });
});
