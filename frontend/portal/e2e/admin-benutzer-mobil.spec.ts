import { expect, test, type Page } from '@playwright/test';

/**
 * Admin › Benutzer am Telefon (Auftrag `vp-admin-mobil-ueberholung`, Bilder des Captains vom 07.11.2026):
 * - Kundenliste: EINE kompakte Zeile je Kunde (Name, Segment, Zustand, darunter „1 Person · 3 Anlagen · 3 Boxen“)
 *   statt einer Etikett/Wert-Karte mit fünf Zeilen;
 * - Kundenkopf: der Name trägt die volle Breite; vorher schrumpfte die Mitte neben dem breiten Knopf auf 26 px und
 *   Name, „aktiv“ und „Wie der Kunde es sieht“ lagen übereinander;
 * - Rückweg-Band „Wie der Kunde es sieht“: eine Zeile statt zwei; Glocke und Hilfe in der Zeile der Auswahl.
 * Wirte: `mandantensicht-navigation.html` (ganzer `App`, gefälschter Server) und `mandanten-akte.html` (Personen).
 */
const PHONE = { width: 390, height: 844 };

async function keinUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
}

test('390 px: die Kundenliste zeigt je Kunde eine kompakte Zeile ohne Etiketten', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/mandantensicht-navigation.html#/mandanten');
  const knopf = page.getByRole('button', { name: 'Details zu Solarhof Beispiel' });
  await expect(knopf).toBeVisible();
  const zeile = page.locator('tr', { has: knopf });
  await expect(zeile).toContainText(/\d+ (Person|Personen) · \d+ (Anlage|Anlagen) · \d+ (Box|Boxen)/);
  const mass = await zeile.evaluate((tr) => ({
    hoehe: tr.getBoundingClientRect().height,
    // Kein „KUNDE“/„PERSONEN“-Etikett mehr vor den Zellen.
    etiketten: [...tr.querySelectorAll('td')].filter((td) => {
      const c = getComputedStyle(td, '::before').content;
      return td.getBoundingClientRect().height > 0 && c !== 'none' && c !== 'normal' && c !== '""';
    }).length,
  }));
  expect(mass.hoehe, 'eine Kundenzeile bleibt unter 110 px (vorher ~ 230 px)').toBeLessThan(110);
  expect(mass.etiketten).toBe(0);
  await keinUeberlauf(page);
});

test('1440 px: die Kundenliste bleibt eine Tabelle mit Spaltenköpfen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/e2e/mandantensicht-navigation.html#/mandanten');
  await expect(page.getByRole('columnheader', { name: 'Personen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Details zu Solarhof Beispiel' })).toContainText('Details');
  await keinUeberlauf(page);
});

test('390 px: der Kundenkopf - Name in voller Breite, darunter Zustand und die Knöpfe in einer Reihe', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/mandanten-akte.html');
  const kopf = page.locator('.vp-kundenakte-kopf');
  await expect(kopf.getByRole('heading', { level: 1 })).toBeVisible();
  const mass = await kopf.evaluate((k) => {
    const r = (e: Element | null) => e!.getBoundingClientRect();
    const knoepfe = [...k.querySelectorAll('.vp-kundenakte-kopf-rechts button')].map(r);
    return { h1: r(k.querySelector('h1')), marken: r(k.querySelector('.vp-kundenakte-marken')), knoepfe };
  });
  expect(mass.h1.width, 'der Name hat Platz (vorher 26 px)').toBeGreaterThan(300);
  expect(mass.marken.top).toBeGreaterThanOrEqual(mass.h1.bottom - 1);
  expect(mass.knoepfe).toHaveLength(2);
  for (const k of mass.knoepfe) expect(k.top, 'kein Knopf liegt über Name oder Zustand').toBeGreaterThanOrEqual(mass.marken.bottom - 1);
  expect(Math.abs(mass.knoepfe[0].top - mass.knoepfe[1].top), 'beide Knöpfe in einer Reihe').toBeLessThan(2);
  await expect(kopf.getByRole('button', { name: 'Bearbeiten' })).toBeVisible();
  await expect(kopf.getByRole('button', { name: 'Wie der Kunde es sieht' })).toBeVisible();
  await keinUeberlauf(page);
});

test('390 px: Personen stehen je in einer kompakten Zeile, die E-Mail bricht höchstens am @', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/mandanten-akte.html');
  const zeile = page.locator('.vp-kundenakte-personen tr', { hasText: 'Felix Diekmann' });
  await expect(zeile).toBeVisible();
  await expect(zeile.getByRole('button', { name: /Aktionen für/ })).toBeVisible();
  const mass = await zeile.evaluate((tr) => ({
    hoehe: tr.getBoundingClientRect().height,
    mail: tr.querySelector('.vp-person-mail')?.getBoundingClientRect().height ?? 0,
    abgeschnitten: [...tr.querySelectorAll<HTMLElement>('td, td *')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
  }));
  expect(mass.hoehe, 'eine Person unter 130 px (vorher ~ 230 px)').toBeLessThan(130);
  expect(mass.abgeschnitten, 'nichts abgeschnitten').toBe(0);
  expect(mass.mail).toBeGreaterThan(0);
  expect(mass.mail, 'E-Mail in höchstens zwei Zeilen (am @)').toBeLessThan(46);
  await keinUeberlauf(page);
});

test('390 px: das Band „Wie der Kunde es sieht“ ist eine Zeile und führt zurück', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/e2e/mandantensicht-navigation.html#/mandanten');
  await page.getByRole('button', { name: 'Details zu Solarhof Beispiel' }).click();
  await page.getByRole('region', { name: 'Solarhof Beispiel' }).getByRole('button', { name: 'Wie der Kunde es sieht' }).click();
  const band = page.locator('.vp-kundenansicht-band');
  await expect(band).toContainText('Solarhof Beispiel');
  const hoehe = await band.evaluate((b) => b.getBoundingClientRect().height);
  expect(hoehe, 'eine Zeile (vorher zwei, ~ 78 px)').toBeLessThanOrEqual(52);
  // Glocke und Hilfe stehen in der Zeile der Auswahl, nicht allein in einer dritten Kopfzeile.
  const kopf = await page.evaluate(() => {
    const r = (s: string) => document.querySelector(s)?.getBoundingClientRect();
    return { auswahl: r('.vp-topbar .vp-context'), glocke: r('.vp-topbar .vp-glocke'), band: r('.vp-kundenansicht-band') };
  });
  expect(kopf.glocke && kopf.auswahl).toBeTruthy();
  expect(Math.abs(kopf.glocke!.top + kopf.glocke!.height / 2 - (kopf.auswahl!.top + kopf.auswahl!.height / 2))).toBeLessThan(4);
  expect(kopf.band!.top, 'das Band folgt direkt auf die Auswahl-Zeile').toBeLessThan(kopf.auswahl!.bottom + 24);
  await keinUeberlauf(page);
  await band.getByRole('button', { name: 'Zur Plattform zurück' }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('vp-tenant-override'))).toBeNull();
});
