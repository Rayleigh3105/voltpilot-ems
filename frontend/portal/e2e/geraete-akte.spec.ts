import { expect, test, type Page } from '@playwright/test';

/**
 * Mobil-Durchgang Geräteakte (`vp-adminview-mobile-rework`): 390 px ist die
 * Haupt-Breite des Auftrags, 768 px die Stichprobe, 1440 px die
 * Regressionsprobe (Desktop darf nicht schlechter werden als vorher).
 */
const PHONE = 390;
const TABLET = 768;
const DESKTOP = 1440;

function wache(page: Page): string[] {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => m.type() === 'error' && fehler.push(m.text()));
  return fehler;
}

/** Kein waagerechter Überlauf der Seite selbst (die Reiterleiste darf in sich scrollen). */
async function keinUeberlauf(page: Page) {
  const breite = await page.evaluate(() => document.documentElement.clientWidth);
  const ueberlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(ueberlauf, `Seite läuft bei ${breite}px über`).toBeLessThanOrEqual(1);
}

test.describe('Geräteakte bei 390 px: Reiterleiste', () => {
  test('die Reiterleiste klebt am Telefon unter dem Kopf und zentriert den gewählten Reiter', async ({ page }) => {
    const fehler = wache(page);
    await page.setViewportSize({ width: PHONE, height: 844 });
    await page.goto('/e2e/geraete-akte.html?reiter=anlage');
    const reiter = page.getByTestId('akte-reiter');
    await expect(reiter).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Anlage' })).toHaveAttribute('aria-selected', 'true');

    // Der gewählte Reiter ist VOLL innerhalb der Leiste zu sehen - nicht an der Kante abgeschnitten
    // (genau das war der Befund auf `edge-a1`: „Anlage" stand zur Hälfte hinter dem rechten Rand).
    const sicht = await page.evaluate(() => {
      const leiste = document.querySelector<HTMLElement>('[data-testid="akte-reiter"]')!.getBoundingClientRect();
      const aktiv = document.querySelector<HTMLElement>('[data-testid="akte-reiter"] [aria-selected="true"]')!.getBoundingClientRect();
      return { linksOk: aktiv.left >= leiste.left - 1, rechtsOk: aktiv.right <= leiste.right + 1 };
    });
    expect(sicht.linksOk).toBe(true);
    expect(sicht.rechtsOk).toBe(true);

    // Position: sticky unter der 68px-Kopfzeile - bleibt nach dem Scrollen im Bild. Die
    // Raum-Reiterleiste (Geräte/Software/Werkstatt/Fernwartung, #1762) UND der Seitenkopf
    // müssen dafür erst vorbeigescrollt sein - 800 px ist genug, aber noch innerhalb des Reiters.
    await page.evaluate(() => window.scrollTo(0, 800));
    await expect(reiter).toBeInViewport();
    const top = await reiter.evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.round(top)).toBe(68);

    await keinUeberlauf(page);
    expect(fehler).toEqual([]);
  });

  test('am Rechner bleibt die Reiterleiste im normalen Fluss (keine Verschlechterung)', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP, height: 900 });
    await page.goto('/e2e/geraete-akte.html?reiter=anlage');
    const reiter = page.getByTestId('akte-reiter');
    await expect(reiter).toBeVisible();
    const position = await reiter.evaluate((el) => getComputedStyle(el).position);
    expect(position).toBe('static');
    await keinUeberlauf(page);
  });
});

test.describe('Geräteakte: einklappbare Sektionen mit Urteilszeile (Anlage, Software)', () => {
  test('Reiter „Anlage" bei 390 px: Plan/Pflege-Hinweise/Komponenten-Fassung/Werkzeuge beginnen zu, mit Urteil', async ({ page }) => {
    await page.setViewportSize({ width: PHONE, height: 844 });
    await page.goto('/e2e/geraete-akte.html?reiter=anlage');
    await page.waitForSelector('[data-testid="geraete-akte"]');

    // Primäre Sektionen bleiben offen (nicht hinter einem Klick versteckt).
    await expect(page.getByText('Not-Aus auf dem Gerät gesetzt.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zurücknehmen' })).toBeVisible();

    // Sekundäre Sektionen beginnen ZU, tragen aber die Urteilszeile sichtbar.
    const plan = page.locator('details', { hasText: 'Plan' }).first();
    await expect(plan).not.toHaveAttribute('open', '');
    await expect(plan).toContainText('vor 10 Min.');
    const pflege = page.locator('details', { hasText: 'Pflege-Hinweise' });
    await expect(pflege).toContainText('2 Hinweise');
    const komponenten = page.locator('details', { hasText: 'Komponenten-Fassung' });
    await expect(komponenten).toContainText('Unbekannt');

    // Antippen öffnet sie - der Inhalt ist nicht verloren, nur zu Beginn weggeklappt.
    await plan.locator('summary').click();
    await expect(plan).toHaveAttribute('open', '');
    await expect(plan).toContainText('Letzter Lauf des Optimierers');

    await keinUeberlauf(page);
  });

  // 768 px liegt ÜBER der Telefon-Grenze (`useIsPhone.ts`: <=720px) - hier gilt
  // bewusst die Rechner-Fassung (offene Karten), die Stichprobe prüft nur,
  // dass dabei nichts überläuft oder bricht.
  test('Reiter „Anlage" bei 768 px (Stichprobe): offene Karten wie am Rechner, kein Überlauf', async ({ page }) => {
    await page.setViewportSize({ width: TABLET, height: 1024 });
    await page.goto('/e2e/geraete-akte.html?reiter=anlage');
    await page.waitForSelector('[data-testid="geraete-akte"]');
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pflege-Hinweise' })).toBeVisible();
    await keinUeberlauf(page);
  });

  test('Reiter „Software" bei 390 px: Vertrauen/Update-Verlauf beginnen zu, mit Urteil', async ({ page }) => {
    await page.setViewportSize({ width: PHONE, height: 844 });
    await page.goto('/e2e/geraete-akte.html?reiter=software');
    await page.waitForSelector('[data-testid="geraete-akte"]');

    // Primär: Linie/Stand und die Aktualisieren-Karte bleiben offen.
    await expect(page.getByText('Läuft · meldet die Box')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aktualisieren', exact: true }).last()).toBeVisible();

    const vertrauen = page.locator('details', { hasText: 'Vertrauen' });
    await expect(vertrauen).not.toHaveAttribute('open', '');
    await expect(vertrauen).toContainText('unbekannt');
    const verlauf = page.locator('details', { hasText: 'Update-Verlauf' });
    await expect(verlauf).toContainText('2 Einträge');

    await keinUeberlauf(page);
  });

  test('am Rechner (1440 px) bleiben dieselben Sektionen offene Karten wie vorher (keine Verschlechterung)', async ({ page }) => {
    await page.setViewportSize({ width: DESKTOP, height: 900 });
    await page.goto('/e2e/geraete-akte.html?reiter=anlage');
    await page.waitForSelector('[data-testid="geraete-akte"]');
    // Keine `details`/Aufklapper am Rechner - alles bleibt die offene Karte mit Überschrift.
    await expect(page.locator('details')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Plan' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pflege-Hinweise' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Komponenten-Fassung' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Werkzeuge' })).toBeVisible();
    await keinUeberlauf(page);
  });
});

test.describe('„Vom Kunden lösen" (L1/L2/N8, vp-plattform-admin-box-benutzer-konzept)', () => {
  for (const breite of [DESKTOP, PHONE]) {
    test(`bei ${breite} px: Karte, Menü, Dialog - keine Fernwartung/Aktualisieren für eine nie gemeldete Box`, async ({ page }) => {
      const fehler = wache(page);
      await page.setViewportSize({ width: breite, height: breite === PHONE ? 844 : 900 });
      await page.goto('/e2e/geraete-akte.html?szenario=nie-gemeldet');
      await page.waitForSelector('[data-testid="geraete-akte"]');

      // N8: eine nie gemeldete Box hat weder einen Tunnel noch einen Software-Stand zu öffnen.
      await expect(page.getByRole('button', { name: 'Fernwartung öffnen' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Aktualisieren', exact: true })).toHaveCount(0);

      // Die Kopf-Karte nennt den Zustand und bietet „Vom Kunden lösen …" an.
      const karte = page.getByTestId('akte-nie-gemeldet');
      await expect(karte).toBeVisible();
      await expect(karte).toContainText('Verbunden, aber nie gemeldet');
      await expect(karte).toContainText('Herzschlag nie');

      // Zweiter Einstieg: das Menü „⋯" trägt denselben Eintrag (B4 = A).
      await page.getByRole('button', { name: 'Weitere Handlungen' }).click();
      await expect(page.getByRole('menuitem', { name: 'Vom Kunden lösen …' })).toBeVisible();
      await page.keyboard.press('Escape');

      await karte.getByRole('button', { name: 'Vom Kunden lösen …' }).click();
      const dialog = page.getByRole('dialog', { name: 'Vom Kunden lösen' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('Hat sich nie gemeldet');
      await expect(dialog).toContainText('edge-cyhchfr');

      // Ohne Anlass bleibt der Knopf wirkungslos (kein Absturz, keine Anfrage ohne Anlass).
      const bestaetigen = dialog.getByRole('button', { name: 'Vom Kunden lösen', exact: true });
      await bestaetigen.click();
      await expect(dialog).toBeVisible();

      await dialog.getByLabel('Anlass').click();
      await page.getByRole('option', { name: 'Falsche Kennung verbunden' }).click();
      await bestaetigen.click();
      // Erfolg: der Dialog schließt sich (die Box ist weg, die Akte navigiert zur Geräte-Liste).
      await expect(dialog).toBeHidden();

      await keinUeberlauf(page);
      expect(fehler).toEqual([]);
    });
  }
});
