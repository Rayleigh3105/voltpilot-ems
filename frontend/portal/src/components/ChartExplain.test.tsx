import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChartDetailToggle, ChartHeadline, ChartLegend } from './ChartExplain';
import { chartDetailKey, initialChartDetail } from '../useChartDetail';

/**
 * Die drei neuen Bausteine der Stufe 1 (K1/K2/K3). Sie sind render-only - die
 * Regeln liegen in `chartKopf.ts`/`useChartDetail.ts` und sind dort geprüft;
 * hier wird die Verdrahtung festgenagelt, allen voran die Ehrlichkeitsregel.
 */
describe('ChartHeadline (K1/M11)', () => {
  it('zeigt Zahl, Satz und Vergleichsanker', () => {
    render(
      <ChartHeadline
        kern={{
          wert: '9,84 €',
          satz: 'Mittags laden, abends verkaufen.',
          grund: null,
          ton: 'ok',
          anker: 'Ohne Speicher wären es 3,10 €.',
        }}
      />,
    );
    expect(screen.getByText('9,84 €')).toBeInTheDocument();
    expect(screen.getByText('Mittags laden, abends verkaufen.')).toBeInTheDocument();
    expect(screen.getByText('Ohne Speicher wären es 3,10 €.')).toBeInTheDocument();
  });

  // Diagnose vp-tagesbild-minus-f3 §6.2: der Bestand steht NEBEN der Kasse,
  // nie darin - die Zahl ist gemessen, dieser Betrag ist nach dem Plan bewertet.
  it('zeigt die Bestandszeile unter der Zahl - mit ihrem Abzeichen', () => {
    render(
      <ChartHeadline
        kern={{
          wert: '-4,69 €',
          satz: 'hat die Steuerung an diesem Tag bisher gebracht.',
          grund: null,
          ton: 'calm',
          bestand: {
            text: 'dazu 44,2 kWh im Speicher für später — nach dem Plan ≈ +8,35 €',
            badge: 'Geplant',
            titel: 'Bewertet mit dem Speicherwert dieser Viertelstunde.',
          },
        }}
      />,
    );
    const satz = screen.getByText(/44,2 kWh im Speicher/);
    expect(satz.closest('p')).toHaveTextContent('Geplant');
    expect(satz.closest('p')).toHaveAttribute(
      'title',
      'Bewertet mit dem Speicherwert dieser Viertelstunde.',
    );
    // Die Kasse bleibt die Kasse.
    expect(screen.getByText('-4,69 €')).toBeInTheDocument();
  });

  it('rendert ohne Bestand nichts Zusätzliches', () => {
    const { container } = render(
      <ChartHeadline kern={{ wert: '2,73 €', satz: 'Ein Satz.', grund: null, ton: 'ok' }} />,
    );
    expect(container.querySelector('.vp-chart-kern-bestand')).toBeNull();
  });

  it('sagt ohne Satz den GRUND - und nennt dabei keine Zahl', () => {
    render(
      <ChartHeadline
        kern={{ wert: '9,84 €', satz: null, grund: 'Für heute liegt noch kein Fahrplan vor.', ton: 'calm' }}
      />,
    );
    expect(screen.getByText('Für heute liegt noch kein Fahrplan vor.')).toBeInTheDocument();
    expect(screen.queryByText('9,84 €')).not.toBeInTheDocument();
  });

  it('rendert GAR NICHTS ohne Satz und ohne Grund - nie ein nacktes „—"', () => {
    const { container } = render(
      <ChartHeadline kern={{ wert: '9,84 €', satz: null, grund: null, ton: 'ok' }} />,
    );
    expect(container.querySelector('.vp-chart-kern')).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('rendert nichts, wenn es gar keine Kernaussage gibt', () => {
    const { container } = render(<ChartHeadline kern={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ChartDetailToggle (K3/M13)', () => {
  it('nennt, WAS dahinter liegt - ein „mehr" ohne Inhaltsangabe ist eine Wundertüte', () => {
    render(<ChartDetailToggle open={false} onToggle={() => {}} was="Batterie, Ladestand" />);
    expect(screen.getByRole('button', { name: /Mehr anzeigen/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByText('Batterie, Ladestand')).toBeInTheDocument();
  });

  it('meldet den offenen Zustand und kehrt die Beschriftung um', () => {
    const onToggle = vi.fn();
    render(<ChartDetailToggle open onToggle={onToggle} was="Ladestand" />);
    const btn = screen.getByRole('button', { name: /Weniger anzeigen/ });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('useChartDetail (die Tiefe wird pro Fläche gemerkt)', () => {
  it('trennt die Flächen über ihren Schlüssel', () => {
    expect(chartDetailKey('messwerte.reihen')).not.toBe(chartDetailKey('fahrplan.schichten'));
    expect(chartDetailKey('a')).toContain('a');
  });

  it('startet im Grundzustand - alles ausser „1" ist zu', () => {
    expect(initialChartDetail(null)).toBe(false);
    expect(initialChartDetail('0')).toBe(false);
    expect(initialChartDetail('kaputt')).toBe(false);
    expect(initialChartDetail('1')).toBe(true);
  });
});

describe('ChartLegend · die Umriss-Form (K5)', () => {
  it('malt eine Umriss-Reihe mit derselben Farbe, nur hohl', () => {
    const { container } = render(
      <ChartLegend
        items={[
          { color: '#2E9E5B', label: 'Batterie lädt', unit: 'kW', shape: 'bar' },
          { color: '#2E9E5B', label: 'Batterie entlädt', unit: 'kW', shape: 'outline' },
        ]}
      />,
    );
    const swatches = container.querySelectorAll('.vp-swatch');
    expect(swatches[0]).toHaveClass('vp-swatch-bar');
    expect(swatches[1]).toHaveClass('vp-swatch-outline');
    // Dieselbe Farbe - die FORM trägt die Richtung, plus das Wort daneben.
    expect(screen.getByText('Batterie lädt')).toBeInTheDocument();
    expect(screen.getByText('Batterie entlädt')).toBeInTheDocument();
  });
});
