/**
 * „Als App auf dem Handy" - die Regeln und die Copy der Einrichten-Fläche.
 *
 * Das Portal ist mobil fertig; was fehlte, war die Hülle: Manifest, Icons,
 * Vollbild. Diese Datei entscheidet ausschließlich, WAS der Kunde darüber liest
 * und ob es überhaupt etwas zu tun gibt - sie rendert nichts und ruft nichts
 * auf, was ein Gerät verändert.
 *
 * Fünf Zustände, weil es fünf verschiedene Situationen sind:
 *  - `installiert`   - läuft bereits als App. Dann gibt es KEINEN Hinweis mehr,
 *                      nur einen ruhigen Satz (nie eine Aufforderung zu etwas,
 *                      das schon geschehen ist).
 *  - `installierbar` - der Browser hat uns seinen Einrichten-Dialog angeboten
 *                      (Chrome/Edge, Android wie Rechner). Ein echter Knopf.
 *  - `ios-anleitung` - iPhone/iPad. Apple bietet KEINEN Dialog an, also ist die
 *                      Anleitung der einzige ehrliche Weg - WELCHE Schritte, hängt vom Gerät
 *                      (iPhone/iPad) und Browser (Safari/fremd) ab, siehe `IosContext`.
 *  - `android-anleitung` - ein Chrome/Chromium-Browser auf Android, der das
 *                      Einrichten GRUNDSÄTZLICH kann, es diesem Gerät aber noch
 *                      nicht angeboten hat (Chrome entscheidet das selbst, u.a.
 *                      nach bisheriger Nutzung). Es wäre eine falsche Behauptung,
 *                      "dieser Browser bietet das Einrichten nicht an" zu sagen,
 *                      wenn der Kunde GENAU in diesem Browser sitzt - darum der
 *                      Weg über das Browser-Menü statt eines toten Knopfes.
 *  - `nicht-verfuegbar` - dieser Browser sagt nichts an UND ist keiner, der es
 *                      grundsätzlich könnte. Dann steht dort der GRUND und der
 *                      Weg, nie ein Knopf, der nichts bewirkt (die `applyView`-
 *                      Regel des Hauses).
 *
 * DIE EHRLICHKEITSREGEL dieser Fläche: es wird nichts behauptet, was der
 * Browser nicht gesagt hat. `beforeinstallprompt` ist der EINZIGE Beleg dafür,
 * dass ein Knopf etwas bewirken kann - eine Prüfung „ist das Manifest da?"
 * verspräche eine Einrichtung, die der Browser danach verweigert. Dieselbe
 * Regel gilt umgekehrt für den Text: "dieser Browser bietet es nicht an" ist
 * nur wahr, wenn es wirklich KEIN Chrome/Chromium auf Android ist - sonst sitzt
 * der Kunde im selben Satz im Browser, der angeblich nicht geht.
 */

/** Der Zustand der Einrichtung auf DIESEM Gerät. */
export type InstallState =
  | 'installiert'
  | 'installierbar'
  | 'ios-anleitung'
  | 'android-anleitung'
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
  /** Chrome/Chromium auf Android - kann grundsätzlich einrichten, auch ohne Angebot. */
  androidChromium: boolean;
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
  if (facts.androidChromium) return 'android-anleitung';
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

/**
 * iPad statt iPhone/iPod - auch dann, wenn es sich als „Macintosh" meldet (s.o.). Wichtig für
 * die Anleitung: das iPad hatte seine Werkzeugleiste mit dem Teilen-Symbol schon immer OBEN,
 * nie eine wählbare „kompakte" Leiste, die es wie beim iPhone verstecken könnte - iPadOS 26
 * hatte die Kompakt-Wahl zum Start gar nicht erst im Angebot (Quelle: MacRumors/9to5Mac zu
 * iPadOS 26, siehe PR-Beschreibung).
 */
export function isIPad(env: InstallEnv): boolean {
  const nav = env.navigator ?? {};
  const ua = nav.userAgent ?? '';
  if (/iPad/.test(ua)) return true;
  const touch = nav.maxTouchPoints ?? 0;
  const macish = nav.platform === 'MacIntel' || /Macintosh/.test(ua);
  return macish && touch > 1;
}

/**
 * Chrome oder ein verwandter fremder Browser auf iOS (Kennungen "CriOS/", "FxiOS/", "EdgiOS/",
 * "OPiOS/" - Apple zwingt sie auf WebKit, aber sie zeichnen ihre eigene Oberfläche). Dort sitzt
 * das Teilen-Symbol oben an der Adressleiste, nicht unten in einer Browser-Leiste wie bei
 * Safari - belegt für Chrome (browserstack.com-Anleitung, siehe PR-Beschreibung). Safaris
 * eigene, vom Kunden wählbare Leisten-Varianten (unten/oben/„Kompakt" seit iOS 26) gelten hier
 * NICHT - dort ist die Lage, anders als bei Chrome, nicht aus der UA ablesbar.
 */
export function isNonSafariIosBrowser(env: InstallEnv): boolean {
  return /CriOS\/|FxiOS\/|EdgiOS\/|OPiOS\//.test(env.navigator?.userAgent ?? '');
}

/** Was die iPhone/iPad-Anleitung zusätzlich zum bloßen `ios-anleitung`-Zustand wissen muss. */
export interface IosContext {
  /** iPad statt iPhone - andere Lage des Teilen-Symbols (siehe `isIPad`). */
  ipad: boolean;
  /** Chrome o.ä. statt Safari - andere Lage UND kein Safari-spezifischer Web-App-Schalter. */
  fremderBrowser: boolean;
}

/**
 * Marker eingebetteter Ansichten (In-App-Browser anderer Apps). Deren UA
 * trägt oft trotzdem "Chrome/", aber sie haben weder ein Browser-Menü noch
 * eine Adressleiste - der Weg "Menü > App installieren" wäre dort eine
 * zweite falsche Behauptung.
 */
const EINGEBETTETE_ANSICHT = /; ?wv\)|FBAN|FBAV|Instagram|Line\/|MicroMessenger|TikTok/;

/**
 * Chrome/Chromium auf Android (Chrome, Edge, Samsung Internet, Opera - alle
 * Chromium-Ableger tragen "Chrome/" in ihrer UA). Diese Browser KÖNNEN
 * grundsätzlich einrichten, auch wenn sie es diesem Gerät gerade nicht
 * anbieten - anders als ein wirklich fremder Browser (Firefox, ein
 * eingebetteter In-App-Browser).
 */
export function isAndroidChromium(env: InstallEnv): boolean {
  const ua = env.navigator?.userAgent ?? '';
  if (!/Android/.test(ua)) return false;
  if (!/Chrome\//.test(ua)) return false;
  return !EINGEBETTETE_ANSICHT.test(ua);
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

/** Überschrift der Gruppe auf der Einstellungs-Seite. */
export const APP_GROUP_LABEL = 'Als App auf dem Handy';

/** Der eine erklärende Satz unter der Überschrift. */
export const APP_GROUP_EXPLAIN =
  'VoltPilot lässt sich wie eine App auf den Startbildschirm legen - mit eigenem Symbol und im Vollbild, ohne Browser-Leiste.';

/** Eines der echten Symbole, die der Kunde auf seinem Schirm wiederfinden soll - nie ein Unicode-Zeichen. */
export type InstallStepIcon = 'share' | 'more-vertical' | 'more-horizontal';

/**
 * Ein Stück eines Anleitungssatzes: entweder Text oder genau das Symbol, das an dieser Stelle
 * im Satz gemeint ist - „tippen Sie auf [Symbol] Teilen", nicht ein Symbol VOR dem ganzen Satz.
 * So liest der Kunde Satz und Symbol in einem Zug, in der Reihenfolge, in der er sie auf dem
 * Schirm sucht (Rückmeldung zur ersten Fassung: Symbole standen klein vor dem Satz statt genau
 * dort, wo sie genannt werden).
 */
export type InstallStepPart = { text: string } | { icon: InstallStepIcon };

/** Ein einzelner Anleitungsschritt, aus Text- und Symbol-Stücken in Lesereihenfolge zusammengesetzt. */
export interface InstallStep {
  parts: InstallStepPart[];
}

export interface InstallView {
  state: InstallState;
  /** Der Satz, der immer steht. */
  text: string;
  /** Beschriftung des Knopfes - nur, wo er wirklich etwas bewirkt. */
  action: string | null;
  /** Die Anleitung; leer, wo es keine gibt. */
  steps: InstallStep[];
  /** Ein ruhiger Zusatz (Weg, Folge, Einschränkung). */
  hint: string | null;
}

/**
 * Die Fläche zu einem Zustand.
 *
 * `outcome` ist das Ergebnis des LETZTEN Klicks. Es gibt dafür bewusst KEINEN
 * eigenen Zustand: ein abgebrochener Dialog verbraucht das Angebot des Browsers
 * (er lässt sich kein zweites Mal öffnen), der Zustand ist danach also
 * wahrheitsgemäß `nicht-verfuegbar` - nur der GRUND ist ein anderer, und genau
 * den nennt der Zusatz.
 *
 * `ios` gilt NUR für `ios-anleitung`: Apple bietet dort nie einen Dialog, aber WO das
 * Teilen-Symbol sitzt, hängt vom Gerät (iPhone/iPad) und Browser (Safari/fremd) ab - ohne
 * diese Unterscheidung behauptete die Anleitung pauschal „unten in der Browser-Leiste", was
 * auf dem iPad und in Chrome schlicht falsch ist (derselbe Fehler wie beim Android-Fall).
 */
export function installView(
  state: InstallState,
  outcome?: InstallOutcome,
  ios?: IosContext,
): InstallView {
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
    const fremderBrowser = ios?.fremderBrowser === true;
    const teilenSchritt: InstallStep = ios?.ipad
      ? { parts: [{ text: 'Tippen Sie oben auf ' }, { icon: 'share' }, { text: ' Teilen.' }] }
      : fremderBrowser
        ? {
            parts: [
              { text: 'Tippen Sie oben neben der Adressleiste auf ' },
              { icon: 'share' },
              { text: ' Teilen.' },
            ],
          }
        : {
            parts: [
              { text: 'Tippen Sie unten auf ' },
              { icon: 'share' },
              { text: ' Teilen. Sehen Sie nur ' },
              { icon: 'more-horizontal' },
              { text: ', tippen Sie zuerst darauf.' },
            ],
          };
    const zumHomeBildschirmSchritt: InstallStep = {
      parts: [{ text: 'Wählen Sie „Zum Home-Bildschirm“.' }],
    };
    return {
      state,
      text: 'Auf dem iPhone und iPad legen Sie VoltPilot über das Teilen-Menü ab:',
      action: null,
      steps: [teilenSchritt, zumHomeBildschirmSchritt],
      hint: fremderBrowser
        ? 'Danach startet VoltPilot im Vollbild, ganz ohne Browser-Leiste.'
        : 'Danach startet VoltPilot im Vollbild, ganz ohne Browser-Leiste. Fragt Safari dabei noch, ob die Seite wie eine App statt nur als Lesezeichen geöffnet wird, lassen Sie das eingeschaltet.',
    };
  }
  if (state === 'android-anleitung') {
    return {
      state,
      text: 'Dieser Browser hat das Einrichten hier noch nicht von sich aus angeboten.',
      action: null,
      steps: [
        { parts: [{ text: 'Tippen Sie oben rechts auf ' }, { icon: 'more-vertical' }, { text: ' Menü.' }] },
        {
          parts: [{ text: 'Wählen Sie „App installieren“ oder „Zum Startbildschirm hinzufügen“.' }],
        },
      ],
      hint: 'Taucht der Eintrag nicht auf, hilft meist ein Neuladen der Seite.',
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
        ? 'Über das Menü Ihres Browsers geht es weiterhin - dort heißt der Eintrag meist „App installieren“ oder „Zum Startbildschirm hinzufügen“.'
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
    androidChromium: isAndroidChromium(env),
  });
}

/**
 * Nur für `ios-anleitung` gebraucht (siehe `installView`) - `null` außerhalb von iOS, damit ein
 * Aufrufer nicht aus Versehen eine `IosContext` zeigt, wo sie nichts bedeutet.
 */
export function installIosContext(): IosContext | null {
  if (!env || !isIos(env)) return null;
  return { ipad: isIPad(env), fremderBrowser: isNonSafariIosBrowser(env) };
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
