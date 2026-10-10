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
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}
async function foto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  const ueber = await page.locator('.vp-bz, .vp-bzs, .vp-bz-form').evaluateAll(elements => elements.flatMap(e => [...e.querySelectorAll<HTMLElement>('*')]).filter(e => e.getClientRects().length && !e.closest('.vp-picker-panel') && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.className));
  expect(ueber).toEqual([]);
  if (BILDER) { mkdirSync(BILDER, { recursive: true }); await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: !name.startsWith('anlegen-') && !name.startsWith('archivieren-') }); }
}
async function importFoto(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  if (IMPORT_BILDER) { mkdirSync(IMPORT_BILDER, { recursive: true }); await page.screenshot({ path: join(IMPORT_BILDER, `${name}.png`), fullPage: false }); }
}
/** Ein Werkzeug der Liste: am Rechner „Werte importieren“ als Knopf, sonst (und alles andere) im Menü ⋯ (Konzept §6.8). */
async function aktion(page: Page, breite: number, name: string) {
  if (name === 'Werte importieren' && breite > 720) return page.getByRole('button', { name, exact: true }).click();
  await page.getByTestId('bezugsgroessen-menue').getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
}
async function waehle(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option, exact: false }).first().click();
}
async function importVorschauOeffnen(page: Page, breite: number, fall: 'B2' | 'B3') {
  await oeffne(page, breite, `&importfall=${fall}`);
  await aktion(page, breite, 'Werte importieren');
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
  test(`${breite}: Liste je Periode, Flächen, Statuszeile; Anlegen im Menü, Archivieren auf der Seite`, async ({ page }) => {
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message)); page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
    await oeffne(page, breite);
    const reihen = page.getByTestId('bezugsgroesse-reihe');
    // Konzept §6.8: je Periode eine Karte mit Reihen (Name, was sie zählt, letzter Wert) - keine „Art nicht angegeben“,
    // keine Auswahlfelder, die Flächen als Kacheln statt sieben gleicher Karten.
    await expect(reihen).toHaveCount(6);
    await expect(page.getByTestId('bezugsgroessen-gruppe')).toHaveText([/Werte je Monat/, /Werte je Tag/]);
    await expect(page.getByText('Art nicht angegeben', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Standort', exact: true })).toHaveCount(0);
    await expect(page.getByText('Flächen werden in der Ortsstruktur gepflegt.')).toHaveCount(0);
    const flaechen = page.getByTestId('bezugsgroessen-flaechen');
    await expect(flaechen.locator('.vp-bz-kachel')).toHaveCount(5);
    await expect(flaechen.locator('.vp-bz-kachel').filter({ hasText: 'Halle 1' })).toContainText('4.200\u00a0m²');
    await expect(flaechen.locator('.vp-bz-kachel').filter({ hasText: 'Lagerhalle Lindach' })).toContainText('nicht angegeben');
    // Die Bühne legt am 01.10.2026 an: September ist für die Monatswerte noch nicht fällig, der Tag 19.10.2026 für die
    // Ladezeit (Tageswerte) schon - die Statuszeile wird zum Hinweis mit dem Schritt zu ihr.
    await expect(reihen.filter({ hasText: 'BZ-1' })).toContainText('305.200');
    await expect(reihen.filter({ hasText: 'BZ-1' })).toContainText('Sep 2026');
    await expect(reihen.filter({ hasText: 'BZ-7' })).toContainText('Aug 2026');
    const hinweis = page.getByTestId('bezugsgroessen-hinweis');
    await expect(hinweis).toContainText('Für den 19.10.2026 fehlt der Wert von Ladezeit Ladepunkt Halle 2');
    await expect(hinweis).toHaveAttribute('href', /^#\/portfolio\/bezugsgroessen\//);
    await foto(page, `a-liste-${breite}`);
    if (breite === 375) {
      expect(await page.locator('.vp-bottombar .lbl').evaluateAll(es => es.filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent))).toEqual([]);
      for (const b of await page.locator('.vp-bottombar button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    const menueKnopf = page.getByTestId('bezugsgroessen-menue').getByRole('button', { name: 'Weitere Aktionen' });
    await aktion(page, breite, 'Bezugsgröße anlegen');
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
    await expect(menueKnopf).toBeFocused();
    const reihe = reihen.filter({ hasText: 'BZ-0008' });
    await expect(reihe).toContainText('noch kein Wert');
    await expect(reihe).toContainText('Spritzguss · kg je Monat');
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { anlegen: unknown[] } }).bzAufrufe.anlegen)).toHaveLength(1);
    // Die ganze Reihe öffnet die Seite der Bezugsgröße (Entscheid 9) - dort steht „Archivieren“ im Menü ⋯.
    await reihe.click();
    const seite = page.getByTestId('bezugsgroesse-seite');
    await expect(seite).toHaveAttribute('data-kennzeichen', 'BZ-0008');
    await expect(page).toHaveURL(/#\/portfolio\/bezugsgroessen\/[^/]+$/);
    await expect(page.getByRole('tab', { name: 'Bezugsgrößen', exact: true })).toHaveCount(0);
    await expect(seite.getByRole('button', { name: 'Wert eintragen', exact: true })).toBeVisible();
    await foto(page, `seite-neu-${breite}`);
    const seitenMenue = page.getByTestId('bezugsgroesse-menue').getByRole('button', { name: 'Weitere Aktionen' });
    await seitenMenue.click();
    await page.getByRole('menuitem', { name: 'Archivieren' }).click();
    const archiv = page.getByRole('dialog', { name: 'Bezugsgröße archivieren?', exact: true });
    await expect(archiv).toContainText('Bisherige Werte bleiben lesbar.');
    await foto(page, `archivieren-${breite}`);
    await archiv.getByRole('button', { name: 'Abbrechen', exact: true }).click();
    await expect(seitenMenue).toBeFocused();
    await seitenMenue.click();
    await page.getByRole('menuitem', { name: 'Archivieren' }).click();
    await archiv.getByRole('button', { name: 'Archivieren', exact: true }).click();
    await expect(archiv).toHaveCount(0);
    await expect(seite.getByTestId('bezugsgroesse-status')).toContainText('Archiviert');
    await expect(page.getByTestId('bezugsgroesse-menue')).toHaveCount(0);
    await expect(seite.getByRole('button', { name: 'Wert eintragen', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { bzAufrufe: { archivieren: unknown[] } }).bzAufrufe.archivieren)).toHaveLength(1);
    // Zurück zur Liste: archivierte stehen erst auf Wunsch (Menü ⋯), zugeklappt am Ende.
    await page.getByRole('link', { name: 'Alle Bezugsgrößen' }).click();
    await expect(reihen.filter({ hasText: 'BZ-0008' })).toHaveCount(0);
    await aktion(page, breite, 'Archivierte zeigen');
    await expect(page.getByTestId('bezugsgroessen-archiv')).toContainText('BZ-0008');
    await foto(page, `archiv-${breite}`);
    expect(fehler).toEqual([]);
  });
  test(`${breite}: leer, Leserechte und Ladefehler`, async ({ page }) => {
    await oeffne(page, breite, '&bezugs=leer');
    await expect(page.getByText('Noch keine Bezugsgrößen', { exact: true })).toBeVisible();
    await foto(page, `leer-${breite}`);
    await oeffne(page, breite, '&person=CB');
    const menue = page.getByTestId('bezugsgroessen-menue');
    if (await menue.count()) {
      await menue.getByRole('button').click();
      await expect(page.getByRole('menuitem', { name: /Bezugsgröße anlegen/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    await page.getByTestId('bezugsgroesse-reihe').first().click();
    await expect(page.getByTestId('bezugsgroesse-seite')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wert eintragen', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('bezugsgroesse-menue')).toHaveCount(0);
    await oeffne(page, breite, '&bezugs=fehler');
    await expect(page.getByRole('alert')).toContainText('ließen sich gerade nicht laden');
    await expect(page.getByText('Noch keine Bezugsgrößen')).toHaveCount(0);
  });
  test(`${breite}: unbekannt ist nie „eingetragen“ - Werte unterwegs oder nicht abrufbar (Prüfung r4 M3)`, async ({ page }) => {
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message)); page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
    const reihen = page.getByTestId('bezugsgroesse-reihe');
    // Die Werte von BZ-1 kommen nie an: die Reihe ist ein Skelett - kein „noch kein Wert“, kein „Eintragen“, keine Statuszeile.
    await page.clock.setFixedTime(new Date('2026-10-20T10:00:00Z'));
    await page.setViewportSize({ width: breite, height: breite === 375 ? 812 : 1000 });
    await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=bezugsgroessen&bezugs=werteunterwegs');
    const unterwegs = reihen.filter({ hasText: 'BZ-1' });
    await expect(unterwegs).toHaveAttribute('data-abruf', 'unterwegs');
    await expect(unterwegs).toHaveAttribute('aria-busy', 'true');
    await expect(reihen.filter({ hasText: 'BZ-2' })).toContainText('4.820');
    await expect(unterwegs).not.toContainText('noch kein Wert');
    await expect(unterwegs).not.toContainText('Eintragen');
    await expect(page.getByTestId('bezugsgroessen-status')).toHaveCount(0);
    await expect(page.getByTestId('bezugsgroessen-hinweis')).toHaveCount(0);
    // Die Werte von BZ-2 sind nicht abrufbar: die Reihe sagt es, die Lage sagt es mit dem Weg zurück - nie grün.
    await oeffne(page, breite, '&bezugs=wertefehler');
    const kaputt = reihen.filter({ hasText: 'BZ-2' });
    await expect(kaputt).toHaveAttribute('data-abruf', 'fehler');
    await expect(kaputt).toContainText('gerade nicht abrufbar');
    // Sichtbar an jeder Breite: am Telefon in der Wert-Spalte (dort gibt es keine Zustand-Spalte), sonst im Zustand.
    await expect(kaputt.getByText('gerade nicht abrufbar').filter({ visible: true })).toHaveCount(1);
    if (breite === 375) await expect(kaputt.locator('.vp-bz-strich')).toBeHidden();
    await expect(kaputt).not.toContainText('Eintragen');
    await expect(page.getByTestId('bezugsgroessen-status')).toHaveCount(0);
    const lage = page.getByTestId('bezugsgroessen-nicht-abrufbar');
    await expect(lage).toContainText('Einige Werte sind gerade nicht abrufbar.');
    await foto(page, `nicht-abrufbar-${breite}`);
    if (breite === 375) expect((await lage.getByRole('button', { name: 'Erneut versuchen' }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(fehler).toEqual([]);
  });
  test(`${breite}: „Alle N“ zählt, was die Liste zeigt - auch einen zurückgenommenen Wert (Prüfung r4 S22)`, async ({ page }) => {
    await oeffne(page, breite, '&bezugs=zurueckgenommen');
    await page.getByTestId('bezugsgroesse-reihe').filter({ hasText: 'BZ-1' }).click();
    const werte = page.getByTestId('bezugsgroesse-werte');
    const zeilen = werte.locator('.vp-bzs-liste > li');
    await expect(zeilen).toHaveCount(3);
    await expect(zeilen.first()).toContainText('zurückgenommen');
    const alle = werte.getByRole('button', { name: 'Alle 4' });
    await expect(alle).toHaveAttribute('aria-expanded', 'false');
    await alle.click();
    await expect(zeilen).toHaveCount(4);
    await expect(zeilen.last()).toContainText('290.000');
    await foto(page, `seite-alle-${breite}`);
  });
  test(`${breite}: Variante B nur als E2E-Vorschau unter Messstellen`, async ({ page }) => {
    await oeffne(page, breite, '-b');
    await expect(page.getByRole('tab', { name: 'Bezugsgrößen', exact: true })).toHaveAttribute('aria-selected', 'true');
    await foto(page, `b-liste-${breite}`);
  });
  test(`${breite}: Import-Assistent führt durch Datei, Zuordnung, Vorschau und Übernahme`, async ({ page }) => {
    const fehler: string[] = []; page.on('pageerror', e => fehler.push(e.message)); page.on('console', m => { if (m.type() === 'error') fehler.push(m.text()); });
    await oeffne(page, breite);
    await aktion(page, breite, 'Werte importieren');
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
    await aktion(page, breite, 'Import-Protokoll');
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
  await aktion(page, 375, 'Bezugsgröße anlegen');
  await page.getByRole('combobox', { name: 'Geltungsbereich', exact: true }).click();
  await expect(page.getByRole('option').filter({ hasText: 'Werk Ahrenberg' }).first()).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('option').filter({ hasText: 'Werk Lindach' }).first()).not.toHaveAttribute('aria-disabled', 'true');
  await oeffne(page, 375, '&bezugs=konflikt');
  await aktion(page, 375, 'Bezugsgröße anlegen');
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
    // Am Telefon trägt die Leiste Gruppen: „Messen“ öffnet die Gruppe, darüber steht der Reiter „Bezugsgrößen“.
    // N1: am Rechner stehen dieselben Gruppen in der Seitenleiste.
    if (breite === 375) await page.locator('.vp-bottombar').getByRole('button', { name: 'Messen', exact: true }).click();
    else await page.getByTestId('seitenleiste-messen').click();
    await page.getByRole('tab', { name: 'Bezugsgrößen', exact: true }).click();
    await expect(page).toHaveURL(/#\/portfolio\/bezugsgroessen$/);
    await expect(page.getByTestId('bezugsgroesse-reihe')).toHaveCount(6);
    await expect(page.getByText('Art nicht angegeben', { exact: true })).toHaveCount(0);
    await aktion(page, breite, 'Bezugsgröße anlegen');
    await expect(page.getByRole('dialog', { name: 'Bezugsgröße anlegen', exact: true })).toBeVisible();
  });
}
