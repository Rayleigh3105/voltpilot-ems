import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { Einspeiseverguetung, StandorteAmStichtag } from '../src/api';

/**
 * Die Karte „Einspeisevergütung" unter „Strom & Geld" bei 375 und 1440 px, auf der
 * echten `TechnikSection` (`meine-anlage.html?fall=ohne`, „Hof Sonnenfeld"):
 * - hergeleitet aus dem EEG → eigener Satz → Folge mit „Rückgängig",
 * - ohne Inbetriebnahmedatum: „Ohne Angabe" und die Pflichtfrage zu § 51a,
 * - Direktvermarktung: erklärt, nimmt nichts an.
 * Je Fall: kein horizontaler Überlauf von Seite und Blatt.
 *
 * Mit `VERGUETUNG_BILDER=<Ordner>` legt der Lauf je Fall ein Bild ab.
 */

const BILDER = process.env.VERGUETUNG_BILDER;
const BREITEN = [375, 1440] as const;

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const OHNE_STANDORT: StandorteAmStichtag = {
  stichtag: '2026-10-20',
  standorte: [],
  nichtGezeigt: [],
  nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: 's-1', name: 'Hof Sonnenfeld' }] },
};

function stand(over: Partial<Einspeiseverguetung> = {}): Einspeiseverguetung {
  return {
    zustand: 'eeg',
    wirksamCtKwh: 7.94,
    angegebenCtKwh: null,
    inbetriebnahmeAbSolarspitzengesetz: null,
    hergeleitetCtKwh: 7.94,
    hergeleitetGenaehert: false,
    inbetriebnahme: '2025-06-01',
    leistungKwp: 9.8,
    eegEndeAm: '2045-12-31',
    ohneVerguetungBeiNegativpreis: true,
    anzulegenderWertCtKwh: null,
    ...over,
  };
}

const OHNE_DATUM = stand({
  zustand: 'ohne_angabe',
  wirksamCtKwh: null,
  hergeleitetCtKwh: null,
  inbetriebnahme: null,
  leistungKwp: null,
  eegEndeAm: null,
  ohneVerguetungBeiNegativpreis: false,
});

/** Verdrahtet die Cloud: GET liefert den Stand, PUT antwortet wie der Server und merkt sich den Body. */
async function verdrahte(page: Page, start: Einspeiseverguetung) {
  const gesendet: unknown[] = [];
  let aktuell = start;
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/standorte', (r) => r.fulfill(json(OHNE_STANDORT)));
  await page.route('**/api/v1/sites/*/einspeiseverguetung', async (r: Route) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON() as { satzCtKwh: number | null; inbetriebnahmeAbSolarspitzengesetz?: boolean };
      gesendet.push(body);
      aktuell =
        body.satzCtKwh == null
          ? start.angegebenCtKwh == null
            ? start
            : stand()
          : {
              ...aktuell,
              zustand: 'angegeben',
              wirksamCtKwh: body.satzCtKwh,
              angegebenCtKwh: body.satzCtKwh,
              inbetriebnahmeAbSolarspitzengesetz: aktuell.inbetriebnahme == null ? (body.inbetriebnahmeAbSolarspitzengesetz ?? null) : null,
              ohneVerguetungBeiNegativpreis:
                aktuell.inbetriebnahme == null
                  ? body.inbetriebnahmeAbSolarspitzengesetz === true
                  : aktuell.ohneVerguetungBeiNegativpreis,
            };
      return r.fulfill(json(aktuell));
    }
    return r.fulfill(json(aktuell));
  });
  return gesendet;
}

async function oeffne(page: Page, breite: number) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/meine-anlage.html?fall=ohne');
  await expect(page.locator('#technik-geld')).toBeVisible();
}

/** Kein Element ragt über den Rand, weder die Seite noch das Blatt scrollen quer. */
async function ohneUeberlauf(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
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
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`), fullPage: !(await page.locator('.vp-modal').count()) });
  const koerper = page.locator('.vp-modal .dbody').last();
  if (await page.locator('.vp-modal').count()) {
    await koerper.screenshot({ path: join(BILDER, `${name}-${breite}-blatt.png`) });
  }
}

test.describe('Einspeisevergütung unter Strom & Geld', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-chromium', 'eine Bühne, zwei Breiten');
  });

  for (const breite of BREITEN) {
    test(`hergeleitet → eigener Satz → Rückgängig - ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahte(page, stand());
      await oeffne(page, breite);
      const zeile = page.locator('#technik-verguetung');
      await expect(zeile).toContainText('7,94');
      await expect(zeile).toContainText('hergeleitet aus EEG, Inbetriebnahme 01.06.2025');
      await zeile.scrollIntoViewIfNeeded();
      await ohneUeberlauf(page, breite, 'eeg-zeile');

      await zeile.getByRole('button').click();
      const blatt = page.getByRole('dialog', { name: 'Einspeisevergütung' });
      await expect(blatt.getByText('Wirkt auf: Fahrplan')).toBeVisible();
      await expect(blatt.getByTestId('verguetung-jetzt')).toContainText('7,94');
      await ohneUeberlauf(page, breite, 'eeg-blatt');

      await blatt.getByRole('radio', { name: /Eigenen Satz angeben/ }).check();
      await expect(blatt.getByLabel('Ihr Satz (ct/kWh)')).toBeFocused();
      await blatt.getByLabel('Ihr Satz (ct/kWh)').fill('12,5');
      await ohneUeberlauf(page, breite, 'eeg-eigener-satz');
      await blatt.getByRole('button', { name: 'Speichern' }).click();
      await expect(blatt).toBeHidden();
      expect(gesendet).toEqual([{ satzCtKwh: 12.5 }]);
      await expect(zeile).toContainText('12,50');
      await expect(zeile).toContainText('von Ihnen angegeben');
      await expect(zeile).toContainText('Ab dem nächsten Fahrplan gilt Ihr Satz');
      await ohneUeberlauf(page, breite, 'angegeben-folge');

      await zeile.getByRole('button', { name: 'Rückgängig' }).click();
      await expect(zeile).toContainText('7,94');
      expect(gesendet).toEqual([{ satzCtKwh: 12.5 }, { satzCtKwh: null }]);
    });

    test(`ohne Datum: „Ohne Angabe" und die Pflichtfrage zu § 51a - ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahte(page, OHNE_DATUM);
      await oeffne(page, breite);
      const zeile = page.locator('#technik-verguetung');
      await expect(zeile).toContainText('Ohne Angabe');
      await expect(zeile).toContainText('Vergütung nicht hinterlegt');
      await zeile.scrollIntoViewIfNeeded();
      await ohneUeberlauf(page, breite, 'ohne-angabe-zeile');

      await zeile.getByRole('button').click();
      const blatt = page.getByRole('dialog', { name: 'Einspeisevergütung' });
      await expect(blatt.getByRole('button', { name: /Anlage verknüpfen/ })).toBeVisible();
      await blatt.getByRole('radio', { name: /Eigenen Satz angeben/ }).check();
      await blatt.getByLabel('Ihr Satz (ct/kWh)').fill('6');
      const frage = blatt.getByRole('group', { name: 'Wann ging Ihre Anlage in Betrieb?' });
      await expect(frage).toBeVisible();
      await blatt.getByRole('button', { name: 'Speichern' }).click();
      await expect(frage.getByRole('alert')).toContainText('negativem Börsenpreis');
      expect(gesendet).toEqual([]);
      await ohneUeberlauf(page, breite, 'ohne-angabe-frage');

      await frage.getByRole('radio', { name: /am 25\.02\.2025 oder später/ }).check();
      await blatt.getByRole('button', { name: 'Speichern' }).click();
      await expect(blatt).toBeHidden();
      expect(gesendet).toEqual([{ satzCtKwh: 6, inbetriebnahmeAbSolarspitzengesetz: true }]);
      await expect(zeile).toContainText('6,00');
      await expect(zeile).toContainText('von Ihnen angegeben');
    });

    test(`Direktvermarktung: erklärt den Börsenpreis + Marktprämie - ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahte(
        page,
        stand({ zustand: 'direktvermarktung', wirksamCtKwh: null, anzulegenderWertCtKwh: 8.11 }),
      );
      await oeffne(page, breite);
      const zeile = page.locator('#technik-verguetung');
      await expect(zeile).toContainText('Börsenpreis + Marktprämie');
      await zeile.getByRole('button').click();
      const blatt = page.getByRole('dialog', { name: 'Einspeisevergütung' });
      await expect(blatt.getByText(/Marktprämie aus Ihrem anzulegenden Wert/)).toContainText('8,11');
      await expect(blatt.getByRole('radio')).toHaveCount(0);
      await ohneUeberlauf(page, breite, 'dv-blatt');
      await blatt.getByRole('button', { name: 'Verstanden' }).click();
      await expect(blatt).toBeHidden();
      expect(gesendet).toEqual([]);
    });
  }
});
