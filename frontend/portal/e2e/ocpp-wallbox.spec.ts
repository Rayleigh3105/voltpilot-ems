import { expect, test, type Page } from '@playwright/test';

const now = '2026-08-25T08:42:00Z';
const station = { deviceId: 'device-1', chargePointId: 'CP-CARPORT', connected: true, connectedAt: now,
  disconnectedAt: null, lastSeen: now, bootedAt: '2026-08-25T07:59:00Z', chargeBoxSerialNumber: 'K-BOX-18477',
  chargePointModel: 'P30', chargePointSerialNumber: 'KP30-18477', chargePointVendor: 'KEBA', firmwareVersion: '1.9.4',
  iccid: '893491234567890', imsi: '262011234567890', meterSerialNumber: 'MID-22', meterType: 'MID',
  diagnosticsStatus: 'Uploaded', diagnosticsStatusAt: now, firmwareStatus: 'Installed', firmwareStatusAt: now,
  supportedFeatureProfiles: ['Core', 'SmartCharging', 'Reservation', 'LocalAuthListManagement', 'RemoteTrigger', 'FirmwareManagement'],
  connectors: [
    { connectorId: 1, status: 'Charging', errorCode: 'NoError', info: null, vendorId: 'KEBA', vendorErrorCode: null, stationTimestamp: now, reportedAt: now },
    { connectorId: 2, status: 'Available', errorCode: 'NoError', info: 'vendor field remains honest', vendorId: 'KEBA', vendorErrorCode: 'V-0', stationTimestamp: now, reportedAt: now },
  ] };
const transaction = { deviceId: 'device-1', chargePointId: 'CP-CARPORT', transactionId: 1842, connectorId: 1,
  startedAt: '2026-08-25T08:00:00Z', stoppedAt: null, meterStart: 1000, meterStop: null, stopReason: null,
  startIdTagRef: 'private-idtag-reference', stopIdTagRef: null, reservationId: null, chargingProfileId: 12,
  chargingProfilePurpose: 'TxProfile', startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
  transactionData: { sampledValue: [{ value: 'private', idTag: 'must-hide' }] }, transactionDataPurgedAt: null };
const sample = (id: string, measurand: string, value: number, unit: string) => ({ sampledAt: now, eventId: id,
  meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'device-1', chargePointId: 'CP-CARPORT', connectorId: 1,
  transactionId: 1842, source: 'MeterValues', pointKey: measurand, measurand, context: 'Sample.Periodic',
  format: 'Raw', phase: null, location: 'Outlet', unit, value: String(value), numericValue: value });
const late = { id: 'late-1', deviceId: 'device-1', chargePointId: 'CP-CARPORT', action: 'SoftReset', state: 'timed_out',
  correlationId: 'ocpp-late', idempotencyKey: 'late', actor: 'operator@example.test', connectorId: null, transactionId: null,
  request: {}, response: { status: 'Accepted' }, responseStatus: 'Accepted', effect: { action: 'BootNotification' },
  reason: 'Passender Folgebeleg BootNotification später beobachtet.', preparedAt: now, sentAt: now, responseAt: now,
  effectAt: '2026-08-25T08:53:00Z', deadlineAt: '2026-08-25T08:45:00Z', updatedAt: '2026-08-25T08:53:00Z' };

async function mock(page: Page) {
  let actions = [late];
  await page.route('**/api/v1/sites/site-e2e/ocpp/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (route.request().method() === 'POST' && path.endsWith('/action-intents')) {
      return route.fulfill({ json: { id: 'intent-1', action: 'HardReset', phrase: 'HardReset CP-CARPORT SAFE1234', fourEyes: false, expiresAt: '2099-08-25T09:00:00Z' } });
    }
    if (route.request().method() === 'POST' && path.endsWith('/actions')) {
      const body = route.request().postDataJSON();
      const created = { id: `new-${body.action}`, deviceId: 'device-1', chargePointId: 'CP-CARPORT', action: body.action,
        state: 'accepted_waiting_effect', correlationId: `ocpp-${body.action}`, idempotencyKey: route.request().headers()['idempotency-key'],
        actor: 'operator@example.test', connectorId: body.connectorId ?? null, transactionId: body.transactionId ?? null,
        request: body.request, response: { status: 'Accepted' }, responseStatus: 'Accepted', effect: null,
        reason: null, preparedAt: now, sentAt: now, responseAt: now, effectAt: null,
        deadlineAt: '2099-08-25T09:00:00Z', updatedAt: now };
      actions = [created, ...actions]; return route.fulfill({ status: 201, json: created });
    }
    if (path.endsWith('/stations')) return route.fulfill({ json: [station] });
    if (path.endsWith('/events')) return route.fulfill({ json: [{ eventId: 'event-1', occurredAt: now, deviceId: 'device-1', chargePointId: 'CP-CARPORT', direction: 'station_to_csms', messageType: 'CallError', correlationId: 'wire-7', action: 'DataTransfer', errorCode: 'NotSupported', errorDescription: 'Vendor action unsupported', errorDetails: { vendor: 'KEBA' }, payload: { password: 'must-hide', unknownVendorField: 7 } }] });
    if (path.endsWith('/transactions')) return route.fulfill({ json: [transaction] });
    if (path.endsWith('/meter-values')) return route.fulfill({ json: [sample('power', 'Power.Active.Import', 11000, 'W'), sample('energy', 'Energy.Active.Import.Register', 7400, 'Wh'), sample('soc', 'SoC', 62, 'Percent'), sample('vendor', 'Vendor.Custom.Measure', 1847, '')] });
    if (path.endsWith('/configuration')) return route.fulfill({ json: [{ deviceId: 'device-1', chargePointId: 'CP-CARPORT', keys: [{ key: 'AuthorizationKey', value: null, readonly: false, secret: true, redacted: true, standardKey: false, meaningKnown: false, reportedAt: now }, { key: 'HeartbeatInterval', value: '60', readonly: false, secret: false, redacted: false, standardKey: true, meaningKnown: true, reportedAt: now }], unknownKeys: ['KEBA.Custom.Mode'], supportedFeatureProfiles: station.supportedFeatureProfiles }] });
    if (path.endsWith('/action-permissions')) return route.fulfill({ json: { actions: Object.fromEntries(['RemoteStartTransaction','RemoteStopTransaction','UnlockConnector','ReserveNow','CancelReservation','SetChargingProfile','ClearChargingProfile','GetCompositeSchedule','ChangeAvailability','SoftReset','HardReset','GetConfiguration','ChangeConfiguration','ClearCache','GetLocalListVersion','SendLocalList','TriggerMessage','GetDiagnostics','UpdateFirmware','DataTransfer'].map((key) => [key, true])) } });
    if (path.endsWith('/actions')) return route.fulfill({ json: actions });
    return route.fulfill({ status: 404, json: { message: 'unmocked' } });
  });
}

test('complete wallbox home stays responsive and exposes response/effect choreography', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await mock(page); await page.goto('/e2e/ocpp-wallbox.html');
  await expect(page.getByRole('heading', { name: 'Auto lädt' })).toBeVisible();
  await expect(page.getByText('11 kW')).toBeVisible();
  await expect(page.getByText('62 Percent').first()).toBeVisible();
  for (const name of ['Jetzt', 'Stecker', 'Messwerte', 'Aktionen', 'Konfiguration', 'Ereignisse', 'Ladevorgänge', 'Software & Diagnose']) await expect(page.getByRole('link', { name })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  await page.getByRole('button', { name: 'Laden stoppen', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Auswirkung');
  await expect(page.getByLabel('Transaktion *')).toHaveValue('1842');
  await page.getByRole('button', { name: 'Prüfen und senden' }).click();
  await expect(page.getByRole('dialog')).toContainText('Befehl angenommen');
  await expect(page.getByRole('dialog')).toContainText('Wirkung noch nicht bestätigt');
  await page.getByRole('button', { name: 'Zum Journal' }).click();
  await expect(page.getByText('Wirkung verspätet beobachtet')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(consoleErrors).toEqual([]);
});

test('hard action requires the server phrase and never overflows its sheet', async ({ page }) => {
  await mock(page); await page.goto('/e2e/ocpp-wallbox.html');
  await page.locator('.vp-ocpp-action-group').filter({ hasText: 'Betrieb' }).locator('summary').click();
  await page.getByRole('button', { name: /Hart neu starten/ }).click();
  await page.getByRole('button', { name: 'Starke Bestätigung vorbereiten' }).click();
  await expect(page.getByText('HardReset CP-CARPORT SAFE1234')).toBeVisible();
  const send = page.getByRole('button', { name: 'Prüfen und senden' });
  await expect(send).toBeDisabled();
  await page.getByLabel('Bestätigungsphrase').fill('HardReset CP-CARPORT SAFE1234');
  await expect(send).toBeEnabled(); await send.click();
  await expect(page.getByRole('dialog')).toContainText('Wirkung noch nicht bestätigt');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
