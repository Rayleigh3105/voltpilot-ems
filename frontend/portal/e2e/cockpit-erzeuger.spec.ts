import { expect, test, type Page } from '@playwright/test';

/**
 * Das Cockpit einer Erzeugeranlage an einer Anlagensteuerung (Konzept „Erzeuger am WAGO-Modbus-Server“,
 * Paket EZ-8, Entscheid EW-11 A): kein neuer Reiter - Status oben, Bühne mit Erzeugung · Netz · Hof, die
 * Steuerzeile als Kette Netzbetreiber › Direktvermarkter › Anlage mit dem Blatt „Steuerung jetzt“, die
 * Spuren der Vorgaben in der Tagesleiste und die Kacheln „Motoren“ und „Wer hat heute geregelt?“.
 * Echtes Portal auf den fiktiven Hilfe-Fixtures (`?erzeuger=buettner|gore`). GEMESSEN: Ort, Inhalt,
 * „—“ statt 0 ohne Netzpunkt (EW-16 C), Tippziele, kein Überlauf, Konsole sauber.
 */
const COCKPIT = (fall: 'buettner' | 'gore') => `/e2e/help.html?erzeuger=${fall}#/anlage/help-site`;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffnen(page: Page, fall: 'buettner' | 'gore') {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
  await page.goto(COCKPIT(fall));
  await page.locator('.vp-steuer').waitFor();
  return fehler;
}

const text = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => (el.textContent ?? '').replace(/[\u00a0\u202f]/g, ' '));

const ueberlauf = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('am Rechner (Biogas): Vorgaben oben, Kette rechts unter dem Börsenpreis, Netz und Hof „—“', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fehler = await oeffnen(page, 'buettner');
  await expect(page.getByTestId('erzeuger-status-nb')).toHaveText('Netzbetreiber begrenzt 60 %');
  await expect(page.getByTestId('erzeuger-status-dv')).toHaveText('Direktvermarkter ruft ab');

  const zeile = page.locator('.vp-hero-side .vp-hero-steuer .vp-steuer');
  await expect(zeile).toBeVisible();
  expect(await text(page, '.vp-steuer-kette')).toBe('Netzbetreiber 60 %›Direktvermarkter 80,0 kW›Anlage 58,9 kWDaten 3 s alt');
  await expect(zeile.locator('.vp-steuer-hinweis')).toHaveText('NB strenger');

  expect(await text(page, '.vp-eb-satz')).toBe('Der Netzbetreiber begrenzt die Anlage auf 60 %. Sie erzeugt 58,9 kW.');
  await expect(page.getByRole('button', { name: /^Netz: —, ohne Messung$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Hof: —, Hof$/ })).toBeVisible();
  await expect(page.locator('.vp-tl-vorgabe')).toHaveCount(2);

  await expect(page.locator('[data-kachel="einheiten"]')).toContainText('Gasspeicher');
  await expect(page.locator('[data-kachel="geregelt"]')).toContainText('Netzbetreiber');
  expect(await text(page, '[data-kachel="geld"]')).toContain('—Erlöse für Biogas folgen');

  await zeile.getByRole('button', { name: /Warum\?/ }).click();
  const blatt = page.getByRole('dialog', { name: 'Steuerung jetzt' });
  await expect(blatt).toBeVisible();
  const inhalt = await blatt.evaluate((el) => (el.textContent ?? '').replace(/[\u00a0\u202f]/g, ' '));
  expect(inhalt).toContain('Netz Musterstadt GmbH · Stufe 60 % · seit 10:48');
  expect(inhalt).toContain('Stadtwerke Beispiel · Abruf seit 09:21 · bereit ✓');
  expect(inhalt).toContain('59,4 kW – der Netzbetreiber ist strenger als der Direktvermarkter');
  expect(inhalt).toContain('Netzbetreiber 2× · Direktvermarkter 1×');
  await blatt.getByRole('button', { name: /Zur Steuerung/ }).click();
  await expect(blatt).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('/steuerung');
  expect(await ueberlauf(page)).toBe(0);
  expect(fehler).toEqual([]);
});

test.describe('am Telefon', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('Biogas: Statuszeile oben, Kette am Bühnenfuß in Kurzform, Tippziel ≥ 44 px, kein Überlauf', async ({ page }) => {
    const fehler = await oeffnen(page, 'buettner');
    await expect(page.locator('.vp-anlage-chipzeile')).toContainText('Netzbetreiber begrenzt 60 %');
    const zeile = page.locator('.vp-stage-foot .vp-steuer');
    await expect(zeile).toBeVisible();
    await expect(page.locator('.vp-hero-side')).toHaveCount(0);
    expect(await zeile.locator('.vp-steuer-kette').evaluate((el) =>
      // Sichtbar ist die Kurzform; die ganzen Wörter stehen nur für den Bildschirmleser darin.
      [...el.querySelectorAll('.vp-steuer-glied')].map((g) => {
        const sichtbar = g.cloneNode(true) as HTMLElement;
        sichtbar.querySelectorAll('.vp-sr-only').forEach((x) => x.remove());
        return (sichtbar.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ').trim();
      }),
    )).toEqual(['NB 60 %', 'DV 80,0 kW', 'Anlage 58,9 kW']);
    const knopf = await zeile.getByRole('button', { name: /Warum\?/ }).boundingBox();
    expect(knopf?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(await ueberlauf(page)).toBe(0);
    await zeile.getByRole('button', { name: /Warum\?/ }).tap();
    await expect(page.getByRole('dialog', { name: 'Steuerung jetzt' })).toBeVisible();
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test('PV: Leitstelle getrennt als Warnung, gehaltene Vorgabe in der Kette, Verbrauch = Erzeugung + Netzpunkt', async ({ page }) => {
    const fehler = await oeffnen(page, 'gore');
    await expect(page.getByTestId('erzeuger-status-leitstelle')).toHaveText('Leitstelle getrennt');
    const zeile = page.locator('.vp-stage-foot .vp-steuer');
    await expect(zeile.locator('.vp-steuer-hinweis')).toHaveText('1 Hinweis');
    expect(await text(page, '.vp-steuer-glied.tone-warn')).toBe('NB 100 % (gehalten)Netzbetreiber 100 % (gehalten)');
    expect(await text(page, '.vp-eb-satz')).toBe('Die Anlage begrenzt sich selbst: Am Netzpunkt fließt nichts ins Netz.');
    await expect(page.getByRole('button', { name: /^Verbrauch: 41,1 kW/ })).toBeVisible();
    await expect(page.locator('[data-kachel="einheiten"]')).toContainText('Wechselrichter 3');
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });
});
