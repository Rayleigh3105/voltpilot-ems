import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ChargingConfig, type Netzanschluss } from '../api';
import { RechteStandort, setSelbstauskunft } from '../rollen';
import { FIXTURE_IDS as I } from '../test/standorteFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { AnschlussgrenzeBlatt } from './AnschlussgrenzeBlatt';

// „Ein Ort fürs Laden" Scheibe 4 (E5 = A): die Anschlussgrenze zieht aus dem
// Rahmen-Blatt der Steuerung in die Einstellungen - diese Hülle holt ihre
// Daten selbst und reicht sie an das unveränderte `RahmenBlatt` weiter.

const site = { id: I.an2, name: 'Werk Ahrenberg – Halle 2' };
const config: ChargingConfig = {
  gridLimitKw: 200,
  priorityChargePointIds: [],
  chargePoints: [],
  frame: { houseReserveKw: 30, maxHouseLoadKw: 96.5 },
};

function na2(vereinbart: number | null): Netzanschluss {
  return {
    id: 'na-2', kennzeichen: 'NA-2', name: 'Netzanschluss Halle 2',
    standort: { id: I.st1, kurzzeichen: 'ST-1' }, malo: null, netzbetreiber: null,
    anschluss_kva: 250, vereinbart_kw: vereinbart, messung: 'RLM',
    gueltig_ab: '2024-03-12', gueltig_bis: null, hinweise: [], angelegt_am: '2024-03-12T00:00:00Z',
    anlagen: [{ id: 'b-2', anlage: { id: I.an2, name: site.name }, gueltig_ab: '2024-03-12', gueltig_bis: null }],
  };
}

function mockOk(c: ChargingConfig = config) {
  vi.spyOn(api, 'siteVerbraucher').mockResolvedValue({
    verbraucher: [], rangliste: [],
    ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
  } as never);
  vi.spyOn(api, 'chargingConfig').mockResolvedValue(c);
  vi.spyOn(api, 'siteDetail').mockResolvedValue({ ...site, standort: { id: I.st1, kurzzeichen: 'ST-1' } } as never);
  vi.spyOn(api, 'netzanschluesse').mockResolvedValue({
    standort: { id: I.st1, kurzzeichen: 'ST-1' }, stichtag: null, kennzeichen_vorschlag: 'NA-3', netzanschluesse: [na2(200)],
  });
}

beforeEach(() => setSelbstauskunft(rechteSeed().me));
afterEach(() => { cleanup(); vi.restoreAllMocks(); setSelbstauskunft(null); });

describe('AnschlussgrenzeBlatt (Einstellungen)', () => {
  it('lädt und zeigt dann das Rahmen-Blatt mit dem heutigen Wert', async () => {
    mockOk();
    render(<RechteStandort.Provider value={I.st1}>
      <AnschlussgrenzeBlatt siteId={site.id} onClose={vi.fn()} />
    </RechteStandort.Provider>);
    expect(screen.getByText('Lädt …')).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: /Netzanschluss und Laden/ })).toBeInTheDocument();
    expect(await screen.findByText(/Netzanschluss NA-2: 200/)).toHaveTextContent('vereinbart');
  });

  it('speichert über denselben Kunden-Schritt und meldet den neuen Wert nach oben', async () => {
    mockOk();
    const saved = vi.spyOn(api, 'saveCustomerChargingFrame').mockResolvedValue({ ...config, gridLimitKw: 199 });
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<RechteStandort.Provider value={I.st1}>
      <AnschlussgrenzeBlatt siteId={site.id} onClose={onClose} onSaved={onSaved} />
    </RechteStandort.Provider>);
    await screen.findByText(/Netzanschluss NA-2: 200/);
    fireEvent.click(screen.getByRole('button', { name: 'weniger' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); });
    expect(saved).toHaveBeenCalledWith(site.id, { gridLimitKw: 199 });
    expect(onSaved).toHaveBeenCalledWith({ ...config, gridLimitKw: 199 });
    expect(onClose).toHaveBeenCalled();
  });

  it('zeigt einen Speicher-Fehler, ohne das Blatt zu schließen', async () => {
    mockOk();
    vi.spyOn(api, 'saveCustomerChargingFrame').mockRejectedValue(new Error('offline'));
    const onClose = vi.fn();
    render(<RechteStandort.Provider value={I.st1}>
      <AnschlussgrenzeBlatt siteId={site.id} onClose={onClose} />
    </RechteStandort.Provider>);
    await screen.findByText(/Netzanschluss NA-2: 200/);
    fireEvent.click(screen.getByRole('button', { name: 'weniger' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Übernehmen' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Der Rahmen konnte nicht gespeichert werden.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('zeigt einen Lade-Fehler, wenn die Daten nicht ankommen', async () => {
    vi.spyOn(api, 'siteVerbraucher').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'chargingConfig').mockResolvedValue(config);
    render(<RechteStandort.Provider value={I.st1}>
      <AnschlussgrenzeBlatt siteId={site.id} onClose={vi.fn()} />
    </RechteStandort.Provider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Die Anschlussgrenze konnte nicht geladen werden.');
  });
});
