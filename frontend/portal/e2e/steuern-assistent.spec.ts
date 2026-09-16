import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { FIXTURE_IDS, ahrenbergHeute } from '../src/test/standorteFixtures';

const BILDER = process.env.STEUERN_ASSISTENT_BILDER;

async function cloud(page: Page) {
  const aufrufe = { grenze: 0, steuerart: 0, profiles: 0 };
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const pfad = new URL(req.url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/standorte') return json(ahrenbergHeute());
    if (pfad === '/api/v1/funktionen') return json(ahrenbergFunktionen());
    if (pfad.endsWith(`/sites/${FIXTURE_IDS.an2}/entities`)) return json({ registry: null, localSetup: [], staleOnDevice: [], entities: [
      { id: 'K-9', entityType: 'ocpp-charge-point', typeLabel: 'Ladepunkt', role: 'consumer', label: 'Parkplatz Halle 2', control: true, deviceId: 'E-2', capabilities: null, guards: null, syncStatus: 'in_sync', observed: null, edgeSourceId: null },
      { id: 'EK-1', entityType: 'meter', typeLabel: 'Energiekarte EK-1', role: 'grid', label: 'Energiekarte EK-1', control: false, deviceId: 'E-2', capabilities: null, guards: null, syncStatus: 'in_sync', observed: null, edgeSourceId: null },
    ] });
    if (pfad.endsWith(`/sites/${FIXTURE_IDS.an2}/verbraucher`)) {
      if (req.method() === 'PUT') aufrufe.steuerart += 1;
      return json({
        verbraucher: [{ entityId: 'K-9', name: 'Parkplatz Halle 2', typ: 'ev_charger', typLabel: 'Ladepunkt', ladepunkt: true, steuerart: { quelle: 'sofort', herkunft: 'ohne' }, regeln: 0, aktiv: false, optionen: { schreibbar: true, quellen: [{ id: 'sofort', gesperrt: false }], ziele: [], vorgaben: {} } }],
        ladepunkte: { standard: null, standardFolger: 0, gesamt: 1, rahmen: { hoechsteHausLastKw: 96.5 } }, rangliste: [],
      });
    }
    if (pfad.endsWith(`/standorte/${FIXTURE_IDS.st1}/netzanschluesse`)) return json({
      standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1' }, stichtag: '2026-12-01', kennzeichen_vorschlag: 'NA-3',
      netzanschluesse: [{ id: 'NA-2', kennzeichen: 'NA-2', name: 'Netzanschluss Halle 2', malo: null, netzbetreiber: null, anschluss_kva: 250, vereinbart_kw: 200, messung: 'RLM', gueltig_ab: '2026-01-01', gueltig_bis: null, standort: { id: FIXTURE_IDS.st1, kurzzeichen: 'ST-1' }, hinweise: [], angelegt_am: '2026-01-01T00:00:00Z', anlagen: [{ id: 'b-1', anlage: { id: FIXTURE_IDS.an2, name: 'Halle 2' }, gueltig_ab: '2026-01-01', gueltig_bis: null }] }],
    });
    if (pfad.endsWith(`/sites/${FIXTURE_IDS.an2}/charging-config`)) return json({ gridLimitKw: null, priorityChargePointIds: [] });
    if (pfad.endsWith(`/sites/${FIXTURE_IDS.an2}/charging-frame`) && req.method() === 'PUT') {
      aufrufe.grenze += 1;
      return json({ gridLimitKw: 200, priorityChargePointIds: [] });
    }
    if (pfad.includes('/profiles') && req.method() === 'PUT') { aufrufe.profiles += 1; return json({ profiles: [] }); }
    if (pfad.includes('/steuerart') && req.method() === 'PUT') { aufrufe.steuerart += 1; return json({ aktiv: true }); }
    return json({ message: `Unerwartete Route ${req.method()} ${pfad}` }, 404);
  });
  return aufrufe;
}

async function bild(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    draussen: [...document.querySelectorAll('.vp-anlegen-dialog *')].map((el) => ({
      el, r: el.getBoundingClientRect(), name: `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`,
    })).filter(({ el, r }) => !el.classList.contains('vp-anlegen-sr') && r.width > 0
      && (r.left < -0.5 || r.right > innerWidth + 0.5)).map(({ name }) => name),
  }));
  expect(layout.overflow, name).toBe(0);
  expect(layout.draussen, name).toEqual([]);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
  }
}

for (const breite of [375, 1440] as const) {
  for (const runde of [1, 2] as const) {
    test(`Referenzfall 5 · Schritte 1–4 · ${breite}px · Runde ${runde}`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
      const aufrufe = await cloud(page);
      await page.goto('/e2e/steuern-assistent.html');
      await expect(page.getByText('Welche Anlage wird aufgenommen?')).toBeVisible();
      await bild(page, `schritt-1-${breite}-r${runde}`);
      await page.getByRole('button', { name: 'Weiter' }).click();

      await expect(page.getByText('Was darf VoltPilot steuern?')).toBeVisible();
      await expect(page.getByText('Energiekarte EK-1')).toBeVisible();
      await bild(page, `schritt-2-${breite}-r${runde}`);
      await page.getByRole('button', { name: 'Weiter' }).click();

      await page.getByLabel('Anschlussgrenze (kW)').fill('200');
      await expect(page.getByText('Die Grenze liegt innerhalb der vereinbarten Leistung.')).toBeVisible();
      await bild(page, `schritt-3-${breite}-r${runde}`);
      await page.getByRole('button', { name: 'Weiter' }).click();
      await expect.poll(() => aufrufe.grenze).toBe(1);

      await expect(page.getByText('Wie soll gesteuert werden?')).toBeVisible();
      await page.getByRole('button', { name: 'Steuerart wählen' }).click();
      await page.getByLabel(/Sofort laden/).click();
      await page.getByRole('button', { name: 'Weiter' }).click();
      await page.getByRole('button', { name: 'Speichern' }).click();
      await expect(page.getByText('Auswahl vorbereitet — noch nicht aktiv')).toBeVisible();
      await expect(page.getByText('Kein Speicher — kein Betriebsmodell nötig.')).toBeVisible();
      await bild(page, `schritt-4-${breite}-r${runde}`);
      expect(aufrufe.profiles).toBe(0);
      expect(aufrufe.steuerart).toBe(0);
    });
  }
}
