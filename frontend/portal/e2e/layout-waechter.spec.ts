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
 *   unter dem Fluss steht kein leerer Streifen, und im Fahrplan stehen Status,
 *   Uhr und Kacheln im ersten Bildschirm.
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
  // Der Leitungsplan der Bühne (Konzept „Cockpit als Tagesfilm“): Knoten
  // sind Knöpfe mit Symbol, die Spuren eine SVG-Fläche darunter.
  const fluss = page.locator('.vp-hero-flow .vp-lp').first();
  await expect(fluss).toBeVisible();

  const mass = await fluss.evaluate((el) => {
    const wrap = el.parentElement!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const symbole = [...el.querySelectorAll('.vp-lp-knoten svg')].map((s) => {
      const b = s.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height) };
    });
    // Unterkante des tatsächlich Gezeichneten: Knoten und Beschriftungen.
    const inhaltUnten = Math.max(
      ...[...el.querySelectorAll('.vp-lp-knoten, .vp-lp-batt, .vp-lp-lab')].map((e) => e.getBoundingClientRect().bottom),
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

/**
 * Die Einführung der Tagesuhr startet beim ersten Besuch von selbst (E11) -
 * die Hilfe-Fixtures sind ein erster Besuch. Die Messungen gelten dem
 * Alltag danach; der Wächter beendet sie deshalb wie ein Kunde.
 */
test('Fahrplan: das Tagesbild passt, Symbole bleiben Symbole, nichts ragt über den Rand', async ({ page }) => {
  await oeffnen(page, FAHRPLAN);
  await page.locator('.vp-tb').first().waitFor();

  const mass = await page.locator('.vp-tb').first().evaluate((card) => {
    const k = card.getBoundingClientRect();
    // Am Telefon und Tablet die Uhr, ab 900 px Inhaltsbreite das Tagesband.
    const bild = card.querySelector('.vp-uhr-svg, .vp-tband-svg')!;
    const b = bild.getBoundingClientRect();
    // Die Symbole der Tätigkeiten sind verschachtelte <svg> (`Icon`) - der
    // Fehler des Energieflusses (V-07) darf sich hier nicht wiederholen.
    const symbole = [...bild.querySelectorAll('svg')].map((s) => {
      const r = s.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      art: bild.classList.contains('vp-uhr-svg') ? 'uhr' : 'tagesband',
      karteLinks: k.left,
      karteRechts: k.right,
      bildLinks: b.left,
      bildRechts: b.right,
      bildHoehe: b.height,
      symbole,
    };
  });

  const breite = page.viewportSize()?.width ?? 0;
  expect(mass.art, 'Uhr bis 900 px Inhaltsbreite, darüber das Tagesband').toBe(breite >= 1200 ? 'tagesband' : 'uhr');
  expect(mass.bildHoehe, 'das Tagesbild hat eine Fläche').toBeGreaterThan(150);
  expect(mass.bildLinks).toBeGreaterThanOrEqual(mass.karteLinks - 1);
  expect(mass.bildRechts).toBeLessThanOrEqual(mass.karteRechts + 1);
  expect(mass.symbole.length, 'die Tätigkeiten tragen Symbole').toBeGreaterThan(0);
  for (const s of mass.symbole) {
    expect(s.w, `Symbol ${s.w}×${s.h} px ist aufgeblasen`).toBeLessThanOrEqual(24);
    expect(s.h, `Symbol ${s.w}×${s.h} px ist aufgeblasen`).toBeLessThanOrEqual(24);
  }
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);

  // Neben dem Tagesbild steht kein zweites Bild desselben Tages, kein Film
  // und kein „Mehr erklären". Das bisherige Diagramm öffnet sich nur als
  // Dialog „Alle Werte" (am Telefon in „Gut zu wissen").
  await expect(page.locator('.vp-uhr-svg, .vp-tband-svg')).toHaveCount(1);
  await expect(page.locator('.vp-film')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Mehr erklären/ })).toHaveCount(0);
  const wissen = page.getByRole('button', { name: 'Gut zu wissen' });
  if (await wissen.count()) await wissen.click();
  await expect(page.getByRole('button', { name: /Alle Werte im Diagramm/ })).toHaveCount(1);
});

/**
 * Der erste Bildschirm (Überblick 20.10.2026, Variante A: „in fünf Sekunden
 * verstehen, was abgeht"): am Telefon stehen Tagesschalter, die Status-Zeile,
 * die Uhr und die Kacheln GANZ im ersten Bildschirm (375 × 812, über der
 * unteren Leiste) - in dieser Reihenfolge. Am Rechner stehen Status und
 * Kacheln in der Jetzt-Karte über dem Tagesband, und das Band beginnt im
 * ersten Bildschirm.
 *
 * Seit dem Tagesschalter (25.09.2026) trägt der Fahrplan wie seine Reiter
 * Preise und Wetter keinen SICHTBAREN Seitenkopf: die Reiterleiste springt
 * nicht, und das Tagesbild bekommt den Platz.
 */
test('Fahrplan: Status, Uhr und Kacheln im ersten Bildschirm', async ({ page }) => {
  await oeffnen(page, FAHRPLAN);
  await page.locator('.vp-tb-status').first().waitFor();
  // Die Überschrift ist da - für Screenreader, nicht auf der Fläche.
  await expect(page.locator('main h1', { hasText: 'Fahrplan' })).toHaveClass(/vp-sr-only/);

  const mass = await page.evaluate(() => {
    const leiste = document.querySelector('.vp-bottombar');
    const leisteOben = leiste && leiste.getBoundingClientRect().height > 0 ? leiste.getBoundingClientRect().top : innerHeight;
    const r = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    return {
      sichtbarBis: Math.min(innerHeight, leisteOben),
      tage: r('.vp-tb-tage'),
      status: r('.vp-tb-status'),
      bild: r('.vp-uhr, .vp-tband'),
      uhr: document.querySelector('.vp-uhr') != null,
      kacheln: [...document.querySelectorAll('.vp-antw-zeile')].map((el) => {
        const b = el.getBoundingClientRect();
        return { top: b.top, bottom: b.bottom };
      }),
    };
  });
  expect(mass.kacheln.length, 'Kacheln zum Tag').toBeGreaterThanOrEqual(1);
  expect(mass.tage!.top, 'der Tagesschalter (E2) steht über der Status-Zeile').toBeLessThan(mass.status!.top);
  if (mass.uhr) {
    // Telefon und Tablet: Status über der Uhr (Tablet: daneben), Kacheln unter Status und Uhr.
    expect(mass.status!.bottom).toBeLessThanOrEqual(mass.sichtbarBis);
    expect(mass.bild!.bottom, 'die ganze Uhr im ersten Bildschirm').toBeLessThanOrEqual(mass.sichtbarBis + 1);
    for (const k of mass.kacheln) {
      expect(k.bottom, 'eine Kachel ragt unter den ersten Bildschirm').toBeLessThanOrEqual(mass.sichtbarBis + 1);
      expect(k.top).toBeGreaterThan(mass.status!.top);
    }
  } else {
    // Rechner: die Kacheln stehen in der Jetzt-Karte über dem Band, das Band beginnt im ersten Bildschirm.
    for (const k of mass.kacheln) expect(k.bottom).toBeLessThanOrEqual(mass.bild!.top);
    expect(mass.bild!.top, 'das Tagesband beginnt im ersten Bildschirm').toBeLessThan(mass.sichtbarBis - 100);
  }
});

/**
 * Befund B1 für den Fahrplan-Bereich: ein Kopf nur über „Fahrplan" ließ die
 * Reiterleiste beim Wechsel zu Preise und Wetter um 140 px springen.
 */
test('Fahrplan: die Reiterleiste steht auf Fahrplan, Preise und Wetter an derselben Stelle', async ({ page }) => {
  const oben: number[] = [];
  for (const reiter of ['fahrplan', 'marktpreise', 'wetter']) {
    await oeffnen(page, `/e2e/help.html#/anlage/help-site/${reiter}`);
    const leiste = page.getByRole('tablist', { name: /Reiter des Bereichs/ });
    await leiste.waitFor();
    oben.push(Math.round((await leiste.boundingBox())!.y));
  }
  expect(oben, 'Oberkante der Reiterleiste je Reiter').toEqual([oben[0], oben[0], oben[0]]);
});
