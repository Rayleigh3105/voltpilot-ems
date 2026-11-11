import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GatewaySeiteSection } from './GatewaySeiteSection';
import { GeraetSeiteSection } from './GeraetSeiteSection';
import { api, type Site, type UemsDatenquelle } from '../api';
import type { AnlageDaten } from '../boxGeraete';
import { consumersApi } from '../consumers/consumersApi';
import { anbindungApi } from '../geraetAnbindung';
import { gatewayForm, HS_SITE } from '../test/boxGeraeteFixtures';

const site: Site = {
  id: HS_SITE.id,
  name: HS_SITE.name,
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

function stub(d: AnlageDaten) {
  vi.spyOn(api, 'siteEntities').mockResolvedValue(d.entities!);
  vi.spyOn(api, 'topology').mockResolvedValue(d.topology as never);
  vi.spyOn(api, 'siteSources').mockResolvedValue([...(d.sources ?? [])]);
  vi.spyOn(api, 'siteChargers').mockResolvedValue({ budget: null, chargers: [] });
  vi.spyOn(api, 'datenquellen').mockResolvedValue({ datenquellen: [...(d.datenquellen ?? [])] });
  vi.spyOn(api, 'uemsGeraete').mockImplementation(() => d.uemsGeraete == null
    ? Promise.reject(new Error('down'))
    : Promise.resolve({ geraete: [...d.uemsGeraete] }));
  vi.spyOn(api, 'gemeinsameSteuerung').mockRejectedValue(new Error('nicht gebraucht'));
  vi.spyOn(consumersApi, 'list').mockResolvedValue([]);
  vi.spyOn(anbindungApi, 'verlauf').mockResolvedValue({ eintraege: [] });
}

function rendere(d: AnlageDaten, kennzeichen = 'DQ-3') {
  return render(
    <GatewaySeiteSection site={site} boxRef="VP-HS-0001" kennzeichen={kennzeichen} devices={[...d.devices]} devicesFetchedAt={d.now} />,
  );
}

describe('GatewaySeiteSection (GE-5)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('Gateway-Form mit vier Geräten: Rahmen, Geräte mit ihren Seiten, Anbindung mit Box-Wechsel, Hinzufügen mit Weg', async () => {
    const d = gatewayForm(Date.now());
    stub(d);
    rendere(d);

    const rahmen = await screen.findByTestId('gateway-rahmen');
    expect(within(rahmen).getByRole('heading', { level: 1 })).toHaveTextContent('Zählergateway Halle');
    const liste = await screen.findByTestId('gateway-geraete');
    const links = within(liste).getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(links[1]).toHaveTextContent('Geräte-ID 2');
    expect(links[0]).toHaveAttribute('href', '#/anlage/site-hs/geraet/VP-HS-0001/src-haupt');
    expect(screen.getByTestId('gateway-geraete-satz')).toHaveTextContent('4 Geräte · 4 liefern Daten');

    const anbindung = screen.getByTestId('geraet-anbindung');
    expect(anbindung).toHaveTextContent('Modbus TCP · 192.168.10.31:502 · Geräte-IDs 1–4');
    expect(anbindung).toHaveTextContent('Last an der Box');
    expect(anbindung).toHaveTextContent('Box und Last gelten für alle 4 Geräte an diesem Gateway');
    expect(anbindung).toHaveTextContent('Kennung DQ-3');

    expect(screen.getByTestId('gateway-hinzufuegen')).toHaveAttribute('href', '#/anlage/site-hs/modell?neu=geraet&an=DQ-3');
    expect(screen.getByTestId('gateway-hinzufuegen')).toHaveTextContent('Gerät an diesem Gateway hinzufügen');

    // „Zuständige Box wechseln" öffnet den vorhandenen Dialog — er gilt für alle Geräte dahinter.
    fireEvent.click(within(anbindung).getByRole('button', { name: 'Zuständige Box wechseln' }));
    expect(await screen.findByRole('dialog', { name: /Box wechseln|zuständige Box/i })).toBeInTheDocument();
  });

  it('die Geräte-Adresse `…/dq-3` öffnet die Gateway-Seite im Rahmen der Geräteseiten', async () => {
    const d = gatewayForm(Date.now());
    stub(d);
    render(<GeraetSeiteSection site={site} boxRef="VP-HS-0001" geraetId="dq-3" devices={[...d.devices]} />);
    expect(await screen.findByTestId('gateway-rahmen')).toBeInTheDocument();
    expect(await screen.findByTestId('gateway-geraete')).toBeInTheDocument();
  });

  it('„Verlauf der Anbindung" liest das Protokoll des Gateway-Wegs', async () => {
    const d = gatewayForm(Date.now());
    stub(d);
    window.history.replaceState(null, '', '#/anlage/site-hs/geraet/VP-HS-0001/dq-3?ansicht=technik&abschnitt=anbindung');
    rendere(d);
    expect(await screen.findByTestId('anbindung-verlauf')).toHaveTextContent('An dieser Anbindung wurde noch nichts geändert.');
    expect(anbindungApi.verlauf).toHaveBeenCalledWith('site-hs', 'dq-3');
    window.history.replaceState(null, '', '#/');
  });

  it('Gateway ohne Box: der Kopf sagt „Von keiner Box gelesen", keine Last', async () => {
    const d = gatewayForm(Date.now());
    const wege = (d.datenquellen ?? []).map((q): UemsDatenquelle =>
      q.id === 'dq-3' ? { ...q, zustaendige_box: null, rueckmeldung: null } : q);
    stub({ ...d, datenquellen: wege });
    rendere({ ...d, datenquellen: wege });
    const anbindung = await screen.findByTestId('geraet-anbindung');
    expect(anbindung).toHaveTextContent('Von keiner Box gelesen');
    expect(anbindung).not.toHaveTextContent('Last an der Box');
    expect(within(screen.getByTestId('gateway-geraete')).getAllByRole('link')).toHaveLength(4);
  });

  it('Gegenprobe 1 : 1: DQ-1 bekommt keine Gateway-Seite, sondern den Weg zu seinem Gerät', async () => {
    const d = gatewayForm(Date.now());
    stub(d);
    rendere(d, 'DQ-1');
    const fehlt = await screen.findByTestId('gateway-fehlt');
    expect(fehlt).toHaveTextContent('DQ-1 ist die Anbindung von Wechselrichter Dach');
    expect(within(fehlt).getByRole('link', { name: 'Zu Wechselrichter Dach' }))
      .toHaveAttribute('href', '#/anlage/site-hs/geraet/VP-HS-0001/src-wr');
    expect(screen.queryByTestId('gateway-rahmen')).toBeNull();
  });

  it('fällt der Abruf der Wege aus, sagt die Seite es und bietet „Erneut versuchen"', async () => {
    const d = gatewayForm(Date.now());
    stub(d);
    vi.mocked(api.datenquellen).mockRejectedValueOnce(new Error('down'));
    rendere(d);
    expect(await screen.findByText('Dieses Gateway konnte nicht geladen werden.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('gateway-rahmen')).toBeNull());
  });
});
