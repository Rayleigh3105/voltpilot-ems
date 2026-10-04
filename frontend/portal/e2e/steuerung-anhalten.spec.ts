import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { RUHE_VERBINDUNG_HINWEIS } from '../src/ruheHinweis';

const BILDER = process.env.STEUERUNG_ANHALTEN_BILDER;

function angehalten() {
  const f = structuredClone(ahrenbergFunktionen());
  const standort = f.standorte[0];
  const teilnahme = standort.steuern.anlagen[0].teilnahme;
  teilnahme.zustand = 'angehalten';
  teilnahme.seit = '2026-11-03T14:10:00+01:00';
  teilnahme.text = 'Angehalten seit 03.11.2026 14:10';
  teilnahme.aktionen = ['fortsetzen', 'beenden'];
  teilnahme.ruhe_hinweis = { jetzt: true, beim_anhalten: false };
  standort.steuern.zustand = 'angehalten';
  standort.steuern.seit = teilnahme.seit;
  standort.steuern.text = 'Angehalten seit 03.11.2026 14:10';
  standort.steuern.aktionen = ['fortsetzen', 'beenden'];
  return f;
}

/** Ein gesteuertes Gerät, damit das Blatt mit „Aus · Smart · Ein“ zu sehen ist. */
const VERBRAUCHER = {
  verbraucher: [{
    entityId: 'e-hs', name: 'Heizstab Warmwasser', typ: 'heating-rod', typLabel: 'Heizstab', ladepunkt: false, regeln: 0,
    steuerart: { quelle: 'ueberschuss', herkunft: 'policy', schwelleKw: 1 },
    optionen: { schreibbar: true, quellen: [{ id: 'ueberschuss', gesperrt: false }], ziele: [], vorgaben: { schwelleKw: 1 } },
  }],
  ladepunkte: { standard: null, standardFolger: 0, gesamt: 0, rahmen: null },
  rangliste: [{ position: 1, art: 'verbraucher', entityId: 'e-hs', name: 'Heizstab Warmwasser' }],
};

/** Stellt die Cloud; gibt die Liste der schreibenden Aufrufe zurück (in Ruhe muss sie leer bleiben). */
async function cloud(page: Page): Promise<string[]> {
  const schreibend: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const pfad = new URL(req.url()).pathname;
    if (req.method() !== 'GET') schreibend.push(`${req.method()} ${pfad}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/funktionen') return json(angehalten());
    if (pfad.endsWith('/flows')) return json([]);
    if (pfad.endsWith('/entities')) return json({ registry: null, localSetup: [], staleOnDevice: [], entities: [] });
    if (pfad.endsWith('/flow-node-governance')) return json({ gatedNodes: [] });
    if (pfad.endsWith('/profile')) return json({ signals: { hasStorage: true, hasPv: true, activeStrategyNodeTypes: [] } });
    if (pfad === '/api/v1/earnings') return json({ sites: [] });
    if (pfad.endsWith('/profiles')) return json({ profiles: [] });
    if (pfad.endsWith('/assets')) return json([]);
    if (pfad.endsWith('/chargers')) return json({ budget: null, chargers: [] });
    if (pfad.endsWith('/verbraucher')) return json(VERBRAUCHER);
    if (pfad.endsWith('/fahrzeuge')) return json({ fahrzeuge: [] });
    if (pfad.endsWith('/schedule')) return json({ deviceId: null, slots: [] });
    if (pfad.endsWith('/control-status') || pfad.endsWith('/curtailment-status')) return route.fulfill({ status: 204 });
    if (pfad.endsWith('/consumers') || pfad.endsWith('/consumer-status') || pfad.endsWith('/consumer-overrides')) return json([]);
    if (pfad.endsWith('/interventions')) return json({ automationPaused: false, pausedUntil: null, interventions: [] });
    return json({ message: `Nicht gestellt: ${req.method()} ${pfad}` }, 404);
  });
  return schreibend;
}

async function pruefenUndBild(page: Page, name: string) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), name).toBe(0);
  if (BILDER) {
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
  }
}

for (const breite of [375, 1440] as const) {
  test(`A4/A5 Steuerungsseite und Standort-Karte · ${breite}px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    const schreibend = await cloud(page);
    await page.goto('/e2e/steuerung-anhalten.html');
    // Die Plakette trägt den Zustand und ist kein Pause-Knopf: in Ruhe nie „Automatik an“.
    const kopf = page.locator('.stn-kopf');
    await expect(kopf).toContainText('Angehalten seit 03.11.');
    await expect(kopf.getByRole('button')).toHaveCount(0);
    await expect(page.getByText('Automatik an')).toHaveCount(0);
    const band = page.getByTestId('steuern-ruhe');
    await expect(band).toContainText('Angehalten seit 03.11.2026 14:10.');
    await expect(band).toContainText('Regeln und das Betriebsmodell des Speichers wirken nicht.');
    await expect(page.getByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Heizstab Warmwasser/ })).toBeVisible();
    await pruefenUndBild(page, `steuerung-angehalten-${breite}`);

    // Ein Eingriff endete in Ruhe mit 409 - das Blatt sperrt ihn und sagt warum.
    await page.getByRole('button', { name: /Heizstab Warmwasser/ }).click();
    const blatt = page.getByRole('dialog', { name: /Heizstab Warmwasser/ });
    await expect(blatt.getByRole('button', { name: 'Aus' })).toBeDisabled();
    await expect(blatt.getByRole('button', { name: 'Ein' })).toBeDisabled();
    await expect(blatt.getByRole('note')).toHaveText('Eingriffe und Pause gibt es wieder, sobald die Steuerung fortgesetzt ist.');
    await pruefenUndBild(page, `steuerung-angehalten-eingriff-${breite}`);
    await page.keyboard.press('Escape');
    expect(schreibend).toEqual([]);

    await page.goto('/e2e/steuerung-anhalten.html?ansicht=standort');
    await page.getByRole('button', { name: 'Standort fortsetzen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort fortsetzen?' });
    await expect(dialog).toContainText('Betroffen: Werk Ahrenberg – Halle 1.');
    await expect(dialog).toContainText('prüft Box, Freigaben, Grenze, Hauptzähler und Betriebsweise erneut');
    await pruefenUndBild(page, `standort-fortsetzen-${breite}`);
  });

  for (const fall of [
    { code: 'alt', bild: 'ruhe-alte-box', hinweis: true },
    { code: 'neu', bild: 'ruhe-faehige-box', hinweis: false },
    { code: 'aktiv', bild: 'anlage-ohne-ruhe', hinweis: false },
  ] as const) {
    test(`${fall.bild} · ${breite}px`, async ({ page }) => {
      await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
      await page.goto(`/e2e/steuerung-anhalten.html?ansicht=standort&fall=${fall.code}`);
      const hinweis = page.getByText(RUHE_VERBINDUNG_HINWEIS, { exact: true });
      if (fall.hinweis) await expect(hinweis).toBeVisible();
      else await expect(hinweis).toHaveCount(0);
      await pruefenUndBild(page, `${fall.bild}-${breite}`);
    });
  }
}
