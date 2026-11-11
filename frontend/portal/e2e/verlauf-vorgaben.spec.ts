import { expect, test, type Page } from '@playwright/test';

/**
 * **Die Vorgaben einer Erzeugeranlage im Verlauf** (Konzept „Erzeuger am WAGO-Modbus-Server“ §4.5, Paket EZ-9,
 * Entscheid EW-12 A): kein neuer Reiter — Netzbetreiber, Direktvermarkter und „nicht bereit“ stehen als Arten in der
 * Spur, der Chronik und „Nach Art“ der Karte „Ereignisse“, ein Tipp öffnet das Detail mit Rohsignalen und
 * Zählerständen, „Vorgaben als CSV“ lädt den Zeitraum der Ansicht. Prüfbühne `verlauf.html?erzeuger=…` (Bilanz der
 * Bühne plus die Vorgaben wie vom Server, `src/test/erzeugerFixtures.ts`) und `help.html?erzeuger=buettner` (eine
 * Erzeugeranlage ohne Hausbilanz). GEMESSEN: Ort, Inhalt, Tippziele ≥ 44 px, kein Überlauf bei 375/1440 px, Konsole
 * sauber. `EZ9_SHOTS=<Ordner>` legt die Bilder für den PR ab.
 */
const TAG = (fall: 'buettner' | 'gore') => `/e2e/verlauf.html?erzeuger=${fall}#/anlage/help-site/messwerte?z=tag&at=2026-09-10`;
const MONAT = '/e2e/verlauf.html?erzeuger=buettner#/anlage/help-site/messwerte?z=monat&at=2026-09-10';
const OHNE_BILANZ = '/e2e/help.html?erzeuger=buettner#/anlage/help-site/messwerte?z=tag&at=2026-09-10';
const SHOTS = process.env.EZ9_SHOTS;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffne(page: Page, url: string) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
  await page.goto(url);
  await expect(karte(page)).toBeVisible();
  return fehler;
}

const karte = (page: Page) => page.getByRole('region', { name: 'Ereignisse' });
const ueberlauf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const text = (l: ReturnType<Page['locator']>) => l.evaluate((el) => (el.textContent ?? '').replace(/[  ]/g, ' '));

/**
 * Ein Bild für den PR: das Fenster so hoch wie die Seite (feste Kopf- und Fußleisten stehen dann oben und unten,
 * nicht mitten im Bild), wahlweise auf die Ziele zugeschnitten.
 */
async function bild(page: Page, name: string, ...ziele: ReturnType<Page['locator']>[]) {
  if (!SHOTS) return;
  const fenster = page.viewportSize()!;
  await page.evaluate(() => window.scrollTo(0, 0));
  const hoehe = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: fenster.width, height: Math.min(hoehe, 4000) });
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  if (ziele.length) {
    const r = await Promise.all(ziele.map((z) => z.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, r: b.right, u: b.bottom };
    })));
    const x = Math.max(0, Math.min(...r.map((b) => b.x)) - 8);
    const y = Math.max(0, Math.min(...r.map((b) => b.y)) - 8);
    clip = { x, y, width: Math.min(fenster.width, Math.max(...r.map((b) => b.r)) + 8) - x, height: Math.max(...r.map((b) => b.u)) + 8 - y };
  }
  await page.screenshot({ path: `${SHOTS}/${name}.png`, clip });
  await page.setViewportSize(fenster);
}

test('am Rechner: Spur, Chronik-Zeile mit Vorgabe und Detail, „Vorgaben als CSV“', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fehler = await oeffne(page, TAG('buettner'));
  // Die Spur unter der Achse: Netzbetreiber (Netz), Direktvermarkter (Markt), nicht bereit (Daten).
  const spur = page.getByRole('group', { name: 'Ereignisse am Diagramm' });
  await expect(spur.locator('.vp-vr-spur-bahn').filter({ has: page.locator('[title="Netzbetreiber"]') })).toHaveClass(/is-netz/);
  await expect(spur.locator('.vp-vr-spur-bahn').filter({ has: page.locator('[title="Direktvermarkter"]') })).toHaveClass(/is-markt/);
  await expect(spur.locator('.vp-vr-spur-bahn').filter({ has: page.locator('[title="nicht bereit"]') })).toHaveClass(/is-daten/);

  const zeile = karte(page).getByRole('button', { name: /^Netzbetreiber · 60\s%/ });
  expect(await text(zeile)).toBe('Netzbetreiber · 60 %1 Std 11 Min · folgt ✓≈ 25,0 kWh');
  expect(await text(karte(page).getByRole('button', { name: /^Direktvermarkter · Abruf 80,0\skW/ }))).toContain('nicht bindend');
  await expect(karte(page)).toContainText('1 weiterer Wechsel während einer Datenlücke');
  await expect(karte(page)).not.toContainText('Eingriff');
  await bild(page, 'rechner-tag', page.locator('.vp-vr-row .vp-vr-col').first());

  await zeile.click();
  const detail = karte(page).locator('.vp-vr-vorgabe-detail');
  await expect(detail).toContainText('Rohsignale am Beginn');
  expect(await text(detail)).toContain('Zählerstand41 → 42');
  expect(await text(detail)).toContain('n_bitsVorgabe gültig, Verbindung steht, Wirkleistung begrenzt (7)');
  await bild(page, 'rechner-detail', karte(page));

  const download = page.waitForEvent('download');
  await karte(page).getByRole('button', { name: 'Vorgaben als CSV' }).click();
  expect((await download).suggestedFilename()).toBe('vorgaben_biogas-lindenhof_tag_2026-09-10.csv');
  expect(await ueberlauf(page)).toBe(0);
  expect(fehler).toEqual([]);
});

test('am Rechner, Monat: „Nach Art“ zählt je Urheber, je Einheit aufklappbar', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fehler = await oeffne(page, MONAT);
  await karte(page).getByRole('button', { name: 'Nach Art' }).click();
  const nb = karte(page).getByRole('button', { name: /^Netzbetreiber: 4×/ });
  expect(await text(nb)).toContain('6 Std · ≈ 160 kWh nicht erzeugt');
  expect(await text(nb)).toContain('1 Abschaltung');
  expect(await text(karte(page).getByRole('button', { name: /^Direktvermarkter: 10×/ }))).toContain('4 Stopps');
  await karte(page).getByRole('button', { name: 'Je Einheit (2)' }).click();
  await expect(karte(page).getByRole('list', { name: 'Vorgaben je Einheit' })).toContainText('Motor 1');
  await bild(page, 'rechner-monat-nach-art', karte(page));
  expect(await ueberlauf(page)).toBe(0);
  expect(fehler).toEqual([]);
});

test('Gore (PV): die Euro-Schätzung steht unter der Energie, weil EZ-7 sie liefert', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fehler = await oeffne(page, TAG('gore'));
  expect(await text(karte(page).getByRole('button', { name: /^Netzbetreiber · 60\s%/ }))).toContain('≈ 18,4 kWh≈ 1,47 €');
  expect(fehler).toEqual([]);
});

test.describe('am Telefon', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('Chronik als Kontoauszug, Tippziele ≥ 44 px, Detail ohne Überlauf', async ({ page }) => {
    const fehler = await oeffne(page, TAG('buettner'));
    const zeile = karte(page).getByRole('button', { name: /^Netzbetreiber · 60\s%/ });
    await zeile.scrollIntoViewIfNeeded();
    expect((await zeile.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await bild(page, 'telefon-tag', karte(page));
    await zeile.tap();
    await expect(karte(page).locator('.vp-vr-vorgabe-detail')).toContainText('Rohsignale am Beginn');
    const csv = karte(page).getByRole('button', { name: 'Vorgaben als CSV' });
    // Der Textknopf vergrößert seine Tippfläche über ::before (inset −12 px).
    const tippflaeche = await csv.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const vor = getComputedStyle(el, '::before');
      return r.height - parseFloat(vor.top) - parseFloat(vor.bottom);
    });
    expect(tippflaeche).toBeGreaterThanOrEqual(44);
    await bild(page, 'telefon-detail', karte(page));
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test('eine Erzeugeranlage ohne Hausbilanz zeigt die Ereignisse trotzdem', async ({ page }) => {
    const fehler = await oeffne(page, OHNE_BILANZ);
    await expect(page.getByText('Keine Messwerte in diesem Zeitraum')).toBeVisible();
    await expect(karte(page).getByRole('button', { name: /^Netzbetreiber · 30\s%/ })).toBeVisible();
    await expect(karte(page).getByRole('button', { name: 'Vorgaben als CSV' })).toBeVisible();
    await bild(page, 'telefon-ohne-bilanz');
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
});
