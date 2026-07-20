import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PeakBand } from './PeakBand';
import { peakBand } from '../peakBand';
import type { PeakShaving } from '../api';

const PEAK: PeakShaving = {
  leistungspreisEurKw: 120,
  abrechnung: 'monat',
  periodStart: '2026-07-01',
  peakKw: 142,
  baselinePeakKw: 180,
  avoidedKw: 38,
  avoidedEur: 4560,
  history: [],
};

describe('PeakBand - the render of the peak-face lead artifact', () => {
  it('renders the current mean, the Ziel marker and the PS-4 metrics', () => {
    const view = peakBand({ current: { kw: 142, fresh: true, count: 5 }, targetKw: 180, peak: PEAK });
    const { container } = render(<PeakBand view={view} peak={PEAK} />);

    expect(screen.getByText('Aktuelle ¼-Stunde')).toBeInTheDocument();
    expect(screen.getByText(/142/)).toBeInTheDocument();
    // the Ziel marker + label
    expect(container.querySelector('.vp-peakband-limit')).not.toBeNull();
    expect(screen.getByText(/Ziel/)).toBeInTheDocument();
    // PS-4 proof metrics
    expect(screen.getByText(/Vermiedene Spitze/)).toBeInTheDocument();
    expect(screen.getByText('Ersparte Leistungskosten')).toBeInTheDocument();
    expect(screen.getByText(/4\.560/)).toBeInTheDocument();
  });

  it('shows the honest note (and no fill) when the live value is missing', () => {
    const view = peakBand({ current: { kw: null, fresh: false, count: 0 }, targetKw: 180, peak: PEAK });
    const { container } = render(<PeakBand view={view} peak={PEAK} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(container.querySelector('.vp-peakband-fill')).toBeNull();
    expect(screen.getByText(/Live-Wert liegt gerade nicht vor/)).toBeInTheDocument();
    // the target marker is still placeable from the target alone
    expect(container.querySelector('.vp-peakband-limit')).not.toBeNull();
  });

  it('marks a breach when the current mean exceeds the Ziel', () => {
    const view = peakBand({ current: { kw: 200, fresh: true, count: 5 }, targetKw: 180, peak: PEAK });
    const { container } = render(<PeakBand view={view} peak={PEAK} />);
    expect(container.querySelector('.vp-peakband-bar.breach')).not.toBeNull();
  });
});
