import { describe, expect, it } from 'vitest';
import {
  isBetreiberShell,
  isFleetShell,
  redirectAdminToPlattform,
  redirectOverviewToAnlage,
  redirectToPortfolio,
  showOverviewNav,
  showPortfolioNav,
} from './betriebsart';

const base = { isAdmin: false, loaded: true, tenantReady: true } as const;

describe('isFleetShell (U0: the frame decides, not the site count)', () => {
  it('betreiber gets the fleet shell even with a single Standort', () => {
    expect(isFleetShell('betreiber', 1)).toBe(true);
    expect(isFleetShell('betreiber', 0)).toBe(true);
    expect(isFleetShell('betreiber', 5)).toBe(true);
  });

  it('endkunde with one Anlage stays in the cockpit', () => {
    expect(isFleetShell('endkunde', 1)).toBe(false);
    expect(isFleetShell('endkunde', 0)).toBe(false);
  });

  it('endkunde with 2-3 Anlagen gets the calm card overview level (never an operator table)', () => {
    // The Übersicht renders FleetUebersicht CARDS for them; the operator
    // portfolio table is betreiber-only (U5, #516).
    expect(isFleetShell('endkunde', 2)).toBe(true);
    expect(isFleetShell('endkunde', 3)).toBe(true);
  });

  it('unknown frame falls back to the v1 site-count heuristic', () => {
    expect(isFleetShell(null, 1)).toBe(false);
    expect(isFleetShell(null, 2)).toBe(true);
  });
});

describe('isBetreiberShell (U5: the Portfolio shell)', () => {
  it('is the betreiber frame, and only that', () => {
    expect(isBetreiberShell('betreiber')).toBe(true);
    expect(isBetreiberShell('endkunde')).toBe(false);
    expect(isBetreiberShell(null)).toBe(false);
  });
});

describe('showPortfolioNav', () => {
  it('a betreiber (customer or admin-selected) gets the Portfolio item', () => {
    expect(showPortfolioNav({ ...base, betriebsart: 'betreiber', siteCount: 1 })).toBe(true);
    expect(showPortfolioNav({ isAdmin: true, loaded: true, tenantReady: true, betriebsart: 'betreiber', siteCount: 4 })).toBe(true);
  });

  it('waits for the load + tenant context, and never below the fleet level', () => {
    expect(showPortfolioNav({ ...base, loaded: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
    expect(showPortfolioNav({ ...base, tenantReady: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
    // Ohne Flotten-Ebene gibt es kein Portfolio - der Einzel-Anlagen-Kunde
    // ist von Stufe 4 unberührt.
    expect(showPortfolioNav({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
    expect(showPortfolioNav({ ...base, betriebsart: null, siteCount: 1 })).toBe(false);
  });

  it('Stufe 4 (E5): auch ein ENDKUNDE ab zwei Anlagen bekommt das Portfolio', () => {
    // Die sichtbare U0/U5-Änderung: bis Stufe 3 sah dieser Kunde die ruhigen
    // `FleetUebersicht`-Karten und NIE eine Portfolio-Welt. Jetzt ist es
    // dieselbe EINE Fläche - nur in Karten-Dichte (`portfolioDichte`).
    expect(showPortfolioNav({ ...base, betriebsart: 'endkunde', siteCount: 2 })).toBe(true);
    expect(showPortfolioNav({ ...base, betriebsart: 'endkunde', siteCount: 3 })).toBe(true);
    // Ein unbekannter Rahmen folgt derselben Heuristik wie die Flotten-Ebene.
    expect(showPortfolioNav({ ...base, betriebsart: null, siteCount: 2 })).toBe(true);
  });
});

describe('showOverviewNav', () => {
  it('admins keep the Übersicht (today\'s behavior) - unless a betreiber tenant is selected', () => {
    expect(showOverviewNav({ isAdmin: true, loaded: false, tenantReady: false, betriebsart: null, siteCount: 0 })).toBe(true);
    // A betreiber tenant swaps Übersicht for Portfolio, even for an admin.
    expect(showOverviewNav({ isAdmin: true, loaded: true, tenantReady: true, betriebsart: 'betreiber', siteCount: 2 })).toBe(false);
  });

  it('a betreiber gets Portfolio INSTEAD of Übersicht', () => {
    expect(showOverviewNav({ ...base, betriebsart: 'betreiber', siteCount: 1 })).toBe(false);
    expect(showOverviewNav({ ...base, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
  });

  it('Stufe 4: ein Endkunde ab zwei Anlagen bekommt Portfolio STATT Übersicht', () => {
    // Vor Stufe 4 stand hier `true` - der Punkt hieß „Übersicht" und führte
    // auf die `FleetUebersicht`. Es geht nichts verloren: derselbe Kunde hat
    // jetzt den Punkt „Portfolio" auf dieselbe Fläche.
    expect(showOverviewNav({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
    expect(showOverviewNav({ ...base, betriebsart: 'endkunde', siteCount: 2 })).toBe(false);
    expect(showPortfolioNav({ ...base, betriebsart: 'endkunde', siteCount: 2 })).toBe(true);
  });

  it('ohne Rahmen gilt dieselbe Flotten-Heuristik', () => {
    expect(showOverviewNav({ ...base, betriebsart: null, siteCount: 1 })).toBe(false);
    expect(showOverviewNav({ ...base, betriebsart: null, siteCount: 2 })).toBe(false);
    expect(showPortfolioNav({ ...base, betriebsart: null, siteCount: 2 })).toBe(true);
  });
});

describe('redirectOverviewToAnlage', () => {
  it('a betreiber is never forwarded to the Anlage (they land on Portfolio)', () => {
    expect(redirectOverviewToAnlage({ ...base, betriebsart: 'betreiber', siteCount: 1 })).toBe(false);
  });

  it('an endkunde without a fleet level is forwarded to their Anlage', () => {
    expect(redirectOverviewToAnlage({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(true);
    expect(redirectOverviewToAnlage({ ...base, betriebsart: null, siteCount: 1 })).toBe(true);
    expect(redirectOverviewToAnlage({ ...base, betriebsart: 'endkunde', siteCount: 2 })).toBe(false);
  });

  it('admins and unsettled loads never redirect', () => {
    expect(redirectOverviewToAnlage({ isAdmin: true, loaded: true, tenantReady: true, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
    expect(redirectOverviewToAnlage({ ...base, loaded: false, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
  });
});

describe('redirectToPortfolio', () => {
  it('a settled betreiber landing on Übersicht is sent to the Portfolio page', () => {
    expect(redirectToPortfolio({ ...base, betriebsart: 'betreiber', siteCount: 1 })).toBe(true);
    expect(redirectToPortfolio({ isAdmin: true, loaded: true, tenantReady: true, betriebsart: 'betreiber', siteCount: 1 })).toBe(true);
  });

  it('Stufe 4: das alte Endkunden-Lesezeichen #/uebersicht gilt weiter', () => {
    // Genau DAS ist der Weg, auf dem die U0/U5-Änderung niemandem etwas
    // wegnimmt: wer `#/uebersicht` gespeichert hat, landet auf `#/portfolio`.
    expect(redirectToPortfolio({ ...base, betriebsart: 'endkunde', siteCount: 3 })).toBe(true);
    expect(redirectToPortfolio({ ...base, betriebsart: null, siteCount: 3 })).toBe(true);
  });

  it('never below the fleet level or before the context settles', () => {
    expect(redirectToPortfolio({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
    expect(redirectToPortfolio({ ...base, betriebsart: null, siteCount: 1 })).toBe(false);
    expect(redirectToPortfolio({ ...base, loaded: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
  });
});

describe('HIGH-1: an UNSET frame is deploy-day neutral (pre-deploy audit)', () => {
  // The api no longer derives the frame from tenant.segment (which defaults to
  // 'CI' for every admin-provisioned tenant), so an existing customer arrives
  // here with betriebsart === null and must see EXACTLY the pre-U0 shell.
  const unset = (siteCount: number) => ({ ...base, betriebsart: null, siteCount });

  it('a single-plant customer lands on their cockpit, never on Portfolio', () => {
    expect(showPortfolioNav(unset(1))).toBe(false);
    expect(redirectToPortfolio(unset(1))).toBe(false);
    expect(showOverviewNav(unset(1))).toBe(false);
    expect(redirectOverviewToAnlage(unset(1))).toBe(true);
  });

  it('Stufe 4: ein 2+-Anlagen-Kunde landet auf dem Portfolio-Cockpit (Karten)', () => {
    // Der HIGH-1-Kern bleibt: ein Bestandskunde OHNE gesetzten Rahmen wird
    // nicht auf eine Betreiber-Fläche geworfen. Die Fläche ist jetzt dieselbe
    // wie beim Betreiber, ihre DICHTE aber die ruhige Karten-Dichte - das
    // prüft `portfolioCockpit.test.ts` an `portfolioDichte(null)`.
    expect(showPortfolioNav(unset(3))).toBe(true);
    expect(showOverviewNav(unset(3))).toBe(false);
    expect(redirectOverviewToAnlage(unset(3))).toBe(false);
  });

  it('nur ein ausdrücklicher betreiber-Rahmen öffnet das Portfolio schon bei EINER Anlage', () => {
    expect(showPortfolioNav({ ...base, betriebsart: 'betreiber', siteCount: 1 })).toBe(true);
    // Das ist der Rest, den die Betriebsart an der SCHALE noch entscheidet:
    // ab wann es eine Flotten-Ebene gibt. Ein Endkunde mit EINER Anlage hat
    // keine - für ihn ist Stufe 4 folgenlos.
    expect(showPortfolioNav({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
  });
});

/**
 * Admin-Umbau Stufe 1 (F1): der Admin wacht auf seiner Landung auf - aber nur,
 * wenn der Aufruf gar kein Ziel genannt hat.
 */
describe('redirectAdminToPlattform', () => {
  it('leitet einen ziellosen Admin-Boot auf die Plattform-Übersicht', () => {
    expect(redirectAdminToPlattform({ isAdmin: true, bootHash: true })).toBe(true);
  });

  it('lässt einen Deep-Link in Ruhe - auch `#/uebersicht`', () => {
    expect(redirectAdminToPlattform({ isAdmin: true, bootHash: false })).toBe(false);
  });

  it('fasst einen Kunden nie an', () => {
    expect(redirectAdminToPlattform({ isAdmin: false, bootHash: true })).toBe(false);
    expect(redirectAdminToPlattform({ isAdmin: false, bootHash: false })).toBe(false);
  });
});
