import { test, expect } from '@playwright/test';
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
      await expect(page.locator('.vp-eb-marke')).toHaveText('Plan und Prognose');
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
