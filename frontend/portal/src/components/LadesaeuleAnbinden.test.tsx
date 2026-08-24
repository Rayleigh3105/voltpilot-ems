import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '../api';
import type { ChargingConfig, SiteCharging } from '../ladepunkte';
import { LadesaeuleAnbinden } from './LadesaeuleAnbinden';

const chargingConfig = vi.fn();
const siteChargers = vi.fn();
const admitChargePoint = vi.fn();
const removeChargePoint = vi.fn();

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    api: {
      chargingConfig: (...a: unknown[]) => chargingConfig(...a),
      siteChargers: (...a: unknown[]) => siteChargers(...a),
      admitChargePoint: (...a: unknown[]) => admitChargePoint(...a),
      removeChargePoint: (...a: unknown[]) => removeChargePoint(...a),
    },
  };
});

const BOX = {
  id: 'd1',
  siteId: 's1',
  externalRef: 'edge-abcdefj',
  lanHost: '192.168.1.5:8484',
  lanSource: 'erreicht',
} as unknown as Device;

const LEER: ChargingConfig = { gridLimitKw: null, priorityChargePointIds: [], chargePoints: [] };

function charging(over: Partial<SiteCharging> = {}): SiteCharging {
  return {
    budget: { deviceId: 'd1', ocppPort: 8887, ocppUrlPath: '/ocpp' } as SiteCharging['budget'],
    chargers: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  chargingConfig.mockResolvedValue(LEER);
  siteChargers.mockResolvedValue(charging());
  admitChargePoint.mockResolvedValue({
    ...LEER,
    chargePoints: [{ chargePointId: 'hof-nord', label: 'Hof Nord' }],
  });
  removeChargePoint.mockResolvedValue({ ...LEER, removedChargePointIds: ['halle'] });
});

function mount(device: Device | undefined = BOX) {
  return render(<LadesaeuleAnbinden siteId="s1" device={device} />);
}

describe('LadesaeuleAnbinden', () => {
  it('schlägt die Kennung aus dem Namen vor und trägt sie ein', async () => {
    mount();
    fireEvent.change(screen.getByLabelText(/Name der Säule/), { target: { value: 'Hof Nord' } });
    expect((screen.getByLabelText('Kennung') as HTMLInputElement).value).toBe('hof-nord');

    fireEvent.click(screen.getByRole('button', { name: 'Kennung eintragen' }));
    await waitFor(() =>
      expect(admitChargePoint).toHaveBeenCalledWith('s1', {
        chargePointId: 'hof-nord',
        label: 'Hof Nord',
      }),
    );
    expect(await screen.findByText(/lässt diese Kennung ab jetzt herein/)).toBeTruthy();
  });

  it('lässt den Menschen gewinnen: eine getippte Kennung folgt dem Namen nicht mehr', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'meine-saeule' } });
    fireEvent.change(screen.getByLabelText(/Name der Säule/), { target: { value: 'Hof Nord' } });
    expect((screen.getByLabelText('Kennung') as HTMLInputElement).value).toBe('meine-saeule');
  });

  it('zeigt BEIDE Adress-Formen zum Kopieren', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'hof-nord' } });
    await waitFor(() =>
      expect(screen.getByText('ws://192.168.1.5:8887/ocpp/hof-nord')).toBeTruthy(),
    );
    expect(screen.getByText('ws://192.168.1.5:8887/ocpp')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Kopieren' })).toHaveLength(2);
  });

  it('behauptet ohne gemeldete Adresse KEINE - und nennt den Weg', async () => {
    mount({ ...BOX, lanHost: null } as Device);
    await waitFor(() => expect(screen.getByText(/Geräteseite von VoltPilot/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Kopieren' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/ws:\/\//);
  });

  it('hält den Eintrag-Knopf zu, solange die Kennung nicht taugt', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'mit leerzeichen' } });
    expect(screen.getByRole('button', { name: 'Kennung eintragen' })).toHaveProperty(
      'disabled',
      true,
    );
    // ⚠ Der Satz nennt das erlaubte Vokabular - „ungültig" wäre keine Antwort.
    expect(screen.getByText(/keine Leerzeichen/)).toBeTruthy();
  });

  it('meldet Vollzug erst, wenn die SÄULE sich gemeldet hat', async () => {
    chargingConfig.mockResolvedValue({
      ...LEER,
      chargePoints: [{ chargePointId: 'hof-nord' }],
    });
    // ⚠ EINGETRAGEN ist keine Meldung: die Kennung steht in der Allowlist, die
    // Box würde sie also annehmen - benutzt hat sie noch keine Säule.
    const erster = mount();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'hof-nord' } });
    expect(await screen.findByText('Wartet auf die Säule')).toBeTruthy();
    expect(screen.queryByText('Verbunden')).toBeNull();
    erster.unmount();

    siteChargers.mockResolvedValue(
      charging({
        chargers: [
          {
            deviceId: 'd1',
            chargePointId: 'hof-nord',
            priority: false,
            connected: true,
            ready: true,
          } as SiteCharging['chargers'][number],
        ],
      }),
    );
    mount();
    fireEvent.change(screen.getByLabelText('Kennung'), { target: { value: 'hof-nord' } });
    // Beide sagen dasselbe: der Schritt-3-Zustand UND die Zeile in der Liste.
    expect(await screen.findAllByText('Verbunden')).toHaveLength(2);
  });

  it('sagt, ab wann eine Rücknahme wirkt', async () => {
    mount();
    expect(await screen.findByText(/das nächste Mal verbunden/)).toBeTruthy();
  });

  it('zeigt die schon eingetragenen Kennungen mit ihrem Zustand', async () => {
    chargingConfig.mockResolvedValue({
      ...LEER,
      chargePoints: [{ chargePointId: 'halle', label: 'Halle' }],
    });
    mount();
    expect(await screen.findByText('Halle')).toBeTruthy();
    expect(screen.getByText('halle')).toBeTruthy();
    expect(screen.getAllByText('Wartet auf die Säule').length).toBeGreaterThan(0);
  });

  it('entfernt eine Kennung erst NACH der Rückfrage - und nennt vorher die Folgen', async () => {
    chargingConfig.mockResolvedValue({
      ...LEER,
      chargePoints: [{ chargePointId: 'halle', label: 'Halle' }],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Halle.*entfernen/ }));

    // ⚠ Der erste Klick entfernt NICHTS - er fragt.
    expect(removeChargePoint).not.toHaveBeenCalled();
    expect(screen.getByText(/endet dadurch NICHT/)).toBeTruthy();
    expect(screen.getByText(/jederzeit wieder eintragen/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Kennung entfernen' }));
    await waitFor(() => expect(removeChargePoint).toHaveBeenCalledWith('s1', 'halle'));
    await waitFor(() => expect(screen.queryByText('Halle')).toBeNull());
  });

  it('lässt Abbrechen wirklich abbrechen', async () => {
    chargingConfig.mockResolvedValue({
      ...LEER,
      chargePoints: [{ chargePointId: 'halle', label: 'Halle' }],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Halle.*entfernen/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
    expect(removeChargePoint).not.toHaveBeenCalled();
    expect(screen.getByText('Halle')).toBeTruthy();
  });
});
