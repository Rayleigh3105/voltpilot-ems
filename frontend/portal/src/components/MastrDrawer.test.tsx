import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MastrDrawer } from './MastrDrawer';
import { api, type MastrLokationPreview, type MastrPreview, type RegisterEinheit, type Site } from '../api';

/**
 * S2/S3 (vp-mastr-mehrere-einheiten-konzept, E2=A "eine Nummer genügt"): die
 * drei Schritte der Lokations-Suche - Nummer, Auswahl (mit Vorauswahl nach
 * Betreiber), Richtung prüfen nur dort, wo das Register grob ist.
 */

const site: Site = {
  id: 's-1',
  name: 'Hof Sonnenfeld',
  biddingZone: 'DE-LU',
  latitude: null,
  longitude: null,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  netzladenErlaubt: false,
  maxFeedInKw: null,
};

function previewOf(over: Partial<MastrPreview> = {}): MastrPreview {
  return {
    mastrNummer: 'SEE111111111111',
    kind: 'pv',
    name: null,
    status: 'In Betrieb',
    plantType: 'Gebäudesolaranlage',
    powerKw: 8.4,
    inverterPowerKw: null,
    moduleCount: 20,
    azimuthLabel: 'Süd',
    azimuthDeg: 180,
    tiltLabel: '21 - 40 Grad',
    tiltDeg: 30,
    commissionedOn: '2014-06-01',
    storageCapacityKwh: null,
    chargePowerKw: null,
    batteryTechnology: null,
    plz: '89150',
    ort: 'Laichingen',
    linkedUnitNumber: null,
    warnings: [],
    ...over,
  };
}

function registerEinheit(over: Partial<RegisterEinheit> = {}): RegisterEinheit {
  return {
    id: 'e-1',
    art: 'pv',
    registry: 'mastr',
    registryUnitId: 'SEE111111111111',
    bezeichnung: null,
    inbetriebnahme: '2014-06-01',
    leistungKwp: 8.4,
    speicherKwh: null,
    speicherKw: null,
    bestaetigtAm: '2026-11-12T10:00:00Z',
    registryFetchedAt: null,
    abweichungVonRegister: false,
    flaechen: [],
    ...over,
  };
}

function renderDrawer() {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<MastrDrawer site={site} open onClose={onClose} onApplied={onApplied} />);
  return { onApplied, onClose };
}

describe('MastrDrawer — Lokations-Suche (S2/S3)', () => {
  it('zeigt alle gefundenen Einheiten vorausgewählt, wenn der Betreiber bekannt und gleich ist', async () => {
    const lookup = vi.spyOn(api, 'mastrLokationLookup').mockResolvedValue({
      lokationMastrNummer: 'SEL926735321862',
      einheiten: [
        { vorschau: previewOf(), vorausgewaehlt: true, grund: null },
        {
          vorschau: previewOf({ mastrNummer: 'SEE222222222222', powerKw: 6.3, commissionedOn: '2024-06-30' }),
          vorausgewaehlt: true,
          grund: null,
        },
      ],
    } satisfies MastrLokationPreview);
    renderDrawer();

    fireEvent.change(screen.getByLabelText('MaStR-Nummer Ihrer Anlage'), { target: { value: 'SEE111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Im Register nachschlagen' }));

    await waitFor(() => expect(lookup).toHaveBeenCalledWith('s-1', 'SEE111111111111'));
    expect(await screen.findByText(/Im Register gefunden: 2 Einheiten/)).toBeInTheDocument();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes.every((c) => c.checked)).toBe(true);
  });

  it('zeigt eine andere Betreibernummer abgewählt, aber sichtbar mit Begründung', async () => {
    vi.spyOn(api, 'mastrLokationLookup').mockResolvedValue({
      lokationMastrNummer: 'SEL926735321862',
      einheiten: [
        { vorschau: previewOf(), vorausgewaehlt: true, grund: null },
        {
          vorschau: previewOf({ mastrNummer: 'SEE999999999999' }),
          vorausgewaehlt: false,
          grund: 'anderer_betreiber',
        },
      ],
    });
    renderDrawer();
    fireEvent.change(screen.getByLabelText('MaStR-Nummer Ihrer Anlage'), { target: { value: 'SEE111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Im Register nachschlagen' }));

    await screen.findByText(/Im Register gefunden/);
    expect(screen.getByText(/anderen Betreiber eingetragen/)).toBeInTheDocument();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.filter((c) => c.checked)).toHaveLength(1);
  });

  it('überspringt "Richtung prüfen", wenn jede ausgewählte Einheit eine Richtung hat', async () => {
    vi.spyOn(api, 'mastrLokationLookup').mockResolvedValue({
      lokationMastrNummer: 'SEL1',
      einheiten: [{ vorschau: previewOf(), vorausgewaehlt: true, grund: null }],
    });
    const apply = vi.spyOn(api, 'mastrLokationApply').mockResolvedValue([registerEinheit()]);
    const { onApplied } = renderDrawer();
    fireEvent.change(screen.getByLabelText('MaStR-Nummer Ihrer Anlage'), { target: { value: 'SEE111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Im Register nachschlagen' }));
    await screen.findByText(/Im Register gefunden/);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0][1]).toEqual({
      pv: [
        {
          mastrNummer: 'SEE111111111111',
          capacityKwp: 8.4,
          moduleCount: 20,
          azimuthDeg: 180,
          tiltDeg: 30,
          commissionedOn: '2014-06-01',
        },
      ],
    });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(await screen.findByText(/wurden übernommen/)).toBeInTheDocument();
  });

  it('fragt die Richtung, wenn das Register grob ist (Ost-West/unbekannt), und sperrt "Übernehmen" bis sie gewählt ist', async () => {
    vi.spyOn(api, 'mastrLokationLookup').mockResolvedValue({
      lokationMastrNummer: 'SEL1',
      einheiten: [
        {
          vorschau: previewOf({ azimuthDeg: null, azimuthLabel: 'Ost-West', tiltDeg: null }),
          vorausgewaehlt: true,
          grund: null,
        },
      ],
    });
    const apply = vi.spyOn(api, 'mastrLokationApply').mockResolvedValue([registerEinheit()]);
    renderDrawer();
    fireEvent.change(screen.getByLabelText('MaStR-Nummer Ihrer Anlage'), { target: { value: 'SEE111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Im Register nachschlagen' }));
    await screen.findByText(/Im Register gefunden/);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(await screen.findByText(/kennt das Register keine feste Himmelsrichtung/)).toBeInTheDocument();
    const uebernehmenButton = screen.getByRole('button', { name: 'Übernehmen' });
    expect(uebernehmenButton).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Ausrichtung' }));
    fireEvent.click(screen.getByRole('option', { name: 'Süd' }));
    expect(uebernehmenButton).toBeEnabled();

    fireEvent.click(uebernehmenButton);
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0][1].pv![0].azimuthDeg).toBe(180);
  });

  it('übernimmt eine zweite Nummer an anderem Anschluss zusätzlich', async () => {
    vi.spyOn(api, 'mastrLokationLookup').mockResolvedValue({
      lokationMastrNummer: 'SEL1',
      einheiten: [{ vorschau: previewOf(), vorausgewaehlt: true, grund: null }],
    });
    vi.spyOn(api, 'mastrLookup').mockResolvedValue(
      previewOf({ mastrNummer: 'SEE972142227037', kind: 'storage', storageCapacityKwh: 12.8 }),
    );
    renderDrawer();
    fireEvent.change(screen.getByLabelText('MaStR-Nummer Ihrer Anlage'), { target: { value: 'SEE111111111111' } });
    fireEvent.change(
      screen.getByLabelText('MaStR-Nummer einer weiteren Einheit an anderem Anschluss (optional)'),
      { target: { value: 'SEE972142227037' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Im Register nachschlagen' }));

    expect(await screen.findByText(/Im Register gefunden: 2 Einheiten/)).toBeInTheDocument();
    expect(screen.getByText('SEE972142227037')).toBeInTheDocument();
  });
});
