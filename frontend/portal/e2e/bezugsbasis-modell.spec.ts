import { expect, test, type Page } from '@playwright/test';

/**
 * Modell-Ansicht einer Fassung (UEMS AP-17 IP-14, §5.2, §5.8) bei 375 px und 1440 px auf der Bühne von IP-9
 * `e2e/bezugsbasis.html` — die ECHTE Kennzahl-Seite von KZ-0004, die Routen im Speicher gespielt.
 *
 * Fälle: „Modell bilden“ — Ines legt BB-0001 mit November 2026 bis Oktober 2027 und dem Modell mit einer Einflussgröße an,
 * die Vorschau zeigt Punkte, Gerade und den Kopfsatz von R12, sie gibt frei, der Reiter zeigt dieselbe Ansicht an der
 * gespeicherten Fassung. „Ablehnung“ (R9) — BB-0001 Fassung 2 nennt Betriebsstunden als nicht aufgenommen (r = 0,997),
 * mit Güte, Spannweite und genau einem Grenz-Satz. 375 px: Grafik in voller Breite, Legende darunter; 1440 px: Grafik
 * neben der Tafel.
 *
 * GEMESSEN: Querlauf des Dokuments und überstehende Elemente, Lage von Grafik, Legende und Tafel. Keine Fixtures importiert.
 */

const AM_24_11_2027 = new Date('2027-11-24T09:00:00+01:00');
const GRENZE =
  'VoltPilot unterstützt Ihr Energiemanagement mit Messung, Kennzahlen und Berichten. Eine Aussage zur Konformität mit einer Norm ist damit nicht verbunden.';
const KOPF_R4 = 'Grundlast 10 523 kWh · je kg 0,2343 kWh · Streuung ± 0,8 % · gilt für 254 000–341 000 kg';
const ABGELEHNT_R9 =
  'Betriebsstunden nicht aufgenommen: hängt an Produktionsmenge (r = 0,997). Ein Modell mit zwei Einflussgrößen braucht unabhängige Größen.';
const GUETE = 'Güte 0,991 — das Modell erklärt 99,1 % der Schwankung der Monatswerte.';

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(AM_24_11_2027);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto(`/e2e/bezugsbasis.html?${query}`);
  await page.evaluate(() => document.fonts.ready);
}

async function ohneQuerlauf(page: Page) {
  const q = await page.evaluate(() => {
    const doc = document.documentElement;
    const breite = doc.clientWidth;
    const sichtbar = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === 'fixed';
    return {
      dokument: doc.scrollWidth - doc.clientWidth,
      ueberstehend: [...document.querySelectorAll<HTMLElement>('.vp-main *, .vp-modal *')]
        .filter((e) => sichtbar(e) && !e.closest('.vp-bereich-tabs') && !e.closest('.vp-steps') && !e.closest('svg'))
        .filter((e) => e.getBoundingClientRect().right > breite + 0.5)
        .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`),
    };
  });
  expect(q).toEqual({ dokument: 0, ueberstehend: [] });
}

/** Die Option in der Liste GENAU dieses Pickers — beide Monats-Picker tragen dieselben Monate (wie `bezugsbasis.spec.ts`). */
async function waehleMonat(page: Page, feld: string, monat: string) {
  await page.getByRole('combobox', { name: feld, exact: true }).click();
  await page.getByRole('listbox', { name: feld, exact: true }).getByRole('option', { name: monat, exact: true }).click();
}

/** 375 px: Legende und Tafel unter der Grafik · 1440 px (Reiter): Tafel rechts neben der Grafik. */
async function lage(ansicht: ReturnType<Page['getByTestId']>, nebeneinander: boolean) {
  const grafik = (await ansicht.getByTestId('bezugsbasis-modell-grafik').boundingBox())!;
  const legende = (await ansicht.locator('.vp-bbm-legende').boundingBox())!;
  const tafel = (await ansicht.getByTestId('bezugsbasis-modell-tafel').boundingBox())!;
  expect(legende.y).toBeGreaterThanOrEqual(grafik.y + grafik.height - 0.5);
  if (nebeneinander) {
    expect(tafel.x).toBeGreaterThanOrEqual(grafik.x + grafik.width - 0.5);
    expect(tafel.y).toBeLessThan(grafik.y + grafik.height);
  } else {
    expect(tafel.y).toBeGreaterThanOrEqual(grafik.y + grafik.height - 0.5);
  }
}

for (const breite of [375, 1440]) {
  test.describe(`Bezugsbasis: Modell-Ansicht (${breite} px)`, () => {
    test(`Modell bilden: zwölf Monate, Modell mit einer Einflussgröße, Punkte und Gerade (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=IK', breite);
      await page.getByRole('tab', { name: 'Bezugsbasis', exact: true }).click();
      await page.getByRole('button', { name: 'Bezugsbasis anlegen' }).click();
      const dialog = page.getByTestId('bezugsbasis-assistent');
      await expect(dialog).toBeVisible();

      await waehleMonat(page, 'Erster Monat', 'November 2026');
      await waehleMonat(page, 'Letzter Monat', 'Oktober 2027');
      await page.getByTestId('bezugsbasis-monate-knopf').click();
      await expect(page.getByTestId('bezugsbasis-monate')).toContainText('Oktober 2027');
      await page.getByTestId('bezugsbasis-weiter').click();
      await dialog.locator('input[type="radio"][value="regression_eine_variable"]').check();
      await page.getByTestId('bezugsbasis-weiter').click();
      await page.getByTestId('bezugsbasis-weiter').click();
      await page.getByTestId('bezugsbasis-weiter').click();
      await page.getByTestId('bezugsbasis-entwurf-knopf').click();

      const vorschau = dialog.getByTestId('bezugsbasis-modell-ansicht');
      await expect(vorschau.getByTestId('bezugsbasis-modell-kopf')).toHaveText(KOPF_R4);
      await expect(vorschau.getByTestId('bezugsbasis-modell-punkt')).toHaveCount(12);
      await expect(vorschau.getByTestId('bezugsbasis-modell-gerade')).toHaveCount(1);
      await expect(vorschau.getByTestId('bezugsbasis-modell-guete')).toHaveText(GUETE);
      await expect(vorschau.getByTestId('bezugsbasis-abgelehnt')).toHaveCount(0);
      await expect(dialog.getByText(GRENZE)).toHaveCount(1);
      await lage(vorschau, false);
      await ohneQuerlauf(page);

      await page.getByLabel('Begründung').fill('Zwölf endgültige Monate: das Modell trägt die Grundlast.');
      await page.getByTestId('bezugsbasis-freigeben-knopf').click();
      await expect(page.getByTestId('bezugsbasis-nach-antrag')).toHaveText('Fassung 1 ist freigegeben und gilt ab 01.11.2027.');
      await page.getByTestId('bezugsbasis-fertig').click();

      const reiter = page.getByTestId('bezugsbasis-reiter').getByTestId('bezugsbasis-modell-ansicht');
      await expect(reiter.getByTestId('bezugsbasis-modell-kopf')).toHaveText(KOPF_R4);
      await expect(reiter.getByTestId('bezugsbasis-modell-punkt')).toHaveCount(12);
      await lage(reiter, breite >= 1100);
      await ohneQuerlauf(page);
    });

    test(`Ablehnung (R9): Betriebsstunden nicht aufgenommen, Güte, Spannweite, ein Grenz-Satz (${breite} px)`, async ({ page }) => {
      await oeffne(page, 'person=CB&lage=modell', breite);
      await page.getByRole('tab', { name: 'Bezugsbasis', exact: true }).click();
      const ansicht = page.getByTestId('bezugsbasis-reiter').getByTestId('bezugsbasis-modell-ansicht');
      await expect(ansicht.getByTestId('bezugsbasis-modell-kopf')).toHaveText(KOPF_R4);
      await expect(ansicht.getByTestId('bezugsbasis-abgelehnt')).toHaveText(ABGELEHNT_R9);
      await expect(ansicht.getByTestId('bezugsbasis-modell-guete')).toHaveText(GUETE);
      await expect(ansicht.getByTestId('bezugsbasis-modell-spannweite-1')).toHaveText(
        'Einflussgröße 1, Produktionsmenge (BZ-1): 254 000–341 000 kg · das Modell gilt von 228 600 bis 375 100 kg; außerhalb ist es nicht anwendbar.',
      );
      await expect(ansicht.getByTestId('bezugsbasis-modell-datenlage')).toHaveText('vollständig (12 Monate)');
      await expect(page.getByText(GRENZE)).toHaveCount(1);
      await lage(ansicht, breite >= 1100);
      await ohneQuerlauf(page);

      await ansicht.getByText('Monate der Referenzperiode (12)').click();
      await expect(ansicht.getByTestId('bezugsbasis-modell-monate')).toContainText('August 2027: 69 693 kWh bei 254 000 kg');
      await ohneQuerlauf(page);
    });
  });
}
