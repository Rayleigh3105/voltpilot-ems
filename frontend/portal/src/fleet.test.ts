import { describe, expect, it } from 'vitest';
import type { OverviewSite } from './api';
import {
  composeFleetSentence,
  fleetFinePrint,
  fleetHeadline,
  fleetKind,
  fleetPvKw,
  fleetSubline,
  siteEarnText,
  siteLiveFresh,
} from './fleet';

const NOW = new Date('2026-07-06T12:00:00Z');

function site(over: Partial<OverviewSite>): OverviewSite {
  return {
    id: 's1',
    name: 'Berlin',
    plantKind: 'eigenverbrauch',
    deviceCount: 1,
    onlineCount: 1,
    waitingCount: 0,
    worstStatus: 'online',
    lastSeenAt: NOW.toISOString(),
    live: { ts: NOW.toISOString(), pvKw: 3.2, loadKw: 1.1, gridKw: -0.9, socPct: 76 },
    plannedSavingsTodayEur: 1.1,
    ...over,
  };
}

describe('fleetKind + wording', () => {
  it('only Direktvermarktung speaks revenue', () => {
    expect(fleetKind(['direktvermarktung', 'direktvermarktung'])).toBe('direktvermarktung');
    expect(fleetHeadline('direktvermarktung')).toBe('Ihr VoltPilot-Mehrerlös');
    expect(fleetSubline('direktvermarktung')).toBe('heute laut Fahrplan mehr verdient');
  });

  it('only Eigenverbrauch speaks avoided cost', () => {
    expect(fleetKind(['eigenverbrauch'])).toBe('eigenverbrauch');
    expect(fleetHeadline('eigenverbrauch')).toBe('Ihr VoltPilot-Vorteil');
    expect(fleetSubline('eigenverbrauch')).toBe('heute laut Fahrplan gespart');
  });

  it('a mixed fleet gets the neutral headline', () => {
    expect(fleetKind(['direktvermarktung', 'eigenverbrauch'])).toBe('gemischt');
    expect(fleetHeadline('gemischt')).toBe('Ihr VoltPilot-Vorteil');
    expect(fleetSubline('gemischt')).toContain('alle Standorte');
  });

  it('an empty list counts as gemischt-neutral', () => {
    expect(fleetKind([])).toBe('gemischt');
  });

  it('fine print is honest about the planned nature', () => {
    expect(fleetFinePrint('eigenverbrauch')).toContain('Geplanter Wert');
    expect(fleetFinePrint('eigenverbrauch')).toContain('sparen');
    expect(fleetFinePrint('direktvermarktung')).toContain('mehr herausholen');
    // Mixed fleet reads right for both stories.
    expect(fleetFinePrint('gemischt')).toContain('mehr herausholen');
  });
});

describe('siteEarnText (per-site wording)', () => {
  it('uses the SITE kind, German amount, and the honest (geplant) tag', () => {
    expect(siteEarnText('eigenverbrauch', 1.1)).toBe('Heute +1,10\u00a0€ gespart (geplant)');
    expect(siteEarnText('direktvermarktung', 0.85)).toBe(
      'Heute +0,85\u00a0€ mehr verdient (geplant)',
    );
  });

  it('is silent (null) without a plan - never a fake zero', () => {
    expect(siteEarnText('eigenverbrauch', null)).toBeNull();
  });

  it('keeps a negative planned value honest', () => {
    expect(siteEarnText('direktvermarktung', -0.2)).toBe(
      'Heute -0,20\u00a0€ mehr verdient (geplant)',
    );
  });
});

describe('composeFleetSentence', () => {
  it('is green with PV when everything reports and generates', () => {
    const s = composeFleetSentence(
      [site({}), site({ id: 's2', name: 'München', live: { ts: NOW.toISOString(), pvKw: 9.2, loadKw: 2, gridKw: -7, socPct: 41 } })],
      NOW,
    );
    expect(s.tone).toBe('ok');
    expect(s.text).toBe(
      'Alles läuft. 2 von 2 Geräten online, Ihre Anlagen erzeugen gerade 12,4\u00a0kW Solarstrom.',
    );
  });

  it('drops the PV clause when nothing generates (night)', () => {
    const s = composeFleetSentence(
      [site({ live: { ts: NOW.toISOString(), pvKw: 0, loadKw: 0.4, gridKw: 0.4, socPct: 30 } })],
      NOW,
    );
    expect(s.tone).toBe('ok');
    expect(s.text).toBe('Alles läuft. 1 von 1 Geräten online.');
  });

  it('one silent device turns the sentence amber and names it', () => {
    const s = composeFleetSentence(
      [site({}), site({ id: 's2', name: 'Hamburg', onlineCount: 0, worstStatus: 'stale' })],
      NOW,
    );
    expect(s.tone).toBe('warn');
    expect(s.text).toBe('1 Gerät in Hamburg meldet sich nicht. 1 von 2 Geräten online.');
  });

  it('several silent devices are counted and their sites listed', () => {
    const s = composeFleetSentence(
      [
        site({ deviceCount: 2, onlineCount: 0, worstStatus: 'stale' }),
        site({ id: 's2', name: 'Hamburg', onlineCount: 0, worstStatus: 'stale' }),
      ],
      NOW,
    );
    expect(s.tone).toBe('warn');
    expect(s.text).toBe('3 Geräte melden sich nicht (Berlin und Hamburg). 0 von 3 Geräten online.');
  });

  it('a waiting device gets the calm onboarding wording', () => {
    const s = composeFleetSentence(
      [site({}), site({ id: 's2', name: 'Hamburg', onlineCount: 0, waitingCount: 1, worstStatus: 'waiting' })],
      NOW,
    );
    expect(s.tone).toBe('warn');
    expect(s.text).toBe('1 Gerät in Hamburg wartet auf erste Daten. 1 von 2 Geräten online.');
  });

  it('silent beats waiting in the lead clause', () => {
    const s = composeFleetSentence(
      [
        site({ onlineCount: 0, worstStatus: 'stale' }),
        site({ id: 's2', name: 'Hamburg', onlineCount: 0, waitingCount: 1, worstStatus: 'waiting' }),
      ],
      NOW,
    );
    expect(s.tone).toBe('warn');
    expect(s.text).toContain('meldet sich nicht');
  });

  it('no devices at all is the muted empty tone', () => {
    const s = composeFleetSentence([site({ deviceCount: 0, onlineCount: 0, worstStatus: null, live: null })], NOW);
    expect(s.tone).toBe('off');
    expect(s.text).toBe('Noch keine Geräte verbunden.');
  });
});

describe('fleetPvKw (fresh sites only)', () => {
  it('sums PV over fresh sites and skips stale snapshots', () => {
    const staleTs = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    const pv = fleetPvKw(
      [
        site({}),
        site({ id: 's2', live: { ts: staleTs, pvKw: 99, loadKw: 1, gridKw: 0, socPct: 50 } }),
      ],
      NOW,
    );
    expect(pv).toBe(3.2);
  });

  it('is null when no fresh site reports PV', () => {
    expect(fleetPvKw([site({ live: null })], NOW)).toBeNull();
  });
});

describe('siteLiveFresh', () => {
  it('needs BOTH an online device and a fresh observation', () => {
    expect(siteLiveFresh(site({}), NOW)).toBe(true);
    // Online device replaying old buffered samples: values are NOT current.
    const oldTs = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(
      siteLiveFresh(site({ live: { ts: oldTs, pvKw: 1, loadKw: 1, gridKw: 0, socPct: 50 } }), NOW),
    ).toBe(false);
    expect(siteLiveFresh(site({ onlineCount: 0 }), NOW)).toBe(false);
    expect(siteLiveFresh(site({ live: null }), NOW)).toBe(false);
  });
});
