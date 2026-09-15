import { flushSync } from 'react-dom';
import { PAGE_CHUNK, SUB_CHUNK } from './pageChunks';
import type { AnlagenSub, PageId, Route, TransitionKind } from './nav';

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

   ⚠ **Die `import()`-Aufrufe stehen NICHT hier, sondern in `pageChunks.ts`.**
     Vite erzeugt je AUFRUFSTELLE einen eigenen Vorlade-Rumpf samt
     Abhängigkeitsliste; eine zweite Liste derselben Adressen kostete das
     Einstiegs-Bündel gemessene 1,03 kB gz für null zusätzliche Funktion
     (Begründung dort). Hier steht nur, WELCHE Route WELCHES Stück braucht.

   ⚠ **Ein fehlender Eintrag ist ein NO-OP, kein Fehler.** Wer eine Route
     vergisst, bekommt den Deckel statt des Vorladens — schlechter, aber nie
     falsch.
   ------------------------------------------------------------------------- */

export const PRELOAD_DEADLINE_MS = 300;

type Loader = () => Promise<unknown>;

/**
 * Die Unterseiten, die sich EIN Stück teilen, nennen dasselbe: Fahrplan,
 * Wetter und Marktpreise wohnen zu dritt in `DataPages`.
 */
const SUB_LOADER: Partial<Record<AnlagenSub, Loader>> = {
  fahrplan: SUB_CHUNK.daten,
  wetter: SUB_CHUNK.daten,
  marktpreise: SUB_CHUNK.daten,
  messwerte: SUB_CHUNK.messwerte,
  erloese: SUB_CHUNK.erloese,
  modell: SUB_CHUNK.modell,
  geraet: SUB_CHUNK.geraet,
  box: SUB_CHUNK.box,
  ladevorgaenge: SUB_CHUNK.ladevorgaenge,
  lastspitzen: SUB_CHUNK.lastspitzen,
  steuerung: SUB_CHUNK.steuerung,
  technik: SUB_CHUNK.technik,
  befehle: SUB_CHUNK.befehle,
  prognose: SUB_CHUNK.prognose,
};

/**
 * `anlagen` fehlt mit Absicht: ohne Anlage ist es die Umleitungs-Adresse der
 * Flotten-Ebene, mit Anlage das Cockpit — beides ohne eigenes Stück.
 * Geräte-Registry und Edge-Updates teilen sich `GeraeteBereich`.
 */
const PAGE_LOADER: Partial<Record<PageId, Loader>> = {
  hilfe: PAGE_CHUNK.hilfe,
  uebersicht: PAGE_CHUNK.uebersicht,
  portfolio: PAGE_CHUNK.portfolio,
  'portfolio-standorte': PAGE_CHUNK['portfolio-standorte'],
  'portfolio-messstellen': PAGE_CHUNK['portfolio-messstellen'],
  'portfolio-kennzahlen': PAGE_CHUNK['portfolio-kennzahlen'],
  'portfolio-berichte': PAGE_CHUNK['portfolio-berichte'],
  'portfolio-messwerte': PAGE_CHUNK['portfolio-messwerte'],
  'portfolio-erloese': PAGE_CHUNK['portfolio-erloese'],
  standort: PAGE_CHUNK.standort,
  mandanten: PAGE_CHUNK.mandanten,
  'plattform-uebersicht': PAGE_CHUNK['plattform-uebersicht'],
  'geraete-registry': PAGE_CHUNK['geraete-registry'],
  'edge-updates': PAGE_CHUNK['geraete-registry'],
  optimizer: PAGE_CHUNK.optimizer,
  flows: PAGE_CHUNK.flows,
  'steuerungs-freigabe': PAGE_CHUNK['steuerungs-freigabe'],
  vorlagen: PAGE_CHUNK.vorlagen,
  'komponenten-flotte': PAGE_CHUNK['komponenten-flotte'],
};

/** Route → Stück. `undefined` heisst „diese Seite liegt im Einstieg". */
function loaderFor(route: Route): Loader | undefined {
  if (route.page !== 'anlagen') return PAGE_LOADER[route.page];
  // Das Anlagen-COCKPIT (`sub === null`) ist nicht geschnitten — es ist das
  // Ziel fast jedes Besuchs und liegt im Einstiegs-Bündel.
  return route.siteId != null && route.sub != null ? SUB_LOADER[route.sub] : undefined;
}

/** Schon geholte Stücke — ein zweiter Besuch wartet auf nichts. */
const loaded = new Set<Loader>();

/**
 * Holt das Stück einer Zielroute, falls es eines gibt und es noch fehlt.
 * `null` heisst „hier ist nichts zu warten" (Anlagen-Cockpit, unbekannte
 * Seite, schon geladen) — der Aufrufer schiebt dann sofort los.
 */
export function preloadRoute(route: Route): Promise<unknown> | null {
  const loader = loaderFor(route);
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

let navigationVersion = 0;

/** A late chunk from a previous click must never replace the latest route. */
export function transitionToRoute(route: Route, kind: TransitionKind, apply: () => void): void {
  const version = ++navigationVersion;
  if (!supportsViewTransitions()) {
    apply();
    return;
  }
  const commit = () => {
    if (version === navigationVersion) runPageTransition(kind, apply);
  };
  const chunk = awaitRouteChunk(route);
  if (chunk) void chunk.then(commit);
  else commit();
}
