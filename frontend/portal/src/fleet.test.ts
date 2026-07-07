import { describe, expect, it } from 'vitest';
import type { EarningsSite, OverviewSite } from './api';
import {
  arbitrageLine,
  BATTERY_NO_DEVICE_SHORT,
  BATTERY_NO_DEVICE_WARNING,
  netzladenBadge,
  berlinDay,
  composeFleetSentence,
  fleetDailySaved,
  fleetHeadline,
  fleetKind,
  fleetPvKw,
  notComputableHint,
  parsePremiumInput,
  premiumIncluded,
  premiumInputText,
  proofLine,
  rangePhrase,
  realizedFinePrint,
  realizedSubline,
  savedOnDay,
  composeSiteSentence,
  siteEarnText,
  siteLiveFresh,
  siteSnapshot,
  sparkDays,
} from './fleet';

const NOW = new Date('2026-07-06T12:00:00Z');

function site(over: Partial<OverviewSite>): OverviewSite {
  return {
    id: 's1',
    name: 'Berlin',
    plantKind: 'eigenverbrauch',
    netzladenErlaubt: false,
    batteryWithoutDevice: false,
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
    expect(fleetHeadline('direktvermarktung')).toBe('Ihr VoltPilot-Mehrerl\u00f6s');
    expect(realizedSubline('direktvermarktung', 'day', NOW, null)).toBe('heute mehr verdient');
  });

  it('only Eigenverbrauch speaks avoided cost', () => {
    expect(fleetKind(['eigenverbrauch'])).toBe('eigenverbrauch');
    expect(fleetHeadline('eigenverbrauch')).toBe('Ihr VoltPilot-Vorteil');
    expect(realizedSubline('eigenverbrauch', 'day', NOW, null)).toBe('heute gespart');
  });

  it('a mixed fleet gets the neutral headline and verb', () => {
    expect(fleetKind(['direktvermarktung', 'eigenverbrauch'])).toBe('gemischt');
    expect(fleetHeadline('gemischt')).toBe('Ihr VoltPilot-Vorteil');
    expect(realizedSubline('gemischt', 'day', NOW, null)).toBe(
      'heute herausgeholt, alle Standorte zusammen',
    );
  });

  it('an empty list counts as gemischt-neutral', () => {
    expect(fleetKind([])).toBe('gemischt');
  });
});

describe('rangePhrase (hero period wording)', () => {
  it('names the Berlin month and year', () => {
    expect(rangePhrase('day', NOW, null)).toBe('heute');
    expect(rangePhrase('month', NOW, null)).toBe('im Juli');
    expect(rangePhrase('year', NOW, null)).toBe('im Jahr 2026');
  });

  it('dates a Gesamt view at the first covered day', () => {
    expect(rangePhrase('all', NOW, '2026-06-20')).toBe('seit dem 20. Juni 2026');
    expect(rangePhrase('all', NOW, null)).toBe('insgesamt');
  });

  it('composes the subline: "im Juli gespart"', () => {
    expect(realizedSubline('eigenverbrauch', 'month', NOW, null)).toBe('im Juli gespart');
    expect(realizedSubline('direktvermarktung', 'all', NOW, '2026-06-20')).toBe(
      'seit dem 20. Juni 2026 mehr verdient',
    );
  });
});

describe('proofLine (sign-honest two-number framing)', () => {
  it('Direktvermarktung reads revenue: Erl\u00f6s = -actual', () => {
    // actual -474.38 \u20ac cost = 474.38 \u20ac revenue; baseline -436 \u20ac = 436 \u20ac.
    const p = proofLine('direktvermarktung', -436.0, -474.38);
    expect(p.mitLabel).toBe('Erl\u00f6s mit VoltPilot');
    expect(p.ohneLabel).toBe('Ungeregelt w\u00e4ren es');
    expect(p.mitEur).toBeCloseTo(474.38);
    expect(p.ohneEur).toBeCloseTo(436.0);
  });

  it('Eigenverbrauch reads costs as they are', () => {
    const p = proofLine('eigenverbrauch', 150.52, 112.1);
    expect(p.mitLabel).toBe('Stromkosten mit VoltPilot');
    expect(p.ohneLabel).toBe('Ohne Speicher w\u00e4ren es');
    expect(p.mitEur).toBeCloseTo(112.1);
    expect(p.ohneEur).toBeCloseTo(150.52);
  });

  it('flips a net-export Eigenverbrauch period to revenue framing (no negative costs)', () => {
    const p = proofLine('eigenverbrauch', -5.0, -8.0);
    expect(p.mitLabel).toBe('Erl\u00f6s mit VoltPilot');
    expect(p.mitEur).toBeCloseTo(8.0);
    expect(p.ohneEur).toBeCloseTo(5.0);
  });

  it('a mixed fleet with net costs keeps cost framing (Ungeregelt counterfactual)', () => {
    const p = proofLine('gemischt', 100.0, 80.0);
    expect(p.mitLabel).toBe('Stromkosten mit VoltPilot');
    expect(p.ohneLabel).toBe('Ungeregelt w\u00e4ren es');
  });

  it('MIXED signs get per-row verbs and absolute amounts - never a minus sign', () => {
    // Earned 12,89 \u20ac with VoltPilot; would have PAID 12,89 \u20ac without.
    const p = proofLine('eigenverbrauch', 12.89, -12.89);
    expect(p.mitLabel).toBe('Mit VoltPilot verdient');
    expect(p.ohneLabel).toBe('Ohne Speicher h\u00e4tten Sie gezahlt');
    expect(p.mitEur).toBeCloseTo(12.89);
    expect(p.ohneEur).toBeCloseTo(12.89);

    // The reverse mix on a marketed plant reads "Ungeregelt".
    const q = proofLine('direktvermarktung', -5.0, 2.0);
    expect(q.mitLabel).toBe('Mit VoltPilot gezahlt');
    expect(q.ohneLabel).toBe('Ungeregelt h\u00e4tten Sie verdient');
    expect(q.mitEur).toBeCloseTo(2.0);
    expect(q.ohneEur).toBeCloseTo(5.0);
  });
});

describe('realizedFinePrint', () => {
  it('says measured x B\u00f6rsenpreise vs. unregulated plant', () => {
    const t = realizedFinePrint('eigenverbrauch', 'month', null);
    expect(t).toContain('gemessenen Werten');
    expect(t).toContain('B\u00f6rsenstrompreisen');
    expect(t).toContain('ungeregelten Anlage');
    expect(t).not.toContain('Marktpr\u00e4mie');
  });

  it('mentions the Marktpr\u00e4mie for DV and mixed fleets (amount stays out)', () => {
    expect(realizedFinePrint('direktvermarktung', 'month', null)).toContain(
      'zzgl. Marktpr\u00e4mie',
    );
    expect(realizedFinePrint('gemischt', 'month', null)).toContain('zzgl. Marktpr\u00e4mie');
  });

  it('dates a Gesamt view honestly', () => {
    expect(realizedFinePrint('eigenverbrauch', 'all', '2026-06-20')).toContain(
      'seit dem 20. Juni 2026',
    );
  });

  it('a configured premium flips to "inkl." with the negative-price caveat', () => {
    const t = realizedFinePrint('direktvermarktung', 'month', null, true);
    expect(t).toContain('Inkl. Marktprämie');
    expect(t).toContain('entfällt bei negativen Preisen');
    expect(t).not.toContain('zzgl. Marktprämie');
    // Mixed fleets with a premium-configured DV site say it too.
    expect(realizedFinePrint('gemischt', 'month', null, true)).toContain('Inkl. Marktprämie');
    // Eigenverbrauch never mentions the premium, configured or not.
    expect(realizedFinePrint('eigenverbrauch', 'month', null, true)).not.toContain(
      'Marktprämie',
    );
  });

  it('explains the Netzladen attribution in one sentence when the line is shown', () => {
    const t = realizedFinePrint('direktvermarktung', 'month', null, false, true);
    expect(t).toContain('Netzladen-Anteil');
    expect(t).toContain('Verkaufserlös der aus dem Netz geladenen Energie');
    expect(t).toContain('abzüglich ihrer Einkaufskosten');
    // Without the line the fine print stays silent about Netzladen.
    expect(realizedFinePrint('direktvermarktung', 'month', null)).not.toContain('Netzladen');
    expect(realizedFinePrint('eigenverbrauch', 'month', null, false, true)).toContain(
      'Netzladen-Anteil',
    );
  });
});

describe('arbitrageLine ("davon durch Netzladen verdient")', () => {
  it('renders the calm extra line for a positive attribution', () => {
    expect(arbitrageLine(3.4)).toBe(
      'davon durch Netzladen verdient: +3,40 €',
    );
  });

  it('is silent (null) without an attribution - EEG sites and ranges without grid charging', () => {
    expect(arbitrageLine(null)).toBeNull();
  });

  it('a losing period says so plainly instead of pretending a Verdienst', () => {
    expect(arbitrageLine(-0.8)).toBe(
      'Netzladen hat in diesem Zeitraum 0,80 € gekostet',
    );
  });

  it('never renders a negative zero', () => {
    expect(arbitrageLine(-0.0001)).toBe(
      'davon durch Netzladen verdient: +0,00 €',
    );
  });
});

describe('premiumIncluded (do the numbers contain a Marktprämie?)', () => {
  it('true only when a DV site has one configured', () => {
    expect(premiumIncluded([{ plantKind: 'direktvermarktung', marktpraemieCtKwh: 0.6 }])).toBe(
      true,
    );
    expect(premiumIncluded([{ plantKind: 'direktvermarktung', marktpraemieCtKwh: null }])).toBe(
      false,
    );
    // A stale premium on an Eigenverbrauch site is inert (backend gates on
    // the plant kind), so the fine print must not claim it is included.
    expect(premiumIncluded([{ plantKind: 'eigenverbrauch', marktpraemieCtKwh: 0.6 }])).toBe(
      false,
    );
    expect(
      premiumIncluded([
        { plantKind: 'eigenverbrauch', marktpraemieCtKwh: null },
        { plantKind: 'direktvermarktung', marktpraemieCtKwh: 1.2 },
      ]),
    ).toBe(true);
  });
});

describe('parsePremiumInput / premiumInputText (Marktprämie form field)', () => {
  it('accepts German comma and dot decimals', () => {
    expect(parsePremiumInput('0,60')).toBe(0.6);
    expect(parsePremiumInput('0.6')).toBe(0.6);
    expect(parsePremiumInput(' 1 ')).toBe(1);
    expect(parsePremiumInput('0')).toBe(0);
  });

  it('empty means not configured (null)', () => {
    expect(parsePremiumInput('')).toBeNull();
    expect(parsePremiumInput('   ')).toBeNull();
  });

  it('rejects garbage and negative values (undefined = form error)', () => {
    expect(parsePremiumInput('abc')).toBeUndefined();
    expect(parsePremiumInput('-0,5')).toBeUndefined();
    expect(parsePremiumInput('1,2,3')).toBeUndefined();
  });

  it('round-trips the stored value back into German form text', () => {
    expect(premiumInputText(0.6)).toBe('0,6');
    expect(premiumInputText(null)).toBe('');
    expect(parsePremiumInput(premiumInputText(1.25))).toBe(1.25);
  });
});

describe('siteEarnText (per-site wording, measured)', () => {
  it('uses the SITE kind and a German amount', () => {
    expect(siteEarnText('eigenverbrauch', 1.1)).toBe('Heute +1,10\u00a0\u20ac gespart');
    expect(siteEarnText('direktvermarktung', 0.85)).toBe('Heute +0,85\u00a0\u20ac mehr verdient');
  });

  it('is silent (null) without a computable value - never a fake zero', () => {
    expect(siteEarnText('eigenverbrauch', null)).toBeNull();
  });

  it('keeps a negative measured value honest (losses debit VoltPilot)', () => {
    expect(siteEarnText('direktvermarktung', -0.2)).toBe('Heute -0,20\u00a0\u20ac mehr verdient');
  });

  it('never renders a negative zero', () => {
    expect(siteEarnText('eigenverbrauch', -0.0001)).toBe('Heute +0,00\u00a0\u20ac gespart');
  });
});

describe('netzladenBadge (grid-charging mode)', () => {
  it('EEG default reads "Nur Solarladen (EEG)" in green', () => {
    expect(netzladenBadge(false)).toEqual({ label: 'Nur Solarladen (EEG)', kind: 'eeg' });
  });

  it('admin-enabled grid charging reads "Netzladen aktiv" in cyan', () => {
    expect(netzladenBadge(true)).toEqual({ label: 'Netzladen aktiv', kind: 'netzladen' });
  });
});

describe('battery-without-device warning copy', () => {
  it('names the problem and the fix without internal jargon', () => {
    expect(BATTERY_NO_DEVICE_WARNING).toContain('keinem Gerät zugeordnet');
    expect(BATTERY_NO_DEVICE_WARNING).toContain('Fahrplan kann nicht ausgeführt werden');
    // Customer-facing: no internal vocabulary leaks.
    expect(BATTERY_NO_DEVICE_WARNING).not.toMatch(/optimizer|broker|MQTT|device_id/i);
    expect(BATTERY_NO_DEVICE_SHORT).toBe('Speicher ohne Gerät');
  });
});

describe('daily saved helpers', () => {
  const earnSite = (id: string, dailySaved: { day: string; savedEur: number }[]): EarningsSite => ({
    id,
    name: id,
    plantKind: 'eigenverbrauch',
    marktpraemieCtKwh: null,
    baselineEur: null,
    actualEur: null,
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 0,
    firstCoveredDate: null,
    reason: null,
    dailySaved,
  });

  it('savedOnDay picks the exact Berlin day, else null', () => {
    const daily = [
      { day: '2026-07-05', savedEur: 0.4 },
      { day: '2026-07-06', savedEur: 1.2 },
    ];
    expect(savedOnDay(daily, '2026-07-06')).toBe(1.2);
    expect(savedOnDay(daily, '2026-07-04')).toBeNull();
  });

  it('berlinDay converts an instant to the Berlin calendar day', () => {
    // 23:30 UTC on July 5 is already July 6 in Berlin (CEST).
    expect(berlinDay(new Date('2026-07-05T23:30:00Z'))).toBe('2026-07-06');
  });

  it('fleetDailySaved merges the sites per day, sorted', () => {
    const merged = fleetDailySaved([
      earnSite('a', [
        { day: '2026-07-06', savedEur: 1.0 },
        { day: '2026-07-05', savedEur: 0.5 },
      ]),
      earnSite('b', [{ day: '2026-07-06', savedEur: 0.25 }]),
    ]);
    expect(merged).toEqual([
      { day: '2026-07-05', savedEur: 0.5 },
      { day: '2026-07-06', savedEur: 1.25 },
    ]);
  });
});

describe('sparkDays (fixed 14-day axis)', () => {
  it('pads missing days with null slots, oldest first, ending today (Berlin)', () => {
    const days = sparkDays(
      [
        { day: '2026-07-05', savedEur: 0.4 },
        { day: '2026-07-06', savedEur: 1.2 },
      ],
      NOW,
    );
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({ day: '2026-06-23', savedEur: null });
    expect(days[12]).toEqual({ day: '2026-07-05', savedEur: 0.4 });
    expect(days[13]).toEqual({ day: '2026-07-06', savedEur: 1.2 });
  });
});

describe('notComputableHint', () => {
  it('explains each reason in plain German', () => {
    expect(notComputableHint('missing_channels')).toContain('Messwerte');
    expect(notComputableHint('no_prices')).toContain('B\u00f6rsenpreise');
    expect(notComputableHint('no_data')).toContain('Messwerte');
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

describe('siteSnapshot (overview row -> EnergyFlow snapshot)', () => {
  it('derives the battery from the power balance and sanitizes the SoC', () => {
    const snap = siteSnapshot({ ts: NOW.toISOString(), pvKw: 3.2, loadKw: 1.1, gridKw: -0.9, socPct: 76 });
    expect(snap.pvKw).toBe(3.2);
    expect(snap.loadKw).toBe(1.1);
    expect(snap.gridKw).toBe(-0.9);
    // battery = grid - load + pv = -0.9 - 1.1 + 3.2
    expect(snap.battKw).toBeCloseTo(1.2, 10);
    expect(snap.socPct).toBe(76);
    expect(snap.socAt).toBe(NOW.toISOString());
  });

  it('keeps absent channels absent and drops an implausible SoC (never fake zeros)', () => {
    const snap = siteSnapshot({ ts: NOW.toISOString(), pvKw: 3.2, loadKw: null, gridKw: -0.9, socPct: 1270 });
    expect(snap.loadKw).toBeNull();
    expect(snap.battKw).toBeNull();
    expect(snap.socPct).toBeNull();
    expect(snap.socAt).toBeNull();
  });

  it('a missing live row is the all-absent snapshot', () => {
    const snap = siteSnapshot(null);
    expect(snap).toEqual({ pvKw: null, loadKw: null, gridKw: null, battKw: null, socPct: null, socAt: null });
  });
});

describe('composeSiteSentence (single-site Übersicht)', () => {
  it('is green with the live energy sentence when everything reports fresh', () => {
    const s = composeSiteSentence(site({}), NOW);
    expect(s.tone).toBe('ok');
    expect(s.text).toBe(
      'Alles läuft. Ihre Anlage erzeugt gerade 3,2 kW. Die Batterie lädt (76 %). 0,9 kW fließen ins Netz.',
    );
  });

  it('stays green but says values are in transit when online with an old observation (replay)', () => {
    const oldTs = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    const s = composeSiteSentence(
      site({ live: { ts: oldTs, pvKw: 1, loadKw: 1, gridKw: 0, socPct: 50 } }),
      NOW,
    );
    expect(s.tone).toBe('ok');
    expect(s.text).toBe('Alles läuft. Ihr Gerät ist online - die neuesten Messwerte werden gerade übertragen.');
  });

  it('speaks plural for several online devices without fresh values', () => {
    const s = composeSiteSentence(site({ deviceCount: 3, onlineCount: 3, live: null }), NOW);
    expect(s.text).toBe('Alles läuft. 3 von 3 Geräten online - die neuesten Messwerte werden gerade übertragen.');
  });

  it('one silent device turns the sentence amber with what to check', () => {
    const s = composeSiteSentence(site({ onlineCount: 0, worstStatus: 'stale' }), NOW);
    expect(s.tone).toBe('warn');
    expect(s.text).toBe(
      'Ihr Gerät meldet sich nicht. Bitte prüfen Sie, ob das Gerät mit Strom und Internet verbunden ist.',
    );
  });

  it('counts silent devices among several', () => {
    const one = composeSiteSentence(site({ deviceCount: 3, onlineCount: 2, worstStatus: 'stale' }), NOW);
    expect(one.tone).toBe('warn');
    expect(one.text).toContain('1 von 3 Geräten meldet sich nicht.');
    const two = composeSiteSentence(site({ deviceCount: 3, onlineCount: 1, worstStatus: 'stale' }), NOW);
    expect(two.text).toContain('2 von 3 Geräten melden sich nicht.');
  });

  it('a waiting device gets the calm onboarding wording (silent beats waiting)', () => {
    const s = composeSiteSentence(
      site({ deviceCount: 1, onlineCount: 0, waitingCount: 1, worstStatus: 'waiting', live: null }),
      NOW,
    );
    expect(s.tone).toBe('warn');
    expect(s.text).toBe('Ihr Gerät ist verbunden und wartet auf die ersten Daten.');
    const mixed = composeSiteSentence(
      site({ deviceCount: 2, onlineCount: 0, waitingCount: 1, worstStatus: 'stale' }),
      NOW,
    );
    expect(mixed.text).toContain('meldet sich nicht');
  });

  it('no devices is the muted empty tone', () => {
    const s = composeSiteSentence(site({ deviceCount: 0, onlineCount: 0, worstStatus: null, live: null }), NOW);
    expect(s.tone).toBe('off');
    expect(s.text).toBe('Hier ist noch kein Gerät verbunden.');
  });
});
