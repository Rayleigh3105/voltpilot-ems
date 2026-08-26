import { describe, expect, it } from 'vitest';
import { canonicalShellRoute, type ShellInput } from './betriebsart';
import { anlageRoute, pageRoute, type Route } from './nav';

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
});
