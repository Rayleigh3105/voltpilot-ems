import { expect, test, type Page } from '@playwright/test';

/**
 * **Die Ereignisse auf Verlauf › Energie** (Konzept `data/vp-verlauf-ereignisse-k1`)
 * auf der Prüfbühne `verlauf.html`: die Spur sitzt unter der Achse, die Karte
 * direkt unter dem Diagramm, Chips filtern, „Nach Art" fasst zusammen, eine
 * Zeile öffnet ihren Tag. Die Ereignisse der Bühne kommen wie vom Server
 * (`verlauf-fixtures.ts`: Fenster mit der einen Zahl, ab der Woche gebündelt).
 */

const MONAT = '/e2e/verlauf.html#/anlage/help-site/messwerte?z=monat&at=2026-08-15';
const TAG = '/e2e/verlauf.html#/anlage/help-site/messwerte?z=tag&at=2026-08-04';

async function oeffne(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole('region', { name: 'Ereignisse' })).toBeVisible();
}

const karte = (page: Page) => page.getByRole('region', { name: 'Ereignisse' });

test('die Ereignisse stehen direkt unter dem Diagramm, die Spur unter der Achse', async ({ page }) => {
  await oeffne(page, MONAT);
  const diagramm = page.getByRole('region', { name: 'Energiebilanz je Tag' });
  const d = (await diagramm.boundingBox())!;
  const e = (await karte(page).boundingBox())!;
  // Gleich unter dem Diagramm, bündig — am Telefon wie am Schreibtisch.
  expect(e.y).toBeGreaterThan(d.y + d.height - 1);
  expect(e.y - (d.y + d.height)).toBeLessThan(32);
  expect(Math.abs(e.x - d.x)).toBeLessThan(1);
  // Die Seitenkarten folgen erst danach (am Telefon) bzw. stehen daneben.
  const quote = (await page.getByRole('region', { name: 'Selbst versorgt' }).boundingBox())!;
  if (quote.x <= d.x + 1) expect(quote.y).toBeGreaterThan(e.y + e.height - 1);

  // Je Art eine Bahn, in den Farben ihres Bereichs.
  const bahnen = diagramm.locator('.vp-vr-spur-bahn');
  await expect(bahnen).toHaveCount(4);
  await expect(bahnen.first()).toHaveClass(/is-markt/);
  // Jede Marke öffnet ihren Tag, ihre Bahn liegt innerhalb der Karte.
  const marke = diagramm.getByRole('button', { name: /Dienstag, 04\.08\.: Negative Preise/ });
  const m = (await marke.boundingBox())!;
  expect(m.x).toBeGreaterThan(d.x);
  expect(m.x + m.width).toBeLessThan(d.x + d.width);
});

test('ein Wort und eine Zahl je Zeile; zwei Arten an einem Tag unter einem Datum', async ({ page }) => {
  await oeffne(page, MONAT);
  // Am Telefon zeigt die Chronik erst vier Tage, am Schreibtisch sechs.
  await karte(page).getByRole('button', { name: /^Alle \d+ Tage zeigen$/ }).click();
  const zeile = karte(page).getByRole('button', { name: /Samstag, 15\.08\.: Abregelung/ });
  await expect(zeile).toContainText('Abregelung');
  await expect(zeile).toContainText('geplant');
  await expect(zeile).toContainText(/\d,\d\s?kWh/);
  const tag = karte(page).getByRole('list', { name: 'Samstag, 15.08.' });
  await expect(tag.getByRole('button')).toHaveCount(2);
  // Kein Servertext mehr als zweiter Satz neben dem Etikett.
  await expect(karte(page)).not.toContainText('Negative Börsenpreise:');
});

test('Chips filtern Chronik und Spur, „Nach Art" fasst zusammen und führt zurück', async ({ page }) => {
  await oeffne(page, MONAT);
  const chips = karte(page).getByRole('group', { name: 'Nach Art filtern' });
  await chips.getByRole('button', { name: /Netzladen/ }).click();
  await expect(chips.getByRole('button', { name: /Netzladen/ })).toHaveAttribute('aria-pressed', 'true');
  const zeilen = karte(page).locator('.vp-vr-zeile');
  await expect(zeilen).toHaveCount(2);
  await expect(zeilen.first()).toContainText('Netzladen');
  await expect(page.locator('.vp-vr-spur-bahn.is-markt')).toHaveClass(/is-gedimmt/);

  await karte(page).getByRole('button', { name: 'Nach Art' }).click();
  const kachel = karte(page).getByRole('button', { name: /^Abregelung: 1\sTag/ });
  await expect(kachel).toBeVisible();
  await expect(kachel.locator('.vp-vr-streifen > i')).toHaveCount(31);
  await kachel.click();
  await expect(karte(page).getByRole('button', { name: 'Nach Tag' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chips.getByRole('button', { name: /Abregelung/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(zeilen).toHaveCount(1);
});

test('eine Zeile öffnet ihren Tag', async ({ page }) => {
  await oeffne(page, MONAT);
  await karte(page).getByRole('button', { name: /Dienstag, 04\.08\.: Negative Preise/ }).click();
  await expect(page).toHaveURL(/z=tag&at=2026-08-04/);
  await expect(page.getByRole('region', { name: 'Leistung im Tagesverlauf' })).toBeVisible();
});

test('am Tag klappt der Abendverkauf seine Fakten auf', async ({ page }) => {
  await oeffne(page, TAG);
  await expect(karte(page).getByRole('button', { name: 'Nach Zeit' })).toHaveAttribute('aria-pressed', 'true');
  const verkauf = karte(page).getByRole('button', { name: /Abendverkauf\s*geplant/ });
  await expect(verkauf).toHaveAttribute('aria-expanded', 'false');
  await verkauf.click();
  await expect(verkauf).toHaveAttribute('aria-expanded', 'true');
  await expect(karte(page).getByText('Speicher leer')).toBeVisible();
  await expect(karte(page).getByText('03:15')).toBeVisible();
});

test('kein Querlauf und jede Zeile ein 44-px-Ziel', async ({ page }) => {
  for (const url of [MONAT, TAG]) {
    await oeffne(page, url);
    const breite = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(breite[0]).toBeLessThanOrEqual(breite[1]);
    for (const box of await karte(page).locator('button.vp-vr-zeile').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(box).toBeGreaterThanOrEqual(44);
    }
    // Kein Text der Karte ragt aus ihr heraus.
    const raus = await karte(page).evaluate((k) => {
      const r = k.getBoundingClientRect();
      return [...k.querySelectorAll('*')].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1);
      }).length;
    });
    expect(raus).toBe(0);
  }
});
