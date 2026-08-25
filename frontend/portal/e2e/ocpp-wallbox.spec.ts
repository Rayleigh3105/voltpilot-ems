import { expect, test, type Page } from '@playwright/test';

const now = new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const station = { deviceId: 'device-1', chargePointId: 'CP-CARPORT', connected: true, connectedAt: now,
  disconnectedAt: null, lastSeen: now, bootedAt: ago(43 * 60_000), chargeBoxSerialNumber: 'K-BOX-18477',
  chargePointModel: 'P30', chargePointSerialNumber: 'KP30-18477', chargePointVendor: 'KEBA', firmwareVersion: '1.9.4',
  iccid: '893491234567890', imsi: '262011234567890', meterSerialNumber: 'MID-22', meterType: 'MID',
  diagnosticsStatus: 'Uploaded', diagnosticsStatusAt: now, firmwareStatus: 'Installed', firmwareStatusAt: now,
  supportedFeatureProfiles: ['Core', 'SmartCharging', 'Reservation', 'LocalAuthListManagement', 'RemoteTrigger', 'FirmwareManagement'],
  connectors: [
    { connectorId: 1, status: 'Charging', errorCode: 'NoError', info: null, vendorId: 'KEBA', vendorErrorCode: null, stationTimestamp: now, reportedAt: now },
    { connectorId: 2, status: 'Available', errorCode: 'NoError', info: 'vendor field remains honest', vendorId: 'KEBA', vendorErrorCode: 'V-0', stationTimestamp: now, reportedAt: now },
  ] };
const transaction = { deviceId: 'device-1', chargePointId: 'CP-CARPORT', transactionId: 1842, connectorId: 1,
  startedAt: ago(42 * 60_000), stoppedAt: null, meterStart: 1000, meterStop: null, stopReason: null,
  startIdTagRef: 'private-idtag-reference', stopIdTagRef: null, reservationId: null, chargingProfileId: 12,
  chargingProfilePurpose: 'TxProfile', startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
  transactionData: { sampledValue: [{ value: 'private', idTag: 'must-hide' }], callbackUrl: 'https://secret.example/token/abc' }, transactionDataPurgedAt: null };
const sample = (id: string, measurand: string, value: number, unit: string) => ({ sampledAt: now, eventId: id,
  meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'device-1', chargePointId: 'CP-CARPORT', connectorId: 1,
  transactionId: 1842, source: 'MeterValues', pointKey: measurand, measurand, context: 'Sample.Periodic',
  format: 'Raw', phase: null, location: 'Outlet', unit, value: String(value), numericValue: value });
const late = { id: 'late-1', deviceId: 'device-1', chargePointId: 'CP-CARPORT', action: 'SoftReset', state: 'timed_out',
  correlationId: 'ocpp-late', idempotencyKey: 'late', actor: 'operator@example.test', connectorId: null, transactionId: null,
  request: { callbackUrl: 'https://secret.example/token/abc' }, response: { status: 'Accepted' }, responseStatus: 'Accepted', effect: { action: 'BootNotification' },
  reason: 'Passender Folgebeleg BootNotification später beobachtet.', preparedAt: ago(4 * 60_000), sentAt: ago(4 * 60_000), responseAt: ago(3 * 60_000),
  effectAt: now, deadlineAt: ago(60_000), updatedAt: now };

const timedOut = { ...late, effect: null, effectAt: null, reason: null, updatedAt: ago(60_000) };

async function mock(page: Page, options: { failFirstAction?: boolean; slowAction?: boolean; lateAfterPoll?: boolean; fourEyes?: boolean } = {}) {
  let actions = [late];
  let actionPosts = 0;
  let actionGets = 0;
  const idempotencyKeys: string[] = [];
  await page.route('**/api/v1/sites/site-e2e/ocpp/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (route.request().method() === 'POST' && path.endsWith('/action-intents')) {
      const body = route.request().postDataJSON();
      return route.fulfill({ json: { id: 'intent-1', action: body.action, phrase: `${body.action} CP-CARPORT SAFE1234`, fourEyes: Boolean(options.fourEyes), expiresAt: '2099-08-25T09:00:00Z' } });
    }
    if (route.request().method() === 'POST' && path.endsWith('/actions')) {
      actionPosts += 1;
      idempotencyKeys.push(route.request().headers()['idempotency-key']);
      if (options.failFirstAction && actionPosts === 1) return route.fulfill({ status: 503, json: { message: 'java.net.SocketTimeoutException token=abc' } });
      if (options.slowAction) await new Promise((resolve) => setTimeout(resolve, 650));
      const body = route.request().postDataJSON();
      const created = { id: `new-${body.action}`, deviceId: 'device-1', chargePointId: 'CP-CARPORT', action: body.action,
        state: 'accepted_waiting_effect', correlationId: `ocpp-${body.action}`, idempotencyKey: route.request().headers()['idempotency-key'],
        actor: 'operator@example.test', connectorId: body.connectorId ?? null, transactionId: body.transactionId ?? null,
        request: body.request, response: { status: 'Accepted' }, responseStatus: 'Accepted', effect: null,
        reason: null, preparedAt: now, sentAt: now, responseAt: now, effectAt: null,
        deadlineAt: '2099-08-25T09:00:00Z', updatedAt: now };
      actions = [created, ...actions]; return route.fulfill({ status: 201, json: created });
    }
    if (route.request().method() === 'DELETE' && /\/actions\/[^/]+$/.test(path)) return route.fulfill({ status: 204 });
    if (path.endsWith('/audit')) return route.fulfill({ json: [{ id: 1, actor: 'operator@example.test', state: 'prepared', reason: null, deviceId: 'device-1', chargePointId: 'CP-CARPORT', connectorId: 1, transactionId: 1842, occurredAt: now }] });
    if (path.endsWith('/stations')) return route.fulfill({ json: [station] });
    if (path.endsWith('/events')) return route.fulfill({ json: [{ eventId: 'event-1', occurredAt: now, deviceId: 'device-1', chargePointId: 'CP-CARPORT', direction: 'station_to_csms', messageType: 'CallError', correlationId: 'wire-7', action: 'DataTransfer', errorCode: 'NotSupported', errorDescription: 'upload https://private.example/diag?token=secret', errorDetails: { uploadUrl: 'https://private.example/diag?token=secret' }, payload: { password: 'must-hide', neutral: 'https://secret.example/token/abc', unknownVendorField: 7 } }] });
    if (path.endsWith('/gaps')) return route.fulfill({ json: [{ eventId: 'gap-1', reportedAt: now, deviceId: 'device-1', droppedCount: 2, totalDropped: 2, firstOccurredAt: ago(90_000), lastOccurredAt: ago(60_000), firstEventId: 'lost-a', lastEventId: 'lost-b', reasons: { buffer_full: 2 } }] });
    if (path.endsWith('/transactions')) return route.fulfill({ json: [transaction] });
    if (path.endsWith('/meter-values')) return route.fulfill({ json: [sample('power', 'Power.Active.Import', 11000, 'W'), sample('energy', 'Energy.Active.Import.Register', 7400, 'Wh'), sample('soc', 'SoC', 62, 'Percent'), sample('vendor', 'Vendor.Custom.Measure', 1847, '')] });
    if (path.endsWith('/configuration')) return route.fulfill({ json: [{ deviceId: 'device-1', chargePointId: 'CP-CARPORT', keys: [{ key: 'AuthorizationKey', value: null, readonly: false, secret: true, redacted: true, standardKey: false, meaningKnown: false, reportedAt: now }, { key: 'HeartbeatInterval', value: '60', readonly: false, secret: false, redacted: false, standardKey: true, meaningKnown: true, reportedAt: now }], unknownKeys: ['KEBA.Custom.Mode'], supportedFeatureProfiles: station.supportedFeatureProfiles }] });
    if (path.endsWith('/action-permissions')) return route.fulfill({ json: { actions: Object.fromEntries(['RemoteStartTransaction','RemoteStopTransaction','UnlockConnector','ReserveNow','CancelReservation','SetChargingProfile','ClearChargingProfile','GetCompositeSchedule','ChangeAvailability','SoftReset','HardReset','GetConfiguration','ChangeConfiguration','ClearCache','GetLocalListVersion','SendLocalList','TriggerMessage','GetDiagnostics','UpdateFirmware','DataTransfer'].map((key) => [key, true])) } });
    if (path.endsWith('/actions')) {
      actionGets += 1;
      if (options.lateAfterPoll) return route.fulfill({ json: actionGets === 1 ? [timedOut] : [late] });
      return route.fulfill({ json: actions });
    }
    if (/\/actions\/[^/]+$/.test(path)) return route.fulfill({ json: actions[0] });
    return route.fulfill({ status: 404, json: { message: 'unmocked' } });
  });
  return { idempotencyKeys };
}

test('complete wallbox home stays responsive and exposes response/effect choreography', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await mock(page); await page.goto('/e2e/ocpp-wallbox.html');
  await expect(page.getByRole('heading', { name: 'Auto lädt' })).toBeVisible();
  await expect(page.getByText('11 kW')).toBeVisible();
  await expect(page.getByText('62 %').first()).toBeVisible();
  await expect(page.getByText(/1 belegte Datenlücke/)).toBeVisible();
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
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('secret.example');
  expect(body).not.toContain('private.example');
  expect(body).not.toContain('token=secret');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const contrastFailures = await page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const color = (css: string): Rgba => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = css; context.fillRect(0, 0, 1, 1);
      const p = context.getImageData(0, 0, 1, 1).data; return [p[0], p[1], p[2], p[3] / 255];
    };
    const over = (front: Rgba, back: Rgba): Rgba => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [0, 1, 2, 3].map((_, i) => i === 3 ? alpha
        : (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha) as Rgba;
    };
    const lum = (rgb: Rgba) => {
      const c = rgb.slice(0, 3).map((v) => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
      return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    };
    const ratio = (a: Rgba, b: Rgba) => { const l1 = lum(a); const l2 = lum(b); return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05); };
    return [...document.querySelectorAll<HTMLElement>('.vp-ocpp *')].filter((element) =>
      [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
      && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      .map((element) => {
        const ancestors: HTMLElement[] = []; let current: HTMLElement | null = element;
        while (current) { ancestors.unshift(current); current = current.parentElement; }
        let background: Rgba = [255, 255, 255, 1];
        for (const ancestor of ancestors) background = over(color(getComputedStyle(ancestor).backgroundColor), background);
        const style = getComputedStyle(element); const foreground = over(color(style.color), background);
        const size = Number.parseFloat(style.fontSize); const bold = Number.parseInt(style.fontWeight, 10) >= 700;
        const required = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
        return { text: element.textContent?.trim().slice(0, 80), ratio: ratio(foreground, background), required };
      }).filter((item) => item.ratio + .01 < item.required);
  });
  expect(contrastFailures).toEqual([]);
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

test('transport retry is idempotent and the modal traps focus while every close path is busy-locked', async ({ page }) => {
  const state = await mock(page, { failFirstAction: true, slowAction: true });
  await page.goto('/e2e/ocpp-wallbox.html');
  const trigger = page.getByRole('button', { name: 'Laden stoppen', exact: true });
  await trigger.focus(); await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAttribute('aria-describedby', 'ocpp-action-description');
  const send = page.getByRole('button', { name: 'Prüfen und senden' });
  await send.focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Dialog schließen' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(send).toBeFocused();
  await send.click();
  await expect(dialog.getByRole('alert')).toContainText('Doppelwirkung');
  await expect(dialog).not.toContainText('token=abc');
  await send.click();
  const close = page.getByRole('button', { name: 'Dialog schließen' });
  await expect(close).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Befehl ist erfasst')).toBeVisible();
  expect(state.idempotencyKeys).toHaveLength(2);
  expect(state.idempotencyKeys[1]).toBe(state.idempotencyKeys[0]);
  await dialog.getByRole('button', { name: 'Zum Journal' }).click();
  await expect(trigger).toBeFocused();
});

test('timed-out actions keep polling until late effect evidence arrives', async ({ page }) => {
  await mock(page, { lateAfterPoll: true });
  await page.goto('/e2e/ocpp-wallbox.html');
  await expect(page.getByText('Wirkung nicht innerhalb der Frist beobachtet')).toBeVisible();
  await expect(page.getByText('Wirkung verspätet beobachtet')).toBeVisible({ timeout: 7_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('foreign firmware has an executable bound handoff to a second operator', async ({ page }) => {
  await mock(page, { fourEyes: true });
  await page.goto('/e2e/ocpp-wallbox.html');
  await page.locator('.vp-ocpp-action-group').filter({ hasText: 'Betrieb' }).locator('summary').click();
  const firmware = page.getByRole('button', { name: /Firmware aktualisieren/ });
  await firmware.click();
  await page.getByLabel('Allowlisted Firmware-URL *').fill('https://firmware.example/presigned');
  await page.getByLabel('Abruf ab *').fill('2026-08-26T12:00');
  await page.getByLabel('SHA-256 *').fill('a'.repeat(64));
  await page.getByLabel('Signatur *').fill('signed');
  await page.getByRole('button', { name: 'Starke Bestätigung vorbereiten' }).click();
  const code = await page.getByLabel('Gebundener Übergabecode').inputValue();
  await expect(page.getByRole('button', { name: 'Übergabe durch zweiten Operator erforderlich' })).toBeDisabled();
  await page.getByRole('button', { name: 'Dialog schließen' }).click();

  await firmware.click();
  await page.getByText('Vier-Augen-Übergabe eines anderen Operators übernehmen').click();
  await page.getByLabel('Übergabecode').fill(code);
  await page.getByRole('button', { name: 'Übergabe prüfen' }).click();
  await expect(page.getByText('Gebundene Übergabe übernommen')).toBeVisible();
  await page.getByLabel('Bestätigungsphrase').fill('UpdateFirmware CP-CARPORT SAFE1234');
  await page.getByRole('button', { name: 'Prüfen und senden' }).click();
  await expect(page.getByText('Befehl ist erfasst')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
