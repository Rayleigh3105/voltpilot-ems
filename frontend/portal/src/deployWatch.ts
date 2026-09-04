import { useEffect, useState } from 'react';

/**
 * Deploy-Erkennung: ein Tab führt nie länger als einen Augenblick eine ANDERE
 * Fassung des Portals aus als die, die der Server gerade ausliefert.
 *
 * Das WARUM (Scout vp-stale-view-w2 04.08.2026, erweitert um die dritte
 * Eskalation 06.08.2026): der Kunde sah „beim Öffnen zuerst die alte Ansicht"
 * — auf JEDEM Endgerät, also nicht wegputzbar. Die Auslieferungskette ist
 * dabei nachweislich sauber (index.html `no-cache`/`cf-cache-status: DYNAMIC`,
 * gehashte Bündel `immutable`, ein verschwundenes Bündel ein hartes 404);
 * der Rest ist LEBENSZYKLUS im Browser, und dort hatte diese Datei zwei
 * strukturelle Löcher (beide im echten Chrome nachgestellt):
 *
 *  1. **Der Rückkehr-Pfad konnte gar nicht neu laden.** Der stille Reload hing
 *     an `document.visibilityState === 'hidden'` — der einzige Auslöser, der
 *     beim Zurückkommen feuert, ist aber `visibilitychange → sichtbar`, dort
 *     ist der Zustand per Definition `visible`. Der Zweig war vom
 *     Rückkehr-Auslöser aus UNERREICHBAR, und Hintergrund-Takte drosseln oder
 *     frieren Browser ein, also lief er im Feld praktisch nie. Ergebnis:
 *     alte Ansicht + bestenfalls ein Hinweis.
 *  2. **Der Boot galt als Prüfung.** Das stimmt nur, wenn das laufende
 *     Dokument WIRKLICH das ist, was der Server ausliefert. Ein Client, dessen
 *     `index.html` aus einer alten Schicht kam (heuristischer Browser-Cache
 *     aus der Zeit VOR der `no-cache`-Politik, eine Zwischenschicht, ein
 *     wiederhergestellter Tab), lief damit eine halbe Stunde lang ungeprüft
 *     auf dem alten Stand — und eine Portal-Sitzung ist meist kürzer.
 *     Nachgemessen: frischer Boot (`pageshow persisted=false`), alte Ansicht,
 *     während der Server längst das neue Bündel ausliefert; `location.reload()`
 *     validiert nach und heilt es.
 *
 * Der Anker bleibt das ENTRY-BUNDLE: Vite hasht es pro Build
 * (`/assets/index-<hash>.js`), die frisch geholte `index.html` (`no-store`,
 * also am Browser-Cache vorbei) referenziert also genau dann einen anderen
 * Pfad, wenn ein anderer Stand ausgeliefert wird. Kein Versions-Endpunkt,
 * nichts zu pflegen — und weil geprüft wird, was der Server JETZT liefert,
 * fängt es jede stale Schicht ab, ohne sie kennen zu müssen.
 *
 * Wann automatisch neu geladen wird — nach AUSLÖSER, nicht nach Sichtbarkeit:
 *  - **Boot** (die wichtigste Prüfung; es gibt nichts zu verlieren),
 *  - **Rückkehr nach echter Abwesenheit** (>= {@link RESUME_CHECK_AFTER_MS}) —
 *    das ist das „Öffnen" aus der Kundenmeldung,
 *  - **bfcache-Rückkehr** (`pageshow` mit `persisted`) — eingefrorene Seite,
 *  - **verdeckter Tab** (wie bisher).
 * Ein kurzer Tab-Wechsel und der laufende Takt eines SICHTBAREN Tabs laden
 * NICHT von selbst — wer gerade liest, bekommt den Hinweis; niemandem wird die
 * Seite unter den Augen weggezogen.
 *
 * Ehrlichkeits-/Sicherheitsregeln:
 *  - Ohne erkennbares laufendes Entry-Bundle (Dev-Server: das Dokument lädt
 *    `/src/main.tsx`) deaktiviert sich die Prüfung selbst — nie ein geratener
 *    Befund, und der Netz-Abruf unterbleibt ganz.
 *  - Jeder Fehlschlag (Netz, non-2xx, HTML ohne Bundle-Referenz) ist STUMM:
 *    die Prüfung ist Komfort, nie ein neuer Fehlerkanal.
 *  - **Nie ein Reload über ungesicherter Eingabe** ({@link hasUnsavedInput}) —
 *    dort bleibt der sichtbare Hinweis der Weg.
 *  - Je Ziel-Bundle wird HÖCHSTENS EINMAL automatisch neu geladen
 *    (sessionStorage-Wächter): eine kaputte Zwischenschicht, die dauerhaft
 *    einen fremden Stand liefert, darf den Tab nicht in eine Reload-Schleife
 *    schicken — danach übernimmt der Hinweis.
 */

/** Frühestens alle 30 min prüft der laufende Takt von sich aus. */
export const DEPLOY_CHECK_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** Takt, in dem die Fälligkeit geprüft wird (Browser drosseln ihn im Hintergrund). */
export const DEPLOY_POLL_MS = 5 * 60 * 1000;
/**
 * Ab dieser Verdeckungsdauer ist die Rückkehr ein AUFWACHEN: sofort prüfen und
 * gegebenenfalls automatisch neu laden, unabhängig von der Mindestfrist. Ein
 * kurzer Blick in einen anderen Tab bleibt darunter und löst keinen Abruf aus.
 */
export const RESUME_CHECK_AFTER_MS = 60 * 1000;
/**
 * So lange nach der letzten Tastatur-/Formulareingabe gilt die Sitzung als
 * „der Kunde arbeitet gerade" — dort wird nie automatisch neu geladen.
 */
export const INPUT_GRACE_MS = 5 * 60 * 1000;

const AUTO_RELOAD_KEY = 'vp.deployWatch.autoReloadedFor';

const ENTRY_BUNDLE_RE = /\/assets\/index-[\w-]+\.js/;

/** Entry-Bundle-Pfad aus einem index.html-Text (null = keiner referenziert). */
export function entryBundleFrom(html: string): string | null {
  const m = html.match(ENTRY_BUNDLE_RE);
  return m ? m[0] : null;
}

/** Der Pfad des GERADE LAUFENDEN Entry-Bundles (null im Dev-Server). */
export function runningEntryBundle(doc: Document = document): string | null {
  const el = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return el ? entryBundleFrom(el.getAttribute('src') ?? '') : null;
}

/**
 * Fragt den Server nach seiner aktuellen `index.html` und vergleicht deren
 * Entry-Bundle mit dem laufenden. Liefert den NEUEN Bundle-Pfad, wenn der
 * Server einen anderen Stand ausliefert, sonst null — auch bei jedem Fehler.
 *
 * `cache: 'no-store'` ist tragend: die Frage lautet „was liefert der Server
 * JETZT", nicht „was liegt in meinem Cache" — genau daran hängt, dass auch ein
 * Client mit heuristisch gecachter `index.html` seinen Rückstand bemerkt.
 */
export async function fetchNewBundle(
  fetchImpl: typeof fetch = fetch,
  doc: Document = document,
): Promise<string | null> {
  const running = runningEntryBundle(doc);
  if (running == null) return null;
  try {
    const res = await fetchImpl('/', { cache: 'no-store' });
    if (!res.ok) return null;
    const served = entryBundleFrom(await res.text());
    return served != null && served !== running ? served : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Ungesicherte Eingabe                                                       */
/* -------------------------------------------------------------------------- */

let lastInputAt = Number.NEGATIVE_INFINITY;

/** Merkt eine Nutzereingabe (der Hook hängt sie an das `input`-Ereignis). */
export function noteUserInput(at: number = Date.now()): void {
  lastInputAt = at;
}

/** Nur für Tests: vergisst die gemerkte Eingabe. */
export function resetUserInput(): void {
  lastInputAt = Number.NEGATIVE_INFINITY;
}

/**
 * true, wenn ein automatischer Reload gerade Arbeit vernichten könnte.
 *
 * Bewusst NICHT über einen Attribut-/Property-Vergleich der Formularfelder:
 * React hält bei einem kontrollierten Feld `defaultValue` mit `value` in
 * Deckung, ein getipptes Feld sähe dort also unverändert aus (und ein
 * vorbelegtes umgekehrt verändert) — die Erkennung wäre in BEIDE Richtungen
 * falsch. Stattdessen drei belastbare Signale:
 *
 *  1. eine offene Aufgabenfläche (`.vp-modal` / `[aria-modal="true"]` /
 *     `dialog[open]`) — im Portal ist das immer ein Anlegen/Bearbeiten/
 *     Bestätigen, nie eine reine Erklärfläche (`.vp-fw-panel`, das Mehr-Blatt,
 *     das Hilfe-Panel tragen `role="dialog"` OHNE `aria-modal`),
 *  2. der Fokus steht in einem Eingabefeld,
 *  3. es wurde in den letzten {@link INPUT_GRACE_MS} wirklich etwas eingegeben.
 *
 * Im Zweifel „ja": die Folge ist der sichtbare Hinweis statt eines Reloads.
 */
export function hasUnsavedInput(doc: Document = document, now: number = Date.now()): boolean {
  if (now - lastInputAt < INPUT_GRACE_MS) return true;
  if (doc.querySelector('.vp-modal, [aria-modal="true"], dialog[open]')) return true;
  const active = doc.activeElement as HTMLElement | null;
  if (!active) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable === true;
}

/* -------------------------------------------------------------------------- */

export interface DeployWatchDeps {
  /** Test-Naht; Produktion = {@link fetchNewBundle}. */
  check?: () => Promise<string | null>;
  reload?: () => void;
  /** Test-Naht; Produktion = {@link hasUnsavedInput}. */
  busy?: () => boolean;
  minIntervalMs?: number;
  pollMs?: number;
  resumeAfterMs?: number;
}

/**
 * true, sobald der Server einen neueren Stand ausliefert und dieser Tab ihn
 * NICHT automatisch übernehmen durfte (der Aufrufer rendert dann den
 * „Jetzt aktualisieren"-Hinweis). Beim Ankommen — Boot, Rückkehr nach echter
 * Abwesenheit, bfcache — lädt der Tab von selbst neu, solange dabei keine
 * Eingabe verloren gehen kann. Die Deps werden bewusst nur beim Mount gelesen
 * (Tests reichen stabile Fakes).
 */
export function useDeployWatch(deps: DeployWatchDeps = {}): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const check = deps.check ?? fetchNewBundle;
    const reload = deps.reload ?? (() => window.location.reload());
    const busy = deps.busy ?? (() => hasUnsavedInput());
    const minIntervalMs = deps.minIntervalMs ?? DEPLOY_CHECK_MIN_INTERVAL_MS;
    const pollMs = deps.pollMs ?? DEPLOY_POLL_MS;
    const resumeAfterMs = deps.resumeAfterMs ?? RESUME_CHECK_AFTER_MS;
    let disposed = false;
    // Der Boot ist KEINE Prüfung: genau das machte einen Client mit altem
    // Dokument eine halbe Stunde lang blind für seinen eigenen Rückstand.
    let lastCheck = 0;
    let running = false;
    let hiddenSince: number | null =
      document.visibilityState === 'hidden' ? Date.now() : null;

    /** @param mayReload darf DIESER Auslöser still neu laden? */
    const run = async (mayReload: boolean) => {
      if (running) return;
      running = true;
      lastCheck = Date.now();
      let served: string | null = null;
      try {
        served = await check();
      } finally {
        running = false;
      }
      if (disposed || served == null) return;
      if ((mayReload || document.visibilityState === 'hidden') && !busy()) {
        let alreadyFor: string | null = null;
        try {
          alreadyFor = sessionStorage.getItem(AUTO_RELOAD_KEY);
        } catch {
          // sessionStorage gesperrt: kein stiller Reload ohne Schleifen-Schutz.
        }
        if (alreadyFor !== served) {
          try {
            sessionStorage.setItem(AUTO_RELOAD_KEY, served);
            reload();
            return;
          } catch {
            /* fällt auf den sichtbaren Hinweis zurück */
          }
        }
      }
      setUpdateAvailable(true);
    };
    const maybeRun = (force: boolean, mayReload: boolean) => {
      if (force || Date.now() - lastCheck >= minIntervalMs) void run(mayReload);
    };

    // Ankommen #1: dieses Dokument kann aus einer alten Schicht stammen.
    maybeRun(true, true);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince = Date.now();
        return;
      }
      // Ankommen #2: nach echter Abwesenheit sofort prüfen und übernehmen;
      // ein kurzer Blick woandershin bleibt der normalen Frist unterworfen.
      const away = hiddenSince == null ? 0 : Date.now() - hiddenSince;
      hiddenSince = null;
      const woken = away >= resumeAfterMs;
      maybeRun(woken, woken);
    };
    // Ankommen #3: die Seite kam eingefroren aus dem bfcache zurück - kein
    // Boot, kein React-Neuaufbau, also der einzige Ort, an dem das auffällt.
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      hiddenSince = null;
      maybeRun(true, true);
    };
    const onInput = () => noteUserInput();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('input', onInput, true);
    const timer = window.setInterval(
      () => maybeRun(false, document.visibilityState === 'hidden'),
      pollMs,
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('input', onInput, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return updateAvailable;
}
