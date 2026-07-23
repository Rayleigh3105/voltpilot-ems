import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TelemetryPoint } from '../api';
import { v1FallbackRows, v1Sparks } from '../livePuls';
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

function renderHero(points: TelemetryPoint[], fresh: boolean, onOpen = vi.fn()) {
  const rows = v1FallbackRows(points);
  const now = new Date('2026-07-06T10:00:00Z');
  return {
    onOpen,
    ...render(
      <LiveHero
        points={points}
        fresh={fresh}
        rows={rows}
        sparks={v1Sparks(rows, points, now)}
        onOpenVerlauf={onOpen}
      />,
    ),
  };
}

describe('LiveHero', () => {
  it('renders the four board rows and the flow diagram', () => {
    const { container } = renderHero(surplus, true);
    const board = within(container.querySelector('.vp-puls') as HTMLElement);
    for (const title of ['Solar', 'Batterie', 'Haus', 'Netz']) {
      expect(board.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getByRole('img', { name: /Energiefluss/i })).toBeInTheDocument();
  });

  it('speaks direction words: charging battery + Einspeisung, no signs', () => {
    renderHero(surplus, true);
    expect(screen.getByText('Lädt')).toBeInTheDocument();
    expect(screen.getByText('Einspeisung')).toBeInTheDocument();
    // The status sentence covers producing + charging + export.
    const status = screen.getByText(/Ihre Anlage erzeugt gerade/);
    expect(status.textContent).toContain('fließen ins Netz');
    expect(status.textContent).not.toMatch(/-\d/); // never a signed number
  });

  it('flips to Netzbezug + Entlädt when importing and discharging', () => {
    // load 9.5, pv 0, grid +3.2 -> battery -6.3 discharging, importing.
    renderHero([pt({ pvPowerKw: 0, loadKw: 9.5, powerKw: 3.2, socPct: 54 })], true);
    expect(screen.getByText('Netzbezug')).toBeInTheDocument();
    expect(screen.getByText('Entlädt')).toBeInTheDocument();
  });

  it('goes honest-grey and dims when the data is stale', () => {
    const { container } = renderHero(surplus, false);
    const status = container.querySelector('.vp-status-line');
    expect(status).toHaveClass('stale');
    expect(status?.textContent).toContain('keine aktuellen Daten');
    // the board wrapper dims (the flow + board carry .vp-stale).
    expect(container.querySelectorAll('.vp-stale').length).toBeGreaterThan(0);
  });

  it('shows the SoC progress and derived charge power on the battery row', () => {
    const { container } = renderHero(surplus, true);
    const board = container.querySelector('.vp-puls') as HTMLElement;
    expect(within(board).getByText(/Ladeleistung/)).toBeInTheDocument();
    const bar = board.querySelector('.vp-puls-socbar > span') as HTMLElement;
    expect(bar.style.width).toBe('76%');
  });

  it('jumps into the v1 explorer tree when a board row is tapped', () => {
    const { onOpen, container } = renderHero(surplus, true);
    const netzJump = container.querySelector<HTMLButtonElement>('.vp-puls-jump[title="Netz"]')!;
    fireEvent.click(netzJump);
    expect(onOpen).toHaveBeenCalledWith({ entityId: 'anlage', channel: 'netz' });
  });
});
