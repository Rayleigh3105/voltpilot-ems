import { describe, expect, it } from 'vitest';
import {
  applyProfileStates,
  benefitLine,
  blockedReason,
  originLine,
  profileShelf,
  profileStatesFrom,
  requirementChips,
  unlockChips,
  type SiteProfile,
  type SiteProfiles,
} from './profiles';
import { activeModes, anlageSurface, type AnlageSurfaceInput } from './surface';

function profile(over: Partial<SiteProfile> & { id: string }): SiteProfile {
  return {
    label: over.id,
    state: null,
    derivedActive: false,
    active: false,
    unlocks: { views: [], widgets: [], moneyStream: null },
    requirements: [],
    blockedReason: null,
    origin: null,
    flowRef: null,
    gatedNodeTypes: [],
    gatedNodesEnabled: true,
    ...over,
  };
}

const SHELF: SiteProfiles = {
  profiles: [
    profile({
      id: 'eigenverbrauch',
      label: 'Eigenverbrauch',
      active: true,
      derivedActive: true,
      origin: 'masterdata',
      requirements: [
        { label: 'PV-Erzeugung', met: true },
        { label: 'Speicher', met: true },
      ],
    }),
    profile({
      id: 'marktvermarktung',
      label: 'Marktoptimierung',
      state: 'an',
      active: true,
      requirements: [
        { label: 'Dynamischer Tarif oder Direktvermarktung', met: false },
        { label: 'Speicher', met: true },
      ],
      blockedReason:
        'Für den Handel fehlt der Marktzugang: Ihre Anlage hat weder einen dynamischen ' +
        'Stromtarif noch eine Direktvermarktung hinterlegt. Solange wird nichts am Markt gehandelt.',
      gatedNodeTypes: ['vp.strategy.market'],
      gatedNodesEnabled: false,
    }),
    profile({
      id: 'lastspitzenkappung',
      label: 'Lastspitzenkappung',
      requirements: [
        { label: 'Leistungspreis hinterlegt', met: false },
        { label: 'Speicher', met: true },
      ],
    }),
    profile({
      id: 'atypische-netznutzung',
      label: 'Atypische Netznutzung',
      requirements: [{ label: 'Leistungsmessung', met: false }],
    }),
  ],
};

describe('profileShelf - aktiv zuerst, Unmögliches eingeklappt', () => {
  it('sorts active profiles first and collapses the structurally unreachable', () => {
    const shelf = profileShelf(SHELF);
    // Aktiv (kanonisch: Markt vor Eigenverbrauch), dann erreichbare.
    expect(shelf.cards.map((c) => c.profile.id)).toEqual([
      'marktvermarktung',
      'eigenverbrauch',
      'lastspitzenkappung',
    ]);
    // Kein Chip erfüllt -> unter "Weitere Profile", aber NIE verschwunden.
    expect(shelf.weitere.map((c) => c.profile.id)).toEqual(['atypische-netznutzung']);
    expect(shelf.cards.length + shelf.weitere.length).toBe(SHELF.profiles.length);
  });

  it('is empty-safe (older backend / not loaded)', () => {
    expect(profileShelf(null)).toEqual({ cards: [], weitere: [] });
    expect(profileShelf({ profiles: [] })).toEqual({ cards: [], weitere: [] });
  });
});

describe('Karten-Copy - ehrlich, ohne Anfragewand', () => {
  it('names what is missing, never asks for a request', () => {
    const markt = SHELF.profiles[1];
    expect(requirementChips(markt).map((c) => c.text)).toEqual([
      'Dynamischer Tarif oder Direktvermarktung fehlt',
      'Speicher',
    ]);
    expect(blockedReason(markt)).toContain('Marktzugang');
  });

  it('falls back to an honest sentence when the server gave none', () => {
    const local = profile({
      id: 'lastspitzenkappung',
      active: true,
      requirements: [{ label: 'Leistungspreis hinterlegt', met: false }],
    });
    expect(blockedReason(local)).toBe('Läuft noch nicht: Leistungspreis hinterlegt fehlt.');
  });

  it('has no blockedReason for a profile that is off or fully met', () => {
    expect(blockedReason(SHELF.profiles[2])).toBeNull();
    expect(blockedReason(SHELF.profiles[0])).toBeNull();
  });

  it('says where an active profile comes from', () => {
    expect(originLine(SHELF.profiles[0])).toBe('Von VoltPilot eingerichtet.');
    expect(
      originLine(
        profile({ id: 'x', active: true, origin: 'flow', flowRef: { flowId: 'f', name: 'Regel' } }),
      ),
    ).toContain('Regel');
    expect(originLine(profile({ id: 'x' }))).toBeNull();
  });

  it('NEVER carries request-wall copy (no "Angefragt", no setup wall)', () => {
    const copy = profileShelf(SHELF)
      .cards.concat(profileShelf(SHELF).weitere)
      .flatMap((c) => [c.benefit, c.blockedReason ?? '', ...c.unlocks, ...c.requirements.map((r) => r.text)])
      .join(' | ')
      .toLowerCase();
    expect(copy).not.toContain('angefragt');
    expect(copy).not.toContain('in vorbereitung');
    expect(copy).not.toContain('voltpilot richtet ein');
  });

  it('never invents copy for an unknown profile id', () => {
    const unknown = profile({ id: 'quantenspeicher' });
    expect(benefitLine(unknown)).toBe('Eine zusätzliche Betriebsart Ihrer Anlage.');
    expect(unlockChips(unknown)).toEqual([]);
  });
});

describe('applyProfileStates - das Overlay über die M0-Projektion', () => {
  const PEAK: AnlageSurfaceInput = {
    signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [], hasLeistungspreis: true },
    config: { leistungspreisEurKw: 120 },
    entities: [
      { id: 'e1', entityType: 'battery-hybrid', capabilities: { measure: [{ channel: 'soc_pct' }] } },
    ],
  };

  it('removes a mode the customer switched OFF', () => {
    const derived = activeModes(PEAK);
    expect(derived.map((m) => m.kind)).toContain('lastspitzenkappung');
    const overlaid = applyProfileStates(derived, { lastspitzenkappung: 'aus' });
    expect(overlaid.map((m) => m.kind)).not.toContain('lastspitzenkappung');
  });

  it('`an` never invents a mode the plant cannot structurally have', () => {
    const derived = activeModes(PEAK);
    expect(applyProfileStates(derived, { marktvermarktung: 'an' })).toEqual(derived);
  });

  it('is a no-op without states (older backend) - byte-identical', () => {
    const derived = activeModes(PEAK);
    expect(applyProfileStates(derived, null)).toBe(derived);
    expect(applyProfileStates(derived, undefined)).toBe(derived);
    expect(applyProfileStates(derived, {})).toEqual(derived);
  });

  it('suppresses the mode block, deep views and money stream through the surface', () => {
    const on = anlageSurface(PEAK);
    const off = anlageSurface({ ...PEAK, profileStates: { lastspitzenkappung: 'aus' } });
    expect(on.cockpitBlocks.map((b) => b.id)).toContain('peak-band');
    expect(off.cockpitBlocks.map((b) => b.id)).not.toContain('peak-band');
    expect(on.moneyStreams.map((s) => s.id)).toContain('lastspitzen');
    expect(off.moneyStreams.map((s) => s.id)).not.toContain('lastspitzen');
    expect(off.deepViews).not.toContain('lastspitzen');
  });

  it('leaves automations alone (they are not profiles)', () => {
    const withAutomation: AnlageSurfaceInput = {
      entities: PEAK.entities,
      flows: [
        {
          flowId: 'f1',
          name: 'Wallbox bei PV',
          activeVersion: 1,
          latestLifecycle: 'active',
          latestDocument: { nodes: [{ id: 'n1', type: 'vp.entity.control' }] } as never,
        },
      ],
    };
    const modes = anlageSurface({ ...withAutomation, profileStates: { automation: 'aus' } }).modes;
    expect(modes.map((m) => m.kind)).toContain('automation');
  });
});

describe('profileStatesFrom', () => {
  it('keeps only the stored intent and is null without a response', () => {
    expect(profileStatesFrom(SHELF)).toEqual({ marktvermarktung: 'an' });
    expect(profileStatesFrom(null)).toBeNull();
    expect(profileStatesFrom(undefined)).toBeNull();
  });
});
