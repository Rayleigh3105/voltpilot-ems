import { expect, test, type Page } from '@playwright/test';

/**
 * Cockpit für private Haushalte (Konzept `vp-cockpit-privat-konzept`, Captain-Entscheide E1–E4 = A vom
 * 08.11.2026). Führt der Fluss, steht neben ihm der Block „Heute“, der Euro ist eine ruhige Zeile am Ende,
 * und die Spalte steht nur neben dem Fluss - Tagesleiste und Listen laufen darunter über die volle Breite,
 * auch beim Gewerbe mit Lastspitze (E4). Echtes Portal auf gestellten Antworten (`e2e/cockpit-privat.tsx`),
 * drei Lagen eines Haushalts und eine gewerbliche Anlage. GEMESSEN bei 1440 und 390 px: Ort und Inhalt,
 * Höhe der Spalte gegen die Fluss-Reihe, Lücke unter ihrem Inhalt, kein Überlauf, Konsole sauber.
 */
const ZEIT = {
  abend: '2026-11-07T18:47:00Z',
  mittag: '2026-11-07T11:30:00Z',
  speicher: '2026-11-07T18:47:00Z',
  gewerbe: '2026-09-10T10:00:00Z',
} as const;
const ANLAGE = { abend: 'muehlbach', mittag: 'muehlbach', speicher: 'birkenweg', gewerbe: 'help-site' } as const;
type Lage = keyof typeof ZEIT;
/** Mehr Luft unter dem Inhalt der Spalte gilt wieder als „leer“ (der Anlass des Konzepts: 677 px). */
const LUECKE_PX = 160;

test.use({ locale: 'de-DE', timezoneId: 'Europe/Berlin' });

/** Je Breite nur die passende Maschine: der Rechner auf Chromium, das Telefon auf WebKit (iPhone). */
function nurAuf(maschine: 'desktop-chromium' | 'mobile-webkit') {
  test.beforeEach(({}, info) => test.skip(info.project.name !== maschine, 'je Breite nur die passende Maschine'));
}

async function oeffnen(page: Page, lage: Lage, breite: 1440 | 390 | 375, extra = '') {
  const fehler: string[] = [];
  page.on('pageerror', (e) => fehler.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') fehler.push(m.text()); });
  await page.setViewportSize({ width: breite, height: breite === 1440 ? 900 : 844 });
  await page.clock.setFixedTime(new Date(ZEIT[lage]));
  await page.goto(`/e2e/cockpit-privat.html?lage=${lage}${extra}#/anlage/${ANLAGE[lage]}`);
  await page.locator('.vp-lp').first().waitFor();
  // Die Kacheln laden nach; erst ihr Bild, nie ihr Platzhalter.
  await expect(page.locator('.vp-k-platz[aria-hidden="true"]')).toHaveCount(0);
  return fehler;
}

const text = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => (el.textContent ?? '').replace(/[  ]/g, ' '));

/** Spalte, Fluss-Reihe und die Luft unter dem Inhalt der Spalte - am echten Layout gemessen. */
function messen(page: Page) {
  return page.evaluate(() => {
    const spalte = document.querySelector('.vp-eb-reihe > .vp-hero-side');
    const links = document.querySelector('.vp-eb-reihe > .vp-eb-links');
    let inhaltUnten = 0;
    for (const c of spalte?.children ?? []) inhaltUnten = Math.max(inhaltUnten, c.getBoundingClientRect().bottom);
    const s = spalte?.getBoundingClientRect() ?? null;
    return {
      ueberlauf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      spalteHoehe: s?.height ?? null,
      flussHoehe: links?.getBoundingClientRect().height ?? null,
      luecke: s ? Math.round(s.bottom - inhaltUnten) : null,
    };
  });
}

test.describe('1440 px', () => {
  nurAuf('desktop-chromium');

  for (const lage of ['abend', 'mittag', 'speicher'] as const) {
    test(`Haushalt, ${lage}, 1440 px: „Heute“ neben dem Fluss, nie höher als er, ohne große Lücke`, async ({ page }) => {
      const fehler = await oeffnen(page, lage, 1440);
      const heute = page.locator('.vp-eb-reihe > .vp-hero-side [data-kachel="heute"]');
      await expect(heute).toBeVisible();
      expect(await text(page, '.vp-hero-side [data-kachel="heute"]')).toMatch(/Ihres Stroms kam heute aus eigener Sonne/);
      // Der Fluss führt: kein Stern, keine Geld-Leitkachel; Autarkie, Eigenverbrauch und Sonne stehen im Block.
      await expect(page.locator('.vp-k-stern')).toHaveCount(0);
      for (const weg of ['geld', 'autarkie', 'eigenverbrauch', 'sonne']) {
        await expect(page.locator(`[data-kachel="${weg}"]`)).toHaveCount(0);
      }
      // Der Euro: eine ruhige Zeile am Ende, ohne Rot.
      await expect(page.locator('.vp-k-geldzeile')).toBeVisible();
      expect(await text(page, '.vp-k-geldzeile')).toContain('heute bisher');
      await expect(page.locator('.is-kosten')).toHaveCount(0);
      const m = await messen(page);
      expect(m.ueberlauf).toBeLessThanOrEqual(0);
      expect(m.spalteHoehe!).toBeLessThanOrEqual(m.flussHoehe! + 1);
      expect(m.luecke!).toBeLessThan(LUECKE_PX);
      expect(fehler).toEqual([]);
    });
  }

  test('Haushalt ohne Speicher: keine Steuerungs-Zeile am Geld, kein Netzladen-Abzeichen, kein leerer Rasterabstand', async ({ page }) => {
    const fehler = await oeffnen(page, 'abend', 1440);
    expect(await text(page, '.vp-main')).not.toContain('Steuerung —');
    expect(await text(page, '.vp-anlage-badges')).not.toMatch(/Solarladen|Netzladen/);
    // Ohne weitere Kacheln steht zwischen Karte und Geld-Zeile derselbe Abstand wie zwischen den Zeilen darunter.
    const abstand = await page.evaluate(() => {
      const karte = document.querySelector('.vp-cockpit-hero')!.getBoundingClientRect();
      const geld = document.querySelector('.vp-k-geldzeile')!.getBoundingClientRect();
      const zustand = document.querySelector('.vp-cockpit-health')!.getBoundingClientRect();
      return { oben: Math.round(geld.top - karte.bottom), unten: Math.round(zustand.top - geld.bottom) };
    });
    expect(abstand.oben).toBe(abstand.unten);
    expect(fehler).toEqual([]);
});

test('Haushalt mittags: der Rest des Tages steht schraffiert als „noch erwartet“', async ({ page }) => {
  await oeffnen(page, 'mittag', 1440);
  expect(await text(page, '[data-kachel="heute"]')).toContain('noch erwartet');
  await expect(page.locator('[data-kachel="heute"] .vp-k-heute-balken i.is-plan')).toBeVisible();
});

test('Haushalt mit Speicher: die Steuerzeile schließt die Spalte unten ab', async ({ page }) => {
  await oeffnen(page, 'speicher', 1440);
  expect(await text(page, '[data-kachel="heute"]')).toContain('Speicher');
  const steuer = page.locator('.vp-eb-reihe > .vp-hero-side > .vp-hero-steuer .vp-steuer');
  await expect(steuer).toBeVisible();
  const unten = await page.evaluate(() => {
    const s = document.querySelector('.vp-eb-reihe > .vp-hero-side')!.getBoundingClientRect();
    const z = document.querySelector('.vp-eb-reihe > .vp-hero-side > .vp-hero-steuer')!.getBoundingClientRect();
    return Math.round(s.bottom - z.bottom);
  });
  expect(unten).toBeLessThanOrEqual(1);
});

test('der Stern des Kunden auf „Unterm Strich“ holt den Euro als Leitkachel zurück', async ({ page }) => {
  await oeffnen(page, 'abend', 1440, '&stern=erloes-komposition');
  await expect(page.locator('.vp-eb-reihe > .vp-hero-side [data-kachel="geld"] .vp-k-stern')).toBeVisible();
  await expect(page.locator('[data-kachel="heute"]')).toHaveCount(0);
  await expect(page.locator('.vp-k-geldzeile')).toHaveCount(0);
});

test('Gewerbe mit Lastspitze, 1440 px: die Leitkachel steht nur neben dem Fluss (E4), sonst wie bisher', async ({ page }) => {
  const fehler = await oeffnen(page, 'gewerbe', 1440);
  await expect(page.locator('.vp-eb-reihe > .vp-hero-side [data-kachel="lastspitze"] .vp-k-stern')).toBeVisible();
  await expect(page.locator('[data-kachel="heute"]')).toHaveCount(0);
  await expect(page.locator('.vp-k-geldzeile')).toHaveCount(0);
  const m = await messen(page);
  expect(m.ueberlauf).toBeLessThanOrEqual(0);
  expect(m.spalteHoehe!).toBeLessThanOrEqual(m.flussHoehe! + 1);
  expect(fehler).toEqual([]);
});

});

// 390 px aus dem Auftrag, 375 px aus der Portal-Regel (Browserprüfung bei 1440 und 375).
for (const breite of [390, 375] as const) {
  test.describe(`${breite} px`, () => {
    nurAuf('mobile-webkit');

    for (const lage of ['abend', 'mittag', 'speicher', 'gewerbe'] as const) {
      test(`${lage}, ${breite} px: keine Spalte, die führende Kachel zuerst, kein Überlauf, kein Euro in der Kopfzeile`, async ({ page }) => {
        const fehler = await oeffnen(page, lage, breite);
        await expect(page.locator('.vp-hero-side')).toHaveCount(0);
        const erste = await page.locator('.vp-kraster [data-kachel]').first().getAttribute('data-kachel');
        expect(erste).toBe(lage === 'gewerbe' ? 'lastspitze' : 'heute');
        if (lage !== 'gewerbe') {
          await expect(page.locator('.vp-k-geldzeile')).toBeVisible();
          // Die Kopfzeile beim Scrollen trägt keinen Euro, wenn der Fluss führt.
          await expect(page.locator('.vp-mob-sticky-money')).toHaveCount(0);
        }
        const m = await messen(page);
        expect(m.ueberlauf).toBeLessThanOrEqual(0);
        expect(fehler).toEqual([]);
      });
    }
  });
}
