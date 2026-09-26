import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** AP-14 IP-15 / U7a: zwei Einstiege, derselbe Dialog und der bestehende Archiv-Weg. */
const BILDER = process.env.ZUORDNUNG_KORREKTUR_BILDER;

async function ruhe(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function bild(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await ruhe(page);
  await page.screenshot({ path: join(BILDER, name), fullPage: true });
}

async function breite(page: Page, px: 375 | 1440) {
  await page.clock.setFixedTime(new Date('2026-11-20T09:00:00+01:00'));
  await page.setViewportSize({ width: px, height: px === 375 ? 812 : 900 });
}

for (const px of [375, 1440] as const) {
  test(`U7a: Zuordnung rückwirkend korrigieren und leeren Standort archivieren (${px} px)`, async ({ page }) => {
    await breite(page, px);
    await page.goto('/e2e/startansicht.html?bild=korrektur&ansicht=werk-anlagen');
    const einstieg = page.getByRole('button', { name: 'Zuordnung korrigieren' });
    await expect(einstieg).toBeVisible();
    await bild(page, `zuordnung-korrigieren-standort-anlagen-${px}.png`);

    await einstieg.click();
    const dialog = page.getByRole('dialog', { name: 'Anlage zuordnen' });
    await expect(dialog).toContainText('Die Anlage gehört seit ihrem ersten Tag zu einem anderen Standort? Hier ändern Sie das rückwirkend. Steuerung und Messwerte bleiben unberührt.');
    await expect(dialog.getByRole('combobox', { name: 'Gültig ab *' })).toContainText('15.10.2026');
    await bild(page, `zuordnung-korrigieren-dialog-${px}.png`);

    await dialog.getByRole('combobox', { name: 'Neuer Standort *' }).click();
    await page.getByRole('option', { name: /Werk Lindach \(ST-2\)/ }).click();
    const folgen = dialog.getByTestId('umzug-folgen');
    await expect(folgen).toContainText('Rückwirkend (36 Tage)');
    await expect(folgen).toContainText('Die Teilnahme an „Steuern & Optimieren“ bleibt, wie sie ist');
    await bild(page, `zuordnung-korrigieren-folgen-${px}.png`);

    await dialog.getByRole('button', { name: 'Zuordnen' }).click();
    await expect(page.getByText('Zuordnung gespeichert')).toBeVisible();
    const angebot = page.getByTestId('standort-archiv-angebot');
    await expect(angebot).toContainText('Werk Irrtum ist jetzt leer');
    await angebot.scrollIntoViewIfNeeded();
    await bild(page, `zuordnung-korrigieren-archivangebot-${px}.png`);

    await angebot.getByRole('button', { name: 'Standort archivieren' }).click();
    const archiv = page.getByRole('dialog', { name: 'Werk Irrtum archivieren?' });
    await expect(archiv).toContainText('bleibt lesbar und in alten Berichten unverändert');
    await archiv.getByRole('button', { name: 'Archivieren' }).click();
    await expect(page.getByTestId('standort-archiv-angebot')).toContainText('ist archiviert');
  });

  test(`zweiter Einstieg, normaler Umzug und Hilfe (${px} px)`, async ({ page }) => {
    await breite(page, px);
    await page.goto('/e2e/startansicht.html?bild=korrektur&ansicht=korrektur-anlage');
    // Seit den kurzen Einstellungen (main 41ed67c26) ist „Meine Anlage“ auch am Telefon offen — kein Aufklappen mehr.
    const korrektur = page.getByRole('button', { name: 'Zuordnung korrigieren: Werk Lindach' });
    await expect(korrektur).toBeVisible();
    await bild(page, `zuordnung-korrigieren-anlagen-dialog-${px}.png`);

    await page.getByRole('button', { name: 'Anderem Standort zuordnen: Werk Lindach' }).click();
    const normal = page.getByRole('dialog', { name: 'Anlage zuordnen' });
    await expect(normal.getByRole('combobox', { name: 'Gültig ab *' })).toContainText('20.11.2026');
    await expect(normal).toContainText('Die Anlage gehört ab dem gewählten Tag zu einem anderen Standort.');
    await expect(normal).not.toContainText('seit ihrem ersten Tag');
    await bild(page, `zuordnung-korrigieren-normaler-umzug-${px}.png`);

    await page.goto('/e2e/help.html#/hilfe/standort-zuordnung-korrigieren');
    await expect(page.getByRole('heading', { name: 'Standort-Zuordnung korrigieren' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Es gibt keinen Zustand „wieder nicht zugeordnet“');
    await bild(page, `zuordnung-korrigieren-hilfe-${px}.png`);
  });
}
