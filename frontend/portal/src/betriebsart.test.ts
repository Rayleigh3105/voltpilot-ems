import { describe, expect, it } from 'vitest';
import { isFleetShell, redirectOverviewToAnlage, showOverviewNav } from './betriebsart';

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

describe('showOverviewNav', () => {
  it('admins always keep the Übersicht (today\'s behavior)', () => {
    expect(showOverviewNav({ isAdmin: true, loaded: false, tenantReady: false, betriebsart: null, siteCount: 0 })).toBe(true);
  });

  it('waits for the load + tenant context before showing fleet nav', () => {
    expect(showOverviewNav({ ...base, loaded: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
    expect(showOverviewNav({ ...base, tenantReady: false, betriebsart: 'betreiber', siteCount: 3 })).toBe(false);
  });

  it('keys on the frame: betreiber with 1 site shows it, endkunde with 1 site does not', () => {
    expect(showOverviewNav({ ...base, betriebsart: 'betreiber', siteCount: 1 })).toBe(true);
    expect(showOverviewNav({ ...base, betriebsart: 'endkunde', siteCount: 1 })).toBe(false);
  });

  it('v1 regression: without a frame the pre-U0 behavior holds', () => {
    expect(showOverviewNav({ ...base, betriebsart: null, siteCount: 1 })).toBe(false);
    expect(showOverviewNav({ ...base, betriebsart: null, siteCount: 2 })).toBe(true);
  });
});

describe('redirectOverviewToAnlage', () => {
  it('a betreiber is never forwarded away from the Übersicht landing', () => {
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
