import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ladenKachel } from '../ladenKachel';
import type { ChargePoint, ChargingBudget } from '../ladepunkte';
import { LadenKachel } from './LadenKachel';

function saeule(over: Partial<ChargePoint> & { chargePointId: string }): ChargePoint {
  return {
    deviceId: 'd1', chargePointId: over.chargePointId, label: over.label ?? null,
    priority: false, connected: over.connected ?? true, ready: true,
    lastSeen: over.lastSeen ?? '2026-08-28T09:41:00Z', entityId: null,
    reportedAt: '2026-08-28T09:41:00Z', connectors: over.connectors ?? [],
  };
}

const BUDGET: ChargingBudget = {
  deviceId: 'd1', enabled: true, controlEnabled: true, gridLimitKw: 32, effLimitKw: 32,
  marginPct: 10, minPowerKw: 4.2, budgetKw: 22, allocatedKw: 22, measuredKw: 11,
  siteLoadKw: 12.2, siteGridKw: 12.2, budgetMode: 'gemessen',
  budgetNote: 'Das Budget folgt der Messung am Netzanschluss.', budgetBlind: false,
  connectorCount: 1,
};

const LAEDT = saeule({
  chargePointId: 'GARAGE-1', label: 'Wallbox Garage',
  connectors: [{ connectorId: 1, status: 'Charging', charging: true, powerKw: 11,
    sessionSince: '2026-08-28T12:10:00Z' }],
});

function view(chargers: ChargePoint[], budget: ChargingBudget | null = null, links = {}) {
  return ladenKachel({ charging: { budget, chargers }, links })!;
}

describe('LadenKachel', () => {
  it('zeigt Kopf, Zeile und Zustand', () => {
    render(<LadenKachel view={view([LAEDT])} />);
    expect(screen.getByText('Laden')).toBeInTheDocument();
    expect(screen.getByText('Lädt · 11,0 kW')).toBeInTheDocument();
    expect(screen.getByText('Wallbox Garage')).toBeInTheDocument();
  });

  it('die Fusszeile IST das Netzanschluss-Band - ohne Budget gibt es sie nicht', () => {
    const mit = render(<LadenKachel view={view([LAEDT], BUDGET)} />);
    expect(screen.getByText(/Ladebudget/)).toBeInTheDocument();
    expect(
      screen.getByText('Das Budget folgt der Messung am Netzanschluss.'),
    ).toBeInTheDocument();
    mit.unmount();

    render(<LadenKachel view={view([LAEDT])} />);
    expect(screen.queryByText(/Ladebudget/)).toBeNull();
  });

  it('ist REINE ANZEIGE - kein Start, kein Stopp, keine Freigabe', () => {
    const { container } = render(<LadenKachel view={view([LAEDT], BUDGET, {
      uebersicht: () => '#/anlage/s/ladevorgaenge', charger: () => '#/g/1' })} />);
    // Kein einziger Knopf: jede Handlung wohnt dort, wo sie hingehört.
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // Nur Sprünge - der Kopf auf „Ladevorgänge", die Zeile auf ihr Gerät.
    const links = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['#/anlage/s/ladevorgaenge', '#/g/1']);
  });

  it('verlinkt nichts, wo es kein Ziel gibt', () => {
    const { container } = render(<LadenKachel view={view([LAEDT], BUDGET)} />);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('Wallbox Garage')).toBeInTheDocument();
  });

  it('E6: die kollabierten Ruhenden sind EIN Satz, keine Liste', () => {
    const viele = Array.from({ length: 10 }, (_, i) =>
      i < 2
        ? saeule({ chargePointId: `P${i}`, label: `Stellplatz ${i}`, connectors: [{
            connectorId: 1, status: 'Charging', charging: true, powerKw: 11 }] })
        : saeule({ chargePointId: `P${i}`, label: `Stellplatz ${i}`, connectors: [{
            connectorId: 1, status: 'Available', charging: false }] }));
    const { container } = render(<LadenKachel view={view(viele)} />);
    expect(container.querySelectorAll('.vp-laden-zeile')).toHaveLength(2);
    expect(screen.getByText('8 weitere laden gerade nicht')).toBeInTheDocument();
  });

  it('macht aus einem fehlenden Messwert keine 0', () => {
    const ohne = saeule({ chargePointId: 'P', label: 'Wallbox', connectors: [{
      connectorId: 1, status: 'Charging', charging: true, powerKw: null }] });
    const { container } = render(<LadenKachel view={view([ohne])} />);
    expect(screen.getByText('Lädt · Leistung nicht messbar')).toBeInTheDocument();
    expect(container.querySelector('.vp-laden-kw')).toBeNull();
  });
});
