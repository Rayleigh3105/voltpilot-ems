import { describe, expect, it } from 'vitest';
import {
  anlagenLabel,
  anlageRoute,
  befehleGeraetHash,
  befehleHash,
  parseBefehleGeraet,
  parseBefehleKomponente,
  canonicalAnlageHash,
  hashForRoute,
  geraetBearbeitenHash,
  geraetBearbeitenKomponente,
  geraetKomponenteBearbeitenHash,
  geraetSeiteHash,
  istGeraetBearbeitenHash,
  isBootHash,
  pageLabel,
  pageRoute,
  parseGeraetRef,
  parseRoute,
  routeDepth,
  transitionKind,
  komponenteBearbeitenHash,
  modellBearbeitenKomponente,
  ohneModellBearbeiten,
  ohneGeraetBearbeiten,
  parseZentraleAnsicht,
  zentraleAnsichtHash,
  PLATFORM_GROUPS,
  PLATFORM_PAGES,
  PLATFORM_TAB_PAGES,
  GERAETE_BEREICH,
  navPageFor,
  isGeraeteBereich,
  canonicalPlatformHash,
  sektionHash,
  parseSektion,
  type AnlagenSub,
  type Route,
  komponenteHash,
  parseKomponente,
  boxSeiteHash,
} from './nav';
import { anlageSidebar } from './ebenenNav';
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
  // ⚠ `geraet`/`box` stehen bewusst NICHT hier: beide sind eine Ebene UNTER
  // dem Anlagen-Modell und haben keinen eigenen Navigationspunkt.
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
    expect(parseRoute('#/mandanten')).toEqual(route('mandanten'));
    // Stufe 4 (F5): „Benutzer" ist im Mandanten-Drawer aufgegangen - das
    // Lesezeichen bleibt gültig und landet auf der Mandanten-Liste, wo der
    // Betreiber seinen Kunden wählt.
    expect(parseRoute('#/benutzer')).toEqual(route('mandanten'));
    expect(canonicalPlatformHash('#/benutzer')).toBe('#/mandanten');
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
    expect(parseRoute('#/mandanten?state=abc')).toEqual(route('mandanten'));
  });
});

describe('hashForRoute', () => {
  it('round-trips every route shape', () => {
    const routes: Route[] = [
      pageRoute('uebersicht'),
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

  /**
   * Die GERÄTE-DETAILSEITE der Anlagen-Zentrale (Stufe 1): zwei zusätzliche
   * Abschnitte, ADDITIV - jede bestehende Adresse ist unverändert gültig.
   */
  it('liest die zwei zusätzlichen Abschnitte der Geräteseite', () => {
    // ⚠ OHNE Gerät dahinter meint die Adresse die BOX (E3) - sie ist ein TOR,
    // kein Gerät, und das sagt seit Geräteseiten Stufe 1 auch die Adresse. Die
    // Referenz reist mit, die Weiterleitung ist also verlustfrei.
    expect(parseRoute('#/anlage/s-1/geraet/edge-45gz7da')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'box',
      geraet: { ref: 'edge-45gz7da', geraetId: null },
    });
    expect(parseRoute('#/anlage/s-1/geraet/edge-45gz7da/inverter')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'geraet',
      geraet: { ref: 'edge-45gz7da', geraetId: 'inverter' },
    });
    // Eine Säulen-Kennung darf kodiert sein - sie ist keine topic-sichere Referenz.
    expect(parseRoute('#/anlage/s-1/geraet/edge-1/cp-CARPORT%201')?.geraet).toEqual({
      ref: 'edge-1',
      geraetId: 'cp-CARPORT 1',
    });
  });

  it('fällt OHNE Referenz auf die Zentrale zurück - nie ins Leere', () => {
    expect(parseRoute('#/anlage/s-1/geraet')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'modell',
    });
  });

  /**
   * Die BOX-Seite (`#/anlage/{id}/box[/{ref}]`, E3): das Tor bekommt eine
   * eigene Adresse, und JEDES Lesezeichen der alten bleibt gültig - die
   * Weiterleitung trägt die Referenz mit, damit auch eine Anlage mit mehreren
   * beanspruchten Geräten sie noch auflösen kann.
   */
  it('gibt der BOX eine eigene Adresse und leitet die alte verlustfrei um', () => {
    expect(parseRoute('#/anlage/s-1/box')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'box',
      geraet: undefined,
    });
    expect(parseRoute('#/anlage/s-1/box/edge-45gz7da')).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'box',
      geraet: { ref: 'edge-45gz7da', geraetId: null },
    });
    // Rundlauf über den Schreiber, mit und ohne Referenz.
    expect(boxSeiteHash('s-1')).toBe('#/anlage/s-1/box');
    expect(parseRoute(boxSeiteHash('s-1', 'edge-45gz7da')).geraet)
      .toEqual({ ref: 'edge-45gz7da', geraetId: null });
    // Und die kanonische Umschreibung der ALTEN Adresse - sie behält die
    // Referenz UND die Parameter (die `canonicalAnlageHash`-Zusage).
    expect(canonicalAnlageHash('#/anlage/s-1/geraet/edge-45gz7da'))
      .toBe('#/anlage/s-1/box/edge-45gz7da');
    expect(canonicalAnlageHash('#/anlage/s-1/geraet/edge-45gz7da?ansicht=schaltbild'))
      .toBe('#/anlage/s-1/box/edge-45gz7da?ansicht=schaltbild');
    // Eine Adresse MIT Gerät bleibt unangetastet - `geraet` ist nicht
    // stillgelegt, nur seine geräteLOSE Form.
    expect(canonicalAnlageHash('#/anlage/s-1/geraet/edge-45gz7da/inverter')).toBeNull();
  });

  it('schreibt die Geräteseite als Hash zurück (Rundlauf)', () => {
    for (const geraetId of ['inverter', 'cp-CARPORT 1']) {
      const hash = geraetSeiteHash('s-1', 'edge-45gz7da', geraetId);
      expect(parseRoute(hash).geraet).toEqual({ ref: 'edge-45gz7da', geraetId });
      expect(hashForRoute(parseRoute(hash))).toBe(hash);
    }
    // ⚠ Die geräteLOSE Form ist die AUSNAHME: sie meint die Box, wird also
    // beim Zurückschreiben auf deren Adresse kanonisiert (E3) - genau das ist
    // die Weiterleitung, und ihr Ziel behält die Referenz.
    const boxAlt = geraetSeiteHash('s-1', 'edge-45gz7da', null);
    expect(parseRoute(boxAlt).geraet).toEqual({ ref: 'edge-45gz7da', geraetId: null });
    expect(hashForRoute(parseRoute(boxAlt))).toBe('#/anlage/s-1/box/edge-45gz7da');
  });

  it('öffnet Bearbeiten auf derselben Geräteseite und verbraucht nur diesen Eintritt', () => {
    const hash = geraetBearbeitenHash('s-1', 'edge-45gz7da', 'src-fronius');
    expect(hash).toBe('#/anlage/s-1/geraet/edge-45gz7da/src-fronius?bearbeiten=1');
    expect(parseRoute(hash).geraet).toEqual({ ref: 'edge-45gz7da', geraetId: 'src-fronius' });
    expect(istGeraetBearbeitenHash(hash)).toBe(true);
    expect(ohneGeraetBearbeiten(`${hash}&kachel=leistung`))
      .toBe('#/anlage/s-1/geraet/edge-45gz7da/src-fronius?kachel=leistung');

    const componentHash = geraetKomponenteBearbeitenHash(
      's-1', 'edge-45gz7da', 'inverter', 'grid/main',
    );
    expect(componentHash).toBe(
      '#/anlage/s-1/geraet/edge-45gz7da/inverter?bearbeiten=1&komponente=grid%2Fmain',
    );
    expect(geraetBearbeitenKomponente(componentHash)).toBe('grid/main');
    expect(ohneGeraetBearbeiten(`${componentHash}&abschnitt=komponenten`)).toBe(
      '#/anlage/s-1/geraet/edge-45gz7da/inverter?abschnitt=komponenten',
    );
  });

  it('trägt das Geräte-Feld NUR auf der Geräteseite', () => {
    expect(parseRoute('#/anlage/s-1/modell').geraet).toBeUndefined();
    expect(parseRoute('#/uebersicht').geraet).toBeUndefined();
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

  it('zieht Marktpreise/Prognose UNTER die Anlage - ohne ein Lesezeichen zu brechen', () => {
    // Navigations-Runde „zwei Ebenen" (E3): sie sind Reiter des Verlaufs
    // geworden. Die alten Adressen bleiben gültig und lösen sich wie jede
    // andere stillgelegte Route auf (die EINE Anlage eines Einzel-Kunden,
    // sonst die Flotten-Ebene) - das `#/fahrplan`-Muster.
    expect(parseRoute('#/marktpreise')).toEqual({
      page: 'anlagen',
      siteId: null,
      sub: 'marktpreise',
    });
    expect(parseRoute('#/prognose')).toEqual({ page: 'anlagen', siteId: null, sub: 'prognose' });
    // Und als Unterseite tragen sie ihre eigene Adresse.
    expect(parseRoute(hashForRoute(anlageRoute('s-1', 'marktpreise')))).toEqual({
      page: 'anlagen',
      siteId: 's-1',
      sub: 'marktpreise',
    });
  });

  it('routet jede Fläche, die die fünf Bereiche und ihre Reiter erreichen', () => {
    // Die breitest mögliche Navigation, damit jeder abgeleitete Reiter da ist.
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
    const reachable = sidebar.bereiche
      .flatMap((b) =>
        b.tabs.length > 0
          ? b.tabs.map((t) => t.sub as AnlagenSub | null)
          : [b.target.kind === 'sub' ? b.target.sub : null],
      )
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

  it('verliert keine Seite: die flache Liste sind die Gruppen PLUS die Tab-Seiten', () => {
    expect(PLATFORM_PAGES).toEqual([
      ...PLATFORM_GROUPS.flatMap((g) => g.pages),
      ...PLATFORM_TAB_PAGES,
    ]);
    // Und jede Seite steht GENAU EINMAL darin - eine Tab-Seite darf nie
    // zusätzlich als Nav-Punkt auftauchen.
    const ids = PLATFORM_PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fencet auch die TAB-Seiten: sie stehen in der flachen Liste, nicht in der Nav', () => {
    // Der Admin-Zaun in `App.tsx` prüft gegen `PLATFORM_PAGES`. Stünde
    // `edge-updates` nur in den Gruppen, käme ein Nicht-Admin über
    // `#/edge-updates` ungefencet durch.
    expect(PLATFORM_PAGES.some((p) => p.id === 'geraete-registry')).toBe(true);
    expect(PLATFORM_GROUPS.flatMap((g) => g.pages).some((p) => p.id === 'geraete-registry'))
      .toBe(false);
  });

  it('hält jede Plattform-Route gültig (kein Lesezeichen bricht)', () => {
    for (const p of PLATFORM_PAGES) {
      expect(parseRoute(hashForRoute(pageRoute(p.id)))).toEqual(route(p.id));
      // Beide Hash-Schreibweisen, wie überall im Router.
      expect(parseRoute(`#${p.id}`)).toEqual(route(p.id));
    }
  });

  it('gibt jedem Punkt ein EIGENES Icon (die Doppel-Icons waren das Anhäng-Symptom)', () => {
    const icons = PLATFORM_PAGES.map((p) => p.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('hat die zwei gefalteten Punkte aus der Navigation genommen (Stufe 3)', () => {
    const flotte = PLATFORM_GROUPS.find((g) => g.key === 'flotte')!.pages.map((p) => p.id);
    expect(flotte).toEqual(['edge-updates', 'steuerungs-freigabe']);
  });

  it('lässt den Tab „Updates" den Nav-Punkt „Geräte" leuchten', () => {
    // Der Bereich ist EIN Ort; der Tab darf die Leiste nicht ins Nichts zeigen
    // lassen. Jede andere Seite bleibt sie selbst.
    expect(navPageFor('edge-updates')).toBe('edge-updates');
    expect(navPageFor('geraete-registry')).toBe('edge-updates');
    expect(navPageFor('mandanten')).toBe('mandanten');
    expect(isGeraeteBereich('edge-updates')).toBe(true);
    expect(isGeraeteBereich('geraete-registry')).toBe(true);
    expect(isGeraeteBereich('optimizer')).toBe(false);
  });

  it('nennt die zwei Tabs in Lese-Reihenfolge und führt mit dem Wirt', () => {
    expect(GERAETE_BEREICH.tabs.map((t) => [t.id, t.label])).toEqual([
      ['edge-updates', 'Updates'],
      ['geraete-registry', 'Registrierung'],
    ]);
    // Der Wirt IST einer der Tabs - sonst wäre der Bereich ohne Auswahl leer.
    expect(GERAETE_BEREICH.tabs.some((t) => t.id === GERAETE_BEREICH.host)).toBe(true);
  });

  it('behält beide Routen des Bereichs (kein Redirect, auch nicht programmatisch)', () => {
    // `edge-updates` ist bewusst KEIN Legacy-Redirect: der Flotten-Puls
    // navigiert programmatisch dorthin, und ein Lesezeichen soll auf dem Tab
    // Updates landen, nicht auf dem Inventar.
    expect(parseRoute('#/edge-updates')).toEqual(route('edge-updates'));
    expect(parseRoute('#/geraete-registry')).toEqual(route('geraete-registry'));
  });

  it('faltet die Gerätetypen in die Steuerungs-Freigabe - MIT ihrem Anker', () => {
    expect(parseRoute('#/geraetetypen')).toEqual(route('steuerungs-freigabe'));
    expect(parseRoute('#geraetetypen')).toEqual(route('steuerungs-freigabe'));
    // Ohne den Anker landete das Lesezeichen oben auf einer Seite, deren
    // Inhalt es gar nicht sucht.
    expect(canonicalPlatformHash('#/geraetetypen'))
      .toBe('#/steuerungs-freigabe?sektion=geraetetypen');
    expect(parseSektion(canonicalPlatformHash('#/geraetetypen')!)).toBe('geraetetypen');
    // Eine Seite, die es noch gibt, wird NIE umgeschrieben.
    expect(canonicalPlatformHash('#/steuerungs-freigabe')).toBeNull();
    expect(canonicalPlatformHash('#/edge-updates')).toBeNull();
  });

  it('sektionHash/parseSektion: der Anker ist ein Parameter, nie eine eigene Route', () => {
    expect(sektionHash('steuerungs-freigabe', 'geraetetypen'))
      .toBe('#/steuerungs-freigabe?sektion=geraetetypen');
    // Ohne Sektion bleibt es die nackte Seite.
    expect(sektionHash('steuerungs-freigabe')).toBe('#/steuerungs-freigabe');
    expect(sektionHash('steuerungs-freigabe', '  ')).toBe('#/steuerungs-freigabe');
    // Und die Route ist in JEDEM Fall dieselbe Seite.
    expect(parseRoute(sektionHash('steuerungs-freigabe', 'geraetetypen')))
      .toEqual(route('steuerungs-freigabe'));
    expect(parseSektion('#/steuerungs-freigabe')).toBeNull();
  });

  it('behält die Beschriftungen, die Lesezeichen und Copy schon kennen', () => {
    expect(pageLabel('geraete-registry')).toBe('Registrierung');
    expect(pageLabel('edge-updates')).toBe('Geräte');
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
 * Der DEEP-LINK-VERTRAG der abgelösten Plattform-Vollansicht (Anlagen-Zentrale
 * Stufe 3, PR 3b). Geschrieben wird die Adresse nirgends mehr - GELESEN muss
 * sie für immer werden, damit kein altes Lesezeichen bricht.
 */
describe('parseGeraetRef (der Deep-Link-Vertrag)', () => {
  it('liest die Referenz aus einer alten Adresse', () => {
    expect(parseGeraetRef('#/geraete-registry?geraet=edge-k2m4pqj')).toBe('edge-k2m4pqj');
    expect(parseGeraetRef('#/geraete-registry?geraet=VP-DEMO-0001')).toBe('VP-DEMO-0001');
  });

  it('lässt die Route dabei die Geräte-Seite bleiben', () => {
    expect(parseRoute('#/geraete-registry?geraet=edge-k2m4pqj')).toEqual(
      route('geraete-registry'),
    );
  });

  it('ist null, wo kein Gerät genannt ist', () => {
    expect(parseGeraetRef('#/geraete-registry')).toBeNull();
    expect(parseGeraetRef('')).toBeNull();
    expect(parseGeraetRef('#/geraete-registry?geraet=   ')).toBeNull();
  });

  it('dekodiert eine Referenz, die Sonderzeichen trägt', () => {
    expect(parseGeraetRef('#/geraete-registry?geraet=edge-a%20b')).toBe('edge-a b');
  });

  // ⚠ Der No-Orphan-Wächter: der frühere SCHREIBER ist ersatzlos entfallen.
  // Käme er zurück, erzeugte er wieder Adressen auf eine Fläche, die es nicht
  // mehr gibt.
  it('hat keinen Schreiber mehr (geraetHash ist entfallen)', async () => {
    const nav = await import('./nav');
    expect('geraetHash' in nav).toBe(false);
  });
});

/**
 * Der Geräte-Filter der Befehle-Seite (Anlagen-Zentrale Stufe 1,
 * Captain-Entscheid D3: die Seite bleibt, die Geräteseite zeigt die gefilterte
 * Sicht).
 */
describe('befehleGeraetHash - das Gerät als Hash-Parameter', () => {
  it('trägt das Gerät und findet es wieder', () => {
    const h = befehleGeraetHash('s-1', 'src-7c1e9a2b');
    expect(h).toBe('#/anlage/s-1/befehle?geraet=src-7c1e9a2b');
    expect(parseBefehleGeraet(h)).toBe('src-7c1e9a2b');
    // Eine Referenz mit Sonderzeichen überlebt den Weg.
    const ref = 'cp-CARPORT 1';
    expect(parseBefehleGeraet(befehleGeraetHash('s-1', ref))).toBe(ref);
  });

  it('lässt die Route dabei die Befehle-Seite bleiben', () => {
    expect(parseRoute(befehleGeraetHash('s-1', 'inverter')))
      .toEqual({ page: 'anlagen', siteId: 's-1', sub: 'befehle' });
  });

  it('hält Komponente und Gerät auseinander - zwei Fragen, zwei Parameter', () => {
    // Der Server lehnt beides zusammen mit 400 ab; die zwei Adressen können es
    // deshalb gar nicht erst gemeinsam ausdrücken.
    expect(parseBefehleGeraet(befehleHash('s-1', 'e-1'))).toBeNull();
    expect(parseBefehleKomponente(befehleGeraetHash('s-1', 'inverter'))).toBeNull();
    expect(parseBefehleGeraet('#/anlage/s-1/befehle')).toBeNull();
    expect(parseBefehleGeraet('#/anlage/s-1/befehle?geraet=%20%20')).toBeNull();
  });
});

describe('zentraleAnsichtHash / parseZentraleAnsicht', () => {
  it('trägt die Listen-Zweitsicht als Hash-Parameter und lässt die Route unberührt', () => {
    const h = zentraleAnsichtHash('s-1', 'geraete');
    expect(h).toBe('#/anlage/s-1/modell?ansicht=geraete');
    expect(parseRoute(h)).toEqual({ page: 'anlagen', siteId: 's-1', sub: 'modell' });
    expect(parseZentraleAnsicht(h)).toBe('geraete');
  });

  it('schreibt für die VORGABE keinen Parameter - der Einstieg ist das Anlagenbild', () => {
    expect(zentraleAnsichtHash('s-1', 'schaltbild')).toBe('#/anlage/s-1/modell');
    expect(parseZentraleAnsicht('#/anlage/s-1/modell')).toBe('schaltbild');
    expect(parseZentraleAnsicht('#/anlage/s-1/modell?ansicht=phantasie')).toBe('schaltbild');
  });

  it('öffnet einen Komponenten-Deep-Link weiterhin in der Liste', () => {
    expect(parseZentraleAnsicht('#/anlage/s-1/modell?komponente=grid')).toBe('geraete');
  });
});

/**
 * Der Weg ZURÜCK auf EINE Komponente (Anlagen-Zentrale Stufe 3, PR 3c): die
 * Gegenrichtung jedes Drill-ins - Cockpit, Regel-Karte und Schaltbild führen
 * alle an dieselbe Zeile.
 */
describe('komponenteHash / parseKomponente', () => {
  it('trägt die Komponente als Hash-Parameter und lässt die Route unberührt', () => {
    const h = komponenteHash('s-1', 'batt');
    expect(h).toBe('#/anlage/s-1/modell?komponente=batt');
    expect(parseRoute(h)).toEqual({ page: 'anlagen', siteId: 's-1', sub: 'modell' });
    expect(parseKomponente(h)).toBe('batt');
  });

  it('kodiert eine Kennung mit Sonderzeichen und liest sie zurück', () => {
    const id = 'cp/1 a';
    expect(komponenteHash('s-1', id)).toContain('cp%2F1%20a');
    expect(parseKomponente(komponenteHash('s-1', id))).toBe(id);
  });

  it('ist null, wo keine Komponente genannt ist', () => {
    expect(parseKomponente('#/anlage/s-1/modell')).toBeNull();
    expect(parseKomponente('#/anlage/s-1/modell?ansicht=schaltbild')).toBeNull();
    expect(parseKomponente('')).toBeNull();
  });
});

describe('komponenteBearbeitenHash', () => {
  it('round-trips and consumes the inline model entry', () => {
    const hash = komponenteBearbeitenHash('s-1', 'pv/garage');
    expect(hash).toBe('#/anlage/s-1/modell?bearbeiten=1&komponente=pv%2Fgarage');
    expect(modellBearbeitenKomponente(hash)).toBe('pv/garage');
    expect(ohneModellBearbeiten(hash)).toBe('#/anlage/s-1/modell');
    expect(modellBearbeitenKomponente(komponenteHash('s-1', 'pv/garage'))).toBeNull();
  });
});

describe('Bewegung P5 · die Richtung eines Seitenwechsels', () => {
  const portfolio = pageRoute('portfolio');
  const mandanten = pageRoute('mandanten');
  const anlage = anlageRoute('s-1');
  const messwerte = anlageRoute('s-1', 'messwerte');
  const erloese = anlageRoute('s-1', 'erloese');
  const geraet = anlageRoute('s-1', 'geraet');

  it('die Tiefe folgt der Brotkrume, die der Kunde liest', () => {
    expect(routeDepth(portfolio)).toBe(0);
    expect(routeDepth(mandanten)).toBe(0);
    expect(routeDepth(anlage)).toBe(1);
    expect(routeDepth(messwerte)).toBe(2);
    // Geräte- und Box-Seite wohnen EINE Ebene unter dem Anlagen-Modell
    // (`ebenenNav.OHNE_BEREICHS_REITER`: sie tragen keinen Reiter).
    expect(routeDepth(geraet)).toBe(3);
    expect(routeDepth(anlageRoute('s-1', 'box'))).toBe(3);
  });

  it('`#/anlagen` OHNE Anlage ist Flotten-Ebene, keine geöffnete Anlage', () => {
    // Die Umleitungs-Adresse der Flotten-Ebene — sie zeigt nie einen
    // Anlagen-Kopf, also darf sie auch nicht als Anlage zählen.
    expect(routeDepth({ page: 'anlagen', siteId: null, sub: null })).toBe(0);
  });

  it('tiefer schiebt, flacher zieht zurück', () => {
    expect(transitionKind(portfolio, anlage)).toBe('push');
    expect(transitionKind(anlage, messwerte)).toBe('push');
    expect(transitionKind(anlageRoute('s-1', 'modell'), geraet)).toBe('push');
    expect(transitionKind(anlage, portfolio)).toBe('pop');
    expect(transitionKind(messwerte, anlage)).toBe('pop');
    expect(transitionKind(geraet, anlageRoute('s-1', 'modell'))).toBe('pop');
  });

  it('Geschwister blenden — auf jeder Ebene', () => {
    // Reiter neben Reiter (der Fall, für den es die Regel gibt) …
    expect(transitionKind(messwerte, erloese)).toBe('fade');
    // … Flotten-Seite neben Flotten-Seite …
    expect(transitionKind(portfolio, mandanten)).toBe('fade');
    // … und Anlage neben Anlage (der Umschalter in der Kopfzeile).
    expect(transitionKind(anlage, anlageRoute('s-2'))).toBe('fade');
  });

  it('ZURÜCK gewinnt gegen die Tiefe — sonst führe das Browser-Zurück vorwärts', () => {
    // Genau der Fall, den eine Heuristik am Hash falsch macht: über die
    // Brotkrume flacher (pop), dann Browser-Zurück — die Tiefe sagt `push`,
    // der Kunde erlebt ein Zurück.
    expect(transitionKind(anlage, messwerte, true)).toBe('pop');
    expect(transitionKind(portfolio, geraet, true)).toBe('pop');
    expect(transitionKind(messwerte, erloese, true)).toBe('pop');
  });

  it('das erste Bild ist kein Wechsel — es blendet (das Ankommen gehört P4)', () => {
    expect(transitionKind(null, anlage)).toBe('fade');
    expect(transitionKind(null, portfolio)).toBe('fade');
  });

  it('dieselbe Route auf sich selbst schiebt nichts', () => {
    expect(transitionKind(messwerte, anlageRoute('s-1', 'messwerte'))).toBe('fade');
  });
});
