import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveDefault,
  effectiveProfile,
  emphasisFor,
  isUsageProfile,
  strategyNodeType,
  type ProfileSignals,
} from './usageProfile';

// The ONE shared vector file, also consumed by the Java twin
// (UsageProfileDeriverTest) - asserting deriveDefault/effectiveProfile/emphasisFor
// here AND in Java proves the two produce the same profile. vitest runs with
// cwd = frontend/portal, so the repo root is two levels up.
const vectorsPath = resolve(process.cwd(), '../../docs/contracts/v2/usage-profile-vectors.json');

interface RawSignals {
  has_storage: boolean;
  has_pv: boolean;
  has_controllable_consumer: boolean;
  active_strategy_node_types: string[];
  plant_kind: string | null;
  has_charge_point: boolean;
  has_leistungspreis: boolean;
  override: string | null;
}

interface VectorFile {
  emphasis: Record<string, Record<string, string>>;
  derivation: {
    name: string;
    signals: RawSignals;
    expected_derived: string;
    expected_profile: string;
  }[];
}

const vectors: VectorFile = JSON.parse(readFileSync(vectorsPath, 'utf8'));

function signals(s: RawSignals): ProfileSignals {
  return {
    hasStorage: s.has_storage,
    hasPv: s.has_pv,
    hasControllableConsumer: s.has_controllable_consumer,
    hasChargePoint: s.has_charge_point,
    activeStrategyNodeTypes: s.active_strategy_node_types,
    plantKind: s.plant_kind,
    hasLeistungspreis: s.has_leistungspreis,
    override: s.override,
  };
}

describe('usageProfile deriver (shared vectors)', () => {
  it('has cases', () => {
    expect(vectors.derivation.length).toBeGreaterThan(0);
  });

  for (const c of vectors.derivation) {
    it(c.name, () => {
      const s = signals(c.signals);
      expect(deriveDefault(s)).toBe(c.expected_derived);
      expect(effectiveProfile(s)).toBe(c.expected_profile);
    });
  }
});

describe('usageProfile emphasis map (shared vectors)', () => {
  for (const profile of ['arbitrage', 'peak', 'laden', 'private']) {
    it(profile, () => {
      expect(emphasisFor(profile)).toEqual(vectors.emphasis[profile]);
    });
  }

  it('unknown profile falls back to the private emphasis', () => {
    expect(emphasisFor('grey')).toEqual(vectors.emphasis.private);
  });
});

describe('usageProfile helpers', () => {
  it('isUsageProfile guards the SETTABLE override vocabulary (private is derived-only)', () => {
    expect(isUsageProfile('arbitrage')).toBe(true);
    expect(isUsageProfile('peak')).toBe(true);
    expect(isUsageProfile('private')).toBe(false);
    // laden ist ebenfalls ABGELEITET, nie wählbar (Lastmanagement Stufe 3).
    expect(isUsageProfile('laden')).toBe(false);
    expect(isUsageProfile('grey')).toBe(false);
    expect(isUsageProfile(null)).toBe(false);
  });

  it('strategyNodeType maps each profile (private has no starter)', () => {
    expect(strategyNodeType('arbitrage')).toBe('vp.strategy.market');
    expect(strategyNodeType('peak')).toBe('vp.strategy.peakshaving');
    expect(strategyNodeType('private')).toBeNull();
    // Lastmanagement ist SCHUTZ, keine Marktteilnahme - es gibt keinen
    // Strategie-Knoten und damit auch keinen Starter-Flow (Konzept §5.2).
    expect(strategyNodeType('laden')).toBeNull();
    expect(strategyNodeType('grey')).toBeNull();
  });
});
