import { expect, test } from '@playwright/test';

/**
 * „Wie wird das berechnet?" am Steuerungs-Chip (Captain-Wunsch 01.09.2026).
 *
 * Die zwei Abnahme-Zusagen sind LAYOUT-Zusagen und deshalb hier statt im
 * jsdom-Test: zugeklappt darf die Karte nur um die eine Auslöser-Zeile
 * wachsen, und am Telefon läuft nichts über den Rand.
 */
const PAGE = '/e2e/erloes-formel.html';

test('zugeklappt kostet die Erklärung genau eine Zeile', async ({ page }) => {
  await page.goto(PAGE);
  const karte = page.locator('[data-fall="dv"]');
  await expect(karte).toBeVisible();

  const details = karte.locator('details.vp-formel');
  await expect(details).toHaveJSProperty('open', false);

  // Die Höhe der zugeklappten Erklärung IST die Auslöser-Zeile: der Rumpf
  // steht zwar im DOM (so arbeitet `<details>`), ist aber nicht sichtbar und
  // trägt keine Höhe bei; die Zeile hält ihre 44-px-Trefferfläche (Touch-Regel).
  const zu = (await details.boundingBox())!;
  expect(zu.height).toBeGreaterThanOrEqual(44);
  expect(zu.height).toBeLessThanOrEqual(56);
  await expect(karte.locator('.vp-formel-body')).toBeHidden();

  // Und der Chip darüber wie die Bestandszeile darunter stehen unverändert da.
  await expect(karte.locator('.vp-erg-steering')).toContainText('durch VoltPilots Steuerung');
  await expect(karte.locator('.vp-erg-bestand')).toContainText('im Speicher für später');
});

test('aufgeklappt trägt sie die ganze Rechnung', async ({ page }) => {
  await page.goto(PAGE);
  const karte = page.locator('[data-fall="dv"]');
  const details = karte.locator('details.vp-formel');

  const zu = (await details.boundingBox())!.height;
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);

  const body = details.locator('.vp-formel-body');
  await expect(body).toBeVisible();
  await expect(body).toContainText('Wir vergleichen jede Viertelstunde');
  // ⚠ „Ohne SMARTE Steuerung" — nicht „Ohne Steuerung". #626 hat die Messlatte
  // umbenannt, weil die Vergleichs-Anlage DENSELBEN Speicher hat und ihn nur
  // stur fährt; „Ohne Steuerung" las sich wie „ohne Speicher" und wäre eine
  // andere Zahl. Die jsdom-Zwillinge (`src/steuerungFormel.test.ts`,
  // `src/components/SteuerungFormel.test.tsx`) wurden damals mitgezogen, diese
  // Zeile nicht — sie stand seither rot.
  await expect(body).toContainText('Ohne smarte Steuerung');
  await expect(body).toContainText('Mit Steuerung');
  await expect(body).toContainText('Beitrag der Steuerung');
  await expect(body).toContainText('Bezugspreis');
  await expect(body).toContainText('Einspeisepreis');
  await expect(body).toContainText('voll aus dem Markt');
  await expect(body).toContainText('reine Kassenrechnung');
  // Das Bestandskonto wird VERWIESEN, nicht wiederholt.
  await expect(body).toContainText('steht in der Zeile darunter');
  await expect(body).not.toContainText('Planwert');

  expect((await details.boundingBox())!.height).toBeGreaterThan(zu);
});

test('jede Tarif-Lage sagt ihre eigene Wahrheit, keine erfundene Zahl', async ({ page }) => {
  await page.goto(PAGE);
  for (const fall of ['dv', 'fest', 'ohne', 'portfolio']) {
    await page.locator(`[data-fall="${fall}"] details.vp-formel summary`).click();
  }
  await expect(page.locator('[data-fall="fest"] .vp-formel-body')).toContainText(
    'Ihr fester Stromtarif: 30,0',
  );
  await expect(page.locator('[data-fall="ohne"] .vp-formel-body')).toContainText(
    'kein Stromtarif hinterlegt',
  );
  await expect(page.locator('[data-fall="portfolio"] .vp-formel-body')).toContainText(
    'Der Stromtarif der jeweiligen Anlage.',
  );
});

test('kein horizontaler Überlauf — zugeklappt wie aufgeklappt', async ({ page }) => {
  await page.goto(PAGE);
  const ueberlauf = async () =>
    page.evaluate(() => {
      const doc = document.documentElement;
      const raus: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)) {
          raus.push(`${el.tagName}.${el.className}`);
        }
      }
      return { scrollX: doc.scrollWidth - doc.clientWidth, raus: raus.slice(0, 5) };
    });

  expect(await ueberlauf()).toEqual({ scrollX: 0, raus: [] });

  for (const fall of ['dv', 'fest', 'ohne', 'portfolio', 'schiene']) {
    await page.locator(`[data-fall="${fall}"] details.vp-formel summary`).click();
  }
  expect(await ueberlauf()).toEqual({ scrollX: 0, raus: [] });
});

test('die schmale Cockpit-Schiene bricht einspaltig um — nicht das Fenster entscheidet', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await page.locator('[data-fall="schiene"] details.vp-formel summary').click();
  await page.locator('[data-fall="dv"] details.vp-formel summary').click();

  const spalten = (sel: string) =>
    page
      .locator(`${sel} .vp-formel-zeile`)
      .first()
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);

  // Dieselbe Fensterbreite, zwei verschiedene Wirte: die BREITE entscheidet.
  expect(await spalten('[data-fall="schiene"]')).toBe(1);
  expect(await spalten('[data-fall="dv"]')).toBe(2);
});
