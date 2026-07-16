import { describe, expect, it } from 'vitest';
import { NBSP } from './format';
import {
  assumptionsFootnote,
  beispielDatum,
  headlineSentence,
  monthLabel,
  monthlyChartData,
  netzladenLine,
  progressLabel,
  scenarioCards,
  sweepChartData,
  sweepInsight,
  type SimulationResult,
  type SweepEntry,
} from './simulation';

const HEADLINE = {
  gesamtVorteilEur: 364.0,
  gesamtVorteilNettoEur: 356.7,
  speicherVorteilEur: 356.71,
  voltpilotVorteilEur: 7.03,
  voltpilotVorteilNettoEur: 7.04,
};

function result(overrides: Partial<SimulationResult> = {}): SimulationResult {
  return {
    scenarios: {
      ohneSpeicher: {
        kostenEur: 239.45,
        importKwh: 2911,
        exportKwh: 6922,
        monatlich: [
          { monat: '2025-01', kostenEur: 60, wearEur: 0, importKwh: 400, exportKwh: 100 },
          { monat: '2025-02', kostenEur: 40, wearEur: 0, importKwh: 300, exportKwh: 200 },
        ],
      },
      standardSpeicher: {
        kostenEur: -117.26,
        importKwh: 900,
        exportKwh: 5000,
        wearEur: 75.2,
        nettoKostenEur: -42.06,
        vollzyklen: 188,
        eigenverbrauchsquotePct: 61,
        autarkiegradPct: 74,
        abgeregeltKwh: 0,
        monatlich: [
          { monat: '2025-01', kostenEur: 10, wearEur: 6, importKwh: 100, exportKwh: 80 },
          { monat: '2025-02', kostenEur: -5, wearEur: 6, importKwh: 90, exportKwh: 90 },
        ],
      },
      voltpilot: {
        kostenEur: -124.29,
        importKwh: 850,
        exportKwh: 5100,
        wearEur: 48.6,
        nettoKostenEur: -75.69,
        vollzyklen: 121,
        eigenverbrauchsquotePct: 62,
        autarkiegradPct: 75,
        abgeregeltKwh: 12,
        monatlich: [
          { monat: '2025-01', kostenEur: 8, wearEur: 4, importKwh: 95, exportKwh: 85 },
          // Chunk not solved yet: exactly zero while ohneSpeicher priced it.
          { monat: '2025-02', kostenEur: 0, wearEur: 0, importKwh: 0, exportKwh: 0 },
        ],
      },
    },
    headline: HEADLINE,
    sizeSweep: [
      { capacityKwh: 5, gesamtVorteilEur: 285.05, voltpilotVorteilEur: 9.2, istBasisgroesse: false },
      { capacityKwh: 10, gesamtVorteilEur: 364.0, voltpilotVorteilEur: 7.0, istBasisgroesse: true },
      { capacityKwh: 15, gesamtVorteilEur: 370.0, voltpilotVorteilEur: 6.5, istBasisgroesse: false },
    ],
    netzladenVariante: {
      kostenEur: -78.38,
      wearEur: 60,
      nettoKostenEur: -18.38,
      vollzyklen: 210,
      abgeregeltKwh: 0,
      zusatzVorteilNettoEur: -57.31,
    },
    beispielTage: null,
    annahmen: {
      preisjahr: '2025',
      zone: 'DE-LU',
      wetter: 'open-meteo-archive',
      profil: 'haushalt',
      hinweis: 'Simulation, keine Garantie',
    },
    ...overrides,
  };
}

describe('headlineSentence', () => {
  it('leads with the captain framing: Speicher + VoltPilot vs. ohne Speicher (net)', () => {
    const s = headlineSentence(HEADLINE, '2025');
    expect(s).toContain('Im Jahr 2025');
    expect(s).toContain(`356,70${NBSP}€ mehr erwirtschaftet als ohne Speicher`);
    expect(s).toContain(`7,04${NBSP}€ durch die intelligente VoltPilot-Steuerung`);
  });

  it('is sign-honest when the standard battery wins or ties', () => {
    expect(
      headlineSentence({ ...HEADLINE, voltpilotVorteilNettoEur: -12 }, '2025'),
    ).toContain('Standard-Speicher hätte in diesem Jahr');
    expect(
      headlineSentence({ ...HEADLINE, voltpilotVorteilNettoEur: 0.4 }, '2025'),
    ).toContain('auf Augenhöhe');
  });

  it('handles a net-negative total honestly', () => {
    const s = headlineSentence({ ...HEADLINE, gesamtVorteilNettoEur: -30 }, '2024');
    expect(s).toContain('weniger erwirtschaftet als ohne Speicher');
  });
});

describe('netzladenLine', () => {
  it('is a calm potential line when positive', () => {
    const line = netzladenLine({
      kostenEur: 0, wearEur: 0, nettoKostenEur: 0, vollzyklen: null,
      abgeregeltKwh: 0, zusatzVorteilNettoEur: 171.2,
    });
    expect(line).toContain('Ihr Potenzial mit Netzladen');
    expect(line).toContain(`+171,20${NBSP}€`);
  });

  it('says plainly when Netzladen would LOSE money (the EEG pointe)', () => {
    const line = netzladenLine(result().netzladenVariante);
    expect(line).toContain('nicht lohnen');
    expect(line).toContain('EEG-Vergütung');
  });

  it('is null without the variant (site already grid-charges)', () => {
    expect(netzladenLine(null)).toBeNull();
  });
});

describe('scenarioCards', () => {
  it('builds the fully-visible 3-way breakdown, revenue-positive framing', () => {
    const cards = scenarioCards(result());
    expect(cards.map((c) => c.key)).toEqual(['ohneSpeicher', 'standardSpeicher', 'voltpilot']);
    expect(cards[0].amountLabel).toBe('Stromkosten');
    expect(cards[1].amountLabel).toBe('Überschuss'); // net -42.06
    expect(cards[2].highlight).toBe(true);
    expect(cards[2].subLines.join(' ')).toContain('Speicherverschleiß');
    expect(cards[2].subLines.join(' ')).toContain('Vollzyklen');
    expect(cards[2].subLines.join(' ')).toContain('abgeregelt');
  });

  it('renders only the scenarios that exist (progressive job)', () => {
    const cards = scenarioCards(result({ scenarios: { ohneSpeicher: result().scenarios.ohneSpeicher } }));
    expect(cards).toHaveLength(1);
  });
});

describe('monthlyChartData', () => {
  it('aligns months, sums net cost, and marks unsolved chunks as null', () => {
    const data = monthlyChartData(result());
    expect(data?.labels).toEqual(['Jan', 'Feb']);
    expect(data?.ohne).toEqual([60, 40]);
    expect(data?.standard).toEqual([16, 1]); // kosten + wear
    expect(data?.voltpilot).toEqual([12, null]); // Feb chunk pending
  });

  it('is null before any scenario exists', () => {
    expect(monthlyChartData(result({ scenarios: {} }))).toBeNull();
  });

  it('labels months in German', () => {
    expect(monthLabel('2025-03')).toBe('Mär');
    expect(monthLabel('2025-12')).toBe('Dez');
  });
});

describe('sweep', () => {
  it('chart data marks the base size', () => {
    const data = sweepChartData(result().sizeSweep);
    expect(data?.sizes).toEqual([5, 10, 15]);
    expect(data?.baseIndex).toBe(1);
  });

  it('insight names the flat marginal value at the household knee', () => {
    const text = sweepInsight(result().sizeSweep);
    expect(text).toContain('kaum noch etwas');
  });

  it('insight recommends more capacity when the curve still climbs', () => {
    const sweep: SweepEntry[] = [
      { capacityKwh: 30, gesamtVorteilEur: 1000, voltpilotVorteilEur: 100, istBasisgroesse: true },
      { capacityKwh: 60, gesamtVorteilEur: 1400, voltpilotVorteilEur: 150, istBasisgroesse: false },
    ];
    expect(sweepInsight(sweep)).toContain('zusätzlich');
  });

  it('is silent without a larger candidate', () => {
    const data = sweepChartData([]);
    expect(data).toBeNull();
  });
});

describe('copy helpers', () => {
  it('progressLabel reports the fraction', () => {
    expect(progressLabel({ status: 'running', progress: 0.42 })).toBe(
      'Simulation läuft – 42 % gerechnet',
    );
    expect(progressLabel({ status: 'queued', progress: 0 })).toContain('wartet');
  });

  it('footnote names year, profile and the no-promise clause', () => {
    const text = assumptionsFootnote(result().annahmen);
    expect(text).toContain('2025');
    expect(text).toContain('typisches Haushaltsprofil');
    expect(text).toContain('keine Zusage');
  });

  it('footnote flags missing Marktwert months', () => {
    const text = assumptionsFootnote({ ...result().annahmen, fehlendeMarktwertMonate: ['2025-01'] });
    expect(text).toContain('Monatsmarktwert');
  });

  it('beispielDatum renders German dates', () => {
    expect(beispielDatum('2025-11-12')).toBe('12. November 2025');
  });
});
