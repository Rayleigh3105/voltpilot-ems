import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { grenzHinweisZeigt } from './grenzHinweis';

/**
 * „Bewertung › Bewertungsstand“ (UEMS AP-16 IP-25, §5.5, R7/R10) bei 375 px und 1440 px auf der Bühne
 * `e2e/bewertung.html?stand=voll&bewertungsstand=…` — die ECHTE `BewertungPage` mit dem ECHTEN Freigabe-Dialog der
 * Bericht-Maschine; die Bericht-Routen spielt `src/test/bewertungStandBuehne.ts` entlang R7/R10.
 *
 * Fälle: Freigabe Stand Nr. 1 aus dem Entwurf (09.11.2026 10:12) · Anstoß-Vermerk „Revision nötig — Korrektur
 * K-2026-0007“ und Freigabe Nr. 2 (17.11.2026 09:30, ersetzt Nr. 1) · PDF-Abruf eines ersetzten Stands unter „Frühere
 * Stände“ · „Unterschiede ansehen“ · fällige Bewertung als Hinweiskarte (18.11.2027, Konzept Auswerten a1 §6.7). Mit `BEWERTUNGSSTAND_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 * Die Spec importiert keine Fixtures.
 */

const BILDER = process.env.BEWERTUNGSSTAND_BILDER;
const AM_09_11_1012 = new Date('2026-11-09T09:12:00Z');
const AM_17_11_0930 = new Date('2026-11-17T08:30:00Z');
const AM_20_11 = new Date('2026-11-20T09:00:00Z');
const AM_18_11_2027 = new Date('2027-11-18T09:00:00Z');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';

async function oeffne(page: Page, lage: string, breite: number, jetzt: Date) {
  await page.clock.setFixedTime(jetzt);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/bewertung.html?stand=voll&bewertungsstand=${lage}`);
  await expect(page.locator('.vp-topbar').first()).toBeVisible();
  await expect(page.getByTestId('bewertung-stand')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function ohneQuerlauf(page: Page, fall: string) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    return {
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [
        ...new Set(
          [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
            .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs'))
            .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
            .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`),
        ),
      ],
    };
  });
  expect(m.dokument, `${fall}: Querlauf des Dokuments`).toBe(0);
  expect(m.ueberstehend, `${fall}: überstehende Elemente`).toEqual([]);
}

async function ablegen(page: Page, name: string, ziel: 'stand' | 'dialog' | 'kopf') {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const pfad = join(BILDER, `${name}.png`);
  if (ziel === 'dialog') await page.locator('.vp-modal').first().screenshot({ path: pfad });
  else if (ziel === 'kopf') await page.getByTestId('bewertung-faellig').screenshot({ path: pfad });
  else {
    // Die Karte direkt unter die klebende Kopfleiste rollen und den Bildschirm aufnehmen — so verdeckt der Kopf nichts.
    await page.getByTestId('bewertung-stand').evaluate((e) => {
      const kopf = document.querySelector('.vp-topbar')?.getBoundingClientRect().bottom ?? 0;
      window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - kopf - 8);
    });
    await page.screenshot({ path: pfad });
  }
}

for (const breite of [375, 1440]) {
  test.describe(`Bewertungsstand bei ${breite} px`, () => {
    test('Freigabe (§5.5 Schritt 2): der Entwurf wird Stand Nr. 1 - Datumsblöcke statt Prüfsumme, die Statuszeile sagt, was gilt', async ({ page }) => {
      await oeffne(page, 'entwurf', breite, AM_09_11_1012);
      const stand = page.getByTestId('bewertung-stand');
      await expect(stand.getByTestId('bewertung-entwurf')).toContainText('Erster Stand mit den Zahlen bis Oktober 2026');
      await expect(stand.getByTestId('bewertung-entwurf').getByRole('img')).toHaveAccessibleName('Entwurf mit Datenstand 09.11.2026');
      await expect(page.getByTestId('bewertung-status')).toHaveText('Noch kein Stand freigegebenDer Entwurf wartet auf die erste Freigabe.');
      await grenzHinweisZeigt(page, GRENZE);
      await expect(page.getByTestId('bewertung-faellig')).toHaveCount(0);
      await expect(stand.getByTestId('bewertung-unterschiede-knopf')).toHaveCount(0);
      await ohneQuerlauf(page, 'Entwurf');
      await ablegen(page, `entwurf-${breite}`, 'stand');

      await stand.getByTestId('bewertung-freigeben-knopf').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Berichtsstand freigeben');
      await expect(dialog).toContainText('Zeitraum zu Ende');
      await expect(dialog).not.toContainText('Werte endgültig');
      await ohneQuerlauf(page, 'Freigabe-Dialog');
      await ablegen(page, `freigabe-dialog-${breite}`, 'dialog');
      await dialog.getByTestId('bericht-freigeben-knopf').click();
      await expect(dialog).toHaveCount(0);

      const nr1 = stand.getByTestId('bewertung-stand-1');
      await expect(nr1).toContainText('gilt · freigegeben von Ines Kaltenbach');
      await expect(nr1.getByRole('img')).toHaveAccessibleName('Stand Nr. 1 vom 09.11.2026');
      await expect(nr1).not.toContainText('Prüfsumme');
      await expect(page.getByTestId('bewertung-status')).toContainText('Gilt · Stand Nr. 1 vom 09.11.2026');
      await expect(page.getByTestId('bewertung-status')).toContainText('nächste Überprüfung bis 09.11.2027');
      await ohneQuerlauf(page, 'Stand Nr. 1');
    });

    test('Anstoß (R7): „Revision nötig — Korrektur K-2026-0007“; Freigabe = Stand Nr. 2, Nr. 1 bleibt unter „Frühere Stände“ lesbar', async ({ page }) => {
      await oeffne(page, 'revision', breite, AM_17_11_0930);
      const stand = page.getByTestId('bewertung-stand');
      const vermerk = stand.getByTestId('bewertung-revision');
      await expect(vermerk).toContainText('Revision nötig — Korrektur K-2026-0007');
      await expect(vermerk).toContainText('Erkannt am 12.11.2026 10:05.');
      await expect(vermerk).toContainText('Der Berichtsstand Nr. 1 bleibt unverändert.');
      await expect(stand.getByTestId('bewertung-freigeben-knopf')).toHaveText('Als Stand Nr. 2 freigeben');
      await expect(stand.getByTestId('bewertung-entwurf')).toContainText('Neuer Stand mit den Zahlen bis Oktober 2026');
      await ohneQuerlauf(page, 'Revision-Vermerk');
      await ablegen(page, `revision-${breite}`, 'stand');

      await stand.getByTestId('bewertung-freigeben-knopf').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('ersetzt Berichtsstand Nr. 1');
      await dialog.getByTestId('bericht-freigeben-knopf').click();
      await expect(dialog).toHaveCount(0);

      await expect(stand.getByTestId('bewertung-revision')).toHaveCount(0);
      await expect(page.getByTestId('bewertung-status')).toContainText('Gilt · Stand Nr. 2 vom 17.11.2026');
      await expect(stand.getByTestId('bewertung-stand-2')).toContainText('Anlass: Korrektur K-2026-0007');
      await expect(stand.getByTestId('bewertung-stand-1')).toHaveCount(0);
      await stand.getByTestId('bewertung-fruehere').click();
      await expect(stand.getByTestId('bewertung-stand-1')).toContainText('ersetzt durch Stand Nr. 2 · freigegeben von Ines Kaltenbach');
      await expect(stand.getByTestId('bewertung-fruehere')).toHaveText('Frühere Stände ausblenden');
      await ohneQuerlauf(page, 'Stand Nr. 2');
    });

    test('PDF-Abruf (S4): PDF und CSV am gültigen Stand; der ersetzte Stand Nr. 1 bleibt unter „Frühere Stände“ abrufbar', async ({ page }) => {
      await oeffne(page, 'nr2', breite, AM_20_11);
      const stand = page.getByTestId('bewertung-stand');
      // Der gültige Stand und der Entwurf.
      await expect(stand.getByTestId('bewertung-staende').locator('> li')).toHaveCount(2);
      await expect(stand.getByTestId('bewertung-pdf-2')).toBeVisible();
      await expect(stand.getByTestId('bewertung-csv-2')).toBeVisible();
      await ohneQuerlauf(page, 'Stände');
      await ablegen(page, `staende-${breite}`, 'stand');

      await stand.getByTestId('bewertung-fruehere').click();
      const download = page.waitForEvent('download');
      await stand.getByTestId('bewertung-pdf-1').click();
      expect((await download).suggestedFilename()).toBe('bericht-BR-2026-0009-nr1.pdf');
      await expect(stand.getByTestId('bewertung-abruf')).toHaveText('PDF von Stand Nr. 1 abgerufen - der Abruf ist protokolliert.');
      expect(await page.evaluate(() => (window as unknown as { __bewertungAbrufe: string[] }).__bewertungAbrufe)).toEqual(['BR-2026-0009/1/pdf']);
      await ablegen(page, `pdf-abruf-${breite}`, 'stand');
    });

    test('Unterschiede ansehen (§6.7): der Entwurf gegen den gültigen Stand, von dort weiter zur Freigabe', async ({ page }) => {
      await oeffne(page, 'nr2', breite, AM_20_11);
      await page.getByTestId('bewertung-unterschiede-knopf').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Keine Abweichung — der Entwurf zeigt dieselben Zahlen wie Nr. 2.');
      await expect(dialog.getByRole('button', { name: 'Als Berichtsstand Nr. 3 freigeben' })).toBeVisible();
      await ohneQuerlauf(page, 'Vergleich');
      await ablegen(page, `unterschiede-${breite}`, 'dialog');
    });

    test('Frist (R10): fällig wird die Statuszeile zur Hinweiskarte - Datum statt Tageszähler, Verantwortliche, „Neuen Stand freigeben“', async ({ page }) => {
      await oeffne(page, 'faellig', breite, AM_18_11_2027);
      const karte = page.getByTestId('bewertung-faellig');
      await expect(karte).toContainText('Überprüfung fällig seit 17.11.2027');
      await expect(karte).toContainText('Stand Nr. 2 vom 17.11.2026 - prüfen Sie den Entwurf und geben Sie einen neuen Stand frei.');
      await expect(karte).toContainText('Paul Hartmann (EE-2, EE-5)');
      await expect(page.getByTestId('bewertung-status')).toHaveCount(0);
      await ohneQuerlauf(page, 'Frist');
      await ablegen(page, `frist-${breite}`, 'kopf');
      await page.getByTestId('bewertung-faellig-schritt').click();
      await expect(page.getByTestId('bewertung-freigeben-knopf')).toBeFocused();
    });
  });
}
