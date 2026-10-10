import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { OrtsbaumAmStichtag } from '../src/api';
import {
  ortNachSchreiben,
  ortsbaumAhrenberg,
  ortsbaumLindach,
  ortsbaumLindachOhneGebaeude,
  verwaltung,
  halle1,
  halle2,
} from '../src/test/ortsbaumFixtures';
import { ahrenbergHeute, ahrenbergUnternehmen, werkLindach } from '../src/test/standorteFixtures';

/**
 * Der Ortsbaum „Standort › Gebäude“ und die Dialoge für Gebäude und Bereich
 * (UEMS AP-02 IP-7, T3/T4/T5/L1) bei 375 und 1440 px: kein Querlauf der Seite,
 * des Dialogs oder eines einzelnen Elements — GEMESSEN, nicht behauptet. Bühne ist
 * die Liste „Standorte“ (`standorte.html`), in deren Karten der Baum wohnt; die
 * Cloud ist per `page.route` verdrahtet (Referenzunternehmen Ahrenberg, 20.10.2026).
 *
 * Mit `ORTSBAUM_BILDER=<Ordner>` legt der Lauf je Fall ein Bild und
 * `messung-<fall>-<breite>.json` ab — die Vorschau für die Freigabe.
 */

const BILDER = process.env.ORTSBAUM_BILDER;
const BREITEN = [375, 1440] as const;

type Baeume = { ahrenberg: () => OrtsbaumAmStichtag; lindach: () => OrtsbaumAmStichtag };

const DATENLAGE: Record<string, [number, number]> = {
  'G-1': [5, 6], 'B-1': [1, 1], 'B-2': [2, 3],
  'G-2': [4, 5], 'B-3': [1, 1], 'B-4': [1, 1], 'B-5': [0, 1],
  'G-3': [2, 2], 'G-4': [1, 1], 'B-6': [0, 0], 'G-5': [0, 1], 'B-7': [0, 0],
};

function mitDatenlage(baum: OrtsbaumAmStichtag): OrtsbaumAmStichtag {
  for (const g of baum.gebaeude) {
    const [erfuellt, gesamt] = DATENLAGE[g.kurzzeichen] ?? [0, 0];
    g.datenlage = { erfuellt, gesamt, text: `${erfuellt} von ${gesamt} Messstellen liefern Daten` };
    for (const b of g.bereiche) {
      const [bErfuellt, bGesamt] = DATENLAGE[b.kurzzeichen] ?? [0, 0];
      b.datenlage = { erfuellt: bErfuellt, gesamt: bGesamt, text: `${bErfuellt} von ${bGesamt} Messstellen liefern Daten` };
    }
  }
  if (baum.direktAmStandort) {
    const gesamt = baum.direktAmStandort.messstellenZahl ?? 0;
    const erfuellt = Math.max(0, gesamt - 1);
    baum.direktAmStandort.datenlage = { erfuellt, gesamt, text: `${erfuellt} von ${gesamt} Messstellen liefern Daten` };
  }
  return baum;
}

const HEUTE: Baeume = { ahrenberg: () => mitDatenlage(ortsbaumAhrenberg()), lindach: () => mitDatenlage(ortsbaumLindach()) };
const LINDACH_LEER: Baeume = { ahrenberg: () => ortsbaumAhrenberg(), lindach: ortsbaumLindachOhneGebaeude };
const VERWALTUNG_OHNE_FLAECHE: Baeume = {
  ahrenberg: () =>
    ortsbaumAhrenberg({ gebaeude: [halle1(), halle2(), verwaltung({ flaecheM2: null, flaecheQuelle: null })] }),
  lindach: () => ortsbaumLindach(),
};

async function verdrahte(page: Page, baeume: Baeume) {
  const gesendet: { methode: string; pfad: string; body: unknown }[] = [];
  const liste = ahrenbergHeute();
  if (baeume === LINDACH_LEER) {
    liste.standorte[1] = werkLindach({ gebaeudeZahl: 0, bereichZahl: 0, flaecheM2: null, flaecheQuelle: null });
  }
  await page.route('**/api/v1/unternehmen', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ahrenbergUnternehmen()) }),
  );
  await page.route('**/api/v1/standorte**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.endsWith('/orte/kurzzeichen-vorschlag') && r.request().method() === 'GET') {
      const kurzzeichen = url.searchParams.get('art') === 'bereich' ? 'B-8' : 'G-6';
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kurzzeichen }) });
    }
    if (url.pathname.endsWith('/orte') && r.request().method() === 'GET') {
      const baum = url.pathname.includes(werkLindach().id) ? baeume.lindach() : baeume.ahrenberg();
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(baum) });
    }
    if (r.request().method() === 'GET') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liste) });
    }
    gesendet.push({ methode: r.request().method(), pfad: url.pathname, body: r.request().postDataJSON() });
    return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(ortNachSchreiben()) });
  });
  await page.route('**/api/v1/orte/**', (r) => {
    gesendet.push({
      methode: r.request().method(),
      pfad: new URL(r.request().url()).pathname,
      body: r.request().postDataJSON(),
    });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ortNachSchreiben()) });
  });
  return gesendet;
}

async function oeffne(page: Page, breite: number, baeume: Baeume = HEUTE) {
  const gesendet = await verdrahte(page, baeume);
  await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
  await page.goto('/e2e/standorte.html');
  await expect(page.getByTestId('ortsbaum')).toHaveCount(2);
  // Geladen ist ein Baum, sobald er nicht mehr „werden geladen …“ sagt (L1 kann Hinweis UND Zweig tragen).
  await expect(page.locator('.vp-ob [aria-busy]')).toHaveCount(0);
  return gesendet;
}

/** Querlauf in px: Seite, Dialog-Körper und jedes Element über den Rand; gekürzte Auswahl. */
async function ueberlauf(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.vp-bereich-tabs'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    const gekuerzt = [...document.querySelectorAll('.vp-modal .vp-picker-wert')]
      .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
      .map((el) => el.textContent);
    const baeume = [...document.querySelectorAll('.vp-ob')] as HTMLElement[];
    const zeilen = [...document.querySelectorAll('.vp-ob-zeile')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
      gekuerzt,
      // Für die Vorschau: wie hoch der Baum am Telefon wird.
      baumHoehe: baeume.map((x) => Math.round(x.getBoundingClientRect().height)),
      zeilenHoehe: zeilen.length ? Math.round(zeilen.reduce((s, z) => s + z.offsetHeight, 0) / zeilen.length) : null,
      seitenHoehe: document.documentElement.scrollHeight,
    };
  }, breite);
}

async function messeUndFotografiere(page: Page, breite: number, name: string, ausschnitt?: Locator) {
  if (await page.locator('.vp-modal').count()) {
    await expect(page.locator('.vp-modal').last()).toHaveCSS('opacity', '1');
  }
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await ueberlauf(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente`).toEqual([]);
  expect(m.gekuerzt, `${name} ${breite}: gekürzte Auswahl`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
  if (ausschnitt) await ausschnitt.screenshot({ path: join(BILDER, `${name}-${breite}-ausschnitt.png`) });
  if (await page.locator('.vp-modal').count()) {
    const hoehe = await page.evaluate(() => {
      const oben = [...document.querySelectorAll('.vp-modal')].at(-1) as HTMLElement;
      const k = oben.querySelector('.dbody') as HTMLElement;
      const kopf = (oben.querySelector('.dhead') as HTMLElement).offsetHeight;
      const fuss = (oben.querySelector('.dfoot') as HTMLElement | null)?.offsetHeight ?? 0;
      return kopf + k.scrollHeight + fuss + 8;
    });
    const vorher = page.viewportSize()!;
    await page.setViewportSize({ width: breite, height: Math.max(vorher.height, hoehe) });
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`) });
    await page.setViewportSize(vorher);
  } else {
    await page.screenshot({ path: join(BILDER, `${name}-${breite}-ganz.png`), fullPage: true });
  }
}

async function waehle(page: Page, feld: string, optionen: (string | RegExp)[]) {
  await page.getByRole('combobox', { name: feld }).click();
  for (const o of optionen) await page.getByRole('option', { name: o }).click();
  if (optionen.length !== 1) await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
}

const ahrenberg = (page: Page) => page.getByTestId('ortsbaum').first();
const lindach = (page: Page) => page.getByTestId('ortsbaum').nth(1);

for (const breite of BREITEN) {
  test.describe(`${breite} px`, () => {
    test('T3 Baum: Werk Ahrenberg mit Gebäuden, Bereichen und „Direkt am Standort“', async ({ page }) => {
      await oeffne(page, breite);
      const baum = ahrenberg(page);
      await expect(baum.locator('.vp-ob-name')).toHaveText([
        'Halle 1G-1',
        'Halle 1 NordB-1',
        'Halle 1 SüdB-2',
        'Halle 2G-2',
        'Halle 2 MontageB-3',
        'Halle 2 SpritzgussB-4',
        'Halle 2 LagerB-5',
        'VerwaltungG-3',
        'Direkt am Standort',
      ]);
      await expect(baum.getByTestId('datenlage').first()).toHaveText('5 von 6 Messstellen liefern Daten');
      await expect(lindach(page).locator('.vp-ob-name')).toHaveText([
        'Lagerhalle LindachG-4',
        'Lager LindachB-6',
        'Montagehalle LindachG-5',
        'Montage LindachB-7',
        'Direkt am Standort',
      ]);
      await messeUndFotografiere(page, breite, 'baum', baum);
    });

    test('L1: Werk Lindach ohne Gebäude — Hinweis und beide Wege', async ({ page }) => {
      await oeffne(page, breite, LINDACH_LEER);
      const leer = lindach(page).getByTestId('ortsbaum-leer');
      // MS-16 hängt schon direkt am Standort: der Zweig steht unter dem Hinweis.
      await expect(lindach(page).locator('.vp-ob-name')).toHaveText(['Direkt am Standort']);
      await expect(leer).toContainText('Gebäude sind optional — Messstellen dürfen direkt am Standort hängen.');
      await expect(leer.getByRole('button')).toHaveText(['Gebäude anlegen', 'Bereich direkt am Standort anlegen']);
      await lindach(page).scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'leer', page.locator('.vp-st-karte').nth(1));
    });

    test('T4 Gebäude anlegen: Halle 4 mit Fläche ab 20.10.2026 und Baujahr', async ({ page }) => {
      const gesendet = await oeffne(page, breite);
      await ahrenberg(page).getByRole('button', { name: 'Gebäude anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Gebäude anlegen' });
      await expect(dialog.getByText('Am Standort Werk Ahrenberg (ST-1). Nur der Name ist Pflicht.')).toBeVisible();
      await expect(dialog.getByLabel('Kurzzeichen')).toHaveValue('G-6');
      await dialog.getByLabel('Name *').fill('Halle 4');
      await waehle(page, 'Nutzung', ['Lager', 'Logistik']);
      await dialog.getByLabel('Bezugsfläche (m²)').fill('2400');
      await dialog.getByLabel('Baujahr').fill('2021');
      await messeUndFotografiere(page, breite, 'gebaeude-anlegen');
      await dialog.getByRole('button', { name: 'Gebäude anlegen' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(gesendet).toEqual([
        {
          methode: 'POST',
          pfad: `/api/v1/standorte/${ortsbaumAhrenberg().standort.id}/orte`,
          body: {
            art: 'gebaeude',
            name: 'Halle 4',
            kurzzeichen: 'G-6',
            gueltigAb: '2026-10-20',
            nutzung: ['lager', 'logistik'],
            notiz: null,
            flaecheM2: 2400,
            baujahr: 2021,
          },
        },
      ]);
    });

    test('T5 Bereich anlegen: die Zielliste ohne Bereiche, Halle 2 gewählt', async ({ page }) => {
      const gesendet = await oeffne(page, breite);
      await ahrenberg(page).getByRole('button', { name: 'Bereich anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Bereich anlegen' });
      await dialog.getByLabel('Name *').fill('Halle 2 Prüffeld');
      await page.getByRole('combobox', { name: 'Hängt an *' }).click();
      await expect(page.getByRole('option')).toHaveCount(4);
      await messeUndFotografiere(page, breite, 'bereich-ziele');
      await page.getByRole('option', { name: /Gebäude Halle 2/ }).click();
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await messeUndFotografiere(page, breite, 'bereich-anlegen');
      await dialog.getByRole('button', { name: 'Bereich anlegen' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(gesendet[0].body).toMatchObject({ art: 'bereich', name: 'Halle 2 Prüffeld', elternId: halle2().id });
    });

    test('Bereich anlegen leer gesendet: Name und „Hängt an“ mit ihren Sätzen', async ({ page }) => {
      await oeffne(page, breite);
      await ahrenberg(page).getByRole('button', { name: 'Bereich anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Bereich anlegen' });
      await dialog.getByRole('button', { name: 'Bereich anlegen' }).click();
      await expect(dialog.getByText('Bitte geben Sie einen Namen an.')).toBeVisible();
      await expect(
        dialog.getByText('Ein Bereich kann nur an einem Gebäude oder direkt an einem Standort hängen.'),
      ).toBeVisible();
      await expect(dialog.getByLabel('Name *')).toBeFocused();
      await messeUndFotografiere(page, breite, 'bereich-pflicht');
    });

    test('L1 → „Bereich direkt am Standort anlegen“: Werk Lindach vorgewählt, ohne elternId gesendet', async ({
      page,
    }) => {
      const gesendet = await oeffne(page, breite, LINDACH_LEER);
      await lindach(page).getByRole('button', { name: 'Bereich direkt am Standort anlegen' }).click();
      const dialog = page.getByRole('dialog', { name: 'Bereich anlegen' });
      await expect(dialog.getByRole('combobox', { name: 'Hängt an *' })).toContainText(
        'Direkt am Standort Werk Lindach',
      );
      await dialog.getByLabel('Name *').fill('Zählerplatz Lindach');
      await messeUndFotografiere(page, breite, 'bereich-direkt');
      await dialog.getByRole('button', { name: 'Bereich anlegen' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(gesendet[0]).toMatchObject({ methode: 'POST', body: { art: 'bereich', elternId: null } });
    });

    test('Gebäude bearbeiten: Halle 2 mit Fläche lesend, Rückkehr zum Stift', async ({ page }) => {
      const gesendet = await oeffne(page, breite);
      const stift = page.getByRole('button', { name: 'Halle 2 bearbeiten' });
      await stift.click();
      const dialog = page.getByRole('dialog', { name: 'Gebäude bearbeiten' });
      await expect(dialog.getByLabel('Kurzzeichen *')).toHaveValue('G-2');
      await expect(dialog.locator('.vp-sd-flaeche')).toContainText('3 100 m²');
      await messeUndFotografiere(page, breite, 'gebaeude-bearbeiten');
      await dialog.getByRole('button', { name: 'Speichern' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(stift).toBeFocused();
      expect(gesendet).toEqual([
        {
          methode: 'PUT',
          pfad: `/api/v1/orte/${halle2().id}`,
          body: {
            name: 'Halle 2',
            kurzzeichen: 'G-2',
            nutzung: ['produktion', 'montage', 'lager'],
            notiz: '2019 zugekauft, eigener Netzanschluss NA-2',
            baujahr: 2019,
          },
        },
      ]);
    });

    test('„für kWh/m² fehlt die Fläche — Fläche eintragen“: Verwaltung bekommt ihre erste Fläche', async ({ page }) => {
      const gesendet = await oeffne(page, breite, VERWALTUNG_OHNE_FLAECHE);
      const knopf = page.getByRole('button', { name: 'Fläche eintragen: Verwaltung' });
      await knopf.scrollIntoViewIfNeeded();
      await messeUndFotografiere(page, breite, 'flaeche-fehlt', page.locator('.vp-ob-knoten[data-art="gebaeude"]').nth(2));
      await knopf.click();
      const dialog = page.getByRole('dialog', { name: 'Gebäude bearbeiten' });
      await expect(dialog.getByLabel('Bezugsfläche (m²)')).toBeFocused();
      await dialog.getByLabel('Bezugsfläche (m²)').fill('1150');
      await messeUndFotografiere(page, breite, 'flaeche-eintragen');
      await dialog.getByRole('button', { name: 'Speichern' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(gesendet.map((g) => [g.methode, g.pfad])).toEqual([
        ['PUT', `/api/v1/orte/${verwaltung().id}`],
        ['PUT', `/api/v1/orte/${verwaltung().id}/flaeche`],
      ]);
      expect(gesendet[1].body).toEqual({ m2: 1150, gueltigAb: '2026-10-20' });
    });
  });
}
