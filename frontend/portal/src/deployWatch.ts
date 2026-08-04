import { useEffect, useState } from 'react';

/**
 * Deploy-Erkennung: ein laufender Tab erfährt, dass der Server ein NEUERES
 * Portal ausliefert als das, das er gerade ausführt.
 *
 * Das WARUM (Scout vp-stale-view-w2, 04.08.2026): es gab keinerlei Mechanismus,
 * der einer offenen SPA-Sitzung einen Deploy mitteilt. Ein über Tage/Wochen
 * offener (angehefteter, wiederhergestellter) Tab lief mit der UI seines
 * Deploy-Stands weiter — die API-Endpunkte sind additiv, die alte App
 * funktioniert also klaglos und wirkt „aktuell" — und jeder Reload wurde zum
 * Alt→Neu-Erlebnis. Der Vergleichsanker ist das ENTRY-BUNDLE: Vite hasht es
 * pro Build (`/assets/index-<hash>.js`), die frisch geholte `index.html`
 * (no-store) referenziert also genau dann einen anderen Pfad, wenn ein neuer
 * Stand ausgeliefert wird. Kein eigener Versions-Endpunkt, nichts zu pflegen.
 *
 * Ehrlichkeits-/Sicherheitsregeln:
 *  - Ohne erkennbares laufendes Entry-Bundle (Dev-Server: das Dokument lädt
 *    `/src/main.tsx`) deaktiviert sich die Prüfung selbst — nie ein geratener
 *    Befund, und der Netz-Abruf unterbleibt ganz.
 *  - Jeder Fehlschlag (Netz, non-2xx, HTML ohne Bundle-Referenz) ist STUMM:
 *    die Prüfung ist Komfort, nie ein neuer Fehlerkanal.
 *  - Verdeckter Tab → stiller Reload, aber je Ziel-Bundle nur EINMAL
 *    (sessionStorage-Wächter): eine kaputte Zwischenschicht, die dauerhaft
 *    einen fremden Stand liefert, darf den Tab nicht in eine Reload-Schleife
 *    schicken — dann bleibt der sichtbare Hinweis der Weg.
 */

/** Frühestens alle 30 min wird wirklich geprüft (der Boot zählt als Prüfung). */
export const DEPLOY_CHECK_MIN_INTERVAL_MS = 30 * 60 * 1000;
/** Takt, in dem die Fälligkeit geprüft wird (Browser drosseln ihn im Hintergrund). */
export const DEPLOY_POLL_MS = 5 * 60 * 1000;
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

export interface DeployWatchDeps {
  /** Test-Naht; Produktion = {@link fetchNewBundle}. */
  check?: () => Promise<string | null>;
  reload?: () => void;
  minIntervalMs?: number;
  pollMs?: number;
}

/**
 * true, sobald der Server einen neueren Stand ausliefert und der Tab SICHTBAR
 * ist (der Aufrufer rendert dann den „Jetzt aktualisieren"-Hinweis). Ein
 * verdeckter Tab lädt still neu — für den Kunden unsichtbar, und der nächste
 * Blick trifft die aktuelle Version. Die Deps werden bewusst nur beim Mount
 * gelesen (Tests reichen stabile Fakes).
 */
export function useDeployWatch(deps: DeployWatchDeps = {}): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const check = deps.check ?? fetchNewBundle;
    const reload = deps.reload ?? (() => window.location.reload());
    const minIntervalMs = deps.minIntervalMs ?? DEPLOY_CHECK_MIN_INTERVAL_MS;
    const pollMs = deps.pollMs ?? DEPLOY_POLL_MS;
    let disposed = false;
    // Der Boot zählt als Prüfung: dieses Dokument kam gerade frisch vom Server.
    let lastCheck = Date.now();

    const run = async () => {
      lastCheck = Date.now();
      const served = await check();
      if (disposed || served == null) return;
      if (document.visibilityState === 'hidden') {
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
    const maybeRun = () => {
      if (Date.now() - lastCheck >= minIntervalMs) void run();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeRun();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(maybeRun, pollMs);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return updateAvailable;
}
