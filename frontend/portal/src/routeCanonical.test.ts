import { describe, expect, it } from 'vitest';
import { canonicalShellHash, canonicalShellRoute, type ShellInput } from './betriebsart';
import { anlageRoute, pageRoute, parseRoute, type Route } from './nav';

const shell = (over: Partial<ShellInput> = {}): ShellInput => ({
  isAdmin: false,
  loaded: true,
  tenantReady: true,
  betriebsart: 'endkunde',
  siteCount: 1,
  ...over,
});

function canonical(route: Route, over: Partial<ShellInput> = {}, siteIds = ['sole']) {
  return canonicalShellRoute({ shell: shell({ ...over, siteCount: siteIds.length }), route, siteIds });
}

describe('post-hydration route canonicalization', () => {
  it('sends every one-site customer landing directly to the sole Anlage', () => {
    for (const route of [
      pageRoute('uebersicht'),
      pageRoute('anlagen'),
      pageRoute('portfolio'),
      pageRoute('portfolio-messwerte'),
      pageRoute('portfolio-erloese'),
    ]) {
      expect(canonical(route)).toEqual(anlageRoute('sole'));
    }
  });

  it('is idempotent, so the stable snapshot needs at most one replacement', () => {
    const target = canonical(pageRoute('uebersicht'));
    expect(target).toEqual(anlageRoute('sole'));
    expect(canonical(target as Route)).toBeNull();
  });

  it('keeps valid Anlage and wallbox deep links stable', () => {
    expect(canonical(anlageRoute('sole'))).toBeNull();
    expect(canonical({
      page: 'anlagen', siteId: 'sole', sub: 'geraet',
      geraet: { ref: 'edge-1', geraetId: 'cp-CP-1' },
    })).toBeNull();
  });

  it('corrects an invalid sole-site URL without losing its device target', () => {
    expect(canonical({
      page: 'anlagen', siteId: 'missing', sub: 'geraet',
      geraet: { ref: 'edge-1', geraetId: 'cp-CP-1' },
    })).toEqual({
      page: 'anlagen', siteId: 'sole', sub: 'geraet',
      geraet: { ref: 'edge-1', geraetId: 'cp-CP-1' },
    });
  });

  it('preserves the complete browser query suffix while correcting an invalid site', () => {
    const source = '#/anlage/missing/messwerte?m=e%3Ac&z=woche&at=2026-05-01';
    window.history.replaceState(null, '', source);
    const target = canonical(parseRoute(window.location.hash));
    expect(target).toEqual({ page: 'anlagen', siteId: 'sole', sub: 'messwerte' });
    window.history.replaceState(null, '', canonicalShellHash(target as Route, window.location.hash));
    expect(window.location.hash).toBe('#/anlage/sole/messwerte?m=e%3Ac&z=woche&at=2026-05-01');
  });

  it('lands a fleet shell once on Portfolio and preserves valid site deep links', () => {
    const fleet = { betriebsart: 'betreiber' as const };
    expect(canonical(pageRoute('uebersicht'), fleet, ['a'])).toEqual(pageRoute('portfolio'));
    expect(canonical(pageRoute('anlagen'), fleet, ['a'])).toEqual(pageRoute('portfolio'));
    expect(canonical(anlageRoute('a'), fleet, ['a'])).toBeNull();
    expect(canonical(anlageRoute('missing'), fleet, ['a'])).toEqual(pageRoute('portfolio'));
    expect(canonical(pageRoute('portfolio'), fleet, ['a'])).toBeNull();
  });

  it('waits for one tenant-ready loaded snapshot and leaves an empty account alone', () => {
    expect(canonical(pageRoute('uebersicht'), { loaded: false })).toBeNull();
    expect(canonical(pageRoute('uebersicht'), { tenantReady: false })).toBeNull();
    expect(canonical(pageRoute('uebersicht'), {}, [])).toBeNull();
  });

  it('the operator outside a tenant view keeps today\'s routes: no tenant ready means no canonicalization', () => {
    for (const route of [pageRoute('uebersicht'), pageRoute('plattform-uebersicht'), pageRoute('mandanten')]) {
      expect(canonical(route, { isAdmin: true, tenantReady: false }), route.page).toBeNull();
      expect(canonical(route, { isAdmin: true, loaded: false }), route.page).toBeNull();
    }
    // Plattform-Seiten bleiben auch IN einer Mandantensicht, wo sie sind.
    expect(canonical(pageRoute('plattform-uebersicht'), { isAdmin: true })).toBeNull();
    expect(canonical(pageRoute('mandanten'), { isAdmin: true })).toBeNull();
  });

  it('canonicalizes the complete admin portfolio matrix for 0, 1 and 2 sites', () => {
    for (const betriebsart of ['endkunde', 'betreiber', null] as const) {
      for (const count of [0, 1, 2]) {
        const siteIds = Array.from({ length: count }, (_, index) => `site-${index + 1}`);
        const over = { isAdmin: true, betriebsart };
        const fleet = betriebsart === 'betreiber' || count >= 2;
        // Mandantensicht: wie beim Kunden selbst - ohne Flotte ist die einzige Anlage die Landung (ihre fünf Bereiche
        // stehen dann in der Seitenleiste), ohne Anlage bleibt die Kunden-Übersicht.
        const sole = !fleet && count === 1 ? anlageRoute(siteIds[0]) : null;
        const expectedLanding = fleet ? pageRoute('portfolio') : sole;
        const expectedPortfolio = fleet ? null : sole ?? pageRoute('uebersicht');

        expect(canonical(pageRoute('uebersicht'), over, siteIds), `${betriebsart}/${count} overview`)
          .toEqual(expectedLanding);
        expect(canonical(pageRoute('anlagen'), over, siteIds), `${betriebsart}/${count} naked Anlage`)
          .toEqual(expectedLanding);
        for (const page of ['portfolio', 'portfolio-messwerte', 'portfolio-erloese'] as const) {
          expect(canonical(pageRoute(page), over, siteIds), `${betriebsart}/${count} ${page}`)
            .toEqual(expectedPortfolio);
        }
        if (count > 0) {
          expect(canonical(anlageRoute(siteIds[0]), over, siteIds), `${betriebsart}/${count} valid site`)
            .toBeNull();
          expect(canonical(anlageRoute('missing'), over, siteIds), `${betriebsart}/${count} invalid site`)
            .toEqual(fleet ? pageRoute('portfolio') : anlageRoute(siteIds[0]));
        }
      }
    }
  });

  it('an admin in a one-site tenant lands exactly where that tenant\'s customer lands, and stays there', () => {
    const kunde = canonical(pageRoute('uebersicht'));
    const admin = canonical(pageRoute('uebersicht'), { isAdmin: true });
    expect(admin).toEqual(kunde);
    expect(admin).toEqual(anlageRoute('sole'));
    expect(canonical(admin as Route, { isAdmin: true })).toBeNull();
    // Der Tiefenlink im Mandanten bleibt, auch ein ungültiger Standort behält seinen Reiter.
    expect(canonical({ page: 'anlagen', siteId: 'missing', sub: 'fahrplan' }, { isAdmin: true }))
      .toEqual({ page: 'anlagen', siteId: 'sole', sub: 'fahrplan' });
    expect(canonical(anlageRoute('sole', 'steuerung'), { isAdmin: true })).toBeNull();
  });
});
