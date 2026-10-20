import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Die Bühne des Cockpits (Konzept „Cockpit als Tagesfilm“): Leitungsplan,
// Jetzt/Heute, Tagesleiste und Blätter bei 375 und 1440 px.
for (const width of [375, 1440]) {
  for (const betrieb of ['eigenverbrauch', 'markt', 'spitze']) {
    test(`${betrieb}: Bühne bei ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      const fehler: string[] = [];
      page.on('pageerror', (e) => fehler.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
      await page.goto(`/e2e/cockpit-buehne.html?betrieb=${betrieb}`);
      await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();
      await expect(page.locator('.vp-eb-marke')).toHaveText(/Live/);
      // Live laufen die Punkte, zurückgezogen nicht.
      await expect(page.locator('.vp-lp.is-live')).toHaveCount(1);
      const leiste = page.getByRole('slider', { name: 'Tageszeit' });
      await leiste.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('.vp-eb-marke')).toHaveText('gemessen');
      await expect(page.locator('.vp-lp.is-live')).toHaveCount(0);
      await page.keyboard.press('End');
      // Die Plan-Tätigkeit steht IN der Marke („Plan · …“), keine zweite Plakette (Konzept b1).
      await expect(page.locator('.vp-eb-marke')).toHaveText(/^Plan/);
      await expect(page.locator('.vp-eb-plan')).toHaveCount(0);
      await expect(page.locator('.vp-lp.is-plan')).toHaveCount(1);
      await page.getByRole('button', { name: 'Zurück zu Jetzt' }).click();
      await expect(page.locator('.vp-eb-marke')).toHaveText(/Live/);
      // Heute · kWh
      await page.getByRole('button', { name: 'Heute · kWh' }).click();
      await expect(page.locator('.vp-eb-marke')).toHaveText('Energie · gemessen');
      await expect(page.locator('.vp-lp-lab').first()).toContainText('kWh');
      await page.getByRole('button', { name: 'Jetzt · kW' }).click();
      // Ein Knoten öffnet sein Blatt; Escape schließt und gibt den Fokus zurück.
      const speicher = page.locator('.vp-lp-batt');
      await speicher.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(speicher).toBeFocused();
      // Kein Überlauf, nichts ragt heraus, keine Fehler.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      expect(await page.locator('main').evaluate((el) => [...el.querySelectorAll('*')].filter((e) => {
        const r = e.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1);
      }).length)).toBe(0);
      expect(fehler).toEqual([]);
      if (process.env.BUEHNE_BILDER) {
        await mkdir(process.env.BUEHNE_BILDER, { recursive: true });
        await page.screenshot({ path: `${process.env.BUEHNE_BILDER}/${betrieb}-${width}.png`, fullPage: true });
      }
    });
  }
}

// Konzept b1 (20.10.2026): der Kopf hat feste Plätze. Der Umschalter steht in jedem Zustand an
// derselben Stelle oben rechts, der Kopf bleibt gleich hoch - vorher rutschte er je nach Marke
// („Live“, „Plan und Prognose“ + „Plan: …“) in die zweite oder dritte Zeile.
for (const width of [375, 1440]) {
  test(`Kopf: Umschalter bleibt in jedem Zustand an seinem Platz bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto('/e2e/cockpit-buehne.html?betrieb=markt');
    await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();
    const modus = page.getByRole('group', { name: 'Anzeige' });
    const kopf = page.locator('.vp-eb-kopf');
    const lage = async () => {
      const m = (await modus.boundingBox())!;
      const k = (await kopf.boundingBox())!;
      return { top: Math.round(m.y - k.y), right: Math.round(k.x + k.width - (m.x + m.width)), hoehe: Math.round(k.height) };
    };
    const live = await lage();
    expect(live.right).toBe(0);
    const leiste = page.getByRole('slider', { name: 'Tageszeit' });
    await leiste.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.vp-eb-marke')).toHaveText(/^gemessen/);
    expect(await lage()).toEqual(live);
    await page.keyboard.press('End');
    await expect(page.locator('.vp-eb-marke')).toHaveText(/^Plan/);
    expect(await lage()).toEqual(live);
  });
}

/** Ein Finger über CDP: Aufsetzen, in Schritten bewegen, Loslassen (echte Touch-Gesten samt Scrollen). */
async function finger(page: Page, von: { x: number; y: number }, nach: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const punkt = (x: number, y: number) => [{ x: Math.round(x), y: Math.round(y), id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: punkt(von.x, von.y) });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: punkt(von.x + ((nach.x - von.x) * i) / 10, von.y + ((nach.y - von.y) * i) / 10),
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// Konzept b1: am Telefon wählt die Tagesleiste nur durch einen Tipp. Wer über sie wischt, scrollt
// die Seite (vorher verschob jeder Wisch die Uhrzeit); die Leiste steht direkt unter dem Fluss und
// springt nach dem ersten Tipp nicht weg (vorher 135 px, weil „Verbrauch im Detail“ darüber von vier
// Zeilen auf eine schrumpfte); ‹ › gehen je eine Viertelstunde.
test.describe('Tagesleiste am Telefon', () => {
  test.use({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });

  test('Wischen scrollt, Tippen wählt, die Leiste bleibt stehen, ‹ › gehen eine Viertelstunde', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Touch-Gesten über CDP gibt es nur in Chromium');
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/cockpit-buehne.html?betrieb=markt');
    await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();
    const marke = page.locator('.vp-eb-marke');
    const leiste = page.getByRole('slider', { name: 'Tageszeit' });
    const jetzt = Number(await leiste.getAttribute('aria-valuenow'));
    await expect(marke).toHaveText(/Live/);
    // Die Leiste steht vor „Verbrauch im Detail“ - direkt unter dem Fluss.
    const vorDerListe = await page.evaluate(() => {
      const tl = document.querySelector('.vp-tl')!;
      const liste = document.querySelector('.vp-eb-listen')!;
      return Boolean(tl.compareDocumentPosition(liste) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(vorDerListe).toBe(true);

    // 1. Senkrecht über die Leiste wischen: die Seite scrollt, die Uhrzeit bleibt.
    await leiste.scrollIntoViewIfNeeded();
    let box = (await leiste.boundingBox())!;
    const scrollVor = await page.evaluate(() => scrollY);
    await finger(page, { x: box.x + box.width * 0.3, y: box.y + 60 }, { x: box.x + box.width * 0.3, y: box.y - 140 });
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scrollVor + 50);
    await expect(marke).toHaveText(/Live/);
    await expect(leiste).toHaveAttribute('aria-valuenow', String(jetzt));

    // 2. Waagrecht mit dem Finger ziehen: kein Tipp, nichts wird gewählt.
    box = (await leiste.boundingBox())!;
    await finger(page, { x: box.x + box.width * 0.2, y: box.y + 40 }, { x: box.x + box.width * 0.8, y: box.y + 40 });
    await expect(marke).toHaveText(/Live/);

    // 3. Ein Tipp wählt die Viertelstunde - und die Leiste bleibt, wo sie auf der Seite war (die
    //    Lage zum Seitenanfang: in dieser Bühne ohne Kacheln darunter kürzt die schrumpfende Liste
    //    die Seite, und der Browser rückt nur die Scrollstellung nach).
    const seitenLage = () => leiste.evaluate((el) => Math.round(el.getBoundingClientRect().top + scrollY));
    const lageVor = await seitenLage();
    box = (await leiste.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.4, box.y + 40);
    await expect(marke).toHaveText(/^gemessen/);
    expect(await seitenLage()).toBe(lageVor);

    // 4. ‹ › gehen je eine Viertelstunde; „Zurück zu Jetzt“ springt zurück.
    const gewaehlt = Number(await leiste.getAttribute('aria-valuenow'));
    await page.getByRole('button', { name: 'Eine Viertelstunde später' }).tap();
    await expect(leiste).toHaveAttribute('aria-valuenow', String(gewaehlt + 1));
    await page.getByRole('button', { name: 'Eine Viertelstunde früher' }).tap();
    await expect(leiste).toHaveAttribute('aria-valuenow', String(gewaehlt));
    await page.getByRole('button', { name: 'Zurück zu Jetzt' }).tap();
    await expect(marke).toHaveText(/Live/);
    await expect(page.getByRole('button', { name: 'Zurück zu Jetzt' })).toHaveCount(0);
    // „Tag abspielen“ und der Hinweissatz gibt es nicht mehr.
    await expect(page.getByRole('button', { name: /Tag abspielen/ })).toHaveCount(0);
    await expect(page.getByText('Ziehen Sie über die Tagesleiste')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
});

// Konzept b1, Entscheidung E4: am Rechner darf die Maus weiter ziehen.
test('Tagesleiste am Rechner: die Maus zieht durch den Tag', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/e2e/cockpit-buehne.html?betrieb=markt');
  await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();
  const leiste = page.getByRole('slider', { name: 'Tageszeit' });
  await leiste.scrollIntoViewIfNeeded();
  const box = (await leiste.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + 40);
  await page.mouse.down();
  await expect(page.locator('.vp-eb-marke')).toHaveText(/^gemessen/);
  const anfang = Number(await leiste.getAttribute('aria-valuenow'));
  await page.mouse.move(box.x + box.width * 0.9, box.y + 40, { steps: 8 });
  await page.mouse.up();
  expect(Number(await leiste.getAttribute('aria-valuenow'))).toBeGreaterThan(anfang + 40);
  await expect(page.locator('.vp-eb-marke')).toHaveText(/^Plan/);
});

// „Überwachen" am Wert (Alerting Scheibe 2, Konzept vp-alerting-konzept-m1 §6.3/§6.8): „Vom Wert
// zur fertigen Regel: drei Taps" an einem der vier Live-Kreise von „Dieser Moment" - Menü ⋯ öffnen
// (zählt nicht), „Überwachen" antippen (1), Blatt mit vorbelegtem Satz, Schwelle ändern,
// „Überwachung starten" (2) - danach die Marke „überwacht". `cockpit-buehne.tsx` stellt eine
// Selbstauskunft mit `ueberwachung.eigene` und bildet `/api/v1/meldungen/regeln` über `fetch` nach
// (kein Backend nötig); am Telefon (`isPhone`, kein `momentZiel`) steht der Block ohnehin inline.
for (const width of [390, 1440]) {
  test(`Überwachen am Netzbezug: Blatt vorbelegt, Schwelle ändern, Marke „überwacht" bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/cockpit-buehne.html?betrieb=eigenverbrauch');
    await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();

    const netzKnoten = page.locator('.vp-eb-mk.is-grid');
    await expect(netzKnoten).toBeVisible();
    await expect(netzKnoten.locator('.vp-eb-mk-marke')).toHaveCount(0);

    // (1) Menü ⋯ öffnen zählt nicht als Tap - „Überwachen" antippen öffnet das Blatt.
    await netzKnoten.getByRole('button', { name: 'Werkzeuge: Netz' }).click();
    await page.getByRole('menuitem', { name: 'Überwachen' }).click();

    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('Sag mir Bescheid, wenn der Netzbezug');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('über');

    // Vorbelegt UND änderbar (§6.1 Leitsatz 9): die Schwelle ändern.
    const schwelle = blatt.getByLabel('Schwelle (kW)', { exact: true });
    await schwelle.fill('150');
    await expect(blatt.locator('.vp-ueberwachen-satz')).toContainText('150');

    // (2) „Überwachung starten" - mehr Taps bis zur fertigen Regel sind nicht erlaubt.
    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();
    await expect(blatt).toHaveCount(0);

    await expect(netzKnoten.locator('.vp-eb-mk-marke')).toHaveText(/überwacht/);

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}

// „Gilt für" (Alerting Scheibe 4, Konzept §6.4 "Gilt für"): toddler-simple im BESTEHENDEN Blatt -
// zwei Chips, "Diese Anlage" (Vorgabe) oder "Alle Anlagen"; eine Auswahl ersetzt beim Anlegen den
// konkreten Bezug durch {"alle":"anlage"} (geprüft am tatsächlich gesendeten Anfragekörper, nicht
// nur an der Oberfläche - die Fixture nimmt jeden Körper an).
for (const width of [390, 1440]) {
  test(`„Gilt für: Alle Anlagen" sendet die Auswahl statt des Bezugs bei ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1100 });
    const fehler: string[] = [];
    page.on('pageerror', (e) => fehler.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
    await page.goto('/e2e/cockpit-buehne.html?betrieb=eigenverbrauch');
    await expect(page.getByRole('group', { name: 'Energiefluss Ihrer Anlage' })).toBeVisible();

    const netzKnoten = page.locator('.vp-eb-mk.is-grid');
    await netzKnoten.getByRole('button', { name: 'Werkzeuge: Netz' }).click();
    await page.getByRole('menuitem', { name: 'Überwachen' }).click();

    const blatt = page.getByRole('dialog');
    await expect(blatt).toBeVisible();
    const giltFuer = blatt.getByRole('group', { name: 'Gilt für' });
    await expect(giltFuer).toBeVisible();
    await expect(giltFuer.getByRole('button', { name: 'Diese Anlage' })).toHaveAttribute('aria-pressed', 'true');

    await giltFuer.getByRole('button', { name: 'Alle Anlagen' }).click();
    await expect(giltFuer.getByRole('button', { name: 'Alle Anlagen' })).toHaveAttribute('aria-pressed', 'true');
    // Eine Auswahl hat serverseitig keinen EINEN Probelauf - die Vorschau bleibt aus, nie ein Blocker.
    await expect(blatt.locator('.vp-ueberwachen-probelauf')).toHaveCount(0);

    await blatt.getByRole('button', { name: 'Überwachung starten' }).click();
    await expect(blatt).toHaveCount(0);

    const gesendeteKoerper = await page.evaluate(
      () => (window as unknown as { __ueberwachungAnfragen: unknown[] }).__ueberwachungAnfragen,
    );
    expect(gesendeteKoerper).toHaveLength(1);
    expect(gesendeteKoerper[0]).toMatchObject({ bezug: { alle: 'anlage' } });

    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(fehler).toEqual([]);
  });
}
