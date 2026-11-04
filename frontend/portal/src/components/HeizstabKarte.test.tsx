import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Selbstauskunft } from '../api';
import type { ConsumerRuntimeStatus } from '../consumers/status';
import type { Consumer } from '../consumers/types';
import { setSelbstauskunft } from '../rollen';
import { HeizstabKarte, heizStufen } from './HeizstabKarte';

const startOverride = vi.fn();
const clearOverride = vi.fn();
const testComponentConnection = vi.fn();
const updateComponent = vi.fn();
vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      testComponentConnection: (...a: unknown[]) => testComponentConnection(...a),
      updateComponent: (...a: unknown[]) => updateComponent(...a),
    },
  };
});
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
    setSelbstauskunft({ zustand: 'aktiv', unternehmen_rechte: ['handeingriff.setzen', 'geraet.einrichten'], standorte: [] } as unknown as Selbstauskunft);
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
    expect(screen.getByText(/Netzbezug - hält er 30 Sekunden an/)).toBeInTheDocument();
    // Befohlen 1, bestätigt 2: der Stab heizt mit MEHR - der Hinweis nennt das, statt „nie mehr als befohlen“.
    expect(screen.getByRole('status')).toHaveTextContent(/Seit 11:00 heizt der Stab mit mehr als befohlen/);
    // Die Einzelheiten stehen unter „Mehr zum Heizstab“ - zu, bis man sie öffnet.
    const mehr = screen.getByTestId('heizstab-mehr');
    expect(mehr).not.toHaveAttribute('open');
    expect(within(mehr).getByText('L1 an')).toBeInTheDocument();
    expect(within(mehr).getByText('L3 aus')).toBeInTheDocument();
    expect(within(mehr).getByText(/Wärme heute ≈\s3,4/)).toHaveTextContent(/geschätzt aus den bestätigten Stufen, nicht gemessen/);
  });

  it('ein offener Anschluss steht sichtbar da und sperrt „Jetzt heizen“ mit Grund (der Server lehnt sonst ab)', () => {
    const komponente = {
      id: 'rod-1', role: 'consumer', label: 'Heizstab', templateRef: 'shelly-pro-3', templateVersion: 2, definitionVersion: 4,
      connection: { ip: '192.168.178.43', channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3], anschluss: 'unbekannt' },
    };
    render(
      <HeizstabKarte siteId="site-1" consumer={ROD} status={null} override={null} kanaele={3} komponente={komponente}
        jetzt={new Date('2026-11-02T10:05:00Z')} onGeaendert={() => {}} />,
    );
    expect(screen.getByTestId('heizstab-anschluss-offen')).toHaveTextContent(/schaltet VoltPilot den Heizstab nicht/);
    expect(screen.getByRole('button', { name: /einschalten/ })).toBeDisabled();
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
    expect(screen.getByText(/Höchstens ≈\s2,0/)).toBeInTheDocument();
    // Stufe und Dauer tragen ein sichtbares Wort, damit die zwei Wahlen nicht gleich aussehen.
    expect(screen.getByRole('group', { name: 'Stufe' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Dauer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 Phase für 1 Stunde einschalten' }));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalled());
    expect(startOverride).toHaveBeenCalledWith('site-1', 'rod-1', { action: 'start', durationMinutes: 60, stufe: 1 });
  });

  it('ein laufender Handeingriff zeigt sein Ende und „Automatik fortsetzen“', async () => {
    render(
      <HeizstabKarte siteId="site-1" consumer={ROD} status={null}
        override={{ entityId: 'rod-1', kind: 'start', targetCommand: 'setpoint_kw', targetValue: 2, endsAt: '2026-11-02T12:00:00Z' }}
        kanaele={3} jetzt={new Date('2026-11-02T10:05:00Z')} onGeaendert={() => {}} />,
    );
    // Befohlen, nicht bestätigt: der Satz sagt „eingeschaltet“, nie „heizt“.
    expect(screen.getByText(/^Von Hand eingeschaltet bis 13:00 \(1 Phase · 2,0\skW\)\.$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Automatik fortsetzen' }));
    await waitFor(() => expect(clearOverride).toHaveBeenCalledWith('site-1', 'rod-1'));
  });

  it('„Immer L1“ prüft die Verbindung und speichert sie mit rotation fixed', async () => {
    testComponentConnection.mockReset().mockResolvedValue({
      requestId: 'r1',
      results: [{ id: 'verbindung', ok: true, samples: [{ channel: 'relay_on_0', raw: 0, value: 0, count: 1 }] }],
    });
    updateComponent.mockReset().mockResolvedValue({ components: [] });
    const onGeaendert = vi.fn();
    const komponente = {
      id: 'rod-1', role: 'consumer', label: 'Heizstab', templateRef: 'shelly-pro-3', templateVersion: 2, definitionVersion: 4,
      connection: { ip: '192.168.178.43', channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3], rotation: 'daily', anschluss: 'stern_mit_n' },
    };
    render(
      <HeizstabKarte siteId="site-1" consumer={ROD} status={null} override={null} kanaele={3} komponente={komponente}
        jetzt={new Date('2026-11-02T10:05:00Z')} onGeaendert={onGeaendert} />,
    );
    expect(screen.getByRole('button', { name: /Täglich wechselnd/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /Immer L1/ }));
    await waitFor(() => expect(onGeaendert).toHaveBeenCalled());
    expect(testComponentConnection.mock.calls[0][1]).toMatchObject({ entityId: 'rod-1', connection: { rotation: 'fixed' } });
    expect(updateComponent.mock.calls[0][2]).toMatchObject({
      expectedRevision: 4, connection: { rotation: 'fixed', channels: [0, 1, 2], anschluss: 'stern_mit_n' },
    });
  });
});
