import { expect, test, type Page } from '@playwright/test';

/**
 * GE-3 „Wechselrichter hinter der Steuerung als Geräte“ (Konzept „Ein Gerät, ein Eintrag“, GD-2 A vom 23.10.2026) bei
 * 375 und 1440 px auf der Bühne `e2e/anlagensteuerung.html`: Gore zeigt im Aufbau die Anlagensteuerung und darunter
 * drei Growatt-Wechselrichter („4 Geräte“), jeder mit eigener Seite `as-<Entität>~te-<n>`; Steuerung › Geräte und der
 * Verlauf-Ast führen dorthin. Kein Querlauf, keine Fehler in der Konsole — GEMESSEN, nicht behauptet.
 */
const BREITEN = [375, 1440] as const;
const ENTITY_GORE = '00000000-0000-4000-8000-00000000e221';
const SEITE = (te: number) => `#/anlage/site-gore/geraet/edge-gore/as-${ENTITY_GORE}~te-${te}`;

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
  test(`Aufbau: die Steuerung mit drei Wechselrichtern darunter, „4 Geräte“ (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=aufbau');
    await expect(page.locator('.vp-auf-t-zeile.is-box')).toContainText('· 4 Geräte');
    const zeilen = page.locator('.vp-auf-t-zeile.is-geraet');
    await expect(zeilen).toHaveCount(4);
    await expect(zeilen.nth(0)).toContainText('Anlagensteuerung Gore');
    const einheiten = page.locator('.vp-auf-t-zeile.is-einheit');
    await expect(einheiten).toHaveCount(3);
    // Name oder „Wechselrichter n“, Typ · Nennleistung, Ist-Leistung, Zustand je Einheit.
    await expect(einheiten.nth(0)).toContainText('WR Dach Nord');
    await expect(einheiten.nth(0)).toContainText('Growatt MAX 125KTL3-X · 125');
    await expect(einheiten.nth(0).locator('.vp-auf-t-wert')).toHaveText(/52,8\s?kW/);
    await expect(einheiten.nth(0)).toContainText('Läuft begrenzt');
    await expect(einheiten.nth(1)).toContainText('Wechselrichter 2');
    // WR 3 ohne Gültigkeitsbit: „—“, nie 0.
    await expect(einheiten.nth(2)).toContainText('Wechselrichter 3');
    await expect(einheiten.nth(2).locator('.vp-auf-t-wert')).toHaveText('—');
    await expect(einheiten.nth(2)).toContainText('Werte ungültig');
    // Die Einheiten stehen eingerückt unter der Steuerung.
    const einzug = await zeilen.evaluateAll((z) => z.map((x) => (x.querySelector('.vp-auf-t-titel') as HTMLElement).getBoundingClientRect().left));
    expect(einzug[1]).toBeGreaterThan(einzug[0]);
    expect(new Set(einzug.slice(1)).size).toBe(1);
    await ohneQuerlauf(page, breite);
    // Ein Tipp öffnet den Kurzblick; von dort führt „Geräteseite öffnen“ auf die Seite der Einheit.
    await einheiten.nth(1).locator('.vp-auf-t-titel').click();
    const blick = page.getByRole('dialog');
    await expect(blick).toContainText('Wechselrichter 2');
    await expect(blick).toContainText('gelesen über Anlagensteuerung Gore');
    await expect(blick.getByRole('link', { name: /Geräteseite öffnen/ })).toHaveAttribute('href', SEITE(2));
    await expect(blick).not.toContainText('Register lesen und schreiben');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Seite eines Wechselrichters: Jetzt, Heute mit Energie, Aktivität, Gerät & Verbindung (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=gore&flaeche=einheit&te=2');
    await expect(page.getByRole('heading', { level: 1, name: 'Wechselrichter 2' })).toBeVisible();
    await expect(page.getByTestId('einheit-ueber-steuerung')).toHaveAttribute('href', `#/anlage/site-gore/geraet/edge-gore/as-${ENTITY_GORE}`);
    const held = page.getByTestId('geraet-held');
    await expect(held).toContainText('53,1');
    await expect(held).toContainText(/Soll 53,0\s?kW · folgt/);
    await expect(held).toContainText('Begrenzung der Anlage');
    await expect(page.getByTestId('einheit-energie-heute')).toContainText(/Energie heute \d[\d.]*\s?kWh/);
    await expect(page.getByTestId('einheit-aktivitaet').or(page.getByTestId('einheit-aktivitaet-leer'))).toBeVisible();
    const sektion = page.getByTestId('baustein-details');
    if (!(await sektion.evaluate((el) => (el as HTMLDetailsElement).open))) await sektion.locator(':scope > summary').click();
    const details = sektion.getByTestId('einheit-details');
    await expect(details).toContainText('Einheit 2 · Register 48–57');
    await expect(details.getByRole('link', { name: /Anlagensteuerung Gore/ })).toBeVisible();
    await expect(details).toContainText('VoltPilot-Box Box Gore');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Büttner: die Seite eines BHKW-Motors mit Abruf des Direktvermarkters (${breite} px)`, async ({ page }) => {
    const fehler = await oeffne(page, breite, 'fall=buettner&flaeche=einheit&te=1');
    await expect(page.getByRole('heading', { level: 1, name: 'Motor 1' })).toBeVisible();
    const held = page.getByTestId('geraet-held');
    await expect(held).toContainText('64,0');
    await expect(held).toContainText('Vom Direktvermarkter abgerufen');
    await expect(page.getByTestId('einheit-energie-heute')).toContainText('kWh');
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);
  });

  test(`Steuerung › Geräte und Verlauf führen auf die Seiten der Wechselrichter (${breite} px)`, async ({ page }) => {
    let fehler = await oeffne(page, breite, 'fall=gore&flaeche=steuerung');
    const links = page.getByTestId('erz-einheit-link');
    await expect(links).toHaveCount(3);
    expect(await links.evaluateAll((a) => a.map((x) => x.getAttribute('href')))).toEqual([1, 2, 3].map(SEITE));
    await ohneQuerlauf(page, breite);
    expect(fehler).toEqual([]);

    fehler = await oeffne(page, breite, 'fall=gore&flaeche=verlauf');
    const sprunge = page.getByTestId('verlauf-sprunge').first();
    await expect(sprunge).toBeAttached();
    expect(await sprunge.locator('a').evaluateAll((a) => a.map((x) => x.getAttribute('href')))).toEqual([1, 2, 3].map(SEITE));
    expect(fehler).toEqual([]);
  });
}
