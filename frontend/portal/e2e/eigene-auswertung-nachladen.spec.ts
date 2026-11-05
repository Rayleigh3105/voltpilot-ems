import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * „Eigene Auswertung“ ist ein Stück für sich (Wartungs-Auftrag „Luft im Einstieg“): der Dialog trägt den
 * Messwert-Baum und lädt deshalb nach, aber NICHT erst beim Klick - der Anpassen-Modus holt ihn vor, sobald er
 * aufgeht. Der Fall prüft am echten Seitenaufbau (Dev-Server liefert jede Quelldatei einzeln, daher die URL-Probe
 * statt einer Zeit): (1) im Cockpit lädt das Stück NICHT, (2) „Cockpit anpassen“ holt es, (3) der Klick auf
 * „+ Eigene Auswertung“ stellt den Dialog ohne weitere Anfrage hin, ohne Ladeschirm.
 */

const ANLAGE = {
  id: '10000000-0000-4000-8000-0000000000a1',
  name: 'Hof Lindenberg',
  biddingZone: 'DE-LU',
  latitude: 49.1159,
  longitude: 10.7155,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'dynamisch',
  tarifParamCtKwh: 18,
  netzladenErlaubt: true,
  maxFeedInKw: null,
};
const BOX = { id: '20000000-0000-4000-8000-0000000000a1', siteId: ANLAGE.id, name: 'Box', lastSeenAt: new Date().toISOString() };

const json = (r: Route, body: unknown, status = 200) =>
  r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const sichtbar = (eintraege: unknown[]) => ({ eintraege, teilansicht: { sichtbar: eintraege.length, gesamt: eintraege.length } });

function entitaet(id: string, entityType: string, role: string, channels: string[]) {
  return {
    id, entityType, typeLabel: entityType, role, label: null, control: false, deviceId: BOX.id,
    capabilities: { measure: channels.map((channel) => ({ channel })) }, guards: null, syncStatus: 'synced',
    observed: null, edgeSourceId: null,
  };
}

const TOPOLOGIE = {
  schemaVersion: '1.0',
  entities: [
    { id: 'e-pv', entityType: 'producer', typeLabel: 'PV', label: null, category: 'producer', health: 'ok',
      capabilities: [{ channel: 'pv_power_kw', unit: 'kW', role: 'pv', primary: true, value: 4.2 }] },
    { id: 'e-batt', entityType: 'battery-hybrid', typeLabel: 'Speicher', label: null, category: 'storage', health: 'ok',
      capabilities: [{ channel: 'soc_pct', unit: '%', role: 'storage', primary: true, value: 60 }] },
    { id: 'e-grid', entityType: 'grid-meter', typeLabel: 'Netzanschluss', label: null, category: 'meter', health: 'ok',
      capabilities: [{ channel: 'power_kw', unit: 'kW', role: 'grid', primary: true, value: -2.1 }] },
  ],
  topology: {
    schema_version: '1.0',
    nodes: [
      { role: 'pv', value_kw: 4.2, flow_active: true, direction: 'out', members: [{ entity_id: 'e-pv', label: 'PV', primary: true, value_kw: 4.2 }] },
      { role: 'storage', value_kw: 1.2, soc_pct: 60, flow_active: true, direction: 'in', members: [{ entity_id: 'e-batt', label: 'Speicher', primary: true, value_kw: 1.2 }] },
      { role: 'grid', value_kw: 2.1, flow_active: true, direction: 'out', members: [{ entity_id: 'e-grid', label: 'Netz', primary: true, value_kw: -2.1 }] },
    ],
  },
};

const PROFIL = {
  usageProfile: 'private', derivedProfile: 'private', override: null,
  emphasis: { money: 'normal', peak: 'hidden', flow: 'prominent', devices: 'normal' },
  signals: { hasStorage: true, hasPv: true, hasControllableConsumer: false, activeStrategyNodeTypes: [], plantKind: 'eigenverbrauch', hasLeistungspreis: false },
};

const ZEILE = {
  id: ANLAGE.id, name: ANLAGE.name, plantKind: 'eigenverbrauch', netzladenErlaubt: true, batteryWithoutDevice: false,
  deviceCount: 1, onlineCount: 1, waitingCount: 0, worstStatus: 'online', lastSeenAt: new Date().toISOString(),
  live: { ts: new Date().toISOString(), pvKw: 4.2, loadKw: 1.1, gridKw: -2.1, socPct: 60 },
  plannedSavingsTodayEur: null,
};

/** Verdrahtet die Cloud mit den Stammdaten einer Anlage (Muster `landung-erstbild.spec.ts`). */
async function verdrahte(page: Page) {
  await page.route((url) => url.hostname !== '127.0.0.1' && url.hostname !== 'localhost', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => {
    const leer = /\/(sites|devices|components|entities|candidates|runs|releases|assets)(\?|$)/.test(r.request().url());
    if (!leer && r.request().method() === 'GET') return json(r, { message: 'Not found' }, 404);
    return r.fulfill({ status: 200, contentType: 'application/json', body: leer ? '[]' : '{}' });
  });
  await page.route('**/api/v1/me', (r) => json(r, {
    kennung: 'e2e', name: 'Alex Beispiel', konto: 'benutzer', zustand: 'aktiv', kundenbereich: { id: 't-1', name: 'Demo' },
    zugang: 'konto', rollen: ['kundenadministrator'], unternehmensweit: true,
    standorte: [{ id: ANLAGE.id, name: ANLAGE.name, rechte: ['auswertung.anlegen'] }], unternehmen_rechte: ['anlage.verwalten', 'auswertung.anlegen'],
    kuenftig: [], text: null, teilansicht: null, unterstuetzungen: { eigene: [], gewaehrte: [] }, kundenadministratoren: [],
  }));
  await page.route('**/api/v1/tenant-context', (r) => json(r, { tenantId: 't-1', name: 'Demo', segment: 'B2C', betriebsart: 'endkunde' }));
  await page.route('**/api/v1/funktionen', (r) => json(r, {
    unternehmen: { messen: { laeuft_an: 0, standorte: 0, text: null }, steuern: { laeuft_an: 0, standorte: 0, text: null } }, standorte: [],
  }));
  await page.route('**/api/v1/standorte', (r) => json(r, { message: 'nicht da' }, 404));
  await page.route('**/api/v1/unternehmen', (r) => json(r, { message: 'nicht da' }, 404));
  await page.route('**/api/v1/sites', (r) => json(r, sichtbar([ANLAGE])));
  await page.route('**/api/v1/devices', (r) => json(r, sichtbar([BOX])));
  const s = `**/api/v1/sites/${ANLAGE.id}`;
  await page.route(`${s}/entities`, (r) => json(r, {
    registry: null, localSetup: [], staleOnDevice: [],
    entities: [
      entitaet('e-pv', 'producer', 'pv', ['pv_power_kw']),
      entitaet('e-batt', 'battery-hybrid', 'storage', ['soc_pct']),
      entitaet('e-grid', 'grid-meter', 'grid', ['power_kw']),
    ],
  }));
  await page.route(`${s}/topology`, (r) => json(r, TOPOLOGIE));
  await page.route(`${s}/profile`, (r) => json(r, PROFIL));
  await page.route(`${s}/profiles`, (r) => json(r, { profiles: [] }));
  await page.route(`${s}/schedule`, (r) => json(r, {
    planId: null, deviceId: null, generatedAt: null, slotMinutes: 15, savingsEur: null, bankedValueEur: null,
    socStartPct: null, socEndPct: null, peakTargetKw: null, slots: [],
  }));
  await page.route('**/api/v1/overview', (r) => json(r, {
    sites: [{ ...ZEILE, lastSeenAt: new Date().toISOString(), live: { ...ZEILE.live, ts: new Date().toISOString() } }],
    totals: { sites: 1, devices: 1, online: 1, plannedSavingsTodayEur: null, liveSitesCovered: 1 },
    dailySavings: [],
  }));
}

test('Eigene Auswertung: das Stück lädt mit dem Anpassen-Modus, der Klick öffnet den Dialog sofort', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await verdrahte(page);
  const geladen: string[] = [];
  page.on('request', (req) => { if (/EigeneAuswertungDialog/.test(req.url())) geladen.push(req.url()); });
  await page.goto('/e2e/boot-flow.html');
  await expect(page.locator('.vp-cockpit-stack')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.vp-loader-screen')).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(500);
  expect(geladen, 'im ruhigen Cockpit lädt der Dialog nicht').toEqual([]);

  await page.getByRole('button', { name: 'Cockpit anpassen' }).first().click();
  await expect.poll(() => geladen.length, { timeout: 10_000 }).toBeGreaterThan(0);

  const vorKlick = geladen.length;
  await page.getByRole('button', { name: '+ Eigene Auswertung' }).click();
  const dialog = page.getByRole('dialog', { name: 'Eigene Auswertung' });
  await expect(dialog).toBeVisible({ timeout: 5_000 });
  expect(geladen.length, 'der Klick braucht keine weitere Anfrage').toBe(vorKlick);
  await expect(page.locator('.vp-lazy-page')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
