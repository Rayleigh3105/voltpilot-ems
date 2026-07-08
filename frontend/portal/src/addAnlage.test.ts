import { describe, expect, it } from 'vitest';
import { showAddAnlageButton } from './addAnlage';

const base = {
  isAdmin: false,
  loaded: true,
  tenantReady: true,
  onboarding: false,
  siteCount: 1,
};

describe('showAddAnlageButton', () => {
  it('shows for a customer with exactly one Anlage (the dead-end case)', () => {
    expect(showAddAnlageButton(base)).toBe(true);
  });

  it('hides for a Portal-Admin (they use the Plattform surface)', () => {
    expect(showAddAnlageButton({ ...base, isAdmin: true })).toBe(false);
  });

  it('hides for a fleet (>= 2 Anlagen already carry an add button)', () => {
    // No duplicate/competing button on a screen that already has one.
    expect(showAddAnlageButton({ ...base, siteCount: 2 })).toBe(false);
    expect(showAddAnlageButton({ ...base, siteCount: 5 })).toBe(false);
  });

  it('hides for an empty account (its own "Anlage anlegen" CTA)', () => {
    expect(showAddAnlageButton({ ...base, siteCount: 0 })).toBe(false);
  });

  it('hides during first-run onboarding', () => {
    expect(showAddAnlageButton({ ...base, onboarding: true })).toBe(false);
  });

  it('hides before the tenant-scoped data has loaded', () => {
    expect(showAddAnlageButton({ ...base, loaded: false })).toBe(false);
    expect(showAddAnlageButton({ ...base, tenantReady: false })).toBe(false);
  });
});
