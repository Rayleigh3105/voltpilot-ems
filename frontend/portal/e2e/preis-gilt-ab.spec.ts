import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { StandorteAmStichtag } from '../src/api';

/**
 * „Ab wann?“ beim Stromtarif (vp-tarif-ab-tag): die echte Einstellungsseite
 * (`e2e/meine-anlage.html?fall=ohne`) gegen eine gemockte Cloud. Das Feld ist
 * mit heute vorbelegt, ein früherer Tag geht über den Kalender, ein künftiger
 * ist gesperrt, „Schon immer“ berichtigt von Anfang an - und der Satz darunter
 * sagt jeweils, was mit den Erlösen geschieht. Tarif und Preisblatt reisen mit
 * DEMSELBEN Tag.
 *
 * Mit `PREIS_GILT_AB_BILDER=<Ordner>` legt der Lauf je Breite Bilder ab.
 */
const BILDER = process.env.PREIS_GILT_AB_BILDER;
const BREITEN = [375, 1440] as const;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const OHNE_STANDORT: StandorteAmStichtag = {
  stichtag: '2026-10-20',
  standorte: [],
  nichtGezeigt: [],
  nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: 's-1', name: 'Hof Sonnenfeld' }] },
};

function berlinTag(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

async function verdrahte(page: Page) {
  const gesendet: { pfad: string; body: Record<string, unknown> }[] = [];
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/standorte', (r) => r.fulfill(json(OHNE_STANDORT)));
  await page.route('**/api/v1/sites/s-1', async (r: Route) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    const body = r.request().postDataJSON() as Record<string, unknown>;
    gesendet.push({ pfad: 'site', body });
    return r.fulfill(json({ id: 's-1', ...body }));
  });
  return gesendet;
}

async function ohneUeberlauf(page: Page, breite: number, name: string) {
  await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : 0,
      draussen,
    };
  }, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog, `${name} ${breite}: Blatt`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  const feld = page.getByTestId('preis-gilt-ab');
  await feld.scrollIntoViewIfNeeded();
  await page.locator('.vp-modal .dbody').last().screenshot({ path: join(BILDER, `${name}-${breite}-blatt.png`) });
}

test.describe('Stromtarif: Ab wann?', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-chromium', 'eine Bühne, zwei Breiten');
  });

  for (const breite of BREITEN) {
    test(`ab einem früheren Tag, dann schon immer - ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahte(page);
      await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
      await page.goto('/e2e/meine-anlage.html?fall=ohne');
      await expect(page.locator('#technik-geld')).toBeVisible();

      await page.locator('#technik-geld').getByRole('button', { name: /Stromtarif/ }).first().click();
      const blatt = page.getByRole('dialog', { name: 'Stromtarif' });
      const feld = blatt.getByTestId('preis-gilt-ab');
      await expect(feld).toContainText('Ab wann?');
      await expect(feld).toContainText('Ab heute. Die Erlöse der Tage davor bleiben, wie sie waren.');

      await blatt.getByRole('combobox', { name: 'Stromtarif' }).click();
      await page.getByRole('option', { name: 'Fest (ct/kWh)' }).click();
      await blatt.getByLabel('Arbeitspreis (all-in, brutto) (ct/kWh)').fill('32,5');
      await ohneUeberlauf(page, breite, 'tarif-ab-heute');

      // Ein früherer Tag über den Kalender: drei Tage zurück (ggf. im Vormonat).
      const jetzt = new Date();
      const heute = berlinTag(jetzt);
      const frueher = berlinTag(new Date(jetzt.getTime() - 3 * 86_400_000));
      await feld.getByRole('combobox', { name: 'Ab wann?' }).click();
      const kalender = page.getByRole('grid', { name: 'Ab wann?' });
      await expect(kalender).toBeVisible();
      // Morgen ist nicht wählbar - nie in der Zukunft.
      const morgen = berlinTag(new Date(jetzt.getTime() + 86_400_000));
      const morgenKnopf = kalender.locator(`[data-iso="${morgen}"]`);
      if (await morgenKnopf.count()) await expect(morgenKnopf.first()).toBeDisabled();
      if (frueher.slice(0, 7) !== heute.slice(0, 7) && !(await kalender.locator(`[data-iso="${frueher}"]`).count())) {
        await page.getByRole('button', { name: 'Voriger Monat' }).click();
      }
      await kalender.locator(`[data-iso="${frueher}"]`).first().click();
      const [j, mo, t] = frueher.split('-');
      await expect(feld).toContainText(
        `Ab dem ${t}.${mo}.${j}. Die Erlöse ab diesem Tag werden neu berechnet, die davor bleiben.`,
      );
      await ohneUeberlauf(page, breite, 'tarif-ab-tag');

      // „Schon immer“ berichtigt von Anfang an.
      await feld.getByText(/Schon immer/).click();
      await expect(feld.getByRole('checkbox', { name: /Schon immer/ })).toBeChecked();
      await expect(feld).toContainText('Alle bisherigen Erlöse werden mit dem neuen Wert neu berechnet.');
      await ohneUeberlauf(page, breite, 'tarif-schon-immer');
      await feld.getByText(/Schon immer/).click();
      await expect(feld.getByRole('checkbox', { name: /Schon immer/ })).not.toBeChecked();

      await blatt.getByRole('button', { name: 'Speichern' }).click();
      await expect(blatt).toBeHidden();
      expect(gesendet).toEqual([
        {
          pfad: 'site',
          body: expect.objectContaining({ tarifArt: 'fest', tarifParamCtKwh: 32.5, tarifGueltigAb: frueher }),
        },
      ]);
    });
  }
});
