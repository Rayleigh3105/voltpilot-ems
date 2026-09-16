import { expect, test, type Page, type Locator } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { FAELLE, STAND, type Fall } from './summenwert-abnahme-faelle';
import { cloud } from './summenwert-abnahme-cloud';

const namen = { pv: 'PV-Produktion', consumer: 'Verbrauch', grid: 'Netz' };
async function pruefe(page: Page, bereich: Locator = page.locator('main')) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const text = await bereich.innerText();
  const verboten = await page.evaluate(async (text) => {
    const pfad = '/src/anlegeNurMessen.ts';
    return (await import(pfad)).steuerGeldWoerter(text);
  }, text);
  expect(verboten).toEqual([]);
}
async function shot(page: Page, element: Locator, name: string) {
  if (!process.env.SUMMENWERT_BILDER) return;
  await mkdir(process.env.SUMMENWERT_BILDER, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  const modal = page.locator('.vp-modal');
  if (await modal.count()) await expect(modal.last()).toHaveCSS('opacity', '1');
  await element.screenshot({ path: `${process.env.SUMMENWERT_BILDER}/${name}.png`, animations: 'disabled' });
}
async function rolle(page: Page, name: string, wahl: RegExp) {
  await page.getByRole('button', { name: `Aktionen für ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Rolle ändern' }).click();
  const dialog = page.getByRole('dialog', { name: `Rolle von „${name}“` });
  await dialog.getByRole('radio', { name: wahl }).check();
  await pruefe(page, dialog);
  await dialog.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(dialog).toBeHidden();
}
for (const width of [375, 1440]) {
  for (const fall of ['deye', 'ahrenberg', 'netz', 'lindach'] as Fall[]) {
    test(`${fall}: Register → Stand → Rolle → Cockpit → Entzug bei ${width}`, async ({ page }) => {
      test.setTimeout(90_000);
      const f = FAELLE[fall], errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width, height: 1000 });
      await page.clock.setFixedTime(new Date(STAND));
      const state = await cloud(page, fall);
      await page.goto(`/e2e/summenwert-abnahme.html?fall=${fall}&person=${fall === 'lindach' ? 'PH' : 'JW'}`);
      const karte = page.getByRole('region', { name: 'Gerätekarte' });
      const cockpit = page.getByRole('region', { name: 'Anlagen-Übersicht' });
      await expect(cockpit.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();
      const vorher = await cockpit.getByRole('group', { name: 'Energiefluss Ihrer Anlage' }).textContent();
      await page.getByRole('button', { name: 'Summenwert anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: /Summenwert/ });
      await expect(dialog.getByText('Welche Register gehören zusammen?')).toBeVisible();
      if (fall === 'deye') {
        await expect(dialog.locator('.vp-sw-sumline')).toContainText('12,4');
        await dialog.locator('summary').filter({ hasText: 'Alle Register des Geräts' }).click();
        await dialog.getByRole('button', { name: 'Gen-Port einmal lesen' }).click();
        await expect(dialog.getByText(/jetzt gelesen 10:15:12 Uhr/)).toBeVisible();
        await dialog.locator('.vp-sw-suggest', { hasText: 'Mikrowechselrichter' }).locator('label').click();
        expect(state.reads).toBe(1);
        expect(state.writes.filter((p) => p.startsWith('PUT'))).toEqual([]);
      } else {
        const weitere = dialog.locator('summary').filter({ hasText: 'Weitere Geräte dieser Anlage' });
        if (await weitere.count()) await weitere.click();
        for (const r of f.register) await dialog.getByRole('button', { name: `${r.label} mitzählen` }).click();
      }
      await expect(dialog.getByText(/Stand 10:15:12 Uhr/).first()).toBeVisible();
      await pruefe(page, dialog);
      await shot(page, dialog, `${fall}-${width}-schritt1`);
      await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
      if (fall === 'netz') await dialog.getByRole('group', { name: 'Vorzeichen für Wirkleistung Abgabe' }).getByRole('button', { name: '−' }).click();
      await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
      await dialog.getByLabel('Name des Summenwerts').fill(f.name);
      await dialog.getByRole('button', { name: 'Weiter', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'keine Rolle', exact: true })).toHaveAttribute('aria-pressed', 'true');
      // A2/A4 starten absichtlich ohne Rolle. A3 setzt sie anschließend; A4 bleibt reine Summe.
      if (fall === 'deye' || fall === 'netz') await dialog.getByRole('button', { name: namen[f.rolle as keyof typeof namen], exact: true }).click();
      await pruefe(page, dialog);
      await shot(page, dialog, `${fall}-${width}-schritt4`);
      await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
      await expect(dialog.getByText(/ist angelegt/)).toBeVisible();
      expect(state.body.terme).toHaveLength(f.register.length);
      if (fall === 'deye') expect(state.body.terme.at(-1).gilt_als_erzeugung).toBe(true);
      if (fall === 'netz') expect(state.body.terme[1].vorzeichen).toBe('-');
      await dialog.getByRole('button', { name: 'Fertig', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(karte.getByText(f.name, { exact: true })).toBeVisible();
      if (fall === 'ahrenberg' || fall === 'lindach') {
        await expect(karte.getByText('ohne Rolle', { exact: true })).toBeVisible();
        await expect(cockpit.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toHaveText(vorher!);
      }
      if (fall === 'ahrenberg') await rolle(page, f.name, /^Verbrauch/);
      if (fall !== 'lindach') {
        await expect(karte.locator('.vp-summen-chip')).toHaveText(namen[f.rolle as keyof typeof namen]);
        await expect(cockpit.locator(`.vp-rolle-${f.rolle}`)).toBeVisible();
        await cockpit.locator(`.vp-rolle-${f.rolle} button`).click();
        if (new Set(f.register.map((r) => r.entityId)).size > 1) await expect(cockpit.getByText(/Er zählt in der Anlagenzahl einmal/)).toBeVisible();
        const svg = cockpit.getByRole('group', { name: 'Energiefluss Ihrer Anlage' });
        await expect(svg.getByText(fall === 'netz' ? '2,0 kW' : `${f.wert.toLocaleString('de-DE')} kW`, { exact: true })).toBeVisible();
      }
      await pruefe(page);
      await shot(page, karte, `${fall}-${width}-karte`);
      await shot(page, cockpit, `${fall}-${width}-cockpit`);
      if (fall !== 'lindach') {
        await rolle(page, f.name, /^keine Rolle/);
        await expect(karte.getByText('ohne Rolle', { exact: true })).toBeVisible();
        await expect(cockpit.locator('.vp-pvrolle')).toHaveCount(0);
        await expect(cockpit.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toHaveText(vorher!);
        expect(state.angelegt).toBe(true);
        await shot(page, cockpit, `${fall}-${width}-rueckfall`);
      }
      expect(errors).toEqual([]);
    });
  }
  test(`A4: Leser sieht Lindach ohne Schreibhebel, Unterstützung ST-1 sieht es nicht bei ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.setFixedTime(new Date(STAND));
    const state = await cloud(page, 'lindach', true);
    await page.goto('/e2e/summenwert-abnahme.html?fall=lindach&person=CB');
    await expect(page.getByText('Hallen Lindach jetzt', { exact: true })).toBeVisible();
    const karte = page.getByRole('region', { name: 'Gerätekarte' });
    await expect(karte.getByRole('button', { name: 'Summenwert anlegen' })).toHaveCount(0);
    await expect(karte.getByRole('button', { name: /Aktionen für/ })).toHaveCount(0);
    await pruefe(page); expect(state.writes).toEqual([]);
    await shot(page, karte, `leser-${width}-karte`);
    await page.goto('/e2e/summenwert-abnahme.html?fall=lindach&person=LV');
    await expect(page.getByText('Dieser Standort gehört nicht zu Ihrem Zugriff.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Gerätekarte' })).toHaveCount(0);
    expect(state.writes).toEqual([]);
  });
}
