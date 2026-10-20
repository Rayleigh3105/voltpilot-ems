import { test, expect, type Page } from '@playwright/test';

/**
 * Die Wetter-Seite (Konzept „Preise und Wetter", Fassung 3, E5 = A „Wetter
 * zuerst") im echten Browser: Wetter oben, drei Tage als Karten, ein Bild mit
 * Jetzt-Linie, gemessen und erwartet getrennt, Stunden im Blatt bzw. daneben.
 * Bei 375 und 1440 px: kein Überlauf, nichts ragt heraus, keine Fehler.
 */
async function oeffnen(page: Page, width: number, fall: string, uhr: Date) {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(uhr);
  await page.goto(`/e2e/wetter.html?fall=${fall}`);
  await expect(page.locator('.vp-pz-antwort')).toBeVisible();
  await expect(page.locator('.vp-pz-bild > svg')).toBeVisible();
}

async function ohneUeberlauf(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect(
    await page.locator('main').evaluate((el) =>
      [...el.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length,
    ),
  ).toBe(0);
}

for (const width of [375, 1440]) {
  test(`Wetter bei ${width} px: Wetter zuerst, drei Tage, Jetzt im Bild`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'normal', new Date(2026, 9, 20, 13, 45));

    const antwort = page.locator('.vp-pz-antwort');
    await expect(antwort).toContainText('Wetter am Standort · jetzt 13:45');
    await expect(antwort.locator('.vp-wt-temp')).toContainText('°C');
    await expect(antwort).toContainText('Sonnenstrom jetzt');
    await expect(antwort).toContainText('gemessen');
    const obenAntwort = (await antwort.boundingBox())!.y;
    const obenBild = (await page.locator('.vp-pz-bild').boundingBox())!.y;
    expect(obenAntwort).toBeLessThan(obenBild);

    // Die Jetzt-Marke steht im Bild; gemessen und erwartet stehen in der Legende.
    await expect(page.locator('.vp-pz-bild .vp-pz-jetzt')).toHaveCount(1);
    await expect(page.locator('.vp-pz-legende')).toContainText('gemessen');
    await expect(page.locator('.vp-pz-legende')).toContainText('erwartet');

    // Drei Tage als Karten; „Morgen" wählt das Bild von morgen, ohne Jetzt-Linie.
    const tage = page.getByRole('tablist', { name: 'Tag wählen' });
    await expect(tage.getByRole('tab')).toHaveCount(3);
    await tage.getByRole('tab').nth(1).click();
    await expect(page.getByRole('heading', { name: 'Sonnenstrom morgen' })).toBeVisible();
    await expect(page.locator('.vp-pz-bild .vp-pz-jetzt')).toHaveCount(0);
    await tage.getByRole('tab').nth(2).click();
    await expect(page.locator('.vp-wt-hinweis')).toContainText('reicht noch nicht');
    await tage.getByRole('tab').nth(0).click();

    // Eine Viertelstunde wählen und zurück.
    const bild = page.locator('.vp-pz-bild');
    const b = (await bild.boundingBox())!;
    await bild.click({ position: { x: b.width * 0.8, y: b.height * 0.6 } });
    await expect(antwort).toContainText('heute');
    await expect(antwort).toContainText('erwartet');
    await antwort.getByRole('button', { name: /Jetzt/ }).click();
    await expect(antwort).toContainText('Wetter am Standort · jetzt 13:45');

    await ohneUeberlauf(page);

    if (width < 1024) {
      const knopf = page.getByRole('button', { name: /Stunde für Stunde/ });
      await knopf.click();
      await expect(page.getByRole('dialog')).toContainText('jetzt');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(knopf).toBeFocused();
    } else {
      await expect(page.locator('.vp-wt-tabelle')).toBeVisible();
    }
    expect(fehler).toEqual([]);
  });

  test(`Wetter bei ${width} px: vor Sonnenaufgang und ohne Prognose bleibt alles ehrlich`, async ({ page }) => {
    await oeffnen(page, width, 'normal', new Date(2026, 9, 20, 7, 10));
    await expect(page.locator('.vp-pz-antwort')).toContainText('Sonne ab ca. 8 Uhr');
    await ohneUeberlauf(page);

    await oeffnen(page, width, 'ohne', new Date(2026, 9, 20, 13, 45));
    await expect(page.locator('.vp-wt-hinweis')).toContainText('keine Sonnenstrom-Prognose');
    await expect(page.getByRole('tab').first()).toContainText('Std Sonne');
    await ohneUeberlauf(page);
  });
}
