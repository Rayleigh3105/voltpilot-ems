/**
 * „Als App auf dem Handy" - die Regeln und die Copy der Einrichten-Fläche.
 *
 * Das Portal ist mobil fertig; was fehlte, war die Hülle: Manifest, Icons,
 * Vollbild. Diese Datei entscheidet ausschließlich, WAS der Kunde darüber liest
 * und ob es überhaupt etwas zu tun gibt - sie rendert nichts und ruft nichts
 * auf, was ein Gerät verändert.
 *
 * Vier Zustände, weil es vier verschiedene Situationen sind:
 *  - `installiert`   - läuft bereits als App. Dann gibt es KEINEN Hinweis mehr,
 *                      nur einen ruhigen Satz (nie eine Aufforderung zu etwas,
 *                      das schon geschehen ist).
 *  - `installierbar` - der Browser hat uns seinen Einrichten-Dialog angeboten
 *                      (Chrome/Edge, Android wie Rechner). Ein echter Knopf.
 *  - `ios-anleitung` - iPhone/iPad. Apple bietet KEINEN Dialog an, also ist die
 *                      Zwei-Schritt-Anleitung der einzige ehrliche Weg.
 *  - `nicht-verfuegbar` - dieser Browser sagt nichts an. Dann steht dort der
 *                      GRUND und der Weg, nie ein Knopf, der nichts bewirkt
 *                      (die `applyView`-Regel des Hauses).
 *
 * DIE EHRLICHKEITSREGEL dieser Fläche: es wird nichts behauptet, was der
 * Browser nicht gesagt hat. `beforeinstallprompt` ist der EINZIGE Beleg dafür,
 * dass ein Knopf etwas bewirken kann - eine Prüfung „ist das Manifest da?"
 * verspräche eine Einrichtung, die der Browser danach verweigert.
 */

/** Der Zustand der Einrichtung auf DIESEM Gerät. */
export type InstallState =
  | 'installiert'
  | 'installierbar'
  | 'ios-anleitung'
  | 'nicht-verfuegbar';

/** Was ein Klick auf „App installieren" ergeben hat. */
export type InstallOutcome = 'installiert' | 'abgelehnt' | 'nicht-moeglich';

export interface InstallFacts {
  /** Ein `beforeinstallprompt` liegt eingefangen bereit. */
  promptReady: boolean;
  /** Läuft schon als installierte App (Vollbild ohne Browser-Leiste). */
  standalone: boolean;
  /** iPhone/iPad - dort gibt es nie einen Einrichten-Dialog. */
  ios: boolean;
}

/**
 * Die Zustands-Regel. Die Reihenfolge ist eine Aussage: wer die App schon
 * benutzt, bekommt NIE eine Anleitung dazu - auch nicht, wenn der Browser
 * daneben noch einen Dialog anböte.
 */
export function installState(facts: InstallFacts): InstallState {
  if (facts.standalone) return 'installiert';
  if (facts.promptReady) return 'installierbar';
  if (facts.ios) return 'ios-anleitung';
  return 'nicht-verfuegbar';
}

/* -------------------------------------------------------------------------- */
/* Erkennung                                                                  */
/* -------------------------------------------------------------------------- */

interface MediaQueryLike {
  matches: boolean;
  addEventListener?: (t: 'change', cb: () => void) => void;
  removeEventListener?: (t: 'change', cb: () => void) => void;
}

/** Genau das, was diese Datei vom `window` braucht - damit Tests es stellen können. */
export interface InstallEnv {
  addEventListener(type: string, cb: (e: Event) => void): void;
  removeEventListener(type: string, cb: (e: Event) => void): void;
  matchMedia?(query: string): MediaQueryLike;
  navigator?: {
    userAgent?: string;
    maxTouchPoints?: number;
    platform?: string;
    /** Apples eigener Standalone-Marker (nur Safari). */
    standalone?: boolean;
  };
}

/** Der Marker, an dem ein Browser eine installierte App erkennt. */
export const STANDALONE_QUERY = '(display-mode: standalone)';

/**
 * Läuft die Seite als installierte App? Zwei Wege, weil Apple den Standard
 * nicht mitgeht: die Anzeige-Art (überall) und `navigator.standalone` (iOS).
 */
export function isStandalone(env: InstallEnv): boolean {
  try {
    if (env.matchMedia?.(STANDALONE_QUERY).matches) return true;
  } catch {
    /* matchMedia kann in einer Testumgebung fehlen - dann zählt nur iOS */
  }
  return env.navigator?.standalone === true;
}

/**
 * iPhone oder iPad?
 *
 * ⚠ Ein iPad ab iPadOS 13 meldet sich als „Macintosh" - es ist NUR über die
 * Zahl der Berührungspunkte von einem echten Mac zu unterscheiden. Ohne diesen
 * zweiten Zweig bekäme genau das Gerät, das die Anleitung am dringendsten
 * braucht, den Satz „dieser Browser bietet es nicht an".
 */
export function isIos(env: InstallEnv): boolean {
  const nav = env.navigator ?? {};
  const ua = nav.userAgent ?? '';
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  const touch = nav.maxTouchPoints ?? 0;
  const macish = nav.platform === 'MacIntel' || /Macintosh/.test(ua);
  return macish && touch > 1;
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

/** Überschrift der Gruppe auf der Einstellungs-Seite. */
export const APP_GROUP_LABEL = 'Als App auf dem Handy';

/** Der eine erklärende Satz unter der Überschrift. */
export const APP_GROUP_EXPLAIN =
  'VoltPilot lässt sich wie eine App auf den Startbildschirm legen - mit eigenem Symbol und im Vollbild, ohne Browser-Leiste.';

export interface InstallView {
  state: InstallState;
  /** Der Satz, der immer steht. */
  text: string;
  /** Beschriftung des Knopfes - nur, wo er wirklich etwas bewirkt. */
  action: string | null;
  /** Die Anleitung; leer, wo es keine gibt. */
  steps: string[];
  /** Ein ruhiger Zusatz (Weg, Folge, Einschränkung). */
  hint: string | null;
}

/**
 * Die Fläche zu einem Zustand.
 *
 * `outcome` ist das Ergebnis des LETZTEN Klicks. Es gibt dafür bewusst keinen
 * fünften Zustand: ein abgebrochener Dialog verbraucht das Angebot des Browsers
 * (er lässt sich kein zweites Mal öffnen), der Zustand ist danach also
 * wahrheitsgemäß `nicht-verfuegbar` - nur der GRUND ist ein anderer, und genau
 * den nennt der Zusatz.
 */
export function installView(state: InstallState, outcome?: InstallOutcome): InstallView {
  if (state === 'installiert') {
    return {
      state,
      text: 'Sie nutzen VoltPilot bereits als App.',
      action: null,
      steps: [],
      hint: null,
    };
  }
  if (state === 'installierbar') {
    return {
      state,
      text: 'Ein Tipp genügt - danach liegt VoltPilot mit eigenem Symbol auf Ihrem Startbildschirm.',
      action: 'App installieren',
      steps: [],
      hint: 'Sie können die App jederzeit wieder entfernen wie jede andere auch.',
    };
  }
  if (state === 'ios-anleitung') {
    return {
      state,
      text: 'Auf dem iPhone und iPad legen Sie VoltPilot über das Teilen-Menü ab:',
      action: null,
      steps: [
        'Tippen Sie unten in der Browser-Leiste auf das Teilen-Symbol.',
        'Wählen Sie „Zum Home-Bildschirm".',
      ],
      hint: 'Danach startet VoltPilot im Vollbild, ganz ohne Browser-Leiste.',
    };
  }
  return {
    state,
    text:
      outcome === 'abgelehnt'
        ? 'Sie haben das Einrichten abgebrochen.'
        : 'Dieser Browser bietet das Einrichten hier nicht an.',
    action: null,
    steps: [],
    hint:
      outcome === 'abgelehnt'
        ? 'Über das Menü Ihres Browsers geht es weiterhin - dort heißt der Eintrag meist „App installieren" oder „Zum Startbildschirm hinzufügen".'
        : 'Öffnen Sie VoltPilot am Handy in Chrome (Android) oder Safari (iPhone) - dort lässt es sich einrichten.',
  };
}

/* -------------------------------------------------------------------------- */
/* Der Speicher (kein React)                                                   */
/* -------------------------------------------------------------------------- */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let env: InstallEnv | null = null;
let deferred: BeforeInstallPromptEvent | null = null;
let installedSeen = false;
let lastOutcome: InstallOutcome | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

/**
 * Hängt die Zuhörer ein - so FRÜH wie möglich (aus `main.tsx`), denn
 * `beforeinstallprompt` feuert kurz nach dem Laden und wird nicht wiederholt.
 * Wer erst beim Öffnen der Einstellungs-Seite zuhört, hat es verpasst.
 */
export function initInstallApp(w: InstallEnv): () => void {
  env = w;
  const onPrompt = (e: Event) => {
    // Ohne das der Browser seinen eigenen Streifen zeigt; wir wollen den Knopf
    // an der Stelle, an der er erklärt wird.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    lastOutcome = undefined;
    notify();
  };
  const onInstalled = () => {
    installedSeen = true;
    deferred = null;
    notify();
  };
  w.addEventListener('beforeinstallprompt', onPrompt);
  w.addEventListener('appinstalled', onInstalled);

  let mql: MediaQueryLike | undefined;
  const onDisplayChange = () => notify();
  try {
    mql = w.matchMedia?.(STANDALONE_QUERY);
    mql?.addEventListener?.('change', onDisplayChange);
  } catch {
    /* ohne matchMedia entfällt nur die Live-Aktualisierung */
  }

  return () => {
    w.removeEventListener('beforeinstallprompt', onPrompt);
    w.removeEventListener('appinstalled', onInstalled);
    mql?.removeEventListener?.('change', onDisplayChange);
    if (env === w) env = null;
  };
}

/** Nur für Tests: vergisst alles Eingefangene. */
export function resetInstallApp(): void {
  env = null;
  deferred = null;
  installedSeen = false;
  lastOutcome = undefined;
  listeners.clear();
}

export function subscribeInstallApp(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Der aktuelle Zustand. Primitiv, also für `useSyncExternalStore` stabil. */
export function installSnapshot(): InstallState {
  if (!env) return 'nicht-verfuegbar';
  return installState({
    promptReady: deferred != null,
    standalone: installedSeen || isStandalone(env),
    ios: isIos(env),
  });
}

/** Das Ergebnis des letzten Klicks (für den ehrlichen Zusatz). */
export function lastInstallOutcome(): InstallOutcome | undefined {
  return lastOutcome;
}

/**
 * Öffnet den Einrichten-Dialog des Browsers.
 *
 * ⚠ Das eingefangene Angebot ist EINMALIG - `prompt()` ein zweites Mal zu rufen
 * wirft. Es wird deshalb in jedem Fall verworfen, auch bei Abbruch; der Zustand
 * fällt danach ehrlich auf `nicht-verfuegbar` mit dem passenden Grund zurück.
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const evt = deferred;
  if (!evt) {
    lastOutcome = 'nicht-moeglich';
    notify();
    return 'nicht-moeglich';
  }
  deferred = null;
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    lastOutcome = outcome === 'accepted' ? 'installiert' : 'abgelehnt';
  } catch {
    lastOutcome = 'nicht-moeglich';
  }
  notify();
  return lastOutcome;
}
