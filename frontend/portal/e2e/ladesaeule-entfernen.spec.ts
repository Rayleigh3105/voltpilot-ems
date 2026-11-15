import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * vp-ladesaeule-entfernen: eine per OCPP angebundene Ladesäule hatte im Aufbau keinen Weg zum Entfernen - ihr
 * Zeilenmenü bot nur „Technisch …" (keine löschbare Messkomponente), die Geräteseite schloss es ausdrücklich aus.
 * Diese Bühne stellt die Anlage Hof Seewiesen mit einer zugelassenen Ladesäule (`&ladesaeule=1`,
 * `e2e/geraetesuche.tsx`) und beweist den neuen Gefahr-Eintrag im Zeilenmenü - denselben Dialog wie im
 * Anbinde-Assistenten, dieselbe Rückfrage, dieselben Folgen.
 *
 * Bilder vorher/nachher nur auf Wunsch (`LADESAEULE_BILDER=<Ordner>`), nie ins Repository.
 */
const BILDER = process.env.LADESAEULE_BILDER;

for (const breite of [390, 1440] as const) {
  test(`Aufbau: „Ladesäule entfernen …" im Zeilenmenü - Rückfrage, Rücknahme, keine löschbare Komponente (${breite})`, async ({ page }, info) => {
    const passend = breite < 720 ? info.project.name === 'mobile-webkit' : info.project.name === 'desktop-chromium';
    test.skip(!passend, 'je Breite nur die passende Maschine');
    await page.setViewportSize({ width: breite, height: breite < 720 ? 844 : 900 });
    await page.goto('/e2e/geraetesuche.html?flaeche=aufbau&neu=0&ladesaeule=1');

    const tabelle = page.getByRole('table', { name: 'Aufbau: Anlagen, Boxen und Geräte' });
    await expect(tabelle).toBeVisible();
    const saeule = tabelle.locator('[data-aufbau-geraet="cp-CP-HOF-SUED"]');
    await expect(saeule).toContainText('Hof Süd');

    if (BILDER) {
      mkdirSync(BILDER, { recursive: true });
      await page.screenshot({ path: join(BILDER, `aufbau-ladesaeule-vorher-${breite}.png`), fullPage: true });
    }

    await saeule.getByRole('button', { name: /Weitere Aktionen/ }).click();
    const eintrag = page.getByRole('menuitem', { name: /Ladesäule entfernen/ });
    await expect(eintrag).toBeVisible();
    // Keine zweite, löschbare Messkomponente - der einzige Gefahr-Eintrag ist die Rücknahme der Kennung.
    await expect(page.getByRole('menuitem', { name: /Komponente löschen/ })).toHaveCount(0);
    await eintrag.click();

    const dialog = page.getByRole('dialog', { name: 'Ladesäule entfernen' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Soll VoltPilot die Ladesäule „Hof Süd" nicht mehr annehmen?')).toBeVisible();
    await expect(dialog.getByText(/endet dadurch NICHT/)).toBeVisible();
    await expect(dialog.getByText(/jederzeit wieder eintragen/)).toBeVisible();
    // Das Modal blendet ein (Rechner: Opacity, Telefon < 720 px: ein Blatt, das per `transform` hochfährt -
    // Bewegungs-Programm P6, `shell.css`). `toBeVisible()` wartet nicht auf das Ende dieser Animation, ein Bild
    // mitten drin zeigt die Fläche durchscheinend bzw. verschoben; diese zwei Zusicherungen schon.
    await expect(dialog).toHaveCSS('opacity', '1');
    await expect(dialog).toHaveCSS('transform', 'none');

    if (BILDER) {
      await page.screenshot({ path: join(BILDER, `aufbau-ladesaeule-rueckfrage-${breite}.png`), fullPage: true });
    }

    const vorAbrufe = await page.evaluate(() => (window as unknown as { __siteEntitiesAufrufe: () => number }).__siteEntitiesAufrufe());
    await dialog.getByRole('button', { name: 'Ladesäule entfernen' }).click();
    await expect(dialog).toBeHidden();
    await expect(saeule).toHaveCount(0);
    await expect(page.getByText('Hof Süd')).toHaveCount(0);

    // „Im Aufbau verschwindet die Zeile ohne Neuladen" (Firstmate-Auftrag, Schritt 3): kein zweiter Abruf der Anlage.
    const nachAbrufe = await page.evaluate(() => (window as unknown as { __siteEntitiesAufrufe: () => number }).__siteEntitiesAufrufe());
    expect(nachAbrufe).toBe(vorAbrufe);

    const gesendet = await page.evaluate(() => (window as unknown as { __gesendet: Record<string, unknown> }).__gesendet);
    expect(gesendet.removeChargePoint).toBe('CP-HOF-SUED');

    if (BILDER) {
      await page.screenshot({ path: join(BILDER, `aufbau-ladesaeule-nachher-${breite}.png`), fullPage: true });
    }
  });
}
