import { describe, expect, it } from 'vitest';
import {
  activeAreaKey,
  activeKeyForPage,
  anlageSidebar,
  bottomBarSlots,
  BASE_GROUP_LABEL,
  modeViewItems,
  moreSheetItems,
  resolveAnlage,
  type SidebarGroup,
  type SidebarItem,
} from './anlageNav';
import { MAIN_PAGES, type AnlagenSub } from './nav';
import { anlageSurface, type AnlageSurface, type AnlageSurfaceInput } from './surface';

/** Every AnlagenSub that exists - the "nothing is orphaned" ground truth. */
const ALL_SUBS: AnlagenSub[] = [
  'fahrplan',
  'historie',
  'wetter',
  'technik',
  'modell',
  'steuerung',
  'lastspitzen',
];

const ENTITIES: AnlageSurfaceInput['entities'] = [
  { id: 'e1', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
];

/** A migrated plant with the market mode active. */
const MARKT = anlageSurface({
  entities: ENTITIES,
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch' },
});

/** A migrated plant with the peak mode active. */
const PEAK = anlageSurface({
  entities: ENTITIES,
  config: { plantKind: 'eigenverbrauch', leistungspreisEurKw: 120 },
});

/** Both money modes at once - the widest possible nav. */
const ALLE = anlageSurface({
  entities: ENTITIES,
  config: { plantKind: 'direktvermarktung', tarifArt: 'dynamisch', leistungspreisEurKw: 120 },
  signals: {
    hasStorage: true,
    hasPv: true,
    activeStrategyNodeTypes: ['vp.strategy.selfconsumption'],
    plantKind: 'direktvermarktung',
    hasLeistungspreis: true,
  },
});

/** A plain self-consumption plant (no market, no peak). */
const PRIVAT = anlageSurface({
  entities: ENTITIES,
  signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
  config: { plantKind: 'eigenverbrauch', tarifArt: 'fest' },
});

function subsOf(items: SidebarItem[]): (AnlagenSub | null)[] {
  return items
    .filter((i) => i.target.kind === 'sub')
    .map((i) => (i.target as { kind: 'sub'; sub: AnlagenSub | null }).sub);
}

function allSubs(groups: SidebarGroup[]): (AnlagenSub | null)[] {
  return groups.flatMap((g) => subsOf(g.items));
}

describe('anlageSidebar - the base group is fixed and ordered', () => {
  it('is always exactly the four Anlage areas, in that order', () => {
    // Cockpit+Live merge (Option A): the former Live-Daten area is gone — the
    // cockpit hosts the Komponenten-Board + the compact Verlauf itself.
    for (const surface of [MARKT, PEAK, PRIVAT, null, undefined]) {
      const base = anlageSidebar(surface).groups[0];
      expect(base.label).toBe(BASE_GROUP_LABEL);
      expect(base.tone).toBeNull();
      expect(base.items.map((i) => i.key)).toEqual([
        'cockpit',
        'historie',
        'steuerung',
        'anlagen-modell',
      ]);
      expect(base.items.map((i) => i.label)).toEqual([
        'Cockpit',
        'Historie',
        'Steuerung',
        'Anlagen-Modell',
      ]);
      // No "Live-Daten" nav item anywhere.
      expect(base.items.some((i) => i.label.includes('Live'))).toBe(false);
    }
  });

  it('opens the cockpit and the three area routes', () => {
    expect(subsOf(anlageSidebar(null).groups[0].items)).toEqual([
      null,
      'historie',
      'steuerung',
      'modell',
    ]);
  });

  it('badges Steuerung with the active-mode count from the M0 read-model', () => {
    const badge = (count: number | null | undefined) =>
      anlageSidebar(null, count).groups[0].items.find((i) => i.key === 'steuerung')?.badge;
    expect(badge(3)).toBe(3);
    expect(badge(1)).toBe(1);
    // Never a discouraging "0" / an invented number.
    expect(badge(0)).toBeNull();
    expect(badge(null)).toBeNull();
    expect(badge(Number.NaN)).toBeNull();
  });

  it('defaults the badge to the surface’s own mode count', () => {
    const steuerung = anlageSidebar(MARKT).groups[0].items.find((i) => i.key === 'steuerung');
    expect(steuerung?.badge).toBe(MARKT.modes.length);
  });

  it('never badges anything but Steuerung', () => {
    const base = anlageSidebar(ALLE).groups[0];
    expect(base.items.filter((i) => i.badge != null).map((i) => i.key)).toEqual(['steuerung']);
  });

  it('carries the foot: Einstellungen · Hilfe & Kontakt (no standalone profile)', () => {
    // v3.1-M2 retired the Modus-Profile shelf - modes are containers opened from
    // the Steuerung capsule, so the foot no longer carries a `profile` entry.
    const { foot } = anlageSidebar(PRIVAT);
    expect(foot.map((i) => i.key)).toEqual(['technik', 'hilfe']);
    expect(foot[0].target).toEqual({ kind: 'sub', sub: 'technik' });
    expect(foot[1].target).toEqual({ kind: 'help' });
  });
});

describe('anlageSidebar - mode groups are a projection, never a hardcoded list', () => {
  it('renders one labelled, colour-tagged group per active mode with own views', () => {
    const groups = anlageSidebar(MARKT).groups.slice(1);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Modus · Marktvermarktung');
    expect(groups[0].tone).toBe('markt');
    expect(groups[0].items.map((i) => i.key)).toEqual(['fahrplan', 'marktpreise', 'prognose']);
  });

  it('shows Marktpreise/Prognose ONLY while the market mode is active', () => {
    const keys = (s: AnlageSurface) =>
      anlageSidebar(s)
        .groups.slice(1)
        .flatMap((g) => g.items.map((i) => i.key));
    expect(keys(MARKT)).toContain('marktpreise');
    expect(keys(MARKT)).toContain('prognose');
    // A plain self-consumption plant never sees trading knowledge.
    expect(keys(PRIVAT)).not.toContain('marktpreise');
    expect(keys(PRIVAT)).not.toContain('prognose');
    expect(keys(PEAK)).not.toContain('marktpreise');
  });

  it('gives the peak mode its own group with Lastspitzen', () => {
    const groups = anlageSidebar(PEAK).groups.slice(1);
    expect(groups.map((g) => g.label)).toEqual(['Modus · Lastspitzenkappung']);
    expect(groups[0].tone).toBe('peak');
    expect(groups[0].items.map((i) => i.key)).toEqual(['lastspitzen']);
  });

  it('emits NO group for a mode whose views are all base areas', () => {
    // Eigenverbrauch contributes only `erloes-historie` (= the base Historie),
    // so it is active but adds no navigation of its own.
    expect(PRIVAT.modes.map((m) => m.kind)).toContain('eigenverbrauch');
    expect(anlageSidebar(PRIVAT).groups).toHaveLength(1);
  });

  it('never duplicates an entry across two mode groups', () => {
    const keys = anlageSidebar(ALLE)
      .groups.slice(1)
      .flatMap((g) => g.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has no mode group at all for an un-migrated / unloaded plant', () => {
    expect(anlageSidebar(null).groups).toHaveLength(1);
    expect(anlageSidebar(anlageSurface({})).groups).toHaveLength(1);
  });
});

describe('bottomBarSlots - exactly five, Mehr last', () => {
  it('is Cockpit · Historie · Steuerung · Anlage · Mehr (owner Q3)', () => {
    // Historie takes the slot the Live-Daten merge freed — every „Verlauf →"
    // jump lands there, so it is one thumb away.
    for (const surface of [MARKT, PRIVAT, null]) {
      const slots = bottomBarSlots(anlageSidebar(surface));
      expect(slots).toHaveLength(5);
      expect(slots.map((s) => s.label)).toEqual([
        'Cockpit',
        'Historie',
        'Steuerung',
        'Anlage',
        'Mehr',
      ]);
      expect(slots[4].target).toEqual({ kind: 'more' });
    }
  });

  it('carries the Steuerung badge into the bar', () => {
    const slots = bottomBarSlots(anlageSidebar(null, 4));
    expect(slots.find((s) => s.key === 'steuerung')?.badge).toBe(4);
  });
});

describe('moreSheetItems - everything the bottom bar does not carry', () => {
  it('keeps the mode groups (colour-tagged) and the foot; no empty base group', () => {
    // The bottom bar carries all four base areas since the merge, so the base
    // remainder is empty and the sheet leads with the mode groups.
    const groups = moreSheetItems(anlageSidebar(MARKT));
    expect(groups.some((g) => g.label === BASE_GROUP_LABEL)).toBe(false);
    expect(groups[0].label).toBe('Modus · Marktvermarktung');
    expect(groups[0].tone).toBe('markt');
    const last = groups[groups.length - 1];
    expect(last.items.map((i) => i.key)).toEqual(['wetter', 'technik', 'hilfe']);
  });
});

describe('no orphaned view: every AnlagenSub is mounted exactly once', () => {
  it('base ∪ mode groups ∪ Mehr sheet covers every sub, none twice', () => {
    // The widest surface, so every mode group that can exist does.
    const sidebar = anlageSidebar(ALLE);
    const sidebarSubs = allSubs(sidebar.groups).concat(subsOf(sidebar.foot));
    const sheetSubs = allSubs(moreSheetItems(sidebar));

    // Nothing is listed twice WITHIN one surface.
    expect(new Set(sidebarSubs).size).toBe(sidebarSubs.length);
    expect(new Set(sheetSubs).size).toBe(sheetSubs.length);

    // And together they reach every sub the router knows - a new AnlagenSub
    // must be mounted somewhere or this fails.
    const reachable = new Set(
      [...sidebarSubs, ...sheetSubs].filter((s): s is AnlagenSub => s != null),
    );
    expect([...reachable].sort()).toEqual([...ALL_SUBS].sort());
  });

  it('reaches every sub even on a plant with no mode at all (via the sheet)', () => {
    const sidebar = anlageSidebar(null);
    const reachable = new Set(
      [...allSubs(sidebar.groups), ...subsOf(sidebar.foot), ...allSubs(moreSheetItems(sidebar))]
        .filter((s): s is AnlagenSub => s != null),
    );
    // Only the two mode-scoped views are legitimately absent without a mode.
    expect([...reachable].sort()).toEqual(
      ALL_SUBS.filter((s) => s !== 'fahrplan' && s !== 'lastspitzen').sort(),
    );
  });
});

describe('activeAreaKey / activeKeyForPage - ONE highlight rule', () => {
  it('maps the cockpit and every sub onto its own entry', () => {
    expect(activeAreaKey(null)).toBe('cockpit');
    expect(activeAreaKey('modell')).toBe('anlagen-modell');
    for (const sub of ['historie', 'steuerung', 'fahrplan', 'lastspitzen', 'wetter', 'technik'] as const) {
      expect(activeAreaKey(sub)).toBe(sub);
    }
  });

  it('keeps a mode page highlighted inside its mode group', () => {
    expect(activeKeyForPage('marktpreise')).toBe('marktpreise');
    expect(activeKeyForPage('prognose')).toBe('prognose');
    expect(activeKeyForPage('uebersicht')).toBeNull();
    expect(activeKeyForPage('mandanten')).toBeNull();
  });

  it('highlights a real sidebar entry for every mode-group item', () => {
    for (const group of anlageSidebar(ALLE).groups.slice(1)) {
      for (const item of group.items) {
        const key =
          item.target.kind === 'sub'
            ? activeAreaKey(item.target.sub)
            : item.target.kind === 'page'
              ? activeKeyForPage(item.target.page)
              : null;
        expect(key).toBe(item.key);
      }
    }
  });
});

describe('Marktpreise/Prognose are not a global main-nav group', () => {
  it('the main nav is just Übersicht + Meine Anlage(n)', () => {
    expect(MAIN_PAGES.map((p) => p.id)).toEqual(['uebersicht', 'anlagen']);
  });
});

describe('modeViewItems - the shared derivation for the sidebar group AND the container', () => {
  it('maps a mode’s deep views onto navigable entries, dropping base areas', () => {
    // Marktvermarktung: fahrplan/marktpreise/prognose become entries;
    // erloes-historie is a base area and contributes none.
    const markt = MARKT.modes.find((m) => m.kind === 'marktvermarktung');
    const items = modeViewItems(markt?.manifest.deepViews ?? []);
    expect(items.map((i) => i.key)).toEqual(['fahrplan', 'marktpreise', 'prognose']);
  });

  it('is empty for a mode whose views are all base areas', () => {
    const eigen = PRIVAT.modes.find((m) => m.kind === 'eigenverbrauch');
    expect(modeViewItems(eigen?.manifest.deepViews ?? [])).toEqual([]);
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
