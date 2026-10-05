import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Wiedervorlage als Arbeitsliste (Konzept Wiedervorlage w1) bei 375, 390 und 1440 px auf der eigenen Bühne
 * `e2e/energiemanagement-wiedervorlage.html`: R12, die Demo (zehn Korrekturen sind ein Eintrag, Zuletzt erledigt), der
 * Normalfall mit offenem Jahresplan, ohne Fristen, ein gescheitertes Laden, „Einsicht“, „Niemand zuständig“ mit seinem
 * eigenen Link über der Karte und der Art-Filter aus der Übersicht. GEMESSEN: kein Querlauf, nichts über dem Rand der
 * Seite, am Telefon Karten (Tippziel ≥ 52 px) und im Jahresplan leise Zeilen (≥ 44 px), ab 760 px Reihen in vier Spalten.
 * Mit `ENERGIEMANAGEMENT_BILDER=<Ordner>` legt der Lauf je Fall ein Bild der ganzen Seite ab.
 */
const BILDER = process.env.ENERGIEMANAGEMENT_BILDER;

async function oeffne(page: Page, query: string, breite: number) {
  await page.setViewportSize({ width: breite, height: 900 });
  await page.goto(`/e2e/energiemanagement-wiedervorlage.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByTestId('wiedervorlage')).toBeVisible();
}

async function vermessen(page: Page, fall: string) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const seite = document.querySelector('[data-testid="wiedervorlage"]')!.getBoundingClientRect();
    const draussen = [...document.querySelectorAll<HTMLElement>('[data-testid="wiedervorlage"] *')]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.left < seite.left - 0.5 || r.right > seite.right + 0.5))
      .map(({ e }) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
    return { quer: doc.scrollWidth - doc.clientWidth, draussen };
  });
  expect(m.quer, `${fall}: Querlauf`).toBeLessThanOrEqual(0);
  expect(m.draussen, `${fall}: über dem Rand`).toEqual([]);
}

async function ablegen(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
}

for (const breite of [375, 390, 1440]) {
  test.describe(`Wiedervorlage w1 bei ${breite} px`, () => {
    test('R12: Kopf, Marken, Überfällig vor den nächsten 30 Tagen, Karte oder Reihe je Breite', async ({ page }) => {
      await oeffne(page, 'fall=r12', breite);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Wiedervorlage');
      await expect(page.getByTestId('wiedervorlage-marken').locator('.vp-k-marke')).toHaveText(['8 überfällig', '1 in den nächsten 30 Tagen', 'Jahresplan']);
      const eintraege = page.getByTestId('wiedervorlage-ueberfaellig').locator('.vp-wv-eintrag');
      await expect(eintraege).toHaveCount(8);
      const erste = eintraege.first();
      const box = (await erste.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(52);
      // Am Telefon die Karte mit Fuß, ab 760 px die Reihe: der Schritt steht rechts in einer eigenen Spalte.
      const schritt = (await erste.locator('.vp-wv-schritt').boundingBox())!;
      const text = (await erste.locator('.vp-wv-text').boundingBox())!;
      if (breite >= 760) expect(schritt.y).toBeLessThan(text.y + text.height);
      else expect(schritt.y).toBeGreaterThan(text.y + text.height);
      // Der Kalender-Abzug: am Rechner ein Link im Kopf, am Telefon im Menü.
      if (breite >= 760) await expect(page.getByTestId('wiedervorlage-kalender')).toBeVisible();
      else await expect(page.getByRole('button', { name: 'Weitere Aktionen' })).toBeVisible();
      await vermessen(page, 'r12');
      await ablegen(page, `wiedervorlage-r12-${breite}`);
      await erste.click();
      expect(await page.evaluate(() => (window as unknown as { __sprung: string[] }).__sprung)).toEqual([
        expect.stringMatching(/^#\/portfolio\/kennzahlen\/.+\?entscheid=bezugsbasis_ueberpruefung$/),
      ]);
    });

    test('Niemand zuständig: „Aufgabe festlegen“ liegt über dem Link der Karte und führt zu den Aufgaben', async ({ page }) => {
      await oeffne(page, 'fall=r12', breite);
      const bericht = page.getByTestId('wiedervorlage-eintrag-BR-2028-0001');
      await expect(bericht.locator('.vp-wv-wer.is-leer')).toContainText('Niemand zuständig');
      await bericht.getByRole('link', { name: 'Aufgabe festlegen' }).click();
      expect(await page.evaluate(() => (window as unknown as { __sprung: string[] }).__sprung)).toEqual([
        '#/portfolio/energiemanagement/aufgaben?entscheid=aufgabe_festlegen&kennzeichen=energiemanagement_leiten',
      ]);
      // „laut Aufgabe“: am Telefon kurz hinter dem Namen, in der Reihe mit dem Wort der Aufgabe.
      const d1 = (await page.getByTestId('wiedervorlage-eintrag-D-0001').locator('.vp-wv-wer').innerText()).replace(/\s+/g, ' ');
      if (breite >= 760) expect(d1).toBe('Ines Kaltenbach laut Aufgabe „Dokumente des Energiemanagements pflegen“');
      else expect(d1).toBe('Ines Kaltenbach · laut Aufgabe');
      await vermessen(page, 'zustaendig');
    });

    test('Jahresplan: zu bei Überfälligem, die Marke öffnet ihn; nach Monaten, gestrichelt, „Öffnen“', async ({ page }) => {
      await oeffne(page, 'fall=r12', breite);
      await expect(page.getByTestId('wiedervorlage-jahresplan-anzeigen')).toHaveAttribute('aria-expanded', 'false');
      await page.getByTestId('wiedervorlage-marke-jahresplan').click();
      const plan = page.getByTestId('wiedervorlage-jahresplan');
      await expect(plan.getByRole('heading', { level: 2 })).toHaveText('Jahresplan · 6');
      await expect(plan.getByRole('heading', { level: 3 })).toHaveText(['April 2029', 'Juni 2029', 'November 2029', 'Januar 2030']);
      const audit = page.getByTestId('wiedervorlage-eintrag-AU-2029-0001');
      await expect(audit.locator('.vp-fd')).toHaveClass('vp-fd is-plan');
      const box = (await audit.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(plan).toBeInViewport();
      await vermessen(page, 'jahresplan');
      await ablegen(page, `wiedervorlage-jahresplan-${breite}`);
      await audit.click();
      expect(await page.evaluate(() => (window as unknown as { __sprung: string[] }).__sprung)).toEqual(['#/portfolio/energiemanagement/audits']);
    });

    test('Demo: ein Bericht mit zehn Korrekturen ist ein Eintrag; Zuletzt erledigt mit Tag und Person', async ({ page }) => {
      await oeffne(page, 'fall=demo', breite);
      await expect(page.getByTestId('wiedervorlage-ueberfaellig').locator('.vp-wv-eintrag')).toHaveCount(4);
      await expect(page.getByTestId('wiedervorlage-eintrag-BR-2026-0001')).toContainText('10 Korrekturen nach der Freigabe');
      await expect(page.getByTestId('wiedervorlage-zuletzt').locator('li')).toHaveCount(5);
      await vermessen(page, 'demo');
      await ablegen(page, `wiedervorlage-demo-${breite}`);
    });

    test('Normalfall, ohne Fristen, Fehler und Einsicht: ehrlich in jedem Zustand', async ({ page }) => {
      await oeffne(page, 'fall=normal', breite);
      await expect(page.getByTestId('wiedervorlage-marken').locator('.vp-k-marke')).toHaveText(['Keine Frist überfällig', '11 im Jahresplan']);
      await expect(page.getByTestId('wiedervorlage-nichts-bald')).toHaveText('Bis 30.05.2029 ist nichts fällig. Die nächste Frist ist am 30.06.2029.');
      await expect(page.getByTestId('wiedervorlage-jahresplan').getByRole('heading', { level: 3 })).toHaveText([
        'Juni 2029',
        'November und Dezember 2029',
        'Januar bis April 2030',
      ]);
      await vermessen(page, 'normal');
      await ablegen(page, `wiedervorlage-normal-${breite}`);

      await oeffne(page, 'fall=leer', breite);
      await expect(page.getByTestId('wiedervorlage-leer')).toContainText('Noch keine Fristen.');
      await vermessen(page, 'leer');

      await oeffne(page, 'fall=fehler', breite);
      await expect(page.getByTestId('wiedervorlage-fehler')).toContainText('Die Fristen ließen sich gerade nicht laden.');
      await expect(page.getByTestId('wiedervorlage')).not.toContainText('nichts fällig');
      await vermessen(page, 'fehler');
      await ablegen(page, `wiedervorlage-fehler-${breite}`);

      await oeffne(page, 'fall=einsicht', breite);
      await expect(page.getByTestId('wiedervorlage-einsicht')).toHaveText('Sie sehen alle Fristen. Erledigen können sie die Zuständigen.');
      await expect(page.getByTestId('wiedervorlage-eintrag-D-0001')).toContainText('Ansehen');
      await vermessen(page, 'einsicht');
    });

    test('Art-Filter aus der Übersicht: nur Bezugsbasen, mit einem Tipp wieder alle', async ({ page }) => {
      await oeffne(page, 'fall=r12&art=bezugsbasis_ueberpruefung', breite);
      await expect(page.getByTestId('wiedervorlage-ueberfaellig').locator('.vp-wv-eintrag')).toHaveCount(4);
      await expect(page.getByTestId('wiedervorlage-filter-art')).toHaveText('Bezugsbasen');
      await vermessen(page, 'filter');
      await page.getByTestId('wiedervorlage-filter-art').click();
      await expect(page.getByTestId('wiedervorlage-ueberfaellig').locator('.vp-wv-eintrag')).toHaveCount(8);
      await expect(page).toHaveURL(/#\/portfolio\/energiemanagement\/wiedervorlage$/);
    });
  });
}
