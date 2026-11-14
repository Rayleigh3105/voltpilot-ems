import { test, expect as basisExpect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Grundlast (Bedienkonzept Privatkunde §5, Variante A; BK-1…BK-3 = A): Karte in Verlauf › Energie nach
// „Verbrauch nach Bereichen“ und kleine Kachel im Cockpit, bei 1440 und 375 px ohne Querlauf und ohne Fehler.
// Bühnen: `unterverteilung` (Sonnenhof mit UV Halle/UV Keller) und `cockpit-privat` (Mühlbach wie Schramm,
// Birkenweg ohne Unterzähler). Bilder: GRUNDLAST_BILDER=<Ordner>.

const bilder = process.env.GRUNDLAST_BILDER;
// Karte und Kachel holen ihre Zahl nach dem Verlauf; unter Last dauert das länger als die Vorgabe von 5 s.
const expect = basisExpect.configure({ timeout: 20000 });

async function pruefe(page: Page, name: string, fehler: string[], ziel?: ReturnType<Page['locator']>) {
  expect(fehler).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(await page.locator('main').evaluate((el) => [...el.querySelectorAll('*')].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
  }).length)).toBe(0);
  if (bilder) {
    await mkdir(bilder, { recursive: true });
    await page.screenshot({ path: `${bilder}/${name}.png`, fullPage: !ziel });
    if (ziel) await ziel.screenshot({ path: `${bilder}/${name}-karte.png` });
  }
}

function fehlerSammler(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  return fehler;
}

const karte = (page: Page) => page.getByRole('region', { name: 'Grundlast' });

for (const width of [1440, 375]) {
  test(`Verlauf › Energie: Karte Grundlast mit Unterzählern (Woche) bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const fehler = fehlerSammler(page);
    await page.goto('/e2e/unterverteilung.html#/anlage/help-site/messwerte?z=woche&at=2026-09-02');
    const k = karte(page);
    await expect(k).toBeVisible();
    await expect(k).toContainText('läuft immer, auch nachts');
    await expect(k).toContainText('typische Nacht der Woche');
    await expect(k).toContainText('UV Halle');
    await expect(k).toContainText('UV Keller');
    await expect(k).toContainText('übriger Haushalt');
    await expect(k).toContainText(/Rund \d+ kWh am Tag – etwa .* Ihres Verbrauchs\. Vorwoche: \d+ W\./);
    await expect(k.locator('.vp-vr-grundlast-saeule')).toHaveCount(7);
    // Ort: nach „Verbrauch nach Bereichen“ in derselben Spalte.
    const reihenfolge = await page.locator('.vp-vr-col section').evaluateAll((s) => s.map((e) => e.getAttribute('aria-label')));
    expect(reihenfolge.indexOf('Grundlast')).toBe(reihenfolge.indexOf('Verbrauch nach Bereichen') + 1);
    await k.scrollIntoViewIfNeeded();
    await pruefe(page, `verlauf-woche-sonnenhof-${width}`, fehler, k);
  });

  for (const [z, erwartet, balken, at] of [['monat', 'typische Nacht im Monat', 31, '2026-08-15'], ['jahr', 'typische Nacht im Jahr', 12, '2026-09-02']] as const) {
    test(`Verlauf › Energie: Karte folgt dem Zeitraum (${z}) bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler = fehlerSammler(page);
      await page.goto(`/e2e/unterverteilung.html?grundlast=${z === 'monat' ? 'stufe' : 'voll'}#/anlage/help-site/messwerte?z=${z}&at=${at}`);
      const k = karte(page);
      await expect(k).toContainText(erwartet);
      await expect(k.locator('.vp-vr-grundlast-saeule')).toHaveCount(balken);
      if (z === 'monat') await expect(k).toContainText(/Seit dem 17\. August rund \d+\u00a0W mehr\./);
      if (z === 'jahr') await expect(k).toContainText('Niedrigster Monat: Juli');
      await k.scrollIntoViewIfNeeded();
      await pruefe(page, `verlauf-${z}-sonnenhof-${width}`, fehler, k);
    });
  }

  for (const [fall, satz, at] of [
    ['luecke', '2 Nächte ohne Messwerte sind nicht gewertet.', '2026-09-02'],
    ['wenig', 'Noch 1 Nacht Messung, dann steht hier Ihre Grundlast.', '2026-09-10'],
  ] as const) {
    test(`Verlauf › Energie: Zustand ${fall} bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler = fehlerSammler(page);
      await page.goto(`/e2e/unterverteilung.html?grundlast=${fall}#/anlage/help-site/messwerte?z=woche&at=${at}`);
      const k = karte(page);
      await expect(k).toContainText(satz);
      await expect(k.locator('.vp-vr-grundlast-saeule.is-ohne').first()).toBeVisible();
      await k.scrollIntoViewIfNeeded();
      await pruefe(page, `verlauf-${fall}-sonnenhof-${width}`, fehler, k);
    });
  }

  test(`Verlauf › Energie: ohne gemessenen Hausverbrauch keine Karte bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const fehler = fehlerSammler(page);
    await page.goto('/e2e/unterverteilung.html?grundlast=nie#/anlage/help-site/messwerte?z=woche&at=2026-09-02');
    await expect(page.getByRole('region', { name: 'Verbrauch nach Bereichen' })).toBeVisible();
    await expect(karte(page)).toHaveCount(0);
    expect(fehler).toEqual([]);
  });

  for (const [lage, name, teile] of [['abend', 'muehlbach', true], ['speicher', 'birkenweg', false]] as const) {
    test(`Verlauf › Energie: Karte Grundlast (${name}) bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler = fehlerSammler(page);
      await page.goto(`/e2e/cockpit-privat.html?lage=${lage}&profil=privat#/anlage/${name}/messwerte?z=woche&at=2026-11-04`);
      const k = karte(page);
      await expect(k).toContainText('typische Nacht der Woche');
      await expect(k.locator('.vp-vr-grundlast-saeule')).toHaveCount(7);
      if (teile) await expect(k).toContainText('übriger Haushalt');
      else await expect(k.locator('.vp-vr-grundlast-teile')).toHaveCount(0);
      await k.scrollIntoViewIfNeeded();
      await pruefe(page, `verlauf-woche-${name}-${width}`, fehler, k);
    });
  }

  for (const [lage, name] of [['abend', 'muehlbach'], ['speicher', 'birkenweg']] as const) {
    test(`Cockpit: Kachel Grundlast (${name}) bei ${width} px, Absprung in den Verlauf`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler = fehlerSammler(page);
      await page.goto(`/e2e/cockpit-privat.html?lage=${lage}&profil=privat#/anlage/${name}`);
      const kachel = page.locator('[data-kachel="grundlast"]');
      await expect(kachel).toBeVisible();
      await expect(kachel).toContainText('läuft immer');
      await expect(kachel).toContainText(/vor einem Monat \d+ W/);
      await kachel.scrollIntoViewIfNeeded();
      await pruefe(page, `cockpit-${name}-${width}`, fehler, kachel);
      await kachel.getByRole('button', { name: /Grundlast · Verlauf öffnen/ }).click();
      await expect(page).toHaveURL(new RegExp(`#/anlage/${name}/messwerte\\?z=woche`));
    });
  }

  test(`Cockpit: Kachel mit zu wenig Historie bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const fehler = fehlerSammler(page);
    await page.goto('/e2e/cockpit-privat.html?lage=abend&profil=privat&grundlast=wenig#/anlage/muehlbach');
    const kachel = page.locator('[data-kachel="grundlast"]');
    await expect(kachel).toContainText('noch 1 Nacht Messung');
    await kachel.scrollIntoViewIfNeeded();
    await pruefe(page, `cockpit-muehlbach-wenig-${width}`, fehler, kachel);
  });

  test(`Cockpit: ohne gemessenen Hausverbrauch keine Kachel bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto('/e2e/cockpit-privat.html?lage=abend&profil=privat&grundlast=nie#/anlage/muehlbach');
    await expect(page.locator('[data-kachel="heute"]')).toBeVisible();
    await expect(page.locator('[data-kachel="grundlast"]')).toHaveCount(0);
  });
}
