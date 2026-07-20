import { describe, expect, it } from 'vitest';
import {
  isBetreiberShell,
  isFleetShell,
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

  it('waits for the load + tenant context, and never for a non-betreiber frame', () => {
    expect(showPortfolioNav({ ...base, loaded: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
    expect(showPortfolioNav({ ...base, tenantReady: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
    expect(showPortfolioNav({ ...base, betriebsart: 'endkunde', siteCount: 3 })).toBe(false);
    expect(showPortfolioNav({ ...base, betriebsart: null, siteCount: 3 })).toBe(false);
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

  it('an endkunde keeps the calm card Übersicht from the fleet level (unchanged)', () => {
    expect(showOverviewNav({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
    expect(showOverviewNav({ ...base, betriebsart: 'endkunde', siteCount: 2 })).toBe(true);
  });

  it('v1 regression: without a frame the pre-U0 behavior holds', () => {
    expect(showOverviewNav({ ...base, betriebsart: null, siteCount: 1 })).toBe(false);
    expect(showOverviewNav({ ...base, betriebsart: null, siteCount: 2 })).toBe(true);
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

  it('never for a non-betreiber frame or before the context settles', () => {
    expect(redirectToPortfolio({ ...base, betriebsart: 'endkunde', siteCount: 3 })).toBe(false);
    expect(redirectToPortfolio({ ...base, betriebsart: null, siteCount: 3 })).toBe(false);
    expect(redirectToPortfolio({ ...base, loaded: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
  });
});
