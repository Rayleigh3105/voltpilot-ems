import { expect, test, type Page } from '@playwright/test';

/**
 * Kunden-Alarmierung P4 („Ruhe statt Flut, eine Aussage“) im Browser, je Kundenart bei 375 und 1440 px: jede Meldung
 * nennt ihren Zustellstand („Gemeldet: E-Mail 12:34 · Push 12:34“, ehrlich „Nicht gesendet: …“, „beruhigt“), ein
 * ausgefallener Weg steht als Karte in „Jetzt“ und in „Einstellen“. Kein Querlauf, keine Konsolenfehler. Derselbe
 * Harness wie P3 (`meldungen-ein-ort.tsx`, fester Datenstand, kein Server); die Fotos für den PR schreibt
 * `MELDUNGEN_FOTOS=<Ordner>` dazu.
 */
const FOTOS = process.env.MELDUNGEN_FOTOS;

async function oeffnen(page: Page, kunde: 'privat' | 'unternehmen', reiter: string, breite: number, ausfall = false) {
  const fehler: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/meldungen-ein-ort.html?kunde=${kunde}&reiter=${reiter}${ausfall ? '&ausfall=1' : ''}`);
  await expect(page.getByRole('heading', { name: 'Meldungen', level: 1 })).toBeVisible();
  return fehler;
}

async function foto(page: Page, name: string) {
  if (FOTOS) await page.screenshot({ path: `${FOTOS}/${name}.png`, fullPage: true });
}

const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const breite of [375, 1440] as const) {
  test(`Jetzt: Zustellstand an jeder Karte, Ausfall der E-Mail (privat, ${breite}px)`, async ({ page }) => {
    const fehler = await oeffnen(page, 'privat', 'jetzt', breite, true);
    await expect(page.getByTestId('meldung-zustellung')).toHaveText('E-Mail nicht zugestellt');
    await expect(page.getByTestId('leise-zustellung')).toHaveText('Nicht gesendet: kein Weg eingeschaltet');
    await expect(page.getByTestId('weg-ausfall')).toContainText('E-Mails kommen nicht an');
    await expect(page.getByTestId('weg-ausfall')).toContainText('sommer@voltpilot.local');
    await page.waitForTimeout(300);
    await foto(page, `p4-privat-jetzt-ausfall-${breite}`);
    expect(await ueberlauf(page)).toBe(0);

    await page.getByRole('button', { name: 'Wege einstellen' }).click();
    await expect(page.getByTestId('so-erreichen-wir-sie')).toBeVisible();
    await expect(page.getByTestId('weg-ausfall')).toContainText('E-Mails kommen nicht an');
    await expect(page.getByTestId('weg-ausfall').getByRole('button')).toHaveCount(0);
    await page.waitForTimeout(300);
    await foto(page, `p4-privat-einstellen-ausfall-${breite}`);
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  test(`Jetzt: gemeldet und beruhigt, Push-Gerät abgemeldet (unternehmen, ${breite}px)`, async ({ page }) => {
    const fehler = await oeffnen(page, 'unternehmen', 'jetzt', breite, true);
    const stand = page.getByTestId('meldung-zustellung');
    await expect(stand).toHaveCount(2);
    await expect(stand.first()).toHaveText(/^Gemeldet: E-Mail \d\d:\d\d · Push \d\d:\d\d$/);
    await expect(stand.nth(1)).toContainText('falls noch aktuell (beruhigt)');
    await expect(page.getByTestId('weg-ausfall')).toContainText('Push auf „iPad Leitstand“ ist abgemeldet');
    await page.waitForTimeout(300);
    await foto(page, `p4-unternehmen-jetzt-${breite}`);
    expect(await ueberlauf(page)).toBe(0);
    expect(fehler).toEqual([]);
  });

  for (const kunde of ['privat', 'unternehmen'] as const) {
    test(`Verlauf: Zustellstand mit Entwarnung (${kunde}, ${breite}px)`, async ({ page }) => {
      const fehler = await oeffnen(page, kunde, 'verlauf', breite);
      await expect(page.getByTestId('meldung-zustellung')).toContainText(/^Gemeldet: E-Mail .* · Entwarnung: E-Mail /);
      await foto(page, `p4-${kunde}-verlauf-${breite}`);
      expect(await ueberlauf(page)).toBe(0);
      expect(fehler).toEqual([]);
    });
  }

  test(`ohne Ausfall keine Karte (privat, ${breite}px)`, async ({ page }) => {
    const fehler = await oeffnen(page, 'privat', 'jetzt', breite);
    await expect(page.getByTestId('meldung-zustellung')).toHaveText(/^Gemeldet: E-Mail \d\d:\d\d$/);
    await expect(page.getByTestId('weg-ausfall')).toHaveCount(0);
    expect(fehler).toEqual([]);
  });
}
