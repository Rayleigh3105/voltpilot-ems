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
    { connectorId: 2, status: 'Available', errorCode: 'NoError', info: 'idTag=CONNECTOR-LEAK callback=mqtt://connector.internal/topic', vendorId: 'KEBA', vendorErrorCode: 'V-0', stationTimestamp: now, reportedAt: now },
  ] };
const transaction = { deviceId: 'device-1', chargePointId: 'CP-CARPORT', transactionId: 1842, connectorId: 1,
  startedAt: ago(42 * 60_000), stoppedAt: null, meterStart: 1000, meterStop: null, stopReason: null,
  startIdTagRef: 'private-idtag-reference', stopIdTagRef: null, reservationId: null, chargingProfileId: 12,
  chargingProfilePurpose: 'TxProfile', startAuthStatus: 'Accepted', stopAuthStatus: null, parentIdTagRef: null,
  transactionData: { sampledValue: [{ value: 'private', idTag: 'must-hide' }], callbackUrl: 'https://secret.example/token/abc' }, transactionDataPurgedAt: null };
const sample = (id: string, measurand: string, value: string | number, unit: string, numericValue: number | null = typeof value === 'number' ? value : null) => ({ sampledAt: now, eventId: id,
  meterValueIndex: 0, sampledValueIndex: 0, deviceId: 'device-1', chargePointId: 'CP-CARPORT', connectorId: 1,
  transactionId: 1842, source: 'MeterValues', pointKey: measurand, measurand, context: 'Sample.Periodic',
  format: 'Raw', phase: null, location: 'Outlet', unit, value: String(value), numericValue });
const late = { id: 'late-1', deviceId: 'device-1', chargePointId: 'CP-CARPORT', action: 'SoftReset', state: 'timed_out',
  correlationId: 'ocpp-late', idempotencyKey: 'late', actor: 'operator@example.test', connectorId: null, transactionId: null,
  request: { callbackUrl: 'https://secret.example/token/abc' }, response: { status: 'Accepted' }, responseStatus: 'Accepted', effect: { action: 'BootNotification' },
  reason: 'idTag=ACTION-LEAK url=ftp://action.internal/file', preparedAt: ago(4 * 60_000), sentAt: ago(4 * 60_000), responseAt: ago(3 * 60_000),
  effectAt: now, deadlineAt: ago(60_000), updatedAt: now };

const timedOut = { ...late, effect: null, effectAt: null, reason: null, updatedAt: ago(60_000) };

/** „Technik & Diagnose" ist eine eigene Ansicht (E1 a) - OCPP, Messwerte, Rohdaten. */
async function technikOeffnen(page: Page) {
  // Die Ansicht ist eine Adresse: nach einem Neuladen kann sie schon offen stehen.
  await expect(page.getByTestId('geraet-technik').or(page.getByTestId('geraet-technik-oeffnen'))).toBeVisible();
  if (await page.getByTestId('geraet-technik').isVisible()) return;
  await page.getByTestId('geraet-technik-oeffnen').click();
  await expect(page.getByTestId('geraet-technik')).toBeVisible();
}

async function mock(page: Page, options: { failFirstAction?: boolean; slowAction?: boolean; lateAfterPoll?: boolean; fourEyes?: boolean; edgeOnly?: boolean } = {}) {
  let actions = [late];
  let actionPosts = 0;
  let actionGets = 0;
  const idempotencyKeys: string[] = [];
  let control = { revision: 2, enabled: true, authorization: { mode: 'free', allowed_tags: [] },
    electrical: [], phase_limits_a: [], limits: [] };
  await page.route('**/api/v1/sites/site-e2e/ocpp/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (path.endsWith('/control')) {
      if (route.request().method() === 'PUT') control = { ...route.request().postDataJSON(), revision: control.revision + 1 };
      const observedNow = new Date().toISOString();
      return route.fulfill({ json: { desired: control, observed: [{ deviceId: 'device-1', reportedAt: observedNow,
        state: { revision: 2, enabled: true, authorization_mode: 'free', seen_tags: ['tagref_1234567890abcdef12345678'],
          stations: [{ id: 'CP-CARPORT', connected: true, capabilities_read: true, profiles_accepted: true,
            connectors: [{ id: 1, reconciling: false, power_kw: 11, power_at: observedNow, energy_at: observedNow,
              soc_at: observedNow, received_at: observedNow, fresh_power: true, command_status: 'Accepted', readback: 'ok', readback_at: observedNow }] }],
        } }] } });
    }
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
    if (path.endsWith('/audit')) return route.fulfill({ json: [{ id: 1, actor: 'idTag=AUDIT-ACTOR', state: 'prepared', reason: 'endpoint=ssh://audit.internal/private', deviceId: 'device-1', chargePointId: 'CP-CARPORT', connectorId: 1, transactionId: 1842, occurredAt: now }] });
    if (path.endsWith('/stations')) return route.fulfill({ json: options.edgeOnly ? [] : [station] });
    if (path.endsWith('/events')) return route.fulfill({ json: [{ eventId: 'event-1', occurredAt: now, deviceId: 'device-1', chargePointId: 'CP-CARPORT', direction: 'station_to_csms', messageType: 'CallError', correlationId: 'idTag=EVENT-CORRELATION', action: 'DataTransfer', errorCode: 'NotSupported', errorDescription: 'idTag=EVENT-LEAK callback=coap://event.internal/diag', errorDetails: { uploadUrl: 'ftp://event-pre.internal/diag' }, payload: { password: 'must-hide', neutral: 'uri=s3://pre.internal/token/abc', unknownVendorField: 7 } }] });
    if (path.endsWith('/gaps')) return route.fulfill({ json: [{ eventId: 'gap-1', reportedAt: now, deviceId: 'device-1', droppedCount: 2, totalDropped: 2, firstOccurredAt: ago(90_000), lastOccurredAt: ago(60_000), firstEventId: 'lost-a', lastEventId: 'lost-b', reasons: { buffer_full: 2 } }] });
    if (path.endsWith('/transactions')) return route.fulfill({ json: options.edgeOnly ? [] : [transaction] });
    if (path.endsWith('/meter-values')) return route.fulfill({ json: options.edgeOnly ? [] : [sample('power', 'Power.Active.Import', 11000, 'W'), sample('energy', 'Energy.Active.Import.Register', 7400, 'Wh'), sample('soc', 'SoC', 62, 'Percent'), sample('vendor', 'Vendor.Custom.Measure', 'idTag=METER-LEAK endpoint=modbus://meter.internal/unit', '')] });
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
  await expect(page.getByTestId('geraet-heldsatz')).toHaveText('Anschluss 1 lädt.');
  const held = page.getByTestId('geraet-held');
  await expect(held.locator('[data-kachel="leistung"]')).toContainText('11');
  await expect(held.getByText('6,4 kWh')).toBeVisible();
  // Keine Sprungleiste mehr (S4) - und Kopf und Bühne stehen auf derselben Achse.
  await expect(page.locator('.vp-rahmen-nav, .vp-rahmen-chips')).toHaveCount(0);
  const leftEdges = await page.locator('.vp-kern-kopf, [data-baustein="buehne"]')
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left));
  expect(Math.abs(leftEdges[0] - leftEdges[1])).toBeLessThanOrEqual(1);
  // Eine belegte Lücke steht schon an der geschlossenen Zeile „Technik & Diagnose".
  await expect(page.getByTestId('geraet-technik-oeffnen')).toContainText('1 Lücke');
  const hashVorher = await page.evaluate(() => window.location.hash);
  await technikOeffnen(page);
  // Die Ansicht ist ein PARAMETER im Hash - nie eine zweite Raute.
  const hashTechnik = await page.evaluate(() => window.location.hash);
  expect(hashTechnik).toContain('ansicht=technik');
  expect(hashTechnik.slice(1)).not.toContain('#');
  await expect(page.getByText(/1 belegte Datenlücke/)).toBeVisible();
  await page.getByRole('button', { name: 'Unveränderliche Auditspur laden' }).click();
  await expect(page.getByRole('list', { name: 'Unveränderliche Auditspur' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Messwerte', level: 2, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await page.getByRole('button', { name: /Wallbox Carport/ }).click();
  await expect(page.getByTestId('geraet-held')).toBeVisible();
  expect(await page.evaluate(() => window.location.hash)).toBe(hashVorher);

  await page.getByRole('button', { name: 'Laden stoppen', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Auswirkung');
  await expect(page.getByLabel('Transaktion *')).toHaveValue('1842');
  await page.getByRole('button', { name: 'Prüfen und senden' }).click();
  await expect(page.getByRole('dialog')).toContainText('Befehl angenommen');
  await expect(page.getByRole('dialog')).toContainText('Wirkung noch nicht bestätigt');
  await page.getByRole('button', { name: 'Zum Journal' }).click();
  // Das Aktionsjournal der Betreiber wohnt in „Technik & Diagnose".
  await technikOeffnen(page);
  await expect(page.getByText('Wirkung verspätet beobachtet')).toBeVisible();
  const body = await page.locator('body').innerText();
  for (const leak of ['CONNECTOR-LEAK', 'connector.internal', 'METER-LEAK', 'meter.internal', 'EVENT-CORRELATION',
    'EVENT-LEAK', 'event.internal', 'event-pre.internal', 'pre.internal', 'ACTION-LEAK', 'action.internal',
    'AUDIT-ACTOR', 'audit.internal']) expect(body).not.toContain(leak);
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

test('OCPP setup saves a bounded limit and shows independent evidence', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop-chromium') await page.setViewportSize({ width: 1440, height: 1000 });
  if (testInfo.project.name === 'mobile-chromium') await page.setViewportSize({ width: 375, height: 900 });
  await mock(page); await page.goto('/e2e/ocpp-wallbox.html');
  // Einrichtung und Grenzen der Säule wohnen in „Technik & Diagnose" › OCPP.
  await technikOeffnen(page);
  await expect(page.getByRole('heading', { name: 'OCPP einrichten und prüfen' })).toBeVisible();
  await expect(page.getByText('von der Säule angenommen', { exact: true })).toBeVisible();
  await page.getByLabel('Ladegrenze in kW', { exact: true }).fill('7.4');
  await page.getByLabel('Dauer in Minuten', { exact: true }).fill('60');
  const save = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/ocpp/control'));
  await page.getByRole('button', { name: 'Ladegrenze speichern', exact: true }).click();
  const payload = (await save).postDataJSON();
  expect(payload.limits[0].limit_kw).toBe(7.4);
  expect(Date.parse(payload.limits[0].expires_at) - Date.parse(payload.limits[0].requested_at)).toBe(60 * 60_000);
  await expect(page.getByText('Übernahme noch nicht bestätigt', { exact: true })).toBeVisible();
  await expect(page.getByText('Noch kein Prüfergebnis von der Box gemeldet.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (process.env.OCPP_AUDIT_SCREENSHOTS) {
    const dir = process.env.OCPP_AUDIT_SCREENSHOTS;
    const capture = async (selector: string, name: string) => {
      await page.locator(selector).evaluate((element) => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 110, behavior: 'instant' }));
      await page.screenshot({ path: `${dir}/${name}-${testInfo.project.name}.png` });
    };
    await capture('.vp-ocpp-control', 'umsetzung');
    await capture('.vp-ocpp-control fieldset:nth-of-type(2)', 'ladegrenze');
    await page.getByText('AC-Anschluss und Phasengrenzen', { exact: true }).click();
    await page.getByText('Ladekarten und Zugang', { exact: true }).click();
    await capture('.vp-ocpp-control > details:first-of-type', 'einrichtung');
    await capture('.vp-ocpp-control > details:nth-of-type(2)', 'karten');
  }
});

test('edge-only charging stays compact when no power or transaction has arrived', async ({ page }) => {
  await mock(page, { edgeOnly: true });
  await page.goto('/e2e/ocpp-wallbox.html?edge-only');

  const hero = page.locator('[data-state="charging"]');
  await expect(page.getByTestId('geraet-heldsatz')).toHaveText('Anschluss 1 lädt.');
  await expect(hero).toContainText('Ladeleistung und Sitzungsdaten werden noch nicht übertragen.');
  await expect(hero.getByText('Nicht verfügbar')).toHaveCount(0);
  await expect(hero.locator('.vp-ocpp-now-facts')).toHaveCount(0);
  await expect(hero.locator('.vp-ocpp-primary-action')).toHaveCount(0);
  // Ohne Leistung keine große Zahl aus dem Nichts: das Wort des Zustands führt.
  await expect(hero.locator('[data-kachel="leistung"]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('hard action requires the server phrase and never overflows its sheet', async ({ page }) => {
  await mock(page); await page.goto('/e2e/ocpp-wallbox.html');
  await technikOeffnen(page);
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
  // Exercise keyboard return-focus; Safari taps do not retain button focus.
  await trigger.focus(); await trigger.press('Enter');
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
  await technikOeffnen(page);
  await expect(page.getByText('Wirkung nicht innerhalb der Frist beobachtet')).toBeVisible();
  await expect(page.getByText('Wirkung verspätet beobachtet')).toBeVisible({ timeout: 7_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

test('foreign firmware has an executable bound handoff to a second operator', async ({ page }) => {
  await mock(page, { fourEyes: true });
  await page.goto('/e2e/ocpp-wallbox.html');
  await technikOeffnen(page);
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

// The customer journey uses the real page and explicit API evidence fixtures.
// It proves UI transitions and payloads; physical regulation is covered by the
// Go websocket tests, never inferred from these staged screenshots.
test('customer configures OCPP and follows requested accepted and measured states', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop-chromium') await page.setViewportSize({ width: 1440, height: 1000 });
  if (testInfo.project.name === 'mobile-chromium') await page.setViewportSize({ width: 375, height: 900 });
  await mock(page);
  const { initialOcppControl } = await import('../src/ocppControl');
  let desired = initialOcppControl();
  let appliedLimit = 11;
  let revision = 0;
  let enabled = false;
  let charging = false;
  let testReport: null | Record<string, unknown> = null;
  const tag = 'tagref_1234567890abcdef12345678';
  await page.route('**/ocpp/stations', (route) => route.fulfill({ json: [{ ...station,
    connectors: [{ ...station.connectors[0], status: charging ? 'Charging' : 'Available' }] }] }));
  await page.route('**/ocpp/transactions*', (route) => route.fulfill({ json: charging ? [transaction] : [] }));
  await page.route('**/ocpp/meter-values*', (route) => route.fulfill({ json: charging ? [sample('power', 'Power.Active.Import', appliedLimit * 1000, 'W')] : [] }));
  await page.route('**/ocpp/control', async (route) => {
    if (route.request().method() === 'PUT') {
      const input = route.request().postDataJSON();
      expect(input.revision).toBe(desired.revision);
      desired = { ...input, revision: desired.revision + 1 };
    }
    const at = new Date().toISOString();
    return route.fulfill({ json: { desired: desired.revision ? desired : null, observed: [{ deviceId: 'device-1', reportedAt: at,
      state: { revision, enabled, authorization_mode: desired.authorization.mode, seen_tags: [tag], test: testReport,
        stations: [{ id: station.chargePointId, connected: true, capabilities_read: true, profiles_accepted: revision > 0,
          connectors: [{ id: 1, reconciling: false, fresh_power: charging, power_kw: charging ? appliedLimit : undefined,
            power_at: charging ? at : undefined, command_status: charging ? 'Accepted' : undefined,
            readback: charging ? 'ok' : undefined, readback_at: charging ? at : undefined }] }] } }] } });
  });
  const openControl = async () => {
    // Einrichtung und Grenzen wohnen in „Technik & Diagnose" › OCPP - nach einem
    // Neuladen steht die Ansicht schon offen (sie ist eine Adresse).
    await technikOeffnen(page);
    await expect(page.getByRole('heading', { name: 'OCPP einrichten und prüfen' })).toBeVisible();
  };
  const capture = async (step: string, selector?: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (!process.env.OCPP_AUDIT_SCREENSHOTS) return;
    const path = `${process.env.OCPP_AUDIT_SCREENSHOTS}/flow-${step}-${testInfo.project.name}.png`;
    if (selector) {
      // Capture the complete section at the real device width. A taller
      // capture viewport keeps the sticky section navigation outside the
      // crop, including when the form is taller than a phone screen.
      const viewport = page.viewportSize()!;
      const section = page.locator(selector);
      const height = await section.evaluate((element) => element.getBoundingClientRect().height);
      await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(height) + 220) });
      await section.evaluate((element) => window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 160));
      await section.screenshot({ path });
      await page.setViewportSize(viewport);
    } else await page.screenshot({ path });
  };
  const acknowledge = async () => {
    revision = desired.revision; enabled = desired.enabled ?? false;
    appliedLimit = Math.min(11, desired.limits[0]?.limit_kw ?? 11);
    await page.reload(); await openControl();
  };
  await page.goto('/e2e/ocpp-wallbox.html');
  await expect(page.getByRole('heading', { name: 'Wallbox Carport', exact: true })).toBeVisible();
  await capture('01-ladepunkt');
  await openControl();
  await capture('02-bereitschaft', '.vp-ocpp-control-facts');

  await page.getByText('AC-Anschluss und Phasengrenzen', { exact: true }).click();
  await page.getByLabel('Obere Betriebsspannung in V').fill('253');
  await page.getByLabel('Stromgrenze des Steckers in A').fill('32');
  for (const phase of [1, 2, 3]) {
    await page.getByLabel(`Phase L${phase}`, { exact: true }).check();
    await page.getByLabel(`Ladepark-Budget L${phase} in A`, { exact: true }).fill('32');
  }
  await capture('03-anschluss', '.vp-ocpp-control > details:first-of-type');
  await page.getByRole('button', { name: 'Bestätigte Anschlussdaten speichern' }).click();
  await expect(page.getByText(/Hinterlegt für Stecker 1: 253 V/)).toBeVisible();
  expect(desired.electrical[0].phases).toEqual([1, 2, 3]);
  await acknowledge();
  await page.getByRole('button', { name: 'OCPP-Regelung freigeben' }).click();
  await expect(page.getByText('Übernahme noch nicht bestätigt', { exact: true })).toBeVisible();
  await capture('04-freigabe', '.vp-ocpp-control > fieldset:first-of-type');
  await acknowledge();
  await expect(page.getByText('auf der Box freigegeben', { exact: true })).toBeVisible();
  await capture('05-bestaetigt', '.vp-ocpp-control-facts');

  await page.getByText('Ladekarten und Zugang', { exact: true }).click();
  await page.getByLabel('Karte …12345678', { exact: true }).click();
  await expect(page.getByLabel('Karte …12345678', { exact: true })).toBeChecked();
  // VpPicker is the product picker, used by keyboard on desktop and mobile.
  await page.getByRole('combobox', { name: 'Ladeberechtigung' }).click();
  await page.getByRole('option', { name: 'Nur freigegebene Karten' }).click();
  await expect(page.getByRole('combobox', { name: 'Ladeberechtigung' })).toContainText('Nur freigegebene Karten');
  expect(desired.authorization).toEqual({ mode: 'allowlist', allowed_tags: [tag] });
  await capture('06-karten', '.vp-ocpp-control > details:nth-of-type(2)');
  await acknowledge();
  charging = true;
  await page.reload(); await openControl();

  await page.getByLabel('Ladegrenze in kW', { exact: true }).fill('7,4');
  await page.getByLabel('Dauer in Minuten', { exact: true }).fill('60');
  await page.getByRole('button', { name: 'Ladegrenze speichern', exact: true }).click();
  await expect(page.getByText(/Angefordert: 7.4 kW/)).toBeVisible();
  expect(desired.limits[0].limit_kw).toBe(7.4);
  expect(Date.parse(desired.limits[0].expires_at) - Date.parse(desired.limits[0].requested_at)).toBe(3_600_000);
  await capture('07-ladegrenze', '.vp-ocpp-control > fieldset:nth-of-type(2)');
  await acknowledge();

  await page.getByLabel('Ich beaufsichtige den Ladevorgang während der Prüfung.').check();
  await page.getByRole('button', { name: 'Dreiminütige Prüfung anfordern' }).click();
  await expect(page.getByText('Prüfung angefordert. Die Übernahme durch die Box ist noch nicht bestätigt.')).toBeVisible();
  expect(desired.test?.limit_kw).toBe(6);
  await expect(page.getByRole('button', { name: 'Prüfung abbrechen', exact: true })).toBeVisible();
  await capture('08-pruefung', '.vp-ocpp-control > fieldset:last-of-type');
  testReport = { ...desired.test, vendor: 'KEBA', model: 'P30', firmware: '1.9.4', state: 'confirmed', baseline_kw: appliedLimit,
    limited: true, paused: true, resumed: true };
  await acknowledge();
  await expect(page.getByText(/Regelwirkung in allen drei Schritten gemessen/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Gemessene Prüfschritte' })).toContainText('Wiederaufnahme: gemessen');
  await expect(page.getByRole('button', { name: 'Prüfung abbrechen', exact: true })).toHaveCount(0);
  await capture('09-ergebnis', '.vp-ocpp-control > fieldset:last-of-type');
});
