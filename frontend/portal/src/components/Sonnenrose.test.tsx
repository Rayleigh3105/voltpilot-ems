import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sonnenrose } from './Sonnenrose';
import type { RegisterEinheit } from '../api';

function einheit(over: Partial<RegisterEinheit> = {}): RegisterEinheit {
  return {
    id: 'e-1',
    art: 'pv',
    registry: 'mastr',
    registryUnitId: 'SEE123456789012',
    bezeichnung: null,
    inbetriebnahme: '2014-06-01',
    leistungKwp: 8.4,
    speicherKwh: null,
    speicherKw: null,
    bestaetigtAm: '2026-11-12T10:00:00Z',
    registryFetchedAt: null,
    abweichungVonRegister: false,
    flaechen: [{ richtungGrad: 180, neigungGrad: 30, anteilKwp: 8.4, module: 20, quelle: 'register' }],
    ...over,
  };
}

describe('Sonnenrose (E1=B, vp-mastr-mehrere-einheiten-konzept)', () => {
  it('zeigt die Summe aller Einheiten in der Mitte', () => {
    render(
      <Sonnenrose
        einheiten={[
          einheit({ id: 'e-1', leistungKwp: 8.4, inbetriebnahme: '2014-06-01' }),
          einheit({
            id: 'e-2',
            leistungKwp: 6.3,
            inbetriebnahme: '2024-06-01',
            flaechen: [{ richtungGrad: 90, neigungGrad: 12.5, anteilKwp: 6.3, module: 15, quelle: 'register' }],
          }),
        ]}
      />,
    );
    expect(screen.getByText('14,7')).toBeInTheDocument();
    expect(screen.getByText('kWp')).toBeInTheDocument();
  });

  it('lässt eine unbestätigte Vorschlags-Einheit (E5) außen vor', () => {
    render(
      <Sonnenrose
        einheiten={[
          einheit({ id: 'e-1', leistungKwp: 8.4 }),
          einheit({ id: 'e-vorschlag', leistungKwp: 6.3, bestaetigtAm: null, flaechen: [] }),
        ]}
      />,
    );
    // Nur die bestätigte Einheit zählt - 8,4, nicht 14,7.
    expect(screen.getByText('8,4')).toBeInTheDocument();
  });

  it('nennt jede Einheit in der Legende mit kWp, Jahr und Richtung', () => {
    const { container } = render(<Sonnenrose einheiten={[einheit()]} />);
    const legende = container.querySelector('.vp-sonnenrose-legende');
    expect(legende?.textContent).toContain('8,4');
    expect(legende?.textContent).toContain('kWp');
    expect(legende?.textContent).toContain('seit 2014');
    expect(legende?.textContent).toContain('Süd');
  });

  it('zeigt eine einzelne Einheit ohne Fehler (keine Legende-Lücke)', () => {
    render(<Sonnenrose einheiten={[einheit({ inbetriebnahme: null })]} />);
    expect(screen.getAllByText('8,4', { exact: false }).length).toBeGreaterThan(0);
  });

  it('ohne jede PV-Einheit bleibt die Summe 0', () => {
    render(<Sonnenrose einheiten={[]} />);
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
