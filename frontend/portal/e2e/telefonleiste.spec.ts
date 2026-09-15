import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Telefon-Leiste je Ebene (UEMS AP-01 IP-7, E4 = A) bei 375 px, auf der
 * Bühne `startansicht` mit denselben reinen Funktionen wie `App.tsx`:
 *
 * - HEUTE: seit AP-04 IP-5 hat das Unternehmen Ahrenberg DREI Bereiche mit Seite
 *   (Übersicht · Standorte · Messstellen) — die Leiste erscheint. Der Standort Werk
 *   Ahrenberg bleibt bei zwei (Übersicht · Messstellen) und ohne Leiste.
 * - Die Anlage: ihre Leiste, unverändert.
 * - KÜNFTIG (`&seiten=kuenftig`): das Bild, sobald jeder Bereich eine Seite hat
 *   (AP-04 IP-5, AP-13) — nur für die Vorschau.
 *
 * Querlauf GEMESSEN am Dokument (`scrollWidth − clientWidth`), nicht am Fenster.
 * Mit `TELEFONLEISTE_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und die
 * Messwerte (`messung-<fall>.json`) ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.TELEFONLEISTE_BILDER;
const JETZT = new Date('2026-10-20T08:15:30Z');

interface Fall {
  name: string;
  query: string;
  /** Die Kacheln; `null` = keine Leiste. */
  leiste: string[] | null;
  aktiv?: string;
}

const FAELLE: Fall[] = [
  { name: 'unternehmen-heute', query: 'bild=unternehmen', leiste: ['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen'], aktiv: 'Übersicht' },
  { name: 'standort-heute', query: 'bild=unternehmen&ansicht=werk', leiste: null },
  { name: 'anlage-halle1', query: 'bild=unternehmen&ansicht=anlage', leiste: ['Cockpit', 'Fahrplan', 'Verlauf', 'Steuerung', 'Anlage'], aktiv: 'Cockpit' },
  { name: 'anlage-lindach-steuerung', query: 'bild=unternehmen&ansicht=steuerung-lindach', leiste: ['Cockpit', 'Verlauf', 'Steuerung', 'Anlage'], aktiv: 'Steuerung' },
  {
    name: 'unternehmen-kuenftig',
    query: 'bild=unternehmen&seiten=kuenftig',
    leiste: ['Übersicht', 'Standorte', 'Messstellen', 'Kennzahlen', 'Berichte'],
    aktiv: 'Übersicht',
  },
  { name: 'standort-kuenftig', query: 'bild=unternehmen&ansicht=werk&seiten=kuenftig', leiste: ['Übersicht', 'Gebäude', 'Anlagen', 'Messstellen'], aktiv: 'Übersicht' },
  { name: 'lindach-kuenftig', query: 'bild=unternehmen&ansicht=lindach&seiten=kuenftig', leiste: ['Übersicht', 'Gebäude', 'Messstellen'], aktiv: 'Übersicht' },
  // Der Betriebskunde ohne „Messen": auch mit allen Seiten nur Übersicht · Standorte — keine Leiste.
  { name: 'betriebskunde-kuenftig', query: 'bild=unternehmen&messen=bestand&seiten=kuenftig', leiste: null },
];

async function oeffne(page: Page, query: string) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar .here').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const bar = document.querySelector<HTMLElement>('.vp-bottombar');
    const items = [...document.querySelectorAll<HTMLElement>('.vp-bottombar-item')];
    const lbl = (i: HTMLElement) => i.querySelector<HTMLElement>('.lbl')!;
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      leiste: bar ? items.map((i) => lbl(i).textContent ?? '') : null,
      name: bar?.getAttribute('aria-label') ?? null,
      aktiv: bar?.querySelector('[aria-current="page"] .lbl')?.textContent ?? null,
      spalten: bar ? getComputedStyle(bar).gridTemplateColumns.split(' ').length : null,
      gekuerzt: items.map(lbl).filter((l) => l.scrollWidth > l.clientWidth + 0.5).map((l) => l.textContent),
      kachelHoehe: items.map((i) => Math.round(i.getBoundingClientRect().height)),
      kachelBreite: items.map((i) => Math.round(i.getBoundingClientRect().width * 10) / 10),
      reiter: [...document.querySelectorAll('[role="tablist"] [role="tab"]')].map((t) => t.textContent?.trim() ?? ''),
    };
  });
}

async function ablegen(page: Page, name: string, m: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}.png`) });
}

for (const fall of FAELLE) {
  test(`Telefon-Leiste ${fall.name} bei 375 px: Kacheln, keine gekürzte Beschriftung, kein Querlauf`, async ({ page }) => {
    await oeffne(page, fall.query);
    const m = await messe(page);
    expect(m.dokument, `${fall.name}: Querlauf des Dokuments`).toBe(0);
    expect(m.leiste, `${fall.name}: Kacheln`).toEqual(fall.leiste);
    if (fall.leiste) {
      expect(m.aktiv, `${fall.name}: offene Kachel`).toBe(fall.aktiv);
      expect(m.spalten, `${fall.name}: --vp-bar-slots`).toBe(fall.leiste.length);
      expect(m.gekuerzt, `${fall.name}: gekürzte Beschriftung`).toEqual([]);
      for (const h of m.kachelHoehe) expect(h, `${fall.name}: Trefferfläche`).toBeGreaterThanOrEqual(44);
      expect(m.leiste.join(' · ')).toMatch(fall.leiste.includes('Cockpit') ? /Steuerung/ : /^(?!.*Steuer)/);
    }
    await ablegen(page, fall.name, m);
  });
}

test('Telefon, künftig: die Kachel „Standorte" führt auf die Liste der Standorte', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen&seiten=kuenftig');
  await page.locator('.vp-bottombar').getByRole('button', { name: 'Standorte' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/standorte');
});

test('Telefon, heute (AP-04 IP-5): die Kachel „Messstellen" führt auf „Unternehmen › Messstellen"', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen');
  await page.locator('.vp-bottombar').getByRole('button', { name: 'Messstellen' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/messstellen');
  await expect(page.locator('.vp-bottombar [aria-current="page"] .lbl')).toHaveText('Messstellen');
  await expect(page.locator('[data-testid="messstellen"] .vp-ms-karte')).toHaveCount(22);
});
