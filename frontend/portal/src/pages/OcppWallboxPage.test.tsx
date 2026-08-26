import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type OcppAction, type OcppStation } from '../api';
import { OcppWallboxPage } from './OcppWallboxPage';

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
    vi.spyOn(api, 'ocppEvents').mockResolvedValue([]);
    vi.spyOn(api, 'ocppGaps').mockResolvedValue([]);
    vi.spyOn(api, 'ocppTransactions').mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1, startedAt: new Date(Date.now() - 42 * 60_000).toISOString(), stoppedAt: null, meterStart: 1000, meterStop: null, stopReason: null, startIdTagRef: 'private-reference', stopIdTagRef: null, reservationId: null, chargingProfileId: null, chargingProfilePurpose: null, startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null, transactionData: null, transactionDataPurgedAt: null }]);
    vi.spyOn(api, 'ocppMeterValues').mockResolvedValue([
      { sampledAt: new Date().toISOString(), eventId: 'power', meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42, source: 'MeterValues', pointKey: 'power', measurand: 'Power.Active.Import', context: 'Sample.Periodic', format: 'Raw', phase: null, location: 'Outlet', unit: 'W', value: '11000', numericValue: 11000 },
      { sampledAt: new Date().toISOString(), eventId: 'energy', meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42, source: 'MeterValues', pointKey: 'energy', measurand: 'Energy.Active.Import.Register', context: 'Sample.Periodic', format: 'Raw', phase: null, location: 'Outlet', unit: 'Wh', value: '7400', numericValue: 7400 },
    ]);
    vi.spyOn(api, 'ocppConfiguration').mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', keys: [{ key: 'AuthorizationKey', value: null, readonly: false, secret: true, redacted: true, standardKey: false, meaningKnown: false, reportedAt: new Date().toISOString() }], unknownKeys: ['VendorMystery'], supportedFeatureProfiles: ['SmartCharging'] }]);
    vi.spyOn(api, 'ocppActionPermissions').mockResolvedValue({ actions: Object.fromEntries([
      'RemoteStartTransaction','RemoteStopTransaction','UnlockConnector','ReserveNow','CancelReservation','SetChargingProfile','ClearChargingProfile','GetCompositeSchedule',
    ].map((action) => [action, true])) });
    vi.spyOn(api, 'ocppActions').mockResolvedValue([]);
    vi.spyOn(api, 'createOcppAction').mockResolvedValue(created);
    vi.spyOn(api, 'ocppActionAudit').mockResolvedValue([]);
    vi.spyOn(api, 'cancelOcppAction').mockResolvedValue(undefined);
    vi.spyOn(api, 'ocppAction').mockResolvedValue({ ...created, state: 'cancelled' });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('renders the device hierarchy, one customer action and closed role-gated service detail', async () => {
    const view = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#devices" siteHref="#site" />);
    expect(await screen.findByRole('heading', { name: /Wallbox online · Anschluss 1 lädt/ })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Garage', level: 1 })).toBeVisible();
    expect(screen.getByText(/OCPP-Wallbox · KEBA · P30/)).toBeVisible();
    const breadcrumb = screen.getByRole('navigation', { name: 'Pfad zur Geräteseite' });
    expect(within(breadcrumb).getByRole('link', { name: 'Anlage' })).toHaveAttribute('href', '#site');
    expect(within(breadcrumb).getByRole('link', { name: 'Geräte' })).toHaveAttribute('href', '#devices');
    expect(screen.getByText('11 kW')).toBeVisible();
    expect(screen.getByText('6,4 kWh')).toBeVisible();
    expect(view.container.querySelectorAll('.vp-ocpp-primary-action .vp-btn')).toHaveLength(1);
    expect(view.container).not.toHaveTextContent('Erwartetes Ende');
    expect(view.container).not.toHaveTextContent('Kosten bisher');
    expect(view.container).not.toHaveTextContent('Solaranteil');
    const service = screen.getByTestId('ocpp-service');
    expect(service).not.toHaveAttribute('open');
    fireEvent.click(within(service).getByText('Service & Diagnose'));
    expect(screen.getByText('Aktiver OCPP-Ladestand')).toBeVisible();
    expect(screen.getByText('keine bestätigte Freigabe gemeldet')).toBeVisible();
    expect(screen.getByText('noch nicht erfolgreich zurückgelesen')).toBeVisible();
    expect(screen.getByText('42 min')).toBeVisible();
    expect(screen.getByText('••••••••')).toBeVisible();
    fireEvent.click(screen.getByText(/unknownKey/));
    expect(screen.getByText(/VendorMystery/)).toBeVisible();
    const hardReset = screen.getByRole('button', { name: /Hart neu starten/ });
    expect(hardReset).toBeDisabled();
    expect(within(hardReset).getByText(/Plattformoperator/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Firmware aktualisieren/ })).toBeDisabled();
  });

  it('uses routing-neutral service navigation', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    window.history.replaceState(null, '', '#/anlage/s/geraet/edge-1/cp-CP-1');
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#devices" />);
    await screen.findByRole('heading', { name: /Wallbox online/ });
    fireEvent.click(screen.getByText('Service & Diagnose'));
    const before = window.location.hash;
    fireEvent.click(screen.getByRole('button', { name: 'MeterValues' }));
    const target = document.getElementById('messwerte');
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(target).toHaveAttribute('tabindex', '-1');
    expect(window.location.hash).toBe(before);
  });

  it.each([
    ['waiting', 'SuspendedEVSE', true, 'Wallbox online · Anschluss 1 ist angesteckt und wartet.', 'Jetzt laden'],
    ['available', 'Available', true, 'Wallbox online · Anschluss 1 ist verfügbar.', 'Laden starten'],
    ['offline', 'Available', false, 'nicht erreichbar', 'Verbindung prüfen'],
    ['faulted', 'Faulted', true, 'Wallbox online · Anschluss 1 meldet eine Störung.', 'Störung prüfen'],
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
    expect(await screen.findByRole('heading', { name: new RegExp(sentence) })).toBeVisible();
    expect(screen.getByRole('button', { name: actionLabel })).toBeVisible();
    if (kind === 'offline') expect(screen.getByText('Anschluss 1 zuletzt: Frei')).toBeVisible();
    expect(view.container.querySelectorAll('.vp-ocpp-primary-action .vp-btn')).toHaveLength(1);
  });

  it('distinguishes stale and missing device data from offline', async () => {
    vi.mocked(api.ocppStations).mockResolvedValueOnce([{
      ...station,
      lastSeen: new Date(Date.now() - 10 * 60_000).toISOString(),
    }]);
    const stale = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await screen.findByRole('heading', { name: /keine aktuellen Daten/ })).toBeVisible();
    expect(stale.container.querySelector('[data-state="stale"]')).toBeInTheDocument();
    stale.unmount();

    vi.mocked(api.ocppStations).mockResolvedValueOnce([]);
    vi.mocked(api.ocppTransactions).mockResolvedValueOnce([]);
    vi.mocked(api.ocppMeterValues).mockResolvedValueOnce([]);
    const missing = render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Garage" backHref="#back" />);
    expect(await screen.findByRole('heading', { name: /noch keinen aktuellen Gerätestatus/ })).toBeVisible();
    expect(missing.container.querySelector('[data-state="unknown"]')).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: /Zustand von Anschluss 1 ist nicht aktuell/ })).toBeVisible();
    expect(screen.getByText('Anschluss 1 zuletzt: Lädt')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Status prüfen' })).toBeVisible();
    expect(document.body).not.toHaveTextContent('lädt mit Netzfreigabe');
    expect(document.body).not.toHaveTextContent('11 kW');
    expect(screen.getByText('Aktuelle Freigabe').nextElementSibling).toHaveTextContent('nicht gemeldet');
    expect(screen.getByText('Sofort laden').nextElementSibling).toHaveTextContent('nicht aktiv');
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
    expect(await screen.findByRole('heading', { name: /Zustand von Anschluss 2 ist nicht aktuell/ })).toBeVisible();
    expect(screen.getByText('Anschluss 2: kein aktueller Zustand')).toBeVisible();
    expect(document.body).not.toHaveTextContent('Connector 1 lädt');
    expect(document.body).not.toHaveTextContent('22 kW');
    expect(screen.getByRole('button', { name: 'Status prüfen' })).toBeVisible();
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
    fireEvent.click(screen.getByText('Service & Diagnose'));
    expect(screen.getByRole('button', { name: /Firmware aktualisieren/ })).toBeDisabled();
    expect(screen.getAllByText(/NotSupported möglich/).length).toBeGreaterThan(0);
  });

  it('shows inputs and impact before sending, then keeps response and effect separate', async () => {
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await screen.findByRole('heading', { name: /Wallbox online · Anschluss 1 lädt/ });
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
    await screen.findByRole('heading', { name: /Wallbox online · Anschluss 1 lädt/ });
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
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await screen.findByRole('heading', { name: /Wallbox online · Anschluss 1 lädt/ });
    fireEvent.click(screen.getByText('Service & Diagnose'));
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
    await screen.findByRole('heading', { name: /Wallbox online · Anschluss 1 lädt/ });
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
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    fireEvent.click(await screen.findByText('Service & Diagnose'));
    expect(await screen.findByText(/1 belegte Datenlücke/)).toBeVisible();
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
    await screen.findByRole('heading', { name: /Wallbox online/ });
    fireEvent.click(screen.getByText('Service & Diagnose'));
    expect(screen.getAllByText('Energie nicht verfügbar')).toHaveLength(2);
    expect(document.body).not.toHaveTextContent('-1 kWh');
  });

  it('hands a bound foreign-firmware intent to a second operator and executes it unchanged', async () => {
    vi.mocked(api.ocppActionPermissions).mockResolvedValue({ actions: { UpdateFirmware: true } });
    vi.spyOn(api, 'createOcppActionIntent').mockResolvedValue({ id: 'intent-foreign', action: 'UpdateFirmware',
      phrase: 'UpdateFirmware CP-1 SAFE1234', fourEyes: true, expiresAt: '2099-01-01T00:00:00Z' });
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await screen.findByRole('heading', { name: /Wallbox online · Anschluss 1 lädt/ });
    fireEvent.click(screen.getByText('Service & Diagnose'));
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
