import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * GE-5 „Gateway-Seite" (Konzept „Ein Gerät, ein Eintrag“, entschieden 23.10.2026) bei 375 und 1440 px auf der Bühne
 * `e2e/anlagensteuerung.html?flaeche=gateway&form=gateway`: ein Weg mit zwei Steuerungen (Unit 1 und 2) ist ein Kasten
 * mit Seite im Geräteseiten-Rahmen — die Geräte dahinter mit ihren Seiten, die Anbindung mit Last und Box-Wechsel für
 * alle, ihr Verlauf und „Gerät an diesem Gateway hinzufügen“ mit vorbelegtem Weg. Aufbau-Zeile, Box-Seite und das Gerät
 * dahinter (GE-2) führen auf diese Seite. Gegenprobe: ein Weg mit genau einem Gerät (Gore, 1 : 1) bekommt keine.
 * Kein Querlauf der Seite oder eines Elements, keine Fehler in der Konsole. Mit `GATEWAY_SEITE_BILDER=<Ordner>` legt
 * der Lauf je Breite ein Bild ab. Die Spec importiert keine Fixtures (sie laden `api.ts`, dem im Node-Lauf
 * `import.meta.env` fehlt).
 */
const BREITEN = [375, 1440] as const;
const BILDER = process.env.GATEWAY_SEITE_BILDER;
const STEUERUNG = '00000000-0000-4000-8000-00000000e221';
const SEITE = '#/anlage/site-gore/geraet/edge-gore/dq-1';

async function oeffne(page: Page, breite: number, frage: string, hash = '') {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  const fehler: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') fehler.push(m.text());
  });
  await page.goto(`/e2e/anlagensteuerung.html?${frage}${hash}`);
  return fehler;
}

/** „Gerät & Verbindung" ist am Telefon zugeklappt (Rahmen-Regel) — aufklappen, wo die Anbindung gelesen wird. */
async function details(page: Page) {
  const sektion = page.getByTestId('baustein-details');
  if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
  return sektion;
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

for (const breite of BREITEN) {
  test(`Gateway-Seite: Geräte dahinter, Anbindung für alle, Hinzufügen mit Weg (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=gateway&form=gateway');
    const rahmen = page.getByTestId('gateway-rahmen');
    await expect(rahmen.getByRole('heading', { level: 1 })).toHaveText('Steuerungen Halle');
    await expect(page.getByRole('heading', { name: 'Geräte an diesem Gateway' })).toBeVisible();

    const liste = page.getByTestId('gateway-geraete');
    expect(await liste.getByRole('link').evaluateAll((a) => a.map((x) => x.getAttribute('href')))).toEqual([
      `#/anlage/site-gore/geraet/edge-gore/as-${STEUERUNG}`,
      `#/anlage/site-gore/geraet/edge-gore/as-${STEUERUNG}-unit2`,
    ]);
    await expect(liste.getByRole('link').nth(0)).toContainText('Geräte-ID 1');
    await expect(liste.getByRole('link').nth(1)).toContainText('Geräte-ID 2');
    await expect(page.getByTestId('gateway-geraete-satz')).toHaveText('2 Geräte · 2 liefern Daten');

    const anbindung = (await details(page)).getByTestId('geraet-anbindung');
    await expect(anbindung).toBeVisible();
    await expect(anbindung).toContainText('Modbus TCP · 192.168.1.50:503 · Geräte-IDs 1–2');
    await expect(anbindung).toContainText('51 %');
    await expect(anbindung).toContainText('Box und Last gelten für alle 2 Geräte an diesem Gateway');
    await expect(anbindung).toContainText('Kennung DQ-1');
    await expect(anbindung.getByRole('button', { name: 'Zuständige Box wechseln' })).toBeVisible();
    await expect(page.getByTestId('gateway-hinzufuegen')).toHaveAttribute('href', '#/anlage/site-gore/modell?neu=geraet&an=DQ-1');

    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
    if (BILDER) {
      mkdirSync(BILDER, { recursive: true });
      await page.screenshot({ path: join(BILDER, `gateway-${breite}.png`), fullPage: true });
    }
  });

  test(`Gateway-Seite › Technik: „Verlauf der Anbindung“ (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=gateway&form=gateway', `${SEITE}?ansicht=technik&abschnitt=anbindung`);
    const verlauf = page.getByTestId('anbindung-verlauf');
    await expect(verlauf).toContainText('Zuständigkeit begonnen');
    await expect(verlauf).toContainText('Datenquelle angelegt: Anlagensteuerung');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Aufbau, Box-Seite und das Gerät dahinter führen auf die Gateway-Seite (${breite} px)`, async ({ page }) => {
    const aufbau = await oeffne(page, breite, 'fall=gore&flaeche=aufbau&form=gateway');
    const zeile = page.locator('.vp-auf-t-zeile.is-gateway');
    await expect(zeile.getByRole('link', { name: 'Steuerungen Halle' })).toHaveAttribute('href', SEITE);
    await ohneQuerlauf(page, breite);

    const box = await oeffne(page, breite, 'fall=gore&flaeche=box&form=gateway');
    await expect(page.locator('[data-box-weg="DQ-1"] > a.vp-geraet-zeile')).toHaveAttribute('href', SEITE);
    await ohneQuerlauf(page, breite);

    const geraet = await oeffne(page, breite, 'fall=gore&flaeche=geraet&form=gateway');
    await expect(page.getByRole('heading', { name: 'Anlagensteuerung Gore' }).first()).toBeVisible();
    await expect((await details(page)).getByTestId('geraet-anbindung').getByRole('link', { name: /Gateway DQ-1 \(2 Geräte\)/ }))
      .toHaveAttribute('href', SEITE);
    await ohneQuerlauf(page, breite);
    expect([...aufbau, ...box, ...geraet]).toEqual([]);
  });

  test(`Gegenprobe 1 : 1 — Gore hat keine Gateway-Seite, sondern den Weg zur Steuerung (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=gateway');
    const fehlt = page.getByTestId('gateway-fehlt');
    await expect(fehlt).toContainText('DQ-1 ist die Anbindung von');
    await expect(fehlt.getByRole('link', { name: /^Zu / })).toHaveAttribute('href', `#/anlage/site-gore/geraet/edge-gore/as-${STEUERUNG}`);
    await expect(page.getByTestId('gateway-rahmen')).toHaveCount(0);
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });
}
