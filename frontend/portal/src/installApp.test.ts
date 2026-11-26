import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initInstallApp,
  installIosContext,
  installSnapshot,
  installState,
  installView,
  isAndroidChromium,
  isIos,
  isIPad,
  isNonSafariIosBrowser,
  isStandalone,
  lastInstallOutcome,
  promptInstall,
  resetInstallApp,
  subscribeInstallApp,
  type InstallEnv,
  type InstallStep,
  type InstallStepIcon,
} from './installApp';

/** Ein `window`-Stellvertreter mit genau dem, was `installApp` liest. */
function fakeEnv(opts: {
  standalone?: boolean;
  iosStandalone?: boolean;
  ua?: string;
  maxTouchPoints?: number;
  platform?: string;
  noMatchMedia?: boolean;
} = {}) {
  const handlers = new Map<string, Array<(e: Event) => void>>();
  const mqlListeners: Array<() => void> = [];
  const mql = {
    matches: opts.standalone === true,
    addEventListener: (_t: 'change', cb: () => void) => void mqlListeners.push(cb),
    removeEventListener: (_t: 'change', cb: () => void) => {
      const i = mqlListeners.indexOf(cb);
      if (i >= 0) mqlListeners.splice(i, 1);
    },
  };
  const env: InstallEnv & {
    fire(type: string, e?: Partial<Event>): void;
    handlerCount(type: string): number;
    mql: typeof mql;
    mqlListeners: typeof mqlListeners;
  } = {
    addEventListener(type, cb) {
      const list = handlers.get(type) ?? [];
      list.push(cb);
      handlers.set(type, list);
    },
    removeEventListener(type, cb) {
      const list = handlers.get(type) ?? [];
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    },
    matchMedia: opts.noMatchMedia ? undefined : () => mql,
    navigator: {
      userAgent: opts.ua ?? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/151',
      maxTouchPoints: opts.maxTouchPoints ?? 0,
      platform: opts.platform,
      standalone: opts.iosStandalone,
    },
    fire(type, e) {
      for (const cb of handlers.get(type) ?? []) cb({ ...e, type } as Event);
    },
    handlerCount: (type) => (handlers.get(type) ?? []).length,
    mql,
    mqlListeners,
  };
  return env;
}

/** Ein `beforeinstallprompt`, wie Chrome es schickt. */
function promptEvent(outcome: 'accepted' | 'dismissed' | 'throws' = 'accepted') {
  const preventDefault = vi.fn();
  return {
    preventDefault,
    prompt: vi.fn(() =>
      outcome === 'throws' ? Promise.reject(new Error('nope')) : Promise.resolve(),
    ),
    userChoice: Promise.resolve({ outcome: outcome === 'throws' ? 'dismissed' : outcome }),
  } as unknown as Event;
}

beforeEach(() => resetInstallApp());

/** Die Fakten mit allem auf „nein", außer dem, was ein Fall explizit setzt. */
function facts(partial: Partial<Parameters<typeof installState>[0]> = {}) {
  return { promptReady: false, standalone: false, ios: false, androidChromium: false, ...partial };
}

describe('installState: fünf Situationen, fünf Antworten', () => {
  it('läuft die App schon, gibt es NIE eine Anleitung - auch nicht neben einem Angebot', () => {
    expect(installState(facts({ promptReady: true, standalone: true, ios: true }))).toBe(
      'installiert',
    );
    expect(installState(facts({ standalone: true }))).toBe('installiert');
  });

  it('ein eingefangenes Angebot des Browsers ist der Knopf', () => {
    expect(installState(facts({ promptReady: true }))).toBe('installierbar');
  });

  it('auf dem iPhone gibt es keinen Dialog, also die Anleitung', () => {
    expect(installState(facts({ ios: true }))).toBe('ios-anleitung');
  });

  it('Chrome/Chromium auf Android bekommt den Menü-Weg, nie die Falschbehauptung', () => {
    expect(installState(facts({ androidChromium: true }))).toBe('android-anleitung');
  });

  it('ohne Beleg und ohne Android-Chromium wird nichts versprochen', () => {
    expect(installState(facts())).toBe('nicht-verfuegbar');
  });
});

describe('isStandalone', () => {
  it('erkennt die Anzeige-Art', () => {
    expect(isStandalone(fakeEnv({ standalone: true }))).toBe(true);
    expect(isStandalone(fakeEnv())).toBe(false);
  });

  it('erkennt Apples eigenen Marker, auch ohne matchMedia', () => {
    expect(isStandalone(fakeEnv({ noMatchMedia: true, iosStandalone: true }))).toBe(true);
    expect(isStandalone(fakeEnv({ noMatchMedia: true }))).toBe(false);
  });
});

describe('isIos', () => {
  it('erkennt iPhone und iPad an ihrer Kennung', () => {
    expect(isIos(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)' }))).toBe(true);
    expect(isIos(fakeEnv({ ua: 'Mozilla/5.0 (iPad; CPU OS 16_0)' }))).toBe(true);
  });

  it('erkennt ein iPadOS-Gerät, das sich als Macintosh meldet', () => {
    // Genau das Gerät, das die Anleitung am dringendsten braucht.
    expect(
      isIos(
        fakeEnv({
          ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari',
          platform: 'MacIntel',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(true);
  });

  it('hält einen echten Mac und ein Android auseinander', () => {
    expect(
      isIos(
        fakeEnv({
          ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/151',
          platform: 'MacIntel',
          maxTouchPoints: 0,
        }),
      ),
    ).toBe(false);
    expect(isIos(fakeEnv({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/151' }))).toBe(false);
  });
});

describe('isIPad', () => {
  it('erkennt ein iPad an seiner Kennung', () => {
    expect(isIPad(fakeEnv({ ua: 'Mozilla/5.0 (iPad; CPU OS 16_0)' }))).toBe(true);
  });

  it('erkennt ein iPadOS-Gerät, das sich als Macintosh meldet - dasselbe wie bei isIos', () => {
    expect(
      isIPad(
        fakeEnv({
          ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.5 Safari',
          platform: 'MacIntel',
          maxTouchPoints: 5,
        }),
      ),
    ).toBe(true);
  });

  it('ein iPhone ist KEIN iPad - es braucht die andere Lage des Teilen-Symbols', () => {
    expect(isIPad(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5)' }))).toBe(false);
  });
});

describe('isNonSafariIosBrowser', () => {
  it('erkennt Chrome auf iOS an "CriOS/" - Teilen sitzt dort oben, nicht unten', () => {
    expect(
      isNonSafariIosBrowser(
        fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) CriOS/120.0 Mobile Safari' }),
      ),
    ).toBe(true);
  });

  it('erkennt Firefox und Edge auf iOS ebenso', () => {
    expect(
      isNonSafariIosBrowser(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) FxiOS/120.0' })),
    ).toBe(true);
    expect(
      isNonSafariIosBrowser(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) EdgiOS/120.0' })),
    ).toBe(true);
  });

  it('echtes Safari ist KEIN fremder Browser', () => {
    expect(
      isNonSafariIosBrowser(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari/604.1' })),
    ).toBe(false);
  });

  it('Chrome auf Android ist kein "fremder Browser auf iOS" - andere Frage, anderer Zustand', () => {
    expect(
      isNonSafariIosBrowser(fakeEnv({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/151' })),
    ).toBe(false);
  });
});

describe('installIosContext', () => {
  it('ist `null` außerhalb von iOS und ohne eingehängte Umgebung', () => {
    expect(installIosContext()).toBeNull();
    initInstallApp(fakeEnv({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/151' }));
    expect(installIosContext()).toBeNull();
  });

  it('meldet iPad und fremden Browser getrennt', () => {
    initInstallApp(fakeEnv({ ua: 'Mozilla/5.0 (iPad; CPU OS 16_0) CriOS/120.0' }));
    expect(installIosContext()).toEqual({ ipad: true, fremderBrowser: true });
  });

  it('Safari auf dem iPhone: beides falsch', () => {
    initInstallApp(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari/604.1' }));
    expect(installIosContext()).toEqual({ ipad: false, fremderBrowser: false });
  });
});

describe('isAndroidChromium', () => {
  it('erkennt Chrome, Edge, Samsung Internet und Opera auf Android', () => {
    expect(
      isAndroidChromium(fakeEnv({ ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/151' })),
    ).toBe(true);
    expect(
      isAndroidChromium(
        fakeEnv({ ua: 'Mozilla/5.0 (Linux; Android 13) Chrome/120.0 EdgA/120.0' }),
      ),
    ).toBe(true);
    expect(
      isAndroidChromium(
        fakeEnv({
          ua: 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 SamsungBrowser/21.0 Chrome/110.0',
        }),
      ),
    ).toBe(true);
  });

  it('hält einen Android-Browser ohne Chromium-Unterbau auseinander - er bekommt die alte Anleitung zu Recht', () => {
    expect(
      isAndroidChromium(
        fakeEnv({ ua: 'Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/118.0 Firefox/118.0' }),
      ),
    ).toBe(false);
  });

  it('hält Chrome auf dem Rechner und das iPhone auseinander', () => {
    expect(
      isAndroidChromium(fakeEnv({ ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/151' })),
    ).toBe(false);
    expect(
      isAndroidChromium(fakeEnv({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari' })),
    ).toBe(false);
  });

  it('eine eingebettete Ansicht (In-App-Browser) hat kein Menü - dort bleibt die alte Anleitung richtig', () => {
    expect(
      isAndroidChromium(
        fakeEnv({
          ua: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
        }),
      ),
    ).toBe(false);
    expect(
      isAndroidChromium(
        fakeEnv({
          ua: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Instagram 300.0.0.0',
        }),
      ),
    ).toBe(false);
  });
});

/** Alle Text-Stücke eines Schritts aneinandergereiht - zum Prüfen des GANZEN Satzes. */
function stepText(step: InstallStep): string {
  return step.parts.map((p) => ('text' in p ? p.text : '')).join('');
}

/** Alle Symbole eines Schritts in Lesereihenfolge - zum Prüfen, WELCHE Icons er zeigt. */
function stepIcons(step: InstallStep): InstallStepIcon[] {
  return step.parts.flatMap((p) => ('icon' in p ? [p.icon] : []));
}

describe('installView: Kundencopy, kein Fachwort', () => {
  const all = (
    ['installiert', 'installierbar', 'ios-anleitung', 'android-anleitung', 'nicht-verfuegbar'] as const
  ).map((s) => installView(s));

  it('sagt „App" und nie PWA/Manifest/Service Worker', () => {
    const text = all
      .flatMap((v) => [v.text, v.hint ?? '', v.action ?? '', ...v.steps.map(stepText)])
      .join(' ');
    expect(text).not.toMatch(/PWA|Manifest|Service.?Worker|Web.?App/i);
    expect(text).toMatch(/App/);
  });

  it('zeigt nie ein Unicode-Symbol anstelle eines echten Icons (Haus-Regel aus Icon.jsx)', () => {
    const text = all.flatMap((v) => v.steps.map(stepText)).join(' ');
    expect(text).not.toMatch(/⋮|⋯|•••/);
  });

  it('schließt eine Anführung immer mit dem typografischen Zeichen „…“, nie mit dem geraden "', () => {
    const text = all
      .flatMap((v) => [v.text, v.hint ?? '', ...v.steps.map(stepText)])
      .join('\n');
    expect(text).not.toContain('"');
  });

  it('bietet einen Knopf NUR, wo er wirklich etwas bewirkt', () => {
    expect(installView('installierbar').action).toBe('App installieren');
    expect(installView('installiert').action).toBeNull();
    expect(installView('ios-anleitung').action).toBeNull();
    expect(installView('android-anleitung').action).toBeNull();
    expect(installView('nicht-verfuegbar').action).toBeNull();
  });

  it('zeigt der installierten App KEINEN Hinweis mehr, nur einen ruhigen Satz', () => {
    const v = installView('installiert');
    expect(v.steps).toEqual([]);
    expect(v.hint).toBeNull();
    expect(v.text).toMatch(/bereits als App/);
  });

  it('führt ohne bekanntes Gerät/Browser durch das Teilen-Menü - ehrlich uneindeutig statt falsch spezifisch', () => {
    const v = installView('ios-anleitung');
    expect(v.steps).toHaveLength(2);
    expect(stepText(v.steps[0])).toMatch(/Teilen/);
    expect(stepIcons(v.steps[0])).toContain('share');
    // Ohne zu wissen, welche Safari-Leiste der Kunde hat, nennt die Anleitung NIE nur eine
    // Lage - sie zeigt beide Symbole (Menü UND Teilen) statt einer falschen Festlegung.
    expect(stepIcons(v.steps[0])).toContain('more-horizontal');
    expect(stepText(v.steps[1])).toMatch(/Home-Bildschirm/);
  });

  it('auf dem iPad sitzt das Teilen-Symbol oben - eine einzige, eindeutige Lage', () => {
    const v = installView('ios-anleitung', undefined, { ipad: true, fremderBrowser: false });
    expect(stepText(v.steps[0])).toMatch(/oben/);
    expect(stepIcons(v.steps[0])).toEqual(['share']);
    expect(v.hint).toMatch(/wie eine App statt nur als Lesezeichen/);
  });

  it('in Chrome/Edge/Firefox auf iOS sitzt Teilen oben an der Adressleiste, nicht unten', () => {
    const v = installView('ios-anleitung', undefined, { ipad: false, fremderBrowser: true });
    expect(stepText(v.steps[0])).toMatch(/Adressleiste/);
    expect(stepIcons(v.steps[0])).toEqual(['share']);
    // Der iOS-26-Schalter ist eine Safari-eigene Fläche - in einem fremden Browser würde die
    // Erwähnung etwas behaupten, das dort gar nicht existiert.
    expect(v.hint).not.toMatch(/Lesezeichen/);
  });

  it('nennt ohne Angebot und ohne Android-Chromium den GRUND und den Weg, nie nur Leere', () => {
    const v = installView('nicht-verfuegbar');
    expect(v.text).toMatch(/bietet das Einrichten hier nicht an/);
    expect(v.hint).toMatch(/Chrome|Safari/);
  });

  it('nennt auf Chrome/Chromium ohne Angebot den Browser-Menü-Weg, NIE die Behauptung "bietet es nicht an"', () => {
    const v = installView('android-anleitung');
    expect(v.text).not.toMatch(/bietet das Einrichten hier nicht an/);
    expect(v.steps).toHaveLength(2);
    expect(stepIcons(v.steps[0])).toEqual(['more-vertical']);
    expect(stepText(v.steps[1])).toMatch(/App installieren|Startbildschirm/);
  });

  it('nach einem Abbruch steht dort der ANDERE Grund - kein eigener Zustand', () => {
    const v = installView('nicht-verfuegbar', 'abgelehnt');
    expect(v.state).toBe('nicht-verfuegbar');
    expect(v.text).toMatch(/abgebrochen/);
    expect(v.hint).toMatch(/Menü Ihres Browsers/);
  });
});

describe('der Speicher', () => {
  it('fängt das Angebot ein, unterdrückt den Browser-Streifen und meldet es', () => {
    const env = fakeEnv();
    initInstallApp(env);
    const seen = vi.fn();
    subscribeInstallApp(seen);
    expect(installSnapshot()).toBe('nicht-verfuegbar');

    const evt = promptEvent();
    env.fire('beforeinstallprompt', evt);

    expect((evt as unknown as { preventDefault: () => void }).preventDefault).toHaveBeenCalled();
    expect(installSnapshot()).toBe('installierbar');
    expect(seen).toHaveBeenCalled();
  });

  it('ohne eingehängte Umgebung wird nichts behauptet', () => {
    expect(installSnapshot()).toBe('nicht-verfuegbar');
  });

  it('`appinstalled` schaltet auf „installiert" und verwirft das Angebot', () => {
    const env = fakeEnv();
    initInstallApp(env);
    env.fire('beforeinstallprompt', promptEvent());
    env.fire('appinstalled');
    expect(installSnapshot()).toBe('installiert');
  });

  it('eine angenommene Einrichtung wird gemeldet', async () => {
    const env = fakeEnv();
    initInstallApp(env);
    env.fire('beforeinstallprompt', promptEvent('accepted'));
    await expect(promptInstall()).resolves.toBe('installiert');
    expect(lastInstallOutcome()).toBe('installiert');
  });

  it('ein Abbruch verbraucht das Angebot - der Zustand ist danach ehrlich', async () => {
    const env = fakeEnv();
    initInstallApp(env);
    env.fire('beforeinstallprompt', promptEvent('dismissed'));
    await expect(promptInstall()).resolves.toBe('abgelehnt');
    expect(installSnapshot()).toBe('nicht-verfuegbar');
    expect(installView(installSnapshot(), lastInstallOutcome()).text).toMatch(/abgebrochen/);
  });

  it('ein geworfener Dialog ist „nicht möglich", nie ein stiller Erfolg', async () => {
    const env = fakeEnv();
    initInstallApp(env);
    env.fire('beforeinstallprompt', promptEvent('throws'));
    await expect(promptInstall()).resolves.toBe('nicht-moeglich');
  });

  it('ohne Angebot bewirkt der Aufruf nichts', async () => {
    initInstallApp(fakeEnv());
    await expect(promptInstall()).resolves.toBe('nicht-moeglich');
  });

  it('meldet eine gewechselte Anzeige-Art', () => {
    const env = fakeEnv();
    initInstallApp(env);
    const seen = vi.fn();
    subscribeInstallApp(seen);
    env.mql.matches = true;
    env.mqlListeners.forEach((cb) => cb());
    expect(seen).toHaveBeenCalled();
    expect(installSnapshot()).toBe('installiert');
  });

  it('räumt alle Zuhörer wieder ab', () => {
    const env = fakeEnv();
    const stop = initInstallApp(env);
    expect(env.handlerCount('beforeinstallprompt')).toBe(1);
    expect(env.mqlListeners).toHaveLength(1);
    stop();
    expect(env.handlerCount('beforeinstallprompt')).toBe(0);
    expect(env.handlerCount('appinstalled')).toBe(0);
    expect(env.mqlListeners).toHaveLength(0);
  });
});
