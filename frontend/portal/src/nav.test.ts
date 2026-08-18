import { describe, expect, it } from 'vitest';
import {
  anlagenLabel,
  anlageRoute,
  canonicalAnlageHash,
  hashForRoute,
  geraetHash,
  isBootHash,
  pageLabel,
  pageRoute,
  parseGeraetRef,
  parseRoute,
  PLATFORM_GROUPS,
  PLATFORM_PAGES,
  type AnlagenSub,
  type Route,
} from './nav';
import { anlageSidebar, moreSheetItems } from './anlageNav';
import { anlageSurface } from './surface';

/** Every AnlagenSub route that exists. */
const ALL_SUBS: AnlagenSub[] = [
  'fahrplan',
  'messwerte',
  'erloese',
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
    for (const sub of ['fahrplan', 'messwerte', 'erloese', 'wetter'] as const) {
      expect(parseRoute(`#/anlage/site-1/${sub}`)).toEqual({
        page: 'anlagen',
        siteId: 'site-1',
        sub,
      });
    }
  });

  it('redirects every retired menu hash into the Anlage (bookmarks keep working)', () => {
    // Site-scoped deep views keep their intent as the Anlage subpage...
    expect(parseRoute('#/fahrplan')).toEqual({ page: 'anlagen', siteId: null, sub: 'fahrplan' });
    // Die Historie ist zwei Welten - ihre Route erbt die BASIS-Welt.
    expect(parseRoute('#/historie')).toEqual({ page: 'anlagen', siteId: null, sub: 'messwerte' });
    expect(parseRoute('#/wetter')).toEqual({ page: 'anlagen', siteId: null, sub: 'wetter' });
    // ...the entity lists land on the Technik subpage (its content moved there
    // behind the gear icon in the money-centric v2).
    expect(parseRoute('#/standorte')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
    expect(parseRoute('#/geraete')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
    // Both hash spellings work (the router always accepted #foo and #/foo).
    expect(parseRoute('#standorte')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
  });

  it('redirects the retired live routes into the cockpit (Cockpit+Live merge)', () => {
    // Option A: the Live-Daten page is gone — the cockpit hosts the board +
    // Verlauf. Both the old top-level hash and the subpage hash land on the
    // Anlage itself (sub null), never a 404.
    expect(parseRoute('#/live')).toEqual({ page: 'anlagen', siteId: null, sub: null });
    expect(parseRoute('#/anlage/site-1/live')).toEqual({
      page: 'anlagen',
      siteId: 'site-1',
      sub: null,
    });
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

  it('redirects the retired profile subpage into steuerung (v3.1-M2 container)', () => {
    // The standalone Modus-Profile shelf became the per-mode container opened
    // from the Steuerung capsule; the old hash keeps working as a redirect.
    expect(parseRoute('#/anlage/site-1/profile')).toEqual({
      page: 'anlagen',
      siteId: 'site-1',
      sub: 'steuerung',
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
      anlageRoute('site-1', 'fahrplan'),
      anlageRoute('site-1', 'messwerte'),
      anlageRoute('site-1', 'erloese'),
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
    expect(parseRoute('#/live')).toEqual({ page: 'anlagen', siteId: null, sub: null });
    expect(parseRoute('#/fahrplan')).toEqual({ page: 'anlagen', siteId: null, sub: 'fahrplan' });
    expect(parseRoute('#/historie')).toEqual({ page: 'anlagen', siteId: null, sub: 'messwerte' });
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

/**
 * Zwei Welten (Captain-Struktur H1, 30.07.2026): die eine Historie-Seite wurde
 * zu `messwerte` + `erloese`. Weiterleiten heißt hier ausdrücklich AUCH: die
 * Parameter überleben - ohne das wäre jedes `?m=…&z=…`-Lesezeichen ein stiller
 * Datenverlust.
 */
describe('zwei Welten: die Historie-Route leitet MIT Parametern weiter', () => {
  it('parst die alte Route auf die Messwerte-Welt', () => {
    expect(parseRoute('#/anlage/s-1/historie')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'messwerte',
    });
  });

  it('schreibt die Adresse kanonisch um und behält ?m=/z=/at=', () => {
    expect(canonicalAnlageHash('#/anlage/s-1/historie?m=e:c&z=woche&at=2026-05-01')).toBe(
      '#/anlage/s-1/messwerte?m=e:c&z=woche&at=2026-05-01',
    );
    // Auch ohne Parameter, und für die anderen stillgelegten Unterseiten.
    expect(canonicalAnlageHash('#/anlage/s-1/historie')).toBe('#/anlage/s-1/messwerte');
    expect(canonicalAnlageHash('#/anlage/s-1/entitaeten')).toBe('#/anlage/s-1/modell');
    // `live` zeigt auf das Cockpit selbst (sub null).
    expect(canonicalAnlageHash('#/anlage/s-1/live?x=1')).toBe('#/anlage/s-1?x=1');
  });

  it('schreibt NICHTS um, was schon kanonisch ist', () => {
    expect(canonicalAnlageHash('#/anlage/s-1/messwerte?z=tag')).toBeNull();
    expect(canonicalAnlageHash('#/anlage/s-1/erloese')).toBeNull();
    expect(canonicalAnlageHash('#/anlage/s-1')).toBeNull();
    expect(canonicalAnlageHash('#/marktpreise')).toBeNull();
    expect(canonicalAnlageHash('')).toBeNull();
  });
});

function route(page: Route['page']): Route {
  return { page, siteId: null, sub: null };
}

/**
 * Admin-Umbau Stufe 1 „Ordnung" (Konzept `vp-admin-neu-konzept-a9` §3.1,
 * Captain-Entscheid F1). Die Gruppierung ist reine PRÄSENTATION - geprüft wird
 * deshalb vor allem, dass sie NICHTS verändert: keine Route, keine Seite, kein
 * Lesezeichen.
 */
describe('PLATFORM_GROUPS - die gruppierte Plattform-Navigation', () => {
  it('führt mit der Landung und dann den vier Aufgaben-Gruppen', () => {
    expect(PLATFORM_GROUPS.map((g) => g.key)).toEqual([
      'landing',
      'flotte',
      'anlagen-werkzeuge',
      'katalog',
      'kunden',
    ]);
    // Die Landung trägt bewusst KEINE eigene Überschrift - sie steht schon
    // unter dem „Plattform"-Label der Schale.
    expect(PLATFORM_GROUPS[0].label).toBeNull();
    expect(PLATFORM_GROUPS[0].pages.map((p) => p.id)).toEqual(['plattform-uebersicht']);
    expect(PLATFORM_GROUPS.slice(1).map((g) => g.label)).toEqual([
      'Flotte',
      'Anlagen-Werkzeuge',
      'Katalog',
      'Kunden',
    ]);
  });

  it('verliert keine Seite: die flache Liste IST die Vereinigung der Gruppen', () => {
    expect(PLATFORM_PAGES).toEqual(PLATFORM_GROUPS.flatMap((g) => g.pages));
    // Und jede Seite steht in GENAU EINER Gruppe.
    const ids = PLATFORM_PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hält jede Plattform-Route gültig (kein Lesezeichen bricht)', () => {
    for (const p of PLATFORM_PAGES) {
      expect(parseRoute(hashForRoute(pageRoute(p.id)))).toEqual(route(p.id));
      // Beide Hash-Schreibweisen, wie überall im Router.
      expect(parseRoute(`#${p.id}`)).toEqual(route(p.id));
    }
    // Die zwei Punkte, die Stufe 3 zusammenlegt, sind HEUTE noch eigene
    // Seiten - ihre Ids dürfen dabei nicht verschwinden.
    expect(PLATFORM_PAGES.some((p) => p.id === 'edge-updates')).toBe(true);
    expect(PLATFORM_PAGES.some((p) => p.id === 'geraetetypen')).toBe(true);
  });

  it('gibt jedem Punkt ein EIGENES Icon (die Doppel-Icons waren das Anhäng-Symptom)', () => {
    const icons = PLATFORM_PAGES.map((p) => p.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('stellt die künftigen Nachbarn schon nebeneinander (Stufe 3 wird ein Entfernen)', () => {
    const flotte = PLATFORM_GROUPS.find((g) => g.key === 'flotte')!.pages.map((p) => p.id);
    expect(flotte.indexOf('edge-updates')).toBe(flotte.indexOf('geraete-registry') + 1);
    expect(flotte.indexOf('geraetetypen')).toBe(flotte.indexOf('steuerungs-freigabe') + 1);
  });

  it('behält die Beschriftungen, die Lesezeichen und Copy schon kennen', () => {
    expect(pageLabel('geraete-registry')).toBe('Geräte');
    expect(pageLabel('steuerungs-freigabe')).toBe('Steuerungs-Freigabe');
    expect(pageLabel('plattform-uebersicht')).toBe('Plattform-Übersicht');
  });
});

/**
 * `isBootHash` trennt „ohne Ziel gestartet" von „ausdrücklich zur Übersicht" -
 * die Bedingung der Admin-Landung (F1). `parseRoute` kann das nicht: es bildet
 * beides auf `uebersicht` ab.
 */
describe('isBootHash', () => {
  it('ist wahr für den nackten Boot-Hash', () => {
    for (const h of ['', '#', '#/', '#?x=1']) expect(isBootHash(h)).toBe(true);
  });

  it('ist falsch, sobald der Aufruf ein Ziel nennt - auch die Übersicht', () => {
    for (const h of ['#/uebersicht', '#uebersicht', '#/anlage/s-1', '#/plattform-uebersicht']) {
      expect(isBootHash(h)).toBe(false);
    }
  });
});

/**
 * Die GERÄTE-DETAILSEITE (Stufe 2, F2). Sie ist ein HASH-PARAMETER auf der
 * Geräte-Route - der Router bleibt unangetastet, und die Referenz als
 * Schlüssel überlebt Unclaim/Re-Claim.
 */
describe('geraetHash / parseGeraetRef', () => {
  it('schreibt und liest dieselbe Referenz zurück', () => {
    expect(parseGeraetRef(geraetHash('edge-k2m4pqj'))).toBe('edge-k2m4pqj');
    expect(parseGeraetRef(geraetHash('VP-DEMO-0001'))).toBe('VP-DEMO-0001');
  });

  it('lässt die Route dabei die Geräte-Seite bleiben', () => {
    expect(parseRoute(geraetHash('edge-k2m4pqj'))).toEqual(route('geraete-registry'));
  });

  it('räumt den Parameter, wenn nichts geöffnet ist', () => {
    expect(geraetHash(null)).toBe('#/geraete-registry');
    expect(geraetHash('   ')).toBe('#/geraete-registry');
    expect(parseGeraetRef('#/geraete-registry')).toBeNull();
    expect(parseGeraetRef('')).toBeNull();
  });

  it('kodiert eine Referenz, die Sonderzeichen trägt', () => {
    const ref = 'edge-a b';
    expect(geraetHash(ref)).toContain('edge-a%20b');
    expect(parseGeraetRef(geraetHash(ref))).toBe(ref);
  });
});
