import { describe, expect, it } from 'vitest';
import {
  anlagenLabel,
  anlageRoute,
  hashForRoute,
  pageLabel,
  pageRoute,
  parseRoute,
  type AnlagenSub,
  type Route,
} from './nav';
import { anlageSidebar, moreSheetItems } from './anlageNav';
import { anlageSurface } from './surface';

/** Every AnlagenSub route that exists. */
const ALL_SUBS: AnlagenSub[] = [
  'live',
  'fahrplan',
  'historie',
  'wetter',
  'technik',
  'modell',
  'steuerung',
  'lastspitzen',
];

/**
 * The hash router of the Anlagen IA (captain decision 2026-07-07): four
 * customer nav entries, the Anlagen-Seite at #/anlage/{siteId} with its
 * subpages, and the RETIRED menu hashes redirecting into the Anlage so old
 * bookmarks keep working.
 */
describe('parseRoute', () => {
  it('maps the top-level pages', () => {
    expect(parseRoute('')).toEqual(route('uebersicht'));
    expect(parseRoute('#/')).toEqual(route('uebersicht'));
    expect(parseRoute('#/uebersicht')).toEqual(route('uebersicht'));
    expect(parseRoute('#/marktpreise')).toEqual(route('marktpreise'));
    expect(parseRoute('#/prognose')).toEqual(route('prognose'));
    expect(parseRoute('#/mandanten')).toEqual(route('mandanten'));
    expect(parseRoute('#/benutzer')).toEqual(route('benutzer'));
    expect(parseRoute('#/geraete-registry')).toEqual(route('geraete-registry'));
  });

  it('maps the Anlagen entry and one Anlage with its subpages', () => {
    expect(parseRoute('#/anlagen')).toEqual(route('anlagen'));
    expect(parseRoute('#/anlage/site-1')).toEqual({
      page: 'anlagen',
      siteId: 'site-1',
      sub: null,
    });
    for (const sub of ['live', 'fahrplan', 'historie', 'wetter'] as const) {
      expect(parseRoute(`#/anlage/site-1/${sub}`)).toEqual({
        page: 'anlagen',
        siteId: 'site-1',
        sub,
      });
    }
  });

  it('redirects every retired menu hash into the Anlage (bookmarks keep working)', () => {
    // Site-scoped deep views keep their intent as the Anlage subpage...
    expect(parseRoute('#/live')).toEqual({ page: 'anlagen', siteId: null, sub: 'live' });
    expect(parseRoute('#/fahrplan')).toEqual({ page: 'anlagen', siteId: null, sub: 'fahrplan' });
    expect(parseRoute('#/historie')).toEqual({ page: 'anlagen', siteId: null, sub: 'historie' });
    expect(parseRoute('#/wetter')).toEqual({ page: 'anlagen', siteId: null, sub: 'wetter' });
    // ...the entity lists land on the Technik subpage (its content moved there
    // behind the gear icon in the money-centric v2).
    expect(parseRoute('#/standorte')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
    expect(parseRoute('#/geraete')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
    // Both hash spellings work (the router always accepted #foo and #/foo).
    expect(parseRoute('#standorte')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
  });

  it('redirects the retired optimierung subpage into steuerung (U3 merge)', () => {
    // "Optimierung" merged into "Steuerung" as its Level 1 "Was läuft"; the old
    // hash keeps working as a redirect (no bookmark break).
    expect(parseRoute('#/anlage/site-1/optimierung')).toEqual({
      page: 'anlagen',
      siteId: 'site-1',
      sub: 'steuerung',
    });
  });

  it('redirects the retired entitaeten subpage into the Anlagen-Modell (M6)', () => {
    // The "Geräte & Entitäten" list became the Anlagen-Modell in Portal v3 M6;
    // the old hash keeps working as a redirect so bookmarks never break.
    expect(parseRoute('#/anlage/site-1/entitaeten')).toEqual({
      page: 'anlagen',
      siteId: 'site-1',
      sub: 'modell',
    });
  });

  it('ignores an unknown sub segment instead of breaking the Anlage', () => {
    expect(parseRoute('#/anlage/site-1/unbekannt')).toEqual({
      page: 'anlagen',
      siteId: 'site-1',
      sub: null,
    });
  });

  it('falls back to the Übersicht for unknown hashes and a bare #/anlage', () => {
    expect(parseRoute('#/nope')).toEqual(route('uebersicht'));
    expect(parseRoute('#/anlage')).toEqual(route('uebersicht'));
    expect(parseRoute('#register')).toEqual(route('uebersicht'));
  });

  it('drops a query string like the previous router', () => {
    expect(parseRoute('#/marktpreise?state=abc')).toEqual(route('marktpreise'));
  });
});

describe('hashForRoute', () => {
  it('round-trips every route shape', () => {
    const routes: Route[] = [
      pageRoute('uebersicht'),
      pageRoute('marktpreise'),
      pageRoute('anlagen'),
      anlageRoute('site-1'),
      anlageRoute('site-1', 'live'),
      anlageRoute('site-1', 'historie'),
    ];
    for (const r of routes) {
      expect(parseRoute(hashForRoute(r))).toEqual(r);
    }
  });

  it('writes the canonical hashes', () => {
    expect(hashForRoute(pageRoute('anlagen'))).toBe('#/anlagen');
    expect(hashForRoute(anlageRoute('s', 'fahrplan'))).toBe('#/anlage/s/fahrplan');
  });
});

describe('anlagenLabel', () => {
  it('is singular for 0-1 Anlagen and plural from 2', () => {
    expect(anlagenLabel(null)).toBe('Meine Anlage');
    expect(anlagenLabel(0)).toBe('Meine Anlage');
    expect(anlagenLabel(1)).toBe('Meine Anlage');
    expect(anlagenLabel(2)).toBe('Meine Anlagen');
    expect(pageLabel('anlagen', 3)).toBe('Meine Anlagen');
  });
});

/**
 * M1 (#529): the per-Anlage tab bar is retired, but NO route may break with it
 * - every subpage hash and every retired top-level hash still resolves, and
 * every deep view reachable in the UI is a real route.
 */
describe('M1: no route breaks when the tab bar is retired', () => {
  it('still resolves every Anlage subpage hash', () => {
    for (const sub of ALL_SUBS) {
      expect(parseRoute(`#/anlage/s-1/${sub}`)).toEqual({ page: 'anlagen', siteId: 's-1', sub });
    }
  });

  it('still redirects the retired top-level hashes into the Anlage', () => {
    expect(parseRoute('#/live')).toEqual({ page: 'anlagen', siteId: null, sub: 'live' });
    expect(parseRoute('#/fahrplan')).toEqual({ page: 'anlagen', siteId: null, sub: 'fahrplan' });
    expect(parseRoute('#/historie')).toEqual({ page: 'anlagen', siteId: null, sub: 'historie' });
    expect(parseRoute('#/wetter')).toEqual({ page: 'anlagen', siteId: null, sub: 'wetter' });
    expect(parseRoute('#/standorte')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
    expect(parseRoute('#/geraete')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
    expect(parseRoute('#/anlage/s-1/optimierung')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'steuerung',
    });
  });

  it('keeps Marktpreise/Prognose addressable although they left the main nav', () => {
    expect(parseRoute('#/marktpreise')).toEqual(route('marktpreise'));
    expect(parseRoute('#/prognose')).toEqual(route('prognose'));
    expect(pageLabel('marktpreise')).toBe('Marktpreise');
    expect(pageLabel('prognose')).toBe('Prognosequalität');
  });

  it('routes every UI-reachable area (v3 shell: sidebar groups + foot + Mehr sheet)', () => {
    // The widest possible nav, so every mode group that can exist does.
    const sidebar = anlageSidebar(
      anlageSurface({
        entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
        config: {
          plantKind: 'direktvermarktung',
          tarifArt: 'dynamisch',
          leistungspreisEurKw: 120,
        },
      }),
    );
    const reachable = [
      ...sidebar.groups.flatMap((g) => g.items),
      ...sidebar.foot,
      ...moreSheetItems(sidebar).flatMap((g) => g.items),
    ]
      .map((i) => (i.target.kind === 'sub' ? i.target.sub : null))
      .filter((s): s is AnlagenSub => s != null);
    for (const sub of reachable) {
      expect(parseRoute(hashForRoute(anlageRoute('s-1', sub)))).toEqual({
        page: 'anlagen',
        siteId: 's-1',
        sub,
      });
    }
  });
});

function route(page: Route['page']): Route {
  return { page, siteId: null, sub: null };
}
