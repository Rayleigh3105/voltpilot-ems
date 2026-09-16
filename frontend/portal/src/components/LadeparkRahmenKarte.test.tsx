import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChargingConfig, type Site } from '../api';
import { RechteStandort, setSelbstauskunft } from '../rollen';
import { FIXTURE_IDS as I } from '../test/standorteFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { LadeparkRahmenKarte } from './LadeparkRahmenKarte';

const site = { id: I.an2, name: 'Werk Ahrenberg – Halle 2' } as Site;
const config: ChargingConfig = {
  gridLimitKw: 200,
  priorityChargePointIds: [],
  chargePoints: [],
  frame: { houseReserveKw: 30, maxHouseLoadKw: 96.5 },
};

function antwort(vereinbart: number | null = 200) {
  vi.spyOn(api, 'chargingConfig').mockResolvedValue(config);
  vi.spyOn(api, 'siteDetail').mockResolvedValue({ ...site, standort: { id: I.st1, kurzzeichen: 'ST-1' } });
  vi.spyOn(api, 'netzanschluesse').mockResolvedValue({
    standort: { id: I.st1, kurzzeichen: 'ST-1' }, stichtag: null, kennzeichen_vorschlag: 'NA-3',
    netzanschluesse: [{
      id: 'na-2', kennzeichen: 'NA-2', name: 'Netzanschluss Halle 2',
      standort: { id: I.st1, kurzzeichen: 'ST-1' }, malo: null, netzbetreiber: null,
      anschluss_kva: 250, vereinbart_kw: vereinbart, messung: 'RLM',
      gueltig_ab: '2024-03-12', gueltig_bis: null, hinweise: [], angelegt_am: '2024-03-12T00:00:00Z',
      anlagen: [{ id: 'b-2', anlage: { id: I.an2, name: site.name }, gueltig_ab: '2024-03-12', gueltig_bis: null }],
    }],
  });
}

beforeEach(() => setSelbstauskunft(rechteSeed().me));
afterEach(() => { cleanup(); vi.restoreAllMocks(); setSelbstauskunft(null); });

describe('AP-01 IP-13 · Grenze gegen den Netzanschluss', () => {
  it('zeigt NA-2, 7-Tage-Grundlast und das verbleibende Ladebudget', async () => {
    antwort();
    render(<RechteStandort.Provider value={I.st1}>
      <LadeparkRahmenKarte site={site} rahmen={null} />
    </RechteStandort.Provider>);

    expect(await screen.findByText(/Netzanschluss NA-2: 200/)).toBeInTheDocument();
    expect(screen.getByText(/Grundlast der letzten 7 Tage 96,5 kW/)).toHaveTextContent('Ladebudget 73,5 kW');
  });

  it('sperrt 220 kW bei 200 kW vereinbart schon im Dialog mit demselben Grund', async () => {
    antwort();
    render(<RechteStandort.Provider value={I.st1}>
      <LadeparkRahmenKarte site={site} rahmen={null} />
    </RechteStandort.Provider>);
    await screen.findByText(/Netzanschluss NA-2: 200/);
    fireEvent.change(screen.getByLabelText('kW'), { target: { value: '220' } });
    expect(screen.getByText('220 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Übernehmen' })).toBeDisabled();
  });

  it('nennt ohne Bindung den Übergang und sendet die dort eingegebene Leistung', async () => {
    antwort();
    vi.mocked(api.netzanschluesse).mockResolvedValue({
      standort: { id: I.st1, kurzzeichen: 'ST-1' }, stichtag: null,
      kennzeichen_vorschlag: 'NA-3', netzanschluesse: [],
    });
    vi.spyOn(api, 'saveCustomerChargingFrame').mockResolvedValue({ ...config, gridLimitKw: 180 });
    render(<RechteStandort.Provider value={I.st1}>
      <LadeparkRahmenKarte site={site} rahmen={null} />
    </RechteStandort.Provider>);
    expect(await screen.findByText(/Heute ist kein Netzanschluss gebunden/)).toHaveTextContent('für den Übergang');
    fireEvent.change(screen.getByLabelText('kW'), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' }));
    fireEvent.change(await screen.findByLabelText('Vereinbarte Leistung (kW)'), { target: { value: '200' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Übernehmen' }).at(-1)!);
    await waitFor(() => expect(api.saveCustomerChargingFrame).toHaveBeenCalledWith(I.an2, {
      gridLimitKw: 180, vereinbartKw: 200,
    }));
  });

  it('zeigt ohne Recht weder Eingabe noch Knopf', async () => {
    antwort();
    const me = rechteSeed().me;
    setSelbstauskunft({ ...me, unternehmen_rechte: [], standorte: me.standorte.map((s) => ({ ...s, rechte: [] })) });
    render(<RechteStandort.Provider value={I.st1}>
      <LadeparkRahmenKarte site={site} rahmen={null} />
    </RechteStandort.Provider>);
    await screen.findByText(/Netzanschluss NA-2: 200/);
    expect(screen.queryByLabelText('kW')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Übernehmen' })).toBeNull();
  });
});
