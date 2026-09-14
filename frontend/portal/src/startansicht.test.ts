import { describe, expect, it } from 'vitest';
import type { Site } from './api';
import { anlagenOptionen } from './anlagenWahl';
import {
  canonicalShellRoute,
  EBENE_HEUTE,
  kopfPfad,
  orteAus,
  pfadZeile,
  showPortfolioNav,
  startEbene,
  type Orte,
  type ShellInput,
} from './betriebsart';
import { anlageRoute, hashForRoute, pageRoute, parseRoute, standortRoute, type Route } from './nav';
import {
  ahrenbergHeute,
  ahrenbergUnternehmen,
  bestandEineAnlage,
  bestandZweiAnlagen,
  FIXTURE_IDS,
  werkAhrenberg,
  werkLindach,
} from './test/standorteFixtures';

/**
 * UEMS AP-01 IP-5 — die Startansicht-Weiche E1 (Captain-Entscheid 10.09.2026:
 * „die tiefste Ebene, die alles zeigt"). Jeder Fall im ersten Block ist GENAU
 * eine Zeile der Sprungregeln-Tabelle (Report AP-01 §4.6 „Startansicht (E1)")
 * und trägt ihren Namen. Standorte, Anlagen und Namen kommen aus dem
 * Referenzunternehmen Ahrenberg (`test/standorteFixtures.ts`); kein Fall
 * erfindet eine Kundenzahl.
 */

const { an1, an2, an3, st1, st2 } = FIXTURE_IDS;
const MEINE_ANLAGEN = 'Meine Anlagen';

type Rahmen = Pick<ShellInput, 'isAdmin' | 'loaded' | 'tenantReady' | 'betriebsart'>;

/** Die Schale, wie `App.tsx` sie baut: Anlagen + Standorte → Ebene. */
function schale(siteIds: string[], orte: Orte | null, over: Partial<Rahmen> = {}): ShellInput {
  const rahmen: Rahmen = { isAdmin: false, loaded: true, tenantReady: true, betriebsart: 'endkunde', ...over };
  return {
    ...rahmen,
    siteCount: siteIds.length,
    ebene: startEbene({ isAdmin: rahmen.isAdmin, betriebsart: rahmen.betriebsart, siteIds, orte }),
  };
}

/** Die Landung nach der Anmeldung — sie braucht höchstens EINEN Austausch der Adresse. */
function landung(shell: ShellInput, siteIds: string[], start: Route = pageRoute('uebersicht')): Route {
  const ziel = canonicalShellRoute({ shell, route: start, siteIds }) ?? start;
  expect(canonicalShellRoute({ shell, route: ziel, siteIds }), `idempotent ab ${hashForRoute(ziel)}`).toBeNull();
  return ziel;
}

/** Der Pfad als Wörter: die Glieder davor und das letzte, wenn es keine Anlage ist. */
function pfad(shell: ShellInput, route: Route, anlageId: string | null = route.siteId) {
  const p = kopfPfad({ shell, route, anlageId, fleetLabel: MEINE_ANLAGEN });
  return { vor: p.vor.map((g) => g.label), hier: p.hier };
}

/** Ahrenberg bis 30.09.2026: der Standort aus der Bestandsübernahme (A5), eine Anlage Halle 1. */
const einStandortEineAnlage = () =>
  orteAus(bestandEineAnlage(), ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 1 }));
/** Ahrenberg 01.10.–14.10.2026: Werk Ahrenberg mit Halle 1 und Halle 2; Werk Lindach kommt am 15.10.2026. */
const einStandortZweiAnlagen = () =>
  orteAus({ ...ahrenbergHeute(), standorte: [werkAhrenberg()] }, ahrenbergUnternehmen({ standortZahl: 1, anlagenZahl: 2 }));
/** Ahrenberg am 20.10.2026: Werk Ahrenberg (Halle 1, Halle 2) und Werk Lindach. */
const zweiStandorte = () => orteAus(ahrenbergHeute(), ahrenbergUnternehmen());
/** Peter Hollerbach sieht nur Werk Lindach (AP-03) — das Unternehmen hat zwei Standorte. */
const nurLindach = () => orteAus({ ...ahrenbergHeute(), standorte: [werkLindach()] }, ahrenbergUnternehmen());
/** Ein Kundenbereich vor seiner ersten Anlage: Unternehmen angelegt, nichts darunter (Form des Lesemodells). */
const leer = () =>
  orteAus(
    { stichtag: '2026-10-20', standorte: [], nichtGezeigt: [], nochNichtZugeordnet: null },
    ahrenbergUnternehmen({ standortZahl: 0, anlagenZahl: 0, sitz: null }),
  );

describe('UEMS AP-01 IP-5 · Startansicht-Weiche E1 — die sechs Landungsfälle der Sprungregeln-Tabelle', () => {
  it('1 Standort, 1 Anlage → Anlage-Cockpit (heutiges Verhalten)', () => {
    const ids = [an1];
    const shell = schale(ids, einStandortEineAnlage());
    expect(shell.ebene).toEqual({ art: 'anlage' });
    for (const start of [pageRoute('uebersicht'), pageRoute('anlagen'), pageRoute('portfolio'), standortRoute(st1)]) {
      expect(landung(shell, ids, start), hashForRoute(start)).toEqual(anlageRoute(an1));
    }
    // Ohne Standorte landet derselbe Kunde genauso — und hat keine Flotten-Ebene.
    expect(landung(schale(ids, null), ids)).toEqual(anlageRoute(an1));
    expect(showPortfolioNav(shell)).toBe(false);
    // Pfad „Halle 1 ▾": beide oberen Ebenen sind übersprungen (A2).
    expect(pfad(shell, anlageRoute(an1))).toEqual({ vor: [], hier: null });
  });

  it('1 Standort, n Anlagen → Standort-Übersicht', () => {
    const ids = [an1, an2];
    const shell = schale(ids, einStandortZweiAnlagen());
    expect(shell.ebene).toMatchObject({ art: 'standort', teilansicht: false });
    expect(landung(shell, ids)).toEqual(standortRoute(st1));
    // `#/portfolio` meint die übersprungene Unternehmensebene, `#/anlagen` die Flotte.
    expect(landung(shell, ids, pageRoute('portfolio'))).toEqual(standortRoute(st1));
    expect(landung(shell, ids, pageRoute('anlagen'))).toEqual(standortRoute(st1));
    // Die Reiter der Ebene und jede Anlage bleiben, wie sie sind.
    expect(canonicalShellRoute({ shell, route: pageRoute('portfolio-messwerte'), siteIds: ids })).toBeNull();
    expect(canonicalShellRoute({ shell, route: anlageRoute(an2, 'fahrplan'), siteIds: ids })).toBeNull();
    expect(showPortfolioNav(shell)).toBe(true);
    // Pfad „Werk Ahrenberg › Werk Ahrenberg – Halle 1 ▾" — die Unternehmensebene entfällt.
    expect(pfad(shell, anlageRoute(an1))).toEqual({ vor: ['Werk Ahrenberg'], hier: null });
    expect(pfad(shell, standortRoute(st1), null)).toEqual({ vor: [], hier: 'Werk Ahrenberg' });
    // Ohne Standorte hätte derselbe Kunde das Portfolio.
    expect(landung(schale(ids, null), ids)).toEqual(pageRoute('portfolio'));
  });

  it('n Standorte → Unternehmens-Übersicht', () => {
    const ids = [an1, an2, an3];
    const shell = schale(ids, zweiStandorte());
    expect(shell.ebene).toMatchObject({ art: 'unternehmen', name: 'Ahrenberg' });
    expect(landung(shell, ids)).toEqual(pageRoute('portfolio'));
    // Pfad dreigliedrig: „Ahrenberg › Werk Ahrenberg › Werk Ahrenberg – Halle 1 ▾" (A9).
    expect(pfad(shell, anlageRoute(an1))).toEqual({ vor: ['Ahrenberg', 'Werk Ahrenberg'], hier: null });
    expect(pfad(shell, anlageRoute(an3))).toEqual({ vor: ['Ahrenberg', 'Werk Lindach'], hier: null });
    expect(pfad(shell, pageRoute('portfolio'), null)).toEqual({ vor: [], hier: 'Ahrenberg' });
    expect(pfad(shell, standortRoute(st2), null)).toEqual({ vor: ['Ahrenberg'], hier: 'Werk Lindach' });
    // Beide Standort-Übersichten gelten; ein unbekannter Standort landet auf dem Unternehmen.
    expect(canonicalShellRoute({ shell, route: standortRoute(st1), siteIds: ids })).toBeNull();
    expect(landung(shell, ids, standortRoute('unbekannt'))).toEqual(pageRoute('portfolio'));
    // Schon mit EINER Anlage öffnet der zweite Standort die Unternehmensebene (Report §5.4).
    expect(landung(schale([an1], zweiStandorte()), [an1])).toEqual(pageRoute('portfolio'));
  });

  it('Betreiber (tenant.betriebsart) → Übersicht ab der ersten Anlage — unverändert', () => {
    for (const ids of [[an1], [an1, an2, an3]]) {
      const shell = schale(ids, zweiStandorte(), { betriebsart: 'betreiber' });
      const heute = schale(ids, null, { betriebsart: 'betreiber' });
      expect(shell.ebene).toEqual(EBENE_HEUTE);
      expect(landung(shell, ids)).toEqual(pageRoute('portfolio'));
      expect(landung(shell, ids)).toEqual(landung(heute, ids));
      for (const route of [anlageRoute(an1), pageRoute('portfolio')]) {
        expect(kopfPfad({ shell, route, anlageId: an1, fleetLabel: 'Portfolio' }))
          .toEqual(kopfPfad({ shell: heute, route, anlageId: an1, fleetLabel: 'Portfolio' }));
      }
    }
  });

  it('Zugriff nur auf einen Standort (AP-03) → dessen Standort-Übersicht; Unternehmensebene nicht sichtbar', () => {
    const ids = [an3];
    const shell = schale(ids, nurLindach());
    expect(shell.ebene).toMatchObject({ art: 'standort', teilansicht: true });
    // Auch mit nur einer Anlage dort: Peter Hollerbach landet auf „Werk Lindach" (A6).
    expect(landung(shell, ids)).toEqual(standortRoute(st2));
    expect(landung(shell, ids, pageRoute('portfolio'))).toEqual(standortRoute(st2));
    expect(landung(shell, ids, standortRoute(st1))).toEqual(standortRoute(st2));
    expect(pfad(shell, standortRoute(st2), null)).toEqual({ vor: [], hier: 'Werk Lindach' });
    expect(pfad(shell, anlageRoute(an3))).toEqual({ vor: ['Werk Lindach'], hier: null });
  });

  it('0 Standorte, 0 Anlagen → Unternehmens-Übersicht als Leerzustand (heute die leere Übersicht; die Funktions-Karte bringt IP-8)', () => {
    const shell = schale([], leer());
    expect(shell.ebene).toEqual(EBENE_HEUTE);
    expect(landung(shell, [])).toEqual(pageRoute('uebersicht'));
    expect(landung(schale([], null), [])).toEqual(pageRoute('uebersicht'));
    expect(showPortfolioNav(shell)).toBe(false);
    // Eine Standort-Adresse zeigt dort nichts Verwaistes.
    expect(landung(shell, [], standortRoute(st1))).toEqual(pageRoute('uebersicht'));
  });
});

describe('UEMS AP-01 IP-5 · Randfälle der Weiche und des Pfades', () => {
  it('ohne Standorte (zwei Bestandsanlagen, noch nicht zugeordnet) ist alles wie heute', () => {
    const ids = [an1, an2];
    const orte = orteAus(
      bestandZweiAnlagen(),
      ahrenbergUnternehmen({ standortZahl: 0, nochNichtZugeordnetZahl: 2, sitz: null }),
    );
    const shell = schale(ids, orte);
    expect(shell.ebene).toEqual(EBENE_HEUTE);
    expect(landung(shell, ids)).toEqual(pageRoute('portfolio'));
    expect(pfad(shell, anlageRoute(an1))).toEqual({ vor: [MEINE_ANLAGEN], hier: null });
    expect(pfad(shell, pageRoute('portfolio'), null)).toEqual({ vor: [], hier: null });
  });

  it('eine noch nicht zugeordnete Anlage hält die Unternehmensebene offen', () => {
    const ids = [an1, an2];
    const nurHalle1 = werkAhrenberg({ anlagen: [werkAhrenberg().anlagen[0]], anlagenZahl: 1 });
    const shell = schale(
      ids,
      orteAus({ ...ahrenbergHeute(), standorte: [nurHalle1] }, ahrenbergUnternehmen({ standortZahl: 1 })),
    );
    expect(shell.ebene?.art).toBe('unternehmen');
    expect(landung(shell, ids)).toEqual(pageRoute('portfolio'));
    // Halle 2 hat keinen Standort: ihr Pfad nennt nur das Unternehmen.
    expect(pfad(shell, anlageRoute(an2))).toEqual({ vor: ['Ahrenberg'], hier: null });
  });

  it('Standorte nicht geladen, Schale nicht fertig oder Admin: keine neue Entscheidung', () => {
    const ids = [an1, an2, an3];
    expect(startEbene({ isAdmin: true, betriebsart: 'endkunde', siteIds: ids, orte: zweiStandorte() })).toEqual(EBENE_HEUTE);
    expect(startEbene({ isAdmin: false, betriebsart: 'endkunde', siteIds: ids, orte: null })).toEqual(EBENE_HEUTE);
    expect(
      canonicalShellRoute({ shell: { ...schale(ids, zweiStandorte()), loaded: false }, route: pageRoute('uebersicht'), siteIds: ids }),
    ).toBeNull();
    // Ein Admin mit einer Standort-Adresse landet auf der Flotten-Ebene seines Kunden.
    const admin = schale(ids, zweiStandorte(), { isAdmin: true });
    expect(canonicalShellRoute({ shell: admin, route: standortRoute(st1), siteIds: ids })).toEqual(pageRoute('portfolio'));
  });

  it('das Lesemodell zählt: archivierte Standorte fehlen, Kurzname vor Name, unbekannt bleibt unbekannt', () => {
    const orte = orteAus(
      { ...ahrenbergHeute(), standorte: [werkAhrenberg(), werkLindach({ zustand: 'archiviert' })] },
      ahrenbergUnternehmen(),
    );
    expect(orte.standorte.map((s) => s.id)).toEqual([st1]);
    expect(orte.unternehmen).toBe('Ahrenberg');
    expect(orteAus(ahrenbergHeute(), ahrenbergUnternehmen({ kurzname: null })).unternehmen)
      .toBe('Kunststoffwerk Ahrenberg GmbH');
    const ohne = orteAus(ahrenbergHeute(), null);
    expect(ohne.standorteGesamt).toBeNull();
    expect(ohne.unternehmen).toBeNull();
  });

  it('der Umschalter trägt die Glieder als Zeilen — am Telefon sind sie der Rückweg', () => {
    const shell = schale([an1, an2, an3], zweiStandorte());
    const p = kopfPfad({ shell, route: anlageRoute(an1), anlageId: an1, fleetLabel: MEINE_ANLAGEN });
    const rueckwege = p.vor.map(pfadZeile);
    expect(rueckwege).toEqual([
      { value: '__unternehmen__', label: 'Ahrenberg', sub: 'Unternehmen · Übersicht' },
      { value: '__standort__', label: 'Werk Ahrenberg', sub: 'Standort · Übersicht' },
    ]);
    expect(p.vor.map((g) => g.route)).toEqual([pageRoute('portfolio'), standortRoute(st1)]);
    const zeilen = anlagenOptionen({
      sites: [{ id: an1, name: 'Werk Ahrenberg – Halle 1' }] as Site[],
      devices: { devices: [], fetchedAt: null },
      mitFlotte: true,
      rueckwege,
    });
    expect(zeilen.map((z) => z.label)).toEqual(['Ahrenberg', 'Werk Ahrenberg', 'Werk Ahrenberg – Halle 1']);
  });

  it('`#/standort/{id}` ist ein stabiles Lesezeichen; `#/standorte` bleibt die Alt-Adresse der Technik', () => {
    expect(hashForRoute(standortRoute(st1))).toBe(`#/standort/${st1}`);
    expect(parseRoute(`#/standort/${st1}`)).toEqual(standortRoute(st1));
    expect(parseRoute('#/standort')).toEqual({ page: 'standort', siteId: null, sub: null });
    expect(parseRoute('#/standorte')).toEqual({ page: 'anlagen', siteId: null, sub: 'technik' });
  });
});
