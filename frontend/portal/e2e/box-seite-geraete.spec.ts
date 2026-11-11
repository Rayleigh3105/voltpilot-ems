import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * GE-4 „Box-Seite und Standort › Boxen" (Konzept „Ein Gerät, ein Eintrag“, entschieden 23.10.2026) bei 375 und
 * 1440 px auf der Bühne `e2e/anlagensteuerung.html?flaeche=box`: der Baustein „Geräte an dieser Box“ zählt dieselben
 * Kästen wie der Aufbau (GE-1) — Gore (Box + Anlagensteuerung + DQ-1) als EIN Eintrag mit Anbindung und Last, seit GE-3
 * mit ihren drei Wechselrichtern dahinter, die Gateway-Form als Gateway mit zwei Steuerungen darunter und einem offenen
 * Anschluss. Die Box-Zeile im Aufbau
 * (`flaeche=aufbau`, dort ist „Standort › Boxen“ seit 28.09.2026 aufgegangen) sagt „n Geräte · Last p %“ mit derselben
 * Last wie die Box-Seite. Kein Querlauf der Seite oder eines Elements, keine Fehler in der Konsole. Mit `BOX_SEITE_BILDER=<Ordner>` legt der Lauf je Form und Breite ein
 * Bild ab. Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf `import.meta.env` fehlt).
 */
const BREITEN = [375, 1440] as const;
const BILDER = process.env.BOX_SEITE_BILDER;
const STEUERUNG = '00000000-0000-4000-8000-00000000e221';

async function oeffne(page: Page, breite: number, frage: string) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.goto(`/e2e/anlagensteuerung.html?${frage}`);
  if (frage.includes('flaeche=box')) await expect(page.getByRole('heading', { name: 'Geräte an dieser Box' })).toBeVisible();
  return fehler;
}

async function ohneQuerlauf(page: Page, breite: number) {
  const m = await page.evaluate((b) => ({
    seite: document.documentElement.scrollWidth - window.innerWidth,
    draussen: [...document.querySelectorAll('.vp-main *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`),
  }), breite);
  expect(m.seite).toBe(0);
  expect(m.draussen).toEqual([]);
}

async function ablegen(page: Page, name: string) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.getByTestId('baustein-modul').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(BILDER, `${name}.png`), fullPage: true });
}

for (const breite of BREITEN) {
  test(`Gore: die Steuerung EINMAL — mit Anbindung, Last und Summe, keine Zeile für DQ-1 (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=box');
    const liste = page.getByTestId('box-geraete');
    // Die Steuerung und dahinter ihre drei Wechselrichter (GE-3) — jeder mit eigener Seite.
    await expect(liste.locator(':scope > li')).toHaveCount(4);
    expect(await liste.getByRole('link').evaluateAll((a) => a.map((x) => x.getAttribute('href')))).toEqual([
      `#/anlage/site-gore/geraet/edge-gore/as-${STEUERUNG}`,
      ...[1, 2, 3].map((n) => `#/anlage/site-gore/geraet/edge-gore/as-${STEUERUNG}~te-${n}`),
    ]);
    await expect(liste).toContainText('Anlagensteuerung Gore');
    await expect(liste).toContainText('WAGO PFC200 750-8212');
    await expect(liste).toContainText('Modbus TCP · 192.168.1.50:503 · Last 51 %');
    await expect(page.getByTestId('box-last')).toHaveText('Zusammen 12 von 30 Anfragen/min · 305 von 600 Messwerten/min · Last 51 %');
    // Bühne und Liste zählen dieselben Geräte — wie die Box-Zeile im Aufbau („4 Geräte“); WR 3 meldet „Werte ungültig“.
    await expect(page.getByTestId('geraet-heldsatz')).toHaveText('3 von 4 Geräten liefern Daten.');
    const modul = page.getByTestId('baustein-modul');
    await expect(modul).not.toContainText('DQ-1');
    await expect(modul).not.toContainText('Datenquellen und Geräte');
    await expect(modul.getByRole('button', { name: 'Zuständige Box wechseln für Anlagensteuerung Gore' })).toBeVisible();
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
    await ablegen(page, `gore-${breite}`);
  });

  test(`Gateway-Form: das Gateway mit seinen Geräten darunter, ein offener Anschluss (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=box&form=gateway');
    const gateway = page.locator('[data-box-weg="DQ-1"]');
    await expect(gateway).toContainText('Steuerungen Halle');
    await expect(gateway).toContainText('Modbus TCP · 192.168.1.50:503 · Geräte-IDs 1–2 · Kennung DQ-1');
    await expect(gateway).toContainText('2 Geräte · Last 51 %');
    const dahinter = gateway.getByRole('list', { name: 'Geräte hinter Steuerungen Halle' });
    // Zwei Steuerungen; die Wechselrichter der ersten (GE-3) stehen direkt hinter ihr.
    await expect(dahinter.getByRole('link')).toHaveCount(5);
    await expect(dahinter.getByRole('link').nth(1)).toContainText('WR Dach Nord');
    await expect(dahinter.getByRole('link').nth(4)).toContainText('Geräte-ID 2');
    // Den Box-Wechsel trägt das Gateway — er gilt für beide Steuerungen dahinter.
    await expect(gateway.getByRole('button', { name: /Zuständige Box wechseln/ })).toHaveCount(1);
    const offen = page.locator('[data-box-weg="DQ-2"]');
    await expect(offen).toContainText('Anschluss ohne Gerät');
    await expect(offen).toContainText('Kennung DQ-2');
    await expect(offen.getByRole('link', { name: 'Gerät an Anschluss DQ-2 hinzufügen' })).toHaveAttribute('href', '#/anlage/site-gore/modell?neu=geraet');
    // DQ-2 meldet keine Zahlen: es zählt nicht als Null, die Summe nennt es.
    await expect(page.getByTestId('box-last')).toHaveText(
      'Zusammen 12 von 30 Anfragen/min · 305 von 600 Messwerten/min · Last 51 % · ohne Meldung: DQ-2',
    );
    await expect(page.getByTestId('geraet-heldsatz')).toHaveText('4 von 5 Geräten liefern Daten.');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
    await ablegen(page, `gateway-${breite}`);
  });

  test(`Aufbau: die Box-Zeile sagt „n Geräte · Last p %“ — dieselbe Last wie die Box-Seite (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=aufbau');
    await expect(page.locator('.vp-auf-t-zeile.is-box')).toContainText('edge-gore · 4 Geräte · Last 51 %');
    await ohneQuerlauf(page, breite);
    const gateway = await oeffne(page, breite, 'fall=gore&flaeche=aufbau&form=gateway');
    await expect(page.locator('.vp-auf-t-zeile.is-box')).toContainText('5 Geräte · 1 Gateway · 1 Anschluss offen · Last 51 %');
    await ohneQuerlauf(page, breite);
    expect([...fehler, ...gateway]).toEqual([]);
    if (BILDER) {
      mkdirSync(BILDER, { recursive: true });
      await page.locator('.vp-auf-t-zeile.is-box').screenshot({ path: join(BILDER, `aufbau-box-zeile-${breite}.png`) });
    }
  });
}
