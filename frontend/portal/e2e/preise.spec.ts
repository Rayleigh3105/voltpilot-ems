import { test, expect, type Page } from '@playwright/test';

/**
 * Die Preis-Seite (Konzept „Preise und Wetter", Fassung 3, Entscheide E1–E8 = A
 * vom 20.10.2026) im echten Browser: die Antwort steht oben, die Jetzt-Marke im
 * Bild, ein Tipp wählt eine Viertelstunde, Rückblick und Erklärung sind Blätter.
 * Bei 375 und 1440 px: kein Überlauf, nichts ragt heraus, keine Fehler.
 */
async function oeffnen(page: Page, width: number, fall: string, uhr: Date) {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(uhr);
  await page.goto(`/e2e/preise.html?fall=${fall}`);
  await expect(page.locator('.vp-pz-antwort')).toBeVisible();
  await expect(page.locator('.vp-pz-bild svg')).toBeVisible();
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
  test(`Preise bei ${width} px: Antwort zuerst, Jetzt im Bild, Tippen und Blätter`, async ({ page }) => {
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') fehler.push(m.text());
    });
    await oeffnen(page, width, 'normal', new Date(2026, 9, 20, 13, 45));

    // Regel 1: die Antwort steht vor dem Bild, und davor steht keine Bedienung.
    const antwort = page.locator('.vp-pz-antwort');
    await expect(antwort).toContainText('Börsenpreis · jetzt 13:45');
    await expect(antwort.locator('.vp-pz-stufe')).toBeVisible();
    const obenAntwort = (await antwort.boundingBox())!.y;
    const obenBild = (await page.locator('.vp-pz-bild').boundingBox())!.y;
    expect(obenAntwort).toBeLessThan(obenBild);
    expect(await page.locator('.vp-zeitleiste').count()).toBe(0);

    // Regel 2: die Jetzt-Marke steht im ersten Bildschirm.
    const pille = page.locator('.vp-pz-jetzt rect');
    const p = (await pille.boundingBox())!;
    expect(p.y + p.height).toBeLessThan(900);

    // Die Kacheln schauen nach vorn und markieren ihr Fenster.
    const teuer = page.getByRole('button', { name: /Am teuersten/ });
    await expect(teuer).toContainText('morgen');
    await teuer.click();
    await expect(antwort).toContainText('Am teuersten · 2 Std');
    await antwort.getByRole('button', { name: /Jetzt/ }).click();
    await expect(antwort).toContainText('Börsenpreis · jetzt 13:45');

    // Eine Viertelstunde wählen: am Rechner per Klick, die Pfeile gehen weiter.
    const bild = page.locator('.vp-pz-bild');
    const b = (await bild.boundingBox())!;
    await bild.click({ position: { x: b.width * 0.85, y: b.height * 0.5 } });
    await expect(antwort).toContainText('Mi 21.10.');
    await antwort.getByRole('button', { name: '15 Minuten später' }).click();
    await antwort.getByRole('button', { name: /Jetzt/ }).click();
    await expect(antwort).toContainText('Börsenpreis · jetzt 13:45');

    await ohneUeberlauf(page);

    // Rückblick als Blatt; Escape schließt und gibt den Fokus zurück.
    const rueck = page.getByRole('button', { name: /Rückblick/ });
    await rueck.click();
    const blatt = page.getByRole('dialog');
    await expect(blatt.getByRole('tab', { name: 'Woche' })).toHaveAttribute('aria-selected', 'true');
    await blatt.getByRole('tab', { name: 'Jahr' }).click();
    await expect(blatt.getByRole('tab', { name: 'Jahr' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(rueck).toBeFocused();

    expect(fehler).toEqual([]);
  });

  test(`Preise bei ${width} px: ohne Folgetag, unter null und flach bleibt alles ehrlich`, async ({ page }) => {
    await oeffnen(page, width, 'normal', new Date(2026, 9, 20, 9, 30));
    await expect(page.locator('.vp-pz-bild svg')).toContainText('ab ca. 13 Uhr');
    await ohneUeberlauf(page);

    await oeffnen(page, width, 'negativ', new Date(2026, 9, 20, 12, 15));
    await expect(page.locator('.vp-pz-antwort .vp-pz-stufe')).toHaveText('unter null');
    await expect(page.locator('.vp-pz-legende')).toContainText('unter null');
    await ohneUeberlauf(page);

    await oeffnen(page, width, 'flach', new Date(2026, 9, 20, 10, 0));
    await expect(page.locator('.vp-pz-antwort')).toContainText('höchstens');
    await expect(page.locator('.vp-pz-kachel')).toHaveCount(0);
    await ohneUeberlauf(page);
  });
}
