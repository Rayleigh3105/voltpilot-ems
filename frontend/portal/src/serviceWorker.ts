/**
 * Registrierung der App-Huelle.
 *
 * Der Service Worker selbst (`public/sw.js`) ist DURCHREICHE mit Offline-
 * Rueckfall und cacht weder `index.html` noch `/assets/*` noch eine API-Antwort
 * - die Begruendung steht im Kopf jener Datei. Hier steht nur, WANN er
 * ueberhaupt registriert wird.
 *
 * Drei Bedingungen, jede aus einem eigenen Grund:
 *  - **nicht im Dev-Server**: dort gibt es keine gehashten Buendel und keine
 *    Auslieferungs-Politik, gegen die er sich verhalten muesste; ein aus einem
 *    `npm run preview` uebrig gebliebener Worker wuerde einem Entwickler
 *    ausserdem `offline.html` zeigen, sobald Vite gerade neu startet. Deshalb
 *    wird er dort nicht nur uebersprungen, sondern aktiv ABGEMELDET.
 *  - **`serviceWorker` vorhanden**: ein aelterer Browser hat ihn schlicht nicht.
 *  - **sicherer Kontext**: die Registrierung braucht HTTPS oder localhost. Ohne
 *    die Pruefung wirft der Aufruf auf einem LAN-Test ueber plain HTTP eine
 *    Ausnahme in die Konsole, ohne dass irgendetwas kaputt waere.
 *
 * Registriert wird NACH `load`: die Huelle ist Komfort und darf nie mit dem
 * ersten Bild um Bandbreite konkurrieren.
 */

/** Der Pfad des Workers. Wurzel-Scope, weil er unter `/` liegt. */
export const SERVICE_WORKER_URL = '/sw.js';

export interface ServiceWorkerEnv {
  /** Vite-Dev-Server (`import.meta.env.DEV`). */
  dev: boolean;
  /** `'serviceWorker' in navigator`. */
  supported: boolean;
  /** `window.isSecureContext` - HTTPS oder localhost. */
  secure: boolean;
}

/** Rein: darf in dieser Umgebung registriert werden? */
export function shouldRegisterServiceWorker(env: ServiceWorkerEnv): boolean {
  return env.supported && env.secure && !env.dev;
}

/**
 * Rein: soll ein VORHANDENER Worker abgemeldet werden? Genau im Dev-Server -
 * sonst ueberlebt ein Worker aus einem `npm run preview` den Wechsel zurueck.
 */
export function shouldUnregisterServiceWorker(env: ServiceWorkerEnv): boolean {
  return env.supported && env.dev;
}

interface RegisterDeps {
  env?: ServiceWorkerEnv;
  container?: ServiceWorkerContainer;
  onLoad?: (run: () => void) => void;
}

function currentEnv(): ServiceWorkerEnv {
  return {
    dev: import.meta.env.DEV,
    supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    secure: typeof window !== 'undefined' && window.isSecureContext === true,
  };
}

/** Nach `load` ausfuehren - oder sofort, wenn die Seite schon fertig ist. */
function afterLoad(run: () => void): void {
  if (document.readyState === 'complete') {
    run();
    return;
  }
  window.addEventListener('load', run, { once: true });
}

/**
 * Duenne Verdrahtung. Jeder Fehlschlag ist STUMM bis auf eine Konsolenzeile -
 * die Huelle ist Komfort und darf nie ein neuer Fehlerkanal sein.
 */
export function registerServiceWorker(deps: RegisterDeps = {}): void {
  const env = deps.env ?? currentEnv();
  const container =
    deps.container ?? (env.supported ? navigator.serviceWorker : undefined);
  if (!container) return;
  const onLoad = deps.onLoad ?? afterLoad;

  if (shouldUnregisterServiceWorker(env)) {
    void container
      .getRegistrations?.()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {
        /* nichts abzumelden */
      });
    return;
  }
  if (!shouldRegisterServiceWorker(env)) return;

  onLoad(() => {
    void container.register(SERVICE_WORKER_URL).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('Service Worker konnte nicht registriert werden', err);
    });
  });
}
