import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnlageOrtErgebnis, Site, StandorteAmStichtag } from '../src/api';
import { ahrenbergUnternehmen, FIXTURE_IDS, werkAhrenberg } from '../src/test/standorteFixtures';

/**
 * vp-standort-konzept §6.1 (B1/B3/B6, E3): die Zeile „Standort“ und ihr Blatt, am echten Weg
 * (Bühne `meine-anlage.html?fall=ahrenberg`, die echte `TechnikSection`). Misst bei 375 und
 * 1440 px: Seite 0 px Querlauf, kein Element über dem Rand. `ORT_BILDER=<Ordner>` legt je
 * Schritt Bilder ab.
 */

const BILDER = process.env.ORT_BILDER;
const BREITEN = [375, 1440] as const;
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

function standorte(): StandorteAmStichtag {
  return {
    stichtag: '2026-11-26',
    standorte: [werkAhrenberg()],
    nichtGezeigt: [],
    nochNichtZugeordnet: null,
  };
}

async function verdrahte(page: Page) {
  const gesendet: unknown[] = [];
  await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
  await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
  await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
  await page.route('**/api/v1/standorte**', (r) => r.fulfill(json(standorte())));
  await page.route('**/api/v1/orte/suche**', (r) =>
    r.fulfill(
      json({
        treffer: [
          {
            text: 'Lindenweg 45, 91710 Treuchtlingen',
            strasse: 'Lindenweg',
            hausnummer: '45',
            plz: '91710',
            ort: 'Treuchtlingen',
            land: 'DE',
            breitengrad: 48.9517,
            laengengrad: 10.9254,
            genau: 'haus',
          },
        ],
        quelle: '© OpenStreetMap-Mitwirkende',
      }),
    ),
  );
  await page.route('**/api/v1/sites/*/ort', (r) => {
    const body = r.request().postDataJSON() as { adresse: { strasse: string; plz: string | null; ort: string; land: string }; lage: { breitengrad: number; laengengrad: number } };
    gesendet.push(body);
    const ergebnis: AnlageOrtErgebnis = {
      site: {
        id: FIXTURE_IDS.an2,
        name: 'Werk Ahrenberg – Halle 2',
        biddingZone: 'DE-LU',
        latitude: body.lage.breitengrad,
        longitude: body.lage.laengengrad,
        plantKind: 'eigenverbrauch',
        anzulegenderWertCtKwh: null,
        tarifArt: 'ohne',
        tarifParamCtKwh: null,
        netzladenErlaubt: false,
        maxFeedInKw: null,
      } as Site,
      standort: { ...werkAhrenberg(), adresse: body.adresse as never, lage: body.lage },
      boxZugestellt: false,
      wetterNachholungAngestossen: false,
    };
    return r.fulfill(json(ergebnis));
  });
  return gesendet;
}

async function messe(page: Page, breite: number) {
  return page.evaluate((b) => {
    const draussen = [...document.querySelectorAll('.vp-main *, .vp-modal *')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ el }) => !el.closest('.leaflet-container'))
      .filter(({ r }) => r.width > 0 && (r.right > b + 0.5 || r.left < -0.5))
      .map(({ el }) => `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className)}`);
    const koerper = [...document.querySelectorAll('.vp-modal .dbody')] as HTMLElement[];
    return {
      seite: document.documentElement.scrollWidth - window.innerWidth,
      dialog: koerper.length ? Math.max(...koerper.map((k) => k.scrollWidth - k.clientWidth)) : null,
      draussen,
    };
  }, breite);
}

async function pruefeUndFotografiere(page: Page, breite: number, name: string) {
  await page.waitForFunction(() => document.getAnimations().every((x) => x.playState !== 'running'));
  const m = await messe(page, breite);
  expect(m.seite, `${name} ${breite}: Seite`).toBe(0);
  expect(m.dialog ?? 0, `${name} ${breite}: Dialog`).toBe(0);
  expect(m.draussen, `${name} ${breite}: Elemente über dem Rand`).toEqual([]);
  if (!BILDER) return;
  mkdirSync(BILDER, { recursive: true });
  writeFileSync(join(BILDER, `messung-${name}-${breite}.json`), JSON.stringify(m, null, 2));
  await page.screenshot({ path: join(BILDER, `${name}-${breite}.png`) });
}

test.describe('Zeile „Standort“ und ihr Blatt (vp-standort-konzept §6.1)', () => {
  for (const breite of BREITEN) {
    test(`zeigt Adresse und kleine Karte, öffnet das Blatt mit Adresse und großer Karte — ${breite} px`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      await verdrahte(page);
      await page.setViewportSize({ width: breite, height: breite < 720 ? 812 : 900 });
      await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

      const karte = page.locator('#technik-anlage');
      await expect(karte).toBeVisible();
      const aufklappen = karte.locator('button[aria-expanded="false"]');
      if (await aufklappen.count()) await aufklappen.first().click();

      const zeile = karte.getByRole('button', { name: /^Standort bearbeiten: Gewerbering 7, Ahrenberg/ });
      await expect(zeile).toBeVisible();
      // E3: keine zweite Zeile "Standort auf der Karte" mehr.
      await expect(karte.getByText('Standort auf der Karte')).toHaveCount(0);
      await karte.scrollIntoViewIfNeeded();
      await pruefeUndFotografiere(page, breite, 'standort-zeile');

      await zeile.click();
      const dialog = page.getByRole('dialog', { name: 'Standort' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Adresse')).toHaveValue('Gewerbering 7, Ahrenberg');
      // Regel 5 (nie ohne Punkt speichern): "Entfernen" wäre hier ein totes Bedienelement.
      await expect(dialog.getByRole('button', { name: 'Entfernen' })).toHaveCount(0);
      const speichern = dialog.getByRole('button', { name: 'Speichern' });
      await expect(speichern).toBeDisabled();
      await pruefeUndFotografiere(page, breite, 'standort-blatt');
    });
  }

  test('eine neu gewählte Adresse aktiviert „Speichern“ und wird in einem Zug übernommen', async ({ page }) => {
    const gesendet = await verdrahte(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    const karte = page.locator('#technik-anlage');
    await karte.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort' });
    const adresse = dialog.getByLabel('Adresse');
    await adresse.fill('Lindenweg 45');
    await page.getByRole('option', { name: /Lindenweg 45/ }).click();

    const speichern = dialog.getByRole('button', { name: 'Speichern' });
    await expect(speichern).toBeEnabled();
    await speichern.click();

    await expect(dialog.getByText(/^Gespeichert\./)).toBeVisible();
    await expect(dialog.getByText('Vorher: Gewerbering 7, Ahrenberg')).toBeVisible();
    expect(gesendet).toHaveLength(1);
    expect(gesendet[0]).toMatchObject({
      adresse: { strasse: 'Lindenweg 45', plz: '91710', ort: 'Treuchtlingen', land: 'DE' },
      lage: { breitengrad: 48.9517, laengengrad: 10.9254 },
    });

    await dialog.getByRole('button', { name: 'Fertig' }).click();
    await expect(dialog).toBeHidden();
  });

  test('„Details“ zeigt Strommarkt und Zeitzone nur zur Anzeige (B6: keine Gebotszone von Hand)', async ({ page }) => {
    await verdrahte(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/meine-anlage.html?fall=ahrenberg');

    const karte = page.locator('#technik-anlage');
    await karte.getByRole('button', { name: /^Standort bearbeiten/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Standort' });
    await expect(dialog.getByText('Strommarkt')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Details' }).click();
    await expect(dialog.getByText('Strommarkt')).toBeVisible();
    await expect(dialog.getByText('DE-LU')).toBeVisible();
    await expect(dialog.getByText('Europe/Berlin')).toBeVisible();
  });
});

test.describe('Entwurf ohne Adresse: "Adresse nachtragen" bleibt (Randfall, unverändert)', () => {
  test('ein automatisch angelegter Standort zeigt weiter "Adresse nachtragen", keine neue Zeile', async ({ page }) => {
    await page.route('**/api/v1/**', (r) => r.fulfill(json({}, 404)));
    await page.route('**/api/v1/sites/*/assets', (r) => r.fulfill(json([])));
    await page.route('**/api/v1/unternehmen', (r) => r.fulfill(json(ahrenbergUnternehmen())));
    await page.route('**/api/v1/standorte**', (r) =>
      r.fulfill(
        json({
          stichtag: '2026-11-26',
          standorte: [
            werkAhrenberg({
              id: FIXTURE_IDS.an1,
              kurzzeichen: 'ST-X',
              name: 'Werk Ahrenberg – Halle 1',
              adresse: null,
              lage: null,
              esFehlt: ['adresse'],
              zustand: 'entwurf',
              anlagen: [{ id: FIXTURE_IDS.an1, name: 'Werk Ahrenberg – Halle 1', gueltigAb: '2026-03-12', gueltigBis: null }],
            }),
          ],
          nichtGezeigt: [],
          nochNichtZugeordnet: null,
        }),
      ),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/e2e/meine-anlage.html?fall=entwurf');

    const karte = page.locator('#technik-anlage');
    await expect(karte.getByRole('button', { name: /^Adresse nachtragen/ })).toBeVisible();
    await expect(karte.getByRole('button', { name: /^Standort bearbeiten/ })).toHaveCount(0);
  });
});
