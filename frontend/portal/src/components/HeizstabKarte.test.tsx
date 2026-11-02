import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Selbstauskunft } from '../api';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { Consumer } from '../consumers/types';
import { setSelbstauskunft } from '../rollen';
import { HeizstabKarte, heizStufen } from './HeizstabKarte';

const startOverride = vi.fn();
const clearOverride = vi.fn();
vi.mock('../consumers/consumersApi', () => ({
  consumersApi: {
    startOverride: (...a: unknown[]) => startOverride(...a),
    clearOverride: (...a: unknown[]) => clearOverride(...a),
  },
}));

// Ein Heizstab aus Paket 3: Stufenprofil [0, 2, 4, 6] kW über drei Ausgänge.
const ROD = {
  id: 'rod-1', type: 'heating-rod', typeLabel: 'Heizstab', name: 'Heizstab', controlKind: 'stepped',
  ratedPowerKw: 6, levelsKw: [0, 2, 4, 6],
} as unknown as Consumer;

function status(p: Partial<ConsumerRuntimeStatus>): ConsumerRuntimeStatus {
  return { entityId: 'rod-1', state: 'running_optimized', reportedAt: '2026-11-02T10:05:00Z', ...p };
}

describe('Heizstab auf der Geräteseite', () => {
  beforeEach(() => {
    startOverride.mockReset().mockResolvedValue({});
    clearOverride.mockReset().mockResolvedValue({});
    setSelbstauskunft({ zustand: 'aktiv', unternehmen_rechte: ['handeingriff.setzen'], standorte: [] } as unknown as Selbstauskunft);
  });
  afterEach(() => setSelbstauskunft(null));

  it('liest die Stufen aus dem Profil', () => {
    expect(heizStufen(ROD, 3)).toEqual([
      { stufe: 1, ausgaenge: 1, kw: 2 }, { stufe: 2, ausgaenge: 2, kw: 4 }, { stufe: 3, ausgaenge: 3, kw: 6 },
    ]);
  });

  it('zeigt die bestätigte Stufe, die Phasen, den Grund und eine anhaltende Abweichung', () => {
    render(
      <HeizstabKarte
        siteId="site-1"
        consumer={ROD}
        status={status({
          stufe: { commanded: 1, commanded_kw: 2, confirmed: 2, confirmed_kw: 4, outputs_on: [0, 1], mismatch_since: '2026-11-02T10:00:00Z' },
          heizstab: { stufe: 1, code: 'kein_ueberschuss', grund: 'Netzbezug - hält er 30 Sekunden an, folgt eine kleinere Stufe.' },
          stufeEnergieKwhHeute: 3.4,
        })}
        override={null}
        kanaele={3}
        jetzt={new Date('2026-11-02T10:05:00Z')}
        onGeaendert={() => {}}
      />,
    );
    expect(screen.getByText(/^Heizt mit 2 Phasen · 4,0\skW$/)).toBeInTheDocument();
    expect(screen.getByText('L1 an')).toBeInTheDocument();
    expect(screen.getByText('L3 aus')).toBeInTheDocument();
    expect(screen.getByText(/Netzbezug - hält er 30 Sekunden an/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Seit 11:00 meldet ein Ausgang nicht, was VoltPilot befiehlt/);
    expect(screen.getByText(/Wärme heute ≈ 3,4/)).toHaveTextContent(/angenommen aus den bestätigten Stufen/);
  });

  it('„Jetzt heizen“ schickt die gewählte Stufe und die Dauer', async () => {
    const onGeaendert = vi.fn();
    render(
      <HeizstabKarte siteId="site-1" consumer={ROD} status={null} override={null} kanaele={3}
        jetzt={new Date('2026-11-02T10:05:00Z')} onGeaendert={onGeaendert} />,
    );
    expect(screen.getByText('Noch keine Rückmeldung der Box')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^1 Phase\s*2,0/ }));
    fireEvent.click(screen.getByRole('button', { name: '1 Stunde' }));
    expect(screen.getByText(/Höchstens ≈ 2,0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 Phase einschalten' }));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalled());
    expect(startOverride).toHaveBeenCalledWith('site-1', 'rod-1', { action: 'start', durationMinutes: 60, stufe: 1 });
  });

  it('ein laufender Handeingriff zeigt sein Ende und „Automatik fortsetzen“', async () => {
    render(
      <HeizstabKarte siteId="site-1" consumer={ROD} status={null}
        override={{ entityId: 'rod-1', kind: 'start', targetCommand: 'setpoint_kw', targetValue: 2, endsAt: '2026-11-02T12:00:00Z' }}
        kanaele={3} jetzt={new Date('2026-11-02T10:05:00Z')} onGeaendert={() => {}} />,
    );
    expect(screen.getByText(/Heizt von Hand bis 13:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Automatik fortsetzen' }));
    await waitFor(() => expect(clearOverride).toHaveBeenCalledWith('site-1', 'rod-1'));
  });
});
