import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { MessstelleWerte } from '../src/api';
import {
  f13Stunden,
  f13Tag,
  f14Stunden,
  f14Tag,
  f16Monat,
  f16Tage,
  f8Stunden,
  f8Tag,
  normalStunden,
  normalTag,
  ohneQuelleStunden,
  ohneQuelleTag,
} from '../src/test/werteKarteFixtures';

/**
 * Die Tages- und Monatskarte (UEMS AP-08 IP-11) bei 375 px: kein Querlauf,
 * `null` als Strich, MESZ/MEZ an der doppelten Stunde, 23/25 Stunden. Die Cloud
 * ist per `page.route` verdrahtet (Ahrenberg F8, F13, F14, F16, MS-21 ohne
 * Quelle). Mit `TAGESKARTE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild des
 * ersten Bildschirms und eines der ganzen Fläche ab — die Vorschau für die
 * Freigabe.
 */

const ANTWORTEN: Record<string, () => MessstelleWerte> = {
  'MS-10|tag|2026-11-02': normalTag,
  'MS-10|stunde|2026-11-02': normalStunden,
  'MS-10|tag|2026-11-03': f8Tag,
  'MS-10|stunde|2026-11-03': f8Stunden,
  'MS-06|tag|2026-10-25': f13Tag,
  'MS-06|stunde|2026-10-25': f13Stunden,
  'MS-06|tag|2027-03-28': f14Tag,
  'MS-06|stunde|2027-03-28': f14Stunden,
  'MS-06|monat|2026-10-01': f16Monat,
  'MS-06|tag|2026-10-01': f16Tage,
  'MS-21|tag|2026-11-03': ohneQuelleTag,
  'MS-21|stunde|2026-11-03': ohneQuelleStunden,
};

const BILDER = process.env.TAGESKARTE_BILDER;
const BREITE = 375;

async function verdrahte(page: Page) {
  await page.route('**/api/v1/messstellen/*/werte?*', async (route) => {
    const url = new URL(route.request().url());
    const ms = decodeURIComponent(url.pathname.split('/')[4]);
    const key = `${ms}|${url.searchParams.get('raster')}|${url.searchParams.get('von')}`;
    const antwort = ANTWORTEN[key];
    if (!antwort) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(antwort()) });
  });
}

async function oeffne(page: Page, q: string) {
  await verdrahte(page);
  await page.setViewportSize({ width: BREITE, height: 812 });
  await page.goto(`/e2e/tageskarte.html?${q}`);
  await expect(page.getByTestId('werte-karte')).toBeVisible();
  await expect(page.getByTestId('werte-zeile').first()).toBeVisible();
}

/** Kein Querlauf: weder die Seite noch der Dialog noch ein Element ragt über 375 px. */
async function keinQuerlauf(page: Page) {
  const befund = await page.evaluate((breite) => {
    const koerper = document.querySelector('.vp-modal .dbody') as HTMLElement | null;
    const raus = [...document.querySelectorAll('.vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > breite + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${(el as HTMLElement).className}`);
    return {
      seite: document.documentElement.scrollWidth,
      koerper: koerper ? koerper.scrollWidth - koerper.clientWidth : -1,
      raus,
    };
  }, BREITE);
  expect(befund.seite).toBeLessThanOrEqual(BREITE);
  expect(befund.koerper).toBe(0);
  expect(befund.raus).toEqual([]);
}

async function bilder(page: Page, datei: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  // Erst nach dem Einblenden des Dialogs — sonst zeigt das Bild die leere Bühne.
  await expect(page.locator('.vp-modal')).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  await page.screenshot({ path: join(BILDER, `${datei}-telefon.png`) });
  const hoehe = await page.evaluate(() => {
    const k = document.querySelector('.vp-modal .dbody') as HTMLElement;
    const kopf = (document.querySelector('.vp-modal .dhead') as HTMLElement).offsetHeight;
    return kopf + k.scrollHeight + 8;
  });
  await page.setViewportSize({ width: BREITE, height: Math.max(812, hoehe) });
  await page.screenshot({ path: join(BILDER, `${datei}-ganz.png`) });
  await page.setViewportSize({ width: BREITE, height: 812 });
}

const zeile = (page: Page, name: string) =>
  page.getByTestId('werte-zeile').filter({ has: page.locator('.vp-wk-zeile-name', { hasText: new RegExp(`^${name}$`) }) });

test.describe('Tages- und Monatskarte bei 375 px', () => {
  test('ein gewöhnlicher Tag: vollständig aus Zählerständen, Verlauf 100 %', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-02');
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('2.304 kWh');
    await expect(karte).toContainText('vollständig (Menge aus Zählerständen)');
    await expect(karte).toContainText('Verlauf 100 %');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(24);
    await keinQuerlauf(page);
    await bilder(page, '1-gewoehnlicher-tag');
  });

  test('ein Tag mit Lücke: Menge vollständig, Verlauf 85 %, leere Stunden als Strich', async ({ page }) => {
    await oeffne(page, 'ms=MS-10&name=Netzbezug%20Halle%202&art=tag&wert=2026-11-03');
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('2.304 kWh');
    await expect(karte).toContainText('vollständig (Menge aus Zählerständen)');
    await expect(karte).toContainText('Verlauf 85 %');
    await expect(karte).toContainText('Lücke 14:00–17:31: Zuwachs 337,6 kWh gemessen, nicht auf Viertelstunden verteilbar');
    for (const leer of ['15:00–16:00', '16:00–17:00']) {
      await expect(zeile(page, leer).locator('.vp-wk-zeile-zahl')).toHaveText('—');
      await expect(zeile(page, leer)).toContainText('keine Werte');
    }
    await expect(zeile(page, '17:00–18:00').locator('.vp-wk-zeile-zahl')).toHaveText('46,4 kWh');
    await expect(page.locator('.vp-wk-zeile-zahl', { hasText: /^0,0/ })).toHaveCount(0);
    await keinQuerlauf(page);
    await bilder(page, '2-tag-mit-luecke');
  });

  test('der 25-Stunden-Tag: 25 Zeilen, die doppelte Stunde mit MESZ und MEZ', async ({ page }) => {
    await oeffne(page, 'ms=MS-06&name=Spritzguss%20SG01–SG06&art=tag&wert=2026-10-25');
    await expect(page.getByTestId('werte-karte')).toContainText('25 Stunden (Zeitumstellung)');
    await expect(page.getByTestId('werte-karte')).toContainText('720 kWh');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(25);
    await expect(zeile(page, '02:00–03:00 MESZ')).toHaveCount(1);
    await expect(zeile(page, '02:00–03:00 MEZ')).toHaveCount(1);
    await keinQuerlauf(page);
    await bilder(page, '3-fuenfundzwanzig-stunden');
  });

  test('der 23-Stunden-Tag: 23 Zeilen, keine Stunde 02:00', async ({ page }) => {
    await oeffne(page, 'ms=MS-06&name=Spritzguss%20SG01–SG06&art=tag&wert=2027-03-28');
    await expect(page.getByTestId('werte-karte')).toContainText('23 Stunden (Zeitumstellung)');
    await expect(page.getByTestId('werte-karte')).toContainText('662 kWh');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(23);
    await expect(page.locator('.vp-wk-zeile-name', { hasText: /^02:00/ })).toHaveCount(0);
    await keinQuerlauf(page);
    await bilder(page, '4-dreiundzwanzig-stunden');
  });

  test('ein Monat: 55.100 kWh, 31 Tage, der 25.10. nennt seine 25 Stunden', async ({ page }) => {
    await oeffne(page, 'ms=MS-06&name=Spritzguss%20SG01–SG06&art=monat&wert=2026-10');
    const karte = page.getByTestId('werte-karte');
    await expect(karte).toContainText('Oktober 2026');
    await expect(karte).toContainText('55.100 kWh');
    await expect(page.getByTestId('werte-zeile')).toHaveCount(31);
    await expect(zeile(page, 'So 25.10.')).toContainText('25 Stunden (Zeitumstellung)');
    await keinQuerlauf(page);
    await bilder(page, '5-monat');
  });

  test('eine Messstelle ohne Werte: Strich und „keine Werte“, nie 0', async ({ page }) => {
    await oeffne(page, 'ms=MS-21&name=Gas%20Heizung%20Verwaltung&art=tag&wert=2026-11-03');
    const karte = page.getByTestId('werte-karte');
    await expect(karte.locator('.vp-wk-zahl')).toHaveText('—');
    await expect(karte).toContainText('keine Werte');
    await expect(karte).not.toContainText('Verlauf');
    await expect(page.locator('.vp-wk-zeile-zahl', { hasText: '—' })).toHaveCount(24);
    await expect(page.locator('.vp-modal')).not.toContainText(/\b0,0\b|\b0 m³/);
    await keinQuerlauf(page);
    await bilder(page, '6-ohne-werte');
  });
});
