import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type OcppAction, type OcppStation } from '../api';
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
    vi.spyOn(api, 'ocppStations').mockResolvedValue([station]);
    vi.spyOn(api, 'ocppEvents').mockResolvedValue([]);
    vi.spyOn(api, 'ocppTransactions').mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', transactionId: 42, connectorId: 1, startedAt: new Date(Date.now() - 42 * 60_000).toISOString(), stoppedAt: null, meterStart: 0, meterStop: null, stopReason: null, startIdTagRef: 'private-reference', stopIdTagRef: null, reservationId: null, chargingProfileId: null, chargingProfilePurpose: null, startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null, transactionData: null, transactionDataPurgedAt: null }]);
    vi.spyOn(api, 'ocppMeterValues').mockResolvedValue([{ sampledAt: new Date().toISOString(), eventId: 'e', meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'd', chargePointId: 'CP-1', connectorId: 1, transactionId: 42, source: 'MeterValues', pointKey: 'power', measurand: 'Power.Active.Import', context: 'Sample.Periodic', format: 'Raw', phase: null, location: 'Outlet', unit: 'W', value: '11000', numericValue: 11000 }]);
    vi.spyOn(api, 'ocppConfiguration').mockResolvedValue([{ deviceId: 'd', chargePointId: 'CP-1', keys: [{ key: 'AuthorizationKey', value: null, readonly: false, secret: true, redacted: true, standardKey: false, meaningKnown: false, reportedAt: new Date().toISOString() }], unknownKeys: ['VendorMystery'], supportedFeatureProfiles: ['SmartCharging'] }]);
    vi.spyOn(api, 'ocppActionPermissions').mockResolvedValue({ actions: Object.fromEntries([
      'RemoteStartTransaction','RemoteStopTransaction','UnlockConnector','ReserveNow','CancelReservation','SetChargingProfile','ClearChargingProfile','GetCompositeSchedule',
    ].map((action) => [action, true])) });
    vi.spyOn(api, 'ocppActions').mockResolvedValue([]);
    vi.spyOn(api, 'createOcppAction').mockResolvedValue(created);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders the complete IA, live hero, honest unknowns and visible role locks', async () => {
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    expect(await screen.findByRole('heading', { name: 'Auto lädt' })).toBeVisible();
    for (const label of ['Jetzt', 'Stecker', 'Messwerte', 'Aktionen', 'Konfiguration', 'Ereignisse', 'Ladevorgänge', 'Software & Diagnose']) {
      expect(screen.getByRole('link', { name: label })).toBeVisible();
    }
    expect(screen.getByText('11 kW')).toBeVisible();
    expect(screen.getByText('••••••••')).toBeVisible();
    fireEvent.click(screen.getByText(/unknownKey/));
    expect(screen.getByText(/VendorMystery/)).toBeVisible();
    const hardReset = screen.getByRole('button', { name: /Hart neu starten/ });
    expect(hardReset).toBeDisabled();
    expect(within(hardReset).getByText(/Plattformoperator/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Firmware aktualisieren/ })).toBeDisabled();
  });

  it('shows inputs and impact before sending, then keeps response and effect separate', async () => {
    render(<OcppWallboxPage siteId="s" chargePointId="CP-1" fallbackTitle="Wallbox" backHref="#back" />);
    await screen.findByRole('heading', { name: 'Auto lädt' });
    fireEvent.click(screen.getByRole('button', { name: 'Laden stoppen' }));
    expect(screen.getByText('Auswirkung')).toBeVisible();
    expect(screen.getByText('Bestätigung')).toBeVisible();
    expect(screen.getByLabelText('Transaktion *')).toHaveValue(42);
    fireEvent.click(screen.getByRole('button', { name: 'Prüfen und senden' }));
    await waitFor(() => expect(api.createOcppAction).toHaveBeenCalled());
    expect(screen.getAllByText(/OCPP-Antwort ausstehend/).some((node) => node.textContent?.includes('Gesendet'))).toBe(true);
    expect(screen.getAllByText(/Wirkung noch nicht prüfbar/).length).toBeGreaterThan(0);
  });
});
