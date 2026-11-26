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
    // Die Anlagen des Standorts stehen auf seiner Übersicht (die frühere Seite „Anlagen“ ist im Aufbau aufgegangen).
    await page.goto('/e2e/startansicht.html?bild=korrektur&ansicht=werk');
    const einstieg = page.getByRole('button', { name: 'Zuordnung korrigieren' });
    await expect(einstieg).toBeVisible();
    await bild(page, `zuordnung-korrigieren-standort-${px}.png`);

    await einstieg.click();
    const dialog = page.getByRole('dialog', { name: 'Gehört zu' });
    // Schritt 2c (Captain-Korrektur zu PR 2041): erst die volle Liste der Standorte, dann „Seit wann?".
    await bild(page, `zuordnung-korrigieren-dialog-${px}.png`);
    await dialog.getByRole('radio', { name: /Werk Lindach \(ST-2\)/ }).click();
    await dialog.getByRole('button', { name: 'Weiter' }).click();

    // „Seit wann?" steht auf „Schon immer" - kein sichtbares Datum (Regel 5), der erste
    // Anlagentag (15.10.2026) gilt dahinter.
    await expect(dialog.getByRole('radio', { name: 'Schon immer (war falsch)' })).toBeChecked();
    await expect(dialog.getByRole('combobox', { name: 'Gültig ab' })).toHaveCount(0);
    const folgen = dialog.getByTestId('umzug-folgen-kurz');
    await expect(folgen).toContainText('Rückwirkend (36 Tage)');
    await bild(page, `zuordnung-korrigieren-folgen-${px}.png`);
    await dialog.getByRole('button', { name: 'Alle Folgen' }).click();
    await expect(dialog.getByTestId('umzug-folgen')).toContainText('Die Teilnahme an „Steuern & Optimieren“ bleibt, wie sie ist');

    await dialog.getByRole('button', { name: 'Speichern' }).click();
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
    // Schritt 2c (§6.2/§6.5): EIN Einstieg „Gehört zu: … · Ändern" oben im Blatt „Ort
    // berichtigen" statt der beiden früheren Verweise - „Seit wann?" wählt im Dialog selbst.
    await page.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const blatt = page.getByRole('dialog', { name: 'Standort' });
    const aendern = blatt.getByRole('button', { name: 'Ändern: Werk Lindach' });
    await expect(aendern).toBeVisible();
    await bild(page, `zuordnung-korrigieren-anlagen-dialog-${px}.png`);

    await aendern.click();
    const normal = page.getByRole('dialog', { name: 'Gehört zu' });
    await normal.getByRole('radio', { name: /Werk Lindach \(ST-2\)/ }).click();
    await normal.getByRole('button', { name: 'Weiter' }).click();
    await expect(normal.getByText('Seit wann gehört Werk Lindach zu Werk Lindach?')).toBeVisible();
    await expect(normal.getByRole('radio', { name: 'Ab einem Tag' })).toBeChecked();
    await expect(normal.getByRole('combobox', { name: 'Gültig ab' })).toContainText('20.11.2026');
    await bild(page, `zuordnung-korrigieren-normaler-umzug-${px}.png`);

    await page.goto('/e2e/help.html#/hilfe/standort-zuordnung-korrigieren');
    await expect(page.getByRole('heading', { name: 'Standort-Zuordnung korrigieren' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Es gibt keinen Zustand „wieder nicht zugeordnet“');
    await bild(page, `zuordnung-korrigieren-hilfe-${px}.png`);
  });
}
