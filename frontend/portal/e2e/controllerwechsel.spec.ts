import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { c1, c1Einstellungen, k82Kanaele } from '../src/test/geraetHerkunftFixtures';
import { controllerVorschau, CONTROLLER_AM } from '../src/test/controllerwechselFixtures';
import { ahrenbergHeute } from '../src/test/standorteFixtures';
import { wechselAntwort } from '../src/test/zaehlerwechselFixtures';
test('C1: vier Messstellen bestätigen, Kartenwahl, ein POST, Fokus und kein Überlauf', async ({ page }, info) => {
  const breite = info.project.name.includes('mobile') ? 375 : 1440;
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const posts: any[] = [];
  await page.route('**/api/v1/**', async route => {
    const p = new URL(route.request().url()).pathname;
    let body: unknown = {};
    if (p.endsWith('/austausch/vorschau')) body = controllerVorschau();
    else if (p.endsWith('/austausch')) {
      const request = route.request().postDataJSON(); posts.push(request);
      const v = wechselAntwort(); v.geraet.alt.einbau = 'C-1'; v.geraet.neu.einbau = 'C-1′'; v.geraet.neu.eingebaut_am = CONTROLLER_AM;
      v.bindungen = controllerVorschau().folgen.map(f => ({ ...v.bindungen[0], kennzeichen: f.kennzeichen, messstelle: f.messstelle,
        neu: { ...v.bindungen[0].neu, gueltig_ab: CONTROLLER_AM, geraet: { ...v.bindungen[0].neu.geraet, einbau: 'C-1′' } } }));
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(v) });
    } else if (p.endsWith('/geraete')) body = { geraete: [c1()] };
    else if (p.endsWith('/einstellungen')) body = c1Einstellungen();
    else if (p.endsWith('/messkanaele')) body = k82Kanaele();
    else if (p.endsWith('/standorte')) body = ahrenbergHeute();
    else if (p.endsWith('/events')) body = [];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/e2e/controllerwechsel.html');
  const open = page.getByRole('button', { name: 'Controller austauschen', exact: true });
  await open.click();
  await expect(page.getByLabel('Endstand MS-13 (kWh, optional)')).toBeAttached();
  await page.keyboard.press('Escape'); await expect(open).toBeFocused(); await open.click();
  await page.getByLabel('Seriennummer (optional)').fill('C-2027-001');
  for (const [i, ms] of ['MS-10', 'MS-11', 'MS-12', 'MS-13'].entries()) await page.getByLabel(`Endstand ${ms} (kWh, optional)`).fill(`${i + 1}.000,5`);
  await page.getByLabel('Karte übernommen').nth(3).uncheck();
  const dialog = page.getByRole('dialog');
  const bilder = process.env.CONTROLLER_BILDER;
  await dialog.locator('.dbody').evaluate(e => { e.scrollTop = 0; });
  if (bilder) { mkdirSync(bilder, { recursive: true }); await page.screenshot({ path: join(bilder, `c1-eingabe-${breite}.png`) }); }
  await page.getByRole('button', { name: 'Folgen prüfen', exact: true }).click();
  const folgen = page.getByRole('region', { name: 'Folgen des Controllerwechsels' });
  for (const ms of ['MS-10', 'MS-11', 'MS-12', 'MS-13']) await expect(folgen).toContainText(ms);
  await expect(folgen).toContainText('EK-4: ebenfalls neu'); expect(posts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  expect(await dialog.evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  if (bilder) await page.screenshot({ path: join(bilder, `c1-folgen-${breite}.png`) });
  await page.getByRole('button', { name: 'Controllerwechsel eintragen' }).click();
  await expect(page.getByRole('status', { name: 'Gespeicherte Folgen' })).toBeVisible();
  expect(posts).toHaveLength(1); expect(posts[0].ablesestaende).toHaveLength(4);
  expect(posts[0].karten_uebernommen).toHaveLength(3); expect(posts[0].bestaetigte_bindungen).toHaveLength(4);
  await page.getByRole('button', { name: 'Schließen', exact: true }).last().click(); await expect(open).toBeFocused();
  expect(errors).toEqual([]);
});
