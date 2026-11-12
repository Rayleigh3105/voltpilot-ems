import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const widths = [320, 375, 390, 430, 560, 561, 720, 721, 768, 834, 1023, 1024, 1100, 1200, 1279, 1280, 1440];

for (const scene of ['long', 'admin&long', 'admin&fleet', 'ok', 'unknown']) {
  test(`shared header stays aligned and contained: ${scene}`, async ({ page }) => {
    await page.goto(`/e2e/shell-layout.html?${scene}`);
    await expect(page.locator('.vp-topbar')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      // Picker switches between native/custom presentation after matchMedia.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (scene.includes('admin') && width <= 1279) {
        // The shared picker animates its size when entering the compact bar.
        await expect.poll(() => page.locator('.vp-context').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      }
      const bounds = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().toJSON();
        return { pageWidth: document.documentElement.scrollWidth, header: rect('.vp-topbar')!,
          avatar: rect('.vp-avatar-btn')!, title: rect('.vp-topbar .here')!,
          status: rect('.vp-healthbadge'), tenant: rect('.vp-context'), main: rect('.vp-main')!,
          // Scheibe S1 (E3 = A): mit gewähltem Mandanten steht das Rückweg-Band
          // „Wie der Kunde es sieht" zwischen Kopfzeile und Inhalt.
          band: rect('.vp-kundenansicht-band') };
      });
      expect(bounds.pageWidth, `${scene} @ ${width}: document overflow`).toBeLessThanOrEqual(width);
      expect(bounds.avatar.right).toBeLessThanOrEqual(width);
      expect(bounds.main.top).toBeCloseTo(bounds.band ? bounds.band.bottom : bounds.header.bottom, 1);
      if (width <= 1279) {
        expect(bounds.avatar.width).toBeGreaterThanOrEqual(44);
        expect(bounds.avatar.height).toBeGreaterThanOrEqual(44);
        if (!scene.includes('fleet')) {
          expect(bounds.title.width, `plant identity @ ${width}`).toBeGreaterThan(scene.includes('long') ? 80 : 70);
          if (bounds.status) {
            // B1 (UI/UX-Wartung u1): eine Ursache, die nicht neben „Warnung“ passt,
            // bricht jetzt um statt mit „…“ abzuschneiden - dann wird der Block
            // höher als 44px und kann nicht mehr exakt mit dem Avatar fluchten.
            // Im üblichen Fall (keine Ursache oder eine kurze) bleiben Titel- und
            // Zustandszeile weiter ein einziger, mit dem Avatar zentrierter 44px-Block.
            if (bounds.status.height <= 24) {
              expect(bounds.title.top).toBeCloseTo(bounds.avatar.top, 0);
              expect(bounds.status.bottom).toBeCloseTo(bounds.avatar.bottom, 0);
            } else {
              expect(bounds.title.top).toBeGreaterThanOrEqual(bounds.header.top);
              expect(bounds.status.bottom).toBeLessThanOrEqual(bounds.header.bottom);
            }
            expect(bounds.status.right).toBeLessThanOrEqual(bounds.avatar.x - 8);
          }
        }
        if (bounds.tenant) {
          expect(bounds.tenant.height, `tenant target @ ${width}`).toBeGreaterThanOrEqual(44);
          if (width <= 720 && !scene.includes('fleet')) {
            expect(bounds.tenant.top).toBeGreaterThanOrEqual(bounds.avatar.bottom);
            expect(bounds.tenant.x).toBeCloseTo(bounds.title.x, 1);
          }
        }
      }
    }
  });
}

test('plant, health, tenant and account controls stay independently reachable', async ({ page }) => {
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/e2e/shell-layout.html?admin&long');
    const title = page.locator('.vp-topbar .here');
    const box = (await title.boundingBox())!;
    // Real coordinates catch overlays intercepting a visually correct label.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole('option', { name: 'Werkstatt am Bach', exact: true }).click();
    await expect(title).toHaveText('Werkstatt am Bach');
    await page.getByRole('button', { name: /Zustand der Anlage:/ }).click();
    await expect(page.getByRole('dialog', { name: 'Zustand der Anlage' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Scheibe S1 (E3 = A): die Suche ersetzt den Mandanten-Umschalter.
    await page.getByRole('combobox', { name: 'Box, Kunde, Anlage, Person suchen' }).click();
    await expect(page.getByRole('listbox', { name: 'Box, Kunde, Anlage, Person suchen' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Konto-Menü/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.scrollTo(0, 500));
    const header = await page.locator('.vp-topbar').boundingBox();
    expect(header!.y).toBe(0);
    await expect(page.getByRole('button', { name: /Konto-Menü/ })).toBeInViewport();
    await expect.poll(async () => (await page.locator('.vp-mob-sticky').boundingBox())!.y).toBeCloseTo(header!.height, 1);
  }
});

test('anlage shows the connected share of all boxes at 375 and 1440', async ({ page }) => {
  await page.goto('/e2e/shell-layout.html?multi');
  await page.evaluate(() => document.fonts.ready);
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const status = page.getByText('2 von 2 Boxen verbunden', { exact: false });
    await expect(status).toBeVisible();
    await expect(status).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (process.env.VERBUNDEN_BILDER) {
      mkdirSync(process.env.VERBUNDEN_BILDER, { recursive: true });
      await page.screenshot({
        path: join(process.env.VERBUNDEN_BILDER, `verbunden-je-box-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
});

test('cockpit actions stay together below the reserved freshness row', async ({ page }) => {
  await page.goto('/e2e/help.html#/anlage/help-site');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const badges = page.locator('.vp-anlage-head.is-phone .vp-anlage-badges');
    await expect(badges).toBeVisible();
    // Exercise the longest offline wording on the actual rendered component.
    await badges.locator('.vp-anlage-chipzeile > span').first().evaluate(el => {
      el.lastChild!.textContent = 'keine aktuellen Daten · Stand: 15:44 Uhr';
    });
    const customize = (await badges.getByRole('button', { name: 'Cockpit anpassen' }).boundingBox())!;
    const settings = (await badges.getByRole('button', { name: 'Einstellungen', exact: true }).boundingBox())!;
    expect(customize.y).toBe(settings.y);
    expect(settings.x).toBeGreaterThan(customize.x);
    const freshness = (await badges.locator('.vp-anlage-chipzeile').boundingBox())!;
    expect(customize.y).toBeGreaterThanOrEqual(freshness.y + freshness.height);
    expect(settings.width).toBeGreaterThanOrEqual(44);
    expect(settings.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('sidebar entries carry their name as a title only in the icon rail - nothing floats on the desktop', async ({ page }) => {
  // Befund vom 02.11.2026: ein natives „Fahrplan"-Tooltip hing über der Brotkrume.
  // Der `title` steht am Zeiger, nicht am Eintrag; auf dem Rechner ist der Name
  // sichtbar und der Titel entfällt, in der Symbolleiste (721–1023 px) trägt er ihn.
  await page.goto('/e2e/shell-layout.html?ok');
  await page.evaluate(() => document.fonts.ready);
  const lesen = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('.vp-sidebar .vp-navitem')].map((b) => {
          const lbl = b.querySelector('.vp-nav-lbl')!;
          return [lbl.textContent!.trim(), { title: b.getAttribute('title'), labelWidth: Math.round(lbl.getBoundingClientRect().width) }];
        }),
      ),
    );
  await page.setViewportSize({ width: 1200, height: 844 });
  await expect.poll(async () => (await lesen()).Fahrplan?.title ?? null).toBeNull();
  const rechner = await lesen();
  expect(rechner.Fahrplan.labelWidth).toBeGreaterThan(20);
  expect(rechner.Cockpit.title).toBeNull();
  expect(rechner.Portfolio.title).toBeNull();
  expect(rechner['Hilfe & Kontakt'].title).toBeNull();

  await page.setViewportSize({ width: 834, height: 1194 });
  await expect.poll(async () => (await lesen()).Fahrplan?.title ?? null).toBe('Fahrplan');
  const tablet = await lesen();
  expect(tablet.Fahrplan.labelWidth).toBeLessThanOrEqual(1);
  expect(tablet.Cockpit.title).toBe('Cockpit');
  expect(tablet.Portfolio.title).toBe('Portfolio');
  expect(tablet['Hilfe & Kontakt'].title).toBe('Hilfe & Kontakt');
});
