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
 *   unter dem Fluss steht kein leerer Streifen, und im Fahrplan beginnen alle
 *   Antworten im ersten Bildschirm (E9).
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

/**
 * Die Einführung der Tagesuhr startet beim ersten Besuch von selbst (E11) -
 * die Hilfe-Fixtures sind ein erster Besuch. Die Messungen gelten dem
 * Alltag danach; der Wächter beendet sie deshalb wie ein Kunde.
 */
async function einfuehrungBeenden(page: Page) {
  const beenden = page.getByRole('button', { name: 'Beenden' });
  if (await beenden.count()) await beenden.first().click();
}

test('Fahrplan: das Tagesbild passt, Symbole bleiben Symbole, nichts ragt über den Rand', async ({ page }) => {
  await oeffnen(page, FAHRPLAN);
  await page.locator('.vp-tb').first().waitFor();
  // Das Blatt der Einführung (Telefon) liegt innerhalb des Bildschirms.
  const blatt = page.locator('.vp-tb-tour.is-blatt');
  if (await blatt.count()) {
    const b = await blatt.first().boundingBox();
    expect(b!.x).toBeGreaterThanOrEqual(-1);
    expect(b!.x + b!.width).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1);
  }
  await einfuehrungBeenden(page);

  const mass = await page.locator('.vp-tb').first().evaluate((card) => {
    const k = card.getBoundingClientRect();
    // Am Telefon und Tablet die Uhr, ab 900 px Inhaltsbreite der Bildfahrplan (E10).
    const bild = card.querySelector('.vp-uhr-svg, .vp-bf-svg')!;
    const b = bild.getBoundingClientRect();
    // Die Symbole der Tätigkeiten sind verschachtelte <svg> (`Icon`) - der
    // Fehler des Energieflusses (V-07) darf sich hier nicht wiederholen.
    const symbole = [...bild.querySelectorAll('svg')].map((s) => {
      const r = s.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    return {
      art: bild.classList.contains('vp-uhr-svg') ? 'uhr' : 'bildfahrplan',
      karteLinks: k.left,
      karteRechts: k.right,
      bildLinks: b.left,
      bildRechts: b.right,
      bildHoehe: b.height,
      symbole,
    };
  });

  const breite = page.viewportSize()?.width ?? 0;
  expect(mass.art, 'Uhr bis 900 px Inhaltsbreite, darüber der Bildfahrplan').toBe(breite >= 1200 ? 'bildfahrplan' : 'uhr');
  expect(mass.bildHoehe, 'das Tagesbild hat eine Fläche').toBeGreaterThan(150);
  expect(mass.bildLinks).toBeGreaterThanOrEqual(mass.karteLinks - 1);
  expect(mass.bildRechts).toBeLessThanOrEqual(mass.karteRechts + 1);
  expect(mass.symbole.length, 'die Tätigkeiten tragen Symbole').toBeGreaterThan(0);
  for (const s of mass.symbole) {
    expect(s.w, `Symbol ${s.w}×${s.h} px ist aufgeblasen`).toBeLessThanOrEqual(24);
    expect(s.h, `Symbol ${s.w}×${s.h} px ist aufgeblasen`).toBeLessThanOrEqual(24);
  }
  expect(await ueberlauf(page)).toBeLessThanOrEqual(0);

  // Rückmeldung 25.09.2026 („zwei doppelte Diagramme"): neben dem Tagesbild
  // steht kein zweites Bild desselben Tages, kein Film und kein Aufklapper.
  // Das bisherige Diagramm öffnet sich nur als Dialog „Alle Werte".
  await expect(page.locator('.vp-uhr-svg, .vp-bf-svg')).toHaveCount(1);
  await expect(page.locator('.vp-film')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Mehr erklären/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Alle Werte im Diagramm/ })).toHaveCount(1);
});

/**
 * E1/E9 (Konzept „Tagesuhr und Bildfahrplan", 24.09.2026): am Telefon stehen
 * Tagesschalter, Kopfsatz, Uhr, Werte und die Zeile zum Moment ganz oben,
 * direkt darunter die Antworten - und ALLE Antworten beginnen im ersten
 * Bildschirm (375 × 812, über der unteren Leiste). Darunter darf die Seite
 * länger werden; die frühere Grenze der Gesamthöhe (1 750 px, V-02/V-06)
 * ersetzt E9 A durch dieses Budget des ersten Bildschirms.
 *
 * Seit dem Tagesschalter (25.09.2026) trägt der Fahrplan wie seine Reiter
 * Preise und Wetter keinen SICHTBAREN Seitenkopf: die Reiterleiste springt
 * nicht mehr, und die Uhr bekam den Platz („so groß wie möglich").
 */
test('Fahrplan: die Uhr ganz oben, alle Antworten im ersten Bildschirm (E1, E9)', async ({ page }) => {
  await oeffnen(page, FAHRPLAN);
  await page.locator('.vp-antw').first().waitFor();
  await einfuehrungBeenden(page);
  // Die Überschrift ist da - für Screenreader, nicht auf der Fläche.
  await expect(page.locator('main h1', { hasText: 'Fahrplan' })).toHaveClass(/vp-sr-only/);

  const mass = await page.evaluate(() => {
    const leiste = document.querySelector('.vp-bottombar');
    const leisteOben = leiste && leiste.getBoundingClientRect().height > 0 ? leiste.getBoundingClientRect().top : innerHeight;
    const bild = document.querySelector('.vp-uhr, .vp-bf')!.getBoundingClientRect();
    const kopf = document.querySelector('.vp-tb-kopf');
    return {
      sichtbarBis: Math.min(innerHeight, leisteOben),
      bildOben: bild.top,
      kopfOben: kopf ? kopf.getBoundingClientRect().top : null,
      antworten: [...document.querySelectorAll('.vp-antw-kachel')].map((el) => el.getBoundingClientRect().top),
    };
  });
  expect(mass.antworten.length, 'Antworten unter dem Tagesbild').toBeGreaterThanOrEqual(2);
  for (const oben of mass.antworten) {
    // Mindestens die Frage und der Beginn der Antwort stehen über dem Rand.
    expect(oben, 'eine Antwort beginnt unter dem ersten Bildschirm').toBeLessThanOrEqual(mass.sichtbarBis - 40);
    // Unter dem Bild (Telefon, Rechner) oder daneben (Tablet) - nie davor.
    expect(oben, 'die Antworten stehen nicht vor dem Bild').toBeGreaterThanOrEqual(mass.bildOben - 1);
  }
  // Aufbau des Prototyps: der Tagesschalter über dem Kopfsatz, der über dem Bild.
  if (mass.kopfOben != null) expect(mass.kopfOben).toBeLessThan(mass.bildOben);
  const tage = await page.getByRole('tablist', { name: 'Tag' }).boundingBox();
  expect(tage, 'der Tagesschalter (E2)').not.toBeNull();
  if (mass.kopfOben != null) expect(tage!.y).toBeLessThan(mass.kopfOben);
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
