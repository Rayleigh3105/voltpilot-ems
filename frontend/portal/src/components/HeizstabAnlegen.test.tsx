import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GS_SHELLY, gsShelly } from '../test/geraetesucheFixtures';
import { HeizstabAnlegen } from './HeizstabAnlegen';

const testComponentConnection = vi.fn();
const nachStromausfallAus = vi.fn();
const createComponent = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../api');
  return {
    ...actual,
    api: {
      testComponentConnection: (...a: unknown[]) => testComponentConnection(...a),
      nachStromausfallAus: (...a: unknown[]) => nachStromausfallAus(...a),
      createComponent: (...a: unknown[]) => createComponent(...a),
    },
  };
});

// So meldet die Box einen Pro 3 mit Ausgangsmenge (heizstab-shelly.md): samples relay_on_<kanal> + ausgaenge.
const PRO3_TEST = {
  requestId: 'r1',
  results: [{
    id: 'verbindung', ok: true,
    samples: [0, 1, 2].map((k) => ({ channel: `relay_on_${k}`, raw: 0, value: 0, count: 1 })),
    ausgaenge: [
      { kanal: 0, ein: false, nach_stromausfall: 'match_input' },
      { kanal: 1, ein: false, nach_stromausfall: 'restore_last' },
      { kanal: 2, ein: false, nach_stromausfall: 'off' },
    ],
  }],
};

function oeffne() {
  const onFertig = vi.fn();
  render(
    <HeizstabAnlegen
      siteId="site-1"
      boxId="box-1"
      fund={gsShelly}
      template={GS_SHELLY}
      verbindung={{ ip: '192.168.178.43', port: 80 }}
      suchId="such-1"
      onClose={() => {}}
      onFertig={onFertig}
    />,
  );
  return onFertig;
}

describe('Heizstab über alle Ausgänge einrichten', () => {
  beforeEach(() => {
    testComponentConnection.mockReset();
    nachStromausfallAus.mockReset();
    createComponent.mockReset();
  });

  it('testet, stellt „nach Stromausfall“ auf aus und legt EIN Gerät über die drei Ausgänge an', async () => {
    testComponentConnection.mockResolvedValue(PRO3_TEST);
    nachStromausfallAus.mockResolvedValue({
      requestId: 'r2',
      results: [{ id: 'nach-stromausfall', ok: true, ausgaenge: [0, 1, 2].map((k) => ({ kanal: k, nach_stromausfall: 'off' })) }],
    });
    createComponent.mockResolvedValue({ components: [] });
    const onFertig = oeffne();

    fireEvent.click(screen.getByRole('button', { name: /Jede Phase mit Neutralleiter/ }));
    fireEvent.change(screen.getByLabelText('Leistung je Heizelement (kW)'), { target: { value: '2,0' } });
    expect(screen.getByText(/^1 Phase · 2,0\skW$/)).toBeInTheDocument();
    expect(screen.getByText(/^3 Phasen · 6,0\skW$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));

    await screen.findByText('Ausgang 2 (L2)');
    const verbindung = testComponentConnection.mock.calls[0][1].connection;
    expect(verbindung).toEqual({
      ip: '192.168.178.43', port: 80, channels: [0, 1, 2], output_kw: [2, 2, 2], stages: [1, 2, 3],
      rotation: 'daily', anschluss: 'stern_mit_n',
    });
    expect(screen.getByText(/Stellen Sie die Ausgänge auf „aus“/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Auf „aus“ stellen' }));
    await waitFor(() => expect(screen.queryByText(/Stellen Sie die Ausgänge auf „aus“/)).toBeNull());
    expect(nachStromausfallAus.mock.calls[0][1].connection).toEqual(verbindung);
    expect(screen.getAllByText(/nach Stromausfall: aus/)).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Heizstab speichern' }));
    await waitFor(() => expect(onFertig).toHaveBeenCalled());
    const body = createComponent.mock.calls[0][1];
    expect(body).toMatchObject({
      templateRef: GS_SHELLY.templateRef, role: 'consumer', consumerType: 'heating-rod', label: 'Heizstab',
      connection: verbindung, geraetesuche: { suchId: 'such-1', fund: gsShelly.schluessel },
    });
  });

  it('lehnt einen Anschluss ohne N für mehrere Ausgänge vor jedem Test ab', () => {
    oeffne();
    fireEvent.click(screen.getByRole('button', { name: /Im Dreieck/ }));
    fireEvent.change(screen.getByLabelText('Leistung je Heizelement (kW)'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/dreipoliges Schütz/);
    expect(testComponentConnection).not.toHaveBeenCalled();
  });

  it('einzelne Phasen nur mit Elementen bis 4,6 kW (Schieflast)', () => {
    oeffne();
    fireEvent.click(screen.getByRole('button', { name: /Jede Phase mit Neutralleiter/ }));
    fireEvent.change(screen.getByLabelText('Leistung je Heizelement (kW)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/bis 4,6 kW/);
    // Ohne Teilstufen geht es: nur alle zusammen.
    fireEvent.click(screen.getByRole('checkbox', { name: /1 Phase/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /2 Phasen/ }));
    testComponentConnection.mockResolvedValue(PRO3_TEST);
    fireEvent.click(screen.getByRole('button', { name: 'Verbindung testen' }));
    expect(testComponentConnection).toHaveBeenCalledTimes(1);
    expect(testComponentConnection.mock.calls[0][1].connection.stages).toEqual([3]);
  });
});
