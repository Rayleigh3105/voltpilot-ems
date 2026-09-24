import { expect, test, type Page } from '@playwright/test';

/**
 * **Haptik der Tagesuhr im echten Browser** (Wunsch vom 24.09.2026: „für
 * Handy auch Vibrationshaptik").
 *
 * Die Unit-Tests prüfen jede Bedienstelle in jsdom. Hier geht es um das, was
 * jsdom nicht kann: ein echter Finger erzeugt Zeiger-Ereignisse der Art
 * `touch`, der Browser meldet `(pointer: coarse)`, und der Mindestabstand der
 * Impulse misst mit der monotonen Uhr. Mit der Wanduhr bliebe bei
 * festgehaltener Zeit (wie hier und in allen Wächtern) nach dem ersten Impuls
 * alles still - genau so ist es beim ersten Versuch gewesen.
 *
 * `navigator.vibrate` wird aufgezeichnet, nicht ausgeführt. Nur Chromium: das
 * ist der Android-Weg. Safari kennt `navigator.vibrate` nicht; dort spielt
 * `haptik.ts` den Impuls eines Schalters, und den spürt nur ein iPhone.
 */

const FAHRPLAN = '/e2e/help.html#/anlage/help-site/fahrplan';
const TICK = 8;
const ZIEL = 14;
const JETZT = [6, 45, 10];

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });
test.skip(({ browserName }) => browserName !== 'chromium', 'navigator.vibrate gibt es nur in Chromium (Android)');

type MitImpulsen = { __impulse: unknown[] };

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
  await page.addInitScript(() => {
    const w = window as unknown as MitImpulsen;
    w.__impulse = [];
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (muster: unknown) => {
        w.__impulse.push(muster);
        return true;
      },
    });
  });
});

const gespielt = (page: Page) => page.evaluate(() => (window as unknown as MitImpulsen).__impulse);
const vergessen = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as MitImpulsen).__impulse = [];
  });

async function oeffnen(page: Page) {
  await page.goto(FAHRPLAN);
  await page.locator('.vp-tb').first().waitFor();
  // Die Einführung beim ersten Besuch (E11) beendet der Test wie ein Kunde.
  const beenden = page.getByRole('button', { name: 'Beenden' });
  if (await beenden.count()) await beenden.first().click();
  await vergessen(page);
}

/** Ein Punkt der Uhr: Stunde (Mitternacht unten, im Uhrzeigersinn) und Radius in Einheiten der viewBox. */
async function aufDerUhr(page: Page, stunde: number, radius: number) {
  const svg = page.locator('.vp-uhr-svg');
  await svg.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const box = (await svg.boundingBox())!;
  const k = box.width / (await svg.evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.width));
  const winkel = ((90 + stunde * 15) * Math.PI) / 180;
  return {
    x: box.x + box.width / 2 + Math.cos(winkel) * radius * k,
    y: box.y + box.height / 2 + Math.sin(winkel) * radius * k,
  };
}

test('am Telefon gibt jede Bedienstelle der Uhr ihren Impuls - auch bei festgehaltener Wanduhr', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'nur mit Berührung');
  await oeffnen(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'der Browser meldet Berührung').toBe(true);
  const uhr = page.getByRole('slider', { name: /Tagesuhr/ });
  await expect(uhr).toHaveAttribute('aria-valuetext', /^Jetzt/);

  const schritt = async (tun: () => Promise<void>, erwartet: unknown[]) => {
    await vergessen(page);
    await tun();
    await expect.poll(() => gespielt(page)).toEqual(erwartet);
  };

  await schritt(() => page.getByRole('button', { name: /^Sonne/ }).tap(), [TICK]);
  await schritt(() => page.getByRole('button', { name: /Wie geht es weiter\?/ }).tap(), [ZIEL]);
  await expect(uhr).not.toHaveAttribute('aria-valuetext', /^Jetzt/);
  await schritt(() => page.getByRole('button', { name: 'Zurück zu jetzt' }).first().tap(), [JETZT]);
  await expect(uhr).toHaveAttribute('aria-valuetext', /^Jetzt/);

  // Mitten auf die Ringe, in eine andere Phase: ein Tick. Dann die Mitte: zurück zu jetzt.
  const abends = await aufDerUhr(page, 21, 150);
  await schritt(() => page.touchscreen.tap(abends.x, abends.y), [TICK]);
  await expect(uhr).toHaveAttribute('aria-valuetext', /^21:00 Uhr/);
  const mitte = await aufDerUhr(page, 0, 0);
  await schritt(() => page.touchscreen.tap(mitte.x, mitte.y), [JETZT]);
  await expect(uhr).toHaveAttribute('aria-valuetext', /^Jetzt/);
});

test('mit der Maus vibriert nichts', async ({ page }, testInfo) => {
  test.skip(!!testInfo.project.use.hasTouch, 'nur ohne Berührung');
  await oeffnen(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);

  await page.getByRole('button', { name: /Wie geht es weiter\?/ }).click();
  const bild = page.getByRole('slider', { name: /Tagesuhr|Bildfahrplan/ });
  await expect(bild).not.toHaveAttribute('aria-valuetext', /^Jetzt/);
  await page.getByRole('button', { name: 'Zurück zu jetzt' }).first().click();
  await expect(bild).toHaveAttribute('aria-valuetext', /^Jetzt/);
  const box = (await bild.boundingBox())!;
  await bild.click({ position: { x: box.width * 0.85, y: box.height / 2 } });
  await expect(bild).not.toHaveAttribute('aria-valuetext', /^Jetzt/);

  expect(await gespielt(page)).toEqual([]);
});
