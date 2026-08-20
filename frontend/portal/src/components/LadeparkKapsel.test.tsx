import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LadeparkKapsel } from './LadeparkKapsel';
import { api, type Site } from '../api';
import type { SiteCharging } from '../ladepunkte';

const site = { id: 's-lade', name: 'Ladepark Hof' } as Site;

const charging: SiteCharging = {
  budget: null,
  chargers: [
    {
      deviceId: 'd-1',
      chargePointId: 'saeule-1',
      label: 'Hof Nord',
      priority: false,
      connected: true,
      ready: true,
      connectors: [],
    },
    {
      deviceId: 'd-1',
      chargePointId: 'saeule-2',
      label: 'Hof Süd',
      priority: false,
      connected: true,
      ready: true,
      connectors: [],
    },
  ],
};

describe('LadeparkKapsel', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('graut die Überschuss-Karte MIT Grund aus, statt sie zu verstecken', async () => {
    vi.spyOn(api, 'chargingConfig').mockResolvedValue({
      gridLimitKw: 277,
      priorityChargePointIds: [],
    });
    render(<LadeparkKapsel site={site} charging={charging} hasPv={false} />);
    expect(await screen.findByText('PV-Überschussladen')).toBeTruthy();
    expect(screen.getByText(/nicht verfügbar - sie hat keine PV/)).toBeTruthy();
    // Und die Verteilung ist fest eingebaut - kein Schalter dafür.
    expect(screen.getByText(/Dynamisch fair/)).toBeTruthy();
  });

  it('nennt die fehlende Anschlussgrenze und ihre Folge', async () => {
    vi.spyOn(api, 'chargingConfig').mockResolvedValue({
      gridLimitKw: null,
      priorityChargePointIds: [],
    });
    render(<LadeparkKapsel site={site} charging={charging} hasPv={false} />);
    expect(await screen.findByText(/gibt VoltPilot keine Ladeleistung frei/)).toBeTruthy();
  });

  it('fragt VOR dem Speichern nach - mit der Folgenliste des Hauses', async () => {
    vi.spyOn(api, 'chargingConfig').mockResolvedValue({
      gridLimitKw: null,
      priorityChargePointIds: [],
    });
    const save = vi.spyOn(api, 'saveChargingConfig').mockResolvedValue({
      gridLimitKw: 277,
      priorityChargePointIds: [],
    });
    render(<LadeparkKapsel site={site} charging={charging} hasPv={false} />);
    fireEvent.change(await screen.findByLabelText('kW'), { target: { value: '277' } });
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));

    // Der Dialog nennt auch, was GLEICH bleibt.
    expect(await screen.findByText(/Ausfall-Schutz Ihrer Säulen gilt unverändert weiter/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Übernehmen' }).at(-1)!);
    await waitFor(() => expect(save).toHaveBeenCalledWith('s-lade', { gridLimitKw: 277 }));
  });

  it('der Vorrang ist die GANZE Aussage - eine Wahl schickt die ganze Liste', async () => {
    vi.spyOn(api, 'chargingConfig').mockResolvedValue({
      gridLimitKw: 277,
      priorityChargePointIds: [],
    });
    const save = vi.spyOn(api, 'saveChargingConfig').mockResolvedValue({
      gridLimitKw: 277,
      priorityChargePointIds: ['saeule-2'],
    });
    render(<LadeparkKapsel site={site} charging={charging} hasPv={false} />);
    // Ohne Auswahl nennt der Hinweis die FOLGE für die Wartezeit der anderen.
    expect(await screen.findByText(/die Wartezeit der anderen steigt/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hof Süd' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('s-lade', { priorityChargePointIds: ['saeule-2'] }),
    );
  });

  it('lehnt eine unplausible Grenze ab, ohne zu speichern', async () => {
    vi.spyOn(api, 'chargingConfig').mockResolvedValue({
      gridLimitKw: null,
      priorityChargePointIds: [],
    });
    const save = vi.spyOn(api, 'saveChargingConfig');
    render(<LadeparkKapsel site={site} charging={charging} hasPv={false} />);
    fireEvent.change(await screen.findByLabelText('kW'), { target: { value: '0' } });
    expect(screen.getByText(/größer 0 kW/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });
});
