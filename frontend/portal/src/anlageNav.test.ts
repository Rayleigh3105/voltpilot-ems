import { describe, expect, it } from 'vitest';
import {
  activeAreaKey,
  anlageTrio,
  DEEP_VIEW_ITEMS,
  modeNavGroup,
  resolveAnlage,
} from './anlageNav';
import { MAIN_PAGES, MODE_PAGES, type AnlagenSub } from './nav';
import type { DeepViewId } from './surface';

/** Every AnlagenSub that exists - the "nothing is orphaned" ground truth. */
const ALL_SUBS: AnlagenSub[] = [
  'live',
  'fahrplan',
  'historie',
  'wetter',
  'technik',
  'entitaeten',
  'steuerung',
  'lastspitzen',
];

describe('anlageTrio - the Anlage-scoped shell areas (M1 §2.1)', () => {
  it('is always exactly Übersicht · Steuerung · Geräte, in that order', () => {
    for (const count of [null, 0, 1, 3, 7]) {
      expect(anlageTrio(count).map((a) => a.label)).toEqual(['Übersicht', 'Steuerung', 'Geräte']);
    }
  });

  it('opens the cockpit, the Steuerung area and the Geräte area', () => {
    expect(anlageTrio(0).map((a) => a.sub)).toEqual([null, 'steuerung', 'entitaeten']);
  });

  it('badges Steuerung with the active-mode count from the M0 read-model', () => {
    expect(anlageTrio(3).find((a) => a.key === 'steuerung')?.badge).toBe(3);
    expect(anlageTrio(1).find((a) => a.key === 'steuerung')?.badge).toBe(1);
  });

  it('shows NO badge for zero/unknown modes (never a discouraging "0")', () => {
    expect(anlageTrio(0).find((a) => a.key === 'steuerung')?.badge).toBeNull();
    expect(anlageTrio(null).find((a) => a.key === 'steuerung')?.badge).toBeNull();
    expect(anlageTrio(undefined).find((a) => a.key === 'steuerung')?.badge).toBeNull();
    expect(anlageTrio(Number.NaN).find((a) => a.key === 'steuerung')?.badge).toBeNull();
  });

  it('never badges Übersicht or Geräte (Steuerung is THE key area)', () => {
    const trio = anlageTrio(4);
    expect(trio.find((a) => a.key === 'uebersicht')?.badge).toBeNull();
    expect(trio.find((a) => a.key === 'geraete')?.badge).toBeNull();
  });
});

describe('activeAreaKey', () => {
  it('maps the cockpit and the two area subs onto their trio entry', () => {
    expect(activeAreaKey(null)).toBe('uebersicht');
    expect(activeAreaKey('steuerung')).toBe('steuerung');
    expect(activeAreaKey('entitaeten')).toBe('geraete');
  });

  it('highlights NO area while a deep view is open', () => {
    for (const sub of ['live', 'fahrplan', 'historie', 'wetter', 'technik', 'lastspitzen'] as const) {
      expect(activeAreaKey(sub)).toBeNull();
    }
  });
});

describe('DEEP_VIEW_ITEMS - the interim access affordance (no orphaned view)', () => {
  it('covers EVERY AnlagenSub exactly once, together with the trio', () => {
    const trioSubs = anlageTrio(0)
      .map((a) => a.sub)
      .filter((s): s is AnlagenSub => s != null);
    const menuSubs = DEEP_VIEW_ITEMS.map((i) => i.sub);
    const reachable = [...trioSubs, ...menuSubs];
    expect(new Set(reachable).size).toBe(reachable.length); // no duplicates
    expect([...reachable].sort()).toEqual([...ALL_SUBS].sort());
  });

  it('keeps the money/plan/telemetry deep views the retired tab bar carried', () => {
    const subs = DEEP_VIEW_ITEMS.map((i) => i.sub);
    expect(subs).toContain('live');
    expect(subs).toContain('fahrplan');
    expect(subs).toContain('historie');
    expect(subs).toContain('lastspitzen');
    expect(subs).toContain('wetter');
    expect(subs).toContain('technik');
  });
});

describe('modeNavGroup - Marktpreise/Prognose are MODE views, never a global group', () => {
  const marketViews: DeepViewId[] = [
    'live',
    'telemetrie-historie',
    'fahrplan',
    'marktpreise',
    'prognosequalitaet',
  ];

  it('renders the mode-tagged group while the market mode is active', () => {
    expect(modeNavGroup(marketViews)).toEqual({
      title: 'Aus Modus: Marktvermarktung',
      pages: ['marktpreise', 'prognose'],
    });
  });

  it('is hidden for a Privat-EMS / Gewerbe site (no market mode)', () => {
    expect(modeNavGroup(['live', 'telemetrie-historie', 'lastspitzen'])).toBeNull();
    expect(modeNavGroup([])).toBeNull();
    expect(modeNavGroup(null)).toBeNull();
    expect(modeNavGroup(undefined)).toBeNull();
  });

  it('is NOT part of the global main nav any more', () => {
    expect(MAIN_PAGES.map((p) => p.id)).toEqual(['uebersicht', 'anlagen']);
    expect(MODE_PAGES.map((p) => p.id)).toEqual(['marktpreise', 'prognose']);
  });
});

describe('resolveAnlage - one resolution for the shell AND the page', () => {
  const sites = [{ id: 'a' }, { id: 'b' }];

  it('prefers the requested Anlage', () => {
    expect(resolveAnlage(sites, 'b')).toEqual({ id: 'b' });
  });

  it('falls back to the single Anlage of a one-Anlage customer', () => {
    expect(resolveAnlage([{ id: 'only' }], null)).toEqual({ id: 'only' });
  });

  it('resolves to null for a fleet without a selection (the list)', () => {
    expect(resolveAnlage(sites, null)).toBeNull();
  });

  it('falls back rather than 404-ing on an unknown/stale site id', () => {
    expect(resolveAnlage([{ id: 'only' }], 'gone')).toEqual({ id: 'only' });
    expect(resolveAnlage(sites, 'gone')).toBeNull();
  });

  it('handles the empty account', () => {
    expect(resolveAnlage([], null)).toBeNull();
  });
});
