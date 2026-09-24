import { expect, test, type Page } from '@playwright/test';

/**
 * **Layout-Wächter für Cockpit und Fahrplan** (UX-Review V-07, 24.09.2026).
 *
 * Der Anlass: die Symbole in den Kreisen des Energieflusses wurden auf die
 * ganze Diagrammfläche aufgeblasen (eine Regel `.vp-flow-wrap svg` traf auch
 * die verschachtelten Symbol-SVGs) - in Chromium 141 ja, in 151 nein. Kein
 * Test hat es bemerkt, weil keiner die Seite im Browser VERMESSEN hat.
 *
 * ⚠ GEOMETRIE STATT PIXELVERGLEICH: ein `toHaveScreenshot` bräuchte eine
 *   Basis je Browser-Version und Schriftsatz, und jede Chromium-Aktualisierung
 *   verschöbe Kantenglättung und Schrift um Pixel. Der Wächter fragt deshalb
 *   nach den Eigenschaften, die ein Kunde als Fehler sieht - und die in jedem
 *   Browser gleich gelten: Symbole bleiben Symbole, nichts ragt über den Rand,
 *   unter dem Fluss steht kein leerer Streifen, der Fahrplan hat EINE Legende
 *   unter dem Bild und bleibt kurz genug zum Lesen.
 *
 * Er läuft in jedem Projekt der Konfiguration, also auch in `mobile-webkit`
 * (Safari). Breiten nach Portal-Regel: 1440 am Rechner, 375 am Telefon.
 * Daten: die fiktiven Hilfe-Fixtures bei fester Uhr.
 */

const COCKPIT = '/e2e/help.html#/anlage/help-site';
const FAHRPLAN = '/e2e/help.html#/anlage/help-site/fahrplan';

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

test.beforeEach(async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date('2026-09-10T10:00:00Z'));
  const name = testInfo.project.name;
  if (name.startsWith('mobile')) await page.setViewportSize({ width: 375, height: 812 });
  else if (name.startsWith('desktop')) await page.setViewportSize({ width: 1440, height: 1000 });
});

async function oeffnen(page: Page, url: string) {
  await page.goto(url);
  await page.locator('.vp-app').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Wie weit die Seite waagrecht über den Bildschirm ragt (0 = gar nicht). */
const ueberlauf = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('Cockpit: Energiefluss-Symbole bleiben Symbole, nichts ragt über den Rand', async ({ page }) => {
  await oeffnen(page, COCKPIT);
  const flussSvg = page.locator('.vp-flow-adaptive > svg').first();
  await expect(flussSvg).toBeVisible();

  const mass = await flussSvg.evaluate((svg) => {
    const wrap = svg.parentElement!.getBoundingClientRect();
    const r = svg.getBoundingClientRect();
    // Die Symbole der Kreise sind verschachtelte <svg> (`Icon`).
    const symbole = [...svg.querySelectorAll('svg')].map((s) => {
      const b = s.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    });
    // Unterkante des tatsächlich Gezeichneten: Kreise und Beschriftungen.
    const inhaltUnten = Math.max(
      ...[...svg.querySelectorAll('circle, text')].map((el) => el.getBoundingClientRect().bottom),
    );
    return {
      symbole,
      diagrammBreite: r.width,
      wrapBreite: wrap.width,
      leerUnten: r.bottom - inhaltUnten,
    };
  });

  expect(mass.symbole.length, 'der Fluss zeichnet Symbole in seine Kreise').toBeGreaterThan(0);
  for (const s of mass.symbole) {
    expect(s.w, `Symbol ${s.w}×${s.h} px ist aufgeblasen`).toBeLessThanOrEqual(32);
    expect(s.h, `Symbol ${s.w}×${s.h} px ist aufgeblasen`).toBeLessThanOrEqual(32);
  }
  expect(mass.diagrammBreite).toBeLessThanOrEqual(mass.wrapBreite + 1);
  // Gemessen (Chromium, Hilfe-Fixtures): 28-34 px nach der Korrektur F-03,
  // rund 125 px leere Karte unter „Laden" davor. 60 lässt Safari Luft für
  // seine Schriftmetrik und fängt den alten Fehler sicher.
  expect(mass.leerUnten, 'leerer Streifen unter dem Energiefluss').toBeLessThanOrEqual(60);
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
});

test('Fahrplan: ein Bild, eine Legende darunter, nichts ragt über den Rand', async ({ page }) => {
  await oeffnen(page, FAHRPLAN);
  const karte = page.locator('.vp-card:has(.vp-chart.panels)').first();
  const leinwand = karte.locator('.vp-chart.panels canvas').first();
  await expect(leinwand).toBeVisible();

  const mass = await karte.evaluate((card) => {
    const k = card.getBoundingClientRect();
    const bild = card.querySelector('.vp-chart.panels')!.getBoundingClientRect();
    const legenden = [...card.querySelectorAll('.vp-chart-legend, .vp-sched-bandlegend')].filter(
      (el) => (el as HTMLElement).offsetParent !== null,
    );
    return {
      karteLinks: k.left,
      karteRechts: k.right,
      bildLinks: bild.left,
      bildRechts: bild.right,
      bildHoehe: bild.height,
      bildUnten: bild.bottom,
      legenden: legenden.length,
      legendeOben: legenden[0]?.getBoundingClientRect().top ?? null,
    };
  });

  expect(mass.bildHoehe, 'das Diagramm hat eine Fläche').toBeGreaterThan(150);
  expect(mass.bildLinks).toBeGreaterThanOrEqual(mass.karteLinks - 1);
  expect(mass.bildRechts).toBeLessThanOrEqual(mass.karteRechts + 1);
  // V-06: genau EINE Legende, und zwar unter dem Bild.
  expect(mass.legenden, 'Anzahl sichtbarer Legenden in der Diagramm-Karte').toBe(1);
  expect(mass.legendeOben!).toBeGreaterThanOrEqual(mass.bildUnten - 1);
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);
});

test('Fahrplan: die Seite bleibt kurz genug zum Lesen', async ({ page }) => {
  await oeffnen(page, FAHRPLAN);
  await expect(page.locator('.vp-chart.panels canvas').first()).toBeVisible();
  // V-03: der Untertitel ist EINE Zeile, auch bei 375 px.
  const zeilen = await page
    .locator('main h1')
    .first()
    .evaluate((h) => {
      const p = h.parentElement!.querySelector('p')!;
      return p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight);
    });
  expect(Math.round(zeilen), 'Zeilen des Untertitels').toBe(1);
  const hoehe = await page.locator('main').first().evaluate((m) => m.getBoundingClientRect().height);
  // Gemessen (Chromium, Hilfe-Fixtures) vor/nach V-02 und V-06: Rechner
  // 1888 → 1539 px, Tablet 1915 → 1565 px, Telefon 2106 → 1586 px. Die Grenze
  // lässt Luft für Schrift und Browser und fängt den alten Aufbau überall.
  expect(hoehe, 'Höhe der Fahrplan-Seite in px').toBeLessThanOrEqual(1750);
});
