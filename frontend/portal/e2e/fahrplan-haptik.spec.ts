import { expect, test, type Page } from '@playwright/test';
import { HAPTIK_ABSTAND_MS } from '../src/haptik';

/**
 * **Haptik der Fahrplan-Seite im echten Browser** (Wunsch vom 24.09.2026: „für
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
  await vergessen(page);
}

test('am Telefon gibt jede Bedienstelle ihren Impuls - auch bei festgehaltener Wanduhr', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.hasTouch, 'nur mit Berührung');
  await oeffnen(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'der Browser meldet Berührung').toBe(true);

  const schritt = async (tun: () => Promise<void>, erwartet: unknown[]) => {
    // Zwei Impulse binnen HAPTIK_ABSTAND_MS schluckt `haptik.ts` mit Absicht.
    // `expect.poll` sieht den vorigen Impuls oft schon nach wenigen ms - ohne
    // diese Pause fiel der nächste Tipp (Gestern → Heute) in die Sperre.
    await page.waitForTimeout(HAPTIK_ABSTAND_MS + 15);
    await vergessen(page);
    await tun();
    await expect.poll(() => gespielt(page)).toEqual(erwartet);
  };
  const schliessen = () => page.getByRole('dialog').getByRole('button', { name: 'Schließen' }).first().tap();

  // Die Uhr am Telefon (das Tablet zeigt ab 900 px Inhaltsbreite das Tagesband).
  const uhr = page.getByRole('group', { name: /^Die Uhr/ });
  if (await uhr.count()) {
    // Ein Bogen der Uhr: ein Tick, dann das Warum seiner Phase. Getippt wird
    // auf sein Symbol - die Mitte seines Umrisses läge auf dem Zifferblatt.
    await schritt(() => uhr.getByRole('button').filter({ has: page.locator('svg') }).first().locator('svg').first().tap(), [TICK]);
    await schliessen();
  }
  // Die Status-Zeile öffnet das Warum: ein Tick.
  await schritt(() => page.locator('button.vp-tb-status').tap(), [TICK]);
  await schliessen();
  // Eine Kachel: das Ziel-Muster.
  await schritt(() => page.getByRole('list', { name: 'Antworten zum Fahrplan' }).getByRole('button').first().tap(), [ZIEL]);
  // Ein eingeklappter Abschnitt am Telefon: ein Tick.
  const ihrTag = page.getByRole('button', { name: 'Ihr Tag' });
  if (await ihrTag.count()) await schritt(() => ihrTag.tap(), [TICK]);

  // Der Tagesschalter (E2) ist eine Bedienstelle wie jede andere: ein Tick.
  await schritt(() => page.getByRole('tab', { name: /^Gestern/ }).tap(), [TICK]);
  await schritt(() => page.getByRole('tab', { name: /^Heute/ }).tap(), [TICK]);
  await expect(page.locator('button.vp-tb-status')).toBeVisible();
});

test('mit der Maus vibriert nichts', async ({ page }, testInfo) => {
  test.skip(!!testInfo.project.use.hasTouch, 'nur ohne Berührung');
  await oeffnen(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);

  // Ab 900 px Inhaltsbreite das Tagesband: ein Klick wählt eine Viertelstunde,
  // „Zurück zu jetzt" holt die Gegenwart zurück.
  const band = page.getByRole('slider', { name: /Tagesband/ });
  await page.getByRole('list', { name: 'Antworten zum Fahrplan' }).getByRole('button').first().click();
  const box = (await band.boundingBox())!;
  await band.click({ position: { x: box.width * 0.85, y: box.height / 2 } });
  await expect(page.getByRole('button', { name: 'Zurück zu jetzt' })).toBeVisible();
  await page.getByRole('button', { name: 'Zurück zu jetzt' }).click();
  await expect(page.getByRole('button', { name: 'Zurück zu jetzt' })).toHaveCount(0);

  expect(await gespielt(page)).toEqual([]);
});
