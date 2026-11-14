import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('./auth', () => ({
  freshToken: () => Promise.resolve('tok'),
  AuthRedirectError: class AuthRedirectError extends Error {},
}));

import { STARTFENSTER_MS, type Site } from './api';
import { anlageGrundAbrufe, cockpitAbrufe, seitendatenVorab } from './seitenVorab';
import { useAnlageSurface } from './useAnlageSurface';
import { useAdaptiveLive } from './useAdaptiveLive';

/**
 * Der Wächter der Vorab-Abrufe (`seitenVorab.ts`, Performance-Runde vp-perf2-portal, Idee 2): ein Vorab-Abruf, den
 * die Seite nicht selbst stellt, wäre eine vergeudete Serveranfrage bei jedem Start. Hier: die Grundabrufe jeder
 * Anlagen-Route gegen die echten Hooks der Schale (`useAnlageSurface`, `useAdaptiveLive`), auf Adress-Ebene.
 * Die Cockpit-Abrufe prüft `AnlagenPage.test.tsx` gegen die gerenderte `AnlageSeite`.
 */
const site: Site = {
  id: 's-1',
  name: 'Hof Lindenberg',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: true,
  maxFeedInKw: null,
};

let adressen: string[];
beforeEach(() => {
  adressen = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    adressen.push(String(url).replace(/^https?:\/\/[^/]+/, ''));
    return Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(null), text: () => Promise.resolve('') } as Response);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ruhen = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('seitenVorab: nur, was die Seite selbst fragt', () => {
  it('die Grundabrufe stellen Schale und Seite selbst (useAnlageSurface), die Topologie das Cockpit (useAdaptiveLive)', async () => {
    seitendatenVorab('#/anlage/s-1');
    await ruhen(10);
    const vorab = new Set(adressen);
    expect(vorab.size).toBe(anlageGrundAbrufe('s-1').length + cockpitAbrufe('s-1').length);
    // Das Startfenster abwarten: danach fragen die Hooks wirklich selbst, und jede ihrer Adressen landet im Netz.
    await ruhen(STARTFENSTER_MS + 50);
    adressen = [];
    const schale = renderHook(() => useAnlageSurface(site));
    const live = renderHook(() => useAdaptiveLive('s-1'));
    await ruhen(30);
    const hooks = new Set(adressen);
    schale.unmount();
    live.unmount();
    adressen = [];
    seitendatenVorab('#/anlage/s-1/modell');
    await ruhen(10);
    // Jede Grundadresse (Unterseite) fragen die Hooks selbst …
    expect([...new Set(adressen)].filter((a) => !hooks.has(a))).toEqual([]);
    // … und die Topologie gehört zum Cockpit.
    expect(hooks.has('/api/v1/sites/s-1/topology')).toBe(true);
    expect(vorab.has('/api/v1/sites/s-1/topology')).toBe(true);
  }, 10_000);
});
