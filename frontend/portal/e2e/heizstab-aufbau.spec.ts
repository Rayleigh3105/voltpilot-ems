import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Live-Fall „Zuhause" (02.11.2026), zweiter Befund: der eben angelegte Heizstab (Shelly Pro 3, drei Ausgänge als EIN
 * Gerät) stand im Aufbau nirgends - die Box meldete den Deye, und `plantModel` gab dem ersten gemeldeten
 * Wechselrichter jede Komponente ohne Pin, also auch den Stab („gemessen über Deye"). Die Bühne `geraetesuche.html`
 * stellt mit `&heizstab=1` genau diese Anlage: der Aufbau zeigt den Deye UND den Heizstab als eigene Zeile.
 *
 * Bilder nur auf Wunsch (`HEIZSTAB_BILDER=<Ordner>`), nie ins Repository.
 */
const BILDER = process.env.HEIZSTAB_BILDER;

for (const breite of [375, 1440] as const) {
  test(`Heizstab neben gemeldetem Wechselrichter: eigene Zeile im Aufbau (${breite})`, async ({ page }, info) => {
    const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
    test.skip(!passend, 'je Breite nur die passende Maschine');
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/geraetesuche.html?flaeche=aufbau&neu=0&heizstab=1');

    const tabelle = page.getByRole('table', { name: 'Aufbau: Anlagen, Boxen und Geräte' });
    await expect(tabelle).toBeVisible();
    const geraete = tabelle.locator('[data-aufbau-geraet]');
    await expect(geraete).toHaveCount(2);
    await expect(tabelle.locator('[data-aufbau-geraet="inverter"]')).toContainText('SUN-29.9K');
    const stab = tabelle.locator('[data-aufbau-geraet="komp-e-hz"]');
    await expect(stab).toContainText('Heizstab');
    await expect(stab).toContainText('Noch keine Rückmeldung');
    // Der Stab ist kein Messwert des Wechselrichters: nirgends „gemessen über".
    await expect(page.getByText(/gemessen über/)).toHaveCount(0);

    if (!BILDER) return;
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `aufbau-heizstab-${breite}.png`), fullPage: true });
  });
}

/**
 * Live-Fall „Zuhause“, 05.11.2026: nach der Erstbindung stand der Heizstab im Aufbau als „Wartet auf die ersten
 * Daten“ mit „1 braucht Aufmerksamkeit“ - dabei misst der Pro 3 nicht, VoltPilot steuert ihn. `&heizstab=2` stellt den
 * gebundenen Stab: eigene Geräteseite, ehrlicher Zustand, keine zweite Fundzeile für denselben Shelly.
 */
for (const breite of [375, 1440] as const) {
  test(`gebundener Heizstab: wird gesteuert, kein Alarm, kein zweites Fund-Angebot (${breite})`, async ({ page }, info) => {
    const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
    test.skip(!passend, 'je Breite nur die passende Maschine');
    await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
    await page.goto('/e2e/geraetesuche.html?flaeche=aufbau&neu=0&heizstab=2');

    const tabelle = page.getByRole('table', { name: 'Aufbau: Anlagen, Boxen und Geräte' });
    await expect(tabelle).toBeVisible();
    const stab = tabelle.locator('[data-aufbau-geraet]').filter({ hasText: 'Heizstab' });
    await expect(stab).toHaveCount(1);
    await expect(stab).toContainText('Wird von VoltPilot gesteuert');
    await expect(page.getByText('Wartet auf die ersten Daten')).toHaveCount(0);
    // Der Stab hat seine Geräteseite (an der Quelle der Box) und steht nicht ein zweites Mal als Fund da.
    await expect(stab.getByRole('link', { name: 'Heizstab' })).toHaveAttribute('href', /\/geraet\/edge-seewiesen\/src-7q7pdrwh$/);
    await expect(page.getByText(/Nicht übernommen|Shelly gefunden/)).toHaveCount(0);
    // Die einzige Aufmerksamkeit der Bühne gehört dem Deye ohne Rückmeldung, nie dem Stab.
    await expect(tabelle.locator('[data-aufbau-geraet="inverter"]')).toContainText('Noch keine Rückmeldung');

    if (!BILDER) return;
    mkdirSync(BILDER, { recursive: true });
    await page.screenshot({ path: join(BILDER, `aufbau-heizstab-gebunden-${breite}.png`), fullPage: true });
  });
}
