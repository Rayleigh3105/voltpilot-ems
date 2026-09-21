import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Der Einstieg in den Assistenten „Messen & Auswerten“ (AP-01 E5 = A) auf der ECHTEN App-Schale: die Bühne
 * `startansicht.html` mit `rechte=1` rendert `<App initialAuth />` (nicht die Vorschau), der Assistent kommt also
 * aus `App.tsx` — nachgeladen, an genau einer Stelle. Karte „Funktionen“ → Knopf → Schritt 1; Entwurf → „Einrichtung
 * fortsetzen (Schritt n von 5)“ → dieser Schritt; Satz „Daten kommen an“ → Schritt 2; Avatar-Menü „Funktionen“ →
 * Karte; Leerzustand der Messstellen → Assistent. Ohne Recht: Grund und Weg statt Knopf.
 *
 * Mit `EINSTIEG_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab (Ansicht).
 */

const BILDER = process.env.EINSTIEG_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');
const ST1 = '5a1d0000-0000-4000-8000-000000000001';
const ENTWURF = 'vp.uems.messen-assistent.entwurf.v1';

async function bild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const breite = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: false });
}

async function oeffnen(page: Page, query: string, hash = '#/portfolio') {
  await page.clock.setFixedTime(JETZT);
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&rechte=1&${query}${hash}`);
}

const karte = (page: Page) => page.getByTestId('funktionen-karte');
const assistent = (page: Page) => page.getByRole('dialog');

for (const breite of [375, 1440] as const) {
  test.describe(`${breite} px`, () => {
    test.use({ viewport: { width: breite, height: breite === 375 ? 812 : 900 } });

    test('Übersicht → Karte „Funktionen“ → Knopf → Schritt 1', async ({ page }) => {
      await oeffnen(page, 'person=JW&messen=bestand');
      const knopf = karte(page).getByRole('button', { name: 'Messen & Auswerten für Werk Ahrenberg einrichten' });
      await expect(knopf).toBeVisible();
      await knopf.scrollIntoViewIfNeeded();
      // Kein Querlauf, gemessen am Dokument: der lange Knopf bricht um (375 px).
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await bild(page, 'karte-knopf');
      await knopf.click();
      await expect(assistent(page).getByText('Wo wird gemessen?')).toBeVisible();
      await bild(page, 'assistent-schritt1');
    });

    test('Wiedereinstieg: Entwurf → „Einrichtung fortsetzen (Schritt 3 von 5)“ → Schritt 3', async ({ page }) => {
      await page.addInitScript(
        ([schluessel, wert]) => window.localStorage.setItem(schluessel, wert),
        [ENTWURF, JSON.stringify({ standortId: ST1, schritt: 3 })] as const,
      );
      await oeffnen(page, 'person=JW&messen=entwurf');
      const knopf = karte(page).getByRole('button', { name: 'Einrichtung fortsetzen (Schritt 3 von 5)' });
      await expect(knopf).toBeVisible();
      await knopf.scrollIntoViewIfNeeded();
      await bild(page, 'karte-fortsetzen');
      await knopf.click();
      await expect(assistent(page).getByText(/Schritt 3 von 5/).first()).toBeVisible();
    });

    test('Satz „Daten kommen an“ → Schritt 2 der Anlage', async ({ page }) => {
      await oeffnen(page, 'person=JW&messen=entwurf&zuordnung=offen', '#/portfolio/messstellen/MS-06');
      const satz = page.getByTestId('werte-zuordnung');
      await expect(satz).toBeVisible();
      await satz.scrollIntoViewIfNeeded();
      await bild(page, 'satz-weg');
      await satz.getByRole('button', { name: 'Im Messen-Assistenten zuordnen' }).click();
      await expect(assistent(page).getByText('Womit wird gemessen?')).toBeVisible();
    });

    test('Avatar-Menü „Funktionen“ → Karte', async ({ page }) => {
      await oeffnen(page, 'person=JW&messen=bestand', '#/portfolio/messstellen');
      await page.getByRole('button', { name: /Konto-Menü/ }).click();
      const eintrag = page.getByRole('menuitem', { name: 'Funktionen' });
      await expect(eintrag).toBeVisible();
      await bild(page, 'avatar-menue');
      await eintrag.click();
      await expect(karte(page).getByRole('heading', { name: 'Funktionen' })).toBeFocused();
      await expect(karte(page)).toBeInViewport();
    });

    test('Leerzustand der Messstellen → Assistent', async ({ page }) => {
      await oeffnen(page, 'person=JW&messen=bestand', '#/portfolio/messstellen');
      const knopf = page.getByRole('button', { name: 'Messen & Auswerten einrichten', exact: true });
      await expect(knopf).toBeVisible();
      await bild(page, 'leer-messstellen');
      await knopf.click();
      await expect(assistent(page).getByText('Wo wird gemessen?')).toBeVisible();
    });

    test('ohne Recht: Grund und Weg statt Knopf', async ({ page }) => {
      await oeffnen(page, 'person=CB&messen=bestand');
      await expect(karte(page)).toBeVisible();
      await expect(karte(page).getByRole('button', { name: /Messen & Auswerten für/ })).toHaveCount(0);
      await expect(karte(page).getByRole('note').first()).toBeVisible();
      await karte(page).scrollIntoViewIfNeeded();
      await bild(page, 'ohne-recht');
    });
  });
}
