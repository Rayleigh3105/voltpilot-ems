import { expect, test, type Page } from '@playwright/test';

const template = {
  templateRef: 'builtin:deye:sun-12k', kind: 'builtin', version: 1,
  brand: 'deye', brandLabel: 'Deye', model: 'sun-12k', modelLabel: 'SUN-12K',
  deviceType: 'inverter', family: 'deye-sg04lp3', familyLabel: 'SG04LP3',
  communication: 'solarman-v5', communicationLabel: 'Solarman V5',
  transportSchema: [
    { key: 'ip', label: 'IP-Adresse', type: 'text', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'serial', label: 'Logger-Seriennummer', type: 'text', required: true },
    { key: 'password', label: 'Kennwort', type: 'password', secret: true },
  ],
};

const row = {
  id: '20000000-0000-0000-0000-000000000001', role: 'battery-hybrid',
  entityType: 'battery-hybrid', label: 'Speicher Scheune', brand: 'deye', model: 'sun-12k',
  family: 'deye-sg04lp3', communication: 'solarman-v5',
  connection: { ip: '192.168.1.20', port: 8899, serial: '4711', password: '••••••••' },
  sourceKind: 'builtin', templateRef: template.templateRef, templateVersion: 1,
  definitionVersion: 7, syncStatus: 'pending',
};

async function mock(page: Page, stale = false) {
  await page.route('**/api/v1/component-templates', (route) => route.fulfill({ json: [template] }));
  await page.route('**/api/v1/sites/*/components', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { componentAuthority: 'portal', components: [row] } });
    } else await route.fallback();
  });
  await page.route('**/api/v1/sites/*/components/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    if (stale) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Dieses Gerät wurde inzwischen geändert. Bitte laden Sie die neuen Werte.' }) });
    const body = route.request().postDataJSON();
    expect(body.expectedRevision).toBe(7);
    expect(body.connection.password).toBeUndefined();
    return route.fulfill({ json: { componentAuthority: 'portal', sollRevision: 'new', appliedRevision: 'old', components: [{ ...row, label: body.label, definitionVersion: 8, syncStatus: 'pending' }] } });
  });
  await page.route('**/api/v1/sites/*/component-test', (route) => route.fulfill({ json: { results: [{ ok: true, reading: { value: 1, unit: 'kW' } }] } }));
}

test('prefills the inline editor, masks secrets and saves a stable revisioned delta', async ({ page }) => {
  await mock(page);
  await page.goto('/e2e/edit-flow.html');
  await expect(page.getByRole('heading', { name: 'Speicher Scheune bearbeiten' })).toBeVisible();
  await expect(page.getByLabel('Anzeigename')).toHaveValue('Speicher Scheune');
  await page.getByRole('button', { name: 'Technische Daten ändern' }).click();
  await expect(page.getByLabel('Kennwort')).toHaveValue('');
  await expect(page.getByLabel('Kennwort')).toHaveAttribute('placeholder', /unverändert/);
  await page.getByLabel('Anzeigename').fill('Batterie Scheune');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(page.getByText('E2E gespeichert', { exact: true })).toBeVisible();
});

test('keeps the editor usable on mobile and exposes a stale-revision error', async ({ page }) => {
  await mock(page, true);
  await page.goto('/e2e/edit-flow.html');
  await page.getByLabel('Anzeigename').fill('Neuer Name');
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(page.getByRole('alert')).toContainText('inzwischen geändert');
  const box = await page.locator('.vp-geraet-edit').boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('keeps the entered delta when the connection drops before save', async ({ page, context }) => {
  await mock(page);
  await page.goto('/e2e/edit-flow.html');
  await page.getByLabel('Anzeigename').fill('Bleibt bei mir');
  await page.route('**/api/v1/sites/*/components/*', (route) => route.abort('failed'));
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Änderungen speichern' }).click();
  await expect(page.getByRole('alert')).toContainText('Keine Verbindung');
  await expect(page.getByLabel('Anzeigename')).toHaveValue('Bleibt bei mir');
  await context.setOffline(false);
});
