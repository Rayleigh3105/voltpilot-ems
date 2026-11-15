import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Befund PR 1886: eine Ablehnung im Messpunkt-Weg zeigte dem Kunden den rohen
 * englischen Box-Code (`edge_too_old`) statt eines verständlichen deutschen
 * Satzes (`MeasurementSelectionService.state()`, `beobachteteRegister.ts`
 * um Zeile 196). Bühne `fuehler-status.html?stand=vorher` liefert genau die
 * Antwort, die die API speichert, solange die Ablehnung roh durchläuft.
 *
 * Bilder nur auf Wunsch (`ABLEHNGRUND_BILDER=<Ordner>`), nie ins Repository.
 */
const BILDER = process.env.ABLEHNGRUND_BILDER;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

async function oeffne(page: Page, breite: number) {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
  await page.goto('/e2e/fuehler-status.html?stand=vorher');
  await expect(page.getByRole('heading', { name: /Fühler · Register/ })).toBeVisible({ timeout: 20_000 });
  return fehler;
}

async function bild(page: Page, name: string, breite: number) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: true, animations: 'disabled' });
}

for (const breite of [390, 1440] as const) {
  test.describe(`Messpunkt-Ablehngrund (${breite})`, () => {
    test.beforeEach(({}, info) => {
      const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
      test.skip(!passend, 'je Breite nur die passende Maschine');
    });

    test('eine abgelehnte Box-Antwort zeigt einen deutschen Satz, nie den rohen Code', async ({ page }) => {
      const fehler = await oeffne(page, breite);
      await expect(page.getByText('abgelehnt')).toBeVisible();
      // Der frühere Befund: der rohe Code stand wörtlich auf der Seite.
      await expect(page.getByText('edge_too_old')).toHaveCount(0);
      // Der Satz steht zweimal: in der Geräte-weiten Kurzfassung UND an der Zeile
      // selbst (MeasurementSelectionService.state() und die per-Punkt-Ablehnung).
      await expect(page.getByText(
        'Die Software Ihrer VoltPilot-Box unterstützt diesen Punkt noch nicht - '
        + 'bitte ein Update der Box einspielen.',
      ).first()).toBeVisible();
      // Nichts geplant (alles abgelehnt) - der Satz zum Datenvolumen entfällt, statt "0 GB/Jahr" zu behaupten.
      await expect(page.getByText(/GB\/Jahr geplant/)).toHaveCount(0);
      await bild(page, 'k-abgelehnt', breite);
      expect(fehler).toEqual([]);
    });
  });
}
