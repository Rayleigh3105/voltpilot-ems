import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { request } from './api';

/** `request` wartet zuerst auf ein frisches Token - erst danach fliegt fetch. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Vorher hatte der Boot-Abruf (`/me`, `/sites`, …) keine Zeitgrenze: eine hängende Verbindung (Netz
 * weg, Proxy ohne Antwort) ließ `fetch` nie entscheiden und den Lade-Vorhang damit endlos stehen.
 *
 * Das wirkliche Verstreichen von `REQUEST_TIMEOUT_MS` in einem Test abzuwarten wäre langsam und
 * brüchig; stattdessen steht hier das Signal, das `AbortSignal.timeout(...)` sonst irgendwann selbst
 * feuert. Löst DIESES Signal aus, muss die Anfrage genauso enden wie beim echten Ablauf der
 * Zeitgrenze - das ist exakt der Mechanismus, der den endlosen Lader beendet.
 */
describe('request: Zeitgrenze gegen eine hängende Verbindung', () => {
  let zeitgrenze: AbortController;

  beforeEach(() => {
    zeitgrenze = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(zeitgrenze.signal);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('eine Verbindung, die nie antwortet, bricht beim Ablauf der Zeitgrenze ab statt endlos zu hängen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            // Wie ein echter `fetch`: er entscheidet nie von selbst, nur das Signal kann ihn beenden.
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Zeitüberschreitung', 'TimeoutError')));
          }),
      ),
    );

    const antwort = request('/api/v1/sites');
    await flush(); // fetch() erst nach dem (mock-)Token-Abruf; der Fänger muss stehen, bevor die Zeitgrenze feuert
    zeitgrenze.abort();

    await expect(antwort).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('ein eigenes Abbruch-Signal des Aufrufers bleibt unverändert wirksam - die Zeitgrenze ersetzt es nicht', async () => {
    const eigenes = new AbortController();
    let gesehenesSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            gesehenesSignal = init?.signal;
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Unmount', 'AbortError')));
          }),
      ),
    );

    const antwort = request('/api/v1/sites/x/entities', { signal: eigenes.signal });
    await flush();
    eigenes.abort();

    await expect(antwort).rejects.toMatchObject({ name: 'AbortError' });
    expect(gesehenesSignal).toBe(eigenes.signal);
  });

  it('ein schreibender Aufruf bekommt keine Zeitgrenze - ein Abbruch ließe offen, ob der Server schrieb', async () => {
    const signale: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signale.push(init?.signal);
        return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }),
    );

    await request('/api/v1/bezugsdaten/importe', { method: 'POST', body: new FormData() });
    await request('/api/v1/sites/x', { method: 'put', body: '{}' });
    await request('/api/v1/sites');

    expect(signale[0]).toBeUndefined();
    expect(signale[1]).toBeUndefined();
    expect(signale[2]).toBe(zeitgrenze.signal);
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(1);
  });
});
