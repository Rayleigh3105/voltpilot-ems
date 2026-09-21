import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS AP-15 IP-26 (Regel T6) — die Sperre `steuerquelle` auf der Box-Seite (Bühne `startansicht`, Box Halle 1, DQ-1
 * ist Steuerquelle) bei 375 und 1440 px. Ohne Gemeinsame Steuerung steht der Satz von heute. Vor dem Scharfschalten
 * (S1) steht an DQ-1 wieder „Zuständige Box wechseln“ — zu einem Mitglied zieht die Steuerquelle um, der Server urteilt
 * je Ziel-Box. Scharf steht dort Grund UND Weg: „Gemeinsame Steuerung ändern“ — als Sprung auf die Karte der Anlage
 * (Technik, `?abschnitt=gemeinsam` → `#technik-gemeinsam`, IP-23-Folge). Der Zustand kommt über `GET …/gemeinsame-steuerung`, hier per `page.route` gestellt: die geteilte Bühne
 * bleibt unberührt. Mit `STEUERQUELLE_BILDER=<Ordner>` legt der Lauf je Lage und Breite ein Bild ab.
 * Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */

const BILDER = process.env.STEUERQUELLE_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');
const BESTAND = 'Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Optimierung mehrerer Boxen wechseln.';
const WEG = 'DQ-1 gehört zur Gemeinsamen Steuerung — ihre Box wechselt nur über „Gemeinsame Steuerung ändern“';

async function oeffne(page: Page, breite: number, zustand: string | null) {
  await page.unrouteAll();
  if (zustand) {
    await page.route('**/api/v1/sites/*/gemeinsame-steuerung', (route) => route.fulfill({
      json: { eingerichtet: true, zustand, stufe: zustand === 'anteile_aktiv' ? 'S3' : 'S1', epoche: 0, mitglieder: [], fehlt: [] },
    }));
  }
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=box-halle1');
  await expect(page.getByRole('heading', { name: 'Box Halle 1', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Datenquellen und Geräte' }).click();
  await expect(page.locator('.vp-box-quellen')).toContainText('DQ-1');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
}

async function ablegen(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  const quellen = page.getByTestId('box-quellen');
  await quellen.scrollIntoViewIfNeeded();
  await quellen.screenshot({ path: join(BILDER, `${name}.png`) });
}

for (const breite of [375, 1440]) {
  test(`AP-15 IP-26 · Steuerquelle bei ${breite} px: in einer Anlage mit Gemeinsamer Steuerung vor dem Scharfschalten der Knopf, scharf Grund und Weg`, async ({ page }) => {
    await oeffne(page, breite, null);
    const dq1 = page.locator('.vp-box-quellen li').filter({ hasText: 'DQ-1' });
    await expect(dq1).toContainText(BESTAND);
    await expect(dq1.getByRole('button', { name: 'Zuständige Box wechseln' })).toHaveCount(0);
    await ablegen(page, `vorher-${breite}`);

    await oeffne(page, breite, 'beobachtet');
    await expect(dq1.getByRole('button', { name: 'Zuständige Box wechseln' })).toHaveCount(1);
    await expect(dq1).not.toContainText(BESTAND);
    await expect(page.getByTestId('steuerquelle-weg')).toHaveCount(0);
    await ablegen(page, `s1-${breite}`);

    await oeffne(page, breite, 'anteile_aktiv');
    await expect(dq1.getByTestId('steuerquelle-weg')).toHaveText(WEG);
    await expect(dq1).not.toContainText(BESTAND);
    await expect(dq1.getByRole('button', { name: 'Zuständige Box wechseln' })).toHaveCount(0);
    // der Weg springt auf die Karte „Gemeinsame Steuerung“ der Anlage (Technik, Abschnitt `gemeinsam`)
    await expect(dq1.getByRole('link', { name: WEG })).toHaveAttribute('href', /^#\/anlage\/[^/]+\/technik\?abschnitt=gemeinsam$/);
    // Die übrigen Quellen behalten ihren Weg: kein Steuerquellen-Satz an DQ-2/DQ-3.
    await expect(page.getByTestId('steuerquelle-weg')).toHaveCount(1);
    const querlauf = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(querlauf, `Querlauf bei ${breite} px`).toBe(0);
    await ablegen(page, `scharf-${breite}`);
  });
}
