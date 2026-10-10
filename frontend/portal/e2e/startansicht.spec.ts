import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Die Startansicht-Weiche (UEMS AP-01 IP-5) bei 375 und 1440 px: die Landung
 * je Startbild, der Pfad im Seitenkopf und KEIN Querlauf — GEMESSEN am
 * Dokument (`scrollWidth − clientWidth`), nicht am Fenster: in der
 * Telefon-Emulation ist `innerWidth` nicht zwingend die Gerätebreite.
 *
 * Mit `STARTANSICHT_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und die
 * Messwerte (`messung-<fall>-<breite>.json`) ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.STARTANSICHT_BILDER;
const BREITEN = [375, 1440] as const;
const JETZT = new Date('2026-10-20T08:15:30Z');
const ST1 = '5a1d0000-0000-4000-8000-000000000001';
const ST2 = '5a1d0000-0000-4000-8000-000000000002';
const AN1 = 'a0000000-0000-4000-8000-000000000001';

interface Fall {
  name: string;
  query: string;
  route: string;
  /** Das letzte Glied der Kopfzeile (Anlagen- oder Ortsname). */
  kopf: string;
  /** Die sichtbaren Glieder davor — am Rechner und am Telefon. */
  vor: { rechner: string[]; telefon: string[] };
}

const FAELLE: Fall[] = [
  { name: 'einzel', query: 'bild=einzel', route: `#/anlage/${AN1}`, kopf: 'Werk Ahrenberg – Halle 1', vor: { rechner: [], telefon: [] } },
  { name: 'standort', query: 'bild=standort', route: `#/standort/${ST1}`, kopf: 'Werk Ahrenberg', vor: { rechner: [], telefon: [] } },
  { name: 'unternehmen', query: 'bild=unternehmen', route: '#/portfolio', kopf: 'Ahrenberg', vor: { rechner: [], telefon: [] } },
  {
    name: 'unternehmen-halle1',
    query: 'bild=unternehmen&ansicht=anlage',
    route: `#/anlage/${AN1}`,
    kopf: 'Werk Ahrenberg – Halle 1',
    // Am Telefon trägt die Kopfzeile nur den Anlagennamen; der Rückweg steht im Umschalter.
    vor: { rechner: ['Ahrenberg', 'Werk Ahrenberg'], telefon: [] },
  },
  {
    name: 'unternehmen-lindach',
    query: 'bild=unternehmen&ansicht=lindach',
    route: `#/standort/${ST2}`,
    kopf: 'Werk Lindach',
    vor: { rechner: ['Ahrenberg'], telefon: ['Ahrenberg'] },
  },
];

async function oeffne(page: Page, query: string, breite: number) {
  await page.clock.setFixedTime(JETZT);
  await page.setViewportSize({ width: breite, height: breite < 721 ? 812 : 900 });
  await page.goto(`/e2e/startansicht.html?${query}`);
  await expect(page.locator('.vp-topbar .here').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
}

/** Querlauf am DOKUMENT und jedes Element der Kopfzeile oder des Inhalts über den Rand. */
async function messe(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const rand = doc.clientWidth;
    const draussen = [...document.querySelectorAll('.vp-topbar *, .vp-main *')]
      // Kinder einer eigenen Scrollfläche (Reiterleiste) und Sprungziele zählen nicht.
      .filter((el) => !el.closest('.vp-bereich-tabs, .vp-sr-only'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0 && (r.right > rand + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const sichtbar = (el: Element) => el.getBoundingClientRect().width > 0;
    const glieder = [...document.querySelectorAll<HTMLElement>('.vp-topbar .vp-crumb-up')].filter(sichtbar);
    const here = [...document.querySelectorAll<HTMLElement>('.vp-topbar .here')].filter(sichtbar);
    return {
      route: document.body.dataset.route ?? null,
      dokument: doc.scrollWidth - doc.clientWidth,
      clientWidth: rand,
      innerWidth: window.innerWidth,
      draussen,
      kopf: here.map((h) => h.textContent),
      gekuerzt: here.filter((h) => h.scrollWidth > h.clientWidth + 0.5).map((h) => h.textContent),
      vor: glieder.map((g) => g.textContent),
      gliedHoehe: glieder.map((g) => Math.round(g.getBoundingClientRect().height)),
    };
  });
}

async function ablegen(page: Page, name: string, breite: number, m: unknown) {
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
}

for (const fall of FAELLE) {
  for (const breite of BREITEN) {
    test(`Startansicht ${fall.name} bei ${breite} px: Landung, Pfad, kein Querlauf`, async ({ page }) => {
      await oeffne(page, fall.query, breite);
      const m = await messe(page);
      expect(m.route, `${fall.name} ${breite}: Landung`).toBe(fall.route);
      expect(m.dokument, `${fall.name} ${breite}: Querlauf des Dokuments`).toBe(0);
      expect(m.draussen, `${fall.name} ${breite}: Elemente über dem Rand`).toEqual([]);
      expect(m.kopf, `${fall.name} ${breite}: letztes Glied`).toContain(fall.kopf);
      expect(m.gekuerzt, `${fall.name} ${breite}: gekürztes Glied`).toEqual([]);
      expect(m.vor, `${fall.name} ${breite}: Glieder davor`).toEqual(breite < 721 ? fall.vor.telefon : fall.vor.rechner);
      if (breite < 721) {
        for (const h of m.gliedHoehe) expect(h, `${fall.name} ${breite}: Trefferfläche`).toBeGreaterThanOrEqual(44);
      }
      await ablegen(page, fall.name, breite, m);
    });
  }
}

test('Rechner: jedes Glied des Pfades führt eine Ebene hinauf', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen&ansicht=anlage', 1440);
  const kopf = page.locator('.vp-topbar');
  await kopf.getByRole('button', { name: 'Werk Ahrenberg', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${ST1}`);
  await expect(kopf.locator('.here')).toHaveText('Werk Ahrenberg');
  // Unter einem Unternehmen: dieselbe Übersicht, auf den Standort gefiltert (IP-6) — nur seine Anlagen.
  await expect(page.getByRole('button', { name: 'Anlage Werk Ahrenberg – Halle 2 öffnen' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anlage Werk Lindach öffnen' })).toHaveCount(0);
  await kopf.getByRole('button', { name: 'Ahrenberg', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', '#/portfolio');
  await expect(kopf.locator('.here')).toHaveText('Ahrenberg');
});

test('Telefon: der Umschalter trägt Unternehmen und Standort als Rückweg', async ({ page }) => {
  await oeffne(page, 'bild=unternehmen&ansicht=anlage', 375);
  const name = page.locator('.vp-topbar .here');
  const box = (await name.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole('option', { name: /Ahrenberg\s*Unternehmen · Übersicht/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Werk Ahrenberg\s*Standort · Übersicht/ })).toBeVisible();
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
  const m = await messe(page);
  expect(m.dokument).toBe(0);
  await ablegen(page, 'unternehmen-halle1-umschalter', 375, m);
  await page.getByRole('option', { name: /Werk Ahrenberg\s*Standort · Übersicht/ }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${ST1}`);
});

test('Telefon: ein Standort mit mehreren Anlagen trägt die Reiter der Ebene, „Übersicht" bleibt dort', async ({ page }) => {
  await oeffne(page, 'bild=standort', 375);
  const reiter = page.getByRole('tablist');
  await expect(reiter.getByRole('tab', { name: 'Übersicht' })).toHaveAttribute('aria-selected', 'true');
  await reiter.getByRole('tab', { name: 'Übersicht' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-route', `#/standort/${ST1}`);
});
