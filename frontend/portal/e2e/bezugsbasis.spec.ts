import { expect, test, type Page } from '@playwright/test';

/**
 * Reiter „Bezugsbasis“ an der Kennzahl (UEMS AP-17 IP-9, NW-4) bei 375 px und 1440 px auf der eigenen Bühne
 * `e2e/bezugsbasis.html` — die ECHTE Kennzahl-Seite von KZ-0004, die Routen im Speicher gespielt.
 *
 * Fälle: der leere Zustand (§5.8 „Leer“) für Ines Kaltenbach (mit Knopf) und Claudia Berger (nur der Satz), und R1 —
 * Ines legt BB-0001 mit der Referenzperiode Oktober 2026 an: Monate prüfen, „vorläufig (1 von 12 Monaten)“, Verhältnis,
 * Einflussgrößen, Faktoren, Vorschau, „Als Entwurf speichern“ und — ohne Vier-Augen — „Freigeben“ mit Begründung; danach steht
 * die Basis-Zeile von R1 im Kopf und das Register trägt „Energieleistungskennzahl“.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente in Seite und Dialog. Die Spec importiert keine Fixtures.
 */

const AM_12_11 = new Date('2026-11-12T09:00:00+01:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const LEER =
  'Noch keine Bezugsbasis. Legen Sie fest, gegen welchen Zeitraum diese Kennzahl verglichen werden soll — der Vergleich entsteht aus den gespeicherten Werten.';
const ZEILE_R1 =
  'Bezugsbasis BB-0001 · Oktober 2026 · Verhältnis 0,2837 kWh je kg · vorläufig (1 von 12 Monaten) · freigegeben von Ines Kaltenbach am 12.11.2026.';

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(AM_12_11);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/bezugsbasis.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
}

async function querlauf(page: Page) {
  return page.evaluate(() => {
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
}

async function ohneQuerlauf(page: Page) {
  expect(await querlauf(page)).toEqual({ dokument: 0, ueberstehend: [] });
}

/**
 * Die Option in der Liste GENAU dieses Pickers — beide Monats-Picker tragen dieselben Monate (Nachprüfung PR 1173).
 * Jeder Locator dieser Spec ist in `src/bezugsbasisSpecLocatoren.test.tsx` gegen dieselbe Fläche gezählt: genau ein Treffer.
 */
async function waehleMonat(page: Page, feld: string, monat: string) {
  await page.getByRole('combobox', { name: feld, exact: true }).click();
  await page.getByRole('listbox', { name: feld, exact: true }).getByRole('option', { name: monat, exact: true }).click();
}

/** „Bezugsbasis“ ohne `exact` träfe auch „Vergleich mit Bezugsbasis“ (IP-20). */
const reiterBezugsbasis = (page: Page) => page.getByRole('tab', { name: 'Bezugsbasis', exact: true });
const anlegenKnopf = (page: Page) => page.getByRole('button', { name: 'Bezugsbasis anlegen', exact: true });

for (const breite of [375, 1440]) {
  test.describe(`Bezugsbasis (${breite} px)`, () => {
    test(`leerer Zustand: Satz, Knopf nur mit Recht, Grenz-Satz (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK', breite);
      await reiterBezugsbasis(page).click();
      await expect(page.getByText(LEER)).toBeVisible();
      await expect(anlegenKnopf(page)).toBeVisible();
      await expect(page.getByTestId('bezugsbasis-reiter').getByText(GRENZE)).toBeVisible();
      await ohneQuerlauf(page);

      await oeffne(page, 'person=CB', breite);
      await reiterBezugsbasis(page).click();
      await expect(page.getByText(LEER)).toBeVisible();
      await expect(anlegenKnopf(page)).toHaveCount(0);
      await ohneQuerlauf(page);
    });

    test(`R1: Ines legt BB-0001 Oktober 2026 vorläufig an und beantragt die Freigabe (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK', breite);
      await reiterBezugsbasis(page).click();
      await anlegenKnopf(page).click();
      const dialog = page.getByTestId('bezugsbasis-assistent');
      await expect(dialog).toBeVisible();

      await waehleMonat(page, 'Erster Monat', 'Oktober 2026');
      await waehleMonat(page, 'Letzter Monat', 'Oktober 2026');
      await page.getByTestId('bezugsbasis-monate-knopf').click();
      await expect(page.getByTestId('bezugsbasis-vorlaeufig')).toHaveText('vorläufig (1 von 12 Monaten)');
      await expect(page.getByTestId('bezugsbasis-monate')).toContainText('Oktober 2026');
      await ohneQuerlauf(page);

      await page.getByTestId('bezugsbasis-weiter').click();
      await expect(dialog.getByText('Modell nicht möglich: 1 von 12 Monaten in der Referenzperiode. Das Verhältnis ist vorläufig.')).toHaveCount(3);
      await expect(dialog.locator('input[type="radio"][value="verhaeltnis"]')).toBeChecked();
      await ohneQuerlauf(page);

      await page.getByTestId('bezugsbasis-weiter').click();
      await expect(page.getByTestId('bezugsbasis-kandidaten')).toContainText('r = 0,997');
      await ohneQuerlauf(page);

      await page.getByTestId('bezugsbasis-weiter').click();
      await expect(page.getByTestId('bezugsbasis-faktoren')).toBeVisible();
      await ohneQuerlauf(page);

      await page.getByTestId('bezugsbasis-weiter').click();
      await expect(page.getByTestId('bezugsbasis-basiswert')).toHaveText('0,2837 kWh je kg');
      await page.getByTestId('bezugsbasis-entwurf-knopf').click();
      await dialog.getByLabel('Begründung', { exact: true }).fill('Oktober 2026 ist der erste volle Monat mit erfasster Produktionsmenge.');
      await dialog.getByTestId('bezugsbasis-freigeben-knopf').click();
      await expect(page.getByTestId('bezugsbasis-nach-antrag')).toHaveText('Fassung 1 ist freigegeben und gilt ab 01.11.2026.');
      await expect(dialog.getByText(GRENZE)).toBeVisible();
      await ohneQuerlauf(page);

      await page.getByTestId('bezugsbasis-fertig').click();
      await expect(page.getByTestId('bezugsbasis-zeile')).toHaveText(ZEILE_R1);
      await ohneQuerlauf(page);
    });

    test(`Register: Kennzeichen „Energieleistungskennzahl“ und Filter (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK&lage=freigegeben&seite=register', breite);
      await expect(page.getByTestId('kennzahl-energieleistung')).toHaveText('Energieleistungskennzahl — Bezugsbasis BB-0001 · vorläufig.');
      await page.getByLabel('nur Energieleistungskennzahlen', { exact: true }).check();
      await expect(page.getByTestId('kennzahl-karte')).toHaveCount(1);
      await ohneQuerlauf(page);
    });
  });
}
