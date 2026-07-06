import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { TelemetryPoint } from '../api';
import { LiveHero } from './LiveHero';

const pt = (over: Partial<TelemetryPoint>): TelemetryPoint => ({
  ts: '2026-07-06T10:00:00Z',
  powerKw: null,
  socPct: null,
  pvPowerKw: null,
  loadKw: null,
  gridLimitKw: null,
  ...over,
});

// A believable surplus moment: PV 4.7, load 1.1, export 2.4 -> battery +1.2 charging.
const surplus = [pt({ pvPowerKw: 4.7, loadKw: 1.1, powerKw: -2.4, socPct: 76 })];

describe('LiveHero', () => {
  it('renders the four verdict tiles and the flow diagram', () => {
    const { container } = render(<LiveHero points={surplus} fresh />);
    const grid = within(container.querySelector('.vp-verdict-grid') as HTMLElement);
    // Tile heads (Batterie/Haus/Netz also appear as flow-node labels).
    for (const title of ['Solar', 'Batterie', 'Haus', 'Netz']) {
      expect(grid.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getByRole('img', { name: /Energiefluss/i })).toBeInTheDocument();
  });

  it('speaks direction words: charging battery + Einspeisung, no signs', () => {
    render(<LiveHero points={surplus} fresh />);
    expect(screen.getByText('Lädt')).toBeInTheDocument();
    expect(screen.getByText('Einspeisung')).toBeInTheDocument();
    // The status sentence covers producing + charging + export.
    const status = screen.getByText(/Ihre Anlage erzeugt gerade/);
    expect(status.textContent).toContain('fließen ins Netz');
    expect(status.textContent).not.toMatch(/-\d/); // never a signed number
  });

  it('flips to Netzbezug + Entlädt when importing and discharging', () => {
    // load 9.5, pv 0, grid +3.2 -> battery -6.3 discharging, importing.
    render(<LiveHero points={[pt({ pvPowerKw: 0, loadKw: 9.5, powerKw: 3.2, socPct: 54 })]} fresh />);
    expect(screen.getByText('Netzbezug')).toBeInTheDocument();
    expect(screen.getByText('Entlädt')).toBeInTheDocument();
  });

  it('goes honest-grey and dims when the data is stale', () => {
    const { container } = render(<LiveHero points={surplus} fresh={false} />);
    const status = container.querySelector('.vp-status-line');
    expect(status).toHaveClass('stale');
    expect(status?.textContent).toContain('keine aktuellen Daten');
    expect(container.querySelector('.vp-verdict-grid')).toHaveClass('vp-stale');
  });

  it('shows the SoC progress and derived charge power on the battery tile', () => {
    const { container } = render(<LiveHero points={surplus} fresh />);
    const battTile = container.querySelector('.vp-verdict.batt') as HTMLElement;
    expect(within(battTile).getByText(/Ladeleistung/)).toBeInTheDocument();
    const bar = battTile.querySelector('.vp-verdict-soc > span') as HTMLElement;
    expect(bar.style.width).toBe('76%');
  });
});
