import { expect, test, type Page } from '@playwright/test';

/**
 * Der Boot-Ablauf der SCHALE (nach der Keycloak-Anmeldung): `/tenant-context`,
 * `/sites`, `/devices`. Genau hier sass der falsche „Noch keine Anlage"-Blitz -
 * `UnifiedPortal` rendert vor der ersten Antwort mit `sites=[]`, und weil
 * `loaded` noch `false` ist, fiel es früher durch bis zum Leer-Zustand der
 * Landung, bevor Skelett und Inhalt kamen.
 *
 * Die Ehrlichkeitsregel des Hauses: „Fehlend ist keine Null" - ein
 * „noch keine …"-Leer-Zustand darf erst nach einer ERFOLGREICHEN Antwort
 * erscheinen. Bis dahin trägt der Marken-Lade-Moment (`VpLoader`) die Zeit.
 */

const EVID = '/Users/moritzv/IdeaProjects/firstmate/data/vp-ladeanimation-q4/nachweise';

/** Eine plausible, vollständige Anlage - der Inhalt kommt aus diesem Mock. */
const site = {
  id: '10000000-0000-0000-0000-000000000001',
  name: 'Sonnenhof',
  biddingZone: 'DE-LU',
  latitude: 49.2,
  longitude: 12.8,
  plantKind: 'eigenverbrauch',
  anzulegenderWertCtKwh: null,
  tarifArt: 'ohne',
  tarifParamCtKwh: null,
  gridChargingEnabled: false,
};

const device = {
  id: '20000000-0000-0000-0000-000000000001',
  siteId: site.id,
  name: 'Wechselrichter',
  lastSeenAt: new Date().toISOString(),
};

/**
 * Der DATEN-Boot wird verzögert, damit die Lücke sichtbar wird, die in
 * Produktion (echte Latenz) von selbst entsteht. Lokal ist alles schneller -
 * die Drosselung macht denselben Fehlerpfad reproduzierbar.
 */
async function mockBoot(
  page: Page,
  opts: { sites: unknown[]; devices: unknown[]; delayMs: number; tenants?: unknown[] },
) {
  const wait = () => new Promise((r) => setTimeout(r, opts.delayMs));
  // ⚠ In Playwright gewinnt der ZULETZT registrierte Handler. Die Auffang-Route
  // (alle übrigen Anlagen-/Flotten-Reads fail-soft leer, damit der Test am
  // Boot-Fenster misst und nicht an den Innereien einer Seite) steht deshalb
  // ZUERST; die konkreten, verzögerten Routen kommen danach.
  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    const body = /\/(sites|devices|components|entities|candidates|tenants|runs|releases)(\b|\/|\?|$)/.test(url)
      ? '[]'
      : '{}';
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.route('**/api/v1/admin/tenants', (route) =>
    route.fulfill({ json: opts.tenants ?? [{ id: 't-1', name: 'Demo GmbH' }] }),
  );
  await page.route('**/api/v1/tenant-context', async (route) => {
    await wait();
    await route.fulfill({ json: { tenantId: 't-1', name: 'Demo', segment: 'B2C', betriebsart: null } });
  });
  await page.route('**/api/v1/sites', async (route) => {
    await wait();
    await route.fulfill({ json: opts.sites });
  });
  await page.route('**/api/v1/devices', async (route) => {
    await wait();
    await route.fulfill({ json: opts.devices });
  });
}

/** Der Marken-Lade-Moment ist als EIN Statusbereich ausgewiesen. */
function loader(page: Page) {
  return page.locator('[data-vp-loader]');
}

const FALSCHER_LEERTEXT = /Noch keine Anlage|Willkommen bei VoltPilot|noch keine Anlage/;

test.describe('Boot-Ablauf · kein Leer-Zustand vor der ersten Antwort', () => {
  test('Kunde mit Anlage: Marken-Lader statt „Noch keine Anlage"', async ({ page }, info) => {
    await mockBoot(page, { sites: [site], devices: [device], delayMs: 1500 });
    await page.goto('/e2e/boot-flow.html');

    // Im Boot-Fenster (Antwort steht aus): der Marken-Lader trägt die Zeit …
    await expect(loader(page)).toBeVisible();
    // … und der Leer-Zustand darf zu KEINEM Zeitpunkt behauptet werden.
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
    await page.screenshot({ path: `${EVID}/nachher/kunde-lader-${info.project.name}.png` });

    // Nach der Antwort verschwindet der Lader und der echte Inhalt kommt -
    // der falsche Leertext ist nie erschienen.
    await expect(loader(page)).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByText(FALSCHER_LEERTEXT)).toHaveCount(0);
  });

  test('leeres Mandanten-Konto (Admin): Lader zuerst, Leer-Zustand ERST nach der Antwort', async ({
    page,
  }, info) => {
    await mockBoot(page, { sites: [], devices: [], delayMs: 1500 });
    await page.goto('/e2e/boot-flow.html?admin=1&tenant=t-1#/uebersicht');

    // Boot-Fenster: Lader sichtbar, Leer-Zustand NOCH NICHT.
    await expect(loader(page)).toBeVisible();
    await expect(page.getByText(/noch keine Anlage/i)).toHaveCount(0);
    await page.screenshot({ path: `${EVID}/nachher/leer-lader-${info.project.name}.png` });

    // Nach der (erfolgreichen, leeren) Antwort: der ehrliche Leer-Zustand.
    await expect(
      page.getByRole('heading', { name: 'Dieser Mandant hat noch keine Anlage' }),
    ).toBeVisible({ timeout: 8000 });
    await expect(loader(page)).toHaveCount(0);
  });
});
