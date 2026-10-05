import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ahrenbergFunktionen } from '../src/test/funktionenFixtures';
import { FIXTURE_IDS } from '../src/test/standorteFixtures';
import { RUHE_VERBINDUNG_HINWEIS } from '../src/ruheHinweis';

const BILDER = process.env.STEUERUNG_ANHALTEN_BILDER;

/** Halle 1 läuft (SZ-2 A): der Server bietet „anhalten“ an; die ältere Box hält die Ruhe nur verbunden. */
function aktiv() {
  const f = structuredClone(ahrenbergFunktionen());
  const teilnahme = f.standorte[0].steuern.anlagen[0].teilnahme;
  teilnahme.zustand = 'aktiv';
  teilnahme.aktionen = ['anhalten', 'beenden'];
  teilnahme.ruhe_hinweis = { jetzt: false, beim_anhalten: true };
  return f;
}

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
async function cloud(page: Page, lage: { funktion?: 'aktiv' | 'angehalten'; pausiertBis?: string } = {}): Promise<string[]> {
  const schreibend: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const pfad = new URL(req.url()).pathname;
    if (req.method() !== 'GET') schreibend.push(`${req.method()} ${pfad}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pfad === '/api/v1/funktionen') return json(lage.funktion === 'aktiv' ? aktiv() : angehalten());
    if (req.method() === 'PUT' && pfad.endsWith('/funktionen/steuern')) return json({ aktion: req.postDataJSON().aktion, betroffen: [], standort: null });
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
    if (pfad.endsWith('/interventions')) {
      return json({ automationPaused: lage.pausiertBis != null, pausedUntil: lage.pausiertBis ?? null, interventions: [] });
    }
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
    await expect(band).toContainText('Steuerung angehalten seit 03.11.2026 14:10.');
    await expect(band).toContainText('Regeln und das Betriebsmodell des Speichers wirken nicht, bis Sie fortsetzen.');
    await expect(page.getByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toBeVisible();
    // SZ-2 A: die Geräte stehen abgedimmt mit Grund, die Reihenfolge ohne „Ändern“.
    const geraet = page.getByRole('button', { name: /Heizstab Warmwasser/ });
    await expect(geraet).toBeVisible();
    await expect(geraet).toContainText('VoltPilot schaltet nicht · sicherer Zustand');
    await expect(page.getByRole('region', { name: 'Jetzt' })).toContainText('VoltPilot steuert gerade nicht.');
    await pruefenUndBild(page, `steuerung-angehalten-${breite}`);

    // Fortsetzen steht im Band und fragt mit Folgen, bevor es schreibt.
    await band.getByRole('button', { name: 'Fortsetzen' }).click();
    const weiter = page.getByRole('dialog', { name: /Steuerung fortsetzen/ });
    await expect(weiter).toContainText('VoltPilot prüft Box, Freigaben, Grenze, Hauptzähler und Betriebsweise erneut.');
    await pruefenUndBild(page, `steuerung-fortsetzen-${breite}`);
    await page.keyboard.press('Escape');
    await expect(weiter).toHaveCount(0);

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

  test(`SZ-2 A aktiv · Plakette öffnet „Steuerung anhalten“ mit „Bis ich fortsetze“ · ${breite}px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    const schreibend = await cloud(page, { funktion: 'aktiv' });
    await page.goto('/e2e/steuerung-anhalten.html');
    const automatik = page.locator('.stn-kopf').getByRole('button', { name: 'Automatik an' });
    await expect(automatik).toBeEnabled();
    await expect(page.getByTestId('steuern-ruhe')).toHaveCount(0);
    await pruefenUndBild(page, `steuerung-aktiv-${breite}`);

    await automatik.click();
    const blatt = page.getByRole('dialog', { name: /Steuerung anhalten/ });
    for (const dauer of ['30 Min', '1 Std', '2 Std', '4 Std']) await expect(blatt.getByRole('button', { name: dauer, exact: true })).toBeEnabled();
    const offen = blatt.getByRole('button', { name: /Bis ich fortsetze/ });
    await offen.click();
    await expect(offen).toHaveAttribute('aria-pressed', 'true');
    await expect(blatt.getByText(RUHE_VERBINDUNG_HINWEIS, { exact: true })).toBeVisible();
    await pruefenUndBild(page, `steuerung-anhalten-blatt-${breite}`);
    expect(schreibend).toEqual([]);
    await blatt.getByRole('button', { name: 'Anhalten' }).click();
    await expect(blatt).toHaveCount(0);
    expect(schreibend).toEqual([`PUT /api/v1/sites/${FIXTURE_IDS.an1}/funktionen/steuern`]);
  });

  test(`SZ-2 A befristet angehalten · Plakette „Pausiert bis …“ und Band · ${breite}px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    // Die Pause endet am selben Tag: eine feste Uhr der Seite statt der Uhr des Rechners. Mit `Date.now()` + 60 Min.
    // endete sie zwischen 23 und 24 Uhr erst morgen, und die Plakette sagte zu Recht „Pausiert bis morgen 00:16“
    // (Beleglauf des Nachtrags zum Gesamtlauf mispel, 05.10.2026 um 23:16).
    const jetzt = new Date('2026-10-20T08:15:30Z');
    await page.clock.setFixedTime(jetzt);
    await cloud(page, { funktion: 'aktiv', pausiertBis: new Date(jetzt.getTime() + 60 * 60_000).toISOString() });
    await page.goto('/e2e/steuerung-anhalten.html');
    await expect(page.locator('.stn-kopf').getByRole('button', { name: /^Pausiert bis \d{2}:\d{2}$/ })).toBeVisible();
    await expect(page.locator('.stn-band').filter({ hasText: 'Automatik pausiert bis' }).getByRole('button', { name: 'Fortsetzen' })).toBeVisible();
    await pruefenUndBild(page, `steuerung-pausiert-${breite}`);
  });

  test(`SZ-2 A angehalten ohne Recht · Grund statt „Fortsetzen“ · ${breite}px`, async ({ page }) => {
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 900 });
    await cloud(page);
    await page.goto('/e2e/steuerung-anhalten.html?person=IK');
    const band = page.getByTestId('steuern-ruhe');
    await expect(band).toContainText('Steuerung angehalten seit 03.11.2026 14:10.');
    await expect(band.getByRole('button', { name: 'Fortsetzen' })).toHaveCount(0);
    await expect(band.getByRole('note')).toContainText('Dafür fehlt Ihnen das Recht.');
    await pruefenUndBild(page, `steuerung-angehalten-ohne-recht-${breite}`);
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
