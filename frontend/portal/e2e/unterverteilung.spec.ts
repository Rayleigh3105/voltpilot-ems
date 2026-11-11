import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Unterverteilungen (Konzept `vp-unterzaehler-anzeige`, Entscheide UV-1…UV-4 A, 07.11.2026): zwei
// Shelly-Unterzähler im Cockpit („Verbrauch im Detail“, Restwort nach Profil) und im Verlauf
// (Karte „Verbrauch nach Bereichen“), bei 1440 und 390 px ohne Querlauf und ohne Fehler.
// Bilder: UNTERVERTEILUNG_BILDER=<Ordner> (mit `?vorher=1` derselbe Fall im Stand vor dem Paket).

const bilder = process.env.UNTERVERTEILUNG_BILDER;
const vorher = process.env.UNTERVERTEILUNG_VORHER === '1';

async function pruefe(page: Page, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(await page.locator('main').evaluate((el) => [...el.querySelectorAll('*')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
  }).length)).toBe(0);
  if (bilder) {
    await mkdir(bilder, { recursive: true });
    await page.screenshot({ path: `${bilder}/${name}.png`, fullPage: true });
  }
}

for (const width of [1440, 390]) {
  for (const profil of ['privat', 'gewerbe'] as const) {
    test(`Cockpit „Verbrauch im Detail“ mit Unterzählern (${profil}) bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler: string[] = [];
      page.on('pageerror', (e) => fehler.push(e.message));
      await page.goto(`/e2e/unterverteilung.html?profil=${profil}${vorher ? '&vorher=1' : ''}#/anlage/help-site`);
      const liste = page.getByRole('region', { name: 'Verbrauch im Detail' }).first();
      await expect(liste).toBeVisible();
      await expect(liste).toContainText('UV Halle');
      await expect(liste).toContainText('UV Keller');
      if (!vorher) {
        await expect(liste).toContainText(profil === 'gewerbe' ? 'ohne eigenen Zähler' : 'übriger Haushalt');
        await expect(liste).not.toContainText(profil === 'gewerbe' ? 'übriger Haushalt' : 'ohne eigenen Zähler');
      }
      await liste.scrollIntoViewIfNeeded();
      await pruefe(page, `cockpit-${profil}-${width}${vorher ? '-vorher' : ''}`);
      expect(fehler).toEqual([]);
    });
  }

  test(`Verlauf › Energie: „Verbrauch nach Bereichen“ bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.goto(`/e2e/unterverteilung.html${vorher ? '?vorher=1' : ''}#/anlage/help-site/messwerte?z=woche&at=2026-09-03`);
    await expect(page.locator('.vp-vr-card').first()).toBeVisible();
    const karte = page.getByRole('region', { name: 'Verbrauch nach Bereichen' });
    if (vorher) {
      await expect(page.locator('.vp-vr-card').first()).toBeVisible();
      await expect(karte).toHaveCount(0);
    } else {
      await expect(karte).toBeVisible();
      await expect(karte).toContainText('UV Halle');
      await expect(karte).toContainText('Unterzähler');
      await expect(karte).toContainText('übriger Haushalt');
      await expect(karte.locator('.vp-vr-saeule')).toHaveCount(7);
      const [download] = await Promise.all([page.waitForEvent('download'), karte.getByRole('button', { name: 'CSV' }).click()]);
      expect(download.suggestedFilename()).toBe("verbrauch-bereiche_sonnenhof_woche_2026-09-03.csv");
      await karte.scrollIntoViewIfNeeded();
    }
    await pruefe(page, `verlauf-woche-${width}${vorher ? '-vorher' : ''}`);
    expect(fehler).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`Geräteseite eines Unterzählers: Zählerwerte bei ${width} px`, async ({ page }) => {
    test.skip(vorher, 'die Karte gibt es erst mit diesem Paket');
    await page.setViewportSize({ width, height: 1100 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    await page.goto('/e2e/unterverteilung.html#/anlage/help-site/geraet/VP-DEMO-0001/src-uv-halle');
    // Der Dev-Server liefert die Geräteseite als eigenen Chunk: erst laden lassen, dann prüfen (keine Dauer messen).
    await expect(page.getByRole('heading', { name: 'UV Halle', level: 1 })).toBeVisible({ timeout: 30_000 });
    const karte = page.locator('[data-baustein="modul"]');
    await expect(karte).toContainText('Zählerwerte');
    for (const t of ['Leistung L1', '3,9 kW', 'Zählerstand Bezug', '70.802 kWh', 'Zählerstand Einspeisung']) {
      await expect(karte).toContainText(t);
    }
    await karte.scrollIntoViewIfNeeded();
    await pruefe(page, `geraet-uv-halle-${width}`);
    expect(fehler).toEqual([]);
  });
}
