import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initInstallApp,
  installSnapshot,
  installState,
  installView,
  isIos,
  isStandalone,
  lastInstallOutcome,
  promptInstall,
  resetInstallApp,
  subscribeInstallApp,
  type InstallEnv,
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

describe('installState: vier Situationen, vier Antworten', () => {
  it('läuft die App schon, gibt es NIE eine Anleitung - auch nicht neben einem Angebot', () => {
    expect(
      installState({ promptReady: true, standalone: true, ios: true }),
    ).toBe('installiert');
    expect(
      installState({ promptReady: false, standalone: true, ios: false }),
    ).toBe('installiert');
  });

  it('ein eingefangenes Angebot des Browsers ist der Knopf', () => {
    expect(installState({ promptReady: true, standalone: false, ios: false })).toBe(
      'installierbar',
    );
  });

  it('auf dem iPhone gibt es keinen Dialog, also die Anleitung', () => {
    expect(installState({ promptReady: false, standalone: false, ios: true })).toBe(
      'ios-anleitung',
    );
  });

  it('ohne Beleg wird nichts versprochen', () => {
    expect(installState({ promptReady: false, standalone: false, ios: false })).toBe(
      'nicht-verfuegbar',
    );
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

describe('installView: Kundencopy, kein Fachwort', () => {
  const all = (['installiert', 'installierbar', 'ios-anleitung', 'nicht-verfuegbar'] as const).map(
    (s) => installView(s),
  );

  it('sagt „App" und nie PWA/Manifest/Service Worker', () => {
    const text = all
      .flatMap((v) => [v.text, v.hint ?? '', v.action ?? '', ...v.steps])
      .join(' ');
    expect(text).not.toMatch(/PWA|Manifest|Service.?Worker|Web.?App/i);
    expect(text).toMatch(/App/);
  });

  it('bietet einen Knopf NUR, wo er wirklich etwas bewirkt', () => {
    expect(installView('installierbar').action).toBe('App installieren');
    expect(installView('installiert').action).toBeNull();
    expect(installView('ios-anleitung').action).toBeNull();
    expect(installView('nicht-verfuegbar').action).toBeNull();
  });

  it('zeigt der installierten App KEINEN Hinweis mehr, nur einen ruhigen Satz', () => {
    const v = installView('installiert');
    expect(v.steps).toEqual([]);
    expect(v.hint).toBeNull();
    expect(v.text).toMatch(/bereits als App/);
  });

  it('führt auf dem iPhone in zwei Schritten durch das Teilen-Menü', () => {
    const v = installView('ios-anleitung');
    expect(v.steps).toHaveLength(2);
    expect(v.steps[0]).toMatch(/Teilen/);
    expect(v.steps[1]).toMatch(/Home-Bildschirm/);
  });

  it('nennt ohne Angebot den GRUND und den Weg, nie nur Leere', () => {
    const v = installView('nicht-verfuegbar');
    expect(v.text).toMatch(/bietet das Einrichten hier nicht an/);
    expect(v.hint).toMatch(/Chrome|Safari/);
  });

  it('nach einem Abbruch steht dort der ANDERE Grund - kein fünfter Zustand', () => {
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
