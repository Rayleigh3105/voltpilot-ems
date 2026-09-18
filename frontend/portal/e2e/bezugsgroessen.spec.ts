import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
const BILDER = process.env.BEZUGSGROESSEN_BILDER;
const IMPORT_BILDER = process.env.BEZUGSDATEN_IMPORT_BILDER;
async function oeffne(page: Page, breite: number, zusatz = '') {
  await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
  await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
  await page.goto(`/e2e/startansicht.html?bild=unternehmen&ansicht=bezugsgroessen${zusatz}`);
  await expect(page.getByRole('heading', { name: 'Bezugsgrößen', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'werden geladen' })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
async function foto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const ueber = await page.locator('.vp-bz, .vp-bz-form').evaluateAll(elements => elements.flatMap(e => [...e.querySelectorAll<HTMLElement>('*')]).filter(e => e.getClientRects().length && !e.closest('.vp-picker-panel') && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.className));
  expect(ueber).toEqual([]);
  if (BILDER) { mkdirSync(BILDER, { recursive: true }); await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: !name.startsWith('anlegen-') && !name.startsWith('archivieren-') }); }
}
async function importFoto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  if (IMPORT_BILDER) { mkdirSync(IMPORT_BILDER, { recursive: true }); await page.screenshot({ path: join(IMPORT_BILDER, `${name}.png`), fullPage: false }); }
}
async function waehle(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: false }).first().click();
}
async function importVorschauOeffnen(page: Page, breite: number, fall: 'B2' | 'B3') {
  await oeffne(page, breite, `&importfall=${fall}`);
  await page.getByRole('button', { name: 'Werte importieren', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Werte aus Datei übernehmen', exact: true });
  await dialog.getByLabel('CSV-Datei').setInputFiles({ name: 'produktion-oktober.csv', mimeType: 'text/csv', buffer: Buffer.from('Periode;Artikelgruppe;Menge;Einheit\n2026-10;Spritzguss gesamt;312.900,0;kg') });
  await dialog.getByRole('button', { name: 'Weiter zur Zuordnung' }).click();
  await dialog.getByRole('combobox', { name: 'Gespeicherte Vorlage' }).click();
  await page.getByRole('option', { name: /ERP-Export Spritzguss/ }).click();
  await dialog.getByRole('button', { name: 'Vorschau erstellen' }).click();
  await expect(dialog.getByText('Schritt 3 von 4')).toBeVisible();
  return dialog;
}
for (const breite of [375, 1440]) {
  test(`${breite}: Liste, Art/Einheit/Geltung, Fokus, Anlegen und Archivieren`, async ({ page }) => {
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message)); page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
    await oeffne(page, breite);
    await expect(page.getByTestId('bezugsgroesse-karte')).toHaveCount(11);
    await expect(page.getByText('Art nicht angegeben', { exact: true })).toHaveCount(6);
    await foto(page, `a-liste-${breite}`);
    if (breite === 375) {
      expect(await page.locator('.vp-bottombar .lbl').evaluateAll(es => es.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent))).toEqual([]);
      for (const b of await page.locator('.vp-bottombar button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await waehle(page, 'Standort', 'Werk Lindach');
    await expect(page.getByTestId('bezugsgroesse-karte')).toHaveCount(3);
    await expect(page.getByText('Gutteile Montage Lindach', { exact: true })).toBeVisible();
    await waehle(page, 'Standort', 'Alle Standorte');
    const neu = page.getByRole('button', { name: 'Bezugsgröße anlegen', exact: true });
    await neu.click();
    const dialog = page.getByRole('dialog', { name: 'Bezugsgröße anlegen', exact: true });
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
    await dialog.getByLabel('Name', { exact: true }).fill('Produktionsmenge Spritzguss');
    await waehle(page, 'Art', 'Betriebszeit');
    await expect(dialog.getByRole('combobox', { name: 'Einheit', exact: true })).toContainText('h');
    await waehle(page, 'Art', 'Produktionsmenge');
    await page.getByRole('combobox', { name: 'Geltungsbereich', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Produktionsmenge Spritzguss');
    await waehle(page, 'Geltungsbereich', 'Spritzguss Prozess');
    await foto(page, `anlegen-${breite}`);
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(e => e.contains(document.activeElement))).toBe(true); }
    await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(neu).toBeFocused();
    const karte = page.getByTestId('bezugsgroesse-karte').filter({ hasText: 'BZ-0008' });
    await expect(karte).toContainText('Noch keine Werte');
    await expect(karte.getByText('Produktionsmenge', { exact: true })).toBeVisible();
    await foto(page, `art-gespeichert-${breite}`);
    if (BILDER) await karte.screenshot({ path: join(BILDER, `art-karte-${breite}.png`) });
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { anlegen: unknown[] } }).bzAufrufe.anlegen)).toHaveLength(1);
    await karte.getByRole('button', { name: 'Archivieren', exact: true }).click();
    const archiv = page.getByRole('dialog', { name: 'Bezugsgröße archivieren?', exact: true });
    await expect(archiv).toContainText('Bisherige Werte bleiben lesbar.');
    await foto(page, `archivieren-${breite}`);
    await archiv.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await expect(karte.getByRole('button', { name: 'Archivieren', exact: true })).toBeFocused();
    await karte.getByRole('button', { name: 'Archivieren', exact: true }).click();
    await archiv.getByRole('button', { name: 'Archivieren', exact: true }).click();
    await expect(archiv).toHaveCount(0);
    await expect(karte).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Bezugsgrößen', exact: true })).toBeFocused();
    await waehle(page, 'Anzeige', 'Archiviert');
    await expect(karte).toBeVisible();
    await expect(karte.getByRole('button', { name: 'Archivieren', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { archivieren: unknown[] } }).bzAufrufe.archivieren)).toHaveLength(1);
    await foto(page, `archiv-${breite}`);
    expect(fehler).toEqual([]);
  });
  test(`${breite}: leer, Leserechte und Ladefehler`, async ({ page }) => {
    await oeffne(page, breite, '&bezugs=leer');
    await expect(page.getByRole('heading', { name: 'Noch keine Bezugsgrößen' })).toBeVisible();
    await foto(page, `leer-${breite}`);
    await oeffne(page, breite, '&person=CB');
    await expect(page.getByRole('button', { name: 'Bezugsgröße anlegen', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archivieren', exact: true })).toHaveCount(0);
    await oeffne(page, breite, '&bezugs=fehler');
    await expect(page.getByRole('alert')).toContainText('konnten nicht geladen');
    await expect(page.getByText('Noch keine Bezugsgrößen')).toHaveCount(0);
  });
  test(`${breite}: Variante B nur als E2E-Vorschau unter Messstellen`, async ({ page }) => {
    await oeffne(page, breite, '-b');
    await expect(page.getByRole('tab', { name: 'Bezugsgrößen', exact: true })).toHaveAttribute('aria-selected', 'true');
    await foto(page, `b-liste-${breite}`);
  });
  test(`${breite}: Import-Assistent führt durch Datei, Zuordnung, Vorschau und Übernahme`, async ({ page }) => {
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message)); page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
    await oeffne(page, breite);
    await page.getByRole('button', { name: 'Werte importieren', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Werte aus Datei übernehmen', exact: true });
    await expect(dialog.getByText('Schritt 1 von 4')).toBeVisible();
    await importFoto(page, `import-1-datei-${breite}`);
    await dialog.getByLabel('CSV-Datei').setInputFiles({
      name: 'produktion-oktober.csv', mimeType: 'text/csv',
      buffer: Buffer.from('Periode;Artikelgruppe;Menge;Einheit\n2026-10;Spritzguss gesamt;312.400,0;kg\n2026-10;Spritzguss Export;688.720;lbs\n2026-10;Montage;96;Paletten'),
    });
    await dialog.getByRole('button', { name: 'Weiter zur Zuordnung' }).click();
    await expect(dialog.getByText('Schritt 2 von 4')).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Gespeicherte Vorlage' }).click();
    await page.getByRole('option', { name: /ERP-Export Spritzguss/ }).click();
    await importFoto(page, `import-2-zuordnung-${breite}`);
    await dialog.getByRole('button', { name: 'Vorschau erstellen' }).click();
    await expect(dialog.getByText('Schritt 3 von 4')).toBeVisible();
    await expect(dialog.getByText('UTF-8', { exact: true })).toBeVisible();
    await expect(dialog.getByText('2 abgelehnt', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Vorschau der Datenzeilen' })).toContainText('Unbekannte Einheit — erlaubt sind die Einheiten dieser Größe.');
    await importFoto(page, `import-3-vorschau-${breite}`);
    await dialog.getByRole('button', { name: '1 Zeile übernehmen' }).click();
    await expect(dialog.getByText('Schritt 4 von 4')).toBeVisible();
    await expect(dialog.getByText('1 von 3 Zeilen', { exact: true })).toBeVisible();
    await importFoto(page, `import-4-uebernahme-${breite}`);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: '1 Zeile übernehmen' }).click();
    await expect(dialog.getByRole('heading', { name: 'I-2026-0015 ist übernommen' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { vorschau: string[]; importe: string[] } }).bzAufrufe)).toMatchObject({ vorschau: ['produktion-oktober.csv'], importe: ['produktion-oktober.csv'] });
    expect(fehler).toEqual([]);
  });
  test(`${breite}: B2 Doppelimport zeigt den bekannten Import und schreibt keine zweite Menge`, async ({ page }) => {
    const dialog = await importVorschauOeffnen(page, breite, 'B2');
    await expect(dialog.getByText('Diese Datei wurde schon übernommen.', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import I-2026-0001 ansehen' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Nichts zu übernehmen' })).toBeVisible();
    await importFoto(page, `b2-doppelimport-${breite}`);
  });
  test(`${breite}: B3 Konflikt hat Einzelwahl, Sammelhebel und eine Begründung`, async ({ page }) => {
    const dialog = await importVorschauOeffnen(page, breite, 'B3');
    await expect(dialog).toContainText('Vorhanden: 312400 kg · Fassung 1 · I-2026-0001');
    await expect(dialog).toContainText('In der Datei: 312900 kg');
    await expect(dialog.getByRole('radio', { name: 'Behalten' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Alle Konflikte ersetzen' }).click();
    await expect(dialog.getByRole('radio', { name: 'Ersetzen' })).toBeChecked();
    await dialog.getByLabel('Eine Begründung für alle ersetzten Zeilen').fill('ERP-Nachbuchung vom 05.11.2026');
    await importFoto(page, `b3-konflikt-${breite}`);
    await dialog.getByRole('button', { name: 'Entscheidung prüfen' }).click();
    await expect(dialog).toContainText('1 ersetzen · 0 behalten · Begründung: ERP-Nachbuchung vom 05.11.2026');
  });
  test(`${breite}: B14 Rücknahme zeigt Folgen und schreibt erst nach Bestätigung`, async ({ page }) => {
    await oeffne(page, breite);
    await page.getByRole('button', { name: 'Import-Protokoll', exact: true }).click();
    const liste = page.getByRole('dialog', { name: 'Import-Protokoll', exact: true });
    await liste.getByRole('button', { name: /I-2026-0001/ }).click();
    const detail = page.getByRole('dialog', { name: 'I-2026-0001', exact: true });
    await expect(detail.getByRole('region', { name: 'Zeilen und Befunde des Imports' })).toContainText('BZ-1');
    await detail.getByRole('button', { name: 'Import zurücknehmen' }).click();
    const ruecknahme = page.getByRole('dialog', { name: 'I-2026-0001 zurücknehmen?', exact: true });
    await expect(ruecknahme).toContainText('BZ-1 · Oktober 2026: 312.400 kg wird zurückgenommen.');
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { ruecknahmen: string[] } }).bzAufrufe.ruecknahmen)).toEqual([]);
    await ruecknahme.getByLabel('Begründung').fill('Falsche Artikelgruppe exportiert — Datei war ein Testexport');
    await ruecknahme.getByLabel('Begründung').evaluate((e: HTMLInputElement) => { e.setSelectionRange(0, 0); e.scrollLeft = 0; e.blur(); });
    await importFoto(page, `b14-ruecknahme-${breite}`);
    await ruecknahme.getByRole('button', { name: 'Import zurücknehmen' }).click();
    await expect(page.getByRole('dialog', { name: 'Import-Protokoll', exact: true })).toContainText('Zurückgenommen');
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { ruecknahmen: string[] } }).bzAufrufe.ruecknahmen)).toHaveLength(1);
  });
}
test('Bearbeiter kann nur im eigenen Standort anlegen; Serverfehler erhält die Eingabe', async ({ page }) => {
  await oeffne(page, 375, '&person=PH');
  await page.getByRole('button', { name: 'Bezugsgröße anlegen', exact: true }).click();
  await page.getByRole('combobox', { name: 'Geltungsbereich', exact: true }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Werk Ahrenberg' }).first()).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('option').filter({ hasText: 'Werk Lindach' }).first()).not.toHaveAttribute('aria-disabled', 'true');
  await oeffne(page, 375, '&bezugs=konflikt');
  await page.getByRole('button', { name: 'Bezugsgröße anlegen', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Gutteile Montage');
  await waehle(page, 'Geltungsbereich', 'Spritzguss Prozess');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('schon eine andere Bezugsgröße');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Gutteile Montage');
  await expect(page.getByRole('alert')).toBeFocused();
});
test('O18: ohne Messfunktion kein Einstieg und keine Seite', async ({ page }) => {
  await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bezugsgroessen&messen=bestand');
  await expect(page.getByText('Bezugsgrößen stehen zur Verfügung, sobald ein Standort misst.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Bezugsgrößen', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Bezugsgröße anlegen', exact: true })).toHaveCount(0);
});
for (const breite of [375, 1440]) {
  test(`${breite}: produktive App erreicht Bezugsgrößen aus der Unternehmensnavigation`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    await page.setViewportSize({ width: breite, height: 900 });
    await page.goto('/e2e/startansicht.html?bild=unternehmen&rechte=1&person=JW');
    const weg = breite === 375 ? page.locator('.vp-bottombar').getByRole('button', { name: 'Bezugsgrößen', exact: true }) : page.getByRole('tab', { name: 'Bezugsgrößen', exact: true });
    await weg.click();
    await expect(page).toHaveURL(/#\/portfolio\/bezugsgroessen$/);
    await expect(page.getByTestId('bezugsgroesse-karte')).toHaveCount(11);
    await expect(page.getByText('Art nicht angegeben', { exact: true })).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Bezugsgröße anlegen', exact: true })).toBeVisible();
  });
}
