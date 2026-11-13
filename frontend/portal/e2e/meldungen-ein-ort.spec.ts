import { expect, test, type Page } from '@playwright/test';

/**
 * Kunden-Alarmierung P3 („Ein Ort: Jetzt · Verlauf · Einstellen“, KA-6 A) im Browser, je Kundenart bei 375 und
 * 1440 px: kein Querlauf, keine Konsolenfehler; die Fotos für den PR schreibt `MELDUNGEN_FOTOS=<Ordner>` dazu.
 * Gemessen an der Seite selbst (fester Datenstand, kein Server) - die Glocke der Schale gehört nicht dazu.
 */
const FOTOS = process.env.MELDUNGEN_FOTOS;

async function oeffnen(page: Page, kunde: 'privat' | 'unternehmen', reiter: string, breite: number) {
  const fehler: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  page.on('pageerror', (e) => fehler.push(String(e)));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/meldungen-ein-ort.html?kunde=${kunde}&reiter=${reiter}`);
  await expect(page.getByRole('heading', { name: 'Meldungen', level: 1 })).toBeVisible();
  return fehler;
}

async function foto(page: Page, name: string) {
  if (FOTOS) await page.screenshot({ path: `${FOTOS}/${name}.png`, fullPage: true });
}

const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const breite of [375, 1440] as const) {
  for (const kunde of ['privat', 'unternehmen'] as const) {
    test(`Jetzt: Karten, Leise und erste Einrichtung (${kunde}, ${breite}px)`, async ({ page }) => {
      const fehler = await oeffnen(page, kunde, 'jetzt', breite);
      const karten = page.getByTestId('meldung-karte');
      await expect(karten.first()).toBeVisible();
      await expect(karten.first().getByTestId('meldung-titel')).not.toBeEmpty();
      await expect(page.getByRole('button', { name: 'Gesehen' })).toHaveCount(0);
      if (kunde === 'privat') {
        await expect(page.getByTestId('meldungen-leise')).toContainText('Leise');
        await expect(page.getByTestId('erste-einrichtung-email')).toContainText('sommer@voltpilot.local');
      } else {
        await expect(page.getByTestId('erste-einrichtung')).toHaveCount(0);
        await expect(karten.first()).toContainText('Dringend');
      }
      await page.waitForTimeout(300);
      await foto(page, `${kunde}-jetzt-${breite}`);
      if (kunde === 'unternehmen') {
        await karten.first().getByRole('button', { name: 'Stumm' }).click();
        await expect(page.getByTestId('meldung-stumm')).toBeVisible();
        await foto(page, `${kunde}-jetzt-stumm-${breite}`);
      }
      expect(await ueberlauf(page)).toBe(0);
      expect(fehler).toEqual([]);
    });

    test(`Verlauf: Ende und Dauer (${kunde}, ${breite}px)`, async ({ page }) => {
      const fehler = await oeffnen(page, kunde, 'verlauf', breite);
      await expect(page.getByTestId('meldung-dauer')).toContainText('42 Min.');
      await foto(page, `${kunde}-verlauf-${breite}`);
      expect(await ueberlauf(page)).toBe(0);
      expect(fehler).toEqual([]);
    });

    test(`Einstellen: So erreichen wir Sie, Das melden wir, Eigene Überwachung (${kunde}, ${breite}px)`, async ({ page }) => {
      const fehler = await oeffnen(page, kunde, 'einstellen', breite);
      await expect(page.getByTestId('so-erreichen-wir-sie')).toBeVisible();
      await expect(page.getByTestId('das-melden-wir')).toBeVisible();
      await expect(page.getByTestId('melden-wir-zeile').first()).toContainText('Box meldet sich nicht');
      await foto(page, `${kunde}-einstellen-${breite}`);

      const eigene = page.getByTestId('melden-wir-zeile').filter({ hasText: kunde === 'privat' ? 'Börsenpreis über 5' : 'Netzbezug über 300' });
      await eigene.getByRole('button').first().click();
      await expect(eigene.getByTestId('melden-wir-details')).toContainText('Empfänger');
      await foto(page, `${kunde}-einstellen-zeile-${breite}`);
      await eigene.getByRole('button', { name: 'Ändern' }).click();
      const blatt = page.getByRole('dialog', { name: /^Überwachen: / });
      await expect(blatt).toBeVisible();
      await expect(blatt.getByText('Erst 30 Tage mitzählen, nichts senden')).toBeVisible();
      await blatt.getByTestId('ueberwachen-feineinstellung').click();
      await expect(blatt.getByLabel(/Rückkehr/)).toBeVisible();
      await page.waitForTimeout(500);
      await foto(page, `${kunde}-eigene-ueberwachung-${breite}`);
      await blatt.getByRole('button', { name: 'Speichern' }).click();
      await expect(blatt).toHaveCount(0);
      const anfragen = await page.evaluate(() => (window as unknown as { __anfragen: { methode: string; pfad: string }[] }).__anfragen);
      expect(anfragen.some((a) => a.methode === 'PUT' && /\/regeln\/r-eigen$/.test(a.pfad))).toBe(true);

      // Schalter „Das melden wir“: aus und gemessen an der gesendeten Anfrage.
      const box = page.getByTestId('melden-wir-zeile').filter({ hasText: 'Box meldet sich nicht' }).first();
      await box.locator('label').first().click();
      await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __anfragen: { pfad: string }[] }).__anfragen))
        .some((a) => a.pfad.endsWith('/aktiv'))).toBe(true);
      expect(await ueberlauf(page)).toBe(0);
      expect(fehler).toEqual([]);
    });
  }
}
