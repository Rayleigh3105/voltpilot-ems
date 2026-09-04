import { flushSync } from 'react-dom';
import type { Route, TransitionKind } from './nav';

/* =========================================================================
   DIE EINE STELLE, AN DER DAS PORTAL DIE SEITE WECHSELT (Programm P5)
   Konzept `data/vp-motion-konzept-m1/report.md` §6 + Empfehlung E5 (a),
   Captain-Antwort 8 („Handy wie eine App — Blätter schieben; Rechner nur
   blenden"), Captain-Freigabe 04.09.2026.

   Hier steht die MECHANIK; die RICHTUNG steht rein in `nav.transitionKind`
   und das AUSSEHEN in `index.css` (Block „Bewegung · P5"). Diese Datei
   entscheidet also nichts über Routen und nichts über Pixel — sie sorgt nur
   dafür, dass GENAU EIN Übergang läuft und dass es ohne die Browser-API
   zeichengleich beim heutigen Schnitt bleibt.

   ⚠ **Ohne `document.startViewTransition` gibt es KEIN Ersatz-Blenden** (E5):
     ein selbst gebautes Doppel-Montieren wäre ein zweiter Mechanismus mit
     eigenen Fehlern (doppelte Effekte, doppelte Anfragen) für ein Detail, das
     genau die Browser nicht sehen, die es nicht können. Chrome < 111,
     Safari < 18 und Firefox < 144 bekommen den Schnitt von heute — und mit
     ihnen jsdom, weshalb JEDER bestehende Test unverändert synchron bleibt.
   ========================================================================= */

interface ViewTransitionLike {
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

const KIND_CLASSES = ['vp-vt-push', 'vp-vt-pop', 'vp-vt-fade'] as const;

let running: ViewTransitionLike | null = null;

/** Kann dieser Browser Seitenübergänge? Sonst bleibt es beim Schnitt (E5). */
export function supportsViewTransitions(): boolean {
  return typeof document !== 'undefined'
    && typeof (document as DocumentWithViewTransition).startViewTransition === 'function';
}

/**
 * Wendet einen Routenwechsel an — als Übergang, wo der Browser ihn kann.
 *
 * ⚠ **`flushSync` ist tragend, nicht Vorsicht:** die Browser-API friert das
 * alte Bild ein, ruft diesen Rückruf und fotografiert danach das neue. Liefe
 * Reacts Rendern erst im nächsten Tick, wäre das „neue" Bild noch das alte und
 * der Übergang zeigte zweimal dasselbe.
 *
 * ⚠ **Ein zweiter Wechsel STAPELT nie.** Der Browser lässt ohnehin nur einen
 * Übergang je Dokument zu; wir überspringen den laufenden ausdrücklich, damit
 * er sofort auf seinem Endbild steht, statt halb überblendet stehenzubleiben.
 * Die NEUE Navigation gewinnt — das ist die Erwartung an jeden Doppelklick.
 */
export function runPageTransition(kind: TransitionKind, apply: () => void): void {
  const doc = document as DocumentWithViewTransition;
  if (typeof doc.startViewTransition !== 'function') {
    apply();
    return;
  }
  running?.skipTransition();
  const root = document.documentElement;
  root.classList.remove(...KIND_CLASSES);
  root.classList.add(`vp-vt-${kind}`);
  const transition = doc.startViewTransition(() => {
    flushSync(apply);
  });
  running = transition;
  const done = () => {
    // Nur aufräumen, wenn dieser Übergang noch der laufende ist: ein
    // übersprungener Vorgänger darf die Klasse seines Nachfolgers nicht
    // wegnehmen.
    if (running !== transition) return;
    running = null;
    root.classList.remove(...KIND_CLASSES);
  };
  transition.finished.then(done, done);
  // Ein Fehler im Rückruf lehnt diese Zusage ab; ohne Fänger wäre es eine
  // unbehandelte Ablehnung in der Konsole des Kunden.
  transition.updateCallbackDone.catch(() => {});
}

/* -------------------------------------------------------------------------
   VORLADEN: die Zielseite ist DA, bevor der Übergang beginnt
   -------------------------------------------------------------------------
   Das Risiko aus §9: fast jede Seite ist ein Lazy-Stück. Ohne Vorladen
   fotografierte der Browser als „neues Bild" das SKELETT der Suspense-Grenze,
   schöbe es 300 ms herein und ersetzte es danach hart durch den Inhalt — also
   genau der Sprung, den P5 abschafft, eine Ebene tiefer.

   Also: erst holen, dann schieben. Mit einem DECKEL, weil ein langsames Netz
   sonst jede Navigation stumm hielte — nach `PRELOAD_DEADLINE_MS` läuft der
   Übergang auf das Skelett, und der Kunde sieht wenigstens, dass sein Klick
   angekommen ist. Das Überblenden Skelett → Inhalt ist P6.

   ⚠ **Ein fehlender Eintrag ist ein NO-OP, kein Fehler.** Wer eine neue Seite
     per `lazy()` schneidet und sie hier vergisst, bekommt den Deckel statt des
     Vorladens — schlechter, aber nie falsch. Dieselben Adressen wie in
     `App.tsx`/`pages/AnlagenPage.tsx` treffen dasselbe Stück (Vite löst einen
     dynamischen Import einmal auf), es entsteht also kein zweites Bündel.
   ------------------------------------------------------------------------- */

export const PRELOAD_DEADLINE_MS = 300;

type Loader = () => Promise<unknown>;

/** Seiten der Flotten-/Plattform-Ebene (die `lazy()`-Liste aus `App.tsx`). */
const PAGE_CHUNKS: Record<string, Loader> = {
  uebersicht: () => import('./pages/UebersichtPage'),
  portfolio: () => import('./pages/PortfolioPage'),
  'portfolio-messwerte': () => import('./pages/PortfolioMesswerte'),
  'portfolio-erloese': () => import('./pages/PortfolioErloese'),
  mandanten: () => import('./pages/admin/MandantenPage'),
  'plattform-uebersicht': () => import('./pages/admin/PlattformUebersichtPage'),
  'geraete-registry': () => import('./pages/admin/GeraeteBereich'),
  'edge-updates': () => import('./pages/admin/GeraeteBereich'),
  optimizer: () => import('./pages/admin/OptimizerPage'),
  flows: () => import('./pages/admin/FlowsPage'),
  'steuerungs-freigabe': () => import('./pages/admin/SteuerungsFreigabePage'),
  vorlagen: () => import('./pages/admin/VorlagenPage'),
  'komponenten-flotte': () => import('./pages/admin/KomponentenFlottePage'),
};

/** Unterseiten einer Anlage (die `lazy()`-Liste aus `pages/AnlagenPage.tsx`). */
const SUB_CHUNKS: Record<string, Loader> = {
  fahrplan: () => import('./pages/DataPages'),
  wetter: () => import('./pages/DataPages'),
  marktpreise: () => import('./pages/DataPages'),
  messwerte: () => import('./pages/MesswerteSection'),
  erloese: () => import('./pages/ErloeseSection'),
  modell: () => import('./pages/AnlagenModellSection'),
  geraet: () => import('./pages/GeraetSeiteSection'),
  box: () => import('./pages/BoxSeiteSection'),
  ladevorgaenge: () => import('./pages/LadevorgaengeSection'),
  lastspitzen: () => import('./pages/LastspitzenSection'),
  steuerung: () => import('./pages/SteuerungSection'),
  technik: () => import('./pages/AnlageTechnik'),
  befehle: () => import('./pages/BefehleSection'),
  prognose: () => import('./pages/PrognosePage'),
};

/** Schon geholte Stücke — ein zweiter Besuch wartet auf nichts. */
const loaded = new Set<Loader>();

/**
 * Holt das Stück einer Zielroute, falls es eines gibt und es noch fehlt.
 * `null` heisst „hier ist nichts zu warten" (Anlagen-Cockpit, unbekannte
 * Seite, schon geladen) — der Aufrufer schiebt dann sofort los.
 */
export function preloadRoute(route: Route): Promise<unknown> | null {
  const loader = route.page === 'anlagen' && route.siteId
    ? (route.sub ? SUB_CHUNKS[route.sub] : undefined)
    : PAGE_CHUNKS[route.page];
  if (!loader || loaded.has(loader)) return null;
  return loader().then(
    () => loaded.add(loader),
    // Ein Ladefehler gehört der Suspense-Grenze, nicht der Bewegung: sie
    // zeigt ihn danach. Hier wird er nur nicht zur unbehandelten Ablehnung.
    () => undefined,
  );
}

/** Wartet auf das Stück, aber höchstens `PRELOAD_DEADLINE_MS`. */
export function awaitRouteChunk(route: Route): Promise<void> | null {
  const chunk = preloadRoute(route);
  if (!chunk) return null;
  return Promise.race([
    chunk,
    new Promise<void>((resolve) => { window.setTimeout(resolve, PRELOAD_DEADLINE_MS); }),
  ]).then(() => undefined);
}
