import { describe, expect, it, vi } from 'vitest';

import {
  registerServiceWorker,
  SERVICE_WORKER_URL,
  shouldRegisterServiceWorker,
  shouldUnregisterServiceWorker,
  type ServiceWorkerEnv,
} from './serviceWorker';

const prod: ServiceWorkerEnv = { dev: false, supported: true, secure: true };

function fakeContainer(opts: { registrations?: Array<{ unregister: () => Promise<boolean> }> } = {}) {
  return {
    register: vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration)),
    getRegistrations: vi.fn(() => Promise.resolve(opts.registrations ?? [])),
  };
}

describe('shouldRegisterServiceWorker: drei Bedingungen, drei Gründe', () => {
  it('registriert im gebauten Portal', () => {
    expect(shouldRegisterServiceWorker(prod)).toBe(true);
  });

  it('nie im Dev-Server', () => {
    expect(shouldRegisterServiceWorker({ ...prod, dev: true })).toBe(false);
  });

  it('nie ohne Unterstützung des Browsers', () => {
    expect(shouldRegisterServiceWorker({ ...prod, supported: false })).toBe(false);
  });

  it('nie in einem unsicheren Kontext (plain HTTP im LAN)', () => {
    expect(shouldRegisterServiceWorker({ ...prod, secure: false })).toBe(false);
  });
});

describe('shouldUnregisterServiceWorker', () => {
  it('räumt einen aus `npm run preview` übrig gebliebenen Worker im Dev-Server ab', () => {
    expect(shouldUnregisterServiceWorker({ ...prod, dev: true })).toBe(true);
  });

  it('rührt im gebauten Portal nichts an', () => {
    expect(shouldUnregisterServiceWorker(prod)).toBe(false);
  });
});

describe('registerServiceWorker', () => {
  it('registriert erst NACH `load` und mit dem Wurzel-Pfad', () => {
    const container = fakeContainer();
    let run: (() => void) | null = null;
    registerServiceWorker({
      env: prod,
      container: container as unknown as ServiceWorkerContainer,
      onLoad: (r) => {
        run = r;
      },
    });
    expect(container.register).not.toHaveBeenCalled();
    run!();
    expect(container.register).toHaveBeenCalledWith(SERVICE_WORKER_URL);
  });

  it('meldet im Dev-Server ab statt an', async () => {
    const unregister = vi.fn(() => Promise.resolve(true));
    const container = fakeContainer({ registrations: [{ unregister }] });
    const onLoad = vi.fn();
    registerServiceWorker({
      env: { ...prod, dev: true },
      container: container as unknown as ServiceWorkerContainer,
      onLoad,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(unregister).toHaveBeenCalled();
    expect(container.register).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('tut ohne Unterstützung gar nichts', () => {
    const onLoad = vi.fn();
    registerServiceWorker({ env: { ...prod, supported: false }, onLoad });
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('ist bei einem Fehlschlag STUMM - die Hülle ist Komfort, kein Fehlerkanal', async () => {
    const container = fakeContainer();
    container.register.mockReturnValue(Promise.reject(new Error('kaputt')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let run: (() => void) | null = null;
    registerServiceWorker({
      env: prod,
      container: container as unknown as ServiceWorkerContainer,
      onLoad: (r) => {
        run = r;
      },
    });
    expect(() => run!()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
