import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Telefon-Leiste je Ebene (UEMS AP-01 IP-7, E4 = A) bei 375 px, auf der
 * Bühne `startansicht` mit denselben reinen Funktionen wie `App.tsx`:
 *
 * - HEUTE: das Unternehmen Ahrenberg hat sechs Bereiche mit Seite; die Leiste trägt
 *   ihre GRUPPEN (`ebenenNav.UNTERNEHMEN_GRUPPEN`: Übersicht · Messen · Auswerten · Nachweisen),
 *   höchstens fünf Kacheln. Am Standort: Übersicht · Aufbau · Gebäude · Messstellen ·
 *   Anschlüsse — „Aufbau“ ist der EINE Ort für Anlagen, Boxen und Geräte (früher
 *   „Boxen“ und „Anlagen“).
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
  { name: 'betriebskunde-standort', query: 'bild=unternehmen&messen=bestand&ansicht=werk', leiste: null },
  // K1/D2: die Berichte stehen in „Nachweisen“.
  { name: 'unternehmen-heute', query: 'bild=unternehmen', leiste: ['Übersicht', 'Messen', 'Auswerten', 'Nachweisen'], aktiv: 'Übersicht' },
  { name: 'standort-heute', query: 'bild=unternehmen&ansicht=werk', leiste: ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse'], aktiv: 'Übersicht' },
  { name: 'lindach-heute', query: 'bild=unternehmen&ansicht=lindach', leiste: ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse'], aktiv: 'Übersicht' },
  { name: 'anlage-halle1', query: 'bild=unternehmen&ansicht=anlage', leiste: ['Cockpit', 'Fahrplan', 'Verlauf', 'Steuerung', 'Anlage'], aktiv: 'Cockpit' },
  { name: 'anlage-lindach-steuerung', query: 'bild=unternehmen&ansicht=steuerung-lindach', leiste: ['Cockpit', 'Verlauf', 'Steuerung', 'Anlage'], aktiv: 'Steuerung' },
  {
    name: 'unternehmen-kuenftig',
    query: 'bild=unternehmen&seiten=kuenftig',
    leiste: ['Übersicht', 'Messen', 'Auswerten', 'Nachweisen'],
    aktiv: 'Übersicht',
  },
  { name: 'standort-kuenftig', query: 'bild=unternehmen&ansicht=werk&seiten=kuenftig', leiste: ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse'], aktiv: 'Übersicht' },
  { name: 'lindach-kuenftig', query: 'bild=unternehmen&ansicht=lindach&seiten=kuenftig', leiste: ['Übersicht', 'Aufbau', 'Gebäude', 'Messstellen', 'Anschlüsse'], aktiv: 'Übersicht' },
  // firstmate K2 (09.10.2026): kein Standort misst, also ist die Standort-/Unternehmensebene gar
  // nicht erst die Landung (zeichengleich zu main) — keine Telefon-Leiste mehr (wie
  // „betriebskunde-standort" oben), die Übersicht · Energie wandern in die Reiter darüber.
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

/** Die Reiter der Ebene über der Seite, die am Telefon SICHTBAR sind (die Leiste trägt die übrigen; K1: die der Gruppe). */
const sichtbareReiter = (page: Page) =>
  page.locator('.vp-bereich-tabs[aria-label^="Reiter der Ebene"] [role="tab"], .vp-bereich-tabs[aria-label^="Reiter der Gruppe"] [role="tab"]').evaluateAll((tabs) =>
    tabs.filter((t) => (t as HTMLElement).offsetParent !== null).map((t) => t.textContent?.trim() ?? ''));

test('Telefon, künftig: „Standorte" steht als Reiter in der Gruppe „Übersicht" und führt auf die Liste', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen&seiten=kuenftig');
  // „Energie“ (die Messwerte des Unternehmens, main 3e95cc604) gehört zur Übersicht.
  expect(await sichtbareReiter(page)).toEqual(['Übersicht', 'Standorte', 'Energie']);
  await page.locator('.vp-bereich-tabs').getByRole('tab', { name: 'Standorte' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/standorte');
  // Die Kachel bleibt die der Gruppe.
  await expect(page.locator('.vp-bottombar [aria-current="page"] .lbl')).toHaveText('Übersicht');
});

test('Telefon, heute: die Kachel „Messen" führt auf „Unternehmen › Messstellen", ihre Reiter nennen die Gruppe', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen');
  await page.locator('.vp-bottombar').getByRole('button', { name: 'Messen' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio/messstellen');
  await expect(page.locator('.vp-bottombar [aria-current="page"] .lbl')).toHaveText('Messen');
  await expect(page.locator('[data-testid="messstellen"] [data-testid="messstelle-reihe"]')).toHaveCount(22);
  // N5: Kostenstellen und Prozesse stehen in derselben Reihe, sobald ihre Kataloge da sind.
  await expect.poll(() => sichtbareReiter(page)).toEqual(['Messstellen', 'Kostenstellen', 'Prozesse', 'Bezugsgrößen']);
});

test('Telefon, heute: die Kacheln „Gebäude" und „Aufbau" führen auf die Seiten des Standorts', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen&ansicht=werk');
  await page.locator('.vp-bottombar').getByRole('button', { name: 'Gebäude' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/gebaeude$/);
  await expect(page.locator('.vp-bottombar [aria-current="page"] .lbl')).toHaveText('Gebäude');
  await expect(page.locator('[data-testid="ortsbaum"]')).toBeVisible();
  await page.locator('.vp-bottombar').getByRole('button', { name: 'Aufbau' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', /^#\/standort\/[^/]+\/aufbau$/);
  await expect(page.locator('.vp-bottombar [aria-current="page"] .lbl')).toHaveText('Aufbau');
  await expect(page.getByTestId('standort-aufbau')).toBeVisible();
});
