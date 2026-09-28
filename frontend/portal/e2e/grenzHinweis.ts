import { expect, type Locator, type Page } from '@playwright/test';

/**
 * K7 (Konzept „Energiemanagement ohne Fachsprache“, D5): Grenz- und Verantwortungs-Satz stehen einmal im Kopf eines
 * Bereichs — „Was VoltPilot leistet“ öffnet beide im vollen Wortlaut. Der Helfer öffnet den Hinweis, prüft die Sätze
 * sichtbar und schließt ihn wieder, damit Messungen und Ablagen danach die Seite in Ruhe sehen.
 */
export async function grenzHinweisZeigt(bereich: Page | Locator, ...saetze: string[]) {
  const hinweis = bereich.getByTestId('grenzhinweis');
  await expect(hinweis).toHaveCount(1);
  const knopf = hinweis.locator('summary');
  await expect(knopf).toHaveText('Was VoltPilot leistet');
  await knopf.click();
  for (const satz of saetze) await expect(hinweis.getByText(satz)).toBeVisible();
  await knopf.click();
  await expect(hinweis).not.toHaveAttribute('open');
}
