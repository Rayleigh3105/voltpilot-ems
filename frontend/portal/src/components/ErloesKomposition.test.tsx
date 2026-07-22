import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EarningsSite } from '../api';
import { ErloesKomposition } from './ErloesKomposition';
import { activeModes, moneyStreams } from '../surface';

const NOW = new Date('2026-07-21T10:00:00Z');

function money(over: Partial<EarningsSite> = {}): EarningsSite {
  return {
    id: 's1',
    name: 'Hof Lindenberg',
    plantKind: 'eigenverbrauch',
    anzulegenderWertCtKwh: null,
    realizedExportCtKwh: null,
    marketValueSolarCtKwh: null,
    marketValueProvisional: null,
    baselineEur: null,
    actualEur: null,
    savedEur: null,
    arbitrageEur: null,
    pvShiftEur: null,
    coveredSlots: 0,
    firstCoveredDate: null,
    reason: null,
    dailySaved: [],
    tarifArt: 'dynamisch',
    tarifParamCtKwh: 18,
    einspeiseErloesEur: null,
    eigenverbrauchsWertEur: null,
    gesamtertragEur: null,
    selbstverbrauchKwh: null,
    eingespeistKwh: null,
    batterieBewegtKwh: null,
    expectedMarketValueSolarCtKwh: null,
    expectedMarketValueFrom: null,
    expectedMarketValueTo: null,
    expectedMarketValueSlots: null,
    series: [],
    monthlyStrip: [],
    ...over,
  };
}

const multiModus = () =>
  moneyStreams(
    activeModes({
      signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] },
      config: { tarifArt: 'dynamisch', netzladenErlaubt: true, leistungspreisEurKw: 120 },
      entities: [{ id: 'e1', entityType: 'battery-hybrid' }],
      flows: [
        {
          flowId: 'f1',
          name: 'Wallbox bei PV-Überschuss',
          activeVersion: 1,
          latestLifecycle: 'active',
          latestDocument: {
            schemaVersion: '1.0',
            flowId: 'f1',
            flowVersion: 1,
            siteId: 's1',
            name: 'Wallbox bei PV-Überschuss',
            lifecycle: 'active',
            nodes: [{ id: 'n1', type: 'vp.entity.control', config: {} }],
            edges: [],
            claims: [],
          } as never,
        },
      ],
    }),
  );

const fullMoney = () =>
  money({
    savedEur: 89,
    eigenverbrauchsWertEur: 41,
    einspeiseErloesEur: 12,
    peakShaving: {
      leistungspreisEurKw: 120,
      abrechnung: 'jahr',
      periodStart: '2026-01-01',
      peakKw: null,
      baselinePeakKw: null,
      avoidedKw: 9,
      avoidedEur: 1204,
      history: [],
    },
  });

describe('<ErloesKomposition>', () => {
  it('rendert eine Zeile je Strom mit ihrem eigenen Perioden-Etikett', () => {
    render(
      <ErloesKomposition
        streams={multiModus()}
        money={fullMoney()}
        range="month"
        at={NOW}
        now={NOW}
      />,
    );
    expect(screen.getByText('Vermiedene Leistungskosten')).toBeInTheDocument();
    // MIG §5: der Markt-Modus weist den ECHTEN Erlös aus (der Steuerungs-
    // Beitrag ist die Zurechnung darunter, kein eigener Summand).
    expect(screen.getByText('Einspeise-Erlös')).toBeInTheDocument();
    expect(screen.getByText('Wert des Eigenverbrauchs')).toBeInTheDocument();
    // Das Perioden-Etikett steht an der Zeile, nicht nur in einer Fußnote.
    expect(screen.getAllByText('Abrechnungsjahr 2026').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Juli').length).toBeGreaterThan(0);
    // Zwei Summen - eine je Periode, nie eine gemischte.
    expect(screen.getByText('Juli gesamt')).toBeInTheDocument();
    expect(screen.getByText('Abrechnungsjahr 2026 gesamt')).toBeInTheDocument();
    expect(screen.getByText(/nicht zu einer Summe/)).toBeInTheDocument();
  });

  it('zeigt die Automations-Zeile als ehrliches „—"', () => {
    render(
      <ErloesKomposition
        streams={multiModus()}
        money={fullMoney()}
        range="month"
        at={NOW}
        now={NOW}
      />,
    );
    expect(screen.getByText('Wallbox bei PV-Überschuss')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('öffnet die ERLÖS-Historie und grenzt sie vom Telemetrie-Verlauf ab', () => {
    const onOpen = vi.fn();
    render(
      <ErloesKomposition
        streams={multiModus()}
        money={fullMoney()}
        range="month"
        at={NOW}
        now={NOW}
        onOpenErloesHistorie={onOpen}
      />,
    );
    const btn = screen.getByRole('button', { name: /Erlöse im Detail/ });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Erlös-Historie – getrennt vom Telemetrie-Verlauf/)).toBeInTheDocument();
  });

  it('rendert nichts, wenn kein Geld-Modus aktiv ist', () => {
    const { container } = render(
      <ErloesKomposition streams={[]} money={null} range="month" at={NOW} now={NOW} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
