import { describe, expect, it } from 'vitest';
import {
  AUTOMATIC_MODULES,
  EINRICHTUNG_DURCH_VOLTPILOT,
  LASTSPITZEN_CUSTOMER_INFO,
  OPTIMIERUNG_INTRO,
  abrechnungLabel,
  buildLastspitzenUpdate,
  isLeistungspreisActive,
  lastspitzenkappungCard,
  lastspitzenPerioden,
  lastspitzenProof,
  marktoptimierungCard,
  marktoptimierungLine,
  parseLastspitzenForm,
  supportsLastspitzenConfig,
  vermiedeneSpitzeLine,
} from './moduleSurface';
import type { PeakShaving } from './api';
import type { OptimizerOverrides } from './optimizerApi';
import { NBSP } from './format';

describe('marktoptimierungCard (always active, plant-kind/tariff aware wording)', () => {
  it('sells for Direktvermarktung, uses for a dynamic Eigenverbrauch tariff', () => {
    expect(marktoptimierungLine('direktvermarktung', 'ohne')).toBe(
      'Ihr Speicher handelt am Strommarkt: günstig laden, teuer verkaufen.',
    );
    expect(marktoptimierungLine('eigenverbrauch', 'dynamisch')).toBe(
      'Ihr Speicher handelt am Strommarkt: günstig laden, teuer nutzen.',
    );
    // Fixed/no tariff: the solar-shifting story, no market-trading claim.
    expect(marktoptimierungLine('eigenverbrauch', 'fest')).toContain('Solarstrom');
    expect(marktoptimierungLine('eigenverbrauch', 'ohne')).toContain('Solarstrom');
  });

  it('is always active and carries the Speicherschonung preset as a sub-line', () => {
    const card = marktoptimierungCard('eigenverbrauch', 'dynamisch', 'ausgewogen', true);
    expect(card.active).toBe(true);
    expect(card.stateLabel).toBe('Aktiv');
    expect(card.subLine).toBe('Umgang mit dem Speicher: Ausgewogen (empfohlen)');
  });

  it('shows the honest admin-configured state and omits the sub-line without a battery', () => {
    expect(marktoptimierungCard('eigenverbrauch', 'ohne', 'individuell', true).subLine).toBe(
      'Umgang mit dem Speicher: Individuell (durch VoltPilot konfiguriert)',
    );
    expect(marktoptimierungCard('eigenverbrauch', 'ohne', null, false).subLine).toBeNull();
  });
});

describe('lastspitzenkappungCard (Tier 2: active vs the honest offer)', () => {
  it('reads absent/null/zero/garbage as NOT active (the backend field ships separately)', () => {
    expect(isLeistungspreisActive(undefined)).toBe(false);
    expect(isLeistungspreisActive(null)).toBe(false);
    expect(isLeistungspreisActive(0)).toBe(false);
    expect(isLeistungspreisActive(-3)).toBe(false);
    expect(isLeistungspreisActive(Number.NaN)).toBe(false);
    expect(isLeistungspreisActive(120)).toBe(true);
  });

  it('active: VoltPilot-managed state with the configured value read-only', () => {
    const card = lastspitzenkappungCard(142.5);
    expect(card.active).toBe(true);
    expect(card.stateLabel).toBe('Aktiv');
    expect(card.managedNote).toBe('Von VoltPilot für Sie eingerichtet.');
    expect(card.subLine).toBe(`Leistungspreis: 142,50${NBSP}€/kW`);
  });

  it('inactive: the calm offer with plain contact text - NO button, NO mailto (decision 2)', () => {
    const card = lastspitzenkappungCard(undefined);
    expect(card.active).toBe(false);
    expect(card.stateLabel).toBe('Verfügbar');
    expect(card.managedNote).toBe('Verfügbar für Ihre Anlage.');
    expect(card.line).toContain('mehrere tausend Euro Leistungspreis im Jahr');
    expect(card.subLine).toBe(EINRICHTUNG_DURCH_VOLTPILOT);
    expect(JSON.stringify(card)).not.toMatch(/mailto|anfragen/i);
  });
});

describe('PS-4 proof (real numbers on the active card + the money-hero line)', () => {
  const peak: PeakShaving = {
    leistungspreisEurKw: 120,
    abrechnung: 'jahr',
    periodStart: '2026-01-01',
    peakKw: 62.4,
    baselinePeakKw: 74.4,
    avoidedKw: 12,
    avoidedEur: 1440,
    history: [],
  };

  it('lastspitzenProof renders the three German rows with de-DE numbers', () => {
    const proof = lastspitzenProof(peak);
    expect(proof).not.toBeNull();
    expect(proof!.note).toBeNull();
    expect(proof!.rows).toEqual([
      {
        label: 'Gehaltene Spitze diese Periode',
        value: `62,4${NBSP}kW`,
      },
      {
        label: 'Vermiedene Spitze',
        value: `12,0${NBSP}kW`,
        tip: expect.stringContaining('ohne Speichereinsatz'),
      },
      { label: 'Ersparte Leistungskosten', value: `+1.440,00${NBSP}€` },
    ]);
    // The counterfactual tip names the configured price + period kind.
    expect(proof!.rows[1].tip).toContain(`120,00${NBSP}€/kW pro Jahr`);
  });

  it('is absent without the block and honest without measurements', () => {
    expect(lastspitzenProof(null)).toBeNull();
    expect(lastspitzenProof(undefined)).toBeNull();
    const empty = lastspitzenProof({
      ...peak,
      peakKw: null,
      baselinePeakKw: null,
      avoidedKw: null,
      avoidedEur: null,
    });
    expect(empty!.rows).toEqual([]);
    expect(empty!.note).toBe(
      'In der laufenden Abrechnungsperiode liegen noch keine Messwerte vor.',
    );
  });

  it('vermiedeneSpitzeLine renders "X kW × Y €/kW = Z €" and hides noise', () => {
    const line = vermiedeneSpitzeLine(peak);
    expect(line).toEqual({
      label: 'Vermiedene Lastspitze',
      value: `12,0${NBSP}kW × 120,00${NBSP}€/kW = 1.440,00${NBSP}€`,
      tip: expect.stringContaining('ohne Speichereinsatz'),
    });
    // No block / no measurement / a floored-to-zero or noise-level avoidance
    // all stay silent - the hero only carries a real result.
    expect(vermiedeneSpitzeLine(null)).toBeNull();
    expect(vermiedeneSpitzeLine(undefined)).toBeNull();
    expect(vermiedeneSpitzeLine({ ...peak, avoidedKw: null, avoidedEur: null })).toBeNull();
    expect(vermiedeneSpitzeLine({ ...peak, avoidedKw: 0, avoidedEur: 0 })).toBeNull();
    expect(vermiedeneSpitzeLine({ ...peak, avoidedKw: 0.04, avoidedEur: 4.8 })).toBeNull();
  });

  it('abrechnungLabel speaks the billing period', () => {
    expect(abrechnungLabel('jahr')).toBe('pro Jahr');
    expect(abrechnungLabel('monat')).toBe('pro Monat');
  });
});

describe('wording discipline (outcome language, zero internals)', () => {
  it('never says Modul/MILP/Optimizer/Solver in customer copy', () => {
    const copy = [
      marktoptimierungLine('direktvermarktung', 'ohne'),
      marktoptimierungLine('eigenverbrauch', 'dynamisch'),
      marktoptimierungLine('eigenverbrauch', 'fest'),
      JSON.stringify(lastspitzenkappungCard(120)),
      JSON.stringify(lastspitzenkappungCard(null)),
      JSON.stringify(marktoptimierungCard('eigenverbrauch', 'ohne', null, true)),
      JSON.stringify(AUTOMATIC_MODULES),
      OPTIMIERUNG_INTRO,
      LASTSPITZEN_CUSTOMER_INFO,
      JSON.stringify(
        lastspitzenProof({
          leistungspreisEurKw: 120,
          abrechnung: 'monat',
          periodStart: '2026-07-01',
          peakKw: 10,
          baselinePeakKw: 12,
          avoidedKw: 2,
          avoidedEur: 240,
          history: [],
        }),
      ),
      JSON.stringify(
        vermiedeneSpitzeLine({
          leistungspreisEurKw: 120,
          abrechnung: 'jahr',
          periodStart: '2026-01-01',
          peakKw: 10,
          baselinePeakKw: 12,
          avoidedKw: 2,
          avoidedEur: 240,
          history: [],
        }),
      ),
    ].join(' ');
    expect(copy).not.toMatch(/Modul|MILP|Optimizer|Solver|Config/i);
  });

  it('carries the two automatic protections, one line + tip each', () => {
    expect(AUTOMATIC_MODULES.map((m) => m.title)).toEqual([
      '§ 14a-Schutz',
      'Negativpreis-Abregelung',
    ]);
    for (const row of AUTOMATIC_MODULES) {
      expect(row.line.length).toBeGreaterThan(10);
      expect(row.tip.length).toBeGreaterThan(20);
    }
  });
});

describe('admin contract fields (defensively probed, sibling task vp-peakshave-core-p1)', () => {
  const base: OptimizerOverrides = {
    wearCostCtPerKwh: 4,
    socMinPct: null,
    socMaxPct: null,
    backupReserveSocPct: 20,
  };

  it('supportsLastspitzenConfig probes key PRESENCE, never truthiness', () => {
    expect(supportsLastspitzenConfig(base)).toBe(false);
    expect(supportsLastspitzenConfig(null)).toBe(false);
    expect(supportsLastspitzenConfig(undefined)).toBe(false);
    // A backend that carries the field with null = supported but not configured.
    expect(supportsLastspitzenConfig({ ...base, leistungspreisEurKw: null })).toBe(true);
    expect(supportsLastspitzenConfig({ ...base, leistungspreisEurKw: 120 })).toBe(true);
  });

  it('parseLastspitzenForm accepts German decimals, requires a positive Leistungspreis', () => {
    expect(
      parseLastspitzenForm({ leistungspreis: '142,5', abrechnung: 'jahr', reserve: '' }),
    ).toEqual({
      ok: true,
      value: {
        leistungspreisEurKw: 142.5,
        leistungspreisAbrechnung: 'jahr',
        lastspitzenReserveKw: null,
      },
    });
    expect(
      parseLastspitzenForm({ leistungspreis: '15', abrechnung: 'monat', reserve: '2,5' }),
    ).toEqual({
      ok: true,
      value: {
        leistungspreisEurKw: 15,
        leistungspreisAbrechnung: 'monat',
        lastspitzenReserveKw: 2.5,
      },
    });
    expect(parseLastspitzenForm({ leistungspreis: '', abrechnung: 'jahr', reserve: '' }).ok).toBe(
      false,
    );
    expect(parseLastspitzenForm({ leistungspreis: '0', abrechnung: 'jahr', reserve: '' }).ok).toBe(
      false,
    );
    expect(
      parseLastspitzenForm({ leistungspreis: '120', abrechnung: 'jahr', reserve: '-1' }).ok,
    ).toBe(false);
  });

  it('buildLastspitzenUpdate carries the received overrides through (full-representation PUT)', () => {
    const received: OptimizerOverrides = { ...base, leistungspreisEurKw: null };
    const set = buildLastspitzenUpdate(received, {
      leistungspreisEurKw: 120,
      leistungspreisAbrechnung: 'jahr',
      lastspitzenReserveKw: null,
    });
    // Untouched overrides ride along - a full-representation PUT with an
    // absent field would CLEAR that override.
    expect(set.wearCostCtPerKwh).toBe(4);
    expect(set.backupReserveSocPct).toBe(20);
    expect(set.leistungspreisEurKw).toBe(120);
    expect(set.leistungspreisAbrechnung).toBe('jahr');

    // Deactivating clears exactly the contract fields.
    const cleared = buildLastspitzenUpdate({ ...received, leistungspreisEurKw: 120 }, null);
    expect(cleared.leistungspreisEurKw).toBeNull();
    expect(cleared.leistungspreisAbrechnung).toBeNull();
    expect(cleared.lastspitzenReserveKw).toBeNull();
    expect(cleared.wearCostCtPerKwh).toBe(4);
  });
});

describe('P1 · die blätterbaren Abrechnungsperioden (V3)', () => {
  const peak = (over: Partial<PeakShaving> = {}): PeakShaving => ({
    leistungspreisEurKw: 120,
    abrechnung: 'jahr',
    periodStart: '2026-01-01',
    peakKw: 8.7,
    baselinePeakKw: 9.4,
    avoidedKw: 0.7,
    avoidedEur: 84,
    history: [
      { periodStart: '2025-01-01', peakKw: 11, baselinePeakKw: 12, avoidedKw: 1, avoidedEur: 120 },
      { periodStart: '2026-01-01', peakKw: 8.5, baselinePeakKw: 9.4, avoidedKw: 0.9, avoidedEur: 108 },
    ],
    ...over,
  });

  it('nennt die Perioden beim Namen — die Art der Abrechnung steht mit drin', () => {
    expect(lastspitzenPerioden(peak()).map((p) => p.label)).toEqual([
      'Abrechnungsjahr 2025',
      'Abrechnungsjahr 2026',
    ]);
    expect(lastspitzenPerioden(peak({ abrechnung: 'monat', periodStart: '2026-09-01', history: [] }))[0].label)
      .toBe('Abrechnung September 2026');
  });

  it('für die LAUFENDE Periode gewinnt der Kopf — er ist der jüngere Stand', () => {
    const p = lastspitzenPerioden(peak());
    const laufend = p[p.length - 1];
    expect(laufend.laufend).toBe(true);
    // 8,7 aus dem Kopf, nicht 8,5 aus der Historien-Zeile.
    expect(laufend.peakKw).toBe(8.7);
    expect(laufend.avoidedEur).toBe(84);
    // Eine vergangene Periode bleibt, was die Historie sagt.
    expect(p[0].peakKw).toBe(11);
    expect(p[0].laufend).toBe(false);
  });

  it('ohne eine einzige gemessene Periode bleibt der LAUFENDE Eintrag — ehrlich mit null', () => {
    const p = lastspitzenPerioden(
      peak({ history: [], peakKw: null, avoidedKw: null, avoidedEur: null }),
    );
    expect(p).toHaveLength(1);
    expect(p[0].laufend).toBe(true);
    expect(p[0].peakKw).toBeNull();
  });

  it('ohne Block gibt es nichts zu blättern', () => {
    expect(lastspitzenPerioden(null)).toEqual([]);
  });
});
