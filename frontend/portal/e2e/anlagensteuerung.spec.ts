import { expect, test, type Page } from '@playwright/test';

/**
 * UEMS EZ-10 „Steuerung, Anlage, Messwerte“ bei 375 und 1440 px auf der Bühne `e2e/anlagensteuerung.html`:
 * die Karte in Steuerung › Geräte (nur messen), die Geräteseite der Anlagensteuerung (mit ihrer Anbindung, GE-2), „Strom & Geld“ und der
 * Ast im Verlauf - mit den fiktiven Anlagen Gore (PV) und Büttner (BHKW). Kein Querlauf der Seite oder eines
 * Elements, keine Fehler in der Konsole - GEMESSEN, nicht behauptet.
 */
const BREITEN = [375, 1440] as const;

async function oeffne(page: Page, breite: number, frage: string) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.goto(`/e2e/anlagensteuerung.html?${frage}`);
  return fehler;
}

async function ohneQuerlauf(page: Page, breite: number) {
  const m = await page.evaluate((b) => ({
    seite: document.documentElement.scrollWidth - window.innerWidth,
    draussen: [...document.querySelectorAll('.vp-main *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-rahmen-chips, .vp-verlauf-chart'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
  expect(m.seite).toBe(0);
  expect(m.draussen).toEqual([]);
}

for (const breite of BREITEN) {
  test(`Steuerung › Geräte: wer steuert, je Motor Soll, Ist, folgt, Grund (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=buettner&flaeche=steuerung');
    await expect(page.getByText('Gesteuert wird sie vom Netzbetreiber N-ERGIE Netz GmbH und vom Direktvermarkter WVV.', { exact: false })).toBeVisible();
    const motoren = page.getByTestId('erz-einheit');
    await expect(motoren).toHaveCount(2);
    await expect(motoren.nth(0)).toContainText('folgt');
    await expect(motoren.nth(1)).toContainText('nicht bereit für den Direktvermarkter: Wartung, Gasspeicher leer');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Geräteseite: die Anlagensteuerung mit ihren Einheiten (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=geraet');
    await expect(page.getByRole('heading', { name: 'Anlagensteuerung Gore' }).first()).toBeVisible();
    await expect(page.getByText('Die Anlage erzeugt gerade 158,9', { exact: false })).toBeVisible();
    // Die Aktivität fragt über die Komponente - nie „Gerät nicht gefunden.“ (EZ-19).
    const aktivitaet = page.getByTestId('baustein-aktivitaet');
    await expect(aktivitaet).toContainText('Für diesen Zeitraum liegt uns nichts vor');
    await expect(aktivitaet).not.toContainText('Gerät nicht gefunden');
    const sektion = page.getByTestId('baustein-details');
    if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
    const einheiten = sektion.getByTestId('geraet-einheiten');
    await expect(einheiten).toContainText('WR Dach Nord');
    await expect(einheiten).toContainText('läuft begrenzt');
    await expect(sektion.getByText('Energiekarten')).toHaveCount(0);
    await expect(sektion.getByTestId('geraet-anlagensteuerung')).toContainText('speist 41,2');
    // Den Programmstand zeigt EZ-16 an derselben Karte.
    await expect(sektion.getByTestId('geraet-programmstand')).toContainText('26.10');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Geräteseite: die Anbindung der Steuerung - Weg, lesende Box, Empfang, Last, Verlauf (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=geraet');
    await expect(page.getByRole('heading', { name: 'Anlagensteuerung Gore' }).first()).toBeVisible();
    const sektion = page.getByTestId('baustein-details');
    if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
    // GE-2: der Weg ist Teil der Seite des Kastens, an dem er endet - genau einmal, „Datenquelle“ nur noch klein als Kennung.
    const anbindung = sektion.getByTestId('geraet-anbindung');
    await expect(anbindung).toContainText('Modbus TCP · 192.168.1.50:503 · Geräte-ID 1');
    await expect(anbindung.getByRole('link', { name: /VoltPilot-Box Box Gore/ })).toHaveAttribute('href', '#/anlage/site-gore/box/edge-gore');
    await expect(anbindung).toContainText('Liefert Daten');
    await expect(anbindung).toContainText('12 von 30 Anfragen/min · 305 von 600 Messwerten/min');
    await expect(anbindung).toContainText('Kennung DQ-1');
    await expect(anbindung.getByRole('button', { name: 'Zuständige Box wechseln' })).toBeVisible();
    await expect(sektion).not.toContainText('Datenquelle DQ-1');
    await expect(page.getByTestId('geraet-zustand')).not.toContainText('Liefert keine Daten');
    await ohneQuerlauf(page, breite);
    await page.getByTestId('geraet-technik-oeffnen').click();
    const verlauf = page.getByTestId('anbindung-verlauf');
    await expect(verlauf).toContainText('Zuständigkeit begonnen');
    await expect(verlauf).toContainText('Box Gore · Ines Kaltenbach');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Strom & Geld: Netzbetreiber, Direktvermarkter, Einspeisemanagement, Einheiten (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=buettner&flaeche=einstellungen');
    const geld = page.locator('#technik-geld');
    await expect(geld.getByRole('button', { name: /^Direktvermarkter/ })).toContainText('WVV · über Relais und 4–20 mA');
    await expect(geld.getByRole('button', { name: /^Einspeisemanagement/ })).toContainText('Stufen');
    await expect(geld.getByRole('button', { name: /^Motor 1/ })).toContainText('MaStR-Nummer nicht erfasst');
    await ohneQuerlauf(page, breite);
    await geld.getByRole('button', { name: /^Direktvermarkter/ }).click();
    await expect(page.getByRole('dialog').getByLabel('Direktvermarkter')).toHaveValue('WVV');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  // GE-1 „je Kasten ein Eintrag“ (Konzept „Ein Gerät, ein Eintrag“, entschieden 23.10.2026): die Steuerung und ihr
  // Weg DQ-1 sind EINE Zeile — der Weg steht als zweite Textzeile darunter, keine Zeile „DQ-1 · Datenquelle“ mehr.
  // Seit GE-3 stehen ihre drei Wechselrichter darunter (eigene Spec `anlagensteuerung-einheiten.spec.ts`).
  test(`Aufbau: die Anlagensteuerung ist EIN Eintrag mit ihrer Anbindung (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=aufbau');
    const geraete = page.locator('.vp-auf-t-zeile.is-geraet:not(.is-einheit)');
    await expect(geraete).toHaveCount(1);
    await expect(geraete.first()).toContainText('Anlagensteuerung Gore');
    await expect(geraete.first()).toContainText('WAGO PFC200 750-8212');
    await expect(geraete.first().locator('.vp-auf-t-anbindung')).toHaveText('Anbindung: Modbus TCP · 192.168.1.50:503');
    await expect(geraete.first()).toContainText('Liefert Daten');
    await expect(page.locator('[data-aufbau-weg]')).toHaveCount(0);
    await expect(page.locator('.vp-auf-t-zeile.is-box')).toContainText('· 4 Geräte');
    await expect(page.locator('.vp-auf-t')).not.toContainText('Datenquelle');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Aufbau: zwei Steuerungen an einem Weg sind ein Gateway, ein Weg ohne Gerät ein offener Anschluss (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=aufbau&form=gateway');
    const gateway = page.locator('.vp-auf-t-zeile.is-gateway');
    await expect(gateway).toHaveCount(1);
    await expect(gateway).toContainText('Steuerungen Halle');
    await expect(gateway).toContainText('Geräte-IDs 1–2');
    await expect(gateway).toContainText('2 Geräte');
    // Die Geräte stehen eine Ebene unter dem Gateway, in Lese-Reihenfolge direkt danach; die Wechselrichter der
    // ersten Steuerung (GE-3) eine Ebene unter ihr.
    const reihe = await page.locator('.vp-auf-t-zeile').evaluateAll((zeilen) =>
      zeilen
        .map((z) => (z.classList.contains('is-gateway') ? 'gateway' : z.classList.contains('is-geraet')
          ? `${z.classList.contains('is-einheit') ? 'einheit' : 'geraet'}:${(z as HTMLElement).style.getPropertyValue('--ebene')}` : null))
        .filter(Boolean),
    );
    expect(reihe).toEqual(['gateway', 'geraet:3', 'einheit:4', 'einheit:4', 'einheit:4', 'geraet:3']);
    await expect(page.locator('.vp-auf-t-zeile.is-geraet:not(.is-einheit)').nth(1)).toContainText('Geräte-ID 2');
    const anschluss = page.locator('.vp-auf-t-zeile.is-anschluss');
    await expect(anschluss).toContainText('Anschluss ohne Gerät');
    await expect(anschluss).toContainText('Kennung DQ-2');
    await expect(anschluss.getByRole('button', { name: 'Gerät an Anschluss DQ-2 hinzufügen' })).toBeVisible();
    await expect(page.locator('.vp-auf-t-zeile.is-box')).toContainText('5 Geräte · 1 Gateway · 1 Anschluss offen');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Verlauf › Messwerte: der Ast der Anlagensteuerung (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=verlauf');
    await expect(page.getByText('WR Dach Nord · Ist').first()).toBeAttached();
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });
}
