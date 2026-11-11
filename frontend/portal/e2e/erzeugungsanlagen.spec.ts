import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { Einspeiseverguetung, Erzeugungsanlage, Erzeugungsanlagen, StandorteAmStichtag } from '../src/api';

/**
 * Erzeugungsanlagen (Messkonzepte S1, nur Anzeige) unter „Strom & Geld" bei 375 und 1440 px, auf der echten
 * `TechnikSection` (`meine-anlage.html?fall=ohne`, „Hof Sonnenfeld"):
 * - mit EINER Erzeugungsanlage bleibt die Karte, wie sie war; im Blatt nur der leise Einstieg für eine zweite,
 *   der Dialog geht über dem Blatt auf und legt die zweite an,
 * - ab der zweiten: „2 Erzeugungsanlagen", je EA ihr Satz, und der Satz, mit dem Fahrplan und Erlöse rechnen.
 * Je Schritt: kein horizontaler Überlauf von Seite, Blatt und Dialog.
 *
 * Hof Brandl ist erfunden. Mit `EA_BILDER=<Ordner>` legt der Lauf je Schritt ein Bild ab.
 */

const BILDER = process.env.EA_BILDER;
const BREITEN = [375, 1440] as const;

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const OHNE_STANDORT: StandorteAmStichtag = {
  stichtag: '2026-10-20',
  standorte: [],
  nichtGezeigt: [],
  nochNichtZugeordnet: { anlagenZahl: 1, anlagen: [{ id: 's-1', name: 'Hof Sonnenfeld' }] },
};

const STAND: Einspeiseverguetung = {
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
};

function ea(over: Partial<Erzeugungsanlage> = {}): Erzeugungsanlage {
  return {
    id: 'ea-1',
    nummer: 1,
    name: null,
    bezeichnung: 'EA 1',
    art: 'pv',
    inbetriebnahme: '2025-06-01',
    inbetriebnahmeAbSolarspitzengesetz: null,
    registryUnitId: null,
    registryFetchedAt: null,
    folgtAnlage: true,
    fassung: { id: 'f-1', gueltigAb: null, leistungKwp: 9.8, einspeiseart: null, satzAngegebenCtKwh: null, herkunft: 'bestand' },
    fassungen: [],
    komponenten: [],
    verguetung: {
      zustand: 'eeg',
      wirksamCtKwh: 7.94,
      angegebenCtKwh: null,
      hergeleitetCtKwh: 7.94,
      naeherung: [],
      foerderendeAm: '2045-12-31',
      ohneVerguetungBeiNegativpreis: true,
    },
    ...over,
  };
}

const SCHEUNE = ea({
  id: 'ea-2',
  nummer: 2,
  name: 'PV Scheune',
  bezeichnung: 'EA 2 · PV Scheune',
  inbetriebnahme: '2009-04-14',
  folgtAnlage: false,
  fassung: { id: 'f-2', gueltigAb: null, leistungKwp: 30, einspeiseart: 'voll', satzAngegebenCtKwh: null, herkunft: 'angegeben' },
  verguetung: {
    zustand: 'eeg',
    wirksamCtKwh: 23.633,
    angegebenCtKwh: null,
    hergeleitetCtKwh: 23.633,
    naeherung: ['vor_erstem_band', 'volleinspeisung'],
    foerderendeAm: '2029-12-31',
    ohneVerguetungBeiNegativpreis: false,
  },
});

const liste = (eas: Erzeugungsanlage[]): Erzeugungsanlagen => ({
  stichtag: '2026-10-20',
  netzanschluss: null,
  erzeugungsanlagen: eas,
  vorschlaege: [],
});

/** Verdrahtet die Cloud: die Karte der Anlage bleibt fest; POST legt EA 2 an und merkt sich den Body. */
async function verdrahte(page: Page, start: Erzeugungsanlage[]) {
  const gesendet: unknown[] = [];
  let eas = start;
  await page.route((url) => url.hostname !== '127.0.0.1', (r) => r.abort());
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/standorte', (r) => r.fulfill(json(OHNE_STANDORT)));
  await page.route('**/api/v1/sites/*/einspeiseverguetung', (r) => r.fulfill(json(STAND)));
  await page.route('**/api/v1/sites/*/erzeugungsanlagen**', async (r: Route) => {
    if (r.request().method() === 'POST') {
      gesendet.push(r.request().postDataJSON());
      eas = [{ ...eas[0], folgtAnlage: false }, SCHEUNE];
      return r.fulfill(json(liste(eas), 201));
    }
    return r.fulfill(json(liste(eas)));
  });
  return gesendet;
}

async function oeffne(page: Page, breite: number) {
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/meine-anlage.html?fall=ohne');
  await expect(page.locator('#technik-geld')).toBeVisible();
}

/** Kein Element ragt über den Rand, weder die Seite noch ein Blatt oder Dialog scrollen quer. */
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
  if (await page.locator('.vp-modal').count()) {
    await page.locator('.vp-modal .dbody').last().screenshot({ path: join(BILDER, `${name}-${breite}-blatt.png`) });
  }
}

test.describe('Erzeugungsanlagen unter Strom & Geld', () => {
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'desktop-chromium', 'eine Bühne, zwei Breiten');
  });

  for (const breite of BREITEN) {
    test(`eine EA: Karte wie bisher, leiser Einstieg, zweite EA über dem Blatt - ${breite} px`, async ({ page }) => {
      const gesendet = await verdrahte(page, [ea()]);
      await oeffne(page, breite);
      const zeile = page.locator('#technik-verguetung');
      await expect(zeile).toContainText('7,94');
      await expect(zeile).toContainText('hergeleitet aus EEG, Inbetriebnahme 01.06.2025');
      await expect(zeile).not.toContainText('Erzeugungsanlage');

      await zeile.getByRole('button').click();
      const blatt = page.getByRole('dialog', { name: 'Einspeisevergütung' });
      const einstieg = blatt.getByRole('button', { name: 'Weitere Erzeugungsanlage mit eigener Inbetriebnahme hinzufügen' });
      await expect(einstieg).toBeVisible();
      await expect(blatt.getByTestId('erzeugungsanlagen')).toHaveCount(0);
      await expect(blatt.getByText(/Messkonzept/)).toHaveCount(0);
      await einstieg.scrollIntoViewIfNeeded();
      await ohneUeberlauf(page, breite, 'eine-ea-blatt');

      await einstieg.click();
      const dialog = page.getByRole('dialog', { name: 'Erzeugungsanlage hinzufügen' });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Name (freiwillig)').fill('PV Scheune');
      await dialog.getByLabel('Leistung (kWp)').fill('30');
      await ohneUeberlauf(page, breite, 'eine-ea-dialog');
      // Der Dialog liegt über dem Blatt und nimmt Klicks an - auch am Telefon.
      await dialog.getByRole('button', { name: 'Speichern' }).click();
      await expect(dialog).toBeHidden();
      expect(gesendet).toHaveLength(1);
      expect(gesendet[0]).toMatchObject({ name: 'PV Scheune', leistungKwp: 30 });

      await expect(blatt.getByTestId('ea-2')).toContainText('EA 2 · PV Scheune');
      await expect(zeile).toContainText('2 Erzeugungsanlagen');
    });

    test(`zwei EA: je EA ihr Satz, der Satz für Fahrplan und Erlöse - ${breite} px`, async ({ page }) => {
      await verdrahte(page, [ea({ folgtAnlage: false }), SCHEUNE]);
      await oeffne(page, breite);
      const zeile = page.locator('#technik-verguetung');
      await expect(zeile).toContainText('2 Erzeugungsanlagen');
      await expect(zeile).toContainText('EA 1: 7,94 ct/kWh · EA 2: 23,63 ct/kWh');
      await zeile.scrollIntoViewIfNeeded();
      await ohneUeberlauf(page, breite, 'zwei-ea-zeile');

      await zeile.getByRole('button').first().click();
      const blatt = page.getByRole('dialog', { name: 'Einspeisevergütung' });
      await expect(blatt.getByTestId('ea-1')).toContainText('7,94');
      await expect(blatt.getByTestId('ea-2')).toContainText('Inbetriebnahme 14.04.2009 · 30,0 kWp · Volleinspeisung');
      await expect(blatt.getByText(/Fahrplan und Erlöse rechnen bis auf Weiteres mit einem Satz/)).toBeVisible();
      await expect(blatt.getByTestId('verguetung-jetzt')).toContainText('7,94');
      await ohneUeberlauf(page, breite, 'zwei-ea-blatt');

      await blatt.getByTestId('ea-2').getByRole('button', { name: 'Bearbeiten' }).click();
      const dialog = page.getByRole('dialog', { name: 'EA 2 · PV Scheune bearbeiten' });
      await expect(dialog).toBeVisible();
      await ohneUeberlauf(page, breite, 'zwei-ea-bearbeiten');
      await dialog.getByRole('button', { name: 'Abbrechen' }).click();
      await expect(dialog).toBeHidden();
      await expect(blatt).toBeVisible();
    });

    test(`am Netzanschluss: die EA der gebundenen Anlage, Hinzufügen im Dialog - ${breite} px`, async ({ page }) => {
      await page.clock.setFixedTime(new Date('2026-10-20T08:15:30Z'));
      await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 1000 });
      await page.goto('/e2e/startansicht.html?bild=unternehmen&ansicht=werk-netzanschluesse&ea=zwei');
      await expect(page.getByTestId('netzanschluesse')).toBeVisible();
      await expect(page.getByText('Wird geladen …', { exact: true })).toHaveCount(0);
      const abschnitt = page.getByTestId('netzanschluss-NA-1').locator('[data-testid^="na-erzeugungsanlagen-"]');
      await expect(abschnitt).toContainText('Erzeugungsanlagen');
      await expect(abschnitt.getByTestId('ea-1')).toContainText('7,94');
      await expect(abschnitt.getByTestId('ea-2')).toContainText('EA 2 · PV Scheune');
      await expect(abschnitt.getByText(/Messkonzept/)).toHaveCount(0);
      await abschnitt.scrollIntoViewIfNeeded();
      await ohneUeberlaufNa(page, breite, 'na-zwei-ea');

      await abschnitt.getByRole('button', { name: 'Erzeugungsanlage hinzufügen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Erzeugungsanlage hinzufügen' });
      await expect(dialog.getByLabel('MaStR-Nummer der Einheit')).toBeVisible();
      await ohneUeberlaufNa(page, breite, 'na-hinzufuegen');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  }
});

/** Wie {@link ohneUeberlauf}, für die Seite der Netzanschlüsse (andere Schale). */
async function ohneUeberlaufNa(page: Page, breite: number, name: string) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('[data-testid="netzanschluesse"] *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    return { seite: document.documentElement.scrollWidth - document.documentElement.clientWidth, draussen };
  }, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}
