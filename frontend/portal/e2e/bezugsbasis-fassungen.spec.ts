import { expect, test, type Page } from '@playwright/test';

/**
 * Fassungen, Anstoß, neue Fassung, Beenden und Frist im Reiter „Bezugsbasis“ (UEMS AP-17 IP-18, §5.5) bei 375 px und
 * 1440 px auf der Bühne `e2e/bezugsbasis.html` (`lage=anstoss` R5, `lage=frist` R13) — die ECHTE Kennzahl-Seite von
 * KZ-0004, die Routen im Speicher gespielt (`fassungenBuehne`, Form des API-Nachtrags Nachlese 3).
 *
 * Fälle: R5 Anstoß → Fassung 2 mit Anpassungsgrund, Vorschau alt/neu, Freigabe; Fassung 1 bleibt sichtbar (beendet) ·
 * die Leserin sieht den Anstoß ohne Knöpfe · Beenden mit Tag, Grund, Begründung · R13 Frist → „geprüft, bleibt“.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente in Seite und Dialog. Die Spec importiert keine Fixtures;
 * jeder Locator ist in `src/bezugsbasisFassungenSpecLocatoren.test.tsx` gegen dieselbe Fläche gezählt.
 */

const AM_06_01_2027 = new Date('2027-01-06T09:00:00+01:00');
const AM_13_11_2027 = new Date('2027-11-13T09:00:00+01:00');
const ANSTOSS = 'Bezugsbasis BB-0001: die Fläche der Halle 2 hat sich geändert (3 100 → 3 400 m² ab 01.01.2027) — Fassung 1 prüfen.';
const FRIST = 'Bezugsbasis BB-0001, Fassung 1 vom 12.11.2026 · Überprüfung fällig seit 1 Tag — bestätigen oder neu fassen.';
const LEER =
  'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.';

async function oeffne(page: Page, query: string, breite: number, uhr = AM_06_01_2027) {
  await page.clock.setFixedTime(uhr);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/bezugsbasis.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('tab', { name: 'Bezugsbasis', exact: true }).click();
}

async function ohneQuerlauf(page: Page) {
  const q = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    return {
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
        .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !e.closest('.vp-steps'))
        .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`),
    };
  });
  expect(q).toEqual({ dokument: 0, ueberstehend: [] });
}

async function waehle(page: Page, feld: string, wert: string) {
  await page.getByRole('combobox', { name: feld, exact: true }).click();
  await page.getByRole('listbox', { name: feld, exact: true }).getByRole('option', { name: wert, exact: true }).click();
}

for (const breite of [375, 1440]) {
  test.describe(`Bezugsbasis-Fassungen (${breite} px)`, () => {
    test(`R5: Anstoß → Fassung 2 mit Grund „Struktur geändert“; Fassung 1 bleibt sichtbar (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK&lage=anstoss', breite);
      const kasten = page.getByTestId('bezugsbasis-anstoss');
      await expect(kasten.getByText(ANSTOSS, { exact: true })).toBeVisible();
      await expect(page.getByTestId('bezugsbasis-fassung-1')).toContainText('Statischer Faktor: Fläche G-2 3 100 m² (Stand 12.11.2026)');
      await ohneQuerlauf(page);

      await kasten.getByRole('button', { name: 'Neue Fassung bilden', exact: true }).click();
      const anpassung = page.getByTestId('bezugsbasis-neue-fassung');
      await anpassung.getByRole('checkbox', { name: 'Struktur geändert', exact: true }).check();
      await anpassung.getByLabel('Begründung', { exact: true }).fill('Anbau Halle 2: die Fläche wächst von 3 100 auf 3 400 m².');
      await ohneQuerlauf(page);
      await page.getByTestId('bezugsbasis-anpassung-weiter').click();

      const assistent = page.getByTestId('bezugsbasis-assistent');
      await expect(page.getByRole('dialog', { name: 'Neue Fassung bilden' })).toBeVisible();
      await page.getByTestId('bezugsbasis-monate-knopf').click();
      await expect(page.getByTestId('bezugsbasis-vorlaeufig')).toHaveText('vorläufig (1 von 12 Monaten)');
      for (let i = 0; i < 4; i++) await page.getByTestId('bezugsbasis-weiter').click();
      await page.getByTestId('bezugsbasis-entwurf-knopf').click();
      const altNeu = page.getByTestId('bezugsbasis-alt-neu');
      await expect(altNeu).toContainText('Fassung 1');
      await expect(altNeu).toContainText('Fassung 2');
      await ohneQuerlauf(page);
      await assistent.getByLabel('Begründung', { exact: true }).fill('Die neue Fläche gilt ab Januar 2027.');
      await assistent.getByTestId('bezugsbasis-freigeben-knopf').click();
      await expect(page.getByTestId('bezugsbasis-nach-antrag')).toBeVisible();
      await page.getByTestId('bezugsbasis-fertig').click();

      await expect(page.getByTestId('bezugsbasis-fassung-2')).toContainText('Anpassungsgründe: Struktur geändert');
      await expect(page.getByTestId('bezugsbasis-fassung-1')).toContainText('gilt vom 01.11.2026 bis 31.12.2026');
      await expect(page.getByTestId('bezugsbasis-anstoss')).toHaveCount(0);
      await ohneQuerlauf(page);
    });

    test(`die Leserin sieht den Anstoß ohne Knöpfe (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=CB&lage=anstoss', breite);
      const kasten = page.getByTestId('bezugsbasis-anstoss');
      await expect(kasten.getByText(ANSTOSS, { exact: true })).toBeVisible();
      await expect(kasten.getByRole('button')).toHaveCount(0);
      await ohneQuerlauf(page);
    });

    test(`Beenden mit Tag, Grund und Begründung (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK&lage=anstoss', breite);
      await page.getByTestId('bezugsbasis-anstoss').getByRole('button', { name: 'Beenden', exact: true }).click();
      const dialog = page.getByTestId('bezugsbasis-beenden');
      await waehle(page, 'Grund', 'Struktur geändert');
      await dialog.getByLabel('Begründung', { exact: true }).fill('Anbau Halle 2 — die Kennzahl wird neu gefasst.');
      await ohneQuerlauf(page);
      await page.getByTestId('bezugsbasis-beenden-senden').click();
      await expect(page.getByTestId('bezugsbasis-beendet')).toHaveText(
        'Vergleiche danach: Nicht bewertbar: Bezugsbasis beendet am 06.01.2027 (Struktur geändert).',
      );
      await page.getByRole('button', { name: 'Fertig', exact: true }).click();
      await expect(page.getByText(LEER, { exact: true })).toBeVisible();
      await ohneQuerlauf(page);
    });

    test(`R13: Überprüfung fällig seit 1 Tag → geprüft, bleibt (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK&lage=frist', breite, AM_13_11_2027);
      await expect(page.getByTestId('bezugsbasis-frist')).toHaveText(FRIST);
      await ohneQuerlauf(page);
      await page.getByRole('button', { name: 'Geprüft, bleibt', exact: true }).click();
      const dialog = page.getByTestId('bezugsbasis-bleibt');
      await dialog.getByLabel('Begründung', { exact: true }).fill('Keine Änderung an Halle und Produktion.');
      await page.getByTestId('bezugsbasis-bleibt-senden').click();
      await expect(page.getByTestId('bezugsbasis-geprueft')).toHaveText('Geprüft: Fassung 1 bleibt · nächste Überprüfung am 13.11.2028.');
      await ohneQuerlauf(page);
      await page.getByRole('button', { name: 'Fertig', exact: true }).click();
      await expect(page.getByTestId('bezugsbasis-frist')).toHaveCount(0);
    });
  });
}
