import { expect, test, type Page } from '@playwright/test';

/**
 * **Minus-Tage einordnen** (Konzept `vp-erloese-minus-winter-k1` §7/§8,
 * Captain 24.09.2026: E1–E7 = A) — der Browser-Beweis über die vier Flächen
 * mit den Zahlen der Referenzanlage (`src/speicherAussage.vektoren.json`).
 *
 * Die Harness läuft auf fester Uhr (`?jetzt=`), nie auf der echten.
 */
const JETZT = 'jetzt=2026-09-24T19%3A58%3A00%2B02%3A00';
const seite = (fall: string, flaeche: string) =>
  `/e2e/erloese-minus.html?fall=${fall}&flaeche=${flaeche}&${JETZT}`;

async function oeffne(page: Page, fall: string, flaeche: string) {
  await page.goto(seite(fall, flaeche));
  await expect(page.locator(`main[data-fall="${fall}"]`)).toBeVisible();
}

test.describe('Erlöse-Seite · Steuerungs-Karte', () => {
  test('24.09. laufend: Grund mit Paar, Anker, Vorsprung — kein nacktes Minus', async ({ page }) => {
    await oeffne(page, 'herzogau-2409', 'erloese');
    const karte = page.locator('section.vp-c-card.vp-c-speicher');
    await expect(karte).toBeVisible();
    await expect(karte.locator('.vp-chip').first()).toHaveText('Zwischenstand');
    await expect(karte.locator('.vp-c-sp-zeile')).toContainText('Steuerung heute');
    await expect(karte.locator('.vp-c-sp-wert')).toHaveText('− 9,80 €');
    await expect(karte.locator('.vp-c-sp-grund')).toHaveText(
      'gestern verkauft + 12,78 € · beide Tage + 2,98 € · hält 5,0 kWh für morgen',
    );
    await expect(karte.locator('.vp-c-sp-anker-label')).toHaveText('September bisher');
    await expect(karte.locator('.vp-c-sp-anker-wert')).toHaveText('+ 116,94 €');
    const bestand = karte.locator('.vp-c-sp-bestand');
    await expect(bestand).toContainText('5,0 kWh Vorsprung vor dem Vergleichsspeicher · Planwert 1,31 €');
    await expect(bestand.locator('.vp-chip')).toHaveText('Kein Abzug');
    // Die alte Zeile (Änderung seit Mitternacht) steht nirgends mehr.
    await expect(page.locator('main')).not.toContainText('seit Tagesbeginn');
    // Höchstens ein Chip je Zeile, kein Betrag in einem Chip.
    for (const chip of await karte.locator('.vp-chip').allTextContents()) {
      expect(chip).not.toMatch(/€|\d/);
    }

    // Die Kachel oben trägt das Kurzwort.
    await expect(page.locator('.vp-vr-kpi', { hasText: 'VoltPilot-Steuerung' })).toContainText(
      'gestern verkauft',
    );

    // „Wie wird das berechnet?" — der neue Schritt mit den eingesetzten Zahlen.
    await karte.locator('details.vp-formel summary').click();
    const body = karte.locator('.vp-formel-body');
    await expect(body).toContainText('Warum heute weniger · gestern + 12,78 €, heute − 9,80 €, beide Tage + 2,98 €');
    await expect(body).toContainText('Warum heute weniger · 5,0 kWh mehr im Speicher als beim Vergleichsspeicher');
    await expect(body).toContainText('Planwert: 5,0 kWh × 26,00 ct');
    await expect(body).toContainText('Vorsprung vor dem Vergleichsspeicher (dort 13,8 kWh)');
  });

  test('23.09. Plus-Tag: kein Grund, abgeschlossener Anker, Rückstand statt Vorsprung', async ({ page }) => {
    await oeffne(page, 'plus-2309', 'erloese');
    const karte = page.locator('section.vp-c-card.vp-c-speicher');
    await expect(karte.locator('.vp-c-sp-wert')).toHaveText('+ 12,78 €');
    await expect(karte.locator('.vp-c-sp-grund')).toHaveCount(0);
    await expect(karte.locator('.vp-c-sp-anker-label')).toHaveText('1.–23. September');
    await expect(karte.locator('.vp-c-sp-bestand')).toContainText(
      '35,4 kWh Rückstand auf den Vergleichsspeicher · Planwert 11,32 €',
    );
  });

  test('09.09. Wintertag: Winter-Satz im Ergebnis, vermiedener Bezug, Grund am Vortag', async ({ page }) => {
    await oeffne(page, 'winter-0909', 'erloese');
    await expect(page.locator('.vp-vr-kpi', { hasText: 'Ergebnis' }).first()).toContainText(
      'Wenig Sonne: 96 kWh erzeugt, 91 kWh selbst genutzt.',
    );
    await expect(page.locator('main')).toContainText('vermiedener Bezug');
    const karte = page.locator('section.vp-c-card.vp-c-speicher');
    await expect(karte.locator('.vp-chip').first()).toHaveText('unter Null');
    await expect(karte.locator('.vp-c-sp-grund')).toHaveText(
      'am Vortag verkauft + 10,19 € · beide Tage + 1,61 € · so geplant (− 19,68 €)',
    );
  });

  test('Monat: Anker „Jahr bisher", keine Bestandszeile, kein Grund', async ({ page }) => {
    await oeffne(page, 'monat-09', 'erloese');
    const karte = page.locator('section.vp-c-card.vp-c-speicher');
    await expect(karte.locator('.vp-c-sp-wert')).toHaveText('+ 116,94 €');
    await expect(karte.locator('.vp-c-sp-anker-label')).toHaveText('Jahr bisher');
    await expect(karte.locator('.vp-c-sp-anker-wert')).toHaveText('+ 311,21 €');
    await expect(karte.locator('.vp-c-sp-bestand')).toHaveCount(0);
    await expect(karte.locator('.vp-c-sp-grund')).toHaveCount(0);
  });
});

test.describe('Cockpit-Karte', () => {
  test('dieselbe Einordnung in der Sektion, Winter-Satz unter „Unterm Strich"', async ({ page }) => {
    await oeffne(page, 'herzogau-2409', 'cockpit');
    const leiste = page.locator('[data-frame="cockpit-leiste"]');
    await expect(leiste.locator('.vp-c-sp-grund')).toContainText('gestern verkauft + 12,78 €');
    await expect(leiste.locator('.vp-c-sp-anker')).toContainText('September bisher');
    await expect(leiste.locator('.vp-c-ck-winter')).toHaveCount(0);

    await oeffne(page, 'winter-0909', 'cockpit');
    await expect(page.locator('[data-frame="cockpit-leiste"] .vp-c-ck-winter')).toHaveText(
      'Wenig Sonne: 96 kWh erzeugt, 91 kWh selbst genutzt.',
    );
  });
});

test.describe('Meine Anlagen', () => {
  test('Kachel mit Grund und Monat, „1 von 2 Anlagen", Kurzwort, datierter Ladestand', async ({ page }) => {
    await oeffne(page, 'herzogau-2409', 'portfolio');
    const kachel = page.locator('.vp-leiste-zelle.is-lead');
    await expect(kachel.locator('.vp-leiste-einordnung')).toHaveText(
      'gestern verkauft + 12,78 € · September + 116,94 €',
    );
    await expect(kachel.locator('.vp-leiste-sub')).toHaveText('gegenüber Speicher ohne Steuerung · 1 von 2 Anlagen');
    await expect(page.locator('tr', { hasText: 'Pilsting / Herzogau' }).locator('.vp-at-grund')).toHaveText(
      'gestern verkauft',
    );
    const mienbach = page.locator('tr', { hasText: 'Mienbach' });
    await expect(mienbach).toContainText('6 % am 12.08.');
    await expect(mienbach.locator('.vp-at-bar')).toHaveCount(0);
  });
});

/** Wörter = Leerzeichen-getrennte Stücke mit Buchstabe oder Ziffer (Zeichen und „€" zählen nicht). */
async function woerter(page: Page, selector: string, ohne = 'details'): Promise<number> {
  return page.locator(selector).first().evaluate((el, ohneSel) => {
    const kopie = el.cloneNode(true) as HTMLElement;
    kopie.querySelectorAll(ohneSel).forEach((n) => n.remove());
    return (kopie.textContent ?? '').split(/\s+/).filter((w) => /[\p{L}\d]/u.test(w)).length;
  }, ohne);
}

test('Textbudget: Erlöse-Karte ≤ 30 Wörter, Cockpit-Karte ≤ 42 (Konzept k1 §7.1)', async ({ page }) => {
  await oeffne(page, 'herzogau-2409', 'erloese');
  const erloese = await woerter(page, 'section.vp-c-card.vp-c-speicher');
  await oeffne(page, 'herzogau-2409', 'cockpit');
  // Die Cockpit-Karte ohne Zeitraum-Segment (Bedienelement, kein Text) und ohne Aufklapper.
  const cockpit = await woerter(page, '[data-frame="cockpit-leiste"]', 'details, [role="tablist"]');
  test.info().annotations.push({ type: 'woerter', description: `erloese=${erloese} cockpit=${cockpit}` });
  expect(erloese).toBeLessThanOrEqual(30);
  expect(cockpit).toBeLessThanOrEqual(42);
});

test('Telefon 375: kein horizontaler Überlauf auf allen Flächen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 1400 });
  for (const [fall, flaeche] of [
    ['herzogau-2409', 'erloese'],
    ['winter-0909', 'erloese'],
    ['herzogau-2409', 'cockpit'],
    ['herzogau-2409', 'portfolio'],
  ]) {
    await oeffne(page, fall, flaeche);
    const r = await page.evaluate(() => {
      const d = document.documentElement;
      const raus = [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && (b.right > d.clientWidth + 1 || b.left < -1);
        })
        .map((e) => `${e.tagName}.${e.className}`)
        .slice(0, 3);
      return { scrollX: d.scrollWidth - d.clientWidth, raus };
    });
    expect(r, `${fall}/${flaeche}`).toEqual({ scrollX: 0, raus: [] });
  }
});

/**
 * Kontrast-Wächter im Browser: die NEUEN Sekundärtexte gegen ihre tatsächliche
 * Fläche (erster nicht-durchsichtiger Hintergrund), AA für Normaltext.
 */
test('Kontrast: Grund, Anker, Kachel-Einordnung und Kurzwort ≥ 4,5:1', async ({ page }) => {
  const messen = (sel: string) =>
    page.locator(sel).first().evaluate((el) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      let n: Element | null = el;
      let bg = 'rgb(255, 255, 255)';
      while (n) {
        const c = getComputedStyle(n).backgroundColor;
        const t = rgb(c);
        if (t.length >= 3 && (t.length < 4 || t[3] > 0)) {
          bg = c;
          break;
        }
        n = n.parentElement;
      }
      const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(bg))].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    });
  await oeffne(page, 'herzogau-2409', 'erloese');
  for (const sel of ['.vp-c-sp-grund', '.vp-c-sp-anker-label', '.vp-c-sp-anker-wert']) {
    expect(await messen(sel), sel).toBeGreaterThanOrEqual(4.5);
  }
  await oeffne(page, 'herzogau-2409', 'portfolio');
  for (const sel of ['.vp-leiste-einordnung', '.vp-at-grund']) {
    expect(await messen(sel), sel).toBeGreaterThanOrEqual(4.5);
  }
});
