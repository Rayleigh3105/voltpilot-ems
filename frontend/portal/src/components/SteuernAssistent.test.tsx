import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Netzanschluss, type SiteEntity } from '../api';
import { setSelbstauskunft } from '../rollen';
import { ahrenbergFunktionen } from '../test/funktionenFixtures';
import { rechteSeed } from '../test/rollenFixtures';
import { FIXTURE_IDS, ahrenbergHeute } from '../test/standorteFixtures';
import { SteuernAssistent } from './SteuernAssistent';

const ladepunkt: SiteEntity = {
  id: 'K-9', entityType: 'ocpp-charge-point', typeLabel: 'Ladepunkt', role: 'consumer',
  label: 'Parkplatz Halle 2', control: true, deviceId: 'E-2', capabilities: null,
  guards: null, syncStatus: 'in_sync', observed: null, edgeSourceId: null,
};

const anschluss = {
  id: 'NA-2', kennzeichen: 'NA-2', name: 'Netzanschluss Halle 2', malo: null, netzbetreiber: null,
  anschluss_kva: 250, vereinbart_kw: 200, messung: 'RLM', gueltig_ab: '2026-01-01', gueltig_bis: null,
  standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1' }, hinweise: [], angelegt_am: '2026-01-01T00:00:00Z',
  anlagen: [{ id: 'b-1', anlage: { id: FIXTURE_IDS.an2, name: 'Halle 2' }, gueltig_ab: '2026-01-01', gueltig_bis: null }],
} satisfies Netzanschluss;

beforeEach(() => {
  vi.restoreAllMocks();
  setSelbstauskunft(rechteSeed('JW').me);
  vi.spyOn(api, 'standorte').mockResolvedValue(ahrenbergHeute());
  vi.spyOn(api, 'funktionen').mockResolvedValue(ahrenbergFunktionen());
  vi.spyOn(api, 'siteEntities').mockResolvedValue({ registry: null, entities: [ladepunkt], localSetup: [], staleOnDevice: [] });
  vi.spyOn(api, 'siteVerbraucher').mockResolvedValue({
    verbraucher: [{
      entityId: 'K-9', name: 'Parkplatz Halle 2', typ: 'ev_charger', typLabel: 'Ladepunkt', ladepunkt: true,
      steuerart: { quelle: 'sofort', herkunft: 'ohne' }, regeln: 0, aktiv: false,
      optionen: { schreibbar: true, quellen: [{ id: 'sofort', gesperrt: false }], ziele: [], vorgaben: {} },
    }],
    ladepunkte: { standard: null, standardFolger: 0, gesamt: 1, rahmen: { hoechsteHausLastKw: 96.5 } },
    rangliste: [],
  });
  vi.spyOn(api, 'netzanschluesse').mockResolvedValue({
    standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1' }, stichtag: '2026-12-01',
    kennzeichen_vorschlag: 'NA-3', netzanschluesse: [anschluss],
  });
  vi.spyOn(api, 'chargingConfig').mockResolvedValue({ gridLimitKw: null, priorityChargePointIds: [] });
  vi.spyOn(api, 'saveCustomerChargingFrame').mockResolvedValue({ gridLimitKw: 200, priorityChargePointIds: [] });
  vi.spyOn(api, 'setzeSteuerart').mockResolvedValue({ steuerart: { quelle: 'sofort', herkunft: 'policy' }, aktiv: true });
  vi.spyOn(api, 'setSiteProfile').mockResolvedValue({ profiles: [] } as never);
});

describe('SteuernAssistent — Referenzfall 5 bis Schritt 4', () => {
  it('bereitet Halle 2 vor, schreibt die Grenze, aktiviert aber weder Steuerart noch profiles', async () => {
    const onClose = vi.fn();
    render(<SteuernAssistent standortId={FIXTURE_IDS.st1} anlageId={FIXTURE_IDS.an2} onClose={onClose} />);

    expect(await screen.findByText('Welche Anlage wird aufgenommen?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    expect(await screen.findByText('Was darf VoltPilot steuern?')).toBeInTheDocument();
    expect(screen.getByText('Parkplatz Halle 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(await screen.findByText('Welche Grenze gilt?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Anschlussgrenze (kW)'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => expect(api.saveCustomerChargingFrame).toHaveBeenCalledWith(FIXTURE_IDS.an2, { gridLimitKw: 200 }));

    expect(await screen.findByText('Wie soll gesteuert werden?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Steuerart wählen' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/Sofort laden/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Weiter' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Speichern' }));

    expect(await screen.findByText('Auswahl vorbereitet — noch nicht aktiv')).toBeInTheDocument();
    expect(api.setzeSteuerart).not.toHaveBeenCalled();
    expect(api.setSiteProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Betriebsweise übernehmen' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('weist 220 kW gegen 200 kW zurück und ruft die Route nicht', async () => {
    render(<SteuernAssistent standortId={FIXTURE_IDS.st1} anlageId={FIXTURE_IDS.an2} onClose={vi.fn()} />);
    await screen.findByText('Welche Anlage wird aufgenommen?');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText('Was darf VoltPilot steuern?');
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await screen.findByText('Welche Grenze gilt?');
    fireEvent.change(screen.getByLabelText('Anschlussgrenze (kW)'), { target: { value: '220' } });
    expect(screen.getByText('220 kW liegen über 200 kW vereinbarter Leistung — bitte prüfen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled();
    expect(api.saveCustomerChargingFrame).not.toHaveBeenCalled();
  });
});
