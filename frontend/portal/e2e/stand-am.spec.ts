import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ahrenbergUnternehmen } from '../src/test/standorteFixtures';
import { a12Liste, a12Orte, A12_HEUTE, type A12Stichtag } from '../src/test/standAmFixtures';

/**
 * „Stand am …“ (UEMS AP-02 IP-13, H1, A12) auf der Liste „Standorte“ mit den
 * Ortsbäumen ihrer Karten, bei 375 und 1440 px: kein Querlauf der Seite, der
 * Reiter oder eines einzelnen Elements — GEMESSEN, nicht behauptet. Die Cloud ist
 * per `page.route` verdrahtet (Szenario `ahrenberg`, heute = 10.04.2027,
 * `src/test/standAmFixtures.ts`); der Stichtag wird im echten Datumsfeld gewählt.
 *
 * Mit `STAND_AM_BILDER=<Ordner>` legt der Lauf je Fall ein Bild (erster Bildschirm
 * und ganze Seite) und `messung-<fall>-<breite>.json` ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.STAND_AM_BILDER;
const BREITEN = [375, 1440] as const;

async function oeffne(page: Page, breite: number) {
  const angefragt: string[] = [];
  await page.route('**/api/v1/unternehmen', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ahrenbergUnternehmen({ standortZahl: 3 })) }),
  );
  await page.route('**/api/v1/standorte**', (r) => {
    const url = new URL(r.request().url());
    const tag = (url.searchParams.get('stichtag') ?? A12_HEUTE) as A12Stichtag;
    angefragt.push(`${r.request().method()} ${url.pathname}${url.search}`);
    const orte = url.pathname.match(/\/standorte\/([^/]+)\/orte$/);
    const body = orte ? a12Orte(orte[1], tag) : a12Liste(tag);
    return body
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      : r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/standorte.html');
  await expect(page.getByRole('combobox', { name: 'Stand am' })).toHaveText(/10\.04\.2027/);
  return angefragt;
}

/** Wählt im echten Datumsfeld einen Tag — blättert Monat für Monat zurück. */
async function waehleTag(page: Page, iso: string) {
  const feld = page.getByRole('combobox', { name: 'Stand am' });
  const [t, m, j] = ((await feld.textContent())!.match(/\d{2}\.\d{2}\.\d{4}/)![0]).split('.');
  const richtung = iso < `${j}-${m}-${t}` ? 'Voriger Monat' : 'Nächster Monat';
  await feld.click();
  const tag = page.locator(`.vp-kal-tag[data-iso="${iso}"]:not(.is-rand)`);
  for (let i = 0; i < 24 && !(await tag.count()); i++) await page.getByRole('button', { name: richtung }).click();
  await tag.click();
  await expect(page.locator('.vp-kal-gitter')).toHaveCount(0);
  const [jj, mm, dd] = iso.split('-');
  await expect(page.getByRole('status')).toContainText(`Sie sehen den Stand am ${dd}.${mm}.${jj}`);
  await expect(page.getByText('Gebäude werden geladen …')).toHaveCount(0);
  await expect(page.getByText('Standorte werden geladen …')).toHaveCount(0);
}

/** Querlauf in px: Seite, Reiterleiste und jedes Element über den Rand. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const tabs = document.querySelector('.vp-bereich-tabs') as HTMLElement | null;
    const hoehe = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return el ? Math.round(el.getBoundingClientRect().height) : null;
    };
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      reiter: tabs ? tabs.scrollWidth - tabs.clientWidth : null,
      draussen,
      hoeheStandAm: hoehe('[data-testid="stand-am"]'),
      hoeheBanner: hoehe('.vp-sa-banner'),
      hoeheSeite: document.documentElement.scrollHeight,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string) {
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await ueberlauf(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.reiter ?? 0, `${name} ${breite}: Reiter`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
}

/** Kein Knopf außer „Zurück zu heute“ — kein Anlegen, kein Stift, kein „Fläche eintragen“. */
async function keinSchreibweg(page: Page) {
  await expect(page.locator('.vp-main').getByRole('button')).toHaveText(['Zurück zu heute']);
}

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test('heute: Datumsfeld über der Liste, Schreibwege da', async ({ page }) => {
      await oeffne(page, breite);
      await expect(page.getByRole('button', { name: 'Standort anlegen' })).toBeVisible();
      await expect(page.getByRole('status')).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'heute');
    });

    test('A12: 15.02.2027 · 15.03.2027 · 15.09.2026 — Banner, Baum des Tages, kein Schreibweg', async ({ page }) => {
      // Drei Stichtage mit je zwei Bildern — länger als die 30 s der Vorgabe.
      test.slow();
      const angefragt = await oeffne(page, breite);

      await waehleTag(page, '2027-02-15');
      await expect(page.getByTestId('ortsbaum')).toHaveCount(2);
      await expect(page.getByTestId('ortsbaum').first().getByText('Halle 2', { exact: true })).toBeVisible();
      await expect(page.getByTestId('gab-es-noch-nicht')).toHaveText(/Am 15\.02\.2027 gab es Werk Ahrenberg Nord im Portal noch nicht\./);
      await keinSchreibweg(page);
      await messeUndFotografiere(page, breite, 'stand-15-02-2027');

      await waehleTag(page, '2027-03-15');
      await expect(page.getByTestId('ortsbaum')).toHaveCount(3);
      await expect(page.getByTestId('ortsbaum').nth(2).getByText('Halle 2', { exact: true })).toBeVisible();
      await expect(page.getByTestId('ortsbaum').first().getByText('Halle 2', { exact: true })).toHaveCount(0);
      await keinSchreibweg(page);
      await messeUndFotografiere(page, breite, 'stand-15-03-2027');

      await waehleTag(page, '2026-09-15');
      await expect(page.getByTestId('gab-es-noch-nicht')).toHaveCount(3);
      await expect(page.getByText('Am 15.09.2026 gab es Werk Ahrenberg im Portal noch nicht.')).toBeVisible();
      await expect(page.getByTestId('noch-nicht-zugeordnet')).toHaveCount(0);
      await keinSchreibweg(page);
      await messeUndFotografiere(page, breite, 'stand-15-09-2026');

      expect(angefragt).toContain('GET /api/v1/standorte?stichtag=2026-09-15');
      expect(angefragt.filter((a) => !a.startsWith('GET '))).toEqual([]);

      await page.getByRole('button', { name: 'Zurück zu heute' }).click();
      await expect(page.getByRole('status')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Standort anlegen' })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Stand am' })).toBeFocused();
    });
  });
}
