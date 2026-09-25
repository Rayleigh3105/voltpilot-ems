import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type OcppAction, type OcppStation } from '../api';
import { OcppWallboxPage } from './OcppWallboxPage';
import { BAUSTEIN_ORDNUNG } from '../geraetRahmen';

/**
 * Der Zustands-Satz der Bühne - die Antwort auf „was tut die Säule gerade?".
 * (Er ist ein Satz unter der Zahl, keine Überschrift mehr.)
 */
function zustandsSatz(text: string | RegExp): Promise<HTMLElement> {
  return screen.findByText(text, { selector: '[data-testid="geraet-heldsatz"]' });
}

/** Öffnet „Technik & Diagnose" (E1 a) - OCPP, Messwerte, Rohdaten. */
async function technikOeffnen(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByTestId('geraet-technik-oeffnen'));
  return screen.findByTestId('geraet-technik');
}

const station: OcppStation = {
  deviceId: 'd', chargePointId: 'CP-1', connected: true,
  connectedAt: '2026-08-25T08:00:00Z', disconnectedAt: null, lastSeen: '2026-08-25T08:42:00Z',
  bootedAt: '2026-08-25T07:59:00Z', chargeBoxSerialNumber: 'box-serial',
  chargePointModel: 'P30', chargePointSerialNumber: 'station-serial', chargePointVendor: 'KEBA',
  firmwareVersion: '1.9.4', iccid: '893491234567890', imsi: '262011234567890',
  meterSerialNumber: 'meter-1', meterType: 'MID', diagnosticsStatus: 'Uploaded',
  diagnosticsStatusAt: '2026-08-25T07:00:00Z', firmwareStatus: 'Installed',
  firmwareStatusAt: '2026-08-24T07:00:00Z', supportedFeatureProfiles: ['SmartCharging'],
  connectors: [{ connectorId: 1, status: 'Charging', errorCode: 'NoError', info: null,
    vendorId: 'KEBA', vendorErrorCode: null, stationTimestamp: '2026-08-25T08:42:00Z', reportedAt: '2026-08-25T08:42:00Z' }],
};

const created: OcppAction = {
  id: 'a', deviceId: 'd', chargePointId: 'CP-1', action: 'RemoteStopTransaction', state: 'sent',
  correlationId: 'ocpp-a', idempotencyKey: 'i', actor: 'demo', connectorId: 1,
  transactionId: 42, request: { transactionId: 42 }, response: null, responseStatus: null,
  effect: null, reason: null, preparedAt: '2026-08-25T08:42:00Z', sentAt: '2026-08-25T08:42:00Z',
  responseAt: null, effectAt: null, deadlineAt: '2026-08-25T08:42:30Z', updatedAt: '2026-08-25T08:42:00Z',
};

describe('OcppWallboxPage integration', () => {
  beforeEach(() => {
    const reportedAt = new Date().toISOString();
    vi.spyOn(api, 'ocppStations').mockResolvedValue([{
      ...station,
      lastSeen: reportedAt,
      connectors: station.connectors.map((connector) => ({ ...connector, reportedAt })),
    }]);
    vi.spyOn(api, 'ocppControl').mockResolvedValue({ desired: null, observed: [] });
    vi.spyOn(api, 'ocppEvents').mockResolvedValue([]);
    vi.spyOn(api, 'ocppGaps').mockResolvedValue([]);
    vi.spyOn(api, 'ocppTransactions').mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1, startedAt: new Date(Date.now() - 42 * 60_000).toISOString(), stoppedAt: null, meterStart: 1000, meterStop: null, stopReason: null, startIdTagRef: 'private-reference', stopIdTagRef: null, reservationId: null, chargingProfileId: null, chargingProfilePurpose: null, startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null, transactionData: null, transactionDataPurgedAt: null }]);
    vi.spyOn(api, 'ocppMeterValues').mockResolvedValue([
      { sampledAt: new Date().toISOString(), eventId: 'power', meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42, source: 'MeterValues', pointKey: 'power', measurand: 'Power.Active.Import', context: 'Sample.Periodic', format: 'Raw', phase: null, location: 'Outlet', unit: 'W', value: '11000', numericValue: 11000 },
      { sampledAt: new Date().toISOString(), eventId: 'energy', meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42, source: 'MeterValues', pointKey: 'energy', measurand: 'Energy.Active.Import.Register', context: 'Sample.Periodic', format: 'Raw', phase: null, location: 'Outlet', unit: 'Wh', value: '7400', numericValue: 7400 },
    ]);
    vi.spyOn(api, 'ocppConfiguration').mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', keys: [{ key: 'AuthorizationKey', value: null, readonly: false, secret: true, redacted: true, standardKey: false, meaningKnown: false, reportedAt: new Date().toISOString() }], unknownKeys: ['VendorMystery'], supportedFeatureProfiles: ['SmartCharging'] }]);
    vi.spyOn(api, 'ocppActionPermissions').mockResolvedValue({ actions: Object.fromEntries([
      'RemoteStartTransaction','RemoteStopTransaction','UnlockConnector',
    ].map((action) => [action, true])) });
    vi.spyOn(api, 'ocppActions').mockResolvedValue([]);
    vi.spyOn(api, 'createOcppAction').mockResolvedValue(created);
    vi.spyOn(api, 'ocppActionAudit').mockResolvedValue([]);
    vi.spyOn(api, 'cancelOcppAction').mockResolvedValue(undefined);
    vi.spyOn(api, 'ocppAction').mockResolvedValue({ ...created, state: 'cancelled' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // Die Technik-Ansicht ist eine ADRESSE - sie bliebe sonst für den nächsten Test offen.
    window.history.replaceState(null, '', '#/');
  });

  it('renders the device hierarchy and keeps the technical command catalog out of the customer view', async () => {
    const view = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#devices" siteHref="#site" />);
    expect(await zustandsSatz('Anschluss 1 lädt.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Garage', level: 1 })).toBeVisible();
    expect(screen.getByTestId('geraet-typ')).toHaveTextContent('Wallbox · KEBA · P30');
    const breadcrumb = screen.getByRole('navigation', { name: 'Pfad zur Geräteseite' });
    expect(within(breadcrumb).getByRole('link', { name: 'Anlage' })).toHaveAttribute('href', '#site');
    // Die mittlere Stufe heisst wie die Seite, auf die sie zeigt: seit Stufe 0
    // ist die Brotkrume die geteilte `GeraetBrotkrume`, und der Bereich wurde in
    // Steuerung Stufe 8 zu Komponenten umbenannt.
    expect(within(breadcrumb).getByRole('link', { name: 'Aufbau' })).toHaveAttribute('href', '#devices');
    // Die große Zahl der Bühne ist die Ladeleistung - Zahl und Einheit getrennt gesetzt.
    const held = screen.getByTestId('geraet-held');
    expect(held.querySelector('[data-kachel="leistung"]')).toHaveTextContent(/11\s*kW/);
    expect(within(held).getByText('6,4 kWh')).toBeVisible();
    expect(view.container.querySelectorAll('.vp-ocpp-primary-action .vp-btn')).toHaveLength(1);
    expect(view.container).not.toHaveTextContent('Erwartetes Ende');
    expect(view.container).not.toHaveTextContent('Kosten bisher');
    expect(view.container).not.toHaveTextContent('Solaranteil');
    // Die Diagnose bleibt auffindbar - in „Technik & Diagnose"; der
    // OCPP-Befehlskatalog ist für Kunden vollständig ausgeblendet, ihre drei
    // möglichen Aktionen erscheinen nur passend zum aktuellen Zustand.
    expect(screen.queryByTestId('ocpp-service')).toBeNull();
    const technik = await technikOeffnen();
    expect(within(technik).getByText('••••••••')).toBeVisible();
    fireEvent.click(screen.getByText(/unknownKey/));
    expect(screen.getByText(/VendorMystery/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Hart neu starten/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Firmware aktualisieren/ })).toBeNull();
  });

  it('runs through the same core as every other device page', async () => {
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#devices" siteHref="#site" />);
    const rahmen = await screen.findByTestId('ocpp-rahmen');
    const ids = Array.from(rahmen.querySelectorAll('[data-baustein]'))
      .map((el) => el.getAttribute('data-baustein')!);

    // Dieselben Bausteine wie an Hybrid und Box - fehlende fallen still weg.
    for (const id of ids) expect(BAUSTEIN_ORDNUNG as readonly string[]).toContain(id);
    expect(ids[0]).toBe('buehne');
    expect(ids).toContain('aktivitaet');
    expect(ids[ids.length - 1]).toBe('details');
    // Die „Aktivität" einer Säule sind ihre Ladevorgänge.
    expect(within(screen.getByTestId('baustein-aktivitaet')).getByRole('heading', { name: 'Letzte Ladevorgänge' })).toBeVisible();
    // D3: „Register" wäre an einer Säule das falsche Wort, die Fähigkeit nicht.
    expect(screen.getByTestId('geraet-technik-oeffnen')).toHaveTextContent('OCPP · Messwerte · Rohdaten');
    const technik = await technikOeffnen();
    expect(within(technik).getByRole('heading', { name: 'Messwerte', level: 2 })).toBeVisible();
  });

  it('uses routing-neutral service navigation', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(null, '', '#/anlage/s/geraet/edge-1/cp-CP-1?ansicht=technik&abschnitt=register');
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#devices" />);
    // ⚠ Gesprungen wird über `id` + Fokus, NIE über einen `#anker` - die App
    // ist hash-geroutet. Die Technik-Ansicht ist ein PARAMETER im Hash.
    const technik = await screen.findByTestId('geraet-technik');
    const target = technik.querySelector('[data-technik="register"]') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(target).toHaveAttribute('tabindex', '-1');
    expect(window.location.hash).toBe('#/anlage/s/geraet/edge-1/cp-CP-1?ansicht=technik&abschnitt=register');
    window.history.replaceState(null, '', '#/');
  });

  it.each([
    ['waiting', 'SuspendedEVSE', true, 'Fahrzeug angeschlossen.', 'Jetzt laden'],
    ['available', 'Available', true, 'Bereit zum Laden.', 'Laden starten'],
    ['offline', 'Available', false, 'Wallbox nicht erreichbar.', null],
    ['faulted', 'Faulted', true, 'Störung an Anschluss 1.', null],
  ])('renders the %s core state with one contextual action', async (kind, connectorStatus, connected, sentence, actionLabel) => {
    vi.mocked(api.ocppStations).mockResolvedValue([{
      ...station,
      connected,
      lastSeen: new Date().toISOString(),
      connectors: [{ ...station.connectors[0], status: connectorStatus,
        errorCode: connectorStatus === 'Faulted' ? 'GroundFailure' : 'NoError', reportedAt: new Date().toISOString() }],
    }]);
    vi.mocked(api.ocppTransactions).mockResolvedValue([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    const view = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await zustandsSatz(new RegExp(sentence))).toBeVisible();
    if (actionLabel) expect(screen.getByRole('button', { name: actionLabel })).toBeVisible();
    if (kind === 'offline') expect(screen.getByText('Anschluss 1 zuletzt: Frei')).toBeVisible();
    expect(view.container.querySelectorAll('.vp-ocpp-primary-action .vp-btn')).toHaveLength(actionLabel ? 1 : 0);
  });

  it('offers connector unlock only after finishing and binds it to the affected connector', async () => {
    vi.mocked(api.ocppStations).mockResolvedValue([{
      ...station,
      lastSeen: new Date().toISOString(),
      connectors: [{ ...station.connectors[0], connectorId: 2, status: 'Finishing', reportedAt: new Date().toISOString() }],
    }]);
    vi.mocked(api.ocppTransactions).mockResolvedValue([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    const unlock = await screen.findByRole('button', { name: 'Stecker entriegeln' });
    fireEvent.click(unlock);
    expect(within(screen.getByRole('dialog')).getByRole('spinbutton')).toHaveValue(2);
  });

  it('distinguishes stale and missing device data from offline', async () => {
    vi.mocked(api.ocppStations).mockResolvedValueOnce([{
      ...station,
      lastSeen: new Date(Date.now() - 10 * 60_000).toISOString(),
    }]);
    const stale = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await zustandsSatz('Gerätestatus nicht aktuell.')).toBeVisible();
    expect(stale.container.querySelector('[data-state="stale"]')).toBeInTheDocument();
    stale.unmount();

    vi.mocked(api.ocppStations).mockResolvedValueOnce([]);
    vi.mocked(api.ocppTransactions).mockResolvedValueOnce([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValueOnce([]);
    const missing = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await zustandsSatz('Noch keine aktuellen Gerätedaten.')).toBeVisible();
    expect(missing.container.querySelector('[data-state="unknown"]')).toBeInTheDocument();
  });

  it('uses a newer connected Edge heartbeat when the OCPP journal still says offline', async () => {
    vi.mocked(api.ocppStations).mockResolvedValue([{
      ...station,
      connected: false,
      disconnectedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      lastSeen: new Date(Date.now() - 10 * 60_000).toISOString(),
      connectors: [],
    }]);
    vi.mocked(api.ocppTransactions).mockResolvedValue([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    const view = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" charger={{
      deviceId: 'd', chargePointId: 'CP-1', priority: false, connected: true, ready: true,
      lastSeen: new Date().toISOString(), reportedAt: new Date().toISOString(),
      connectors: [{ connectorId: 1, status: 'Available', charging: false }],
    }} />);
    expect(await zustandsSatz('Bereit zum Laden.')).toBeVisible();
    expect(screen.getByTestId('geraet-zustand')).toHaveTextContent('Online');
    // Woher „Online" kommt, steht in „Gerät & Verbindung" (am Rechner offen).
    const details = screen.getByTestId('baustein-details');
    expect(within(details).getByText(/VoltPilot-Box meldet die Wallbox als verbunden/)).toBeVisible();
    expect(view.container.querySelectorAll('.vp-ocpp-primary-action .vp-btn')).toHaveLength(0);
  });

  it('keeps an Edge-only charging state compact instead of advertising missing data', async () => {
    vi.mocked(api.ocppStations).mockResolvedValue([]);
    vi.mocked(api.ocppTransactions).mockResolvedValue([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    const view = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" charger={{
      deviceId: 'd', chargePointId: 'CP-1', priority: false, connected: true, ready: true,
      lastSeen: new Date().toISOString(), reportedAt: new Date().toISOString(),
      connectors: [{ connectorId: 1, status: 'Charging', charging: true }],
    }} />);

    expect(await zustandsSatz('Anschluss 1 lädt.')).toBeVisible();
    const nowCard = view.container.querySelector<HTMLElement>('[data-state="charging"]')!;
    expect(within(nowCard).getByText('Ladeleistung und Sitzungsdaten werden noch nicht übertragen.')).toBeVisible();
    expect(within(nowCard).queryByText('Nicht verfügbar')).toBeNull();
    expect(nowCard.querySelector('.vp-ocpp-now-facts')).toBeNull();
    expect(nowCard.querySelector('.vp-ocpp-primary-action')).toBeNull();
    // Mit AKTUELLEM Beleg der Box trägt die Säule ihren Schalter - Automatik gilt.
    const steuerung = screen.getByTestId('geraet-steuerung');
    expect(within(steuerung).getByRole('radio', { name: /Automatik/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(steuerung).getByRole('radio', { name: /Sofort laden/ })).toBeInTheDocument();
  });

  it('keeps a stale connector out of status, reason and connector settings despite a fresh heartbeat', async () => {
    vi.mocked(api.ocppStations).mockResolvedValue([{
      ...station,
      lastSeen: new Date().toISOString(),
      connectors: [{ ...station.connectors[0], status: 'Charging', reportedAt: new Date(Date.now() - 10 * 60_000).toISOString() }],
    }]);
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" charger={{
      deviceId: 'd', chargePointId: 'CP-1', priority: true, connected: true, ready: true,
      connectors: [{ connectorId: 1, charging: true, allocatedKw: 11, boost: true, reasonText: 'lädt mit Netzfreigabe' }],
    }} />);
    expect(await zustandsSatz('Status von Anschluss 1 nicht aktuell.')).toBeVisible();
    expect(screen.getByText('Anschluss 1 zuletzt: Lädt')).toBeVisible();
    expect(document.querySelector('.vp-ocpp-primary-action')).toBeNull();
    expect(document.body).not.toHaveTextContent('lädt mit Netzfreigabe');
    expect(document.body).not.toHaveTextContent('11 kW');
    // ⚠ Kein Schalter über einen Stecker, dessen Stand niemand kennt.
    expect(screen.queryByTestId('geraet-steuerung')).toBeNull();
    expect(screen.getByText('Aktuelle Freigabe').nextElementSibling).toHaveTextContent('nicht gemeldet');
    expect(screen.getByText('Sofort laden').nextElementSibling).toHaveTextContent('nicht verfügbar');
  });

  it('never uses connector 1 status or settings for an open transaction on connector 2', async () => {
    vi.mocked(api.ocppStations).mockResolvedValue([{
      ...station,
      lastSeen: new Date().toISOString(),
      connectors: [{ ...station.connectors[0], status: 'Charging', reportedAt: new Date().toISOString() }],
    }]);
    vi.mocked(api.ocppTransactions).mockResolvedValue([{
      deviceId: 'd', chargePointId: 'CP-1', transactionId: 43, connectorId: 2,
      startedAt: new Date(Date.now() - 60_000).toISOString(), stoppedAt: null, meterStart: 0, meterStop: null,
      stopReason: null, startIdTagRef: null, stopIdTagRef: null, reservationId: null, chargingProfileId: null,
      chargingProfilePurpose: null, startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
      transactionData: null, transactionDataPurgedAt: null,
    }]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" charger={{
      deviceId: 'd', chargePointId: 'CP-1', priority: false, connected: true, ready: true,
      connectors: [{ connectorId: 1, charging: true, allocatedKw: 22, boost: true, reasonText: 'Connector 1 lädt' }],
    }} />);
    expect(await zustandsSatz('Status von Anschluss 2 nicht aktuell.')).toBeVisible();
    expect(screen.getByText('Anschluss 2: kein aktueller Zustand')).toBeVisible();
    expect(document.body).not.toHaveTextContent('Connector 1 lädt');
    expect(document.body).not.toHaveTextContent('22 kW');
    expect(screen.getByText('Sofort laden').nextElementSibling).toHaveTextContent('nicht verfügbar');
    expect(document.querySelector('.vp-ocpp-primary-action')).toBeNull();
  });

  it('keeps loading and full API failure explicit and recoverable', async () => {
    vi.mocked(api.ocppStations).mockReturnValueOnce(new Promise(() => {}));
    const loading = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(screen.getByRole('status')).toHaveTextContent('Wallbox-Daten werden geladen');
    loading.unmount();

    for (const method of ['ocppStations', 'ocppEvents', 'ocppGaps', 'ocppTransactions',
      'ocppMeterValues', 'ocppConfiguration', 'ocppActionPermissions', 'ocppActions'] as const) {
      vi.mocked(api[method] as (...args: never[]) => Promise<never>).mockRejectedValueOnce(new Error('down'));
    }
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await screen.findByText(/OCPP-Gerätedaten konnten nicht geladen/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Erneut laden' })).toBeVisible();
  });

  it('does not present unsupported or unauthorized actions as executable', async () => {
    vi.mocked(api.ocppTransactions).mockResolvedValue([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    vi.mocked(api.ocppStations).mockResolvedValue([{
      ...station,
      lastSeen: new Date().toISOString(),
      supportedFeatureProfiles: [],
      connectors: [{ ...station.connectors[0], status: 'Available', reportedAt: new Date().toISOString() }],
    }]);
    vi.mocked(api.ocppActionPermissions).mockResolvedValue({ actions: {} });
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await screen.findByRole('button', { name: 'Laden starten' })).toBeDisabled();
    expect(screen.getByText(/Fernaktion ist für Ihr Konto nicht freigegeben/)).toBeVisible();
    expect(screen.queryByTestId('sektion-befehle')).toBeNull();
    expect(screen.queryByRole('button', { name: /Firmware aktualisieren/ })).toBeNull();
    expect(screen.queryByText(/NotSupported möglich/)).toBeNull();
  });

  it('shows inputs and impact before sending, then keeps response and effect separate', async () => {
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await zustandsSatz('Anschluss 1 lädt.');
    fireEvent.click(screen.getByRole('button', { name: 'Laden stoppen' }));
    expect(screen.getByText('Auswirkung')).toBeVisible();
    expect(screen.getByText('Bestätigung')).toBeVisible();
    expect(screen.getByLabelText('Transaktion *')).toHaveValue(42);
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen und senden' }));
    await waitFor(() => expect(api.createOcppAction).toHaveBeenCalled());
    expect(screen.getAllByText(/OCPP-Antwort ausstehend/).some((node) => node.textContent?.includes('Gesendet'))).toBe(true);
    expect(screen.getAllByText(/Wirkung noch nicht prüfbar/).length).toBeGreaterThan(0);
  });

  it('reuses the idempotency key after an uncertain transport error and hides the raw server text', async () => {
    vi.mocked(api.createOcppAction)
      .mockRejectedValueOnce(new ApiError(503, 'java.net.SocketTimeoutException: broker token=abc'))
      .mockResolvedValueOnce(created);
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await zustandsSatz('Anschluss 1 lädt.');
    fireEvent.click(screen.getByRole('button', { name: 'Laden stoppen' }));
    const send = screen.getByRole('button', { name: 'Prüfen und senden' });
    fireEvent.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Doppelwirkung/);
    expect(document.body).not.toHaveTextContent('token=abc');
    fireEvent.click(send);
    await waitFor(() => expect(api.createOcppAction).toHaveBeenCalledTimes(2));
    const firstKey = vi.mocked(api.createOcppAction).mock.calls[0][3];
    const secondKey = vi.mocked(api.createOcppAction).mock.calls[1][3];
    expect(secondKey).toBe(firstKey);
  });

  it('masks assigned identifiers and every URI scheme across all untrusted OCPP DOM surfaces', async () => {
    vi.mocked(api.ocppStations).mockResolvedValue([{ ...station, lastSeen: new Date().toISOString(), connectors: [{
      ...station.connectors[0], reportedAt: new Date().toISOString(), info: 'idTag=CONNECTOR-LEAK callback=mqtt://connector.internal/topic',
    }] }]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([{ sampledAt: new Date().toISOString(), eventId: 'meter-secret', meterValueIndex: 0,
      sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42,
      source: 'MeterValues', pointKey: 'Vendor.Custom.Measure', measurand: 'Vendor.Custom.Measure', context: 'Sample.Periodic',
      format: 'Raw', phase: null, location: 'Outlet', unit: null,
      value: 'idTag=METER-LEAK endpoint=modbus://meter.internal/unit', numericValue: null }]);
    vi.mocked(api.ocppEvents).mockResolvedValue([{ eventId: 'event-secret', occurredAt: new Date().toISOString(), deviceId: 'd',
      chargePointId: 'CP-1', direction: 'station_to_csms', messageType: 'CallError', correlationId: 'idTag=EVENT-CORRELATION', action: 'DataTransfer',
      errorCode: 'InternalError', errorDescription: 'idTag=EVENT-LEAK callback=coap://event.internal/diag',
      errorDetails: { uploadUrl: 'ftp://event-pre.internal/diag' }, payload: { neutral: 'uri=s3://pre.internal/token/abc' } }]);
    vi.mocked(api.ocppTransactions).mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1,
      startedAt: new Date(Date.now() - 60_000).toISOString(), stoppedAt: null, meterStart: 0, meterStop: null, stopReason: null,
      startIdTagRef: null, stopIdTagRef: null, reservationId: null, chargingProfileId: null, chargingProfilePurpose: null,
      startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
      transactionData: { callbackUrl: 'https://transaction-pre.internal/token/abc' }, transactionDataPurgedAt: null }]);
    vi.mocked(api.ocppActions).mockResolvedValue([{ ...created, state: 'completed',
      reason: 'idTag=ACTION-LEAK url=ftp://action.internal/file', request: { neutral: 'callback=wss://action-pre.internal/socket' } }]);
    vi.mocked(api.ocppActionAudit).mockResolvedValue([{ id: 1, actor: 'idTag=AUDIT-ACTOR', state: 'completed',
      reason: 'endpoint=ssh://audit.internal/private', deviceId: 'd', chargePointId: 'CP-1', connectorId: 1,
      transactionId: 42, occurredAt: new Date().toISOString() }]);
    vi.mocked(api.ocppActionPermissions).mockResolvedValue({ actions: {
      RemoteStartTransaction: true, RemoteStopTransaction: true, UnlockConnector: true,
      SoftReset: true,
    } });
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await zustandsSatz('Anschluss 1 lädt.');
    await technikOeffnen();
    fireEvent.click(screen.getByRole('button', { name: 'Unveränderliche Auditspur laden' }));
    await screen.findByRole('list', { name: 'Unveränderliche Auditspur' });
    for (const leak of ['CONNECTOR-LEAK', 'connector.internal', 'METER-LEAK', 'meter.internal', 'EVENT-CORRELATION',
      'EVENT-LEAK', 'event.internal', 'event-pre.internal', 'pre.internal', 'transaction-pre.internal',
      'ACTION-LEAK', 'action.internal', 'action-pre.internal', 'AUDIT-ACTOR', 'audit.internal']) {
      expect(document.body).not.toHaveTextContent(leak);
    }
  });

  it('uses the house modal mechanics for description, focus trap, busy lock and focus return', async () => {
    let resolveAction!: (value: OcppAction) => void;
    vi.mocked(api.createOcppAction).mockReturnValue(new Promise((resolve) => { resolveAction = resolve; }));
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await zustandsSatz('Anschluss 1 lädt.');
    const trigger = screen.getByRole('button', { name: 'Laden stoppen' });
    trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-describedby', 'ocpp-action-description');
    const close = screen.getByRole('button', { name: 'Dialog schließen' });
    const send = screen.getByRole('button', { name: 'Prüfen und senden' });
    send.focus(); fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(send);
    fireEvent.click(send);
    await waitFor(() => expect(close).toBeDisabled());
    fireEvent.click(close); fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeVisible();
    await act(async () => { resolveAction(created); });
    fireEvent.click(await screen.findByRole('button', { name: 'Zum Journal' }));
    expect(document.activeElement).toBe(trigger);
  });

  it('shows data gaps, immutable audit and cancellation of a prepared action', async () => {
    const prepared = { ...created, state: 'prepared', sentAt: null };
    vi.mocked(api.ocppActions).mockResolvedValue([prepared]);
    vi.mocked(api.ocppGaps).mockResolvedValue([{ eventId: 'gap-1', reportedAt: new Date().toISOString(), deviceId: 'd',
      droppedCount: 3, totalDropped: 7, firstOccurredAt: new Date(Date.now() - 60_000).toISOString(),
      lastOccurredAt: new Date().toISOString(), firstEventId: 'a', lastEventId: 'b', reasons: { buffer_full: 3 } }]);
    vi.mocked(api.ocppActionAudit).mockResolvedValue([{ id: 1, actor: 'operator@example.test', state: 'prepared', reason: null,
      deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42, occurredAt: new Date().toISOString() }]);
    vi.mocked(api.ocppAction).mockResolvedValue({ ...prepared, state: 'cancelled' });
    vi.mocked(api.ocppActionPermissions).mockResolvedValue({ actions: {
      RemoteStartTransaction: true, RemoteStopTransaction: true, UnlockConnector: true,
      SoftReset: true,
    } });
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    // ⚠ Eine belegte Lücke bleibt entdeckbar, obwohl „Technik & Diagnose" eine
    // eigene Ansicht ist: die geschlossene Zeile SAGT sie (eine Tür, die nicht
    // sagt, was hinter ihr liegt, ist die Wand, die der Kern beendet).
    const zeile = await screen.findByTestId('geraet-technik-oeffnen');
    await waitFor(() => expect(zeile).toHaveTextContent(/1 Lücken?/));
    await technikOeffnen();
    expect(screen.getByText(/1 belegte Datenlücke/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Unveränderliche Auditspur laden' }));
    expect(await screen.findByRole('list', { name: 'Unveränderliche Auditspur' })).toHaveTextContent('Vorbereitet');
    fireEvent.click(screen.getByRole('button', { name: 'Vor Versand abbrechen' }));
    await waitFor(() => expect(api.cancelOcppAction).toHaveBeenCalledWith('s', prepared.id));
    expect(await screen.findByText('Vor Versand abgebrochen')).toBeVisible();
  });

  it('suppresses a negative completed meter delta in both session summaries', async () => {
    vi.mocked(api.ocppTransactions).mockResolvedValue([{
      deviceId: 'd', chargePointId: 'CP-1', transactionId: 44, connectorId: 1,
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), stoppedAt: new Date().toISOString(),
      meterStart: 2000, meterStop: 1000, stopReason: 'Local', startIdTagRef: null, stopIdTagRef: null,
      reservationId: null, chargingProfileId: null, chargingProfilePurpose: null, startAuthStatus: 'Accepted',
      stopAuthStatus: 'Accepted', parentIdTagRef: null, transactionData: null, transactionDataPurgedAt: null,
    }]);
    vi.mocked(api.ocppMeterValues).mockResolvedValue([]);
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    await zustandsSatz('Anschluss 1 lädt.');
    // Beide Zusammenfassungen sagen es - die Ladevorgänge der Seite UND die
    // Transaktionen in „Technik & Diagnose"; nirgends steht eine negative Energie.
    expect(within(screen.getByTestId('baustein-aktivitaet')).getAllByText('Energie nicht verfügbar')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('-1 kWh');
    const technik = await technikOeffnen();
    expect(within(technik).getAllByText('Energie nicht verfügbar')).toHaveLength(1);
    expect(document.body).not.toHaveTextContent('-1 kWh');
  });

  it('hands a bound foreign-firmware intent to a second operator and executes it unchanged', async () => {
    vi.mocked(api.ocppActionPermissions).mockResolvedValue({ actions: { UpdateFirmware: true } });
    vi.spyOn(api, 'createOcppActionIntent').mockResolvedValue({ id: 'intent-foreign', action: 'UpdateFirmware',
      phrase: 'UpdateFirmware CP-1 SAFE1234', fourEyes: true, expiresAt: '2099-01-01T00:00:00Z' });
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await zustandsSatz('Anschluss 1 lädt.');
    await technikOeffnen();
    fireEvent.click(screen.getByText('Betrieb').closest('summary')!);
    fireEvent.click(screen.getByRole('button', { name: /Firmware aktualisieren/ }));
    fireEvent.change(screen.getByLabelText('Allowlisted Firmware-URL *'), { target: { value: 'https://firmware.example/presigned' } });
    fireEvent.change(screen.getByLabelText('Abruf ab *'), { target: { value: '2026-08-26T12:00' } });
    fireEvent.change(screen.getByLabelText('SHA-256 *'), { target: { value: 'a'.repeat(64) } });
    fireEvent.change(screen.getByLabelText('Signatur *'), { target: { value: 'signed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Starke Bestätigung vorbereiten' }));
    const handoffCode = await screen.findByLabelText('Gebundener Übergabecode') as HTMLTextAreaElement;
    expect(screen.getByRole('button', { name: 'Übergabe durch zweiten Operator erforderlich' })).toBeDisabled();
    const code = handoffCode.value;
    fireEvent.click(screen.getByRole('button', { name: 'Dialog schließen' }));

    fireEvent.click(screen.getByRole('button', { name: /Firmware aktualisieren/ }));
    fireEvent.click(screen.getByText('Vier-Augen-Übergabe eines anderen Operators übernehmen'));
    fireEvent.change(screen.getByLabelText('Übergabecode'), { target: { value: code } });
    fireEvent.click(screen.getByRole('button', { name: 'Übergabe prüfen' }));
    expect(screen.getByText('Gebundene Übergabe übernommen')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Bestätigungsphrase'), { target: { value: 'UpdateFirmware CP-1 SAFE1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen und senden' }));
    await waitFor(() => expect(api.createOcppAction).toHaveBeenCalled());
    expect(vi.mocked(api.createOcppAction).mock.calls.at(-1)?.[2]).toMatchObject({
      action: 'UpdateFirmware', intentId: 'intent-foreign', confirmationPhrase: 'UpdateFirmware CP-1 SAFE1234',
      request: { location: 'https://firmware.example/presigned', sha256: 'a'.repeat(64), signature: 'signed' },
    });
  });

  it('aborts an in-flight action poll when the station target changes', async () => {
    vi.useFakeTimers();
    const sent = { ...created, state: 'sent' };
    let pollSignal: AbortSignal | undefined;
    vi.mocked(api.ocppActions).mockResolvedValue([sent]);
    vi.mocked(api.ocppActions).mockResolvedValueOnce([sent]).mockImplementationOnce((_site, _cp, _limit, signal) => {
      pollSignal = signal;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const view = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(pollSignal).toBeDefined();
    await act(async () => { view.rerender(<OcppWallboxPage siteId="s" chargePointId="CP-2" fallbackTitle="Wallbox" backHref="#back" />); });
    expect(pollSignal?.aborted).toBe(true);
  });
});
